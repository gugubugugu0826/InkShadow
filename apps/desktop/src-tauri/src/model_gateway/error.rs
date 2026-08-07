use reqwest::StatusCode;
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    code: &'static str,
    message: &'static str,
    retryable: bool,
    actions: Vec<&'static str>,
    request_id: String,
}

impl CommandError {
    pub(crate) fn new(
        code: &'static str,
        message: &'static str,
        retryable: bool,
        actions: Vec<&'static str>,
    ) -> Self {
        Self::new_with_request_id(
            code,
            message,
            retryable,
            actions,
            Uuid::now_v7().to_string(),
        )
    }

    pub(crate) fn new_with_request_id(
        code: &'static str,
        message: &'static str,
        retryable: bool,
        actions: Vec<&'static str>,
        request_id: String,
    ) -> Self {
        Self {
            code,
            message,
            retryable,
            actions,
            request_id,
        }
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }

    pub(crate) fn retryable(&self) -> bool {
        self.retryable
    }

    pub(crate) fn credential_store_unavailable() -> Self {
        Self::new(
            "CREDENTIAL_STORE_UNAVAILABLE",
            "The operating system credential store is unavailable.",
            true,
            vec!["RETRY", "OPEN_DIAGNOSTICS"],
        )
    }

    pub(crate) fn credential_missing() -> Self {
        Self::new(
            "MODEL_CREDENTIAL_MISSING",
            "No credential is stored for this model provider.",
            false,
            vec!["EDIT_API_KEY"],
        )
    }

    pub(crate) fn endpoint_invalid() -> Self {
        Self::new(
            "MODEL_ENDPOINT_INVALID",
            "The model endpoint does not satisfy the network safety policy.",
            false,
            vec!["EDIT_MODEL_CONFIG"],
        )
    }

    pub(crate) fn request_invalid() -> Self {
        Self::new(
            "MODEL_REQUEST_INVALID",
            "The model request is invalid or exceeds a field limit.",
            false,
            vec!["EDIT_MODEL_CONFIG", "EDIT_PROMPT"],
        )
    }

    pub(crate) fn operation_unsupported() -> Self {
        Self::new(
            "MODEL_OPERATION_UNSUPPORTED",
            "This provider protocol does not support the requested model operation.",
            false,
            vec!["SWITCH_MODEL", "EDIT_MODEL_CONFIG"],
        )
    }

    pub(crate) fn input_limit_exceeded() -> Self {
        Self::new(
            "MODEL_INPUT_LIMIT_EXCEEDED",
            "The model input exceeds the native gateway limit.",
            false,
            vec!["REDUCE_CONTEXT"],
        )
    }

    pub(crate) fn output_limit_exceeded() -> Self {
        Self::new(
            "MODEL_OUTPUT_LIMIT_EXCEEDED",
            "The requested or received model output exceeds the native gateway limit.",
            false,
            vec!["REDUCE_OUTPUT"],
        )
    }

    pub(crate) fn response_limit_exceeded() -> Self {
        Self::new(
            "MODEL_RESPONSE_LIMIT_EXCEEDED",
            "The provider response exceeds the native gateway limit.",
            false,
            vec!["REDUCE_OUTPUT", "OPEN_DIAGNOSTICS"],
        )
    }

    pub(crate) fn response_invalid() -> Self {
        Self::new(
            "MODEL_RESPONSE_INVALID",
            "The provider returned an invalid response.",
            false,
            vec!["RETRY", "EDIT_MODEL_CONFIG"],
        )
    }

    pub(crate) fn stream_truncated() -> Self {
        Self::new(
            "MODEL_STREAM_TRUNCATED",
            "The provider stream ended before a completion marker.",
            true,
            vec!["RETRY", "OPEN_DIAGNOSTICS"],
        )
    }

    pub(crate) fn provider_error() -> Self {
        Self::new(
            "MODEL_PROVIDER_ERROR",
            "The provider reported an error in an otherwise successful response.",
            true,
            vec!["RETRY", "EDIT_MODEL_CONFIG"],
        )
    }

    pub(crate) fn timeout() -> Self {
        Self::new(
            "MODEL_TIMEOUT",
            "The model request timed out.",
            true,
            vec!["RETRY", "REDUCE_CONTEXT"],
        )
    }

