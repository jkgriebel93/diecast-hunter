"""One-shot backfill of marketplace-deletion records from KV into D1.

Usage:
    CF_API_TOKEN=... D1_DATABASE_ID=... python3 backfill_kv_to_d1.py

The script walks every `deletion:*` key in the DELETIONS KV namespace,
parses the stored JSON, and inserts it into the `marketplace_deletions`
table in D1 with `ON CONFLICT(notification_id) DO NOTHING`, so it is
safe to re-run.
"""

import json
import os
import time
from urllib.parse import quote

import requests

ACCOUNT_ID = "5c21ee6b5f2b8669462d642bc95ec7da"
KV_NAMESPACE_ID = "05f981ddfc9c41dda3789faf7cb7a309"  # DELETIONS
D1_DATABASE_ID = os.environ["D1_DATABASE_ID"]
API_TOKEN = os.environ["CF_API_TOKEN"]

KV_BASE = (
    f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
    f"/storage/kv/namespaces/{KV_NAMESPACE_ID}"
)
D1_URL = (
    f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}"
    f"/d1/database/{D1_DATABASE_ID}/query"
)
HEADERS = {
    "Authorization": f"Bearer {API_TOKEN}",
    "Content-Type": "application/json",
}

INSERT_SQL = """
INSERT INTO marketplace_deletions
  (notification_id, received_at, user_id, username, eias_token, raw)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(notification_id) DO NOTHING
"""


def iter_keys(prefix: str):
    cursor = None
    while True:
        params: dict = {"limit": 1000, "prefix": prefix}
        if cursor:
            params["cursor"] = cursor
        r = requests.get(
            f"{KV_BASE}/keys", headers=HEADERS, params=params, timeout=30
        )
        r.raise_for_status()
        payload = r.json()
        yield from payload["result"]
        cursor = (payload.get("result_info") or {}).get("cursor")
        if not cursor:
            return


def get_value(name: str) -> str:
    r = requests.get(
        f"{KV_BASE}/values/{quote(name)}", headers=HEADERS, timeout=30
    )
    r.raise_for_status()
    return r.text


def d1_exec(sql: str, params: list) -> None:
    r = requests.post(
        D1_URL,
        headers=HEADERS,
        json={"sql": sql, "params": params},
        timeout=30,
    )
    r.raise_for_status()


def main() -> None:
    moved = skipped = 0
    for key in iter_keys("deletion:"):
        notification_id = key["name"][len("deletion:") :]
        try:
            record = json.loads(get_value(key["name"]))
        except Exception as exc:
            print(f"  skip {notification_id}: {exc}")
            skipped += 1
            continue

        notif = (record.get("raw") or {}).get("notification") or {}
        # eBay nests the deletion subject under `notification.data`. The
        # ticket spec reads them directly off `notification`, which would
        # silently land NULLs — match the worker's runtime path instead.
        data = notif.get("data") or {}
        d1_exec(
            INSERT_SQL,
            [
                notification_id,
                record.get("received_at") or int(time.time() * 1000),
                data.get("userId"),
                data.get("username"),
                data.get("eiasToken"),
                json.dumps(notif),
            ],
        )
        moved += 1
        if moved % 50 == 0:
            print(f"  copied {moved}...")

    print(f"Done. Copied={moved} skipped={skipped}")


if __name__ == "__main__":
    main()
