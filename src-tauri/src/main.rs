// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Headless entry point for the OS scheduled task: run one sync and exit
    // without spinning up the GUI/webview. See crate::scheduler.
    if std::env::args().skip(1).any(|a| a == "--sync") {
        diecast_hunter_lib::run_headless_sync();
        return;
    }
    diecast_hunter_lib::run()
}
