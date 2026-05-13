import { NavLink } from "react-router-dom";
import { useTheme } from "@/lib/theme";

const links = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/collection", label: "My Collection" },
  { to: "/listings", label: "Saved Listings" },
  { to: "/browse", label: "Browse eBay" },
  { to: "/registry", label: "Registry search" },
  { to: "/settings", label: "Settings" },
];

export function Sidebar() {
  return (
    <aside className="w-56 shrink-0 border-r border-border bg-bg-panel flex flex-col">
      <div className="px-4 py-5 border-b border-border">
        <h1 className="text-lg font-semibold tracking-tight">Diecast Hunter</h1>
        <p className="text-xs text-fg-subtle mt-0.5">v0.1.0</p>
      </div>
      <nav className="flex-1 py-3">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) =>
              `block px-4 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-bg-elevated text-fg border-l-2 border-accent"
                  : "text-fg-muted hover:text-fg hover:bg-bg-elevated"
              }`
            }
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
      <ThemeToggle />
    </aside>
  );
}

function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  const nextLabel = resolved === "dark" ? "Light mode" : "Dark mode";
  return (
    <div className="border-t border-border px-3 py-3">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs text-fg-muted hover:text-fg hover:bg-bg-elevated transition-colors"
        title={`Switch to ${nextLabel.toLowerCase()}`}
      >
        <span className="flex items-center gap-2">
          <ThemeIcon resolved={resolved} />
          <span>{resolved === "dark" ? "Dark" : "Light"}</span>
        </span>
        <span className="text-fg-subtle">→ {nextLabel}</span>
      </button>
    </div>
  );
}

function ThemeIcon({ resolved }: { resolved: "light" | "dark" }) {
  if (resolved === "dark") {
    // Moon
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
  // Sun
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
