mod commands;
mod db;
mod dcr;
mod ebay;
mod error;
mod listing_groups;
mod listing_receiver;
mod progress;
mod saved;
mod settings;
mod sync;

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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let pool = tauri::async_runtime::block_on(async move {
                let data_dir = db::default_data_dir()?;
                let database = db::Db::open(&data_dir).await?;
                let pool = database.pool.clone();
                handle.manage(AppState {
                    db: database,
                    active_op_cancel: Mutex::new(None),
                });
                Ok::<_, error::AppError>(pool)
            })?;

            // Spawn the embedded listing receiver. Failures here are
            // non-fatal — the rest of the app still works without the
            // browser-extension entry point.
            let receiver_pool = pool.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = listing_receiver::run(receiver_pool).await {
                    tracing::error!("listing receiver: {e}");
                }
            });

            // One-shot driver auto-association backfill: any listing whose
            // driver_id is still NULL (legacy rows from before this feature,
            // or rows imported while the drivers table was sparse) gets a
            // fresh attempt on every launch. Non-forcing — won't overwrite
            // existing values. Runs detached so a slow scan never blocks the
            // UI from showing up.
            let backfill_pool = pool.clone();
            tauri::async_runtime::spawn(async move {
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
            commands::sync_dcr_collection,
            commands::register_diecast_in_garage,
            commands::remove_collection_entry,
            commands::refresh_registry_details,
            commands::list_drivers_with_counts,
            commands::list_collection_for_driver,
            commands::list_all_collection_items,
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
            commands::list_ebay_offers,
            commands::refresh_ebay_listing,
            commands::refresh_all_ebay_listings,
            commands::sync_ebay_watchlist,
            commands::list_listings,
            commands::clear_listing_match,
            commands::reject_listing_match,
            commands::confirm_listing_match,
            commands::auto_match_listing,
            commands::auto_match_all_listings,
            commands::list_drivers,
            commands::set_listing_driver,
            commands::clear_listing_driver,
            commands::reset_listing_driver,
            commands::refresh_registry_form_options,
            commands::list_registry_form_options,
            commands::search_dcr_production,
            commands::link_listing_to_registry,
            commands::prewarm_registry_by_driver,
            commands::list_prewarmed_drivers,
            commands::cancel_active_operation,
            commands::get_ebay_filter_non_diecasts,
            commands::set_ebay_filter_non_diecasts,
            commands::get_ebay_buyer_zip,
            commands::set_ebay_buyer_zip,
            commands::remove_non_diecast_listings,
            commands::get_listing_receiver_status,
            commands::get_listing_receiver_secret,
            commands::regenerate_listing_receiver_secret,
            commands::list_saved_searches,
            commands::create_saved_search,
            commands::update_saved_search,
            commands::delete_saved_search,
            commands::run_saved_search,
            commands::list_saved_sellers,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
