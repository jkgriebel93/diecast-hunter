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

        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;

        sqlx::migrate!("./migrations").run(&pool).await?;

        Ok(Self { pool, path })
    }
}

pub fn default_data_dir() -> AppResult<PathBuf> {
    let dirs = ProjectDirs::from("com", "DiecastHunter", "DiecastHunter")
        .ok_or_else(|| AppError::Config("could not resolve project directory".into()))?;
    Ok(dirs.data_dir().to_path_buf())
}
