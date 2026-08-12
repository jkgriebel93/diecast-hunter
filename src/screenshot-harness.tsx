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
 * of clicks someone has to reproduce. The `filter-*` presets are the filter
 * sidebar (DCH-43/44/47); `seller-*`, `wishlist-*` and `share*` cover the
 * facet popover, bulk add and sharing.
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
import { SellerFeed } from "./pages/SellerFeed";
import { resetMinimized, setManyMinimized } from "./lib/minimized";
import { facetSectionKey } from "./lib/facetSections";
import type {
  DriverOption,
  EbaySearchItem,
  EbaySearchPage,
  HiddenFeedListing,
  ListingGroup,
  ListingRow,
  SavedSeller,
  ShareRecord,
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

/** DCH-48's public links, as the Settings list renders them: one healthy,
 *  one on its last day, one already dead. The expired row is the point —
 *  it stays listed so the user learns the link is gone from here rather
 *  than from whoever they sent it to. */
const SHARE_RECORDS: ShareRecord[] = [
  {
    id: 3,
    kind: "listings",
    label: "Daytona auctions — Aug 11, 2026",
    slug: "K7fQ2mX9pLr4vNc1sYb8Zt",
    url: "https://diecast-hunter-ebay.example.workers.dev/w/K7fQ2mX9pLr4vNc1sYb8Zt",
    item_count: 5,
    shared_at: NOW - DAY * 2,
    expires_at: NOW + DAY * 28,
  },
  {
    id: 2,
    kind: "listings",
    label: "For Dad",
    slug: "b3Vt8sQ1yLm5xKc7nZd2Wp",
    url: "https://diecast-hunter-ebay.example.workers.dev/w/b3Vt8sQ1yLm5xKc7nZd2Wp",
    item_count: 2,
    shared_at: NOW - DAY * 29,
    // Off real `Date.now()`, not the day-rounded `NOW`: this row exists to
    // show the under-a-day countdown, and midnight-plus-five-hours is in the
    // past for most of the day, which rendered it "expired" instead.
    expires_at: Math.floor(Date.now() / 1000) + 3600 * 5,
  },
  {
    id: 1,
    kind: "listings",
    label: "3 listings — Jun 2, 2026",
    slug: "Qm4pR7vT2xLb9nKc5sYd1Z",
    url: "https://diecast-hunter-ebay.example.workers.dev/w/Qm4pR7vT2xLb9nKc5sYd1Z",
    item_count: 3,
    shared_at: NOW - DAY * 70,
    expires_at: NOW - DAY * 40,
  },
];

/** DCH-49's subject is the image itself, so unlike the other fixtures these
 *  rows need pictures that actually render: an inline SVG per item, colored
 *  and numbered so the grid reads as distinct listings offline. Item 6 has
 *  no image on purpose — the placeholder box shares the size classes and
 *  has to survive the same layouts. */
function feedImage(i: number): string {
  const hues = [210, 0, 120, 30, 275, 160, 45, 330];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">` +
    `<rect width="400" height="400" fill="hsl(${hues[i % hues.length]},45%,42%)"/>` +
    `<text x="200" y="230" font-family="sans-serif" font-size="120" ` +
    `font-weight="bold" fill="white" text-anchor="middle">#${5 + i}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const SAVED_SELLERS: SavedSeller[] = [
  "diecast_depot",
  "raceday_collectibles",
  "victorylane_1_24",
].map((username, i) => ({
  id: i + 1,
  seller_code: "ebay",
  username,
  display_name: null,
  notes: null,
  created_at: NOW - DAY * 30,
  ebay_origin: false,
  last_synced_at: NOW - DAY,
}));

function feedItem(i: number): EbaySearchItem {
  const driver = DRIVERS[i % DRIVERS.length];
  // Every fourth id collides with a LISTINGS row on purpose, so a couple of
  // cards render the watched state instead of the Watch button.
  const id = i % 4 === 0 ? 200000000 + i : 210000000 + i;
  return {
    item_id: `v1|1${id}|0`,
    legacy_item_id: `1${id}`,
    title: `${2020 + (i % 5)} ${driver} #${5 + i} Diecast 1/24 Elite`,
    price_cents: 4500 + i * 1150,
    shipping_cents: i % 4 === 0 ? null : 1295,
    currency: "USD",
    condition: "New",
    listing_type: i % 3 === 0 ? "auction" : "fixed",
    seller_username: SAVED_SELLERS[i % SAVED_SELLERS.length].username,
    seller_rating: 99.2,
    image_url: i === 6 ? null : feedImage(i),
    web_url: "https://www.ebay.com/itm/1",
    end_time: NOW + DAY * (1 + (i % 6)),
  };
}

