import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useTheme } from "@/lib/theme";

type IconProps = { className?: string };
type IconFn = (props: IconProps) => JSX.Element;

interface NavItem {
  to: string;
  label: string;
  icon: IconFn;
  children?: NavItem[];
}

const links: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: DashboardIcon },
  { to: "/collection", label: "My Collection", icon: CollectionIcon },
  {
    to: "/ebay",
    label: "eBay",
    icon: EbayIcon,
    children: [
      { to: "/ebay/feed", label: "Seller feed", icon: FeedIcon },
      { to: "/listings", label: "Saved Listings", icon: ListingsIcon },
      { to: "/ebay/searches", label: "Saved Searches", icon: SavedSearchIcon },
      { to: "/browse", label: "Browse eBay", icon: BrowseIcon },
    ],
  },
  { to: "/registry", label: "Registry search", icon: RegistryIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

const STORAGE_KEY = "sidebar.collapsed";
const GROUP_STORAGE_PREFIX = "sidebar.group.";

export function Sidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  return (
    <aside
      className={`${collapsed ? "w-14" : "w-56"} shrink-0 border-r border-border bg-bg-panel flex flex-col transition-[width] duration-150 ease-out`}
    >
      <div
        className={`${collapsed ? "px-2" : "px-4"} py-5 border-b border-border flex items-center gap-2`}
      >
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold tracking-tight truncate">
              Diecast Hunter
            </h1>
            <p className="text-xs text-fg-subtle mt-0.5">v0.1.0</p>
          </div>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className={`${collapsed ? "mx-auto" : ""} rounded-md p-1.5 text-fg-muted hover:text-fg hover:bg-bg-elevated transition-colors shrink-0`}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ChevronIcon direction={collapsed ? "right" : "left"} />
        </button>
      </div>
      <nav className="flex-1 py-3">
        {links.map((item) =>
          item.children && item.children.length > 0 ? (
            <NavGroup key={item.to} item={item} collapsed={collapsed} />
          ) : (
            <NavRow key={item.to} item={item} collapsed={collapsed} />
          ),
        )}
      </nav>
      <ThemeToggle collapsed={collapsed} />
    </aside>
  );
}

function NavRow({
  item,
  collapsed,
  indented = false,
}: {
  item: NavItem;
  collapsed: boolean;
  indented?: boolean;
}) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `flex items-center gap-3 ${
          collapsed
            ? "justify-center px-0"
            : indented
              ? "pl-10 pr-4"
              : "px-4"
        } py-2 text-sm transition-colors ${
          isActive
            ? "bg-bg-elevated text-fg border-l-2 border-accent"
            : "text-fg-muted hover:text-fg hover:bg-bg-elevated"
        }`
      }
    >
      <Icon className="w-4 h-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </NavLink>
  );
}

