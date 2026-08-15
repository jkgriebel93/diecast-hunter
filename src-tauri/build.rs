use tauri_build::{Attributes, WindowsAttributes};

fn main() {
    // The app manifest comes from the linker args below rather than from
    // tauri_build's embedded resource — see `manifest_common_controls_v6`.
    tauri_build::try_build(
        Attributes::new().windows_attributes(WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build");
    manifest_common_controls_v6();
}

/// Declare the Common-Controls v6 side-by-side dependency for *every* binary
/// this crate produces, the test harness included. Without it `cargo test`
/// cannot run at all on Windows.
///
/// # The failure
///
/// The whole test harness fails to *load*: exit code `0xc0000139`
/// (`STATUS_ENTRYPOINT_NOT_FOUND`), before a single test runs and with no
/// indication of which test is at fault. It is not any individual test.
/// `tray-icon` and `muda`, pulled in by tauri's `tray-icon` feature, import
/// `SetWindowSubclass`, `RemoveWindowSubclass`, `DefSubclassProc` and
/// `TaskDialogIndirect` from `comctl32.dll`, and those four are exported only
/// by **version 6** of that DLL. A binary binds to v6 solely by declaring the
/// dependency in its application manifest; without one it gets the v5.82
/// comctl32 in System32, where those entry points do not exist.
///
/// This supersedes the previous note in CLAUDE.md, which read the crash as "a
/// test reached `DcrClient` or the keyring". That was a coincidence of timing
/// — the process dies during image load, so *which* tests exist has never
/// mattered.
///
/// # Why the manifest moved here
///
/// `tauri_build` embeds its own manifest (whose entire content is this same
/// dependency) as a Windows resource, and that resource is linked into the
/// **bin** target only. Adding `/MANIFEST:EMBED` on top of it produces
/// `CVT1100: duplicate resource. type:MANIFEST, name:1`, and Cargo has no
/// "everything except bins" link-arg scope to dodge that with —
/// `rustc-link-arg-tests` covers `tests/` targets, not a lib's own unit-test
/// harness. So the resource is switched off at the source
/// (`new_without_app_manifest`) and the manifest is declared here instead,
/// once, for every target uniformly.
///
/// If a richer manifest is ever needed (DPI awareness, `longPathAware`, a
/// requested execution level), the move is to write a `.manifest` file and
/// pass `/MANIFESTINPUT:` alongside these — not to re-enable the resource,
/// which would put the bin and the tests back on different manifests.
fn manifest_common_controls_v6() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}