const FEED_PAGE: EbaySearchPage = {
  items: Array.from({ length: 8 }, (_, i) => feedItem(i + 1)),
  total: 8,
  limit: 50,
  offset: 0,
  has_more: false,
};

/** DCH-51: two of the feed items above, pre-dismissed, so the hidden
 *  presets show the exclusion and the "2 hidden" review affordance. */
const HIDDEN_FEED: HiddenFeedListing[] = [2, 3].map((i) => ({
  item_id: `v1|1${210000000 + i}|0`,
  title: `${2020 + (i % 5)} ${DRIVERS[i % DRIVERS.length]} #${5 + i} Diecast 1/24 Elite`,
  seller_username: SAVED_SELLERS[i % SAVED_SELLERS.length].username,
  hidden_at: NOW - DAY,
}));

const RESULTS: Record<string, unknown> = {
  list_listings: LISTINGS,
  list_saved_sellers: SAVED_SELLERS,
  // DCH-16's filtered-empty preset needs a feed the filters can "exclude":
  // an empty page plus one clicked chip is the FilteredEmpty state.
  saved_sellers_feed:
    preset === "feed-filtered-empty"
      ? { items: [], total: 0, limit: 50, offset: 0, has_more: false }
      : FEED_PAGE,
  sync_ebay_saved: {
    sellers_seen: 4,
    sellers_created: 1,
    sellers_updated: 3,
    sellers_pruned: 0,
  },
  list_hidden_feed_listings: preset.startsWith("feed-hidden")
    ? HIDDEN_FEED
    : [],
  hide_feed_listing: HIDDEN_FEED[0],
  unhide_feed_listing: null,
  // DCH-52: `feed-details-error` leaves this command unstubbed on purpose —
  // the rejected invoke is the real error path the shot documents.
  ...(preset === "feed-details-error"
    ? {}
    : {
        feed_item_detail: {
          item_id: "v1|1210000001|0",
          image_urls: [feedImage(21), feedImage(22), feedImage(23)],
          aspects: [
            { name: "Scale", value: "1:24" },
            { name: "Driver", value: "Chase Elliott" },
            { name: "Brand", value: "Action Racing Collectables" },
            { name: "Year", value: "2021" },
            { name: "Series", value: "Elite" },
          ],
          description:
            "Mint in box, never displayed. Includes the original certificate of authenticity.\n1 of 5,004 produced.",
        },
      }),
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
  // `share-*` and `settings-share` are DCH-46's unconfigured states; the
  // listing-share presets need a Worker or the dialog only ever explains
  // what's missing.
  get_share_settings:
    preset.startsWith("listing-share") && preset !== "listing-share-unset"
      ? {
          worker_url: "https://diecast-hunter-ebay.example.workers.dev",
          has_secret: true,
        }
      : { worker_url: null, has_secret: false },
  list_shares: preset === "settings-links" ? SHARE_RECORDS : [],
  share_listings: SHARE_RECORDS[0],
  revoke_share: null,
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
// DCH-49's presets photograph the same feed at each image size. Seeded
// before mount because `useImageSize` reads localStorage once, at state
// init, so a post-mount write wouldn't take until a reload.
if (preset.startsWith("feed-")) {
  const size = preset.slice("feed-".length);
  if (size === "sm" || size === "md" || size === "lg") {
    localStorage.setItem("image-size:sellerFeed", size);
  }
}
// DCH-50: the list presets photograph the same feed as full-width rows —
// `feed-list` scrolled to the rows, `feed-list-top` holding on the toolbar
// so the toggle itself is in frame. Seeded pre-mount for the same reason
// as the image size above.
if (preset.startsWith("feed-list")) {
  localStorage.setItem("view-mode:sellerFeed", "list");
}
/** Every section in the panel, checkbox facets and single-control sections
 *  alike — DCH-47 made the second kind collapsible too. */
const ALL_SECTIONS = [
  "status",
  "match",
  "offer",
  "type",
  "driver",
  "seller",
  "year",
  "group",
].map((k) => facetSectionKey("listings", k));
// The filter presets start fully expanded: an option row has to exist to be
// clicked, and the effects below re-collapse the sections once the boxes are
// checked. DCH-43's "expanded" and "badges" presets were the same idea for
// the four checkbox facets alone, and are gone — DCH-47 made every section
// collapsible and replaced the count badge with a summary, so neither shot
// depicts a UI that exists.
if (preset.startsWith("filter-")) {
  setManyMinimized(ALL_SECTIONS, false);
}
// Seller now starts collapsed (DCH-47). Its control has to be on screen
// before the popover presets can drive it — clicking a `display: none`
// trigger opens a menu anchored to a zero-sized rect.
if (preset.startsWith("seller")) {
  setManyMinimized([facetSectionKey("listings", "seller")], false);
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

/** The filter panel's own scroll region (DCH-47). Identified by shape rather
 *  than by a test id: the panel is the only scroller inside the aside, and
 *  putting a hook in the page for the harness's benefit is how the harness
 *  starts dictating the app. */
function panelScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("aside .overflow-y-auto");
}

function Harness() {
  React.useEffect(() => {
    // DCH-47's three panel states. Each drives the real controls, so a shot
    // is evidence the UI can reach the state, not just that it can paint it.
    if (preset.startsWith("filter-")) {
      let cancelled = false;
      void (async () => {
        const step = async (fn: () => void, ms = 150) => {
          await new Promise((r) => setTimeout(r, ms));
          if (!cancelled) fn();
        };
        await step(() => {}, 400);
        if (preset === "filter-active" || preset === "filter-short") {
          await step(() => {
            clickOption("Ended");
            clickOption("Unmatched");
            clickOption("Auction");
          });
          await step(() => clickByText("button", "Exclude"));
          await step(() => clickByText("label", "Watch closely"));
          await step(() =>
            document
              .querySelector<HTMLElement>("div.fixed.inset-0.z-30")
              ?.click(),
          );
          // `filter-short` is the acceptance criterion itself, shot in a
          // window too short for the panel: everything stays expanded, so
          // the middle has to scroll and Clear filters has to stay pinned
          // below it. Collapsing would be cheating the test.
          if (preset === "filter-short") return;
          // Collapsed, every one of those has to announce itself in the
          // header or it is a filter with no way to discover it.
          await step(() => setManyMinimized(ALL_SECTIONS, true));
          return;
        }
        if (preset === "filter-scrolled") {
          // Parked mid-scroll so both edge fades are showing at once.
          await step(() => {
            const el = panelScroller();
            if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
          });
          return;
        }
        if (preset === "filter-menu") {
          // The gotcha the ticket called out: a menu opened from the foot of
          // the scroll region used to be clipped by it.
          await step(() => {
            const el = panelScroller();
            if (el) el.scrollTop = el.scrollHeight;
          });
          // Twice: the panel's measured cap settles a frame after mount, and
          // the first assignment clamps against the pre-settle height.
          await step(() => {
            const el = panelScroller();
            if (el) el.scrollTop = el.scrollHeight;
          });
          await step(() => clickByText("button", "Exclude"));
          return;
        }
      })();
      return () => {
        cancelled = true;
      };
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
    // The feed's cards sit below the filter panel, so an unscrolled capture
    // of the size presets shows everything except the subject (DCH-49).
    // Only those scroll — DCH-16's presets photograph the top of the page.
    if (["feed-sm", "feed-md", "feed-lg", "feed-list"].includes(preset)) {
      const t = setTimeout(() => {
        const port = document.querySelector(".absolute.inset-0.overflow-auto");
        if (port) port.scrollTop = port.scrollHeight;
      }, 400);
      return () => clearTimeout(t);
    }
    // DCH-16: the manage dialog and the active-filters row, driven through
    // the real controls so each shot is a state the UI can reach.
    if (preset === "feed-manage") {
      const t = setTimeout(
        () => clickByText("button", "Manage Saved Sellers"),
        400,
      );
      return () => clearTimeout(t);
    }
    if (preset === "feed-hidden-dialog") {
      const t = setTimeout(() => clickByText("button", "2 hidden"), 400);
      return () => clearTimeout(t);
    }
    // DCH-52: expand the first card's details; the success preset also
    // advances the carousel once so the controls and counter are visibly
    // live rather than decorative.
    if (preset === "feed-details" || preset === "feed-details-error") {
      let cancelled = false;
      void (async () => {
        const step = async (fn: () => void, ms = 150) => {
          await new Promise((r) => setTimeout(r, ms));
          if (!cancelled) fn();
        };
        await step(() => clickByText("button", "Details"), 400);
        if (preset === "feed-details") {
          await step(() => {
            document
              .querySelector<HTMLButtonElement>(
                'button[aria-label="Next image"]',
              )
              ?.click();
          });
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    if (preset === "feed-filters" || preset === "feed-filtered-empty") {
      const t = setTimeout(() => {
        clickByText("button", "New"); // condition chip → filters active
        if (preset === "feed-filters") clickByText("button", "Auction");
      }, 400);
      return () => clearTimeout(t);
    }
    if (preset === "settings-share" || preset === "settings-links") {
      // The sharing cards are last in the Accounts tab, so a viewport-sized
      // capture at scroll 0 would miss them entirely.
      const t = setTimeout(() => {
        const port = document.querySelector(".absolute.inset-0.overflow-auto");
        if (port) port.scrollTop = port.scrollHeight;
      }, 400);
      return () => clearTimeout(t);
    }
    // DCH-48: select mode → pick listings → Share selection…. Driven through
    // the real controls, so the shot is evidence the flow reaches the state.
    if (preset.startsWith("listing-share")) {
      let cancelled = false;
      void (async () => {
        const step = async (fn: () => void, ms = 150) => {
          await new Promise((r) => setTimeout(r, ms));
          if (!cancelled) fn();
        };
        await step(() => clickByText("button", "Select mode"), 300);
        await step(() => {
          const boxes = document.querySelectorAll<HTMLInputElement>(
            'input[aria-label="Select listing"]',
          );
          for (const box of Array.from(boxes).slice(0, 5)) box.click();
        });
        await step(() => clickByText("button", "Share selection…"));
        if (preset === "listing-share-created") {
          // The stubbed command returns a live record, so this is the
          // copy-the-link state the user actually lands on.
          await step(() => clickByText("button", "Create link"), 200);
        }
      })();
      return () => {
        cancelled = true;
      };
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
          {preset.startsWith("settings-")
            ? "Settings"
            : preset.startsWith("share")
              ? "Wishlist"
              : preset.startsWith("feed")
                ? "Seller Feed"
                : "Saved Listings"}
        </div>
      </div>
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 overflow-auto">
          {preset.startsWith("settings-") ? (
            <Settings />
          ) : preset.startsWith("share") ? (
            <Wishlist />
          ) : preset.startsWith("feed") ? (
            <SellerFeed />
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
