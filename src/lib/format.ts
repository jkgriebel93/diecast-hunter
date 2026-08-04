/** Shared numeric display formatting. Kept free of Tauri imports so it can
 *  be unit-tested outside the app shell. */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const COUNT = new Intl.NumberFormat("en-US");

/** "$1,234.56" — money is stored as `*_cents` integers app-wide; this is
 *  the display layer for it. Em dash for missing values. */
export function formatCents(cents: number | null): string {
  if (cents === null || cents === undefined) return "—";
  return USD.format(cents / 100);
}

/** "12,500" — thousands-separated integer for counts and quantities. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return COUNT.format(n);
}
