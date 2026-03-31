use crate::error::{CoreError, Result};

pub(crate) fn parse_agent_name(name: &str) -> Result<String> {
    let candidate = name.trim();
    if candidate.is_empty() {
        return Err(CoreError::InvalidInput(
            "agent name is required".to_string(),
        ));
    }
    if candidate == "." || candidate == ".." {
        return Err(CoreError::InvalidInput(
            "agent name must not be . or ..".to_string(),
        ));
    }
    if candidate.len() > 64 {
        return Err(CoreError::InvalidInput(
            "agent name must be <= 64 characters".to_string(),
        ));
    }
    let valid = candidate
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.');
    if !valid {
        return Err(CoreError::InvalidInput(
            "agent name contains invalid characters".to_string(),
        ));
    }
    Ok(candidate.to_string())
}
