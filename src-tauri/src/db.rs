use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

pub struct Db {
    pub pool: SqlitePool,
    pub path: PathBuf,
}

impl Db {
    pub async fn open(data_dir: &Path) -> AppResult<Self> {
        tokio::fs::create_dir_all(data_dir).await?;
        let path = data_dir.join("diecast-hunter.sqlite");

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(connect_options(&path))
            .await?;

        sqlx::migrate!("./migrations").run(&pool).await?;

        Ok(Self { pool, path })
    }
}

/// Split out of [`Db::open`] so the pragmas are testable without the data
/// dir / migration ceremony.
///
/// `synchronous = NORMAL` (DCH-55): under WAL, NORMAL only skips the fsync
/// on each commit, not on checkpoints, so a power cut can lose the most
/// recent transactions but can't corrupt the database. SQLite's docs
/// recommend it for WAL; the default FULL turns every autocommit statement
/// into an fsync, which is what made row-by-row sync writes cost 1.5-6 s
/// per thousand rows.
fn connect_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
}

pub fn default_data_dir() -> AppResult<PathBuf> {
    let dirs = ProjectDirs::from("com", "DiecastHunter", "DiecastHunter")
        .ok_or_else(|| AppError::Config("could not resolve project directory".into()))?;
    Ok(dirs.data_dir().to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DCH-55's acceptance criterion verbatim: the connection options set
    /// synchronous=NORMAL under WAL, verified by `PRAGMA synchronous`
    /// returning 1 at runtime. A file-backed database is required — WAL
    /// silently degrades on `:memory:`.
    #[tokio::test]
    async fn synchronous_is_normal_under_wal() {
        let path = std::env::temp_dir().join(format!(
            "dch-db-test-{}-{:?}.sqlite",
            std::process::id(),
            std::thread::current().id()
        ));
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(connect_options(&path))
            .await
            .expect("open temp db");

        let (journal_mode,): (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(journal_mode.to_lowercase(), "wal");

        let (synchronous,): (i64,) = sqlx::query_as("PRAGMA synchronous")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(synchronous, 1, "1 = NORMAL");

        pool.close().await;
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
        }
    }
}
