use crate::error::{CoreError, Result};
use crate::http::client;

#[derive(Debug, Clone)]
pub struct DeliveryWebhookRuntimeConfig {
    pub webhook_url: String,
    pub health_url: Option<String>,
    pub webhook_headers: Vec<(String, String)>,
}

impl DeliveryWebhookRuntimeConfig {
    /// Validate and normalize the configured delivery webhook URL.
    pub fn validated_webhook_url(&self) -> Result<String> {
        let url = self.webhook_url.trim();
        if url.is_empty() {
            return Err(CoreError::InvalidInput(
                "delivery webhook url is required".to_string(),
            ));
        }
        let parsed = url::Url::parse(url).map_err(|_| CoreError::InvalidUrl {
            context: "deliveryWebhookUrl",
            value: url.to_string(),
        })?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err(CoreError::InvalidInput(
                "delivery webhook url must use http or https".to_string(),
            ));
        }
        Ok(parsed.to_string())
    }
}

/// Check whether the local delivery webhook endpoint is reachable.
///
/// If `health_url` is provided, it is probed; otherwise `webhook_url` is probed.
pub async fn check_delivery_webhook_health(
    webhook_url: &str,
    health_url: Option<&str>,
) -> Result<bool> {
    let using_explicit_health_url = health_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some();
    let url = health_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| webhook_url.trim());
    if url.is_empty() {
        return Err(CoreError::InvalidInput(
            "delivery webhook url is required".to_string(),
        ));
    }
    let context = if using_explicit_health_url {
        "deliveryHealthUrl"
    } else {
        "deliveryWebhookUrl"
    };
    let parsed = url::Url::parse(url).map_err(|_| CoreError::InvalidUrl {
        context,
        value: url.to_string(),
    })?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(CoreError::InvalidInput(
            "delivery health URL must use http or https".to_string(),
        ));
    }
    let response = client()?
        .get(parsed)
        .send()
        .await
        .map_err(|error| CoreError::Http(error.to_string()))?;
    Ok(response.status().is_success())
}

#[cfg(test)]
mod tests {
    use super::{DeliveryWebhookRuntimeConfig, check_delivery_webhook_health};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn validates_delivery_webhook_url() {
        let config = DeliveryWebhookRuntimeConfig {
            webhook_url: "http://127.0.0.1:19400/hooks/message".to_string(),
            health_url: None,
            webhook_headers: Vec::new(),
        };
        let url = config.validated_webhook_url().expect("webhook url");
        assert_eq!(url, "http://127.0.0.1:19400/hooks/message");
    }

    #[tokio::test]
    async fn default_webhook_health_requires_success_status() {
        let server = MockServer::start().await;
        let webhook_url = format!("{}/hooks/message", server.uri());

        let missing_endpoint_is_unhealthy = check_delivery_webhook_health(&webhook_url, None)
            .await
            .expect("health check");
        assert!(!missing_endpoint_is_unhealthy);

        Mock::given(method("GET"))
            .and(path("/hooks/message"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let healthy = check_delivery_webhook_health(&webhook_url, None)
            .await
            .expect("health check");
        assert!(healthy);
    }

    #[tokio::test]
    async fn explicit_health_url_requires_success_status() {
        let server = MockServer::start().await;
        let webhook_url = format!("{}/hooks/message", server.uri());
        let unhealthy_health_url = format!("{}/health/unhealthy", server.uri());
        let healthy_health_url = format!("{}/health/healthy", server.uri());

        Mock::given(method("GET"))
            .and(path("/health/unhealthy"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/health/healthy"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let unhealthy = check_delivery_webhook_health(&webhook_url, Some(&unhealthy_health_url))
            .await
            .expect("health check");
        assert!(!unhealthy);

        let healthy = check_delivery_webhook_health(&webhook_url, Some(&healthy_health_url))
            .await
            .expect("health check");
        assert!(healthy);
    }
}
