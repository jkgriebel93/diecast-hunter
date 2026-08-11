/**
 * Public share links for an ad-hoc selection (DCH-48).
 *
 * A wishlist share names itself — the list has a name. A selection of five
 * listings picked on a Tuesday does not, so the dialog has to propose one,
 * and the Settings list has to be able to say whether a link is still worth
 * holding on to. Both of those are string decisions with edge cases, so they
 * live here rather than inside a component.
 */

/** How long a link may live. The Worker clamps to 90 days regardless (see
 *  `worker/src/share.ts`), so anything longer here would be a promise the
 *  Worker doesn't keep. */
export interface TtlOption {
  days: number;
  label: string;
}

export const TTL_OPTIONS: readonly TtlOption[] = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

export const DEFAULT_TTL_DAYS = 30;

/**
 * What to call a share before the user renames it.
 *
 * The count plus the date, because those are the two things that tell one
 * row in the Settings list from another months later — "5 listings" alone
 * stops being an identifier the second time you share five listings.
 */
export function defaultShareLabel(count: number, now: Date): string {
  const noun = count === 1 ? "listing" : "listings";
  const date = now.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${count} ${noun} — ${date}`;
}

/**
 * How a share's expiry reads in the Settings list.
 *
 * An expired share is still listed: the Worker's TTL has already killed the
 * link, and showing the row is how the user finds out — rather than hearing
 * it from whoever they sent it to. So this has to distinguish "gone" from
 * "going", and never render a past date as though the link still worked.
 *
 * `null` expiry means the Worker didn't report one. That is not "never
 * expires" — it is "we don't know", and saying so is the honest option.
 */
export function describeExpiry(
  expiresAt: number | null,
  nowSeconds: number,
): { text: string; expired: boolean } {
  if (expiresAt === null) return { text: "expiry unknown", expired: false };
  const secondsLeft = expiresAt - nowSeconds;
  if (secondsLeft <= 0) return { text: "expired", expired: true };
  const days = Math.floor(secondsLeft / 86_400);
  if (days >= 1) {
    return {
      text: `expires in ${days} day${days === 1 ? "" : "s"}`,
      expired: false,
    };
  }
  const hours = Math.floor(secondsLeft / 3_600);
  if (hours >= 1) {
    return {
      text: `expires in ${hours} hour${hours === 1 ? "" : "s"}`,
      expired: false,
    };
  }
  // Under an hour. Not "in 0 hours", and not a minute count either — the
  // page is cached at the edge for five minutes, so minute precision here
  // would be more exact than the thing it describes.
  return { text: "expires within the hour", expired: false };
}
