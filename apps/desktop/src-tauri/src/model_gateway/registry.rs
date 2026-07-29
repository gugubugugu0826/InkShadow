use std::collections::HashMap;
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;

use super::error::CommandError;

#[derive(Debug, Default)]
pub(crate) struct GenerationRegistry {
    entries: Mutex<HashMap<String, CancellationToken>>,
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
}
