import { Dashboard } from "@/pages/Dashboard";
import { Collection } from "@/pages/Collection";
import { Ebay } from "@/pages/Ebay";
import { SellerFeed } from "@/pages/SellerFeed";
import { SavedSearches } from "@/pages/SavedSearches";
import { Listings } from "@/pages/Listings";
import { Browse } from "@/pages/Browse";
import { Registry } from "@/pages/Registry";
import { Wishlist } from "@/pages/Wishlist";
import { Settings } from "@/pages/Settings";

/**
 * A "view" is one of the app's pages, addressed by a stable id. The ids match
 * the old router paths so existing nav definitions and any persisted state keep
 * working. The split-view workspace (src/lib/workspace.tsx) renders these
 * directly inside panes instead of routing to a single one at a time — pages
 * are zero-prop, self-contained components that don't read the router, so this
 * is just a matter of picking which component to mount where.
 */
export type ViewId =
  | "/dashboard"
  | "/collection"
  | "/ebay"
  | "/ebay/feed"
  | "/ebay/searches"
  | "/listings"
  | "/browse"
  | "/registry"
  | "/wishlist"
  | "/settings";

export interface ViewDef {
  id: ViewId;
  label: string;
  Component: () => JSX.Element;
}

export const VIEWS: Record<ViewId, ViewDef> = {
  "/dashboard": { id: "/dashboard", label: "Dashboard", Component: Dashboard },
  "/collection": {
    id: "/collection",
    label: "My Collection",
    Component: Collection,
  },
  "/ebay": { id: "/ebay", label: "eBay", Component: Ebay },
  "/ebay/feed": {
    id: "/ebay/feed",
    label: "Seller feed",
    Component: SellerFeed,
  },
  "/ebay/searches": {
    id: "/ebay/searches",
    label: "Saved Searches",
    Component: SavedSearches,
  },
  "/listings": {
    id: "/listings",
    label: "Saved Listings",
    Component: Listings,
  },
  "/browse": { id: "/browse", label: "Browse eBay", Component: Browse },
  "/registry": {
    id: "/registry",
    label: "Registry search",
    Component: Registry,
  },
  "/wishlist": { id: "/wishlist", label: "Wishlist", Component: Wishlist },
  "/settings": { id: "/settings", label: "Settings", Component: Settings },
};

export const DEFAULT_VIEW: ViewId = "/dashboard";

export function isViewId(value: string): value is ViewId {
  return Object.prototype.hasOwnProperty.call(VIEWS, value);
}
