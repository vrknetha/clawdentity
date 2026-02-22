use ulid::Ulid;

use crate::error::{CoreError, Result};

const DID_SCHEME: &str = "did";
const DID_METHOD: &str = "claw";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClawDidKind {
    Human,
    Agent,
}

impl ClawDidKind {
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
    pub kind: ClawDidKind,
    pub ulid: String,
}

pub fn make_did(kind: ClawDidKind) -> String {
    let ulid = Ulid::new();
    format!("{DID_SCHEME}:{DID_METHOD}:{}:{ulid}", kind.as_str())
}

pub fn make_human_did() -> String {
    make_did(ClawDidKind::Human)
}

pub fn make_agent_did() -> String {
    make_did(ClawDidKind::Agent)
}

pub fn parse_did(value: &str) -> Result<ParsedDid> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 4 {
        return Err(CoreError::InvalidInput(format!("Invalid DID: {value}")));
    }

    let [scheme, method, raw_kind, raw_ulid] = [parts[0], parts[1], parts[2], parts[3]];
    if scheme != DID_SCHEME || method != DID_METHOD {
        return Err(CoreError::InvalidInput(format!("Invalid DID: {value}")));
    }

    let kind = ClawDidKind::from_str(raw_kind)
        .ok_or_else(|| CoreError::InvalidInput(format!("Invalid DID: {value}")))?;
    Ulid::from_string(raw_ulid)
        .map_err(|_| CoreError::InvalidInput(format!("Invalid DID: {value}")))?;

    Ok(ParsedDid {
        kind,
        ulid: raw_ulid.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{ClawDidKind, make_agent_did, make_human_did, parse_did};

    #[test]
    fn make_human_did_uses_expected_format() {
        let did = make_human_did();
        assert!(did.starts_with("did:claw:human:"));
    }

    #[test]
    fn make_agent_did_uses_expected_format() {
        let did = make_agent_did();
        assert!(did.starts_with("did:claw:agent:"));
    }

    #[test]
    fn parse_did_accepts_expected_format() {
        let did = "did:claw:agent:01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let parsed = parse_did(did).expect("did should parse");
        assert_eq!(parsed.kind, ClawDidKind::Agent);
        assert_eq!(parsed.ulid, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    }

    #[test]
    fn parse_did_rejects_invalid_values() {
        let invalid = parse_did("did:claw:agent:not-ulid");
        assert!(invalid.is_err());
    }
}
