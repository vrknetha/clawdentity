use serde_json::Value;

pub(super) fn extract_message_content(payload: &Value) -> String {
    if let Some(content) = payload.get("content").and_then(Value::as_str) {
        return content.to_string();
    }
    if let Some(message) = payload.get("message").and_then(Value::as_str) {
        return message.to_string();
    }
    if let Some(text) = payload.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(text) = payload.as_str() {
        return text.to_string();
    }
    payload.to_string()
}
