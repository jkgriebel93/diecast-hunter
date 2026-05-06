//! Progress event emitter used by long-running sync/enrich operations to
//! drive the global ActivityBar in the frontend.
//!
//! Each operation gets a `ProgressEmitter` carrying an op identifier (e.g.
//! "prewarm", "watchlist") and an optional Tauri AppHandle. Calls to
//! `step()` and `done()` emit a "progress" event the frontend listens for.
//! When the AppHandle is None (tests, or callers that don't need progress)
//! the emitter is a no-op.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct ProgressEvent {
    pub op: String,
    pub label: String,
    pub current: Option<u32>,
    pub total: Option<u32>,
    pub done: bool,
    pub error: bool,
}

#[derive(Clone)]
pub struct ProgressEmitter {
    app: Option<AppHandle>,
    op: String,
}

impl ProgressEmitter {
    pub fn new(app: AppHandle, op: impl Into<String>) -> Self {
        Self {
            app: Some(app),
            op: op.into(),
        }
    }

    /// Headless emitter — useful when an orchestration is invoked outside
    /// a Tauri command (e.g. in unit tests).
    pub fn null(op: impl Into<String>) -> Self {
        Self {
            app: None,
            op: op.into(),
        }
    }

    pub fn step(
        &self,
        label: impl Into<String>,
        current: Option<u32>,
        total: Option<u32>,
    ) {
        self.emit(label.into(), current, total, false, false);
    }

    pub fn done(&self, label: impl Into<String>) {
        self.emit(label.into(), None, None, true, false);
    }

    pub fn fail(&self, label: impl Into<String>) {
        self.emit(label.into(), None, None, true, true);
    }

    fn emit(
        &self,
        label: String,
        current: Option<u32>,
        total: Option<u32>,
        done: bool,
        error: bool,
    ) {
        if let Some(app) = &self.app {
            let payload = ProgressEvent {
                op: self.op.clone(),
                label,
                current,
                total,
                done,
                error,
            };
            if let Err(e) = app.emit("progress", payload) {
                tracing::debug!("progress emit failed (non-fatal): {e}");
            }
        }
    }
}
