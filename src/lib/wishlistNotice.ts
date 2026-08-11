import type { NoticeTone } from "@/components/NoticeBanner";
import type { WishlistBulkAddResult } from "@/lib/tauri";
import { formatCount } from "@/lib/format";

/**
 * The sentence and tone for a bulk add of saved listings to a wishlist
 * (DCH-45).
 *
 * This is authored prose about an action that *worked*, so it is a
 * `NoticeBanner`, never an `ErrorBanner` (DCH-36) — and the tone turns on
 * one question only: was anything left behind? A listing with no registry
 * match can't be represented as a wish, and that is the single fact the user
 * needs back, because it's the one they'd otherwise have to notice by
 * counting rows on the Wishlist page.
 *
 * Nothing here fails. `warning` means "went through, minus these"; it is not
 * a softer red.
 */
export interface WishlistNotice {
  tone: NoticeTone;
  message: string;
}

/** Pluralize by count without repeating the ternary at every call site. */
function listings(n: number): string {
  return `${formatCount(n)} listing${n === 1 ? "" : "s"}`;
}

export function describeWishlistAdd(
  result: WishlistBulkAddResult,
  wishlistName: string,
): WishlistNotice {
  const { linked, already_present, entries_created, skipped_no_match } = result;
  const skipped = skipped_no_match > 0;

  // Every selected listing lacked a match. Nothing was added, but nothing
  // failed either — saying "added 0" would read as a bug rather than as the
  // explanation it is.
  if (linked === 0 && already_present === 0 && skipped) {
    return {
      tone: "warning",
      message:
        `Nothing to add to "${wishlistName}" — ` +
        `${listings(skipped_no_match)} have no registry match. ` +
        `Match them first and they can be wished for.`,
    };
  }

  // The whole selection was already there. Re-adding is a no-op by design,
  // so this is success; it just has nothing to report as new.
  if (linked === 0 && already_present > 0 && !skipped) {
    return {
      tone: "success",
      message: `Already on "${wishlistName}" — ${listings(already_present)}, nothing to add.`,
    };
  }

  const parts: string[] = [`Added ${listings(linked)} to "${wishlistName}"`];
  // How many *wishes* appeared is a different fact from how many listings
  // attached: several listings for one diecast land on a single entry.
  if (entries_created > 0) {
    parts.push(
      `${formatCount(entries_created)} new ${entries_created === 1 ? "wish" : "wishes"}`,
    );
  }
  if (already_present > 0) {
    parts.push(`${formatCount(already_present)} already there`);
  }
  if (skipped) {
    parts.push(`${formatCount(skipped_no_match)} skipped — no registry match`);
  }

  const [head, ...rest] = parts;
  return {
    tone: skipped ? "warning" : "success",
    message: rest.length > 0 ? `${head} (${rest.join(", ")}).` : `${head}.`,
  };
}
