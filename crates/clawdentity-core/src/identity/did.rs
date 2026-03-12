use std::net::IpAddr;

use ulid::Ulid;

use crate::error::{CoreError, Result};

const DID_SCHEME: &str = "did";
const DID_METHOD: &str = "cdi";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DidEntity {
    Human,
    Agent,
}

impl DidEntity {
    fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Agent => "agent",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "human" => Some(Self::Human),
            "agent" => Some(Self::Agent),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDid {
    pub method: String,
    pub authority: String,
    pub entity: DidEntity,
    pub ulid: String,
}

fn is_valid_dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && !value.starts_with('-')
        && !value.ends_with('-')
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
}

fn is_valid_dns_authority(value: &str) -> bool {
    let labels: Vec<&str> = value.split('.').collect();
    labels.len() >= 2 && labels.into_iter().all(is_valid_dns_label)
}

fn validate_ulid(value: &str, context: &str) -> Result<()> {
    Ulid::from_string(value)
        .map_err(|_| CoreError::InvalidInput(format!("{context} must be a valid ULID")))?;
    Ok(())
}

/// TODO(clawdentity): document `normalize_did_authority`.
pub fn normalize_did_authority(value: &str) -> Result<String> {
    let authority = value.trim().to_ascii_lowercase();
    let valid = authority == "localhost"
        || authority.parse::<IpAddr>().is_ok()
        || is_valid_dns_authority(&authority);
    if !valid {
        return Err(CoreError::InvalidInput(
            "DID authority must be a valid hostname".to_string(),
        ));
    }
    Ok(authority)
}

/// TODO(clawdentity): document `did_authority_from_url`.
pub fn did_authority_from_url(url: &str, field_name: &str) -> Result<String> {
    let parsed = url::Url::parse(url)
        .map_err(|_| CoreError::InvalidInput(format!("{field_name} must be a valid URL")))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| CoreError::InvalidInput(format!("{field_name} must include a host")))?;
    normalize_did_authority(host)
}

/// TODO(clawdentity): document `make_did`.
pub fn make_did(authority: &str, entity: DidEntity, ulid: &str) -> Result<String> {
    let authority = normalize_did_authority(authority)?;
    validate_ulid(ulid, "DID ulid")?;
    Ok(format!(
        "{DID_SCHEME}:{DID_METHOD}:{authority}:{}:{ulid}",
        entity.as_str()
    ))
}

/// TODO(clawdentity): document `make_human_did`.
pub fn make_human_did(authority: &str, ulid: &str) -> Result<String> {
    make_did(authority, DidEntity::Human, ulid)
}

/// TODO(clawdentity): document `make_agent_did`.
pub fn make_agent_did(authority: &str, ulid: &str) -> Result<String> {
    make_did(authority, DidEntity::Agent, ulid)
}

/// TODO(clawdentity): document `new_human_did`.
pub fn new_human_did(authority: &str) -> Result<String> {
    make_human_did(authority, &Ulid::new().to_string())
}

/// TODO(clawdentity): document `new_agent_did`.
pub fn new_agent_did(authority: &str) -> Result<String> {
    make_agent_did(authority, &Ulid::new().to_string())
}

/// TODO(clawdentity): document `parse_did`.
pub fn parse_did(value: &str) -> Result<ParsedDid> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 5 {
        return Err(CoreError::InvalidInput(format!("Invalid DID: {value}")));
    }

    let [scheme, method, raw_authority, raw_entity, raw_ulid] =
        [parts[0], parts[1], parts[2], parts[3], parts[4]];
    if scheme != DID_SCHEME || method != DID_METHOD {
        return Err(CoreError::InvalidInput(format!("Invalid DID: {value}")));
    }

    let authority = normalize_did_authority(raw_authority)
        .map_err(|_| CoreError::InvalidInput(format!("Invalid DID: {value}")))?;
    if authority != raw_authority {
        return Err(CoreError::InvalidInput(format!("Invalid DID: {value}")));
    }

    let entity = DidEntity::from_str(raw_entity)
        .ok_or_else(|| CoreError::InvalidInput(format!("Invalid DID: {value}")))?;
    validate_ulid(raw_ulid, "DID ulid")
        .map_err(|_| CoreError::InvalidInput(format!("Invalid DID: {value}")))?;

    Ok(ParsedDid {
        method: DID_METHOD.to_string(),
        authority,
        entity,
        ulid: raw_ulid.to_string(),
    })
}

