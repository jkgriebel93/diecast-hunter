//! Dev harness: run matcher training against a database copy.
//!
//! ```
//! DRYRUN_DB=path/to/copy.sqlite cargo run --example retrain_dryrun
//! ```
//!
//! Writes the learned model + aliases into THAT file, so point it at a
//! scratch copy, never the live database.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::str::FromStr;

#[tokio::main]
async fn main() {
    let db = std::env::var("DRYRUN_DB").expect("set DRYRUN_DB to a sqlite copy");
    let opts = SqliteConnectOptions::from_str(&format!("sqlite:{db}"))
        .unwrap()
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .expect("open db");

    // The copy may trail the working tree's schema.
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");

    // With DRYRUN_BACKFILL set, run the attribute pipeline first — the
    // wider-text auto-fill, then the copy-from-confirmed-match pass.
    if std::env::var("DRYRUN_BACKFILL").is_ok() {
        let s = diecast_hunter_lib::dev_attr_autofill(&pool)
            .await
            .expect("attr autofill");
        println!("auto-fill: detected on {} of {}", s.detected, s.considered);
        let n = diecast_hunter_lib::dev_attr_backfill(&pool)
            .await
            .expect("attr backfill");
        println!("backfill from matches: {n} listings");
    }

    let outcome = diecast_hunter_lib::dev_retrain(&pool)
        .await
        .expect("retrain");
    println!("{}", serde_json::to_string_pretty(&outcome).unwrap());

    let status = diecast_hunter_lib::dev_matcher_status(&pool)
        .await
        .expect("status");
    println!("{}", serde_json::to_string_pretty(&status).unwrap());
}
