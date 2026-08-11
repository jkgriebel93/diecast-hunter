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
import { Wishlist } from "./pages/Wishlist";
// Wishlist links to other pages through <ViewLink>, which reads the
// workspace context. Listings doesn't, which is why this only showed up
// once a second page was photographed.
import { WorkspaceProvider } from "./lib/workspace";
import { Settings } from "./pages/Settings";
import { resetMinimized, setManyMinimized } from "./lib/minimized";
import { facetSectionKey } from "./lib/facetSections";
import type {
  DriverOption,
  ListingGroup,
  ListingRow,
  ShareStatus,
  WishlistBulkAddResult,
  WishlistEntry,
  WishlistInfo,
} from "./lib/tauri";
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

const WISHLISTS: WishlistInfo[] = [
  { wishlist_id: 1, name: "Hunts", created_at: 1, entry_count: 12 },
  { wishlist_id: 2, name: "Grail cars", created_at: 2, entry_count: 3 },
];

/** DCH-45's two reportable shapes. `wishlist-partial` is the one worth
 *  photographing: a partial add is a warning, not an error, and the whole
 *  point is that it doesn't look like a failure. */
const WISHLIST_ADD: Record<string, WishlistBulkAddResult> = {
  "wishlist-added": {
    linked: 4,
    already_present: 0,
    entries_created: 3,
    skipped_no_match: 0,
  },
  "wishlist-partial": {
    linked: 4,
    already_present: 1,
    entries_created: 3,
    skipped_no_match: 2,
  },
  // Nothing addable at all: still not an error, and the message has to say
  // what to do rather than just reporting a zero.
  "wishlist-none": {
    linked: 0,
    already_present: 0,
    entries_created: 0,
    skipped_no_match: 7,
  },
};

/** A few wishes so the Share dialog has a list behind it. */
function wish(i: number): WishlistEntry {
  const driver = DRIVERS[i % DRIVERS.length];
  return {
    entry_id: i,
    wishlist_id: 1,
    registry_entry_id: 900 + i,
    registry_guid: `guid-${i}`,
    driver_name: driver,
    year: 2020 + (i % 5),
    oem: "Chevrolet",
    brand: "Action",
    scale: "1/24",
    make: "CWC",
    scheme_text: i % 2 === 0 ? "Valvoline" : "HendrickCars.com",
    production_qty: 2400,
    retail_value_cents: 9999,
    wholesale_value_cents: null,
    image_url: null,
    detail_url: null,
    notes: i === 1 ? "Only if it's under $80 delivered." : null,
    added_at: NOW - DAY * i,
    sort_rank: i,
    listings: [],
  };
}

const WISHES: WishlistEntry[] = Array.from({ length: 5 }, (_, i) =>
  wish(i + 1),
);

// Preset state driven by the query string so each capture is deterministic.
const params = new URLSearchParams(location.search);
const preset = params.get("preset") ?? "default";

/** DCH-46's three states: unconfigured, configured but not yet shared, and
 *  live. `configured` is what decides whether the dialog offers a button or
 *  explains what's missing. */
const SHARE_STATUS: Record<string, ShareStatus> = {
  "share-unconfigured": {
    wishlist_id: 1,
    slug: null,
    url: null,
    shared_at: null,
    expires_at: null,
    configured: false,
  },
  "share-ready": {
    wishlist_id: 1,
    slug: null,
    url: null,
    shared_at: null,
    expires_at: null,
    configured: true,
  },
  "share-live": {
    wishlist_id: 1,
    slug: "K7fQ2mX9pLr4vNc1sYb8Zt",
    url: "https://diecast-hunter-ebay.example.workers.dev/w/K7fQ2mX9pLr4vNc1sYb8Zt",
    shared_at: NOW - DAY * 2,
    expires_at: NOW + DAY * 28,
    configured: true,
  },
};

const RESULTS: Record<string, unknown> = {
  list_listings: LISTINGS,
  list_wishlists: WISHLISTS,
  create_wishlist: {
    wishlist_id: 3,
    name: "New list",
    created_at: 3,
    entry_count: 0,
  },
  add_listings_to_wishlist:
    WISHLIST_ADD[preset] ?? WISHLIST_ADD["wishlist-added"],
  list_wishlist: WISHES,
  // Enough of Settings to render the Accounts tab for the sharing card.
  get_credentials: {
    diecastregistry_username: "you@example.com",
    diecastregistry_has_password: true,
    ebay_connected: true,
  },
  get_setting: null,
  get_auto_sync_settings: {
    enabled: false,
    interval_hours: 12,
    prewarm_max_entries: 25,
  },
  get_ebay_credentials: {
    has_app_id: true,
    has_cert_id: true,
    environment: "production",
  },
  get_ebay_ru_name: null,
  get_ebay_oauth_status: {
    connected: true,
    expires_at: null,
    environment: "production",
  },
  get_share_settings: { worker_url: null, has_secret: false },
  wishlist_share_status:
    SHARE_STATUS[preset] ?? SHARE_STATUS["share-unconfigured"],
  share_wishlist: SHARE_STATUS["share-live"],
  revoke_wishlist_share: SHARE_STATUS["share-ready"],
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
    if (preset === "settings-share") {
      // The sharing card is the last one in the Accounts tab, so a
      // viewport-sized capture at scroll 0 would miss it entirely.
      const t = setTimeout(() => {
        const port = document.querySelector(".absolute.inset-0.overflow-auto");
        if (port) port.scrollTop = port.scrollHeight;
      }, 400);
      return () => clearTimeout(t);
    }
    if (preset.startsWith("share")) {
      let cancelled = false;
      void (async () => {
        await new Promise((r) => setTimeout(r, 250));
        if (!cancelled) clickByText("button", "Share…");
      })();
      return () => {
        cancelled = true;
      };
    }
    if (preset.startsWith("wishlist")) {
      let cancelled = false;
      void (async () => {
        const step = async (fn: () => void) => {
          await new Promise((r) => setTimeout(r, 150));
          if (!cancelled) fn();
        };
        await step(() => clickByText("button", "Select mode"));
        await step(() => {
          // Four rows so the counts in the notice have something to be
          // about; the fixture gives roughly two in three a registry match.
          const boxes = document.querySelectorAll<HTMLInputElement>(
            'input[aria-label="Select listing"]',
          );
          for (const box of Array.from(boxes).slice(0, 7)) box.click();
        });
        await step(() => clickByText("button", "Add to wishlist…"));
        if (preset === "wishlist-picker") return;
        if (preset === "wishlist-new") {
          await step(() => clickByText("button", "+ New wishlist…"));
          return;
        }
        // Picking a list runs the real handler; the stubbed command decides
        // which of DCH-45's reportable shapes comes back.
        await step(() => clickByText("button", "Hunts"));
      })();
      return () => {
        cancelled = true;
      };
    }
  }, []);
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-stretch border-b border-border bg-bg-panel text-xs">
        <div className="px-4 py-2 border-r border-border text-fg">
          {preset === "settings-share"
            ? "Settings"
            : preset.startsWith("share")
              ? "Wishlist"
              : "Saved Listings"}
        </div>
      </div>
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 overflow-auto">
          {preset === "settings-share" ? (
            <Settings />
          ) : preset.startsWith("share") ? (
            <Wishlist />
          ) : (
            <Listings />
          )}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <FontScaleProvider>
        <WorkspaceProvider>
          <Harness />
        </WorkspaceProvider>
      </FontScaleProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
