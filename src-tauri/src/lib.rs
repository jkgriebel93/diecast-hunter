mod collection_photo;
mod commands;
mod comps;
mod db;
mod dcr;
mod ebay;
mod error;
mod export;
mod hidden_feed;
mod listing_groups;
mod listing_receiver;
mod local_collection;
mod match_feedback;
mod matcher_training;
mod presearch;
mod progress;
mod saved;
mod scheduler;
mod settings;
mod share;
mod sync;
mod wishlist;

/// Dev-harness entry points (used by `examples/retrain_dryrun.rs`); not
/// part of the app's command surface.
pub use matcher_training::{retrain as dev_retrain, status as dev_matcher_status};
pub use sync::attribute_assoc::{
    associate_all_listing_attributes as dev_attr_autofill,
    backfill_all_attrs_from_matches as dev_attr_backfill,
};

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::Manager;
use tokio::sync::Mutex;

pub struct AppState {
    pub db: db::Db,
    /// Cancel handle for the currently running long-running operation.
    /// Set by long-running command handlers, flipped by the
    /// `cancel_active_operation` command.
    pub active_op_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// Cached logged-in diecastregistry.com session, reused across registry
    /// searches so each one doesn't pay the login round trips.
    pub dcr_session: dcr::DcrSession,
    /// Mirror of settings::KEY_RUN_IN_BACKGROUND, cached so the
    /// close-requested handler can read it synchronously. When true,
    /// closing the window hides to the tray instead of exiting.
    pub run_in_background: AtomicBool,
    /// Signalled once by the frontend after its first mount fetches have
    /// been issued (`frontend_ready` command). The startup backfill waits
    /// on this (with a timeout fallback) so it never competes with the
    /// first paint for the connection pool (DCH-60). `Notify` stores the
    /// permit, so a signal that arrives before the wait still releases it.
    pub frontend_ready: tokio::sync::Notify,
}

/// Build-time version metadata (DCH-67), derived in `build.rs`: CalVer
/// `YY.M.D` of the build date, and the short commit (`-dirty` when built
/// from an unclean tree). Nothing here is hand-edited.
pub const APP_VERSION: &str = env!("DCH_BUILD_VERSION");
pub const BUILD_COMMIT: &str = env!("DCH_BUILD_COMMIT");

