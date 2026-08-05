//! Progress event emitter + cooperative cancellation token used by
//! long-running sync/enrich operations.
//!
//! Each operation gets a `ProgressEmitter` carrying:
//!   - an op identifier (e.g. "prewarm", "watchlist")
//!   - an optional Tauri AppHandle for emitting "progress" events
//!   - an Arc<AtomicBool> the orchestrator polls between iterations to
//!     bail early when the user clicks Cancel.
//!
//! The cancel handle is shared with the AppState so a Tauri "cancel"
//! command can flip it without holding a reference to the operation
//! itself.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

#[derive(Clone, Serialize)]
pub struct ProgressEvent {
    pub op: String,
    pub label: String,
    pub current: Option<u32>,
    pub total: Option<u32>,
    pub done: bool,
    pub error: bool,
    pub cancelled: bool,
}

#[derive(Clone)]
pub struct ProgressEmitter {
    app: Option<AppHandle>,
    op: String,
    cancelled: Arc<AtomicBool>,
}

impl ProgressEmitter {
    pub fn new(app: AppHandle, op: impl Into<String>) -> Self {
        Self {
            app: Some(app),
            op: op.into(),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Headless emitter for background tasks (startup backfills, etc.)
    /// that don't have an AppHandle and don't surface progress to the UI.
    /// `step`/`done`/`fail` become no-ops; `check_cancelled` still works.
    pub fn null(op: impl Into<String>) -> Self {
        Self {
            app: None,
            op: op.into(),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Hand the cancel token out so the AppState can flip it from a
    /// separate Tauri command.
    pub fn cancel_handle(&self) -> Arc<AtomicBool> {
        self.cancelled.clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// Convenient `?`-able guard. Call before each loop iteration / before
    /// each network round trip.
    pub fn check_cancelled(&self) -> AppResult<()> {
        if self.is_cancelled() {
            Err(AppError::Cancelled)
        } else {
            Ok(())
        }
    }

    pub fn step(&self, label: impl Into<String>, current: Option<u32>, total: Option<u32>) {
        self.emit(label.into(), current, total, false, false, false);
    }

    pub fn done(&self, label: impl Into<String>) {
        self.emit(label.into(), None, None, true, false, false);
    }

    pub fn fail(&self, label: impl Into<String>) {
        self.emit(label.into(), None, None, true, true, false);
    }

    pub fn cancelled_event(&self, label: impl Into<String>) {
        self.emit(label.into(), None, None, true, false, true);
    }

    fn emit(
        &self,
        label: String,
        current: Option<u32>,
        total: Option<u32>,
        done: bool,
        error: bool,
        cancelled: bool,
    ) {
        if let Some(app) = &self.app {
            let payload = ProgressEvent {
                op: self.op.clone(),
                label,
                current,
                total,
                done,
                error,
                cancelled,
            };
            if let Err(e) = app.emit("progress", payload) {
                tracing::debug!("progress emit failed (non-fatal): {e}");
            }
        }
    }
}