    pub(crate) fn connection_failed() -> Self {
        Self::new(
            "MODEL_CONNECTION_FAILED",
            "The native gateway could not connect to the model endpoint.",
            true,
            vec!["RETRY", "EDIT_MODEL_CONFIG"],
        )
    }

    pub(crate) fn duplicate_generation() -> Self {
        Self::new(
            "MODEL_GENERATION_DUPLICATE",
            "A generation with this identifier is already active.",
            false,
            vec!["WAIT", "CANCEL_GENERATION"],
        )
    }

    pub(crate) fn registry_unavailable() -> Self {
        Self::new(
            "MODEL_GENERATION_REGISTRY_UNAVAILABLE",
            "The native generation registry is unavailable.",
            true,
            vec!["RETRY"],
        )
    }

    pub(crate) fn event_emit_failed() -> Self {
        Self::new(
            "MODEL_EVENT_EMIT_FAILED",
            "The native gateway could not deliver a generation event.",
            true,
            vec!["RETRY"],
        )
    }

    pub(crate) fn runtime_failed() -> Self {
        Self::new(
            "MODEL_RUNTIME_FAILED",
            "The native model task could not be started.",
            true,
            vec!["RETRY", "OPEN_DIAGNOSTICS"],
        )
    }

    pub(crate) fn from_reqwest(error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            Self::timeout()
        } else {
            Self::connection_failed()
        }
    }

    pub(crate) fn from_http_status(status: StatusCode) -> Self {
        if status.is_redirection() {
            return Self::new(
                "MODEL_HTTP_REDIRECT_FORBIDDEN",
                "Model endpoint redirects are forbidden.",
                false,
                vec!["EDIT_MODEL_CONFIG"],
            );
        }

        match status.as_u16() {
            400 | 422 => Self::new(
                "MODEL_HTTP_BAD_REQUEST",
                "The provider rejected the model request.",
                false,
                vec!["EDIT_MODEL_CONFIG", "EDIT_PROMPT"],
            ),
            401 => Self::new(
                "MODEL_HTTP_UNAUTHORIZED",
                "The provider rejected the stored credential.",
                false,
                vec!["EDIT_API_KEY"],
            ),
            403 => Self::new(
                "MODEL_HTTP_FORBIDDEN",
                "The provider denied access to this model operation.",
                false,
                vec!["EDIT_API_KEY", "EDIT_MODEL_CONFIG"],
            ),
            404 => Self::new(
                "MODEL_HTTP_NOT_FOUND",
                "The provider endpoint or model was not found.",
                false,
                vec!["EDIT_MODEL_CONFIG"],
            ),
            408 | 504 => Self::timeout(),
            409 => Self::new(
                "MODEL_HTTP_CONFLICT",
                "The provider reported a request conflict.",
                true,
                vec!["RETRY"],
            ),
            413 => Self::input_limit_exceeded(),
            429 => Self::new(
                "MODEL_HTTP_RATE_LIMITED",
                "The provider rate limit was reached.",
                true,
                vec!["RETRY", "SWITCH_MODEL"],
            ),
            500..=599 => Self::new(
                "MODEL_HTTP_PROVIDER_UNAVAILABLE",
                "The provider is temporarily unavailable.",
                true,
                vec!["RETRY", "SWITCH_MODEL"],
            ),
            _ => Self::new(
                "MODEL_HTTP_ERROR",
                "The provider returned an unsuccessful HTTP status.",
                false,
                vec!["EDIT_MODEL_CONFIG", "OPEN_DIAGNOSTICS"],
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_http_statuses_to_stable_non_body_error_codes() {
        assert_eq!(
            CommandError::from_http_status(StatusCode::UNAUTHORIZED).code(),
            "MODEL_HTTP_UNAUTHORIZED"
        );
        assert_eq!(
            CommandError::from_http_status(StatusCode::TOO_MANY_REQUESTS).code(),
            "MODEL_HTTP_RATE_LIMITED"
        );
        assert_eq!(
            CommandError::from_http_status(StatusCode::TEMPORARY_REDIRECT).code(),
            "MODEL_HTTP_REDIRECT_FORBIDDEN"
        );
        assert_eq!(
            CommandError::from_http_status(StatusCode::BAD_GATEWAY).code(),
            "MODEL_HTTP_PROVIDER_UNAVAILABLE"
        );
    }
}
