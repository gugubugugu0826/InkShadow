use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use rand::RngCore;
use same_file::Handle;
use serde::Serialize;
use tokio::sync::Mutex;

const PATH_TICKET_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_PATH_BYTES: usize = 32_767;
const TOKEN_HEX_BYTES: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PathTicketPurpose {
    BackupDestination,
    RestoreSource,
    PreRestoreRollbackDestination,
}

impl PathTicketPurpose {
    fn is_backup_destination(self) -> bool {
        matches!(
            self,
            Self::BackupDestination | Self::PreRestoreRollbackDestination
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TicketedPathOperation {
    VacuumInto,
    AttachRestoreSource,
}

#[derive(Debug)]
enum TicketStage {
    Issued,
    BackupCreated { identity: Handle },
    Attached,
}

#[derive(Debug)]
struct PathTicket {
    session_token: String,
    purpose: PathTicketPurpose,
    path: PathBuf,
    parent_identity: Option<Handle>,
    selected_identity: Option<Handle>,
    expires_at: Instant,
    stage: TicketStage,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathTicketReceipt {
    ticket: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PathTicketError;

#[derive(Debug)]
pub(crate) struct PathTicketRegistry {
    tickets: HashMap<String, PathTicket>,
    active_attachment: Option<String>,
    ttl: Duration,
}

#[derive(Clone, Default)]
pub(crate) struct PathTicketState {
    pub(crate) inner: Arc<Mutex<PathTicketRegistry>>,
}

impl Default for PathTicketRegistry {
    fn default() -> Self {
        Self {
            tickets: HashMap::new(),
            active_attachment: None,
            ttl: PATH_TICKET_TTL,
        }
    }
}

impl PathTicketRegistry {
    #[cfg(test)]
    fn with_ttl(ttl: Duration) -> Self {
        Self {
            ttl,
            ..Self::default()
        }
    }

    pub(crate) fn issue_selected_path(
        &mut self,
        session_token: &str,
        purpose: PathTicketPurpose,
        selected: Option<PathBuf>,
    ) -> Result<Option<PathTicketReceipt>, PathTicketError> {
        selected
            .map(|path| self.issue_path_at(session_token, purpose, path, Instant::now()))
            .transpose()
    }

    fn issue_path_at(
        &mut self,
        session_token: &str,
        purpose: PathTicketPurpose,
        selected: PathBuf,
        now: Instant,
    ) -> Result<PathTicketReceipt, PathTicketError> {
        if !valid_session_token(session_token) || !valid_path_shape(&selected) {
            return Err(PathTicketError);
        }
        self.purge_expired(now);

        let (path, parent_identity, selected_identity) = if purpose.is_backup_destination() {
            if selected.exists() {
                return Err(PathTicketError);
            }
            let file_name = selected.file_name().ok_or(PathTicketError)?;
            let parent = selected.parent().ok_or(PathTicketError)?;
            let canonical_parent = parent.canonicalize().map_err(|_| PathTicketError)?;
            if !canonical_parent.is_dir() {
                return Err(PathTicketError);
            }
            (
                canonical_parent.join(file_name),
                Some(Handle::from_path(canonical_parent).map_err(|_| PathTicketError)?),
                None,
            )
        } else {
            let canonical = selected.canonicalize().map_err(|_| PathTicketError)?;
            if !canonical.is_file() {
                return Err(PathTicketError);
            }
            let identity = Handle::from_path(&canonical).map_err(|_| PathTicketError)?;
            (canonical, None, Some(identity))
        };

        let token = random_token();
        self.tickets.insert(
            token.clone(),
            PathTicket {
                session_token: session_token.to_owned(),
                purpose,
                path,
                parent_identity,
                selected_identity,
                expires_at: now + self.ttl,
                stage: TicketStage::Issued,
            },
        );
        Ok(PathTicketReceipt { ticket: token })
    }

    pub(crate) fn authorize(
        &mut self,
        session_token: &str,
        token: &str,
        operation: TicketedPathOperation,
    ) -> Result<PathBuf, PathTicketError> {
        self.authorize_at(session_token, token, operation, Instant::now())
    }

    fn authorize_at(
        &mut self,
        session_token: &str,
        token: &str,
        operation: TicketedPathOperation,
        now: Instant,
    ) -> Result<PathBuf, PathTicketError> {
        if !valid_session_token(session_token) || !valid_ticket_token(token) {
            return Err(PathTicketError);
        }
        self.purge_expired(now);
        let ticket = self.tickets.get(token).ok_or(PathTicketError)?;
        if ticket.session_token != session_token || ticket.expires_at <= now {
            return Err(PathTicketError);
        }

        match operation {
            TicketedPathOperation::VacuumInto => {
                if !ticket.purpose.is_backup_destination()
                    || !matches!(ticket.stage, TicketStage::Issued)
                    || ticket.path.exists()
                    || !parent_identity_matches(ticket)?
                {
                    return Err(PathTicketError);
                }
            }
            TicketedPathOperation::AttachRestoreSource => match &ticket.stage {
                TicketStage::Issued
                    if ticket.purpose == PathTicketPurpose::RestoreSource
                        && selected_identity_matches(ticket)? => {}
                TicketStage::BackupCreated { identity }
                    if ticket.purpose.is_backup_destination()
                        && current_identity_matches(&ticket.path, identity)? => {}
                _ => return Err(PathTicketError),
            },
        }
        Ok(ticket.path.clone())
    }

    pub(crate) fn record_success(
        &mut self,
        session_token: &str,
        token: &str,
        operation: TicketedPathOperation,
    ) -> Result<(), PathTicketError> {
        let ticket = self.tickets.get_mut(token).ok_or(PathTicketError)?;
        if ticket.session_token != session_token {
            return Err(PathTicketError);
        }

        match operation {
            TicketedPathOperation::VacuumInto
                if ticket.purpose.is_backup_destination()
                    && matches!(ticket.stage, TicketStage::Issued) =>
            {
                let identity = Handle::from_path(&ticket.path).map_err(|_| PathTicketError)?;
                if !ticket.path.is_file() {
                    return Err(PathTicketError);
                }
                ticket.stage = TicketStage::BackupCreated { identity };
            }
            TicketedPathOperation::AttachRestoreSource
                if self.active_attachment.is_none()
                    && matches!(
                        ticket.stage,
                        TicketStage::Issued | TicketStage::BackupCreated { .. }
                    ) =>
            {
                let identity = Handle::from_path(&ticket.path).map_err(|_| PathTicketError)?;
                // Re-open the path at the transition boundary so an alias
                // swap between authorization and ATTACH fails closed.
                let expected_identity = match &ticket.stage {
                    TicketStage::Issued => ticket.selected_identity.as_ref(),
                    TicketStage::BackupCreated { identity } => Some(identity),
                    TicketStage::Attached => None,
                }
                .ok_or(PathTicketError)?;
                if &identity != expected_identity {
                    return Err(PathTicketError);
                }
                ticket.stage = TicketStage::Attached;
                self.active_attachment = Some(token.to_owned());
            }
            _ => return Err(PathTicketError),
        }
        Ok(())
    }

    pub(crate) fn record_failure(&mut self, token: &str) {
        if self.active_attachment.as_deref() == Some(token) {
            self.active_attachment = None;
        }
        self.tickets.remove(token);
    }

    pub(crate) fn authorize_detach(&self, session_token: &str) -> Result<(), PathTicketError> {
        let token = self.active_attachment.as_deref().ok_or(PathTicketError)?;
        let ticket = self.tickets.get(token).ok_or(PathTicketError)?;
        if ticket.session_token != session_token || !matches!(ticket.stage, TicketStage::Attached) {
            return Err(PathTicketError);
        }
        Ok(())
    }

    pub(crate) fn record_detached(&mut self) {
        if let Some(token) = self.active_attachment.take() {
            self.tickets.remove(&token);
        }
    }

    pub(crate) fn revoke_session(&mut self, session_token: &str) {
        self.tickets
            .retain(|_, ticket| ticket.session_token != session_token);
        if self
            .active_attachment
            .as_ref()
            .is_some_and(|token| !self.tickets.contains_key(token))
        {
            self.active_attachment = None;
        }
    }

    pub(crate) fn clear(&mut self) {
        self.active_attachment = None;
        self.tickets.clear();
    }

    fn purge_expired(&mut self, now: Instant) {
        let active = self.active_attachment.as_deref();
        self.tickets
            .retain(|token, ticket| active == Some(token.as_str()) || ticket.expires_at > now);
    }
}

fn parent_identity_matches(ticket: &PathTicket) -> Result<bool, PathTicketError> {
    let parent = ticket.path.parent().ok_or(PathTicketError)?;
    let expected = ticket.parent_identity.as_ref().ok_or(PathTicketError)?;
    current_identity_matches(parent, expected)
}

fn selected_identity_matches(ticket: &PathTicket) -> Result<bool, PathTicketError> {
    let expected = ticket.selected_identity.as_ref().ok_or(PathTicketError)?;
    current_identity_matches(&ticket.path, expected)
}

fn current_identity_matches(path: &Path, expected: &Handle) -> Result<bool, PathTicketError> {
    let current = Handle::from_path(path).map_err(|_| PathTicketError)?;
    Ok(&current == expected)
}

fn valid_path_shape(path: &Path) -> bool {
    path.is_absolute()
        && path.as_os_str().to_string_lossy().len() <= MAX_PATH_BYTES
        && !path.as_os_str().to_string_lossy().contains('\0')
}

fn valid_session_token(token: &str) -> bool {
    valid_ticket_token(token)
}

fn valid_ticket_token(token: &str) -> bool {
    token.len() == TOKEN_HEX_BYTES && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut token = String::with_capacity(TOKEN_HEX_BYTES);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(token, "{byte:02x}");
    }
    token
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };

    use super::{PathTicketPurpose, PathTicketRegistry, TicketedPathOperation, TOKEN_HEX_BYTES};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create() -> Self {
            let path = std::env::temp_dir()
                .join(format!("inkshadow-path-ticket-{}", super::random_token()));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn session() -> String {
        "a".repeat(TOKEN_HEX_BYTES)
    }

    #[test]
    fn cancellation_issues_no_ticket_or_path() {
        let mut registry = PathTicketRegistry::default();
        let receipt = registry
            .issue_selected_path(&session(), PathTicketPurpose::RestoreSource, None)
            .expect("cancel is not an error");
        assert_eq!(receipt, None);
        assert!(registry.tickets.is_empty());
    }

    #[test]
    fn rejects_purpose_mismatch_and_replay_after_detach() {
        let directory = TestDirectory::create();
        let source = directory.path().join("source.db");
        fs::write(&source, b"sqlite").expect("seed source");
        let mut registry = PathTicketRegistry::default();
        let receipt = registry
            .issue_selected_path(&session(), PathTicketPurpose::RestoreSource, Some(source))
            .expect("issue source")
            .expect("selected");

        assert!(registry
            .authorize(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::VacuumInto,
            )
            .is_err());
        registry
            .authorize(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::AttachRestoreSource,
            )
            .expect("authorize attach");
        registry
            .record_success(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::AttachRestoreSource,
            )
            .expect("record attach");
        registry
            .authorize_detach(&session())
            .expect("authorize detach");
        registry.record_detached();
        assert!(registry
            .authorize(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::AttachRestoreSource,
            )
            .is_err());
    }

    #[test]
    fn rejects_raw_absolute_paths_at_the_production_authorization_boundary() {
        let directory = TestDirectory::create();
        let raw_path = directory.path().join("guessed.db");
        fs::write(&raw_path, b"sqlite").expect("seed source");
        let mut registry = PathTicketRegistry::default();

        assert!(registry
            .authorize(
                &session(),
                raw_path.to_string_lossy().as_ref(),
                TicketedPathOperation::AttachRestoreSource,
            )
            .is_err());
    }

    #[test]
    fn expires_unconsumed_tickets_and_binds_them_to_one_session() {
        let directory = TestDirectory::create();
        let destination = directory.path().join("backup.db");
        let mut registry = PathTicketRegistry::with_ttl(Duration::from_millis(10));
        let now = Instant::now();
        let receipt = registry
            .issue_path_at(
                &session(),
                PathTicketPurpose::BackupDestination,
                destination,
                now,
            )
            .expect("issue destination");

        assert!(registry
            .authorize_at(
                &"b".repeat(TOKEN_HEX_BYTES),
                &receipt.ticket,
                TicketedPathOperation::VacuumInto,
                now,
            )
            .is_err());
        assert!(registry
            .authorize_at(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::VacuumInto,
                now + Duration::from_millis(11),
            )
            .is_err());
        assert!(!registry.tickets.contains_key(&receipt.ticket));
    }

    #[test]
    fn enforces_backup_state_transitions_and_file_identity() {
        let directory = TestDirectory::create();
        let destination = directory.path().join("backup.db");
        let mut registry = PathTicketRegistry::default();
        let receipt = registry
            .issue_selected_path(
                &session(),
                PathTicketPurpose::PreRestoreRollbackDestination,
                Some(destination.clone()),
            )
            .expect("issue destination")
            .expect("selected");

        registry
            .authorize(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::VacuumInto,
            )
            .expect("authorize vacuum");
        fs::write(&destination, b"first identity").expect("create backup");
        registry
            .record_success(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::VacuumInto,
            )
            .expect("record vacuum");
        assert!(registry
            .authorize(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::VacuumInto,
            )
            .is_err());

        fs::remove_file(&destination).expect("replace backup");
        fs::write(&destination, b"replacement identity").expect("replacement backup");
        assert!(registry
            .authorize(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::AttachRestoreSource,
            )
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn preserves_selected_symlink_identity_and_detects_target_swap() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::create();
        let first = directory.path().join("first.db");
        let second = directory.path().join("second.db");
        let alias = directory.path().join("selected.db");
        fs::write(&first, b"first").expect("first");
        fs::write(&second, b"second").expect("second");
        symlink(&first, &alias).expect("symlink");

        let mut registry = PathTicketRegistry::default();
        let receipt = registry
            .issue_selected_path(
                &session(),
                PathTicketPurpose::RestoreSource,
                Some(alias.clone()),
            )
            .expect("issue symlink")
            .expect("selected");
        registry
            .authorize(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::AttachRestoreSource,
            )
            .expect("same selected identity");

        fs::remove_file(alias).expect("remove alias");
        symlink(second, directory.path().join("selected.db")).expect("replace alias");
        // The registry canonicalized the selected identity at issuance, so a
        // later alias rewrite cannot redirect the authorized file.
        registry
            .authorize(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::AttachRestoreSource,
            )
            .expect("still pinned to canonical selected file");
    }

    #[test]
    fn hardlink_aliases_compare_as_the_same_selected_identity() {
        let directory = TestDirectory::create();
        let source = directory.path().join("source.db");
        let alias = directory.path().join("alias.db");
        fs::write(&source, b"source").expect("source");
        fs::hard_link(&source, &alias).expect("hard link");

        let mut registry = PathTicketRegistry::default();
        let receipt = registry
            .issue_selected_path(&session(), PathTicketPurpose::RestoreSource, Some(alias))
            .expect("issue hard link")
            .expect("selected");
        registry
            .authorize(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::AttachRestoreSource,
            )
            .expect("same selected file identity");
    }

    #[test]
    fn rejects_a_restore_source_replaced_after_selection() {
        let directory = TestDirectory::create();
        let source = directory.path().join("source.db");
        fs::write(&source, b"first").expect("source");
        let mut registry = PathTicketRegistry::default();
        let receipt = registry
            .issue_selected_path(
                &session(),
                PathTicketPurpose::RestoreSource,
                Some(source.clone()),
            )
            .expect("issue source")
            .expect("selected");

        fs::remove_file(&source).expect("remove selected source");
        fs::write(&source, b"replacement").expect("replacement source");
        assert!(registry
            .authorize(
                &session(),
                &receipt.ticket,
                TicketedPathOperation::AttachRestoreSource,
            )
            .is_err());
    }
}
