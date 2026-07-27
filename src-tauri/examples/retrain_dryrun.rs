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

    let outcome = diecast_hunter_lib::dev_retrain(&pool)
        .await
        .expect("retrain");
    println!("{}", serde_json::to_string_pretty(&outcome).unwrap());

    let status = diecast_hunter_lib::dev_matcher_status(&pool)
        .await
        .expect("status");
    println!("{}", serde_json::to_string_pretty(&status).unwrap());
}
