/**
 * Dev-only screenshot harness, served at `/screenshot.html` by `pnpm dev`
 * and reached by no other module — `vite build` bundles `index.html` alone,
 * so none of this ships. See `docs/screenshots/README.md`.
 *
 * A page can't be photographed in a plain browser as-is: every screen calls
 * `invoke()` and a browser has no Tauri to answer. So this stubs
 * `__TAURI_INTERNALS__` with a fixed fixture and mounts the page inside a box
 * shaped like `EditorPane`'s scrollport — the scroll parent is the whole
 * point when the bug being photographed is a `sticky` panel outgrowing it.
 *
 * `?preset=` selects the state, so a capture is a URL rather than a sequence
 * of clicks someone has to reproduce. Presets here are DCH-43's: the filter
 * sidebar at rest, with every facet expanded, and collapsed over live
 * selections.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "./lib/theme";
import { FontScaleProvider } from "./lib/fontScale";
import { Listings } from "./pages/Listings";
import { resetMinimized, setManyMinimized } from "./lib/minimized";
import { facetSectionKey } from "./lib/facetSections";
import type { DriverOption, ListingGroup, ListingRow } from "./lib/tauri";
import "./index.css";

const DRIVERS = [
  "Kyle Larson",
  "Chase Elliott",
  "Denny Hamlin",
  "Ryan Blaney",
  "William Byron",
];

/** Uneven on purpose so the seller facet's counts differ and its ordering
 *  (most listings first) is visible rather than incidental. Index 6 is
 *  `null` — the no-seller bucket only appears when a row actually has one. */
const SELLERS: (string | null)[] = [
  "diecast_depot",
  "diecast_depot",
  "raceday_collectibles",
  "diecast_depot",
  "victorylane_1_24",
  "raceday_collectibles",
  null,
];

const DAY = 86400;
/** Rounded down to the day: two captures on the same day are byte-identical,
 *  while the fixture still reads as live. A fixed epoch would buy full
 *  determinism and then quietly render every listing as long ended. */
const NOW = Math.floor(Date.now() / 1000 / DAY) * DAY;

/** Typed against the real row so a backend field rename breaks the harness
 *  loudly at `pnpm build` instead of silently producing a blank screenshot. */
function listing(i: number): ListingRow {
  const driver = DRIVERS[i % DRIVERS.length];
  const matched = i % 3 !== 0;
  const ended = i % 7 === 0;
  return {
    listing_id: i,
    seller_code: "ebay",
    external_id: `v1|1${200000000 + i}|0`,
    url: "https://www.ebay.com/itm/1",
    title: `${2020 + (i % 5)} ${driver} #${5 + i} Diecast 1/24 Elite`,
    price_cents: 4500 + i * 1150,
    shipping_cents: i % 4 === 0 ? null : 1295,
    currency: "USD",
    condition: "New",
    listing_type: i % 3 === 0 ? "auction" : "fixed",
    accepts_offers: i % 4 === 1,
    status: ended ? "ended" : "active",
    is_archived: false,
    end_reason: null,
    archived_at: null,
    end_time: NOW + DAY * (1 + (i % 6)),
    seller_username: SELLERS[i % SELLERS.length],
    seller_rating: 99.2,
    image_url: null,
    saved_at: NOW - DAY * i,
    last_seen_at: NOW - 3600 * i,
    registry_entry_id: matched ? 900 + i : null,
    match_confidence: matched ? 100 : null,
    match_user_confirmed: matched && i % 2 === 0,
    matched_by: matched ? "manual" : null,
    match_reasons: [],
    matched_driver_name: matched ? driver : null,
    matched_scheme_text: matched ? "Valvoline" : null,
    matched_year: matched ? 2020 + (i % 5) : null,
    matched_oem: matched ? "Chevrolet" : null,
    matched_brand: matched ? "Action" : null,
    matched_scale: matched ? "1/24" : null,
    matched_retail_cents: matched ? 9999 : null,
    matched_wholesale_cents: null,
    matched_detail_url: null,
    deal_score: matched ? 60 + i : null,
    comps: null,
    comp_score: null,
    auto_driver_id: (i % DRIVERS.length) + 1,
    auto_driver_name: driver,
    auto_driver_user_set: false,
    group_ids: i % 5 === 0 ? [1] : i % 5 === 1 ? [2] : [],
    oem: "Chevrolet",
    brand: "Action",
    finish: "Elite",
    make: "CWC",
    is_race_win: i % 6 === 0,
    is_autographed: i % 8 === 0,
    production_count: null,
    attrs_from_match: false,
    attributes_user_set: false,
  };
}