/// TODO(clawdentity): document `parse_agent_did`.
pub fn parse_agent_did(value: &str) -> Result<ParsedDid> {
    let did = parse_did(value)?;
    if did.entity != DidEntity::Agent {
        return Err(CoreError::InvalidInput(format!(
            "Invalid agent DID: {value}"
        )));
    }
    Ok(did)
}

/// TODO(clawdentity): document `parse_human_did`.
pub fn parse_human_did(value: &str) -> Result<ParsedDid> {
    let did = parse_did(value)?;
    if did.entity != DidEntity::Human {
        return Err(CoreError::InvalidInput(format!(
            "Invalid human DID: {value}"
        )));
    }
    Ok(did)
}

#[cfg(test)]
mod tests {
    use super::{
        DidEntity, did_authority_from_url, make_agent_did, make_human_did, parse_agent_did,
        parse_did, parse_human_did,
    };

    const AUTHORITY: &str = "registry.clawdentity.com";
    const AGENT_ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const HUMAN_ULID: &str = "01HF7YAT31JZHSMW1CG6Q6MHB7";

    #[test]
    fn make_human_did_uses_expected_format() {
        let did = make_human_did(AUTHORITY, HUMAN_ULID).expect("did");
        assert_eq!(
            did,
            "did:cdi:registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7"
        );
    }

    #[test]
    fn make_agent_did_uses_expected_format() {
        let did = make_agent_did(AUTHORITY, AGENT_ULID).expect("did");
        assert_eq!(
            did,
            "did:cdi:registry.clawdentity.com:agent:01ARZ3NDEKTSV4RRFFQ69G5FAV"
        );
    }

    #[test]
    fn parse_did_accepts_expected_format() {
        let did = "did:cdi:registry.clawdentity.com:agent:01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let parsed = parse_did(did).expect("did should parse");
        assert_eq!(parsed.method, "cdi");
        assert_eq!(parsed.authority, AUTHORITY);
        assert_eq!(parsed.entity, DidEntity::Agent);
        assert_eq!(parsed.ulid, AGENT_ULID);
    }

    #[test]
    fn parse_did_rejects_invalid_values() {
        assert!(parse_did("did:claw:agent:not-ulid").is_err());
        assert!(parse_did("did:cdi:bad_authority:agent:01ARZ3NDEKTSV4RRFFQ69G5FAV").is_err());
        assert!(
            parse_did("did:cdi:registry.clawdentity.com:robot:01ARZ3NDEKTSV4RRFFQ69G5FAV").is_err()
        );
        assert!(parse_did("did:cdi:registry.clawdentity.com:agent:not-ulid").is_err());
    }

    #[test]
    fn parse_entity_specific_helpers_enforce_entity() {
        let agent_did = "did:cdi:registry.clawdentity.com:agent:01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let human_did = "did:cdi:registry.clawdentity.com:human:01HF7YAT31JZHSMW1CG6Q6MHB7";
        assert!(parse_agent_did(agent_did).is_ok());
        assert!(parse_human_did(human_did).is_ok());
        assert!(parse_agent_did(human_did).is_err());
        assert!(parse_human_did(agent_did).is_err());
    }

    #[test]
    fn derives_authority_from_url() {
        let authority = did_authority_from_url("https://registry.clawdentity.com/v1/keys", "iss")
            .expect("authority");
        assert_eq!(authority, AUTHORITY);
    }
}