/// The main window's title: name, version, and the commit that built it —
/// the commit is what tells two same-day CI builds apart.
fn window_title(version: &str, commit: &str) -> String {
    format!("Diecast Hunter {version} ({commit})")
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Viewer windows (DCH-64) just close — hide-to-tray belongs
                // to the main window alone, and a hidden viewer would have
                // no way back from the tray.
                if window.label() != "main" {
                    return;
                }
                let state = window.app_handle().state::<AppState>();
                if state
                    .run_in_background
                    .load(std::sync::atomic::Ordering::Relaxed)
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // Closing the main window takes any viewers with it — in
                // tray mode so "the app is in the tray" stays unambiguous,
                // and on a real exit so an orphaned viewer can't keep the
                // process alive with no main window to come back to.
                for (label, w) in window.app_handle().webview_windows() {
                    if label.starts_with("viewer-") {
                        let _ = w.close();
                    }
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let pool = tauri::async_runtime::block_on(async move {
                let data_dir = db::default_data_dir()?;
                let database = db::Db::open(&data_dir).await?;
                let pool = database.pool.clone();
                let run_in_background =
                    settings::get(&pool, settings::KEY_RUN_IN_BACKGROUND).await?.as_deref()
                        == Some("true");
                handle.manage(AppState {
                    db: database,
                    active_op_cancel: Mutex::new(None),
                    dcr_session: dcr::DcrSession::new(),
                    run_in_background: AtomicBool::new(run_in_background),
                    frontend_ready: tokio::sync::Notify::new(),
                });
                Ok::<_, error::AppError>(pool)
            })?;

            // Let the webview read collection photos out of the app data dir.
            //
            // Granted at runtime rather than through `assetProtocol.scope` in
            // tauri.conf.json because the directory isn't one of Tauri's own:
            // the database lives wherever `directories::ProjectDirs` puts it
            // (`%APPDATA%\DiecastHunter\DiecastHunter\data`), which is not
            // Tauri's `$APPDATA` (`%APPDATA%\com.diecasthunter.app`). A static
            // scope could only reach it by walking back out with `..`.
            //
            // Non-recursive: `images/` holds nothing but photos, and there is
            // no reason for the webview to be able to read a subdirectory
            // someone drops in there later.
            match collection_photo::images_dir() {
                Ok(dir) => {
                    if let Err(e) = std::fs::create_dir_all(&dir)
                        .map_err(error::AppError::from)
                        .and_then(|()| {
                            app.asset_protocol_scope()
                                .allow_directory(&dir, false)
                                .map_err(|e| error::AppError::Config(e.to_string()))
                        })
                    {
                        tracing::error!("collection photos will not render: {e}");
                    }
                }
                Err(e) => tracing::error!("could not resolve the collection photo directory: {e}"),
            }

            // Which build is this? In the title bar so it's readable at a
            // glance and lands in every screenshot a bug report includes.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_title(&window_title(APP_VERSION, BUILD_COMMIT));
            }

            // Embedded listing receiver for the browser extension. Failures
            // are non-fatal — the rest of the app works without it.
            let receiver_pool = pool.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = listing_receiver::run(receiver_pool).await {
                    tracing::error!("listing receiver: {e}");
                }
            });

            // System tray, so background mode has a way back to the window
            // (and an explicit Quit that bypasses hide-on-close).
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::TrayIconBuilder;
                let show =
                    MenuItem::with_id(app, "show", "Open Diecast Hunter", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &quit])?;
                let mut tray = TrayIconBuilder::with_id("main")
                    .menu(&menu)
                    .tooltip("Diecast Hunter")
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_window(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                            show_main_window(tray.app_handle());
                        }
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;
            }

            // One-shot driver auto-association backfill: any listing whose
            // driver_id is still NULL (legacy rows from before this feature,
            // or rows imported while the drivers table was sparse) gets a
            // fresh attempt on every launch. Non-forcing — won't overwrite
            // existing values. Runs detached so a slow scan never blocks the
            // UI from showing up — and deferred (DCH-60) until the frontend
            // reports its first mount fetches issued, so the backfill queues
            // behind the first paint's queries on the connection pool
            // instead of racing them. The timeout is the safety net for a
            // frontend that never signals (crashed webview, stale build).
            let backfill_pool = pool.clone();
            let events_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                {
                    let state = events_handle.state::<AppState>();
                    let ready = state.frontend_ready.notified();
                    tokio::select! {
                        _ = ready => {}
                        _ = tokio::time::sleep(std::time::Duration::from_secs(15)) => {
                            tracing::debug!("backfill: no frontend-ready signal after 15s, proceeding");
                        }
                    }
                }
                let progress = progress::ProgressEmitter::null("driver_assoc_backfill");
                match sync::driver_assoc::associate_all_listings(
                    &backfill_pool,
                    &progress,
                    false,
                )
                .await
                {
                    Ok(summary) if summary.considered > 0 => {
                        tracing::info!(
                            "driver auto-assoc backfill: {} matched, {} cleared, {} unmatched (of {})",
                            summary.associated,
                            summary.cleared,
                            summary.unmatched,
                            summary.considered
                        );
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("driver auto-assoc backfill failed: {e}"),
                }

                // Attribute auto-fill backfill, same spirit: fill-only, so
                // re-running on every launch is harmless and picks up rows
                // saved before the vocabulary (form-options cache) existed.
                match sync::attribute_assoc::associate_all_listing_attributes(&backfill_pool).await
                {
                    Ok(summary) if summary.detected > 0 => {
                        tracing::info!(
                            "attribute auto-fill backfill: detected on {} of {} listings",
                            summary.detected,
                            summary.considered
                        );
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("attribute auto-fill backfill failed: {e}"),
                }

                // Copy authoritative attributes from confirmed matches
                // onto their listings (provenance-marked; pinned rows
                // skipped). Re-running refreshes values from re-enriched
                // entries.
                match sync::attribute_assoc::backfill_all_attrs_from_matches(&backfill_pool).await
                {
                    Ok(n) if n > 0 => {
                        tracing::info!("attr-from-match backfill: {n} listings updated");
                    }
                    Ok(_) => {}
                    Err(e) => tracing::warn!("attr-from-match backfill failed: {e}"),
                }

                // Auto-retrain the match scorer when enough new verdicts
                // have accumulated since the last training run. Cheap
                // no-op otherwise.
                matcher_training::maybe_retrain(&backfill_pool, Some(&events_handle)).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::get_credentials,
            commands::save_diecastregistry_credentials,
            commands::clear_diecastregistry_credentials,
            commands::get_setting,
            commands::set_setting,
            commands::get_auto_sync_settings,
            commands::set_auto_sync_settings,
            commands::sync_dcr_collection,
            commands::register_diecast_in_garage,
            commands::remove_collection_entry,
            commands::refresh_registry_details,
            commands::list_drivers_with_counts,
            commands::list_collection_for_driver,
            commands::list_all_collection_items,
            commands::create_local_collection_entry,
            commands::update_local_collection_entry,
            commands::set_collection_notes,
            commands::set_collection_photo,
            commands::clear_collection_photo,
            commands::allow_photo_preview,
            commands::get_ebay_credentials,
            commands::save_ebay_credentials,
            commands::clear_ebay_credentials,
            commands::test_ebay_connection,
            commands::save_ebay_ru_name,
            commands::get_ebay_ru_name,
            commands::get_ebay_oauth_status,
            commands::start_ebay_oauth,
            commands::complete_ebay_oauth,
            commands::disconnect_ebay_oauth,
            commands::add_ebay_listing,
            commands::search_ebay_listings,
            commands::watch_ebay_listing,
            commands::unwatch_ebay_listing,
            commands::feed_item_detail,
            commands::list_ebay_offers,
            commands::refresh_ebay_listing,
            commands::refresh_all_ebay_listings,
            commands::sync_ebay_watchlist,
            commands::frontend_ready,
            commands::open_viewer_window,
            commands::open_photo_window,
            commands::list_listings,
            commands::list_watched_external_ids,
            commands::get_listing_row,
            commands::clear_listing_match,
            commands::reject_listing_match,
            commands::confirm_listing_match,
            commands::auto_match_listing,
            commands::auto_match_all_listings,
            commands::retrain_matcher,
            commands::matcher_status,
            commands::reset_matcher_model,
            commands::get_listing_receiver_status,
            commands::get_listing_receiver_secret,
            commands::regenerate_listing_receiver_secret,
            commands::get_background_settings,
            commands::set_background_settings,
            commands::list_drivers,
            commands::set_listing_driver,
            commands::clear_listing_driver,
            commands::reset_listing_driver,
            commands::set_listing_attributes,
            commands::reset_listing_attributes,
            commands::refresh_registry_form_options,
            commands::list_registry_form_options,
            commands::search_dcr_production,
            commands::list_registry_presearches,
            commands::create_registry_presearch,
            commands::update_registry_presearch,
            commands::delete_registry_presearch,
            commands::refresh_registry_presearch,
            commands::get_registry_search_mode,
            commands::set_registry_search_mode,
            commands::export_registry_search_html,
            commands::export_wishlist_html,
            commands::export_collection_html,
            commands::export_collection_csv,
            commands::link_listing_to_registry,
            commands::prewarm_registry_by_driver,
            commands::backfill_registry_detail_urls,
            commands::list_prewarmed_drivers,
            commands::cancel_active_operation,
            commands::get_ebay_filter_non_diecasts,
            commands::set_ebay_filter_non_diecasts,
            commands::get_ebay_buyer_zip,
            commands::set_ebay_buyer_zip,
            commands::remove_non_diecast_listings,
            commands::list_saved_searches,
            commands::create_saved_search,
            commands::update_saved_search,
            commands::delete_saved_search,
            commands::run_saved_search,
            commands::list_saved_sellers,
            commands::list_hidden_feed_listings,
            commands::hide_feed_listing,
            commands::unhide_feed_listing,
            commands::add_saved_seller,
            commands::update_saved_seller,
            commands::remove_saved_seller,
            commands::saved_sellers_feed,
            commands::sync_ebay_saved,
            commands::sync_ebay_all,
            commands::list_listing_groups,
            commands::create_listing_group,
            commands::update_listing_group,
            commands::delete_listing_group,
            commands::add_listing_to_group,
            commands::remove_listing_from_group,
            commands::add_listings_to_group,
            commands::remove_listings_from_group,
            commands::ensure_driver,
            commands::propose_group_migration,
            commands::apply_group_migration,
            commands::list_wishlists,
            commands::create_wishlist,
            commands::rename_wishlist,
            commands::delete_wishlist,
            commands::add_wishlist_entry,
            commands::list_wishlist,
            commands::list_wishlisted_guids,
            commands::reorder_wishlist,
            commands::remove_wishlist_entry,
            commands::move_wishlist_entry,
            commands::set_wishlist_notes,
            commands::link_listing_to_wishlist,
            commands::unlink_listing_from_wishlist,
            commands::add_listings_to_wishlist,
            commands::get_share_settings,
            commands::save_share_settings,
            commands::clear_share_settings,
            commands::wishlist_share_status,
            commands::share_wishlist,
            commands::revoke_wishlist_share,
            commands::share_listings,
            commands::list_shares,
            commands::revoke_share,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Headless one-shot sync used by the OS scheduled task
/// (`diecast-hunter.exe --sync`). Opens the DB, runs the collection + eBay
/// syncs once, and exits the process — without starting the GUI/webview.
/// Exit code: 0 = both phases succeeded, 1 = setup error or a phase failed
/// (so Task Scheduler's "Last Run Result" reflects trouble).
pub fn run_headless_sync() {
    init_tracing();

    let code = tauri::async_runtime::block_on(async {
        let data_dir = match db::default_data_dir() {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("headless sync: resolve data dir: {e}");
                return 1;
            }
        };
        let database = match db::Db::open(&data_dir).await {
            Ok(d) => d,
            Err(e) => {
                tracing::error!("headless sync: open db: {e}");
                return 1;
            }
        };
        if sync::auto_sync::run_once(&database.pool).await {
            0
        } else {
            1
        }
    });

    std::process::exit(code);
}

/// Initialize tracing with two sinks:
///   - stderr (existing behavior, useful when running `pnpm tauri dev`)
///   - a rolling log file in the app data dir
///
/// The file sink is gated on `RUST_LOG` like the stderr sink, but defaults
/// to `debug,sqlx=warn,hyper=info,reqwest=info` so DCR/eBay HTTP calls are
/// captured without firehose-level dependency noise.
fn init_tracing() {
    use tracing_subscriber::{
        fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer,
    };

    let stderr_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // html5ever/selectors emit a DEBUG event for every HTML character token
    // during scraping — leaving them at default fills the log file with
    // multi-MB of parser noise per registry search. Pin them at WARN.
    let file_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("debug,sqlx=warn,hyper=info,reqwest=info,html5ever=warn,selectors=warn")
    });

    // Resolve the log directory; fall back to stderr-only if we can't.
    let log_dir = db::default_data_dir().ok().map(|d| d.join("logs"));

    let file_layer = log_dir.as_ref().and_then(|dir| {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("could not create log dir {dir:?}: {e}");
            return None;
        }
        let appender = tracing_appender::rolling::daily(dir, "diecast-hunter.log");
        Some(
            fmt::layer()
                .with_ansi(false)
                .with_writer(appender)
                .with_filter(file_filter),
        )
    });

    let stderr_layer = fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(stderr_filter);

    let registry = tracing_subscriber::registry().with(stderr_layer);
    if let Some(file_layer) = file_layer {
        registry.with(file_layer).init();
        if let Some(dir) = log_dir {
            eprintln!("diecast-hunter: log file → {}", dir.display());
        }
    } else {
        registry.init();
    }
}