const LISTINGS: ListingRow[] = Array.from({ length: 24 }, (_, i) =>
  listing(i + 1),
);

const GROUPS: ListingGroup[] = [
  {
    id: 1,
    name: "Watch closely",
    description: null,
    target_price_cents: null,
    archived: false,
    created_at: 1,
    member_count: 5,
    drivers: [{ id: 1, name: "Kyle Larson" }],
  },
  {
    id: 2,
    name: "Purchased",
    description: null,
    target_price_cents: null,
    archived: false,
    created_at: 1,
    member_count: 5,
    drivers: [],
  },
];

const RESULTS: Record<string, unknown> = {
  list_listings: LISTINGS,
  list_listing_groups: GROUPS,
  list_ebay_offers: [],
  list_drivers: DRIVERS.map<DriverOption>((name, i) => ({
    id: i + 1,
    name,
    normalized_name: name.toLowerCase(),
    listing_count: 5,
  })),
};

// The `any` is deliberate: this is the object Tauri injects at runtime, and
// typing it would mean exporting a bridge type the app itself never needs.
(window as any).__TAURI_INTERNALS__ = {
  invoke: (cmd: string) =>
    cmd in RESULTS
      ? Promise.resolve(RESULTS[cmd])
      : Promise.reject(new Error(`unstubbed command: ${cmd}`)),
  transformCallback: () => 0,
  unregisterCallback: () => {},
  convertFileSrc: (p: string) => p,
};

// Preset state driven by the query string so each capture is deterministic.
const params = new URLSearchParams(location.search);
const preset = params.get("preset") ?? "default";
localStorage.clear();
// The minimized store snapshots localStorage at import time, so seed it
// through its own API rather than writing the key underneath it.
resetMinimized();
const ALL_FACETS = ["status", "match", "offer", "type"].map((k) =>
  facetSectionKey("listings", k),
);
// "badges" starts open too: the option rows have to exist to be clicked,
// and the effect below collapses them once the boxes are checked.
if (preset === "expanded" || preset === "badges") {
  setManyMinimized(ALL_FACETS, false);
}

/** Click a control by its visible text. The seller popover has no stable
 *  hook of its own, and adding a test id to the page for a screenshot would
 *  put the harness's needs into the app. */
function clickByText(selector: string, text: string) {
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    if (el.textContent?.trim().startsWith(text)) {
      el.click();
      return true;
    }
  }
  return false;
}

function clickOption(label: string) {
  for (const el of document.querySelectorAll<HTMLButtonElement>(
    'button[role="checkbox"]',
  )) {
    if (el.textContent?.startsWith(label)) {
      el.click();
      return;
    }
  }
}

function Harness() {
  React.useEffect(() => {
    if (preset === "badges") {
      const t = setTimeout(() => {
        clickOption("Ended");
        clickOption("Unconfirmed");
        clickOption("Unmatched");
        clickOption("Auction");
        setManyMinimized(ALL_FACETS, true);
      }, 400);
      return () => clearTimeout(t);
    }
    // The seller presets drive the real control rather than seeding state:
    // the filter lives in the page's own useState, and a screenshot of a
    // state the UI can't reach isn't evidence of anything.
    if (preset.startsWith("seller")) {
      const t = setTimeout(() => {
        clickByText("button", "All sellers");
        if (preset === "seller-open") return;
        setTimeout(() => {
          if (preset === "seller-empty") {
            clickByText("label", "victorylane_1_24");
          } else {
            clickByText("label", "diecast_depot");
            clickByText("label", "raceday_collectibles");
          }
          // Dismiss through the popover's own scrim, and only then touch
          // anything behind it — the scrim would swallow the click. The
          // trigger is no longer labelled "All sellers" once something is
          // checked, which is the point of the shot.
          setTimeout(() => {
            document
              .querySelector<HTMLElement>("div.fixed.inset-0.z-30")
              ?.click();
            // Crossing a seller with a status they have none of is the
            // DCH-35 "your filters excluded everything" state, reached
            // through the new facet.
            if (preset === "seller-empty") {
              setTimeout(() => {
                clickOption("Archived");
                // Status ORs, so Active has to come off or its rows stay.
                clickOption("Active");
              }, 60);
            }
          }, 60);
        }, 60);
      }, 300);
      return () => clearTimeout(t);
    }
  }, []);
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-stretch border-b border-border bg-bg-panel text-xs">
        <div className="px-4 py-2 border-r border-border text-fg">
          Saved Listings
        </div>
      </div>
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 overflow-auto">
          <Listings />
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <FontScaleProvider>
        <Harness />
      </FontScaleProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
