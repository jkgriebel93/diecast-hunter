// The minimized-panel contract (DCH-70), shared between the content script
// and the test suite. Content scripts are classic scripts — `export` would
// throw at parse time — so this attaches one namespace to `globalThis`,
// which is also how the vitest side reads it after importing the file for
// its side effect.
//
// The panel starts minimized BY DEFAULT: the extension's job on most page
// views is a glanceable verdict, and the full valuation display is the
// on-demand state — the same scan-first call DCH-20 made for listing cards.
// The user's last choice wins once one exists; it lives in extension
// storage (not page localStorage) so it holds across item pages, sites,
// and browser restarts.
globalThis.dhPanelState = {
  /** `browser.storage.local` key holding the last explicit choice. */
  MINIMIZED_KEY: "panelMinimized",

  /** Fold a stored value into the boolean the UI needs: absent (a fresh
   *  install, or pre-0.3.0 storage) means minimized. */
  initialMinimized(stored) {
    return stored === undefined || stored === null ? true : Boolean(stored);
  },

  /**
   * The pill's one-line summary of a successful /match/preview response:
   * match quality first, then the sharpest price signal we have — sold
   * comps when the archive has them, retail otherwise. Returns "" for
   * anything that isn't a usable preview (still loading, app offline,
   * skipped), leaving the pill as just the name.
   */
  pillSummary(p) {
    if (!p || !p.entry) return "";
    const conf =
      p.confidence === null || p.confidence === undefined
        ? "—"
        : `${Math.round(p.confidence)}%`;
    const parts = [p.matched ? `match ${conf}` : `guess ${conf}`];
    if (p.comp_score !== null && p.comp_score !== undefined) {
      parts.push(`${Math.round(p.comp_score)}% of sold`);
    } else if (p.deal_score !== null && p.deal_score !== undefined) {
      parts.push(`${Math.round(p.deal_score)}% of retail`);
    }
    return parts.join(" · ");
  },
};
