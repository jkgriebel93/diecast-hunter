import type { WishlistEntry } from "@/lib/tauri";
import { formatCents, formatCount } from "@/lib/format";

/**
 * A wishlist as plain text, for pasting into a message (DCH-46).
 *
 * This is the fallback that needs no Worker, no account and no link: the
 * user copies the *content* instead of a pointer to it. That makes it the
 * only sharing path that always works, so it can't quietly degrade — it has
 * to read like something a person typed.
 *
 * It carries the same privacy default as a public link. Notes are free-form
 * and the candidate lines are what you're watching and expect to pay;
 * neither is inferable from the wish itself, which is the test for whether
 * omitting it protects anything.
 */
export interface WishlistTextOptions {
  includeNotes?: boolean;
  includeCandidates?: boolean;
  /** Appended under the list, when there's a live share to point at. */
  shareUrl?: string | null;
}

/** One wish, as a person would say it: driver, year, scheme, scale. */
export function wishLine(entry: WishlistEntry): string {
  const head = [entry.year, entry.driver_name ?? "(unknown driver)"]
    .filter((p) => p !== null && p !== undefined && p !== "")
    .join(" ");
  const tail = [entry.scheme_text, entry.scale, entry.brand]
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .join(" · ");
  return tail ? `${head} — ${tail}` : head;
}

/** The cheapest candidate on a wish, which is the number worth quoting. */
function bestCandidate(entry: WishlistEntry): string | null {
  const priced = entry.listings
    .map((l) => ({
      total:
        l.price_cents === null ? null : l.price_cents + (l.shipping_cents ?? 0),
      l,
    }))
    .filter(
      (c): c is { total: number; l: (typeof entry.listings)[number] } =>
        c.total !== null,
    )
    .sort((a, b) => a.total - b.total);
  if (priced.length === 0) return null;
  const [cheapest] = priced;
  const more =
    priced.length > 1 ? ` (+${formatCount(priced.length - 1)} more)` : "";
  return `${formatCents(cheapest.total)} delivered${more}`;
}

export function wishlistToText(
  listName: string,
  entries: readonly WishlistEntry[],
  options: WishlistTextOptions = {},
): string {
  const { includeNotes = false, includeCandidates = false, shareUrl } = options;

  const lines: string[] = [listName];
  if (entries.length === 0) {
    // Still name the list. Pasting a bare heading is a fine way to say
    // "nothing on it yet"; pasting an empty string looks like a bug.
    lines.push("", "(nothing on this list yet)");
    return lines.join("\n");
  }

  lines.push("");
  for (const entry of entries) {
    lines.push(`• ${wishLine(entry)}`);
    if (includeNotes && entry.notes && entry.notes.trim() !== "") {
      // Indented under its wish so a multi-entry paste stays readable in a
      // chat client that does nothing but preserve newlines.
      for (const note of entry.notes.trim().split("\n")) {
        lines.push(`    ${note.trim()}`);
      }
    }
    if (includeCandidates) {
      const candidate = bestCandidate(entry);
      if (candidate) lines.push(`    ${candidate}`);
    }
  }

  lines.push("");
  lines.push(
    `${formatCount(entries.length)} ${entries.length === 1 ? "car" : "cars"} · Diecast Hunter`,
  );
  if (shareUrl) lines.push(shareUrl);
  return lines.join("\n");
}
