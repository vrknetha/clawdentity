use crate::error::{CoreError, Result};
use crate::http::client;

#[derive(Debug, Clone)]
pub struct OpenclawRuntimeConfig {
    pub base_url: String,
    pub hook_path: String,
    pub hook_token: Option<String>,
}

impl OpenclawRuntimeConfig {
    /// TODO(clawdentity): document `hook_url`.
    pub fn hook_url(&self) -> Result<String> {
        let base = self.base_url.trim();
        if base.is_empty() {
            return Err(CoreError::InvalidInput(
                "openclaw base_url is required".to_string(),
            ));
        }
        let path = if self.hook_path.trim().is_empty() {
            "/v1/hooks/relay"
        } else {
            self.hook_path.trim()
        };
        let base_url = url::Url::parse(base).map_err(|_| CoreError::InvalidUrl {
            context: "openclawBaseUrl",
            value: base.to_string(),
        })?;
        let joined = base_url.join(path).map_err(|_| CoreError::InvalidUrl {
            context: "openclawHookPath",
            value: path.to_string(),
        })?;
        Ok(joined.to_string())
    }
}

/// TODO(clawdentity): document `check_openclaw_gateway_health`.
pub async fn check_openclaw_gateway_health(base_url: &str) -> Result<bool> {
    let base = base_url.trim();
    if base.is_empty() {
        return Err(CoreError::InvalidInput(
            "openclaw base url is required".to_string(),
        ));
    }
    let health_url = url::Url::parse(base)
        .map_err(|_| CoreError::InvalidUrl {
            context: "openclawBaseUrl",
            value: base.to_string(),
        })?
        .join("/health")
        .map_err(|_| CoreError::InvalidUrl {
            context: "openclawBaseUrl",
            value: base.to_string(),
        })?;
    let response = client()?
        .get(health_url)
        .send()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;
    Ok(response.status().is_success())
}

#[cfg(test)]
mod tests {
    use super::OpenclawRuntimeConfig;

    #[test]
    fn builds_hook_url_from_base_and_path() {
        let config = OpenclawRuntimeConfig {
            base_url: "http://127.0.0.1:11434".to_string(),
            hook_path: "/v1/hooks/relay".to_string(),
            hook_token: None,
        };
        let url = config.hook_url().expect("hook url");
        assert_eq!(url, "http://127.0.0.1:11434/v1/hooks/relay");
    }
}
