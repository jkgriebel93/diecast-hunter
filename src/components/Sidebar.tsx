import { NavLink } from "react-router-dom";

const links = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/collection", label: "My Collection" },
  { to: "/listings", label: "Saved Listings" },
  { to: "/browse", label: "Browse eBay" },
  { to: "/offers", label: "Offers" },
  { to: "/settings", label: "Settings" },
];

export function Sidebar() {
  return (
    <aside className="w-56 shrink-0 border-r border-border bg-bg-panel flex flex-col">
      <div className="px-4 py-5 border-b border-border">
        <h1 className="text-lg font-semibold tracking-tight">Diecast Hunter</h1>
        <p className="text-xs text-slate-500 mt-0.5">v0.1.0</p>
      </div>
      <nav className="flex-1 py-3">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) =>
              `block px-4 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-bg-elevated text-white border-l-2 border-accent"
                  : "text-slate-400 hover:text-slate-100 hover:bg-bg-elevated"
              }`
            }
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
