import { describe, expect, it } from "vitest";
import { describeWishlistAdd } from "./wishlistNotice";
import type { WishlistBulkAddResult } from "./tauri";

const result = (over: Partial<WishlistBulkAddResult> = {}) => ({
  linked: 0,
  already_present: 0,
  entries_created: 0,
  skipped_no_match: 0,
  ...over,
});

describe("describeWishlistAdd", () => {
  it("reports a clean add as success", () => {
    const n = describeWishlistAdd(
      result({ linked: 3, entries_created: 3 }),
      "Hunts",
    );
    expect(n.tone).toBe("success");
    expect(n.message).toContain("Added 3 listings");
    expect(n.message).toContain('"Hunts"');
  });

  it("singularizes one listing", () => {
    const n = describeWishlistAdd(
      result({ linked: 1, entries_created: 1 }),
      "Hunts",
    );
    expect(n.message).toContain("Added 1 listing to");
    expect(n.message).not.toContain("1 listings");
  });

  it("turns warning the moment anything is skipped", () => {
    // Nothing failed — the rest went through — so this is a notice, not an
    // error. Colouring it red would tell the user to undo a good add.
    const n = describeWishlistAdd(
      result({ linked: 4, entries_created: 4, skipped_no_match: 2 }),
      "Hunts",
    );
    expect(n.tone).toBe("warning");
    expect(n.message).toContain("Added 4 listings");
    expect(n.message).toContain("2 skipped — no registry match");
  });

  it("counts new wishes separately from linked listings", () => {
    // Two listings for the same diecast land on one entry. Reporting only
    // "added 2" would leave the user expecting two rows on the Wishlist.
    const n = describeWishlistAdd(
      result({ linked: 2, entries_created: 1 }),
      "Hunts",
    );
    expect(n.message).toContain("1 new wish");
    expect(n.message).not.toContain("1 new wishes");
  });

  it("pluralizes several new wishes", () => {
    const n = describeWishlistAdd(
      result({ linked: 3, entries_created: 3 }),
      "Hunts",
    );
    expect(n.message).toContain("3 new wishes");
  });

  it("mentions listings that were already candidates", () => {
    const n = describeWishlistAdd(
      result({ linked: 1, entries_created: 0, already_present: 2 }),
      "Hunts",
    );
    expect(n.tone).toBe("success");
    expect(n.message).toContain("2 already there");
  });

  it("explains an add where every listing was already there", () => {
    // A no-op by design. "Added 0" would read as a failure.
    const n = describeWishlistAdd(result({ already_present: 3 }), "Hunts");
    expect(n.tone).toBe("success");
    expect(n.message).toContain("Already on");
    expect(n.message).not.toContain("Added 0");
  });

  it("explains an add where nothing could be wished for", () => {
    const n = describeWishlistAdd(result({ skipped_no_match: 5 }), "Hunts");
    expect(n.tone).toBe("warning");
    expect(n.message).toContain("Nothing to add");
    expect(n.message).toContain("5 listings have no registry match");
    expect(n.message).not.toContain("Added 0");
  });

  it("says what to do about a skipped listing", () => {
    // The skip is only actionable if the user knows the fix is a match.
    const n = describeWishlistAdd(result({ skipped_no_match: 1 }), "Hunts");
    expect(n.message).toContain("Match them first");
  });

  it("keeps the list name verbatim, including quotes-worthy names", () => {
    const n = describeWishlistAdd(result({ linked: 1 }), "Kyle's 2024 hunt");
    expect(n.message).toContain('"Kyle\'s 2024 hunt"');
  });

  it("formats counts through the shared helper", () => {
    // DCH-34: thousands separators everywhere, never a bare String(n).
    const n = describeWishlistAdd(result({ linked: 1234 }), "Hunts");
    expect(n.message).toContain("1,234");
  });
});
