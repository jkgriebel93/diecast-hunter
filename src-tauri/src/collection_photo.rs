//! User-supplied photos for collection entries.
//!
//! A manually-added car (DCH-12) has no diecastregistry.com page and so no
//! image, and the dialog's "Image URL" field only helps when the car happens
//! to be pictured somewhere public. The usual case is a photo on the user's
//! own disk.
//!
//! # Why the file is copied rather than referenced
//!
//! Recording the path the user picked would make the collection depend on a
//! file the app doesn't own. Downloads folders get emptied, phone imports get
//! moved into dated folders, external drives get unplugged — and every one of
//! those turns into a broken image months later, long after the user could
//! connect the cause to the effect. Copying costs a few hundred kilobytes and
//! makes the entry self-contained.
//!
//! # Why the database stores a bare file name
//!
//! The copy lives in `images/` next to the SQLite database, so the row only
//! needs to say *which* file. An absolute path would break whenever the data
//! directory moves — a restored backup, a new Windows profile — while a name
//! is re-resolved against wherever the database actually is. It also means
//! nothing in the database is a path, so nothing in the database can point
//! outside the app's own directory.
//!
//! # Why each save gets a new file name
//!
//! Replacing a photo writes `collection-7-1760000000.jpg`, not
//! `collection-7.jpg`. The webview caches `asset://` responses by URL, so
//! reusing the name shows the *old* photo until the app restarts — the one
//! bug guaranteed to look like the save silently failed.

use std::path::{Path, PathBuf};

use chrono::Utc;
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

/// Subdirectory of the app data dir holding collection photos.
pub const IMAGES_DIR_NAME: &str = "images";

/// What a webview `<img>` can actually display. Deliberately not "whatever
/// the OS calls an image": a HEIC off an iPhone or a RAW off a camera copies
/// fine and then renders as a broken icon, which reads as data loss. Better
/// to refuse the pick and say why.
const ALLOWED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];

/// Generous, but bounded — a photo straight off a modern phone is 3-8 MB.
/// The limit exists so a mis-click on a video file fails immediately instead
/// of copying a gigabyte into the app data directory.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

/// `images/` beside the SQLite database.
pub fn images_dir() -> AppResult<PathBuf> {
    Ok(crate::db::default_data_dir()?.join(IMAGES_DIR_NAME))
}

/// Absolute path of a stored photo, or `None` if the stored name is empty or
/// isn't a plain file name.
///
/// The rejection is a guard, not a formality: the name is handed to the
/// frontend, turned into an `asset://` URL and read back off disk, so a value
/// like `../../settings.json` reaching here would be a file-disclosure bug.
/// Nothing in this module writes such a name — the check is here so that
/// stays true of a hand-edited or migrated database too.
pub fn resolve_path(dir: &Path, stored: &str) -> Option<PathBuf> {
    let name = Path::new(stored).file_name()?;
    if name != stored {
        return None;
    }
    Some(dir.join(name))
}

/// Lowercased extension, if it's one we can render.
fn checked_extension(source: &Path) -> AppResult<String> {
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| ALLOWED_EXTENSIONS.contains(&e.as_str()));
    ext.ok_or_else(|| {
        AppError::Parse(format!(
            "that file isn't an image the app can display — pick a {} file",
            ALLOWED_EXTENSIONS.join(", ")
        ))
    })
}

/// Name for the stored copy. Split out from the copy itself so the naming
/// scheme — and the fact that it never contains a path separator — is
/// testable without touching a filesystem.
fn stored_file_name(collection_id: i64, extension: &str, now: i64) -> String {
    format!("collection-{collection_id}-{now}.{extension}")
}

/// Current stored photo for an entry, erroring if the entry doesn't exist.
/// The existence check is what makes "photo set on a row that was deleted
/// mid-dialog" a clear error rather than a silent no-op.
async fn current_photo(pool: &SqlitePool, collection_id: i64) -> AppResult<Option<String>> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT image_path FROM my_collection WHERE id = ?")
            .bind(collection_id)
            .fetch_optional(pool)
            .await?;
    row.map(|(p,)| p)
        .ok_or_else(|| AppError::Parse(format!("collection entry {collection_id} not found")))
}

/// Delete a stored photo, ignoring a file that's already gone.
///
/// Best-effort on purpose. The database row is the record of what the user
/// asked for; an orphaned file in `images/` wastes disk, while failing the
/// whole save because a stale file couldn't be unlinked would lose the edit.
async fn remove_file(dir: &Path, stored: &str) {
    if let Some(path) = resolve_path(dir, stored) {
        if let Err(e) = tokio::fs::remove_file(&path).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("could not remove old collection photo {path:?}: {e}");
            }
        }
    }
}

/// Copy `source` into `dir` and point the entry at it. Returns the stored
/// file name.
pub async fn set_photo(
    pool: &SqlitePool,
    dir: &Path,
    collection_id: i64,
    source: &Path,
) -> AppResult<String> {
    set_photo_at(pool, dir, collection_id, source, Utc::now().timestamp()).await
}

