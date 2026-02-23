use std::fs;
use std::path::{Path, PathBuf};

use image::Luma;
use qrcode::QrCode;

use crate::error::{CoreError, Result};

pub const PAIRING_QR_DIR_NAME: &str = "pairing";
pub const PAIRING_QR_MAX_AGE_SECONDS: i64 = 900;

fn parse_qr_issued_at_seconds(file_name: &str) -> Option<i64> {
    let without_ext = file_name.strip_suffix(".png")?;
    let (_, maybe_seconds) = without_ext.rsplit_once("-pair-")?;
    maybe_seconds.parse::<i64>().ok()
}

/// TODO(clawdentity): document `encode_ticket_qr_png`.
pub fn encode_ticket_qr_png(ticket: &str) -> Result<Vec<u8>> {
    let ticket = ticket.trim();
    if ticket.is_empty() {
        return Err(CoreError::InvalidInput(
            "pairing ticket is required".to_string(),
        ));
    }
    let code = QrCode::new(ticket.as_bytes())
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    let image = code.render::<Luma<u8>>().max_dimensions(512, 512).build();
    let mut bytes = Vec::<u8>::new();
    image::DynamicImage::ImageLuma8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    Ok(bytes)
}

/// TODO(clawdentity): document `decode_ticket_from_png`.
pub fn decode_ticket_from_png(image_bytes: &[u8]) -> Result<String> {
    let image = image::load_from_memory(image_bytes)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    let luma = image.to_luma8();
    let mut decoder = quircs::Quirc::default();
    let codes = decoder.identify(luma.width() as usize, luma.height() as usize, luma.as_raw());

    for code in codes {
        let Ok(code) = code else {
            continue;
        };
        let Ok(decoded) = code.decode() else {
            continue;
        };
        let text = String::from_utf8(decoded.payload)
            .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    Err(CoreError::InvalidInput(
        "no pairing QR code found in image".to_string(),
    ))
}

/// TODO(clawdentity): document `persist_pairing_qr`.
#[allow(clippy::too_many_lines)]
pub fn persist_pairing_qr(
    config_dir: &Path,
    agent_name: &str,
    ticket: &str,
    qr_output: Option<&Path>,
    now_unix_seconds: i64,
) -> Result<PathBuf> {
    let ticket = ticket.trim();
    if ticket.is_empty() {
        return Err(CoreError::InvalidInput(
            "pairing ticket is required".to_string(),
        ));
    }

    let base_dir = config_dir.join(PAIRING_QR_DIR_NAME);
    if base_dir.exists() {
        for entry in fs::read_dir(&base_dir).map_err(|source| CoreError::Io {
            path: base_dir.clone(),
            source,
        })? {
            let entry = entry.map_err(|source| CoreError::Io {
                path: base_dir.clone(),
                source,
            })?;
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(issued_at) = parse_qr_issued_at_seconds(file_name) else {
                continue;
            };
            if issued_at + PAIRING_QR_MAX_AGE_SECONDS > now_unix_seconds {
                continue;
            }
            let _ = fs::remove_file(&path);
        }
    }

    let output_path = match qr_output {
        Some(path) => path.to_path_buf(),
        None => base_dir.join(format!("{agent_name}-pair-{now_unix_seconds}.png")),
    };

    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|source| CoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }

    let bytes = encode_ticket_qr_png(ticket)?;
    fs::write(&output_path, bytes).map_err(|source| CoreError::Io {
        path: output_path.clone(),
        source,
    })?;

    Ok(output_path)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::{decode_ticket_from_png, encode_ticket_qr_png, persist_pairing_qr};

    #[test]
    fn encode_and_decode_round_trip() {
        let ticket = "clwpair1_dGVzdA";
        let png = encode_ticket_qr_png(ticket).expect("encode");
        let decoded = decode_ticket_from_png(&png).expect("decode");
        assert_eq!(decoded, ticket);
    }

    #[test]
    fn persist_pairing_qr_writes_png() {
        let temp = TempDir::new().expect("temp dir");
        let path = persist_pairing_qr(temp.path(), "alpha", "clwpair1_dGVzdA", None, 1_700_000_000)
            .expect("persist");
        assert!(path.exists());
    }
}
