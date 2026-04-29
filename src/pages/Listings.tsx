export function Listings() {
  return (
    <div className="p-6 space-y-4">
      <header>
        <h2 className="text-2xl font-semibold">Saved Listings</h2>
        <p className="text-sm text-slate-500">
          Grouped by driver. Add listings via the browser extension.
        </p>
      </header>
      <div className="card text-sm text-slate-400">
        No listings tracked yet.
      </div>
    </div>
  );
}
