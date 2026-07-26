//! Windows Task Scheduler integration for the periodic background sync.
//!
//! When the user enables auto-sync on the Settings page we register a task
//! that runs `diecast-hunter.exe --sync` every N hours (see
//! `crate::sync::auto_sync` and `crate::run_headless_sync`). Unlike an
//! in-process timer, this fires even when the app is closed — as long as the
//! user is logged in (the task runs with the interactive token so it can reach
//! the per-user Credential Manager entries the syncs need).
//!
//! Implemented by shelling out to the built-in `schtasks.exe` rather than
//! taking a dependency on the Task Scheduler COM API.

use std::process::Command;

use crate::error::{AppError, AppResult};

/// Name the task is registered under. Visible in Task Scheduler's library.
const TASK_NAME: &str = "DiecastHunter Auto Sync";

/// `CREATE_NO_WINDOW` — keep `schtasks` from flashing a console window when
/// spawned from the GUI process.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn schtasks() -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new("schtasks.exe");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
fn schtasks() -> Command {
    Command::new("schtasks.exe")
}

/// Reconcile the scheduled task with the desired state. Enabling (re)creates
/// it with the given interval; disabling removes it. Idempotent.
pub fn apply(enabled: bool, interval_hours: u32) -> AppResult<()> {
    if !enabled {
        return remove();
    }

    let exe = std::env::current_exe()?;
    let exe = exe.to_string_lossy();
    // schtasks parses /TR itself; wrap the exe path in escaped quotes so a
    // path containing spaces survives, then append our headless flag.
    let action = format!("\"{exe}\" --sync");

    let output = schtasks()
        .args([
            "/Create",
            "/TN",
            TASK_NAME,
            "/TR",
            &action,
            "/SC",
            "HOURLY",
            "/MO",
            &interval_hours.to_string(),
            // Overwrite any existing task so interval edits take effect.
            "/F",
        ])
        .output()?;

    if !output.status.success() {
        return Err(AppError::Config(format!(
            "schtasks /Create failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}

/// Remove the task if present. A missing task is a no-op, not an error.
pub fn remove() -> AppResult<()> {
    // Check first rather than parsing locale-dependent "does not exist" text
    // out of a failed /Delete.
    if !exists() {
        return Ok(());
    }
    let output = schtasks()
        .args(["/Delete", "/TN", TASK_NAME, "/F"])
        .output()?;
    if !output.status.success() {
        return Err(AppError::Config(format!(
            "schtasks /Delete failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}

/// Whether the task is currently registered.
pub fn exists() -> bool {
    schtasks()
        .args(["/Query", "/TN", TASK_NAME])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