/// The clock is a parameter so tests can assert that a replacement writes a
/// *different* file and unlinks the old one — with the wall clock's one-second
/// resolution, two saves in the same test would otherwise land on the same
/// name and hide exactly the bug the naming scheme exists to prevent.
async fn set_photo_at(
    pool: &SqlitePool,
    dir: &Path,
    collection_id: i64,
    source: &Path,
    now: i64,
) -> AppResult<String> {
    let previous = current_photo(pool, collection_id).await?;
    let extension = checked_extension(source)?;

    let meta = tokio::fs::metadata(source).await?;
    if !meta.is_file() {
        return Err(AppError::Parse("that isn't a file".into()));
    }
    if meta.len() > MAX_BYTES {
        return Err(AppError::Parse(format!(
            "that image is {:.0} MB — the limit is {} MB",
            meta.len() as f64 / 1_048_576.0,
            MAX_BYTES / 1_048_576
        )));
    }

    tokio::fs::create_dir_all(dir).await?;
    let name = stored_file_name(collection_id, &extension, now);
    tokio::fs::copy(source, dir.join(&name)).await?;

    // Written after the copy: a row pointing at a file that failed to copy
    // renders as a broken image, whereas a copied file no row points at is
    // invisible and gets cleaned up by the next replacement.
    sqlx::query("UPDATE my_collection SET image_path = ? WHERE id = ?")
        .bind(&name)
        .bind(collection_id)
        .execute(pool)
        .await?;

    if let Some(old) = previous {
        remove_file(dir, &old).await;
    }
    Ok(name)
}

/// Drop an entry's photo and delete the file behind it.
pub async fn clear_photo(pool: &SqlitePool, dir: &Path, collection_id: i64) -> AppResult<()> {
    let previous = current_photo(pool, collection_id).await?;
    sqlx::query("UPDATE my_collection SET image_path = NULL WHERE id = ?")
        .bind(collection_id)
        .execute(pool)
        .await?;
    if let Some(old) = previous {
        remove_file(dir, &old).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    async fn migrated_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("open in-memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    async fn collection_row(pool: &SqlitePool) -> i64 {
        sqlx::query(
            "INSERT INTO registry_entries (external_id, driver_id, fetched_at)
             VALUES (NULL, NULL, 1)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO my_collection (registry_entry_id, source, external_id, imported_at)
             VALUES (1, 'local', 'local-1', 1)",
        )
        .execute(pool)
        .await
        .unwrap()
        .last_insert_rowid()
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dch-photo-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_source(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[tokio::test]
    async fn set_copies_the_file_and_records_the_name() {
        let pool = migrated_pool().await;
        let id = collection_row(&pool).await;
        let dir = temp_dir("set-copies");
        let source = write_source(&dir, "original.JPG", b"jpeg-bytes");
        let images = dir.join("images");

        let name = set_photo(&pool, &images, id, &source).await.unwrap();

        // Extension is normalized; the user's file name isn't reused, so two
        // entries whose photos are both called "IMG_1234.jpg" can't collide.
        assert!(name.starts_with(&format!("collection-{id}-")), "{name}");
        assert!(name.ends_with(".jpg"), "{name}");
        assert_eq!(std::fs::read(images.join(&name)).unwrap(), b"jpeg-bytes");
        // The original is left where the user put it.
        assert!(source.exists());

        let (stored,): (Option<String>,) =
            sqlx::query_as("SELECT image_path FROM my_collection WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored.as_deref(), Some(name.as_str()));
    }

    #[tokio::test]
    async fn replacing_a_photo_deletes_the_old_file() {
        let pool = migrated_pool().await;
        let id = collection_row(&pool).await;
        let dir = temp_dir("replace");
        let images = dir.join("images");

        let first = set_photo_at(
            &pool,
            &images,
            id,
            &write_source(&dir, "a.png", b"one"),
            1_000,
        )
        .await
        .unwrap();
        let second = set_photo_at(
            &pool,
            &images,
            id,
            &write_source(&dir, "b.png", b"two"),
            2_000,
        )
        .await
        .unwrap();

        assert_ne!(first, second, "a replacement must not reuse the URL");
        assert!(!images.join(&first).exists(), "old file should be gone");
        assert_eq!(std::fs::read(images.join(&second)).unwrap(), b"two");
    }

    #[tokio::test]
    async fn clear_removes_the_row_value_and_the_file() {
        let pool = migrated_pool().await;
        let id = collection_row(&pool).await;
        let dir = temp_dir("clear");
        let images = dir.join("images");
        let name = set_photo(&pool, &images, id, &write_source(&dir, "a.png", b"one"))
            .await
            .unwrap();

        clear_photo(&pool, &images, id).await.unwrap();

        assert!(!images.join(&name).exists());
        let (stored,): (Option<String>,) =
            sqlx::query_as("SELECT image_path FROM my_collection WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, None);
    }

    #[tokio::test]
    async fn a_file_we_cannot_render_is_refused_before_anything_is_copied() {
        let pool = migrated_pool().await;
        let id = collection_row(&pool).await;
        let dir = temp_dir("bad-ext");
        let images = dir.join("images");
        let source = write_source(&dir, "clip.mov", b"not an image");

        let err = set_photo(&pool, &images, id, &source).await.unwrap_err();
        assert!(err.to_string().contains("isn't an image"), "{err}");
        assert!(!images.exists(), "nothing should have been written");
    }

    #[tokio::test]
    async fn a_missing_entry_is_an_error_not_a_silent_no_op() {
        let pool = migrated_pool().await;
        let dir = temp_dir("missing-row");
        let source = write_source(&dir, "a.png", b"one");
        let err = set_photo(&pool, &dir.join("images"), 999, &source)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"), "{err}");
    }

    #[test]
    fn resolve_path_refuses_anything_that_is_not_a_bare_file_name() {
        let dir = Path::new("/data/images");
        assert_eq!(
            resolve_path(dir, "collection-1-2.jpg"),
            Some(dir.join("collection-1-2.jpg"))
        );
        for bad in ["", "../secret.json", "sub/dir.jpg", "/etc/passwd", "."] {
            assert_eq!(resolve_path(dir, bad), None, "should reject {bad:?}");
        }
    }

    #[test]
    fn stored_names_never_contain_a_separator() {
        let name = stored_file_name(7, "jpg", 1_760_000_000);
        assert_eq!(name, "collection-7-1760000000.jpg");
        assert_eq!(Path::new(&name).file_name().unwrap(), name.as_str());
    }
}
