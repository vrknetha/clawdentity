use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::db::now_utc_ms;

#[derive(Clone, Default)]
pub struct TrustedReceiptsStore {
    inner: Arc<Mutex<HashMap<String, i64>>>,
}

impl TrustedReceiptsStore {
    /// TODO(clawdentity): document `new`.
    pub fn new() -> Self {
        Self::default()
    }

    /// TODO(clawdentity): document `mark_trusted`.
    pub fn mark_trusted(&self, frame_id: impl Into<String>) {
        let frame_id = frame_id.into();
        if frame_id.trim().is_empty() {
            return;
        }
        if let Ok(mut guard) = self.inner.lock() {
            guard.insert(frame_id, now_utc_ms());
        }
    }

    /// TODO(clawdentity): document `is_trusted`.
    pub fn is_trusted(&self, frame_id: &str) -> bool {
        if frame_id.trim().is_empty() {
            return false;
        }
        match self.inner.lock() {
            Ok(guard) => guard.contains_key(frame_id),
            Err(_) => false,
        }
    }

    /// TODO(clawdentity): document `purge_before`.
    pub fn purge_before(&self, cutoff_ms: i64) -> usize {
        let Ok(mut guard) = self.inner.lock() else {
            return 0;
        };

        let initial_len = guard.len();
        guard.retain(|_, marked_at_ms| *marked_at_ms >= cutoff_ms);
        initial_len.saturating_sub(guard.len())
    }
}

#[cfg(test)]
mod tests {
    use super::TrustedReceiptsStore;

    #[test]
    fn marks_checks_and_purges_receipts() {
        let store = TrustedReceiptsStore::new();
        store.mark_trusted("frame-1");
        assert!(store.is_trusted("frame-1"));
        let purged = store.purge_before(i64::MAX);
        assert_eq!(purged, 1);
        assert!(!store.is_trusted("frame-1"));
    }
}
