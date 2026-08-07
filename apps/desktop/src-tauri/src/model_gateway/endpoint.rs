use reqwest::Url;

use super::error::CommandError;
use super::types::ModelEndpointConfig;
use crate::network_egress::{host_is_explicit_loopback, host_is_ip_literal, literal_ip_is_allowed};

const MAX_ENDPOINT_LENGTH: usize = 2_048;
const MAX_API_PATH_LENGTH: usize = 1_024;

#[derive(Clone, Debug)]
pub(crate) struct ValidatedEndpoint {
    base: Url,
}

impl ValidatedEndpoint {
    pub(crate) fn parse(config: &ModelEndpointConfig) -> Result<Self, CommandError> {
        let input = config.base_url.as_str();
        if input.is_empty()
            || input.len() > MAX_ENDPOINT_LENGTH
            || input.trim() != input
            || input.contains('%')
            || input.contains("/../")
            || input.contains("/./")
            || input.ends_with("/..")
            || input.ends_with("/.")
        {
            return Err(CommandError::endpoint_invalid());
        }

        let mut base = Url::parse(input).map_err(|_| CommandError::endpoint_invalid())?;
        if base.cannot_be_a_base()
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || base.port() == Some(0)
            || base.path().contains('%')
            || base.path().contains('\\')
        {
            return Err(CommandError::endpoint_invalid());
        }

        let host = base.host_str().unwrap_or_default();
        if host_is_ip_literal(host) && !literal_ip_is_allowed(host) {
            return Err(CommandError::endpoint_invalid());
        }

        match base.scheme() {
            "https" => {}
            "http" if host_is_explicit_loopback(host) => {}
            _ => return Err(CommandError::endpoint_invalid()),
        }

        let normalized_path = if base.path().is_empty() {
            "/".to_owned()
        } else {
            base.path().to_owned()
        };
        if normalized_path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
        {
            return Err(CommandError::endpoint_invalid());
        }

        let trimmed_path = normalized_path.trim_end_matches('/');
        let final_path = if trimmed_path.is_empty() {
            "/".to_owned()
        } else {
            trimmed_path.to_owned()
        };
        base.set_path(&final_path);
        Ok(Self { base })
    }

    pub(crate) fn api_url(&self, suffix: &str) -> Result<Url, CommandError> {
        if suffix.is_empty()
            || suffix.len() > MAX_API_PATH_LENGTH
            || !suffix.starts_with('/')
            || suffix.starts_with("//")
            || suffix.contains('?')
            || suffix.contains('#')
            || suffix.contains('\\')
            || suffix.contains('%')
            || suffix.chars().any(char::is_control)
            || suffix
                .split('/')
                .any(|segment| segment == "." || segment == "..")
        {
            return Err(CommandError::endpoint_invalid());
        }

        let mut url = self.base.clone();
        let base_path = self.base.path().trim_end_matches('/');
        url.set_path(&format!("{base_path}{suffix}"));
        url.set_query(None);
        url.set_fragment(None);
        Ok(url)
    }

    pub(crate) fn origin(&self) -> String {
        self.base.origin().ascii_serialization()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_gateway::types::{AuthenticationMode, ProviderKind};

    fn config(base_url: &str) -> ModelEndpointConfig {
        ModelEndpointConfig {
            provider_id: "provider-one".to_owned(),
            provider: ProviderKind::OpenAiCompatible,
            base_url: base_url.to_owned(),
            authentication: AuthenticationMode::None,
            credential_header_name: None,
            model_discovery_path: None,
            text_generation_path: None,
            embedding_path: None,
            request_timeout_ms: None,
            retry_limit: None,
        }
    }

    #[test]
    fn accepts_https_and_loopback_http() {
        assert!(ValidatedEndpoint::parse(&config("https://models.example/v1")).is_ok());
        assert!(ValidatedEndpoint::parse(&config("http://localhost:11434")).is_ok());
        assert!(ValidatedEndpoint::parse(&config("http://ollama.localhost:11434")).is_ok());
        assert!(ValidatedEndpoint::parse(&config("http://127.12.3.4:11434")).is_ok());
        assert!(ValidatedEndpoint::parse(&config("http://[::1]:11434")).is_ok());
    }

    #[test]
    fn rejects_remote_http_and_ambiguous_urls() {
        for endpoint in [
            "http://models.example/v1",
            "https://user:secret@models.example/v1",
            "https://models.example/v1?key=secret",
            "https://models.example/v1#fragment",
            "https://models.example/v1%2fescape",
            "https://models.example/v1/../admin",
            "ftp://models.example/v1",
            " https://models.example/v1",
            "https://10.0.0.1/v1",
            "https://169.254.169.254/v1",
            "https://[fc00::1]/v1",
        ] {
            assert!(
                ValidatedEndpoint::parse(&config(endpoint)).is_err(),
                "{endpoint} should be rejected"
            );
        }
    }

    #[test]
    fn appends_provider_paths_without_dropping_a_version_prefix() {
        let endpoint = ValidatedEndpoint::parse(&config("https://models.example/v1/"))
            .expect("endpoint should be valid");
        let url = endpoint
            .api_url("/chat/completions")
            .expect("route should be valid");

        assert_eq!(url.as_str(), "https://models.example/v1/chat/completions");
        assert_eq!(endpoint.origin(), "https://models.example");
    }

    #[test]
    fn rejects_ambiguous_or_traversing_api_paths() {
        let endpoint = ValidatedEndpoint::parse(&config("https://models.example/v1"))
            .expect("endpoint should be valid");
        let oversized = format!("/{}", "a".repeat(MAX_API_PATH_LENGTH));
        for path in [
            "//attacker.example/models",
            "/models?key=value",
            "/models#fragment",
            "/models\\escape",
            "/%2e%2e/admin",
            "/models/../admin",
            "/models/./list",
            "/models\nnext",
            oversized.as_str(),
        ] {
            assert!(
                endpoint.api_url(path).is_err(),
                "{path:?} should be rejected"
            );
        }
    }
}