function NavGroup({
  item,
  collapsed,
}: {
  item: NavItem;
  collapsed: boolean;
}) {
  const location = useLocation();
  const childPaths = useMemo(
    () => (item.children ?? []).map((c) => c.to),
    [item.children],
  );
  const childActive = childPaths.some((p) => location.pathname === p);
  const groupKey = GROUP_STORAGE_PREFIX + item.to;

  const [open, setOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem(groupKey);
    return stored === null ? true : stored === "1";
  });

  useEffect(() => {
    window.localStorage.setItem(groupKey, open ? "1" : "0");
  }, [open, groupKey]);

  // Auto-expand when a child route is active so the user sees where they are.
  useEffect(() => {
    if (childActive) setOpen(true);
  }, [childActive]);

  // When the sidebar is icon-only, flatten the group: render parent + each
  // child as a sibling icon so all destinations stay one click away.
  if (collapsed) {
    return (
      <>
        <NavRow item={item} collapsed={collapsed} />
        {(item.children ?? []).map((child) => (
          <NavRow key={child.to} item={child} collapsed={collapsed} />
        ))}
      </>
    );
  }

  const Icon = item.icon;
  const parentActive = location.pathname === item.to;

  return (
    <div>
      <div
        className={`group flex items-stretch text-sm transition-colors ${
          parentActive
            ? "bg-bg-elevated text-fg border-l-2 border-accent"
            : "text-fg-muted hover:text-fg hover:bg-bg-elevated"
        }`}
      >
        <NavLink
          to={item.to}
          className={({ isActive }) =>
            `flex-1 min-w-0 flex items-center gap-3 px-4 py-2 ${
              isActive ? "text-fg" : "text-inherit"
            }`
          }
          end
        >
          <Icon className="w-4 h-4 shrink-0" />
          <span className="truncate">{item.label}</span>
        </NavLink>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="px-2 text-fg-subtle hover:text-fg shrink-0"
          aria-label={open ? `Collapse ${item.label}` : `Expand ${item.label}`}
          aria-expanded={open}
          title={open ? `Collapse ${item.label}` : `Expand ${item.label}`}
        >
          <ChevronIcon direction={open ? "down" : "right"} />
        </button>
      </div>
      {open && (
        <div>
          {(item.children ?? []).map((child) => (
            <NavRow
              key={child.to}
              item={child}
              collapsed={collapsed}
              indented
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const { resolved, toggle } = useTheme();
  const nextLabel = resolved === "dark" ? "Light mode" : "Dark mode";
  return (
    <div className="border-t border-border px-3 py-3">
      <button
        type="button"
        onClick={toggle}
        className={`w-full flex items-center ${
          collapsed ? "justify-center" : "justify-between"
        } gap-2 rounded-md px-2 py-1.5 text-xs text-fg-muted hover:text-fg hover:bg-bg-elevated transition-colors`}
        title={`Switch to ${nextLabel.toLowerCase()}`}
        aria-label={`Switch to ${nextLabel.toLowerCase()}`}
      >
        <span className="flex items-center gap-2">
          <ThemeIcon resolved={resolved} />
          {!collapsed && <span>{resolved === "dark" ? "Dark" : "Light"}</span>}
        </span>
        {!collapsed && <span className="text-fg-subtle">→ {nextLabel}</span>}
      </button>
    </div>
  );
}

function ChevronIcon({
  direction,
}: {
  direction: "left" | "right" | "down";
}) {
  const rotate =
    direction === "right" ? 180 : direction === "down" ? 270 : 0;
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
        transform: `rotate(${rotate}deg)`,
        transition: "transform 150ms ease",
      }}
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ThemeIcon({ resolved }: { resolved: "light" | "dark" }) {
  if (resolved === "dark") {
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
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );
  }
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
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function iconSvg(children: JSX.Element, className?: string) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function DashboardIcon({ className }: IconProps) {
  return iconSvg(
    <>
      <rect x="3" y="3" width="7" height="9" />
      <rect x="14" y="3" width="7" height="5" />
      <rect x="14" y="12" width="7" height="9" />
      <rect x="3" y="16" width="7" height="5" />
    </>,
    className,
  );
}

function CollectionIcon({ className }: IconProps) {
  return iconSvg(
    <>
      <path d="M14 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l3 3v11a2 2 0 0 1-2 2z" />
      <path d="M8 21h9a2 2 0 0 0 2-2V8" />
    </>,
    className,
  );
}

function ListingsIcon({ className }: IconProps) {
  return iconSvg(
    <>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </>,
    className,
  );
}

function BrowseIcon({ className }: IconProps) {
  return iconSvg(
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
    className,
  );
}

function EbayIcon({ className }: IconProps) {
  // Price-tag glyph: stands in well for "marketplace listing" without
  // borrowing the eBay logo (trademark).
  return iconSvg(
    <>
      <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </>,
    className,
  );
}

function RegistryIcon({ className }: IconProps) {
  return iconSvg(
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>,
    className,
  );
}

function FeedIcon({ className }: IconProps) {
  // Concentric arcs + dot — universal "feed / broadcast" glyph.
  return iconSvg(
    <>
      <path d="M4 11a9 9 0 0 1 9 9" />
      <path d="M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1.5" />
    </>,
    className,
  );
}

function SavedSearchIcon({ className }: IconProps) {
  // Magnifier with a star — "saved search".
  return iconSvg(
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <polygon points="11 7.5 12.1 9.7 14.5 10 12.8 11.7 13.2 14 11 12.9 8.8 14 9.2 11.7 7.5 10 9.9 9.7 11 7.5" />
    </>,
    className,
  );
}

function SettingsIcon({ className }: IconProps) {
  return iconSvg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>,
    className,
  );
}
