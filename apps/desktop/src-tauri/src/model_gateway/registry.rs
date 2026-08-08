use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;

use super::error::CommandError;

#[derive(Debug, Default)]
pub(crate) struct GenerationRegistry {
    entries: Mutex<HashMap<String, CancellationToken>>,
}

/// Native-only proof of which network futures are still alive in this process.
/// It is intentionally not writable by the WebView: reconciliation may remove
/// a durable lease only when this registry proves its operation has ended.
#[derive(Debug, Default)]
pub(crate) struct ActiveDispatchRegistry {
    entries: Mutex<HashSet<String>>,
}

impl ActiveDispatchRegistry {
    pub(crate) fn register(&self, operation_id: &str) -> Result<(), CommandError> {
        validate_dispatch_id(operation_id)?;
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| CommandError::registry_unavailable())?;
        if !entries.insert(operation_id.to_owned()) {
            return Err(CommandError::registry_unavailable());
        }
        Ok(())
    }

    pub(crate) fn remove(&self, operation_id: &str) -> Result<bool, CommandError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| CommandError::registry_unavailable())?;
        Ok(entries.remove(operation_id))
    }

    pub(crate) fn snapshot(&self) -> Result<HashSet<String>, CommandError> {
        self.entries
            .lock()
            .map(|entries| entries.clone())
            .map_err(|_| CommandError::registry_unavailable())
    }
}

impl GenerationRegistry {
    pub(crate) fn register(&self, generation_id: &str) -> Result<CancellationToken, CommandError> {
        validate_generation_id(generation_id)?;
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| CommandError::registry_unavailable())?;
        if entries.contains_key(generation_id) {
            return Err(CommandError::duplicate_generation());
        }

        let token = CancellationToken::new();
        entries.insert(generation_id.to_owned(), token.clone());
        Ok(token)
    }

    pub(crate) fn cancel(&self, generation_id: &str) -> Result<bool, CommandError> {
        validate_generation_id(generation_id)?;
        let entries = self
            .entries
            .lock()
            .map_err(|_| CommandError::registry_unavailable())?;
        let Some(token) = entries.get(generation_id) else {
            return Ok(false);
        };
        token.cancel();
        Ok(true)
    }

    pub(crate) fn remove(&self, generation_id: &str) -> Result<bool, CommandError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| CommandError::registry_unavailable())?;
        Ok(entries.remove(generation_id).is_some())
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, generation_id: &str) -> Result<bool, CommandError> {
        self.entries
            .lock()
            .map(|entries| entries.contains_key(generation_id))
            .map_err(|_| CommandError::registry_unavailable())
    }
}

pub(crate) fn validate_generation_id(generation_id: &str) -> Result<(), CommandError> {
    let valid = !generation_id.is_empty()
        && generation_id.len() <= 128
        && generation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    if valid {
        Ok(())
    } else {
        Err(CommandError::request_invalid())
    }
}

fn validate_dispatch_id(operation_id: &str) -> Result<(), CommandError> {
    let valid = !operation_id.is_empty()
        && operation_id.len() <= 200
        && operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    if valid {
        Ok(())
    } else {
        Err(CommandError::request_invalid())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prevents_duplicate_active_generations_and_allows_reuse_after_removal() {
        let registry = GenerationRegistry::default();
        let first = registry
            .register("generation-1")
            .expect("first registration should succeed");

        assert!(!first.is_cancelled());
        assert!(registry.register("generation-1").is_err());
        assert!(registry
            .remove("generation-1")
            .expect("removal should succeed"));
        assert!(registry.register("generation-1").is_ok());
    }

    #[test]
    fn cancellation_is_idempotent_and_observable_by_the_worker() {
        let registry = GenerationRegistry::default();
        let token = registry
            .register("generation-2")
            .expect("registration should succeed");

        assert!(registry
            .cancel("generation-2")
            .expect("cancellation should succeed"));
        assert!(token.is_cancelled());
        assert!(registry
            .cancel("generation-2")
            .expect("repeat cancellation should succeed"));
        assert!(!registry
            .cancel("unknown-generation")
            .expect("unknown cancellation should be safe"));
    }

    #[test]
    fn rejects_unsafe_generation_identifiers() {
        let registry = GenerationRegistry::default();
        for generation_id in ["", "../escape", "contains space", "a/b"] {
            assert!(registry.register(generation_id).is_err());
        }
    }

    #[test]
    fn dispatch_registry_snapshots_only_live_operations() {
        let registry = ActiveDispatchRegistry::default();
        registry.register("dispatch-1").expect("register dispatch");
        registry.register("dispatch-2").expect("register dispatch");
        assert!(registry
            .snapshot()
            .expect("snapshot")
            .contains("dispatch-1"));
        assert!(registry.remove("dispatch-1").expect("remove dispatch"));
        let active = registry.snapshot().expect("snapshot after remove");
        assert!(!active.contains("dispatch-1"));
        assert!(active.contains("dispatch-2"));
    }
}