#[cfg(test)]
mod version_tests {
    use super::*;

    /// The build script's contract: CalVer `YY.M.D`, all numeric, year
    /// two-digit — the MSI ProductVersion major field caps at 255, so a
    /// four-digit year would break the installer bundle.
    #[test]
    fn build_version_is_two_digit_calver() {
        let parts: Vec<u32> = APP_VERSION
            .split('.')
            .map(|p| p.parse().expect("numeric version part"))
            .collect();
        assert_eq!(parts.len(), 3, "expected YY.M.D, got {APP_VERSION}");
        assert!(parts[0] <= 99, "year must be two-digit: {APP_VERSION}");
        assert!((1..=12).contains(&parts[1]), "bad month: {APP_VERSION}");
        assert!((1..=31).contains(&parts[2]), "bad day: {APP_VERSION}");
    }

    #[test]
    fn build_commit_is_short_hash_or_unknown() {
        let hash = BUILD_COMMIT.strip_suffix("-dirty").unwrap_or(BUILD_COMMIT);
        assert!(
            hash == "unknown" || (hash.len() >= 7 && hash.chars().all(|c| c.is_ascii_hexdigit())),
            "unexpected commit form: {BUILD_COMMIT}"
        );
    }

    #[test]
    fn title_carries_name_version_and_commit() {
        assert_eq!(
            window_title("26.8.17", "abc1234"),
            "Diecast Hunter 26.8.17 (abc1234)"
        );
    }
}
