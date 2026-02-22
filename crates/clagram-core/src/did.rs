use ulid::Ulid;

use crate::error::{CoreError, Result};

const DID_PREFIX: &str = "did:cdi:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDid {
    pub host: String,
    pub id: String,
}

pub fn make_did_for_registry_host(registry_url: &str) -> Result<String> {
    let url = url::Url::parse(registry_url).map_err(|_| CoreError::InvalidUrl {
        context: "registryUrl",
        value: registry_url.to_string(),
    })?;

    let host = url.host_str().ok_or_else(|| CoreError::InvalidUrl {
        context: "registryUrl",
        value: registry_url.to_string(),
    })?;

    let ulid = Ulid::new();
    Ok(format!("{DID_PREFIX}{host}:{ulid}"))
}

pub fn parse_did(value: &str) -> Result<ParsedDid> {
    if !value.starts_with(DID_PREFIX) {
        return Err(CoreError::InvalidInput(
            "did must start with did:cdi:".to_string(),
        ));
    }

    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 4 {
        return Err(CoreError::InvalidInput(
            "did must include method, host and id".to_string(),
        ));
    }

    let host = parts[2].trim();
    let id = parts[3].trim();
    if host.is_empty() || id.is_empty() {
        return Err(CoreError::InvalidInput(
            "did host and id must be non-empty".to_string(),
        ));
    }

    Ulid::from_string(id)
        .map_err(|_| CoreError::InvalidInput("did id must be a valid ULID".to_string()))?;

    Ok(ParsedDid {
        host: host.to_string(),
        id: id.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{make_did_for_registry_host, parse_did};

    #[test]
    fn make_did_uses_registry_host() {
        let did = make_did_for_registry_host("https://registry.clagram.com")
            .expect("did should be created");
        assert!(did.starts_with("did:cdi:registry.clagram.com:"));
    }

    #[test]
    fn parse_did_accepts_expected_format() {
        let did = "did:cdi:registry.clagram.com:01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let parsed = parse_did(did).expect("did should parse");
        assert_eq!(parsed.host, "registry.clagram.com");
        assert_eq!(parsed.id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    }

    #[test]
    fn parse_did_rejects_invalid_values() {
        let invalid = parse_did("did:cdi:registry.clagram.com:not-ulid");
        assert!(invalid.is_err());
    }
}
