import {
  Fragment,
  type ReactNode,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import {
  api,
  formatAgo,
  formatCents,
  formatCount,
  formatUntil,
  isPreferredOem,
  prepareBrandOptions,
  prepareMakeOptions,
  prepareScaleOptions,
  prepareYearOptions,
  byDriverNamePriority,
  driverListingCounts,
  sortDriverOptions,
  type CompSummary,
  type DriverOption,
  type FormOptionRow,
  type GroupMigrationProposal,
  type ListingAttributes,
  type ListingGroup,
  type ListingGroupInput,
  type ListingRow,
  type ProductionSearchResult,
  type ReceivedOffer,
  type WishlistInfo,
} from "@/lib/tauri";
import {
  loadAttributeOptions,
  EMPTY_ATTRIBUTE_OPTIONS,
  type AttributeOptions,
} from "@/lib/attributeOptions";
import { useImageSize, IMG_CLASS } from "@/lib/imageSize";
import { ImageSizeToggle } from "@/components/ImageSizeToggle";
import { useMinimized, MinimizeToggle } from "@/lib/minimized";
import { ErrorBanner } from "@/components/ErrorBanner";
import { NoticeBanner } from "@/components/NoticeBanner";
import { Modal } from "@/components/Modal";
import { WishlistPickerDialog } from "@/components/WishlistPickerDialog";
import { ShareListingsDialog } from "@/components/ShareListingsDialog";
import { describeWishlistAdd, type WishlistNotice } from "@/lib/wishlistNotice";
import { ClearFiltersButton, FilteredEmpty } from "@/components/FilterCard";
import { YearRangeFilter } from "@/components/YearRangeFilter";
import {
  LISTING_FACETS,
  facetDefaultSelection,
  facetSection,
  facetSectionKey,
  type FacetSection,
} from "@/lib/facetSections";
import {
  controlSection,
  facetSummary,
  groupSummary,
  useScrollEdges,
  useStickyMaxHeight,
  yearSummary,
  type FilterSummary,
} from "@/lib/filterPanel";
import { AnchoredMenu, AnchoredMenuList } from "@/components/AnchoredMenu";
import {
  passesSellerFilter,
  sellerFilterLabel,
  sellerOptions,
  type SellerKey,
  type SellerOption,
} from "@/lib/sellerFilter";
import {
  EMPTY_YEAR_RANGE,
  inYearRange,
  isEmptyRange,
  parseYear,
  yearsInRange,
  type YearRange,
} from "@/lib/yearRange";

type ViewMode = "flat" | "byDriver" | "byGroup";
// The checkbox facets (status, match, offer, type) hold the set of checked
// options. Empty set = facet off = show everything; multiple checks OR
// together within the facet.
type StatusOption = "active" | "ended" | "archived";

/** Human labels for `listings.end_reason` on archived rows. */
const END_REASON_LABELS: Record<string, string> = {
  sold: "sold",
  ended: "ended unsold",
  removed: "removed from eBay",
};
/** "confirmed"/"unconfirmed" split matched listings by user verification;
 *  "unmatched" = no registry entry (including user-marked no-match rows). */
type MatchOption = "confirmed" | "unconfirmed" | "unmatched";
type OfferOption = "unresponded" | "with" | "without";
/** Buying-format facet. "bin" = fixed price that does NOT take offers;
 *  "offers" = accepts Best Offers (fixed or auction). */
type TypeOption = "auction" | "bin" | "offers";
/** "all" = no group filter; "none" = listings with zero groups; otherwise the
 *  numeric group id as a string. */
type GroupFilter = string;
type SortMode =
  | "seen-desc"
  | "price-asc"
  | "price-desc"
  | "total-asc"
  | "deal-asc"
  | "ending-asc"
  | "title-asc";
/** Ordering of the driver/group sections in the grouped views. */
type BucketSort = "name-asc" | "count-desc" | "count-asc";

/** Cluster groups by driver for the filter dropdown and the by-group view.
 *  A group with multiple drivers appears under each of them. Archived groups
 *  are kept out of the driver sections — they live in their own bucket so
 *  resolved hunts don't clutter the active driver lists. */
function clusterGroupsByDriver(groups: ListingGroup[]): {
  drivers: { id: number; name: string; groups: ListingGroup[] }[];
  noDriver: ListingGroup[];
  archived: ListingGroup[];
} {
  const archived = groups.filter((g) => g.archived);
  const active = groups.filter((g) => !g.archived);
  const byDriver = new Map<number, { name: string; groups: ListingGroup[] }>();
  const noDriver: ListingGroup[] = [];
  for (const g of active) {
    if (g.drivers.length === 0) {
      noDriver.push(g);
      continue;
    }
    for (const d of g.drivers) {
      if (!byDriver.has(d.id)) byDriver.set(d.id, { name: d.name, groups: [] });
      byDriver.get(d.id)!.groups.push(g);
    }
  }
  const drivers = Array.from(byDriver.entries())
    .map(([id, v]) => ({ id, name: v.name, groups: v.groups }))
    .sort(
      (a, b) =>
        byDriverNamePriority(a.name, b.name) || a.name.localeCompare(b.name),
    );
  for (const d of drivers)
    d.groups.sort((a, b) => a.name.localeCompare(b.name));
  noDriver.sort((a, b) => a.name.localeCompare(b.name));
  archived.sort((a, b) => a.name.localeCompare(b.name));
  return { drivers, noDriver, archived };
}

/** Split groups into those tied to any of the given drivers and the rest,
 *  preserving order. Matches by local driver id where available and falls
 *  back to case-insensitive name — the registry-match driver on a listing
 *  has no local id, only a name. Used by the group pickers to float the
 *  relevant driver's groups to the top without hiding cross-driver groups
 *  like "Lots". */
function partitionGroupsByDrivers(
  groups: ListingGroup[],
  driverIds: Set<number>,
  driverNames: Set<string>,
): { preferred: ListingGroup[]; others: ListingGroup[] } {
  const preferred: ListingGroup[] = [];
  const others: ListingGroup[] = [];
  for (const g of groups) {
    const hit = g.drivers.some(
      (d) => driverIds.has(d.id) || driverNames.has(d.name.toLowerCase()),
    );
    (hit ? preferred : others).push(g);
  }
  return { preferred, others };
}

interface ListingFilterState {
  /** Lower-cased, trimmed search text; empty = no text filter. */
  q: string;
  status: Set<StatusOption>;
  match: Set<MatchOption>;
  offer: Set<OfferOption>;
  type: Set<TypeOption>;
  group: GroupFilter;
  excluded: Set<number>;
  /** "all", "none", or `d:<lowercased driver name>`. */
  driver: string;
  /** Lower-cased seller usernames, `null` for rows with no seller. Empty =
   *  facet off; multiple sellers OR together. */
  seller: Set<SellerKey>;
  /** Bounds on the matched registry entry's year; unset = no year filter. */
  year: YearRange;
  offersByItemId: Map<string, ReceivedOffer>;
}

/** Single predicate behind both the visible listing list and the sidebar
 *  facet counts. The driver filter matches the registry-match driver first,
 *  then the auto/manual tag — the same precedence the by-driver view uses. */
function listingPassesFilters(row: ListingRow, f: ListingFilterState): boolean {
  if (f.q) {
    const hay = [
      row.title,
      row.matched_driver_name,
      row.matched_scheme_text,
      row.seller_username,
      row.matched_oem,
      row.matched_brand,
      row.oem,
      row.brand,
      row.finish,
      row.make,
      row.is_race_win && "race win",
      row.is_autographed && "autograph autographed",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  if (f.status.size > 0) {
    // Archived is its own bucket: "Ended" means ended-but-not-yet-archived
    // (a transient state between enrichment and the sync's archive pass),
    // so the default active-only filter keeps archived history out of the
    // deal-hunting views until explicitly requested.
    const ok =
      (f.status.has("active") && row.status === "active") ||
      (f.status.has("ended") && row.status === "ended" && !row.is_archived) ||
      (f.status.has("archived") && row.is_archived);
    if (!ok) return false;
  }
  if (f.match.size > 0) {
    const matched = row.registry_entry_id !== null;
    const ok =
      (f.match.has("confirmed") && matched && row.match_user_confirmed) ||
      (f.match.has("unconfirmed") && matched && !row.match_user_confirmed) ||
      (f.match.has("unmatched") && !matched);
    if (!ok) return false;
  }
  if (f.type.size > 0) {
    const ok =
      (f.type.has("auction") && row.listing_type === "auction") ||
      (f.type.has("bin") &&
        row.listing_type === "fixed" &&
        !row.accepts_offers) ||
      (f.type.has("offers") && row.accepts_offers);
    if (!ok) return false;
  }
  // Year comes from the registry match: a listing's own title year is
  // unreliable (race season vs. release year), and an unmatched row has no
  // trustworthy year at all — so it drops out once a bound is set.
  if (!inYearRange(row.matched_year, f.year)) return false;
  if (f.driver !== "all") {
    const name = row.matched_driver_name ?? row.auto_driver_name;
    if (f.driver === "none") {
      if (name !== null) return false;
    } else if (!name || `d:${name.toLowerCase()}` !== f.driver) {
      return false;
    }
  }
  if (!passesSellerFilter(row.seller_username, f.seller)) return false;
  if (f.group !== "all") {
    if (f.group === "none") {
      if (row.group_ids.length > 0) return false;
    } else {
      const wanted = Number(f.group);
      if (!row.group_ids.includes(wanted)) return false;
    }
  }
  if (f.excluded.size > 0 && row.group_ids.some((id) => f.excluded.has(id)))
    return false;
  if (f.offer.size > 0) {
    const offer = f.offersByItemId.get(legacyIdFromExternalId(row.external_id));
    const hasOffer = offer !== undefined;
    // Heuristic for "user already responded": either the notification
    // was opened (eBay flips <Read> on the inbox UI when you open the
    // message — which the web accept/decline flow does), or the
    // underlying listing has ended (signal that the offer was accepted
    // and the item sold). Conservative: a missing listing is treated as
    // "still active" so users who haven't run watchlist sync still see
    // their offers.
    const responded = hasOffer && (offer.is_read || row.status === "ended");
    const ok =
      (f.offer.has("with") && hasOffer) ||
      (f.offer.has("without") && !hasOffer) ||
      (f.offer.has("unresponded") && hasOffer && !responded);
    if (!ok) return false;
  }
  return true;
}

/** Fresh Set with `v` added or removed — checkbox-facet toggle. */
function toggled<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

/** Status is the one facet that starts narrowed — see LISTING_FACETS. */
const defaultStatusFilter = () =>
  facetDefaultSelection<StatusOption>(LISTING_FACETS, "status");

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function Listings() {
  const [rows, setRows] = useState<ListingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** legacy eBay item id → active seller offer, populated lazily on
   *  mount via a parallel fetch. Failures (no eBay OAuth, network, etc.)
   *  are silently ignored — the page works without offer badges. */
  const [offersByItemId, setOffersByItemId] = useState<
    Map<string, ReceivedOffer>
  >(new Map());

  const [viewMode, setViewMode] = useState<ViewMode>("flat");
  const [registrySearchListing, setRegistrySearchListing] =
    useState<ListingRow | null>(null);
  const [imgSize, setImgSize] = useImageSize("listings");

  const [groups, setGroups] = useState<ListingGroup[]>([]);
  const [manageGroupsOpen, setManageGroupsOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Authored prose about an action that went through, so it carries its own
  // tone rather than being an error (DCH-36). `warning` is "worked, minus
  // these" — the wishlist add uses it for listings it had to skip.
  const [bulkNotice, setBulkNotice] = useState<WishlistNotice | null>(null);
  const [bulkCreateGroupOpen, setBulkCreateGroupOpen] = useState(false);
  const [bulkWishlistOpen, setBulkWishlistOpen] = useState(false);
  const [bulkShareOpen, setBulkShareOpen] = useState(false);
  // Whether a Worker is configured at all (DCH-48). Read once on mount so the
  // dialog can explain what's missing instead of offering a button that fails
  // only after every image has been downloaded and embedded.
  const [shareConfigured, setShareConfigured] = useState(false);
  // When set, the per-listing "create a new group" editor is open for this
  // listing; on save the freshly created group is applied to it.
  const [createGroupForListingId, setCreateGroupForListingId] = useState<
    number | null
  >(null);

  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] =
    useState<Set<StatusOption>>(defaultStatusFilter);
  const [matchFilter, setMatchFilter] = useState<Set<MatchOption>>(
    () => new Set(),
  );
  const [offerFilter, setOfferFilter] = useState<Set<OfferOption>>(
    () => new Set(),
  );
  const [typeFilter, setTypeFilter] = useState<Set<TypeOption>>(
    () => new Set(),
  );
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("all");
  // Listings belonging to any of these groups are hidden. Independent of
  // `groupFilter` so you can e.g. show all listings except the "Purchased"
  // group, or drill into one group while hiding an overlapping one.
  const [excludedGroupIds, setExcludedGroupIds] = useState<Set<number>>(
    new Set(),
  );
  // "all", "none", or `d:<lowercased driver name>` — see listingPassesFilters.
  const [driverFilter, setDriverFilter] = useState<string>("all");
  const [sellerFilter, setSellerFilter] = useState<Set<SellerKey>>(
    () => new Set(),
  );
  const [yearFilter, setYearFilter] = useState<YearRange>(EMPTY_YEAR_RANGE);
  const [sortMode, setSortMode] = useState<SortMode>("seen-desc");
  const [bucketSort, setBucketSort] = useState<BucketSort>("name-asc");

  // Filters sidebar visibility, persisted so the choice sticks across
  // visits. Collapsing does not clear the filters — they keep applying.
  const [filtersCollapsed, setFiltersCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("listings.filtersCollapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "listings.filtersCollapsed",
        filtersCollapsed ? "1" : "0",
      );
    } catch {
      // ignore
    }
  }, [filtersCollapsed]);

  // Sharing needs a Worker URL and secret. A failure to read them is not
  // worth a banner on the Listings page — it just means the share dialog
  // explains what's missing, which is what it would say anyway.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await api.getShareSettings();
        if (!cancelled) setShareConfigured(!!s.worker_url && s.has_secret);
      } catch {
        // leave it false
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Collapse/expand-all plumbing for the grouped views. The per-section
  // collapse state lives inside GroupedByDriver/GroupedByGroup (they own
  // the bucket keys and per-section defaults); the toolbar sends one-shot
  // commands down via a sequence number and the active view reports its
  // aggregate state back up so the flip label stays correct.
  const [collapseCmd, setCollapseCmd] = useState<{
    seq: number;
    collapse: boolean;
  }>({ seq: 0, collapse: false });
  const [allCollapsed, setAllCollapsed] = useState(false);

  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [unwatchingId, setUnwatchingId] = useState<number | null>(null);
  const [bulkRefreshing, setBulkRefreshing] = useState(false);

  const [syncingWatchlist, setSyncingWatchlist] = useState(false);

  // One-line outcome of the most recent header action (sync watchlist,
  // auto-match all, refresh all) — each new action overwrites the last.
  const [actionSummary, setActionSummary] = useState<string | null>(null);

  // Registry auto-match. `autoMatchingId` is the listing whose per-card
  // button is busy; `autoMatchNotes` holds per-listing "why no match"
  // feedback from the last attempt.
  const [autoMatchingAll, setAutoMatchingAll] = useState(false);
  const [autoMatchingId, setAutoMatchingId] = useState<number | null>(null);
  const [autoMatchNotes, setAutoMatchNotes] = useState<Map<number, string>>(
    new Map(),
  );

  // Driver-picker (independent of registry match). `tagDriverId` holds
  // the listing currently in edit mode; null when no popover is open.
  // `localDrivers` is the local drivers table — used for autocomplete.
  const [localDrivers, setLocalDrivers] = useState<DriverOption[]>([]);
  const [tagDriverId, setTagDriverId] = useState<number | null>(null);

  async function load() {
    setError(null);
    try {
      const list = await api.listListings();
      setRows(list);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
    void loadOffers();
    void loadGroups();
    void loadLocalDrivers();
  }, []);

  async function loadLocalDrivers() {
    try {
      const list = await api.listDrivers();
      setLocalDrivers(
        sortDriverOptions(
          list,
          (d) => d.name,
          (d) => d.listing_count,
        ),
      );
    } catch {
      // Non-fatal: the driver picker still works on free-form input.
    }
  }

  async function onSetDriver(
    listingId: number,
    name: string,
    normalized: string,
  ) {
    setError(null);
    try {
      await api.setListingDriver(listingId, name, normalized);
      setTagDriverId(null);
      await Promise.all([load(), loadLocalDrivers()]);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onClearDriver(listingId: number) {
    setError(null);
    try {
      await api.clearListingDriver(listingId);
      setTagDriverId(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onResetDriver(listingId: number) {
    setError(null);
    try {
      await api.resetListingDriver(listingId);
      setTagDriverId(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onSetAttributes(listingId: number, attrs: ListingAttributes) {
    setError(null);
    try {
      await api.setListingAttributes(listingId, attrs);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onResetAttributes(listingId: number) {
    setError(null);
    try {
      await api.resetListingAttributes(listingId);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadGroups() {
    try {
      const list = await api.listListingGroups();
      setGroups(list);
    } catch (e) {
      // Surface group failures inline; listings still work without them.
      setError(String(e));
    }
  }

  async function onAddListingToGroup(listingId: number, groupId: number) {
    setError(null);
    try {
      await api.addListingToGroup(groupId, listingId);
      await Promise.all([load(), loadGroups()]);
    } catch (e) {
      setError(String(e));
    }
  }

  // Apply a just-created group to the single listing it was created from.
  async function onCreatedGroupForListing(
    listingId: number,
    group: ListingGroup,
  ) {
    setCreateGroupForListingId(null);
    setError(null);
    try {
      await api.addListingToGroup(group.id, listingId);
    } catch (e) {
      setError(String(e));
    } finally {
      await Promise.all([load(), loadGroups()]);
    }
  }

  async function onRemoveListingFromGroup(listingId: number, groupId: number) {
    setError(null);
    try {
      await api.removeListingFromGroup(groupId, listingId);
      await Promise.all([load(), loadGroups()]);
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleSelected(listingId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(listingId)) next.delete(listingId);
      else next.add(listingId);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
    setBulkNotice(null);
  }

  async function onBulkAddToGroup(groupId: number) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkBusy(true);
    setBulkNotice(null);
    setError(null);
    try {
      const result = await api.addListingsToGroup(groupId, ids);
      const group = groups.find((g) => g.id === groupId);
      const name = group?.name ?? "group";
      setBulkNotice({
        tone: "success",
        message:
          `Added ${formatCount(result.added)} to "${name}"` +
          (result.already_present > 0
            ? ` (${formatCount(result.already_present)} already there).`
            : "."),
      });
      await Promise.all([load(), loadGroups()]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBulkBusy(false);
    }
  }

  // Called after a brand-new group is created from the Select-mode "Add to
  // group" menu: refresh the group list, then add the current selection to it.
  async function onBulkCreatedGroup(group: ListingGroup) {
    setBulkCreateGroupOpen(false);
    const ids = Array.from(selectedIds);
    setBulkBusy(true);
    setBulkNotice(null);
    setError(null);
    try {
      if (ids.length === 0) {
        setBulkNotice({
          tone: "success",
          message: `Created "${group.name}".`,
        });
        return;
      }
      const result = await api.addListingsToGroup(group.id, ids);
      setBulkNotice({
        tone: "success",
        message: `Created "${group.name}" and added ${formatCount(result.added)}.`,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBulkBusy(false);
      await Promise.all([load(), loadGroups()]);
    }
  }

  // Add the selection to a wishlist as purchase candidates (DCH-45). The
  // backend resolves each listing through its registry match and does the
  // find-or-create + link in one transaction, so all this has to decide is
  // what to say about what came back.
  async function onBulkAddToWishlist(wishlist: WishlistInfo) {
    const ids = Array.from(selectedIds);
    setBulkWishlistOpen(false);
    if (ids.length === 0) return;
    setBulkBusy(true);
    setBulkNotice(null);
    setError(null);
    try {
      const result = await api.addListingsToWishlist(wishlist.wishlist_id, ids);
      setBulkNotice(describeWishlistAdd(result, wishlist.name));
    } catch (e) {
      setError(String(e));
    } finally {
      setBulkBusy(false);
    }
  }

  async function onBulkRemoveFromGroup(groupId: number) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkBusy(true);
    setBulkNotice(null);
    setError(null);
    try {
      const removed = await api.removeListingsFromGroup(groupId, ids);
      const group = groups.find((g) => g.id === groupId);
      const name = group?.name ?? "group";
      setBulkNotice({
        tone: "success",
        message: `Removed ${formatCount(removed)} from "${name}".`,
      });
      await Promise.all([load(), loadGroups()]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBulkBusy(false);
    }
  }

  async function loadOffers() {
    try {
      const list = await api.listEbayOffers();
      const nowSec = Math.floor(Date.now() / 1000);
      const map = new Map<string, ReceivedOffer>();
      for (const o of list) {
        if (o.expires_at !== null && o.expires_at < nowSec) continue;
        map.set(o.item_id, o);
      }
      setOffersByItemId(map);
    } catch {
      // Best-effort decoration; no surface for errors here.
    }
  }

  async function onRefreshOne(id: number) {
    setRefreshingId(id);
    try {
      await api.refreshEbayListing(id);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setRefreshingId(null);
    }
  }

  async function onUnwatch(row: ListingRow) {
    const ok = window.confirm(
      `Remove this listing from your eBay watchlist and delete its local row (including price history)?\n\n${row.title}`,
    );
    if (!ok) return;
    setUnwatchingId(row.listing_id);
    setError(null);
    try {
      await api.unwatchEbayListing(row.listing_id);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setUnwatchingId(null);
    }
  }

  async function onRefreshAll() {
    setBulkRefreshing(true);
    setActionSummary(null);
    try {
      const s = await api.refreshAllEbayListings();
      setActionSummary(
        `Refreshed ${s.refreshed} of ${s.considered} (${s.failed} failed).`,
      );
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBulkRefreshing(false);
    }
  }

  async function onSyncWatchlist() {
    setSyncingWatchlist(true);
    setActionSummary(null);
    setError(null);
    try {
      const s = await api.syncEbayWatchlist();
      setActionSummary(
        `Watchlist: ${s.created} new, ${s.updated} updated, ` +
          `${s.skipped_fresh} fresh (skipped), ` +
          `${s.filtered} filtered (non-diecasts), ${s.failed} failed, ` +
          `${s.archived} archived (${s.unwatched} unwatched on eBay), ` +
          `${s.removed} removed from eBay, ` +
          `${s.pruned} pruned (no longer watched) across ${s.pages_fetched} ` +
          `page${s.pages_fetched === 1 ? "" : "s"} (${s.items_seen} items total).`,
      );
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncingWatchlist(false);
    }
  }

  async function onAutoMatchAll() {
    setAutoMatchingAll(true);
    setActionSummary(null);
    setError(null);
    try {
      const s = await api.autoMatchAllListings();
      setActionSummary(
        `Auto-match: ${s.matched} matched, ${s.below_threshold} below ` +
          `confidence threshold, ${s.no_driver} without a driver, ` +
          `${s.no_candidates} with no registry entries` +
          (s.prewarmed_drivers > 0
            ? `, ${s.prewarmed_drivers} driver${
                s.prewarmed_drivers === 1 ? "" : "s"
              } pulled from diecastregistry.com`
            : "") +
          ` (of ${s.considered} considered).`,
      );
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAutoMatchingAll(false);
    }
  }

  async function onAutoMatchOne(listingId: number) {
    setAutoMatchingId(listingId);
    setError(null);
    try {
      const outcome = await api.autoMatchListing(listingId);
      setAutoMatchNotes((prev) => {
        const next = new Map(prev);
        if (outcome.matched) next.delete(listingId);
        else
          next.set(
            listingId,
            outcome.skipped_reason ?? "No registry match found.",
          );
        return next;
      });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAutoMatchingId(null);
    }
  }

  async function onConfirmMatch(listingId: number) {
    setError(null);
    try {
      await api.confirmListingMatch(listingId);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onClearMatch(listingId: number) {
    setError(null);
    try {
      await api.clearListingMatch(listingId);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onRejectMatch(listingId: number) {
    setError(null);
    try {
      await api.rejectListingMatch(listingId);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  // Current filter state in the shape listingPassesFilters consumes. The
  // facet-count memos override single fields of this to answer "what would
  // I see if I picked that option instead?".
  const filterState = useMemo<ListingFilterState>(
    () => ({
      q: searchText.trim().toLowerCase(),
      status: statusFilter,
      match: matchFilter,
      offer: offerFilter,
      type: typeFilter,
      group: groupFilter,
      excluded: excludedGroupIds,
      driver: driverFilter,
      seller: sellerFilter,
      year: yearFilter,
      offersByItemId,
    }),
    [
      searchText,
      statusFilter,
      matchFilter,
      offerFilter,
      typeFilter,
      groupFilter,
      excludedGroupIds,
      driverFilter,
      sellerFilter,
      yearFilter,
      offersByItemId,
    ],
  );

  const filteredRows = useMemo(() => {
    if (!rows) return null;
    const sorted = rows.filter((row) => listingPassesFilters(row, filterState));
    sorted.sort((a, b) => {
      const totalA =
        a.price_cents !== null ? a.price_cents + (a.shipping_cents ?? 0) : null;
      const totalB =
        b.price_cents !== null ? b.price_cents + (b.shipping_cents ?? 0) : null;
      const nullsLast = (av: number | null, bv: number | null) => {
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return av - bv;
      };
      switch (sortMode) {
        case "seen-desc":
          return b.last_seen_at - a.last_seen_at;
        case "price-asc":
          return nullsLast(a.price_cents, b.price_cents);
        case "price-desc":
          return nullsLast(b.price_cents, a.price_cents);
        case "total-asc":
          return nullsLast(totalA, totalB);
        case "deal-asc":
          // Sort on whichever score the row's badge is showing, so the order
          // matches what the user sees rather than a hidden second metric.
          return nullsLast(
            a.comp_score ?? a.deal_score,
            b.comp_score ?? b.deal_score,
          );
        case "ending-asc":
          return nullsLast(a.end_time, b.end_time);
        case "title-asc":
          return a.title.localeCompare(b.title);
      }
    });
    return sorted;
  }, [rows, filterState, sortMode]);

  // Per-option result counts for the sidebar facets. Each count answers
  // "how many listings would I see if I picked this option?" — i.e. it is
  // computed with the search text and every OTHER filter still applied.
  const facetCounts = useMemo(() => {
    const all = rows ?? [];
    const count = (ov: Partial<ListingFilterState>) => {
      const f = { ...filterState, ...ov };
      let n = 0;
      for (const r of all) if (listingPassesFilters(r, f)) n++;
      return n;
    };
    return {
      status: {
        active: count({ status: new Set(["active"]) }),
        ended: count({ status: new Set(["ended"]) }),
        archived: count({ status: new Set(["archived"]) }),
      },
      match: {
        confirmed: count({ match: new Set(["confirmed"]) }),
        unconfirmed: count({ match: new Set(["unconfirmed"]) }),
        unmatched: count({ match: new Set(["unmatched"]) }),
      },
      offer: {
        unresponded: count({ offer: new Set(["unresponded"]) }),
        with: count({ offer: new Set(["with"]) }),
        without: count({ offer: new Set(["without"]) }),
      },
      type: {
        auction: count({ type: new Set(["auction"]) }),
        bin: count({ type: new Set(["bin"]) }),
        offers: count({ type: new Set(["offers"]) }),
      },
    };
  }, [rows, filterState]);

  // Driver options for the sidebar combobox, derived from the loaded rows
  // with the same precedence the by-driver view uses (registry-match driver
  // first, then the auto/manual tag). Counts are faceted: they apply every
  // filter except the driver filter itself.
  const driverOptions = useMemo(() => {
    const f: ListingFilterState = { ...filterState, driver: "all" };
    const byKey = new Map<string, { name: string; count: number }>();
    let noneCount = 0;
    let allCount = 0;
    for (const r of rows ?? []) {
      if (!listingPassesFilters(r, f)) continue;
      allCount++;
      const name = r.matched_driver_name ?? r.auto_driver_name;
      if (!name) {
        noneCount++;
        continue;
      }
      const key = name.toLowerCase();
      const entry = byKey.get(key);
      if (entry) entry.count++;
      else byKey.set(key, { name, count: 1 });
    }
    const options = Array.from(byKey.entries())
      .map(([key, v]) => ({ value: `d:${key}`, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { options, noneCount, allCount };
  }, [rows, filterState]);

  const driverFilterLabel = useMemo(() => {
    if (driverFilter === "all") return "All drivers";
    if (driverFilter === "none") return "No driver";
    const key = driverFilter.slice(2);
    for (const r of rows ?? []) {
      const name = r.matched_driver_name ?? r.auto_driver_name;
      if (name && name.toLowerCase() === key) return name;
    }
    return key;
  }, [driverFilter, rows]);

  // Seller options for the sidebar popover, derived from the loaded rows the
  // same way the driver options are: every filter applies except the seller
  // facet itself, so a count answers "how many would I see if I picked this
  // seller?".
  const sellerFilterOptions = useMemo(() => {
    const f: ListingFilterState = { ...filterState, seller: new Set() };
    return sellerOptions(
      (rows ?? []).filter((r) => listingPassesFilters(r, f)),
    );
  }, [rows, filterState]);

  /** Years present on the loaded listings' registry matches, newest-first.
   *  Derived from the rows rather than the DCR form options so the dropdown
   *  only offers years that can actually return something. */
  const yearFilterOptions = useMemo(() => {
    const seen = new Set<number>();
    for (const r of rows ?? []) {
      if (r.matched_year !== null) seen.add(r.matched_year);
    }
    return [...seen].sort((a, b) => b - a).map(String);
  }, [rows]);

  // Number of sidebar filters currently off their defaults, search text
  // included. Shown on the collapsed filters rail so hidden-but-active
  // filters stay visible.
  const activeFilterCount =
    (searchText.trim() !== "" ? 1 : 0) +
    (!setsEqual(statusFilter, defaultStatusFilter()) ? 1 : 0) +
    (matchFilter.size > 0 ? 1 : 0) +
    (offerFilter.size > 0 ? 1 : 0) +
    (typeFilter.size > 0 ? 1 : 0) +
    (groupFilter !== "all" ? 1 : 0) +
    (excludedGroupIds.size > 0 ? 1 : 0) +
    (driverFilter !== "all" ? 1 : 0) +
    (sellerFilter.size > 0 ? 1 : 0) +
    (isEmptyRange(yearFilter) ? 0 : 1);

  // Facet options are built here rather than inline in the panel because
  // two things need them now: the checkbox rows, and the header summary that
  // has to name the checked option when the rows are hidden (DCH-47).
  const statusFacetOptions = [
    { value: "active", label: "Active", count: facetCounts.status.active },
    { value: "ended", label: "Ended", count: facetCounts.status.ended },
    {
      value: "archived",
      label: "Archived",
      count: facetCounts.status.archived,
    },
  ];
  const matchFacetOptions = [
    {
      value: "confirmed",
      label: "Confirmed",
      count: facetCounts.match.confirmed,
    },
    {
      value: "unconfirmed",
      label: "Unconfirmed",
      count: facetCounts.match.unconfirmed,
    },
    {
      value: "unmatched",
      label: "Unmatched",
      count: facetCounts.match.unmatched,
    },
  ];
  const offerFacetOptions = [
    {
      value: "unresponded",
      label: "Unresponded",
      count: facetCounts.offer.unresponded,
    },
    { value: "with", label: "Any offer", count: facetCounts.offer.with },
    { value: "without", label: "No offer", count: facetCounts.offer.without },
  ];
  const typeFacetOptions = [
    { value: "auction", label: "Auction", count: facetCounts.type.auction },
    { value: "bin", label: "Buy It Now only", count: facetCounts.type.bin },
    {
      value: "offers",
      label: "Accepts offers",
      count: facetCounts.type.offers,
    },
  ];

  /** Display name behind a group-id filter value, for the Group section's
   *  collapsed summary. Null while the groups list is still loading — the
   *  summary says "1 group" rather than going blank. */
  const groupFilterName = useMemo(() => {
    if (groupFilter === "all" || groupFilter === "none") return null;
    return groups.find((g) => String(g.id) === groupFilter)?.name ?? null;
  }, [groupFilter, groups]);

  // Height of the filter panel, and which of its edges have content past
  // them. Both are measured rather than assumed: the panel sticks inside
  // EditorPane's scrollport, which is shorter than the window (see
  // `useStickyMaxHeight`).
  const [setPanelEl, panelMaxHeight] = useStickyMaxHeight(16);
  const [setPanelScrollEl, panelEdges] = useScrollEdges();

  function clearAllFilters() {
    setSearchText("");
    setStatusFilter(defaultStatusFilter());
    setMatchFilter(new Set());
    setOfferFilter(new Set());
    setTypeFilter(new Set());
    setGroupFilter("all");
    setExcludedGroupIds(new Set());
    setDriverFilter("all");
    setSellerFilter(new Set());
    setYearFilter(EMPTY_YEAR_RANGE);
  }

  // Drop exclusions for groups that no longer exist (deleted via the
  // Manage dialog) so the Exclude badge count never goes stale.
  useEffect(() => {
    setExcludedGroupIds((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(groups.map((g) => g.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [groups]);

  // Keep the selection in sync with what's on screen: any action that drops a
  // listing from view (a filter change, a group add/remove under an active
  // group filter, a refresh that ends/removes it) also drops it from the
  // selection, so bulk actions never silently apply to hidden rows.
  useEffect(() => {
    if (!selectMode || !filteredRows) return;
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(filteredRows.map((r) => r.listing_id));
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filteredRows, selectMode]);

  // Seed the create-group editor with the listing's driver — registry match
  // first, then the auto/manual tag — resolved against the local drivers
  // table where possible. An unresolved name becomes a pending chip that
  // `ensure_driver` materializes when the group is saved.
  function prefillDriversForListing(listingId: number): DriverChip[] {
    const r = rows?.find((x) => x.listing_id === listingId);
    if (!r) return [];
    const name = r.matched_driver_name ?? r.auto_driver_name;
    if (!name) return [];
    const local = localDrivers.find(
      (d) => d.name.toLowerCase() === name.toLowerCase(),
    );
    if (local) return [{ id: local.id, name: local.name }];
    if (name === r.auto_driver_name && r.auto_driver_id !== null)
      return [{ id: r.auto_driver_id, name }];
    return [{ id: null, name }];
  }

  // Driver keys (local ids + lower-cased names) across the current
  // selection, used to float matching groups to the top of the bulk
  // "Add to group" menu.
  const selectedDriverKeys = useMemo(() => {
    const ids = new Set<number>();
    const names = new Set<string>();
    if (!filteredRows) return { ids, names };
    for (const r of filteredRows) {
      if (!selectedIds.has(r.listing_id)) continue;
      if (r.auto_driver_id !== null) ids.add(r.auto_driver_id);
      if (r.matched_driver_name) names.add(r.matched_driver_name.toLowerCase());
      if (r.auto_driver_name) names.add(r.auto_driver_name.toLowerCase());
    }
    return { ids, names };
  }, [filteredRows, selectedIds]);

  const unmatchedCount = useMemo(
    () => (rows ? rows.filter((r) => r.registry_entry_id === null).length : 0),
    [rows],
  );

  return (
    <div className="p-6 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <h2 className="text-2xl font-semibold">Saved Listings</h2>
          {rows && rows.length > 0 && (
            <span className="text-sm text-fg-subtle whitespace-nowrap">
              {rows.length} listing{rows.length === 1 ? "" : "s"}
              {unmatchedCount > 0 ? ` · ${unmatchedCount} unmatched` : ""}
            </span>
          )}
        </div>
      </header>

      {actionSummary && (
        <div className="text-xs text-emerald-400">{actionSummary}</div>
      )}
      {error && <ErrorBanner error={error} />}

      {rows === null ? (
        // A failed load leaves this null forever; the error banner above
        // is the state, not "still loading".
        error ? null : (
          <div className="card text-sm text-fg-muted">Loading…</div>
        )
      ) : rows.length === 0 ? (
        <div className="card text-sm text-fg-muted flex flex-wrap items-center justify-between gap-3">
          <span>
            No listings tracked yet. Sync your eBay watchlist to pull in
            listings.
          </span>
          <button
            className="btn-secondary !px-2.5 !py-1 !text-xs"
            type="button"
            onClick={onSyncWatchlist}
            disabled={syncingWatchlist}
            title="Pull watchlist from your connected eBay account"
          >
            {syncingWatchlist ? "Syncing…" : "Sync watchlist"}
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-4">
            {filtersCollapsed ? (
              <button
                type="button"
                className="shrink-0 sticky top-4 card !p-2 flex flex-col items-center gap-1.5 text-fg-muted hover:text-fg"
                onClick={() => setFiltersCollapsed(false)}
                title="Show filters"
                aria-label="Show filters"
                aria-expanded={false}
              >
                <PanelChevronIcon direction="right" />
                {activeFilterCount > 0 && (
                  <span
                    className="rounded-full bg-accent/15 text-accent text-[10px] font-medium px-1.5 py-0.5 tabular-nums"
                    title={`${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"} active`}
                  >
                    {activeFilterCount}
                  </span>
                )}
              </button>
            ) : (
              // A flex column capped at the scrollport, not a stack that
              // grows without bound (DCH-47). Sticky positioning pins the top
              // edge, so any height past the fold is height nobody can ever
              // scroll to — which is why the search box and Clear filters sit
              // *outside* the scrolling middle rather than at either end of
              // one long list.
              <aside
                ref={setPanelEl}
                className="w-52 shrink-0 card !p-0 sticky top-4 flex flex-col overflow-hidden"
                style={{ maxHeight: `${panelMaxHeight}px` }}
              >
                <div className="shrink-0 px-3 pt-3 pb-2 space-y-2">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[10px] uppercase tracking-wide text-fg-subtle">
                      Filters
                    </span>
                    <button
                      type="button"
                      className="text-fg-subtle hover:text-fg"
                      onClick={() => setFiltersCollapsed(true)}
                      title="Hide filters"
                      aria-label="Hide filters"
                      aria-expanded={true}
                    >
                      <PanelChevronIcon direction="left" />
                    </button>
                  </div>
                  <input
                    type="text"
                    className="input !py-1 !text-xs"
                    placeholder="Search title, driver, scheme, seller…"
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                  />
                </div>

                {/* The sections scroll here, and this element is both the
                    flex item and the scroller. Splitting those in two — a
                    `flex-1` box with an `h-full` scroller inside — looks
                    tidier and silently doesn't work: the outer box has no
                    specified height, so the inner percentage height is
                    indefinite and collapses to the content's own height,
                    producing a scroller exactly as tall as its contents. */}
                <div
                  ref={setPanelScrollEl}
                  className="flex-1 min-h-0 overflow-y-auto px-3 py-1"
                >
                  {/* Scroll shadows, pinned to the scrollport with `sticky`
                      and pulled back out of the flow with a negative margin
                      so they overlay the content rather than spacing it.
                      Hidden (not unmounted) for an edge with nothing past
                      it: a fade that is always on dims content that isn't
                      cut, and a scroller with no fade at all is why nobody
                      notices it scrolls. */}
                  <div
                    aria-hidden="true"
                    className={`sticky top-0 z-30 -mx-3 -mb-4 h-4 pointer-events-none bg-gradient-to-b from-bg-panel to-transparent ${
                      panelEdges.atTop ? "invisible" : ""
                    }`}
                  />
                  <div className="space-y-2">
                    <FacetList
                      facet={facetSection(LISTING_FACETS, "status")}
                      selected={statusFilter}
                      options={statusFacetOptions}
                      onToggle={(v) =>
                        setStatusFilter((prev) =>
                          toggled(prev, v as StatusOption),
                        )
                      }
                    />
                    <FacetList
                      facet={facetSection(LISTING_FACETS, "match")}
                      selected={matchFilter}
                      options={matchFacetOptions}
                      onToggle={(v) =>
                        setMatchFilter((prev) =>
                          toggled(prev, v as MatchOption),
                        )
                      }
                    />
                    <FacetList
                      facet={facetSection(LISTING_FACETS, "offer")}
                      selected={offerFilter}
                      options={offerFacetOptions}
                      onToggle={(v) =>
                        setOfferFilter((prev) =>
                          toggled(prev, v as OfferOption),
                        )
                      }
                    />
                    <FacetList
                      facet={facetSection(LISTING_FACETS, "type")}
                      selected={typeFilter}
                      options={typeFacetOptions}
                      onToggle={(v) =>
                        setTypeFilter((prev) => toggled(prev, v as TypeOption))
                      }
                    />
                    <ControlSection
                      sectionKey="driver"
                      summary={{
                        text: driverFilterLabel,
                        active: driverFilter !== "all",
                      }}
                    >
                      <DriverFilterSelect
                        value={driverFilter}
                        label={driverFilterLabel}
                        options={driverOptions.options}
                        allCount={driverOptions.allCount}
                        noneCount={driverOptions.noneCount}
                        onChange={setDriverFilter}
                      />
                    </ControlSection>
                    {/* One seller means filtering by it is a no-op. The
                          second clause keeps the control on screen when a
                          selection is still narrowing — a filter you can't
                          see is the thing DCH-35 forbids. */}
                    {(sellerFilterOptions.length > 1 ||
                      sellerFilter.size > 0) && (
                      <ControlSection
                        sectionKey="seller"
                        summary={{
                          text: sellerFilterLabel(
                            sellerFilter,
                            sellerFilterOptions,
                          ),
                          active: sellerFilter.size > 0,
                        }}
                      >
                        <SellerFilterSelect
                          options={sellerFilterOptions}
                          selected={sellerFilter}
                          onToggle={(key) =>
                            setSellerFilter((prev) => toggled(prev, key))
                          }
                          onClear={() => setSellerFilter(new Set())}
                        />
                      </ControlSection>
                    )}
                    {yearFilterOptions.length > 0 && (
                      <ControlSection
                        sectionKey="year"
                        summary={yearSummary(yearFilter)}
                      >
                        <YearRangeFilter
                          id="listings-year"
                          years={yearFilterOptions}
                          value={yearFilter}
                          onChange={setYearFilter}
                          compact
                        />
                      </ControlSection>
                    )}
                    <ControlSection
                      sectionKey="group"
                      summary={groupSummary(
                        groupFilter,
                        groupFilterName,
                        excludedGroupIds.size,
                      )}
                    >
                      <select
                        className="input !py-1 !text-xs"
                        value={groupFilter}
                        onChange={(e) => setGroupFilter(e.target.value)}
                        title="Filter listings by group membership"
                      >
                        <option value="all">All</option>
                        <option value="none">Ungrouped</option>
                        {(() => {
                          const { drivers, noDriver, archived } =
                            clusterGroupsByDriver(groups);
                          return (
                            <>
                              {drivers.map((d) => (
                                <optgroup key={`d-${d.id}`} label={d.name}>
                                  {d.groups.map((g) => (
                                    <option
                                      key={`${d.id}-${g.id}`}
                                      value={String(g.id)}
                                    >
                                      {g.name} ({g.member_count})
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                              {noDriver.length > 0 && (
                                <optgroup label="Other (no driver)">
                                  {noDriver.map((g) => (
                                    <option key={g.id} value={String(g.id)}>
                                      {g.name} ({g.member_count})
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                              {archived.length > 0 && (
                                <optgroup label="Archived">
                                  {archived.map((g) => (
                                    <option key={g.id} value={String(g.id)}>
                                      {g.name} ({g.member_count})
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                            </>
                          );
                        })()}
                      </select>
                      <div className="mt-1.5">
                        <ExcludeGroupsMenu
                          groups={groups}
                          excluded={excludedGroupIds}
                          onToggle={(id) =>
                            setExcludedGroupIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(id)) next.delete(id);
                              else next.add(id);
                              return next;
                            })
                          }
                          onClear={() => setExcludedGroupIds(new Set())}
                        />
                      </div>
                    </ControlSection>
                  </div>
                  <div
                    aria-hidden="true"
                    className={`sticky bottom-0 z-30 -mx-3 -mt-4 h-4 pointer-events-none bg-gradient-to-t from-bg-panel to-transparent ${
                      panelEdges.atBottom ? "invisible" : ""
                    }`}
                  />
                </div>

                {/* Pinned below the scroll region, not at the end of it: the
                    foot of a too-tall panel is the part that falls off, and
                    the way out of an over-narrowed list is the last control
                    that should be unreachable. Hidden rather than disabled
                    when nothing is set, per DCH-35. */}
                {activeFilterCount > 0 && (
                  <div className="shrink-0 flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                    <span
                      className="rounded-full bg-accent/15 text-accent text-[10px] font-medium px-1.5 py-0.5 tabular-nums"
                      title={`${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"} active`}
                    >
                      {activeFilterCount}
                    </span>
                    <ClearFiltersButton onClear={clearAllFilters} />
                  </div>
                )}
              </aside>
            )}

            <div className="flex-1 min-w-0 space-y-2">
              {/* Toolbar: view + sort on the left, page actions on the right */}
              <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="inline-flex rounded-md border border-border overflow-hidden">
                    {(
                      [
                        { value: "flat", label: "Flat" },
                        { value: "byDriver", label: "By driver" },
                        { value: "byGroup", label: "By group" },
                      ] as { value: ViewMode; label: string }[]
                    ).map((opt, i) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`px-3 py-1 ${
                          i > 0 ? "border-l border-border" : ""
                        } ${
                          viewMode === opt.value
                            ? "bg-accent/15 text-accent"
                            : "text-fg-muted hover:text-fg hover:bg-bg-elevated"
                        }`}
                        onClick={() => setViewMode(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-fg-subtle">Sort:</span>
                    <select
                      className="input !w-auto !py-0.5 !text-[11px]"
                      value={sortMode}
                      onChange={(e) => setSortMode(e.target.value as SortMode)}
                      title="Sort listings"
                    >
                      <option value="seen-desc">
                        Last seen newest → oldest
                      </option>
                      <option value="price-asc">Price low → high</option>
                      <option value="price-desc">Price high → low</option>
                      <option value="total-asc">
                        Total (price + ship) low → high
                      </option>
                      <option value="deal-asc">Deal score low → high</option>
                      <option value="ending-asc">
                        Ending soonest → latest
                      </option>
                      <option value="title-asc">Title A → Z</option>
                    </select>
                  </div>
                  {viewMode !== "flat" && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-fg-subtle">
                        {viewMode === "byGroup" ? "Groups" : "Drivers"}:
                      </span>
                      <select
                        className="input !w-auto !py-0.5 !text-[11px]"
                        value={bucketSort}
                        onChange={(e) =>
                          setBucketSort(e.target.value as BucketSort)
                        }
                        title={`Order ${viewMode === "byGroup" ? "groups" : "drivers"} by`}
                      >
                        <option value="name-asc">Name A → Z</option>
                        <option value="count-desc">
                          Listing count high → low
                        </option>
                        <option value="count-asc">
                          Listing count low → high
                        </option>
                      </select>
                    </div>
                  )}
                  <ImageSizeToggle size={imgSize} onChange={setImgSize} />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    className="btn-secondary !px-2.5 !py-1 !text-xs"
                    type="button"
                    onClick={onSyncWatchlist}
                    disabled={syncingWatchlist}
                    title="Pull watchlist from your connected eBay account"
                  >
                    {syncingWatchlist ? "Syncing…" : "Sync watchlist"}
                  </button>
                  <ListingActionsMenu
                    hasListings={rows.length > 0}
                    autoMatching={autoMatchingAll}
                    refreshing={bulkRefreshing}
                    onAutoMatchAll={onAutoMatchAll}
                    onRefreshAll={onRefreshAll}
                    onManageGroups={() => setManageGroupsOpen(true)}
                  />
                </div>
              </div>

              {/* Select mode */}
              <div className="flex items-center gap-3 border-b border-border pb-2 text-xs">
                <button
                  type="button"
                  role="switch"
                  aria-checked={selectMode}
                  className="flex items-center gap-2"
                  onClick={() => {
                    if (selectMode) exitSelectMode();
                    else setSelectMode(true);
                  }}
                  title="Pick multiple listings to bulk-add to a group"
                >
                  <span
                    className={`relative inline-block h-4 w-8 rounded-full transition-colors ${
                      selectMode ? "bg-accent" : "bg-border"
                    }`}
                  >
                    <span
                      className={`absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                        selectMode ? "translate-x-[18px]" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                  <span
                    className={selectMode ? "text-accent" : "text-fg-muted"}
                  >
                    Select mode
                  </span>
                </button>
              </div>

              <div className="flex items-center justify-between gap-3 text-xs">
                <div className="text-fg-subtle">
                  {filteredRows && filteredRows.length !== rows.length
                    ? `Showing ${filteredRows.length} of ${rows.length} listings.`
                    : ""}
                </div>
                <button
                  type="button"
                  className="text-fg-muted hover:text-fg underline decoration-dotted underline-offset-2 disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
                  disabled={viewMode === "flat"}
                  onClick={() =>
                    setCollapseCmd((c) => ({
                      seq: c.seq + 1,
                      collapse: !allCollapsed,
                    }))
                  }
                  title={
                    viewMode === "flat"
                      ? "Sections only exist in the grouped views"
                      : allCollapsed
                        ? "Expand every section"
                        : "Collapse every section"
                  }
                >
                  {allCollapsed ? "Expand all" : "Collapse all"}
                </button>
              </div>

              {filteredRows && filteredRows.length === 0 ? (
                <FilteredEmpty onClear={clearAllFilters} noun="listings" />
              ) : viewMode === "flat" ? (
                <ul className="space-y-2">
                  {(filteredRows ?? []).map((r) => (
                    <ListingCard
                      key={r.listing_id}
                      row={r}
                      groups={groups}
                      offer={offersByItemId.get(
                        legacyIdFromExternalId(r.external_id),
                      )}
                      refreshing={refreshingId === r.listing_id}
                      unwatching={unwatchingId === r.listing_id}
                      onRefresh={() => onRefreshOne(r.listing_id)}
                      onUnwatch={() => onUnwatch(r)}
                      onClearMatch={() => onClearMatch(r.listing_id)}
                      onRejectMatch={() => onRejectMatch(r.listing_id)}
                      onConfirmMatch={() => onConfirmMatch(r.listing_id)}
                      onChangeMatch={() => setRegistrySearchListing(r)}
                      autoMatching={autoMatchingId === r.listing_id}
                      autoMatchNote={autoMatchNotes.get(r.listing_id)}
                      onAutoMatch={() => onAutoMatchOne(r.listing_id)}
                      onAddToGroup={(gid) =>
                        onAddListingToGroup(r.listing_id, gid)
                      }
                      onCreateGroup={() =>
                        setCreateGroupForListingId(r.listing_id)
                      }
                      onRemoveFromGroup={(gid) =>
                        onRemoveListingFromGroup(r.listing_id, gid)
                      }
                      localDrivers={localDrivers}
                      tagDriverOpen={tagDriverId === r.listing_id}
                      onOpenTagDriver={() => setTagDriverId(r.listing_id)}
                      onCancelTagDriver={() => setTagDriverId(null)}
                      onSetDriver={(name, normalized) =>
                        onSetDriver(r.listing_id, name, normalized)
                      }
                      onClearDriver={() => onClearDriver(r.listing_id)}
                      onResetDriver={() => onResetDriver(r.listing_id)}
                      onSetAttributes={(attrs) =>
                        onSetAttributes(r.listing_id, attrs)
                      }
                      onResetAttributes={() => onResetAttributes(r.listing_id)}
                      selectMode={selectMode}
                      selected={selectedIds.has(r.listing_id)}
                      onToggleSelect={() => toggleSelected(r.listing_id)}
                      imgSizeClass={IMG_CLASS[imgSize]}
                    />
                  ))}
                </ul>
              ) : viewMode === "byGroup" ? (
                <GroupedByGroup
                  rows={filteredRows ?? []}
                  groups={groups}
                  bucketSort={bucketSort}
                  collapseCommand={collapseCmd}
                  onAllCollapsedChange={setAllCollapsed}
                  offersByItemId={offersByItemId}
                  refreshingId={refreshingId}
                  unwatchingId={unwatchingId}
                  onRefresh={onRefreshOne}
                  onUnwatch={onUnwatch}
                  onClearMatch={onClearMatch}
                  onRejectMatch={onRejectMatch}
                  onConfirmMatch={onConfirmMatch}
                  onChangeMatch={setRegistrySearchListing}
                  autoMatchingId={autoMatchingId}
                  autoMatchNotes={autoMatchNotes}
                  onAutoMatch={onAutoMatchOne}
                  onAddToGroup={onAddListingToGroup}
                  onCreateGroup={setCreateGroupForListingId}
                  onRemoveFromGroup={onRemoveListingFromGroup}
                  localDrivers={localDrivers}
                  tagDriverId={tagDriverId}
                  onOpenTagDriver={setTagDriverId}
                  onCancelTagDriver={() => setTagDriverId(null)}
                  onSetDriver={onSetDriver}
                  onClearDriver={onClearDriver}
                  onResetDriver={onResetDriver}
                  onSetAttributes={onSetAttributes}
                  onResetAttributes={onResetAttributes}
                  selectMode={selectMode}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelected}
                  imgSizeClass={IMG_CLASS[imgSize]}
                />
              ) : (
                <GroupedByDriver
                  rows={filteredRows ?? []}
                  groups={groups}
                  bucketSort={bucketSort}
                  collapseCommand={collapseCmd}
                  onAllCollapsedChange={setAllCollapsed}
                  offersByItemId={offersByItemId}
                  refreshingId={refreshingId}
                  unwatchingId={unwatchingId}
                  onRefresh={onRefreshOne}
                  onUnwatch={onUnwatch}
                  onClearMatch={onClearMatch}
                  onRejectMatch={onRejectMatch}
                  onConfirmMatch={onConfirmMatch}
                  onChangeMatch={setRegistrySearchListing}
                  autoMatchingId={autoMatchingId}
                  autoMatchNotes={autoMatchNotes}
                  onAutoMatch={onAutoMatchOne}
                  onAddToGroup={onAddListingToGroup}
                  onCreateGroup={setCreateGroupForListingId}
                  onRemoveFromGroup={onRemoveListingFromGroup}
                  localDrivers={localDrivers}
                  tagDriverId={tagDriverId}
                  onOpenTagDriver={setTagDriverId}
                  onCancelTagDriver={() => setTagDriverId(null)}
                  onSetDriver={onSetDriver}
                  onClearDriver={onClearDriver}
                  onResetDriver={onResetDriver}
                  onSetAttributes={onSetAttributes}
                  onResetAttributes={onResetAttributes}
                  selectMode={selectMode}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelected}
                  imgSizeClass={IMG_CLASS[imgSize]}
                />
              )}
            </div>
          </div>
        </>
      )}

      {selectMode && (
        <BulkSelectionBar
          selectedCount={selectedIds.size}
          visibleCount={filteredRows?.length ?? 0}
          groups={groups}
          selectedDriverKeys={selectedDriverKeys}
          busy={bulkBusy}
          notice={bulkNotice}
          onSelectAllVisible={() => {
            setSelectedIds(
              new Set((filteredRows ?? []).map((r) => r.listing_id)),
            );
          }}
          onClear={clearSelection}
          onDone={exitSelectMode}
          onAddToGroup={onBulkAddToGroup}
          onCreateGroup={() => setBulkCreateGroupOpen(true)}
          onRemoveFromGroup={onBulkRemoveFromGroup}
          onAddToWishlist={() => setBulkWishlistOpen(true)}
          onShareSelection={() => setBulkShareOpen(true)}
        />
      )}

      {bulkWishlistOpen && (
        <WishlistPickerDialog
          selectedCount={selectedIds.size}
          onPick={onBulkAddToWishlist}
          onClose={() => setBulkWishlistOpen(false)}
        />
      )}

      {bulkShareOpen && (
        <ShareListingsDialog
          listingIds={Array.from(selectedIds)}
          configured={shareConfigured}
          onClose={() => setBulkShareOpen(false)}
        />
      )}

      {bulkCreateGroupOpen && (
        <GroupEditorDialog
          initial={null}
          onCancel={() => setBulkCreateGroupOpen(false)}
          onSaved={async (created) => {
            if (created) await onBulkCreatedGroup(created);
            else setBulkCreateGroupOpen(false);
          }}
        />
      )}

      {manageGroupsOpen && (
        <ManageGroupsDialog
          groups={groups}
          onClose={() => setManageGroupsOpen(false)}
          onChanged={async () => {
            await Promise.all([load(), loadGroups()]);
          }}
        />
      )}

      {createGroupForListingId !== null && (
        <GroupEditorDialog
          initial={null}
          prefillDrivers={prefillDriversForListing(createGroupForListingId)}
          onCancel={() => setCreateGroupForListingId(null)}
          onSaved={async (created) => {
            if (created)
              await onCreatedGroupForListing(createGroupForListingId, created);
            else setCreateGroupForListingId(null);
          }}
        />
      )}

      {registrySearchListing && (
        <RegistrySearchDialog
          listing={registrySearchListing}
          onClose={() => setRegistrySearchListing(null)}
          onLinked={async () => {
            setRegistrySearchListing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function ListingCard({
  row,
  groups,
  offer,
  refreshing,
  unwatching,
  onRefresh,
  onUnwatch,
  onClearMatch,
  onRejectMatch,
  onConfirmMatch,
  onChangeMatch,
  autoMatching,
  autoMatchNote,
  onAutoMatch,
  onAddToGroup,
  onCreateGroup,
  onRemoveFromGroup,
  localDrivers,
  tagDriverOpen,
  onOpenTagDriver,
  onCancelTagDriver,
  onSetDriver,
  onClearDriver,
  onResetDriver,
  onSetAttributes,
  onResetAttributes,
  selectMode,
  selected,
  onToggleSelect,
  imgSizeClass,
}: {
  row: ListingRow;
  groups: ListingGroup[];
  offer: ReceivedOffer | undefined;
  refreshing: boolean;
  unwatching: boolean;
  onRefresh: () => void;
  onUnwatch: () => void;
  onClearMatch: () => void;
  onRejectMatch: () => void;
  onConfirmMatch: () => void;
  onChangeMatch: () => void;
  autoMatching: boolean;
  autoMatchNote: string | undefined;
  onAutoMatch: () => void;
  onAddToGroup: (groupId: number) => void;
  onCreateGroup: () => void;
  onRemoveFromGroup: (groupId: number) => void;
  localDrivers: DriverOption[];
  tagDriverOpen: boolean;
  onOpenTagDriver: () => void;
  onCancelTagDriver: () => void;
  onSetDriver: (name: string, normalized: string) => void;
  onClearDriver: () => void;
  onResetDriver: () => void;
  onSetAttributes: (attrs: ListingAttributes) => void;
  onResetAttributes: () => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  imgSizeClass: string;
}) {
  const total =
    row.price_cents !== null
      ? row.price_cents + (row.shipping_cents ?? 0)
      : null;
  const ended = row.status === "ended";
  const matched = row.registry_entry_id !== null;
  // Collapsed by default (DCH-20). The list is a scan surface first: you
  // sweep it for a price worth attention, then open the one card. Rendering
  // every card fully expanded is what made the screen read as cluttered.
  const [minimized, toggleMinimized] = useMinimized(
    `listing:${row.listing_id}`,
    true,
  );
  return (
    <li
      className={`card flex gap-4 ${minimized ? "!py-2" : ""} ${
        ended ? "opacity-60" : ""
      } ${selectMode && selected ? "ring-2 ring-accent/60" : ""}`}
    >
      {selectMode && (
        <label
          className="shrink-0 flex items-start pt-1 cursor-pointer"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            className="w-4 h-4 accent-accent"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={selected ? "Deselect listing" : "Select listing"}
          />
        </label>
      )}
      <MinimizeToggle
        minimized={minimized}
        onToggle={toggleMinimized}
        className="self-start -mt-0.5"
      />
      {!minimized && row.image_url && (
        <img
          src={row.image_url}
          alt=""
          loading="lazy"
          decoding="async"
          className={`${imgSizeClass} object-cover rounded border border-border shrink-0`}
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium truncate flex-1 min-w-0">
            {row.title}
          </div>
          {offer && <OfferBadge offer={offer} />}
        </div>
        {/* Always visible, collapsed or not: this is the line that makes a
            collapsed row scannable. Previously it was hidden when minimized,
            which left a collapsed card as a bare title and a number. */}
        <div className="text-xs text-fg-subtle mt-0.5">
          {[
            row.listing_type &&
              (row.accepts_offers
                ? `${row.listing_type} + offers`
                : row.listing_type),
            row.is_archived
              ? row.end_reason
                ? `archived · ${END_REASON_LABELS[row.end_reason] ?? row.end_reason}`
                : "archived"
              : ended
                ? "ended"
                : row.end_time
                  ? `ends ${formatUntil(row.end_time)}`
                  : null,
            row.condition,
            row.seller_username && `seller: ${row.seller_username}`,
            row.seller_rating !== null &&
              row.seller_rating !== undefined &&
              `${row.seller_rating}%`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>

        {minimized ? null : (
          <>
            <GroupChipRow
              row={row}
              groups={groups}
              onAddToGroup={onAddToGroup}
              onCreateGroup={onCreateGroup}
              onRemoveFromGroup={onRemoveFromGroup}
            />

            <SectionLabel>Match &amp; valuation</SectionLabel>
            {matched ? (
              <div className="rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  {row.match_user_confirmed ? (
                    <span className="text-emerald-400">✓ matched</span>
                  ) : (
                    <span
                      className="text-sky-400"
                      title="Suggested automatically — confirm it or pick a different entry"
                    >
                      ≈ auto-match
                    </span>
                  )}
                  {!row.match_user_confirmed &&
                    row.match_confidence !== null && (
                      <ConfidenceBadge
                        value={row.match_confidence}
                        reasons={row.match_reasons}
                      />
                    )}
                  <span className="text-fg-muted truncate">
                    {row.matched_driver_name}
                    {row.matched_scheme_text
                      ? ` — ${row.matched_scheme_text}`
                      : ""}
                  </span>
                </div>
                <div className="text-fg-subtle mt-0.5">
                  {[
                    row.matched_year,
                    row.matched_oem,
                    row.matched_brand,
                    row.matched_scale,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
                  {row.matched_detail_url && (
                    <a
                      className="text-accent hover:underline inline-block"
                      href={
                        "https://www.diecastregistry.com" +
                        row.matched_detail_url
                      }
                      onClick={(e) => {
                        e.preventDefault();
                        void openExternal(
                          "https://www.diecastregistry.com" +
                            row.matched_detail_url,
                        );
                      }}
                    >
                      View on diecastregistry.com →
                    </a>
                  )}
                  {!row.match_user_confirmed && (
                    <>
                      <button
                        className="text-emerald-400 hover:text-emerald-300"
                        type="button"
                        onClick={onConfirmMatch}
                        title="Lock this in as the right registry entry"
                      >
                        Confirm
                      </button>
                      <button
                        className="link-danger"
                        type="button"
                        onClick={onRejectMatch}
                        title="Wrong entry — drop it and stop auto-matching this listing"
                      >
                        Not it
                      </button>
                    </>
                  )}
                  {!row.match_user_confirmed && (
                    <button
                      className="text-fg-muted hover:text-fg"
                      type="button"
                      onClick={onAutoMatch}
                      disabled={autoMatching}
                      title="Re-run auto-matching — useful after correcting attributes; replaces or clears the current suggestion"
                    >
                      {autoMatching ? "Matching…" : "Re-match"}
                    </button>
                  )}
                  <button
                    className="text-fg-muted hover:text-fg"
                    type="button"
                    onClick={onChangeMatch}
                    title="Search the diecastregistry.com catalog and link a result to this listing"
                  >
                    Change match…
                  </button>
                  <button
                    className="text-fg-subtle hover:text-fg-muted"
                    type="button"
                    onClick={onClearMatch}
                    title="Remove the link to the registry entry"
                  >
                    Clear
                  </button>
                </div>
              </div>
            ) : row.match_user_confirmed ? (
              <div className="rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-xs">
                <div className="text-fg-subtle">Marked as no-match.</div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
                  <button
                    className="text-fg-muted hover:text-fg"
                    type="button"
                    onClick={onChangeMatch}
                    title="Search the diecastregistry.com catalog and link a result to this listing"
                  >
                    Match…
                  </button>
                  <button
                    className="text-fg-subtle hover:text-fg-muted"
                    type="button"
                    onClick={onClearMatch}
                    title="Clear the no-match flag"
                  >
                    Reset
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs">
                <div className="text-amber-400/80">
                  Unmatched — link a registry entry to enable retail comparison.
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
                  <button
                    className="text-fg-muted hover:text-fg"
                    type="button"
                    onClick={onAutoMatch}
                    disabled={autoMatching}
                    title="Search the registry for a best-effort match (pulls the driver's entries from diecastregistry.com if needed)"
                  >
                    {autoMatching ? "Matching…" : "Auto-match"}
                  </button>
                  <button
                    className="text-fg-muted hover:text-fg"
                    type="button"
                    onClick={onChangeMatch}
                    title="Search the diecastregistry.com catalog and link a result to this listing"
                  >
                    Match…
                  </button>
                  <button
                    className="text-fg-subtle hover:text-fg-muted"
                    type="button"
                    onClick={onRejectMatch}
                    title="Mark as having no match in your registry"
                  >
                    Mark no-match
                  </button>
                </div>
              </div>
            )}
            {autoMatchNote && !matched && (
              <div className="mt-1 text-xs text-fg-subtle">
                Auto-match: {autoMatchNote}
              </div>
            )}

            <SectionLabel>Details</SectionLabel>
            <DriverTagSection
              row={row}
              localDrivers={localDrivers}
              open={tagDriverOpen}
              onOpen={onOpenTagDriver}
              onCancel={onCancelTagDriver}
              onSet={onSetDriver}
              onClear={onClearDriver}
              onReset={onResetDriver}
            />

            <AttributesSection
              row={row}
              onSave={onSetAttributes}
              onReset={onResetAttributes}
            />

            {/* Actions, separated from the match controls above. Only the
                three that act on the *listing* live here; everything that
                acts on the match now sits inside the match block, which is
                where you were already looking. */}
            <SectionLabel>Actions</SectionLabel>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <a
                className="text-xs text-accent hover:underline"
                href={row.url}
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(row.url);
                }}
              >
                View on eBay →
              </a>
              <button
                className="text-xs text-fg-muted hover:text-fg"
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
              >
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
              {row.seller_code === "ebay" && (
                <button
                  className="link-danger text-xs"
                  type="button"
                  onClick={onUnwatch}
                  disabled={unwatching}
                  title="Remove from your eBay watchlist and delete this local row"
                >
                  {unwatching ? "Removing…" : "Remove from watchlist"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="text-right text-xs tabular-nums shrink-0 space-y-0.5">
        <div className="flex items-center justify-end gap-2">
          {/* Real sales outrank a catalog value, so the badge shows the comp
              score whenever the archive has enough of them and falls back to
              retail otherwise. Both references stay visible as text below. */}
          {row.comp_score !== null ? (
            <DealBadge score={row.comp_score} basis="sold" comps={row.comps} />
          ) : (
            row.deal_score !== null && (
              <DealBadge score={row.deal_score} basis="retail" />
            )
          )}
          <div>
            <div className="text-base text-fg leading-none">
              {formatCents(total)}
            </div>
            {/* Labelled, because this is the number the whole screen turns
                on and it was previously bare — a reader had to know that the
                big figure meant price *plus shipping*. */}
            <div className="text-[10px] text-fg-faint uppercase tracking-wide">
              delivered
            </div>
          </div>
        </div>
        {!minimized &&
          row.shipping_cents !== null &&
          row.shipping_cents > 0 && (
            <div className="text-fg-subtle mt-1">
              {formatCents(row.price_cents)} + {formatCents(row.shipping_cents)}{" "}
              ship
            </div>
          )}
        {!minimized && matched && (
          <div className="text-fg-subtle mt-1">
            retail {formatCents(row.matched_retail_cents)}
          </div>
        )}
        {!minimized && row.comps !== null && (
          <div
            className="text-fg-subtle"
            title={
              `${row.comps.count} archived ${row.comps.tier === "exact" ? "sales of this car" : "sales of this driver at this scale"}, ` +
              `${formatAgo(row.comps.oldest_sold_at)} to ${formatAgo(row.comps.newest_sold_at)}. ` +
              `Median ${formatCents(row.comps.median_cents)}. Delivered cost, from listings you watched.`
            }
          >
            sold {formatCents(row.comps.low_cents)}–
            {formatCents(row.comps.high_cents)} ·{" "}
            {row.comps.count === 1 ? "1 sale" : `${row.comps.count} sales`}
            {row.comps.tier === "similar" && "*"}
          </div>
        )}
      </div>
    </li>
  );
}

/** The rule + caption that separates a card's groups (DCH-20). The expanded
 *  card was seven flat rows of unrelated concerns; the labels are what turn
 *  it into "facts, then match, then details, then actions". Deliberately
 *  quiet — this is scaffolding, not content. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 mb-1 flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide text-fg-faint shrink-0">
        {children}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Confidence pill for an auto-match. Hover shows the signals that drove
 *  the score (e.g. "production run of 5004 in title"). */
function ConfidenceBadge({
  value,
  reasons,
}: {
  value: number;
  reasons: string[];
}) {
  let cls = "text-orange-400 border-orange-500/30 bg-orange-500/10";
  if (value >= 80) {
    cls = "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
  } else if (value >= 65) {
    cls = "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
  }
  const tooltip =
    reasons.length > 0
      ? `Why this match:\n• ${reasons.join("\n• ")}`
      : "Auto-match confidence";
  return (
    <span
      className={`px-1.5 py-0.5 rounded border tabular-nums shrink-0 ${cls}`}
      title={tooltip}
    >
      {value.toFixed(0)}%
    </span>
  );
}

/** Price verdict for a listing, as a percentage of a reference price.
 *
 *  Two references exist and they are not equally good. `retail` is the
 *  registry's list value — always available for a matched listing, but a
 *  catalog number rather than evidence of what anyone paid. `sold` is the
 *  median of comparable sales from our own archive, which is what the market
 *  actually did — so the caller prefers it whenever there are enough sales,
 *  and the badge names its basis so the two are never confused at a glance. */
function DealBadge({
  score,
  basis,
  comps,
}: {
  score: number;
  basis: "retail" | "sold";
  comps?: CompSummary | null;
}) {
  // < 70%  → great deal (green)
  // 70-90% → fair (yellow)
  // 90-110% → at the reference price (slate)
  // > 110% → over it (red)
  let cls = "text-fg-muted border-border";
  let label = basis === "sold" ? "at market" : "at retail";
  if (score < 70) {
    cls = "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
    label = "great deal";
  } else if (score < 90) {
    cls = "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
    label = "fair";
  } else if (score > 110) {
    cls = "text-red-400 border-red-500/30 bg-red-500/10";
    label = basis === "sold" ? "over market" : "over retail";
  }
  const tooltip =
    basis === "sold" && comps
      ? `${score.toFixed(0)}% of the ${formatCents(comps.median_cents)} median ` +
        `from ${comps.count} ${comps.tier === "exact" ? "sales of this car" : "sales of this driver at this scale"}` +
        ` (${formatCents(comps.low_cents)}–${formatCents(comps.high_cents)}, ` +
        `newest ${formatAgo(comps.newest_sold_at)}) — ${label}`
      : `${score.toFixed(0)}% of registry retail (${label})`;
  return (
    <div
      className={`inline-flex flex-col items-end px-1.5 py-0.5 rounded border ${cls}`}
      title={tooltip}
    >
      {/* "of sold" alone didn't say sold *what*; the median is the
          reference the percentage is actually against. */}
      <span className="font-medium">
        {score.toFixed(0)}% of {basis === "sold" ? "sold median" : "retail"}
      </span>
      <span className="text-[10px] uppercase tracking-wide opacity-80">
        {label}
      </span>
    </div>
  );
}

/** Lower-case + collapse non-alphanumeric runs to single hyphens. Matches
 *  the convention used in the local `drivers` table (e.g. "Dale Earnhardt
 *  Jr." → "dale-earnhardt-jr"). The Rust side doesn't actually care about
 *  the exact format — it just uses normalized as a unique key — but
 *  consistency makes the local autocomplete + DCR form-options
 *  interoperate cleanly. */
function normalizeDriverName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function DriverTagSection({
  row,
  localDrivers,
  open,
  onOpen,
  onCancel,
  onSet,
  onClear,
  onReset,
}: {
  row: ListingRow;
  localDrivers: DriverOption[];
  open: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onSet: (name: string, normalized: string) => void;
  onClear: () => void;
  onReset: () => void;
}) {
  // Picker buffer. Seeded from whatever's currently tagged on the
  // listing each time the picker opens. Independent of the row's
  // committed value so cancel doesn't have side effects.
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (open) {
      setDraft(row.auto_driver_name ?? "");
    }
  }, [open, row.auto_driver_name]);

  const userSet = row.auto_driver_user_set;
  const hasDriver = row.auto_driver_name !== null;

  function submit(e: FormEvent) {
    e.preventDefault();
    const name = draft.trim();
    if (!name) {
      // Empty draft means "clear" — pin to no driver.
      onClear();
      return;
    }
    // If the typed name exactly matches a local driver, reuse its
    // canonical normalized form (so the same person tagged two
    // different ways still collapses to one row).
    const exact = localDrivers.find(
      (d) => d.name.toLowerCase() === name.toLowerCase(),
    );
    const normalized = exact?.normalized_name ?? normalizeDriverName(name);
    onSet(exact?.name ?? name, normalized);
  }

  if (!open) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {hasDriver ? (
          <span className="inline-flex items-center gap-1 rounded border border-border bg-bg-elevated px-1.5 py-0.5">
            <span className="text-fg-muted">Driver:</span>
            <span className="text-fg">{row.auto_driver_name}</span>
            {userSet ? (
              <span
                className="text-[10px] uppercase tracking-wide text-accent"
                title="You manually pinned this driver — auto-detection won't change it"
              >
                manual
              </span>
            ) : (
              <span
                className="text-[10px] uppercase tracking-wide text-fg-faint"
                title="Detected automatically from the listing title"
              >
                auto
              </span>
            )}
          </span>
        ) : userSet ? (
          <span className="text-fg-subtle">No driver (pinned).</span>
        ) : null}
        <button
          type="button"
          className="text-fg-muted hover:text-fg"
          onClick={onOpen}
          title="Manually tag this listing with a driver — independent of any registry match"
        >
          {hasDriver ? "Change driver…" : "Tag driver…"}
        </button>
        {userSet && (
          <button
            type="button"
            className="text-fg-subtle hover:text-fg-muted"
            onClick={onReset}
            title="Drop the manual pin and re-run auto-detection on the title"
          >
            Reset to auto
          </button>
        )}
      </div>
    );
  }

  const listId = `driver-options-${row.listing_id}`;
  return (
    <form onSubmit={submit} className="mt-1 flex items-center gap-1.5 text-xs">
      <input
        list={listId}
        type="text"
        autoFocus
        className="input !py-1 !text-xs flex-1 max-w-xs"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Driver name (e.g. Jeff Gordon)"
      />
      <datalist id={listId}>
        {localDrivers.map((d) => (
          <option key={d.id} value={d.name} />
        ))}
      </datalist>
      <button type="submit" className="text-emerald-400 hover:text-emerald-300">
        Save
      </button>
      <button
        type="button"
        className="text-fg-subtle hover:text-fg-muted"
        onClick={() => {
          onClear();
        }}
        title="Pin this listing to no driver — auto-detection won't try again"
      >
        No driver
      </button>
      <button
        type="button"
        className="text-fg-subtle hover:text-fg-muted"
        onClick={onCancel}
      >
        Cancel
      </button>
    </form>
  );
}

/** Listing-level attributes (oem / brand / finish / make + race-win and
 *  autograph flags) — chips when closed, an inline form when editing.
 *  Auto-filled from the title by the backend unless the user pinned them;
 *  independent of any registry match. */
function AttributesSection({
  row,
  onSave,
  onReset,
}: {
  row: ListingRow;
  onSave: (attrs: ListingAttributes) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Draft buffers, seeded from the row each time the editor opens so
  // cancel has no side effects.
  const [oem, setOem] = useState("");
  const [brand, setBrand] = useState("");
  const [finish, setFinish] = useState("");
  const [make, setMake] = useState("");
  const [raceWin, setRaceWin] = useState(false);
  const [autographed, setAutographed] = useState(false);
  const [prodCount, setProdCount] = useState("");
  const [options, setOptions] = useState<AttributeOptions>(
    EMPTY_ATTRIBUTE_OPTIONS,
  );

  function openEditor() {
    setOem(row.oem ?? "");
    setBrand(row.brand ?? "");
    setFinish(row.finish ?? "");
    setMake(row.make ?? "");
    setRaceWin(row.is_race_win);
    setAutographed(row.is_autographed);
    setProdCount(row.production_count?.toString() ?? "");
    setOpen(true);
    void loadAttributeOptions().then(setOptions);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setOpen(false);
    const pc = parseInt(prodCount.replace(/[^0-9]/g, ""), 10);
    onSave({
      oem: oem.trim() || null,
      brand: brand.trim() || null,
      finish: finish.trim() || null,
      make: make.trim() || null,
      is_race_win: raceWin,
      is_autographed: autographed,
      // 0 is valid: collector convention for prototypes/samples.
      production_count: Number.isFinite(pc) && pc >= 0 ? pc : null,
    });
  }

  const hasAny =
    row.oem !== null ||
    row.brand !== null ||
    row.finish !== null ||
    row.make !== null ||
    row.production_count !== null ||
    row.is_race_win ||
    row.is_autographed;

  if (!open) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {(
          [
            ["OEM", row.oem],
            ["Brand", row.brand],
            ["Make", row.make],
            ["Finish", row.finish],
          ] as const
        ).map(
          // Loose `!=` on purpose: catches undefined as well as null. A row
          // that reaches here missing the field entirely would otherwise
          // render a chip with a label and no value.
          ([label, value]) =>
            value != null && (
              <span
                key={label}
                className="inline-flex items-center gap-1 rounded border border-border bg-bg-elevated px-1.5 py-0.5"
              >
                <span className="text-fg-muted">{label}:</span>
                <span className="text-fg">{value}</span>
              </span>
            ),
        )}
        {row.production_count !== null && (
          <span
            className="inline-flex items-center gap-1 rounded border border-border bg-bg-elevated px-1.5 py-0.5"
            title="Production-run size from the tag photo — the matcher's strongest signal"
          >
            <span className="text-fg-muted">Run:</span>
            <span className="text-fg">
              {row.production_count === 0
                ? "0 (prototype)"
                : formatCount(row.production_count)}
            </span>
          </span>
        )}
        {row.is_race_win && (
          <span className="rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-amber-300">
            Race Win
          </span>
        )}
        {row.is_autographed && (
          <span className="rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-emerald-300">
            Autograph
          </span>
        )}
        {hasAny && (
          <span
            className={`text-[10px] uppercase tracking-wide ${
              row.attributes_user_set
                ? "text-accent"
                : row.attrs_from_match
                  ? "text-sky-400"
                  : "text-fg-faint"
            }`}
            title={
              row.attributes_user_set
                ? "You saved these manually — auto-detection won't change them"
                : row.attrs_from_match
                  ? "Copied from the confirmed registry match"
                  : "Detected automatically from the listing text"
            }
          >
            {row.attributes_user_set
              ? "manual"
              : row.attrs_from_match
                ? "from match"
                : "auto"}
          </span>
        )}
        <button
          type="button"
          className="text-fg-muted hover:text-fg"
          onClick={openEditor}
          title="Tag this listing with OEM / brand / make / finish and race-win or autograph flags"
        >
          {hasAny ? "Edit attributes…" : "Attributes…"}
        </button>
        {row.attributes_user_set && (
          <button
            type="button"
            className="text-fg-subtle hover:text-fg-muted"
            onClick={onReset}
            title="Drop the manual pin, clear the attributes, and re-run auto-detection on the title"
          >
            Reset to auto
          </button>
        )}
      </div>
    );
  }

  const idBase = `attrs-${row.listing_id}`;
  return (
    <form
      onSubmit={submit}
      className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs"
    >
      {(
        [
          ["oem", "OEM", oem, setOem, options.oems],
          ["brand", "Brand", brand, setBrand, options.brands],
          ["make", "Make", make, setMake, options.makes],
          ["finish", "Finish", finish, setFinish, options.finishes],
        ] as const
      ).map(([key, placeholder, value, setValue, opts]) => (
        <Fragment key={key}>
          <input
            list={`${idBase}-${key}`}
            type="text"
            className="input !py-1 !text-xs w-32"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
          />
          <datalist id={`${idBase}-${key}`}>
            {opts.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </Fragment>
      ))}
      <input
        type="text"
        inputMode="numeric"
        className="input !py-1 !text-xs w-24"
        value={prodCount}
        onChange={(e) => setProdCount(e.target.value)}
        placeholder="Run (1 of…)"
        title="Production-run size from the tag photo, e.g. 5004 — enter 0 for prototypes/samples"
      />
      <label className="inline-flex items-center gap-1 cursor-pointer">
        <input
          type="checkbox"
          className="w-3.5 h-3.5 accent-accent"
          checked={raceWin}
          onChange={(e) => setRaceWin(e.target.checked)}
        />
        Race Win
      </label>
      <label className="inline-flex items-center gap-1 cursor-pointer">
        <input
          type="checkbox"
          className="w-3.5 h-3.5 accent-accent"
          checked={autographed}
          onChange={(e) => setAutographed(e.target.checked)}
        />
        Autograph
      </label>
      <button type="submit" className="text-emerald-400 hover:text-emerald-300">
        Save
      </button>
      <button
        type="button"
        className="text-fg-subtle hover:text-fg-muted"
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
    </form>
  );
}

function GroupedByDriver({
  rows,
  groups,
  bucketSort,
  collapseCommand,
  onAllCollapsedChange,
  offersByItemId,
  refreshingId,
  unwatchingId,
  onRefresh,
  onUnwatch,
  onClearMatch,
  onRejectMatch,
  onConfirmMatch,
  onChangeMatch,
  autoMatchingId,
  autoMatchNotes,
  onAutoMatch,
  onAddToGroup,
  onCreateGroup,
  onRemoveFromGroup,
  localDrivers,
  tagDriverId,
  onOpenTagDriver,
  onCancelTagDriver,
  onSetDriver,
  onClearDriver,
  onResetDriver,
  onSetAttributes,
  onResetAttributes,
  selectMode,
  selectedIds,
  onToggleSelect,
  imgSizeClass,
}: {
  rows: ListingRow[];
  groups: ListingGroup[];
  bucketSort: BucketSort;
  collapseCommand: { seq: number; collapse: boolean };
  onAllCollapsedChange: (allCollapsed: boolean) => void;
  offersByItemId: Map<string, ReceivedOffer>;
  refreshingId: number | null;
  unwatchingId: number | null;
  onRefresh: (id: number) => void;
  onUnwatch: (row: ListingRow) => void;
  onClearMatch: (id: number) => void;
  onRejectMatch: (id: number) => void;
  onConfirmMatch: (id: number) => void;
  onChangeMatch: (row: ListingRow) => void;
  autoMatchingId: number | null;
  autoMatchNotes: Map<number, string>;
  onAutoMatch: (id: number) => void;
  onAddToGroup: (listingId: number, groupId: number) => void;
  onCreateGroup: (listingId: number) => void;
  onRemoveFromGroup: (listingId: number, groupId: number) => void;
  localDrivers: DriverOption[];
  tagDriverId: number | null;
  onOpenTagDriver: (id: number) => void;
  onCancelTagDriver: () => void;
  onSetDriver: (id: number, name: string, normalized: string) => void;
  onClearDriver: (id: number) => void;
  onResetDriver: (id: number) => void;
  onSetAttributes: (id: number, attrs: ListingAttributes) => void;
  onResetAttributes: (id: number) => void;
  selectMode: boolean;
  selectedIds: Set<number>;
  onToggleSelect: (listingId: number) => void;
  imgSizeClass: string;
}) {
  // Bucket by driver: prefer the registry-match driver (always present
  // when there's a manual link), fall back to the auto-associated driver
  // (populated from the title on every add/refresh), and only bucket as
  // "Unmatched" when neither is set. "Unmatched" always sorts last.
  const driverBuckets = useMemo(() => {
    const map = new Map<string, ListingRow[]>();
    for (const r of rows) {
      const key = r.matched_driver_name ?? r.auto_driver_name ?? "Unmatched";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    const entries = Array.from(map.entries()).sort(
      ([a, aItems], [b, bItems]) => {
        // "Unmatched" always sinks to the bottom regardless of sort.
        if (a === "Unmatched") return 1;
        if (b === "Unmatched") return -1;
        if (bucketSort === "count-desc") return bItems.length - aItems.length;
        if (bucketSort === "count-asc") return aItems.length - bItems.length;
        return a.localeCompare(b);
      },
    );
    return entries;
  }, [rows, bucketSort]);

  // Controlled collapse state, keyed by driver name. Empty = all expanded
  // (the default). "Collapse all" fills it with every bucket key.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const setOpen = (key: string, isOpen: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(key);
      else next.add(key);
      return next;
    });
  const allCollapsed =
    driverBuckets.length > 0 &&
    driverBuckets.every(([driver]) => collapsed.has(driver));

  // Apply collapse/expand-all commands from the toolbar. The ref swallows
  // commands issued before this view mounted, so switching views doesn't
  // replay the previous view's last command.
  const lastCmdSeq = useRef(collapseCommand.seq);
  useEffect(() => {
    if (collapseCommand.seq === lastCmdSeq.current) return;
    lastCmdSeq.current = collapseCommand.seq;
    setCollapsed(
      collapseCommand.collapse
        ? new Set(driverBuckets.map(([driver]) => driver))
        : new Set(),
    );
  }, [collapseCommand, driverBuckets]);

  // Report the aggregate state up so the toolbar's flip label is correct.
  useEffect(() => {
    onAllCollapsedChange(allCollapsed);
  }, [allCollapsed, onAllCollapsedChange]);

  return (
    <div className="space-y-3">
      {driverBuckets.map(([driver, items]) => {
        const totalCents = items.reduce(
          (s, r) => s + (r.price_cents ?? 0) + (r.shipping_cents ?? 0),
          0,
        );
        return (
          <details
            key={driver}
            className="card !p-0 overflow-hidden"
            open={!collapsed.has(driver)}
            onToggle={(e) => setOpen(driver, e.currentTarget.open)}
          >
            <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between hover:bg-bg-elevated">
              <div className="flex items-center gap-3">
                <span className="font-medium">{driver}</span>
                <span className="text-xs text-fg-subtle">
                  {items.length} listing{items.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="text-xs text-fg-subtle tabular-nums">
                total {formatCents(totalCents)}
              </div>
            </summary>
            <ul className="divide-y divide-border">
              {items.map((r) => (
                <li key={r.listing_id} className="px-4 py-2">
                  <ListingCard
                    row={r}
                    groups={groups}
                    offer={offersByItemId.get(
                      legacyIdFromExternalId(r.external_id),
                    )}
                    refreshing={refreshingId === r.listing_id}
                    unwatching={unwatchingId === r.listing_id}
                    onRefresh={() => onRefresh(r.listing_id)}
                    onUnwatch={() => onUnwatch(r)}
                    onClearMatch={() => onClearMatch(r.listing_id)}
                    onRejectMatch={() => onRejectMatch(r.listing_id)}
                    onConfirmMatch={() => onConfirmMatch(r.listing_id)}
                    onChangeMatch={() => onChangeMatch(r)}
                    autoMatching={autoMatchingId === r.listing_id}
                    autoMatchNote={autoMatchNotes.get(r.listing_id)}
                    onAutoMatch={() => onAutoMatch(r.listing_id)}
                    onAddToGroup={(gid) => onAddToGroup(r.listing_id, gid)}
                    onCreateGroup={() => onCreateGroup(r.listing_id)}
                    onRemoveFromGroup={(gid) =>
                      onRemoveFromGroup(r.listing_id, gid)
                    }
                    localDrivers={localDrivers}
                    tagDriverOpen={tagDriverId === r.listing_id}
                    onOpenTagDriver={() => onOpenTagDriver(r.listing_id)}
                    onCancelTagDriver={onCancelTagDriver}
                    onSetDriver={(name, normalized) =>
                      onSetDriver(r.listing_id, name, normalized)
                    }
                    onClearDriver={() => onClearDriver(r.listing_id)}
                    onResetDriver={() => onResetDriver(r.listing_id)}
                    onSetAttributes={(attrs) =>
                      onSetAttributes(r.listing_id, attrs)
                    }
                    onResetAttributes={() => onResetAttributes(r.listing_id)}
                    selectMode={selectMode}
                    selected={selectedIds.has(r.listing_id)}
                    onToggleSelect={() => onToggleSelect(r.listing_id)}
                    imgSizeClass={imgSizeClass}
                  />
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}

function GroupedByGroup({
  rows,
  groups,
  bucketSort,
  collapseCommand,
  onAllCollapsedChange,
  offersByItemId,
  refreshingId,
  unwatchingId,
  onRefresh,
  onUnwatch,
  onClearMatch,
  onRejectMatch,
  onConfirmMatch,
  onChangeMatch,
  autoMatchingId,
  autoMatchNotes,
  onAutoMatch,
  onAddToGroup,
  onCreateGroup,
  onRemoveFromGroup,
  localDrivers,
  tagDriverId,
  onOpenTagDriver,
  onCancelTagDriver,
  onSetDriver,
  onClearDriver,
  onResetDriver,
  onSetAttributes,
  onResetAttributes,
  selectMode,
  selectedIds,
  onToggleSelect,
  imgSizeClass,
}: {
  rows: ListingRow[];
  groups: ListingGroup[];
  bucketSort: BucketSort;
  collapseCommand: { seq: number; collapse: boolean };
  onAllCollapsedChange: (allCollapsed: boolean) => void;
  offersByItemId: Map<string, ReceivedOffer>;
  refreshingId: number | null;
  unwatchingId: number | null;
  onRefresh: (id: number) => void;
  onUnwatch: (row: ListingRow) => void;
  onClearMatch: (id: number) => void;
  onRejectMatch: (id: number) => void;
  onConfirmMatch: (id: number) => void;
  onChangeMatch: (row: ListingRow) => void;
  autoMatchingId: number | null;
  autoMatchNotes: Map<number, string>;
  onAutoMatch: (id: number) => void;
  onAddToGroup: (listingId: number, groupId: number) => void;
  onCreateGroup: (listingId: number) => void;
  onRemoveFromGroup: (listingId: number, groupId: number) => void;
  localDrivers: DriverOption[];
  tagDriverId: number | null;
  onOpenTagDriver: (id: number) => void;
  onCancelTagDriver: () => void;
  onSetDriver: (id: number, name: string, normalized: string) => void;
  onClearDriver: (id: number) => void;
  onResetDriver: (id: number) => void;
  onSetAttributes: (id: number, attrs: ListingAttributes) => void;
  onResetAttributes: (id: number) => void;
  selectMode: boolean;
  selectedIds: Set<number>;
  onToggleSelect: (listingId: number) => void;
  imgSizeClass: string;
}) {
  // Per-group listing buckets; a listing in N groups appears in N buckets.
  // "Ungrouped" collects everything with zero memberships.
  const groupItems = useMemo(() => {
    const byId = new Map<number, ListingRow[]>();
    for (const g of groups) byId.set(g.id, []);
    const ungrouped: ListingRow[] = [];
    for (const r of rows) {
      if (r.group_ids.length === 0) {
        ungrouped.push(r);
        continue;
      }
      for (const gid of r.group_ids) {
        if (!byId.has(gid)) byId.set(gid, []);
        byId.get(gid)!.push(r);
      }
    }
    return { byId, ungrouped };
  }, [rows, groups]);

  // Two-level layout: a driver section per driver (a multi-driver group
  // appears under each), then "No driver", then "Archived". `bucketSort`
  // orders the groups within each section.
  const sections = useMemo(() => {
    const { drivers, noDriver, archived } = clusterGroupsByDriver(groups);
    const sortGroups = (gs: ListingGroup[]) =>
      [...gs].sort((a, b) => {
        const ca = groupItems.byId.get(a.id)?.length ?? 0;
        const cb = groupItems.byId.get(b.id)?.length ?? 0;
        if (bucketSort === "count-desc") return cb - ca;
        if (bucketSort === "count-asc") return ca - cb;
        return a.name.localeCompare(b.name);
      });
    const out: {
      key: string;
      label: string;
      muted: boolean;
      groups: ListingGroup[];
    }[] = [];
    for (const d of drivers)
      out.push({
        key: `d-${d.id}`,
        label: d.name,
        muted: false,
        groups: sortGroups(d.groups),
      });
    if (noDriver.length > 0)
      out.push({
        key: "no-driver",
        label: "No driver",
        muted: true,
        groups: sortGroups(noDriver),
      });
    if (archived.length > 0)
      out.push({
        key: "archived",
        label: "Archived",
        muted: true,
        groups: sortGroups(archived),
      });
    return out;
  }, [groups, groupItems, bucketSort]);

  // Section-level collapse state. Archived and Ungrouped start collapsed;
  // everything else open. Collapsing a section hides its groups entirely,
  // so "Collapse all" gives a compact per-driver index.
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set<string>(["archived", "ungrouped"]),
  );
  const setOpen = (key: string, isOpen: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(key);
      else next.add(key);
      return next;
    });
  const allKeys = useMemo(() => {
    const ks = sections.map((s) => s.key);
    if (groupItems.ungrouped.length > 0) ks.push("ungrouped");
    return ks;
  }, [sections, groupItems.ungrouped.length]);
  const allCollapsed =
    allKeys.length > 0 && allKeys.every((k) => collapsed.has(k));

  // Apply collapse/expand-all commands from the toolbar; the ref swallows
  // commands issued before this view mounted. "Collapse all" only fills in
  // the section-level keys (matching the old behavior — collapsing a
  // section hides its groups, so per-group keys don't need to be added).
  const lastCmdSeq = useRef(collapseCommand.seq);
  useEffect(() => {
    if (collapseCommand.seq === lastCmdSeq.current) return;
    lastCmdSeq.current = collapseCommand.seq;
    setCollapsed(collapseCommand.collapse ? new Set(allKeys) : new Set());
  }, [collapseCommand, allKeys]);

  // Report the aggregate state up so the toolbar's flip label is correct.
  useEffect(() => {
    onAllCollapsedChange(allCollapsed);
  }, [allCollapsed, onAllCollapsedChange]);

  const renderListing = (r: ListingRow) => (
    <li key={r.listing_id} className="px-4 py-2">
      <ListingCard
        row={r}
        groups={groups}
        offer={offersByItemId.get(legacyIdFromExternalId(r.external_id))}
        refreshing={refreshingId === r.listing_id}
        unwatching={unwatchingId === r.listing_id}
        onRefresh={() => onRefresh(r.listing_id)}
        onUnwatch={() => onUnwatch(r)}
        onClearMatch={() => onClearMatch(r.listing_id)}
        onRejectMatch={() => onRejectMatch(r.listing_id)}
        onConfirmMatch={() => onConfirmMatch(r.listing_id)}
        onChangeMatch={() => onChangeMatch(r)}
        autoMatching={autoMatchingId === r.listing_id}
        autoMatchNote={autoMatchNotes.get(r.listing_id)}
        onAutoMatch={() => onAutoMatch(r.listing_id)}
        onAddToGroup={(gid) => onAddToGroup(r.listing_id, gid)}
        onCreateGroup={() => onCreateGroup(r.listing_id)}
        onRemoveFromGroup={(gid) => onRemoveFromGroup(r.listing_id, gid)}
        localDrivers={localDrivers}
        tagDriverOpen={tagDriverId === r.listing_id}
        onOpenTagDriver={() => onOpenTagDriver(r.listing_id)}
        onCancelTagDriver={onCancelTagDriver}
        onSetDriver={(name, normalized) =>
          onSetDriver(r.listing_id, name, normalized)
        }
        onClearDriver={() => onClearDriver(r.listing_id)}
        onResetDriver={() => onResetDriver(r.listing_id)}
        onSetAttributes={(attrs) => onSetAttributes(r.listing_id, attrs)}
        onResetAttributes={() => onResetAttributes(r.listing_id)}
        selectMode={selectMode}
        selected={selectedIds.has(r.listing_id)}
        onToggleSelect={() => onToggleSelect(r.listing_id)}
        imgSizeClass={imgSizeClass}
      />
    </li>
  );

  if (groups.length === 0) {
    return (
      <div className="card text-sm text-fg-muted">
        No groups yet. Use “Manage groups…” in the header’s ⋯ menu to create
        one.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <details
          key={section.key}
          className={`card !p-0 overflow-hidden ${section.muted ? "opacity-80" : ""}`}
          open={!collapsed.has(section.key)}
          onToggle={(e) => setOpen(section.key, e.currentTarget.open)}
        >
          <summary className="cursor-pointer list-none px-4 py-2.5 flex items-center justify-between hover:bg-bg-elevated bg-bg-elevated/40">
            <div className="flex items-center gap-2">
              <span
                className={`font-semibold ${section.muted ? "text-fg-muted" : ""}`}
              >
                {section.label}
              </span>
              <span className="text-xs text-fg-subtle">
                {section.groups.length} group
                {section.groups.length === 1 ? "" : "s"}
              </span>
            </div>
          </summary>
          <div className="px-3 py-2 space-y-2">
            {section.groups.map((group) => {
              const items = groupItems.byId.get(group.id) ?? [];
              const gkey = `${section.key}::${group.id}`;
              const totalCents = items.reduce(
                (s, r) => s + (r.price_cents ?? 0) + (r.shipping_cents ?? 0),
                0,
              );
              const overTarget =
                group.target_price_cents !== null
                  ? items.filter(
                      (r) =>
                        r.price_cents !== null &&
                        r.price_cents + (r.shipping_cents ?? 0) >
                          (group.target_price_cents ?? 0),
                    ).length
                  : 0;
              return (
                <details
                  key={gkey}
                  className="rounded border border-border overflow-hidden"
                  open={!collapsed.has(gkey)}
                  onToggle={(e) => setOpen(gkey, e.currentTarget.open)}
                >
                  <summary className="cursor-pointer list-none px-3 py-2 flex items-start justify-between gap-4 hover:bg-bg-elevated">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{group.name}</span>
                        <span className="text-xs text-fg-subtle">
                          {items.length} listing{items.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      {group.description && (
                        <div className="text-xs text-fg-subtle mt-0.5 whitespace-pre-wrap">
                          {group.description}
                        </div>
                      )}
                      {group.target_price_cents !== null && (
                        <div className="text-xs text-fg-subtle mt-0.5">
                          target ≤ {formatCents(group.target_price_cents)}
                          {overTarget > 0 && (
                            <span className="text-amber-400 ml-2">
                              {overTarget} over target
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="text-xs text-fg-subtle tabular-nums shrink-0">
                      total {formatCents(totalCents)}
                    </div>
                  </summary>
                  {items.length === 0 ? (
                    <div className="px-3 py-2.5 text-xs text-fg-subtle">
                      No listings in this group yet.
                    </div>
                  ) : (
                    <ul className="divide-y divide-border border-t border-border">
                      {items.map(renderListing)}
                    </ul>
                  )}
                </details>
              );
            })}
          </div>
        </details>
      ))}

      {groupItems.ungrouped.length > 0 && (
        <details
          className="card !p-0 overflow-hidden"
          open={!collapsed.has("ungrouped")}
          onToggle={(e) => setOpen("ungrouped", e.currentTarget.open)}
        >
          <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between hover:bg-bg-elevated">
            <div className="flex items-center gap-2">
              <span className="font-medium text-fg-muted">Ungrouped</span>
              <span className="text-xs text-fg-subtle">
                {groupItems.ungrouped.length} listing
                {groupItems.ungrouped.length === 1 ? "" : "s"}
              </span>
            </div>
          </summary>
          <ul className="divide-y divide-border">
            {groupItems.ungrouped.map(renderListing)}
          </ul>
        </details>
      )}
    </div>
  );
}

function GroupChipRow({
  row,
  groups,
  onAddToGroup,
  onCreateGroup,
  onRemoveFromGroup,
}: {
  row: ListingRow;
  groups: ListingGroup[];
  onAddToGroup: (groupId: number) => void;
  onCreateGroup: () => void;
  onRemoveFromGroup: (groupId: number) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const memberOf = useMemo(() => {
    const ids = new Set(row.group_ids);
    return groups.filter((g) => ids.has(g.id));
  }, [row.group_ids, groups]);
  const memberIds = useMemo(() => new Set(row.group_ids), [row.group_ids]);
  // The picker lists members too (with a check) rather than removing them, so
  // rows don't reshuffle under the cursor while multi-adding.
  const available = useMemo(() => groups.filter((g) => !g.archived), [groups]);
  const filteredAvailable = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((g) => g.name.toLowerCase().includes(q));
  }, [available, query]);

  // Float this listing's driver's groups to the top of the picker. Registry
  // match takes precedence over the auto/manual tag for the section label.
  const driverLabel = row.matched_driver_name ?? row.auto_driver_name;
  const { preferred, others } = useMemo(() => {
    const ids = new Set<number>();
    if (row.auto_driver_id !== null) ids.add(row.auto_driver_id);
    const names = new Set<string>();
    if (row.matched_driver_name)
      names.add(row.matched_driver_name.toLowerCase());
    if (row.auto_driver_name) names.add(row.auto_driver_name.toLowerCase());
    if (ids.size === 0 && names.size === 0)
      return { preferred: [], others: filteredAvailable };
    return partitionGroupsByDrivers(filteredAvailable, ids, names);
  }, [
    filteredAvailable,
    row.auto_driver_id,
    row.matched_driver_name,
    row.auto_driver_name,
  ]);

  // Sections, in display order: the listing's driver's groups first, then
  // driverless groups (they're cross-driver — "Lots", "Purchased" — so they
  // stay near the top), then every other driver's groups under that driver's
  // name. A group tied to several drivers repeats under each, matching the
  // filter dropdown.
  const sections = useMemo(() => {
    const clustered = clusterGroupsByDriver(others);
    const out: { key: string; label: string; groups: ListingGroup[] }[] = [];
    if (preferred.length > 0 && driverLabel)
      out.push({ key: "preferred", label: driverLabel, groups: preferred });
    if (clustered.noDriver.length > 0)
      out.push({
        key: "no-driver",
        label: "No driver",
        groups: clustered.noDriver,
      });
    for (const d of clustered.drivers)
      out.push({ key: `d-${d.id}`, label: d.name, groups: d.groups });
    return out;
  }, [preferred, others, driverLabel]);

  const total =
    row.price_cents !== null
      ? row.price_cents + (row.shipping_cents ?? 0)
      : null;

  const renderOption = (g: ListingGroup) => {
    const isMember = memberIds.has(g.id);
    return (
      <button
        key={g.id}
        type="button"
        className="flex w-full items-center text-left px-2 py-1 text-xs hover:bg-bg"
        // Deliberately keeps the picker open so several groups can be added in
        // one sitting; the click-away catcher is the way out.
        onClick={() =>
          isMember ? onRemoveFromGroup(g.id) : onAddToGroup(g.id)
        }
        title={isMember ? "Remove from this group" : "Add to this group"}
      >
        <span className="w-4 shrink-0 text-accent">{isMember ? "✓" : ""}</span>
        <span className={isMember ? "" : "text-fg-muted"}>
          {g.name}
          {g.member_count > 0 && (
            <span className="text-fg-subtle ml-1">({g.member_count})</span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {/* The button leads the row so the popover anchored to it doesn't move
          as chips get added after it. */}
      <div className="relative">
        <button
          type="button"
          className="text-[10px] px-1.5 py-0.5 rounded border border-dashed border-border text-fg-subtle hover:text-fg hover:border-fg-muted"
          onClick={() => {
            setPickerOpen((v) => !v);
            setQuery("");
          }}
        >
          + group
        </button>
        {pickerOpen && (
          <>
            {/* Click-away catcher. */}
            <div
              className="fixed inset-0 z-30"
              onClick={() => setPickerOpen(false)}
            />
            <div className="absolute z-40 mt-1 min-w-[12rem] rounded border border-border bg-bg-elevated shadow-lg py-1">
              {available.length > 0 && (
                <div className="px-2 pb-1">
                  <input
                    type="text"
                    className="input !py-1 !text-xs"
                    placeholder="Search groups…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                  />
                </div>
              )}
              <div className="max-h-64 overflow-y-auto">
                <button
                  type="button"
                  className="block w-full text-left px-2 py-1 text-xs text-accent hover:bg-bg"
                  onClick={() => {
                    setPickerOpen(false);
                    onCreateGroup();
                  }}
                >
                  + Create new group…
                </button>
                {filteredAvailable.length > 0 && (
                  <div className="my-1 h-px bg-border" />
                )}
                {available.length > 0 && filteredAvailable.length === 0 && (
                  <div className="px-2 py-1 text-xs text-fg-subtle">
                    No groups match “{query.trim()}”.
                  </div>
                )}
                {sections.map((s, i) => (
                  <div key={s.key}>
                    <div
                      className={`px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-fg-subtle ${
                        i > 0 ? "border-t border-border mt-1" : ""
                      }`}
                    >
                      {s.label}
                    </div>
                    {s.groups.map(renderOption)}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
      {memberOf.map((g) => {
        const overTarget =
          g.target_price_cents !== null &&
          total !== null &&
          total > g.target_price_cents;
        return (
          <span
            key={g.id}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${
              overTarget
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : "border-border bg-bg-elevated text-fg-muted"
            }`}
            title={
              g.target_price_cents !== null
                ? `target ≤ ${formatCents(g.target_price_cents)}${overTarget ? " — this listing is over target" : ""}`
                : "in this group"
            }
          >
            {g.name}
            <button
              type="button"
              className="link-danger leading-none"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveFromGroup(g.id);
              }}
              title="Remove from this group"
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

function BulkSelectionBar({
  selectedCount,
  visibleCount,
  groups,
  selectedDriverKeys,
  busy,
  notice,
  onSelectAllVisible,
  onClear,
  onDone,
  onAddToGroup,
  onCreateGroup,
  onRemoveFromGroup,
  onAddToWishlist,
  onShareSelection,
}: {
  selectedCount: number;
  visibleCount: number;
  groups: ListingGroup[];
  selectedDriverKeys: { ids: Set<number>; names: Set<string> };
  busy: boolean;
  /** Authored prose carrying its own tone (DCH-36) — a partial add is a
   *  warning, not an error, because the rest of it went through. */
  notice: WishlistNotice | null;
  onSelectAllVisible: () => void;
  onClear: () => void;
  onDone: () => void;
  onAddToGroup: (groupId: number) => void;
  onCreateGroup: () => void;
  onRemoveFromGroup: (groupId: number) => void;
  onAddToWishlist: () => void;
  onShareSelection: () => void;
}) {
  const activeGroups = groups.filter((g) => !g.archived);
  return (
    <div className="sticky bottom-2 z-30 mx-auto mt-4 w-fit max-w-full">
      <div className="card flex items-center gap-3 shadow-xl border-accent/40 bg-bg-elevated">
        <div className="text-sm">
          <span className="font-medium">{selectedCount}</span>{" "}
          <span className="text-fg-subtle">selected</span>
        </div>
        <div className="h-5 w-px bg-border" />
        <button
          type="button"
          className="text-xs text-fg-muted hover:text-fg"
          onClick={onSelectAllVisible}
          disabled={busy || visibleCount === 0}
          title="Select every listing matching the current filters"
        >
          Select all visible ({visibleCount})
        </button>
        <button
          type="button"
          className="text-xs text-fg-muted hover:text-fg"
          onClick={onClear}
          disabled={busy || selectedCount === 0}
        >
          Clear
        </button>
        <div className="h-5 w-px bg-border" />
        <BulkGroupMenu
          label="Add to group"
          groups={activeGroups}
          preferredDrivers={selectedDriverKeys}
          disabled={busy || selectedCount === 0}
          onPick={onAddToGroup}
          onCreateNew={onCreateGroup}
          emptyHint="No groups yet."
        />
        <BulkGroupMenu
          label="Remove from group"
          groups={groups}
          disabled={busy || selectedCount === 0 || groups.length === 0}
          onPick={onRemoveFromGroup}
          emptyHint="No groups exist."
        />
        <button
          type="button"
          className="text-xs text-fg-muted hover:text-fg disabled:opacity-40"
          onClick={onAddToWishlist}
          disabled={busy || selectedCount === 0}
          title="Add the selection to a wishlist as purchase candidates"
        >
          Add to wishlist…
        </button>
        <button
          type="button"
          className="text-xs text-fg-muted hover:text-fg disabled:opacity-40"
          onClick={onShareSelection}
          disabled={busy || selectedCount === 0}
          title="Publish the selection as a public page and copy its link"
        >
          Share selection…
        </button>
        <div className="h-5 w-px bg-border" />
        <button
          type="button"
          className="text-xs text-fg-subtle hover:text-fg"
          onClick={onDone}
          disabled={busy}
        >
          Done
        </button>
        {notice && (
          <NoticeBanner
            variant="inline"
            tone={notice.tone}
            message={notice.message}
            className="ml-2 max-w-md"
          />
        )}
      </div>
    </div>
  );
}

function renderBulkOption(
  g: ListingGroup,
  setOpen: (v: boolean) => void,
  onPick: (groupId: number) => void,
) {
  return (
    <button
      key={g.id}
      type="button"
      className="block w-full text-left px-2 py-1 text-xs hover:bg-bg"
      onClick={() => {
        setOpen(false);
        onPick(g.id);
      }}
    >
      {g.name}
      {g.archived && <span className="text-fg-subtle ml-1">(archived)</span>}
    </button>
  );
}

function BulkGroupMenu({
  label,
  groups,
  preferredDrivers,
  disabled,
  onPick,
  onCreateNew,
  emptyHint,
}: {
  label: string;
  groups: ListingGroup[];
  /** When set, groups tied to these drivers float to the top in their own
   *  section (used by "Add to group" with the selection's drivers). */
  preferredDrivers?: { ids: Set<number>; names: Set<string> };
  disabled: boolean;
  onPick: (groupId: number) => void;
  onCreateNew?: () => void;
  emptyHint: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, query]);
  const { preferred, others } = useMemo(() => {
    if (
      !preferredDrivers ||
      (preferredDrivers.ids.size === 0 && preferredDrivers.names.size === 0)
    )
      return { preferred: [], others: filtered };
    return partitionGroupsByDrivers(
      filtered,
      preferredDrivers.ids,
      preferredDrivers.names,
    );
  }, [filtered, preferredDrivers]);

  // Same section order as the per-listing picker: the selection's drivers'
  // groups, then driverless (cross-driver) groups, then each other driver's
  // groups, then archived (present only in the remove menu, which lists all
  // groups).
  const sections = useMemo(() => {
    const clustered = clusterGroupsByDriver(others);
    const out: { key: string; label: string; groups: ListingGroup[] }[] = [];
    if (preferred.length > 0)
      out.push({
        key: "preferred",
        label: "Selected drivers",
        groups: preferred,
      });
    if (clustered.noDriver.length > 0)
      out.push({
        key: "no-driver",
        label: "No driver",
        groups: clustered.noDriver,
      });
    for (const d of clustered.drivers)
      out.push({ key: `d-${d.id}`, label: d.name, groups: d.groups });
    if (clustered.archived.length > 0)
      out.push({
        key: "archived",
        label: "Archived",
        groups: clustered.archived,
      });
    return out;
  }, [preferred, others]);
  return (
    <div className="relative">
      <button
        type="button"
        className="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        disabled={disabled}
      >
        {label} ▾
      </button>
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 bottom-full mb-1 right-0 min-w-[14rem] rounded border border-border bg-bg-elevated shadow-lg py-1">
            {groups.length > 0 && (
              <div className="px-2 pb-1">
                <input
                  type="text"
                  className="input !py-1 !text-xs"
                  placeholder="Search groups…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus
                />
              </div>
            )}
            <div className="max-h-64 overflow-y-auto">
              {onCreateNew && (
                <>
                  <button
                    type="button"
                    className="block w-full text-left px-2 py-1 text-xs text-accent hover:bg-bg"
                    onClick={() => {
                      setOpen(false);
                      onCreateNew();
                    }}
                  >
                    + Create new group…
                  </button>
                  {filtered.length > 0 && (
                    <div className="my-1 h-px bg-border" />
                  )}
                </>
              )}
              {groups.length === 0 ? (
                onCreateNew ? null : (
                  <div className="px-2 py-1 text-xs text-fg-subtle">
                    {emptyHint}
                  </div>
                )
              ) : filtered.length === 0 ? (
                <div className="px-2 py-1 text-xs text-fg-subtle">
                  No groups match “{query.trim()}”.
                </div>
              ) : (
                sections.map((s, i) => (
                  <div key={s.key}>
                    <div
                      className={`px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-fg-subtle ${
                        i > 0 ? "border-t border-border mt-1" : ""
                      }`}
                    >
                      {s.label}
                    </div>
                    {s.groups.map((g) => renderBulkOption(g, setOpen, onPick))}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ManageGroupsDialog({
  groups,
  onClose,
  onChanged,
}: {
  groups: ListingGroup[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<ListingGroup | "new" | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Same driver clustering as the filter dropdown: one section per driver
  // (multi-driver groups repeat under each), then driverless, then archived.
  const clustered = useMemo(() => clusterGroupsByDriver(groups), [groups]);

  async function onDelete(g: ListingGroup) {
    if (
      !window.confirm(
        `Delete the group "${g.name}"? Listings in it will not be deleted.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteListingGroup(g.id);
      await onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onToggleArchive(g: ListingGroup) {
    setBusy(true);
    setError(null);
    try {
      await api.updateListingGroup(g.id, {
        name: g.name,
        description: g.description,
        target_price_cents: g.target_price_cents,
        archived: !g.archived,
        driver_ids: g.drivers.map((d) => d.id),
      });
      await onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Manage groups"
      description="Create named buckets for paint schemes or hunts. A listing can belong to any number of groups."
      onClose={onClose}
      size="max-w-2xl"
      scroll="none"
      panelClassName="max-h-[85vh] flex flex-col"
      footer={
        <>
          {/* flex-1 pushes Close to the right, giving this dialog the
              justify-between footer it had before the shared Modal. */}
          <div className="flex-1 flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setEditing("new")}
              disabled={busy}
            >
              New group
            </button>
            {groups.length > 0 && (
              <button
                type="button"
                className="text-xs text-fg-muted hover:text-fg underline decoration-dotted underline-offset-2"
                onClick={() => setWizardOpen(true)}
                disabled={busy}
                title="Strip driver-name prefixes from group names and link the drivers automatically"
              >
                Clean up names…
              </button>
            )}
          </div>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {error && <ErrorBanner error={error} variant="inline" className="mb-2" />}

      <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-4 min-h-[6rem]">
        {groups.length === 0 ? (
          <div className="text-sm text-fg-subtle">No groups yet.</div>
        ) : (
          <>
            {clustered.drivers.map((d) => (
              <GroupSection
                key={`d-${d.id}`}
                label={d.name}
                groups={d.groups}
                busy={busy}
                onEdit={setEditing}
                onToggleArchive={onToggleArchive}
                onDelete={onDelete}
              />
            ))}
            {clustered.noDriver.length > 0 && (
              <GroupSection
                label="No driver"
                groups={clustered.noDriver}
                busy={busy}
                onEdit={setEditing}
                onToggleArchive={onToggleArchive}
                onDelete={onDelete}
              />
            )}
            {clustered.archived.length > 0 && (
              <GroupSection
                label="Archived"
                groups={clustered.archived}
                busy={busy}
                onEdit={setEditing}
                onToggleArchive={onToggleArchive}
                onDelete={onDelete}
              />
            )}
          </>
        )}
      </div>

      {editing !== null && (
        <GroupEditorDialog
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onChanged();
          }}
        />
      )}

      {wizardOpen && (
        <GroupMigrationWizard
          groups={groups}
          onClose={() => setWizardOpen(false)}
          onApplied={async () => {
            setWizardOpen(false);
            await onChanged();
          }}
        />
      )}
    </Modal>
  );
}

/** One labeled section of the Manage-groups list: a driver's groups, the
 *  driverless bucket, or the archived bucket. */
function GroupSection({
  label,
  groups,
  busy,
  onEdit,
  onToggleArchive,
  onDelete,
}: {
  label: string;
  groups: ListingGroup[];
  busy: boolean;
  onEdit: (g: ListingGroup) => void;
  onToggleArchive: (g: ListingGroup) => void;
  onDelete: (g: ListingGroup) => void;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-fg-subtle mb-1">
        {label}
      </div>
      <div className="space-y-2">
        {groups.map((g) => (
          <div
            key={g.id}
            className={`rounded border border-border px-3 py-2 ${g.archived ? "opacity-70" : ""}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  {g.name}
                  {g.archived && (
                    <span className="text-[10px] uppercase tracking-wide text-fg-subtle border border-border rounded px-1">
                      archived
                    </span>
                  )}
                </div>
                <div className="text-xs text-fg-subtle">
                  {g.member_count} listing
                  {g.member_count === 1 ? "" : "s"}
                  {g.target_price_cents !== null && (
                    <> · target ≤ {formatCents(g.target_price_cents)}</>
                  )}
                </div>
                {g.drivers.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {g.drivers.map((d) => (
                      <span
                        key={d.id}
                        className="text-[10px] rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-fg-muted"
                      >
                        {d.name}
                      </span>
                    ))}
                  </div>
                )}
                {g.description && (
                  <div className="text-xs text-fg-muted mt-0.5 whitespace-pre-wrap">
                    {g.description}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  className="text-xs text-fg-muted hover:text-fg"
                  onClick={() => onEdit(g)}
                  disabled={busy}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-xs text-fg-muted hover:text-fg"
                  onClick={() => onToggleArchive(g)}
                  disabled={busy}
                >
                  {g.archived ? "Unarchive" : "Archive"}
                </button>
                <button
                  type="button"
                  className="link-danger text-xs"
                  onClick={() => onDelete(g)}
                  disabled={busy}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A driver chip in the group editor. `id` is null when the name doesn't
 *  match a local drivers row yet — the row is created via `ensure_driver`
 *  when the group is saved, never before (so cancelling leaves no trace). */
interface DriverChip {
  id: number | null;
  name: string;
}

/** Chip-style multi-select for a group's drivers. Autocompletes against the
 *  local drivers table. The draft input is controlled by the parent so the
 *  form can commit a typed-but-unconfirmed name on Save instead of silently
 *  dropping it. */
function DriverMultiSelect({
  selected,
  onChange,
  draft,
  onDraftChange,
}: {
  selected: DriverChip[];
  onChange: (next: DriverChip[]) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
}) {
  const [drivers, setDrivers] = useState<DriverOption[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .listDrivers()
      .then((d) => {
        if (alive)
          setDrivers(
            sortDriverOptions(
              d,
              (x) => x.name,
              (x) => x.listing_count,
            ),
          );
      })
      .catch(() => {
        // Non-fatal: typing a new name still works — it resolves on save.
      });
    return () => {
      alive = false;
    };
  }, []);

  const selectedNames = new Set(selected.map((d) => d.name.toLowerCase()));
  const listId = "group-driver-options";

  function add(rawName: string) {
    const nm = rawName.trim();
    if (!nm) return;
    // Snap to the canonical local row when the name matches one, so the
    // same person typed two ways collapses to a single chip.
    const exact = drivers.find(
      (d) => d.name.toLowerCase() === nm.toLowerCase(),
    );
    const chip: DriverChip = exact
      ? { id: exact.id, name: exact.name }
      : { id: null, name: nm };
    if (!selectedNames.has(chip.name.toLowerCase()))
      onChange([...selected, chip]);
    onDraftChange("");
  }

  return (
    <div>
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 mb-1">
          {selected.map((d) => (
            <span
              key={d.name.toLowerCase()}
              className="inline-flex items-center gap-1 rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-xs"
            >
              {d.name}
              <button
                type="button"
                className="link-danger leading-none"
                onClick={() =>
                  onChange(
                    selected.filter(
                      (x) => x.name.toLowerCase() !== d.name.toLowerCase(),
                    ),
                  )
                }
                title="Remove driver"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          list={listId}
          type="text"
          className="input !py-1 !text-xs flex-1"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder="Add a driver…"
        />
        <datalist id={listId}>
          {drivers
            .filter((d) => !selectedNames.has(d.name.toLowerCase()))
            .map((d) => (
              <option key={d.id} value={d.name} />
            ))}
        </datalist>
        <button
          type="button"
          className="text-xs text-accent hover:text-accent/80 disabled:opacity-50"
          onClick={() => add(draft)}
          disabled={draft.trim() === ""}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function GroupEditorDialog({
  initial,
  prefillDrivers,
  onCancel,
  onSaved,
}: {
  initial: ListingGroup | null;
  /** Seed drivers for create mode — e.g. the listing's driver when the
   *  editor is opened from a listing's "+ group" picker. Ignored on edit. */
  prefillDrivers?: DriverChip[];
  onCancel: () => void;
  onSaved: (created: ListingGroup | null) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [targetDollars, setTargetDollars] = useState(
    initial?.target_price_cents !== null &&
      initial?.target_price_cents !== undefined
      ? (initial.target_price_cents / 100).toFixed(2)
      : "",
  );
  const [selectedDrivers, setSelectedDrivers] = useState<DriverChip[]>(
    initial?.drivers ?? prefillDrivers ?? [],
  );
  const [driverDraft, setDriverDraft] = useState("");
  const [existingGroups, setExistingGroups] = useState<ListingGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .listListingGroups()
      .then((gs) => {
        if (alive) setExistingGroups(gs);
      })
      .catch(() => {
        // Non-fatal: the duplicate-name hint just won't show.
      });
    return () => {
      alive = false;
    };
  }, []);

  // Soft advisory only: names may repeat across drivers, but reusing a name
  // under a driver the new group already shares is usually a mistake.
  const dupWarning = useMemo(() => {
    const nm = name.trim().toLowerCase();
    if (!nm) return null;
    const selIds = new Set(
      selectedDrivers.flatMap((d) => (d.id !== null ? [d.id] : [])),
    );
    const selNames = new Set(selectedDrivers.map((d) => d.name.toLowerCase()));
    const clash = existingGroups.find((g) => {
      if (g.id === initial?.id) return false;
      if (g.name.trim().toLowerCase() !== nm) return false;
      if (selectedDrivers.length === 0) return g.drivers.length === 0;
      return g.drivers.some(
        (d) => selIds.has(d.id) || selNames.has(d.name.toLowerCase()),
      );
    });
    if (!clash) return null;
    return selIds.size === 0
      ? `Another driverless group is already named “${clash.name}”.`
      : `“${clash.name}” already exists under that driver.`;
  }, [name, selectedDrivers, existingGroups, initial?.id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let targetCents: number | null = null;
    const t = targetDollars.trim();
    if (t.length > 0) {
      const parsed = Number(t);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError("Target price must be a non-negative number.");
        return;
      }
      targetCents = Math.round(parsed * 100);
    }
    setBusy(true);
    try {
      // A name typed into the driver field but never confirmed with
      // Enter/Add still counts — losing it silently is how groups end up
      // driverless by accident.
      const chips = [...selectedDrivers];
      const pendingDraft = driverDraft.trim();
      if (
        pendingDraft &&
        !chips.some((c) => c.name.toLowerCase() === pendingDraft.toLowerCase())
      ) {
        chips.push({ id: null, name: pendingDraft });
      }
      // Resolve chips without a local row now — ensure_driver upserts by
      // normalized name, so an existing driver typed by hand still lands
      // on its canonical row.
      const driverIds: number[] = [];
      for (const c of chips) {
        const id =
          c.id ?? (await api.ensureDriver(c.name, normalizeDriverName(c.name)));
        if (!driverIds.includes(id)) driverIds.push(id);
      }

      const input: ListingGroupInput = {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        target_price_cents: targetCents,
        archived: initial?.archived ?? false,
        driver_ids: driverIds,
      };
      if (initial === null) {
        const created = await api.createListingGroup(input);
        await onSaved(created);
      } else {
        await api.updateListingGroup(initial.id, input);
        await onSaved(null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    // No `layer` prop: this dialog is opened both from the Listings toolbar
    // (base layer) and from inside GroupsModal (nested), and Modal works its
    // own depth out from the open-modal stack.
    <Modal
      title={initial === null ? "New group" : "Edit group"}
      onClose={onCancel}
      onSubmit={onSubmit}
      busy={busy}
      size="max-w-md"
      footer={
        <>
          <button
            type="button"
            className="btn-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            type="submit"
            disabled={busy || name.trim() === ""}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label">Name</label>
          <input
            className="input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Mountain Dew throwback"
            autoFocus
            required
          />
          {dupWarning && (
            <p className="text-[11px] text-amber-400 mt-1">{dupWarning}</p>
          )}
        </div>
        <div>
          <label className="label">Drivers (optional)</label>
          <DriverMultiSelect
            selected={selectedDrivers}
            onChange={setSelectedDrivers}
            draft={driverDraft}
            onDraftChange={setDriverDraft}
          />
          <p className="text-[11px] text-fg-subtle mt-1">
            Groups the listing under these drivers in the filter and by-group
            view. Leave empty for a driverless group (e.g. a lot).
          </p>
        </div>
        <div>
          <label className="label">Notes (optional)</label>
          <textarea
            className="input min-h-[4rem]"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What are you looking for? Any constraints?"
          />
        </div>
        <div>
          <label className="label">Target max price (optional)</label>
          <input
            className="input"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={targetDollars}
            onChange={(e) => setTargetDollars(e.target.value)}
            placeholder="e.g. 75.00"
          />
          <p className="text-[11px] text-fg-subtle mt-1">
            Listings over this price get a yellow flag in the group view.
          </p>
        </div>
      </div>
      {error && <ErrorBanner error={error} variant="inline" className="mt-2" />}
    </Modal>
  );
}

// --- Group name-migration wizard ------------------------------------------

/** A handle (driver-name prefix) and the driver it maps to. `driverId` is
 *  null until resolved/created on apply. */
interface MigrationRule {
  handle: string;
  driverName: string;
  driverId: number | null;
}

function firstToken(s: string): string {
  return s.trim().split(/\s+/)[0] ?? "";
}

/** Client-side mirror of the Rust `match_prefix` boundary check, used only
 *  for live match counts in the rules editor. The authoritative match runs
 *  server-side via `propose_group_migration`. */
function clientPrefixMatches(name: string, handle: string): boolean {
  const h = handle.trim();
  if (!h) return false;
  const ln = name.toLowerCase();
  const lh = h.toLowerCase();
  if (ln === lh) return true;
  return ln.startsWith(lh) && /\s/.test(name.charAt(h.length));
}

function GroupMigrationWizard({
  groups,
  onClose,
  onApplied,
}: {
  groups: ListingGroup[];
  onClose: () => void;
  onApplied: () => Promise<void>;
}) {
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [rules, setRules] = useState<MigrationRule[]>([]);
  const [proposals, setProposals] = useState<GroupMigrationProposal[] | null>(
    null,
  );
  // Per-group name overrides in the preview, so the user can resolve
  // collisions (two stripped names landing on the same value) before apply.
  const [editedNames, setEditedNames] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Seed rules from the drivers table: each driver's last name becomes a
  // candidate handle, but only when it actually prefixes some group (keeps
  // the list relevant rather than dumping every known driver).
  useEffect(() => {
    let alive = true;
    api
      .listDrivers()
      .then((ds) => {
        if (!alive) return;
        setDrivers(
          sortDriverOptions(
            ds,
            (x) => x.name,
            (x) => x.listing_count,
          ),
        );
        const seeded: MigrationRule[] = [];
        const seen = new Set<string>();
        for (const d of ds) {
          const handle = d.name.trim().split(/\s+/).pop() ?? "";
          const key = handle.toLowerCase();
          if (!handle || seen.has(key)) continue;
          const matches = groups.some((g) =>
            clientPrefixMatches(g.name, handle),
          );
          if (!matches) continue;
          seen.add(key);
          seeded.push({ handle, driverName: d.name, driverId: d.id });
        }
        seeded.sort((a, b) => a.handle.localeCompare(b.handle));
        setRules(seeded);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [groups]);

  const activeRules = useMemo(
    () => rules.filter((r) => r.handle.trim() && r.driverName.trim()),
    [rules],
  );

  // Groups not matched by any active rule (client approximation) — surfaced
  // so the user knows what still needs a rule.
  const unmatchedNames = useMemo(() => {
    return groups
      .filter(
        (g) => !activeRules.some((r) => clientPrefixMatches(g.name, r.handle)),
      )
      .map((g) => g.name);
  }, [groups, activeRules]);

  function updateRule(i: number, patch: Partial<MigrationRule>) {
    setProposals(null);
    setRules((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    );
  }
  function removeRule(i: number) {
    setProposals(null);
    setRules((prev) => prev.filter((_, idx) => idx !== i));
  }
  function addRule(handle = "") {
    setProposals(null);
    setRules((prev) => [...prev, { handle, driverName: "", driverId: null }]);
  }

  // When a rule's driver name is edited, snap driverId to the matching
  // existing driver (or null, meaning "create on apply").
  function setRuleDriver(i: number, name: string) {
    const exact = drivers.find(
      (d) => d.name.toLowerCase() === name.trim().toLowerCase(),
    );
    updateRule(i, { driverName: name, driverId: exact?.id ?? null });
  }

  async function onPreview() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await api.proposeGroupMigration(
        activeRules.map((r) => r.handle),
      );
      setEditedNames({});
      setProposals(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onApply() {
    if (!proposals) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      // Resolve a driver id for every active rule (create rows as needed),
      // keyed by lower-cased handle for proposal lookup.
      const ruleByHandle = new Map<string, MigrationRule>();
      for (const r of activeRules) ruleByHandle.set(r.handle.toLowerCase(), r);
      const resolvedId = new Map<string, number>();
      for (const r of activeRules) {
        let id = r.driverId;
        if (id === null) {
          id = await api.ensureDriver(
            r.driverName.trim(),
            normalizeDriverName(r.driverName),
          );
        }
        resolvedId.set(r.handle.toLowerCase(), id);
      }

      const items = proposals
        .filter((p) => p.matched_handle !== null)
        .map((p) => {
          const id = resolvedId.get((p.matched_handle ?? "").toLowerCase());
          if (id === undefined) return null;
          return {
            group_id: p.group_id,
            new_name: (editedNames[p.group_id] ?? p.new_name).trim(),
            driver_ids: [id],
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (items.length === 0) {
        setInfo("Nothing to apply — no groups matched a rule with a driver.");
        return;
      }
      const count = await api.applyGroupMigration(items);
      setInfo(`Updated ${count} group${count === 1 ? "" : "s"}.`);
      await onApplied();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const matchedCount = proposals
    ? proposals.filter((p) => p.matched_handle !== null).length
    : 0;

  // Resulting name for a proposal: the edited override, or the proposed new
  // name (which for unmatched/empty rows is just the original).
  const effectiveName = (p: GroupMigrationProposal) =>
    (editedNames[p.group_id] ?? p.new_name).trim();

  // Count every group's *final* name so we can flag duplicates. Duplicate
  // names are allowed (group identity is `id`, and the UI disambiguates by
  // driver), but worth a soft heads-up — only empty names actually block.
  const nameCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (!proposals) return m;
    for (const p of proposals) {
      const nm =
        p.matched_handle !== null ? effectiveName(p) : p.original_name.trim();
      const key = nm.toLowerCase();
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposals, editedNames]);

  const collides = (p: GroupMigrationProposal) =>
    (nameCounts.get(effectiveName(p).toLowerCase()) ?? 0) > 1;
  // Only empty names block apply; duplicates are merely flagged.
  const hasBlocker = proposals
    ? proposals
        .filter((p) => p.matched_handle !== null)
        .some((p) => effectiveName(p) === "")
    : false;

  const driverListId = "migration-driver-options";

  return (
    <Modal
      title="Clean up group names"
      description={
        <span className="max-w-prose block">
          Map each driver-name prefix (a “handle”) to a driver. Preview strips
          the handle from matching group names and links the driver. Nothing is
          written until you click Apply.
        </span>
      }
      onClose={onClose}
      busy={busy}
      size="max-w-3xl"
      scroll="none"
      panelClassName="max-h-[88vh] flex flex-col"
      footer={
        <>
          <span className="flex-1 text-xs text-fg-subtle">
            {activeRules.length} active handle
            {activeRules.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={onPreview}
            disabled={busy || activeRules.length === 0}
          >
            {busy && !proposals ? "Previewing…" : "Preview changes"}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={onApply}
            disabled={
              busy || proposals === null || matchedCount === 0 || hasBlocker
            }
            title={
              proposals === null
                ? "Preview first"
                : hasBlocker
                  ? "Resolve duplicate or empty names first"
                  : "Apply the renames and driver links"
            }
          >
            {busy && proposals ? "Applying…" : "Apply"}
          </button>
        </>
      }
    >
      {error && <ErrorBanner error={error} variant="inline" className="mb-2" />}
      {info && <div className="text-xs text-emerald-400 mb-2">{info}</div>}

      <datalist id={driverListId}>
        {drivers.map((d) => (
          <option key={d.id} value={d.name} />
        ))}
      </datalist>

      <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-4 min-h-[8rem]">
        {/* Rules editor */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">
              Handle → driver ({rules.length})
            </h4>
            <button
              type="button"
              className="text-xs text-accent hover:text-accent/80"
              onClick={() => addRule()}
            >
              + Add handle
            </button>
          </div>
          <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-x-2 gap-y-1 items-center text-xs">
            <div className="text-fg-subtle">Prefix</div>
            <div className="text-fg-subtle">Driver</div>
            <div className="text-fg-subtle text-right">Matches</div>
            <div />
            {rules.map((r, i) => {
              const count = groups.filter((g) =>
                clientPrefixMatches(g.name, r.handle),
              ).length;
              const needsDriver = r.handle.trim() && !r.driverName.trim();
              return (
                <Fragment key={i}>
                  <input
                    type="text"
                    className="input !py-1 !text-xs"
                    value={r.handle}
                    onChange={(e) => updateRule(i, { handle: e.target.value })}
                    placeholder="e.g. Zilisch"
                  />
                  <input
                    type="text"
                    list={driverListId}
                    className={`input !py-1 !text-xs ${needsDriver ? "border-amber-500/50" : ""}`}
                    value={r.driverName}
                    onChange={(e) => setRuleDriver(i, e.target.value)}
                    placeholder="driver name"
                  />
                  <div className="text-right tabular-nums text-fg-muted">
                    {count}
                  </div>
                  <button
                    type="button"
                    className="link-danger px-1"
                    onClick={() => removeRule(i)}
                    title="Remove handle"
                  >
                    ×
                  </button>
                </Fragment>
              );
            })}
          </div>
          {rules.length === 0 && (
            <div className="text-xs text-fg-subtle">
              No handles yet. Add one above, or check the unmatched list.
            </div>
          )}
        </div>

        {/* Unmatched groups */}
        {unmatchedNames.length > 0 && (
          <div className="space-y-1">
            <h4 className="text-sm font-medium">
              Not matched by any handle ({unmatchedNames.length})
            </h4>
            <p className="text-[11px] text-fg-subtle">
              These groups won’t change. Click one to seed a handle from its
              first word, then assign a driver.
            </p>
            <div className="flex flex-wrap gap-1">
              {unmatchedNames.slice(0, 60).map((nm, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="text-[11px] rounded border border-border px-1.5 py-0.5 text-fg-muted hover:text-fg hover:border-fg-muted"
                  onClick={() => addRule(firstToken(nm))}
                  title={`Add handle "${firstToken(nm)}"`}
                >
                  {nm}
                </button>
              ))}
              {unmatchedNames.length > 60 && (
                <span className="text-[11px] text-fg-subtle self-center">
                  +{unmatchedNames.length - 60} more
                </span>
              )}
            </div>
          </div>
        )}

        {/* Preview */}
        {proposals && (
          <div className="space-y-1">
            <h4 className="text-sm font-medium">
              Preview — {matchedCount} of {proposals.length} groups change
            </h4>
            <div className="rounded border border-border divide-y divide-border">
              {proposals
                .filter((p) => p.matched_handle !== null)
                .map((p) => {
                  const rule = activeRules.find(
                    (r) =>
                      r.handle.toLowerCase() ===
                      (p.matched_handle ?? "").toLowerCase(),
                  );
                  const name = effectiveName(p);
                  const dup = collides(p);
                  const empty = name === "";
                  return (
                    <div
                      key={p.group_id}
                      className="px-2 py-1 text-xs flex items-center gap-2"
                    >
                      <span className="text-fg-subtle line-through truncate max-w-[12rem] shrink-0">
                        {p.original_name}
                      </span>
                      <span className="text-fg-subtle">→</span>
                      <input
                        type="text"
                        className={`input !py-0.5 !text-xs flex-1 ${
                          empty
                            ? "border-red-500/60"
                            : dup
                              ? "border-amber-500/50"
                              : ""
                        }`}
                        value={editedNames[p.group_id] ?? p.new_name}
                        onChange={(e) =>
                          setEditedNames((prev) => ({
                            ...prev,
                            [p.group_id]: e.target.value,
                          }))
                        }
                      />
                      {rule && (
                        <span className="text-[10px] rounded border border-border bg-bg-elevated px-1.5 py-0.5 text-fg-muted shrink-0">
                          {rule.driverName}
                        </span>
                      )}
                      {dup && !empty && (
                        <span
                          className="text-[10px] text-amber-400 shrink-0"
                          title="Another group will have this exact name. That's allowed — they're told apart by driver."
                        >
                          duplicate name
                        </span>
                      )}
                      {empty && (
                        <span className="text-[10px] text-red-400 shrink-0">
                          empty
                        </span>
                      )}
                    </div>
                  );
                })}
              {matchedCount === 0 && (
                <div className="px-2 py-2 text-xs text-fg-subtle">
                  No groups matched the current handles.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function RegistrySearchDialog({
  listing,
  onClose,
  onLinked,
}: {
  listing: ListingRow;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [drivers, setDrivers] = useState<FormOptionRow[]>([]);
  const [oems, setOems] = useState<FormOptionRow[]>([]);
  const [scales, setScales] = useState<FormOptionRow[]>([]);
  const [years, setYears] = useState<FormOptionRow[]>([]);
  const [brands, setBrands] = useState<FormOptionRow[]>([]);
  const [makes, setMakes] = useState<FormOptionRow[]>([]);
  const [finishes, setFinishes] = useState<FormOptionRow[]>([]);
  const [optionsLoaded, setOptionsLoaded] = useState(false);

  const [driverInput, setDriverInput] = useState("");
  const [selectedDriverGuid, setSelectedDriverGuid] = useState("");
  const [dialogYearRange, setDialogYearRange] =
    useState<YearRange>(EMPTY_YEAR_RANGE);
  const [oemInput, setOemInput] = useState("");
  const [selectedOemGuid, setSelectedOemGuid] = useState("");
  const [showAllOems, setShowAllOems] = useState(false);
  const [selectedScaleGuid, setSelectedScaleGuid] = useState("");
  const [brandInput, setBrandInput] = useState("");
  const [selectedBrandGuid, setSelectedBrandGuid] = useState("");
  const [makeInput, setMakeInput] = useState("");
  const [selectedMakeGuid, setSelectedMakeGuid] = useState("");
  const [finishInput, setFinishInput] = useState("");
  const [selectedFinishGuid, setSelectedFinishGuid] = useState("");

  const [results, setResults] = useState<ProductionSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [criteriaOpen, setCriteriaOpen] = useState(true);
  const [linkingGuid, setLinkingGuid] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadOptions() {
    setDialogError(null);
    try {
      const [d, o, s, y, b, m, f, listingCounts] = await Promise.all([
        api.listRegistryFormOptions("driver"),
        api.listRegistryFormOptions("oem"),
        api.listRegistryFormOptions("scale"),
        api.listRegistryFormOptions("year"),
        api.listRegistryFormOptions("brand"),
        api.listRegistryFormOptions("make"),
        api.listRegistryFormOptions("finish"),
        driverListingCounts(),
      ]);
      setDrivers(
        sortDriverOptions(
          d,
          (x) => x.display,
          (x) => listingCounts.get(x.normalized) ?? 0,
        ),
      );
      setOems(o);
      setScales(prepareScaleOptions(s));
      setYears(prepareYearOptions(y));
      setBrands(prepareBrandOptions(b));
      setMakes(prepareMakeOptions(m));
      setFinishes(f);
      setOptionsLoaded(true);
      prefillFromListing(d, s, y);
    } catch (e) {
      setDialogError(String(e));
    }
  }

  function prefillFromListing(
    drivers: FormOptionRow[],
    scales: FormOptionRow[],
    years: FormOptionRow[],
  ) {
    const title = listing.title.toLowerCase();
    const yearMatch = title.match(/\b(19[89]\d|20[0-3]\d)\b/);
    if (yearMatch) {
      const yearStr = yearMatch[1];
      if (years.find((y) => y.value === yearStr)) {
        const n = parseYear(yearStr);
        if (n !== null) setDialogYearRange({ from: n, to: n });
      }
    }
    const scaleMatch = title.match(/\b1\s*[:/]\s*(\d{2,3})\b/);
    if (scaleMatch) {
      const scaleDisplay = `1:${scaleMatch[1]}`;
      const found = scales.find((s) => s.display === scaleDisplay);
      if (found) setSelectedScaleGuid(found.value);
    }
    const titleTokens = new Set(title.split(/\W+/).filter((t) => t.length > 0));
    // Prefer the most specific match: "Dale Earnhardt Sr" should win over
    // "Dale Earnhardt" when both fit the title's tokens.
    let best: { display: string; value: string; len: number } | null = null;
    for (const d of drivers) {
      const dt = d.display
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0);
      if (dt.length > 0 && dt.every((t) => titleTokens.has(t))) {
        if (best === null || dt.length > best.len) {
          best = { display: d.display, value: d.value, len: dt.length };
        }
      }
    }
    if (best) {
      setDriverInput(best.display);
      setSelectedDriverGuid(best.value);
    }
  }

  async function onRefreshOptions() {
    setRefreshing(true);
    setDialogError(null);
    setInfo(null);
    try {
      const summary = await api.refreshRegistryFormOptions();
      setInfo(
        `Cached ${summary.options_upserted} options across ${summary.fields_seen} fields.`,
      );
      await loadOptions();
    } catch (e) {
      setDialogError(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function onSearch() {
    setSearching(true);
    setDialogError(null);
    setResults(null);
    try {
      const r = await api.searchDcrProduction({
        driver_guids: selectedDriverGuid ? [selectedDriverGuid] : [],
        years: yearsInRange(
          years.map((y) => y.value),
          dialogYearRange,
        ),
        oem_guids: selectedOemGuid ? [selectedOemGuid] : [],
        scale_guids: selectedScaleGuid ? [selectedScaleGuid] : [],
        brand_guids: selectedBrandGuid ? [selectedBrandGuid] : [],
        make_guids: selectedMakeGuid ? [selectedMakeGuid] : [],
        finish_guids: selectedFinishGuid ? [selectedFinishGuid] : [],
        autographed: false,
        raced: false,
      });
      setResults(r);
      // Give the results list the full height once there's something to scan;
      // the user can reopen the criteria to refine.
      if (r.length > 0) setCriteriaOpen(false);
    } catch (e) {
      setDialogError(String(e));
    } finally {
      setSearching(false);
    }
  }

  async function onLink(result: ProductionSearchResult) {
    setLinkingGuid(result.registry_guid);
    setDialogError(null);
    try {
      await api.linkListingToRegistry(
        listing.listing_id,
        result.registry_guid,
        result.detail_url,
      );
      onLinked();
    } catch (e) {
      setDialogError(String(e));
    } finally {
      setLinkingGuid(null);
    }
  }

  const optionsEmpty =
    optionsLoaded && drivers.length === 0 && oems.length === 0;

  return (
    // `header` rather than `title`/`description`: this dialog's chrome
    // carries the listing thumbnail and an out-link, which the default
    // heading block has no room for. `title` still names it for a screen
    // reader.
    <Modal
      title="Search registry"
      onClose={onClose}
      size="max-w-6xl"
      scroll="none"
      panelClassName="h-[92vh] flex flex-col"
      footer={
        <button type="button" className="btn-secondary" onClick={onClose}>
          Cancel
        </button>
      }
      header={
        <div className="flex items-start gap-3 min-w-0 flex-1">
          {listing.image_url && (
            <img
              src={listing.image_url}
              alt=""
              className="w-16 h-16 object-cover rounded border border-border flex-shrink-0"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-medium">Search registry</h3>
            <p className="text-xs text-fg-subtle mt-0.5" title={listing.title}>
              {listing.title}
            </p>
            {listing.url && (
              <a
                href={listing.url}
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(listing.url);
                }}
                className="text-xs text-accent hover:underline mt-1 inline-block"
              >
                View on eBay →
              </a>
            )}
          </div>
        </div>
      }
    >
      {!optionsLoaded ? (
        <div className="text-sm text-fg-subtle">Loading options…</div>
      ) : optionsEmpty ? (
        <div className="card text-sm text-amber-400/90 space-y-2">
          <div>
            The registry option cache is empty. Fetch it once (a few seconds) so
            the dropdowns can populate.
          </div>
          <button
            className="btn-primary"
            type="button"
            onClick={onRefreshOptions}
            disabled={refreshing}
          >
            {refreshing ? "Fetching…" : "Fetch registry options"}
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs font-medium text-fg-muted hover:text-fg"
            onClick={() => setCriteriaOpen((v) => !v)}
            aria-expanded={criteriaOpen}
          >
            <span className="text-fg-subtle">{criteriaOpen ? "▾" : "▸"}</span>
            Search criteria
          </button>
          {criteriaOpen && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-3 mt-2">
              <div>
                <label className="label">Driver</label>
                <input
                  list="dcr-drivers-list"
                  type="text"
                  value={driverInput}
                  onChange={(e) => {
                    setDriverInput(e.target.value);
                    const match = drivers.find(
                      (d) => d.display === e.target.value,
                    );
                    setSelectedDriverGuid(match?.value ?? "");
                  }}
                  className="input"
                  placeholder="Type to search…"
                  autoComplete="off"
                />
                <datalist id="dcr-drivers-list">
                  {drivers.map((d) => (
                    <option key={d.value} value={d.display} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="label">Year</label>
                {/* Auto-filled from the listing title as a one-year range,
                      which searches identically to the single year this
                      replaced — but can now be widened when the title's year
                      is the race season and the registry's is the release. */}
                <YearRangeFilter
                  id="dialog-year"
                  years={years.map((y) => y.value)}
                  value={dialogYearRange}
                  onChange={setDialogYearRange}
                />
              </div>
              <div>
                <label className="label">OEM</label>
                <input
                  list="dcr-oems-list"
                  type="text"
                  value={oemInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setOemInput(v);
                    const match = oems.find((o) => o.display === v);
                    setSelectedOemGuid(match?.value ?? "");
                  }}
                  className="input"
                  placeholder="Any (type to search…)"
                  autoComplete="off"
                />
                <datalist id="dcr-oems-list">
                  {(oemInput.trim() === "" && !showAllOems
                    ? oems.filter((o) => isPreferredOem(o.display))
                    : oems
                  ).map((o) => (
                    <option key={o.value} value={o.display} />
                  ))}
                </datalist>
                {oemInput.trim() === "" && !showAllOems && (
                  <button
                    type="button"
                    className="text-xs text-fg-subtle hover:text-fg-muted mt-1"
                    onClick={() => setShowAllOems(true)}
                  >
                    More…
                  </button>
                )}
              </div>
              <div>
                <label className="label">Scale</label>
                <select
                  value={selectedScaleGuid}
                  onChange={(e) => setSelectedScaleGuid(e.target.value)}
                  className="input"
                >
                  <option value="">Any</option>
                  {scales.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.display}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Brand</label>
                <input
                  list="dcr-brands-list"
                  type="text"
                  value={brandInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBrandInput(v);
                    const match = brands.find((b) => b.display === v);
                    setSelectedBrandGuid(match?.value ?? "");
                  }}
                  className="input"
                  placeholder="Any (type to search…)"
                  autoComplete="off"
                />
                <datalist id="dcr-brands-list">
                  {brands.map((b) => (
                    <option key={b.value} value={b.display} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="label">Make</label>
                <input
                  list="dcr-makes-list"
                  type="text"
                  value={makeInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setMakeInput(v);
                    const match = makes.find((m) => m.display === v);
                    setSelectedMakeGuid(match?.value ?? "");
                  }}
                  className="input"
                  placeholder="Any (type to search…)"
                  autoComplete="off"
                />
                <datalist id="dcr-makes-list">
                  {makes.map((m) => (
                    <option key={m.value} value={m.display} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="label">Finish</label>
                <input
                  list="dcr-finishes-list"
                  type="text"
                  value={finishInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFinishInput(v);
                    const match = finishes.find((f) => f.display === v);
                    setSelectedFinishGuid(match?.value ?? "");
                  }}
                  className="input"
                  placeholder="Any (type to search…)"
                  autoComplete="off"
                />
                <datalist id="dcr-finishes-list">
                  {finishes.map((f) => (
                    <option key={f.value} value={f.display} />
                  ))}
                </datalist>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between mt-3">
            <button
              type="button"
              className="text-xs text-fg-subtle hover:text-fg-muted"
              onClick={onRefreshOptions}
              disabled={refreshing}
              title="Re-fetch the dropdown choices from diecastregistry.com"
            >
              {refreshing ? "Refreshing options…" : "Refresh options"}
            </button>
            <button
              className="btn-primary"
              type="button"
              onClick={onSearch}
              disabled={searching}
            >
              {searching ? "Searching…" : "Search"}
            </button>
          </div>
        </>
      )}

      {info && <div className="text-xs text-emerald-400 mt-2">{info}</div>}
      {dialogError && (
        <ErrorBanner error={dialogError} variant="inline" className="mt-2" />
      )}

      <div className="flex-1 overflow-y-auto -mx-1 px-1 mt-3 space-y-1 min-h-[8rem]">
        {searching ? (
          <div className="text-sm text-fg-subtle">Searching…</div>
        ) : results === null ? null : results.length === 0 ? (
          <div className="text-sm text-fg-subtle">No results.</div>
        ) : (
          results.map((r) => (
            <button
              key={r.registry_guid}
              type="button"
              className="w-full text-left rounded-md border border-border bg-bg-elevated hover:border-accent hover:bg-accent/5 px-3 py-2 disabled:opacity-50"
              onClick={() => onLink(r)}
              disabled={linkingGuid !== null}
            >
              <div className="flex items-center gap-3">
                {r.image_url ? (
                  <img
                    src={
                      r.image_url.startsWith("http")
                        ? r.image_url
                        : "https://www.diecastregistry.com" + r.image_url
                    }
                    alt=""
                    loading="lazy"
                    className="w-48 h-48 object-cover rounded border border-border shrink-0"
                  />
                ) : (
                  <div className="w-48 h-48 rounded border border-border bg-bg shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-base font-medium truncate">
                    {r.driver_name}
                    {r.year && (
                      <span className="text-fg-subtle ml-2">{r.year}</span>
                    )}
                  </div>
                  <div className="text-sm text-fg-subtle truncate">
                    {r.scheme_text ?? "(no scheme)"}
                  </div>
                  <div className="text-xs text-fg-faint mt-0.5">
                    {[r.oem, r.brand, r.scale, r.make]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {r.seq_produced_total !== null && (
                    <div className="text-xs text-fg-faint mt-0.5">
                      production qty {formatCount(r.seq_produced_total)}
                    </div>
                  )}
                  {r.detail_url && (
                    <a
                      href={
                        r.detail_url.startsWith("http")
                          ? r.detail_url
                          : "https://www.diecastregistry.com" + r.detail_url
                      }
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const url = r.detail_url!.startsWith("http")
                          ? r.detail_url!
                          : "https://www.diecastregistry.com" + r.detail_url!;
                        void openExternal(url);
                      }}
                      className="text-xs text-accent hover:underline mt-1 inline-block"
                    >
                      View on diecastregistry.com →
                    </a>
                  )}
                </div>
                <div className="text-right text-xs tabular-nums shrink-0">
                  <div>retail {formatCents(r.retail_value_cents)}</div>
                  <div className="text-fg-subtle">
                    wholesale {formatCents(r.wholesale_value_cents)}
                  </div>
                  {linkingGuid === r.registry_guid && (
                    <div className="text-emerald-400 mt-1">Linking…</div>
                  )}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}

/** Multi-select dropdown that hides listings belonging to any checked group.
 *  Complements the include-style Group filter rather than replacing it —
 *  e.g. keep Group on "All" but hide everything already in "Purchased".
 *  Sections mirror the include dropdown (driver → other → archived), so a
 *  group with several drivers shows under each; the checkboxes share state. */
/** Header overflow menu for occasional batch actions, so they don't take
 *  up permanent button space next to the title. */
function ListingActionsMenu({
  hasListings,
  autoMatching,
  refreshing,
  onAutoMatchAll,
  onRefreshAll,
  onManageGroups,
}: {
  hasListings: boolean;
  autoMatching: boolean;
  refreshing: boolean;
  onAutoMatchAll: () => void;
  onRefreshAll: () => void;
  onManageGroups: () => void;
}) {
  const [open, setOpen] = useState(false);
  const itemClass =
    "w-full text-left px-3 py-1.5 text-xs text-fg-muted hover:text-fg hover:bg-bg disabled:opacity-50 disabled:cursor-not-allowed";
  return (
    <div className="relative">
      <button
        type="button"
        className="btn-secondary !px-2.5 !py-1 !text-xs"
        onClick={() => setOpen((v) => !v)}
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 top-full mt-1 right-0 w-44 rounded border border-border bg-bg-elevated shadow-lg py-1">
            <button
              type="button"
              className={itemClass}
              disabled={!hasListings || autoMatching}
              onClick={() => {
                setOpen(false);
                onAutoMatchAll();
              }}
              title="Search the registry for a best-effort match on every unconfirmed listing"
            >
              {autoMatching ? "Matching…" : "Auto-match all"}
            </button>
            <button
              type="button"
              className={itemClass}
              disabled={!hasListings || refreshing}
              onClick={() => {
                setOpen(false);
                onRefreshAll();
              }}
              title="Re-fetch price and status for every saved listing"
            >
              {refreshing ? "Refreshing…" : "Refresh all"}
            </button>
            <div className="border-t border-border my-1" />
            <button
              type="button"
              className={itemClass}
              onClick={() => {
                setOpen(false);
                onManageGroups();
              }}
              title="Create, rename, archive, or delete listing groups"
            >
              Manage groups…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ExcludeGroupsMenu({
  groups,
  excluded,
  onToggle,
  onClear,
}: {
  groups: ListingGroup[];
  excluded: Set<number>;
  onToggle: (groupId: number) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, query]);
  const { drivers, noDriver, archived } = useMemo(
    () => clusterGroupsByDriver(filtered),
    [filtered],
  );
  const sectionHeader = (text: string) => (
    <div className="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-fg-subtle">
      {text}
    </div>
  );
  const renderOption = (g: ListingGroup, key: string) => (
    <label
      key={key}
      className="flex items-center gap-2 px-2 py-1 text-xs cursor-pointer hover:bg-bg"
    >
      <input
        type="checkbox"
        className="accent-current"
        checked={excluded.has(g.id)}
        onChange={() => onToggle(g.id)}
      />
      <span className="truncate">
        {g.name} <span className="text-fg-subtle">({g.member_count})</span>
      </span>
    </label>
  );
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`px-2 py-0.5 rounded border text-[11px] ${
          excluded.size > 0
            ? "border-accent text-accent bg-accent/10"
            : "border-border text-fg-muted hover:text-fg"
        }`}
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        title="Hide listings that belong to any of the checked groups"
      >
        Exclude{excluded.size > 0 ? ` (${excluded.size})` : ""} ▾
      </button>
      {/* The trigger is a ~70px chip and the list under it is grouped by
          driver, so this is the one menu that has to be much wider than what
          it hangs from. */}
      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={224}
        label="Groups to exclude"
      >
        {groups.length > 0 && (
          <div className="shrink-0 px-2 pb-1">
            <input
              type="text"
              className="input !py-1 !text-xs"
              placeholder="Search groups…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
        )}
        <AnchoredMenuList>
          {groups.length === 0 ? (
            <div className="px-2 py-1 text-xs text-fg-subtle">
              No groups yet.
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-2 py-1 text-xs text-fg-subtle">
              No groups match “{query.trim()}”.
            </div>
          ) : (
            <>
              {drivers.map((d) => (
                <Fragment key={`d-${d.id}`}>
                  {sectionHeader(d.name)}
                  {d.groups.map((g) => renderOption(g, `${d.id}-${g.id}`))}
                </Fragment>
              ))}
              {noDriver.length > 0 && (
                <>
                  {sectionHeader("Other (no driver)")}
                  {noDriver.map((g) => renderOption(g, `n-${g.id}`))}
                </>
              )}
              {archived.length > 0 && (
                <>
                  {sectionHeader("Archived")}
                  {archived.map((g) => renderOption(g, `a-${g.id}`))}
                </>
              )}
            </>
          )}
        </AnchoredMenuList>
        {excluded.size > 0 && (
          <div className="shrink-0 border-t border-border mt-1 pt-1 px-2">
            <button
              type="button"
              className="text-xs text-fg-subtle hover:text-fg underline decoration-dotted underline-offset-2"
              onClick={onClear}
            >
              Clear exclusions
            </button>
          </div>
        )}
      </AnchoredMenu>
    </>
  );
}

/** Searchable multi-select of the sellers present in the loaded listings
 *  (DCH-44). A popover rather than a checkbox facet on purpose: the seller
 *  list is unbounded, and one row per seller in the sidebar is the shape
 *  DCH-43 had to undo. The trigger is a fixed height whatever is picked, and
 *  the list scrolls inside the popover. */
function SellerFilterSelect({
  options,
  selected,
  onToggle,
  onClear,
}: {
  options: SellerOption[];
  selected: Set<SellerKey>;
  onToggle: (key: SellerKey) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`input !py-1 !text-xs flex items-center justify-between gap-2 text-left ${
          selected.size > 0 ? "!border-accent text-accent" : ""
        }`}
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        title="Filter listings by eBay seller"
      >
        <span className="truncate">{sellerFilterLabel(selected, options)}</span>
        <span className="text-fg-subtle shrink-0">▾</span>
      </button>
      {/* DCH-44 hand-rolled a flip-above-the-trigger rule here, against a
          guessed worst-case popover height. `AnchoredMenu` measures the real
          room on both sides instead, so the guess — and the copy of it that
          the other two menus never had — is gone. */}
      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={192}
        label="Sellers"
      >
        {options.length > 6 && (
          <div className="shrink-0 px-2 pb-1">
            <input
              type="text"
              className="input !py-1 !text-xs"
              placeholder="Search sellers…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
        )}
        <AnchoredMenuList>
          {filtered.length === 0 ? (
            <div className="px-2 py-1 text-xs text-fg-subtle">
              No sellers match “{query.trim()}”.
            </div>
          ) : (
            filtered.map((o) => (
              <label
                // Keys are trimmed usernames, so a leading space can never
                // collide with the no-seller bucket.
                key={o.key ?? " no-seller"}
                className="flex items-center gap-2 px-2 py-1 text-xs cursor-pointer hover:bg-bg"
              >
                <input
                  type="checkbox"
                  className="accent-current"
                  checked={selected.has(o.key)}
                  onChange={() => onToggle(o.key)}
                />
                <span className="truncate">{o.label}</span>
                <span className="ml-auto text-fg-subtle tabular-nums">
                  {o.count}
                </span>
              </label>
            ))
          )}
        </AnchoredMenuList>
        {selected.size > 0 && (
          <div className="shrink-0 border-t border-border mt-1 pt-1 px-2">
            <button
              type="button"
              className="text-xs text-fg-subtle hover:text-fg underline decoration-dotted underline-offset-2"
              onClick={onClear}
            >
              Clear sellers
            </button>
          </div>
        )}
      </AnchoredMenu>
    </>
  );
}

/** Collapse/expand chevron for the filters sidebar toggle. */
function PanelChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        transform: direction === "right" ? "rotate(180deg)" : undefined,
      }}
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

/** One sidebar facet: a collapsible vertical checkbox list. Checked options
 *  OR together; none checked = no filtering. Each option shows a live result
 *  count (computed by the caller against every other active filter — "what
 *  would I see if only this were checked?").
 *
 *  Collapse state persists in the shared minimized store (DCH-43), so the
 *  panel a user shaped stays that shape. A collapsed facet with checked
 *  options wears a count badge — the DCH-35 contract holds whether or not
 *  the checkboxes are on screen. */
/**
 * One collapsible section of the filter panel (DCH-47): a chevron, the
 * section's name, and — on the right — what it is currently filtering to.
 *
 * The whole header is the toggle rather than just the chevron. Every section
 * has one now, so a row of 10×10 glyphs would be ten small targets stacked
 * an inch apart; the label and summary are dead space otherwise.
 *
 * The chevron is drawn here rather than reusing `MinimizeToggle` because
 * that component is itself a `<button>`, and a button inside a button is
 * invalid HTML that browsers resolve by dropping one of them.
 */
function FilterSection({
  sectionKey,
  label,
  defaultCollapsed,
  summary,
  hint,
  children,
}: {
  /** Facet key; namespaced into the shared collapse store by
   *  `facetSectionKey`, so DCH-43's persisted choices carry over unchanged. */
  sectionKey: string;
  label: string;
  defaultCollapsed: boolean;
  summary: FilterSummary;
  /** Tooltip for the section body, where one helps. */
  hint?: string;
  children: ReactNode;
}) {
  const [collapsed, toggleCollapsed] = useMinimized(
    facetSectionKey("listings", sectionKey),
    defaultCollapsed,
  );
  return (
    <div title={hint}>
      <button
        type="button"
        className="w-full flex items-center gap-1 py-0.5 rounded text-left hover:bg-bg-elevated"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed}
        title={`${collapsed ? "Expand" : "Collapse"} ${label} — ${summary.text}`}
      >
        <span
          className={`shrink-0 w-3 text-[8px] leading-none text-fg-subtle transition-transform ${
            collapsed ? "" : "rotate-90"
          }`}
          aria-hidden="true"
        >
          ▶
        </span>
        <span className="text-[10px] uppercase tracking-wide text-fg-subtle">
          {label}
        </span>
        {/* The DCH-35 contract for a section whose control is out of sight:
            accent whenever it is narrowing the list, so nothing that is
            filtering can be silent. `min-w-0` is what lets it truncate
            instead of shoving the label out of the panel. */}
        <span
          className={`ml-auto min-w-0 truncate text-[11px] ${
            summary.active ? "text-accent" : "text-fg-subtle"
          }`}
        >
          {summary.text}
        </span>
      </button>
      <div className={collapsed ? "hidden" : "mt-1"}>{children}</div>
    </div>
  );
}

/** A section holding one control, looked up in `LISTING_CONTROL_SECTIONS` so
 *  its label and default collapse state live in the table with the facets'
 *  rather than at the call site. */
function ControlSection({
  sectionKey,
  summary,
  children,
}: {
  sectionKey: string;
  summary: FilterSummary;
  children: ReactNode;
}) {
  const section = controlSection(sectionKey);
  return (
    <FilterSection
      sectionKey={section.key}
      label={section.label}
      defaultCollapsed={section.defaultCollapsed}
      summary={summary}
    >
      {children}
    </FilterSection>
  );
}

function FacetList({
  facet,
  selected,
  options,
  onToggle,
}: {
  facet: FacetSection;
  selected: Set<string>;
  options: { value: string; label: string; count: number }[];
  onToggle: (v: string) => void;
}) {
  return (
    <FilterSection
      sectionKey={facet.key}
      label={facet.label}
      defaultCollapsed={facet.defaultCollapsed}
      summary={facetSummary(options, selected, facet.defaultSelected)}
      hint="Check any combination — no boxes checked shows everything"
    >
      <div className="space-y-0.5">
        {options.map((opt) => {
          const active = selected.has(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              role="checkbox"
              aria-checked={active}
              className={`w-full flex items-center gap-2 px-1 py-0.5 rounded text-left text-xs ${
                active
                  ? "text-fg font-medium"
                  : "text-fg-muted hover:text-fg hover:bg-bg-elevated"
              }`}
              onClick={() => onToggle(opt.value)}
            >
              <span
                className={`w-2.5 h-2.5 rounded-sm border shrink-0 grid place-items-center ${
                  active ? "border-accent bg-accent" : "border-border"
                }`}
              >
                {active && (
                  <svg
                    viewBox="0 0 10 10"
                    className="w-2 h-2 text-bg"
                    aria-hidden="true"
                  >
                    <path
                      d="M1.5 5.5 4 8l4.5-6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span className="truncate">{opt.label}</span>
              <span className="ml-auto text-fg-subtle tabular-nums">
                {opt.count}
              </span>
            </button>
          );
        })}
      </div>
    </FilterSection>
  );
}

/** Searchable driver dropdown for the filter sidebar. Options come from the
 *  loaded listings; counts are faceted against the other active filters. */
function DriverFilterSelect({
  value,
  label,
  options,
  allCount,
  noneCount,
  onChange,
}: {
  value: string;
  label: string;
  options: { value: string; name: string; count: number }[];
  allCount: number;
  noneCount: number;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, query]);

  const optionRow = (
    optValue: string,
    optLabel: string,
    count: number | null,
  ) => {
    const active = value === optValue;
    return (
      <button
        key={optValue}
        type="button"
        className={`w-full flex items-center gap-2 px-2 py-1 text-left text-xs hover:bg-bg ${
          active ? "text-accent" : "text-fg-muted"
        }`}
        onClick={() => {
          onChange(optValue);
          setOpen(false);
        }}
      >
        <span className="truncate">{optLabel}</span>
        {count !== null && (
          <span className="ml-auto text-fg-subtle tabular-nums">{count}</span>
        )}
      </button>
    );
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="input !py-1 !text-xs flex items-center justify-between gap-2 text-left"
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        title="Filter listings by driver"
      >
        <span className="truncate">{label}</span>
        <span className="text-fg-subtle shrink-0">▾</span>
      </button>
      <AnchoredMenu
        anchorRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        minWidth={192}
        label="Drivers"
      >
        <div className="shrink-0 px-2 pb-1">
          <input
            type="text"
            className="input !py-1 !text-xs"
            placeholder="Search drivers…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <AnchoredMenuList>
          {!query.trim() && optionRow("all", "All drivers", allCount)}
          {!query.trim() && optionRow("none", "No driver", noneCount)}
          {filtered.map((o) => optionRow(o.value, o.name, o.count))}
          {filtered.length === 0 && query.trim() && (
            <div className="px-2 py-1 text-xs text-fg-subtle">
              No drivers match “{query.trim()}”.
            </div>
          )}
        </AnchoredMenuList>
      </AnchoredMenu>
    </>
  );
}

function OfferBadge({ offer }: { offer: ReceivedOffer }) {
  const parts: string[] = [];
  if (offer.offer_price_cents !== null) {
    parts.push(formatCents(offer.offer_price_cents));
  }
  if (offer.discount_percent !== null) {
    const pct = Number.isInteger(offer.discount_percent)
      ? `${offer.discount_percent}`
      : offer.discount_percent.toFixed(1);
    parts.push(`${pct}% off`);
  }
  const label =
    parts.length > 0 ? `Seller offer: ${parts.join(" · ")}` : "Seller offer";
  return (
    <a
      href={offer.item_web_url}
      onClick={(e) => {
        e.preventDefault();
        void openExternal(offer.item_web_url);
      }}
      title="A seller sent you a discount offer on this item — open eBay to accept or decline"
      className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[11px] hover:bg-emerald-500/20"
    >
      ✨ {label} →
    </a>
  );
}

/** Listings table stores eBay item ids as v1|<legacy>|0; the messages
 *  API returns just the legacy segment, so we extract it for lookups. */
function legacyIdFromExternalId(external_id: string): string {
  const parts = external_id.split("|");
  return parts.length >= 2 && /^\d+$/.test(parts[1]) ? parts[1] : external_id;
}
