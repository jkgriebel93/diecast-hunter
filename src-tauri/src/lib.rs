mod commands;
mod db;
mod dcr;
mod ebay;
mod error;
mod settings;
mod sync;

use tauri::Manager;

pub struct AppState {
    pub db: db::Db,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let data_dir = db::default_data_dir()?;
                let database = db::Db::open(&data_dir).await?;
                handle.manage(AppState { db: database });
                Ok::<_, error::AppError>(())
            })?;
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
            commands::refresh_registry_details,
            commands::list_drivers_with_counts,
            commands::list_collection_for_driver,
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
            commands::refresh_ebay_listing,
            commands::refresh_all_ebay_listings,
            commands::sync_ebay_watchlist,
            commands::list_listings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
