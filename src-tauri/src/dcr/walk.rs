//! Bounded, ordered, cancel-clean page fetching for DCR walks (DCH-61).
//!
//! A multi-page walk knows every remaining page number after page 1, so
//! fetching them strictly one-at-a-time left the client's rate gate as the
//! only thing determining wall time. This helper keeps a small fixed number
//! of fetches in flight (the client's own gate still spaces their *starts*),
//! while delivering results **in page order** — registry order is the "no
//! axis" sort the UI preserves, so out-of-order assembly would reorder
//! results.
//!
//! Error semantics are the DCH-61 acceptance criterion: the first failed
//! page (or a callback error, e.g. a login-redirect detection) stops the
//! walk — nothing new is issued, the still-in-flight futures are dropped
//! (reqwest cancels them), and exactly that one error surfaces.

use std::future::Future;

use futures_util::stream::{FuturesOrdered, StreamExt};

use crate::error::AppResult;

/// Fetch `pages` with at most `concurrency` in flight, invoking `on_page`
/// with each page's payload strictly in page order. `on_page` returning an
/// error aborts the walk the same way a fetch error does.
pub(crate) async fn walk_pages_buffered<T, F, Fut>(
    pages: impl IntoIterator<Item = u32>,
    concurrency: usize,
    fetch: F,
    mut on_page: impl FnMut(u32, T) -> AppResult<()>,
) -> AppResult<()>
where
    F: Fn(u32) -> Fut,
    Fut: Future<Output = AppResult<T>>,
{
    let mut pages = pages.into_iter();
    let mut in_flight = FuturesOrdered::new();
    let push = |in_flight: &mut FuturesOrdered<_>, page: u32, fut: Fut| {
        in_flight.push_back(async move { (page, fut.await) });
    };

    for _ in 0..concurrency.max(1) {
        match pages.next() {
            Some(p) => push(&mut in_flight, p, fetch(p)),
            None => break,
        }
    }

    while let Some((page, result)) = in_flight.next().await {
        // `?` drops `in_flight` on the way out, cancelling anything still
        // running before the error surfaces.
        on_page(page, result?)?;
        if let Some(p) = pages.next() {
            push(&mut in_flight, p, fetch(p));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// Results arrive strictly in page order even when earlier pages finish
    /// slower than later ones.
    #[tokio::test]
    async fn delivers_pages_in_order_despite_uneven_latency() {
        let seen = Mutex::new(Vec::new());
        walk_pages_buffered(
            2..=6,
            3,
            |page| async move {
                // Earlier pages sleep longer, so completion order inverts.
                tokio::time::sleep(std::time::Duration::from_millis((7 - page as u64) * 10)).await;
                Ok(format!("page-{page}"))
            },
            |page, body: String| {
                assert_eq!(body, format!("page-{page}"));
                seen.lock().unwrap().push(page);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![2, 3, 4, 5, 6]);
    }

    /// The in-flight window is a hard bound, not a hint.
    #[tokio::test]
    async fn never_exceeds_the_concurrency_cap() {
        let current = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        walk_pages_buffered(
            1..=20,
            3,
            |_page| async {
                let now = current.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                current.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            },
            |_, ()| Ok(()),
        )
        .await
        .unwrap();
        assert!(peak.load(Ordering::SeqCst) <= 3);
    }

    /// A failed page surfaces as the walk's one error, and nothing beyond
    /// the already-in-flight window is ever issued.
    #[tokio::test]
    async fn error_aborts_cleanly_without_issuing_more_pages() {
        let started = Mutex::new(Vec::new());
        let delivered = Mutex::new(Vec::new());
        let result = walk_pages_buffered(
            1..=20,
            3,
            |page| {
                started.lock().unwrap().push(page);
                async move {
                    if page == 4 {
                        Err(AppError::SessionExpired)
                    } else {
                        Ok(page)
                    }
                }
            },
            |page, _| {
                delivered.lock().unwrap().push(page);
                Ok(())
            },
        )
        .await;

        assert!(matches!(result, Err(AppError::SessionExpired)));
        // Pages 1-3 delivered in order; the failure at 4 stops delivery.
        assert_eq!(*delivered.lock().unwrap(), vec![1, 2, 3]);
        // At most the failing page plus one full window was ever started.
        let max_started = *started.lock().unwrap().iter().max().unwrap();
        assert!(max_started <= 4 + 3, "issued too far ahead: {max_started}");
    }

    /// The callback can abort too — that's how the login-redirect detection
    /// inside a walk stops the remaining fetches.
    #[tokio::test]
    async fn callback_error_aborts_the_walk() {
        let delivered = Mutex::new(Vec::new());
        let result = walk_pages_buffered(
            1..=10,
            2,
            |page| async move { Ok(page) },
            |page, _| {
                delivered.lock().unwrap().push(page);
                if page == 3 {
                    Err(AppError::Parse("bad page".into()))
                } else {
                    Ok(())
                }
            },
        )
        .await;
        assert!(matches!(result, Err(AppError::Parse(_))));
        assert_eq!(*delivered.lock().unwrap(), vec![1, 2, 3]);
    }
}
