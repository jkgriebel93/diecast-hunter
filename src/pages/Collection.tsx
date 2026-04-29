export function Collection() {
  return (
    <div className="p-6 space-y-4">
      <header>
        <h2 className="text-2xl font-semibold">My Collection</h2>
        <p className="text-sm text-slate-500">
          Imported from diecastregistry.com.
        </p>
      </header>
      <div className="card text-sm text-slate-400">
        Empty. Run a sync from Settings once credentials are configured.
      </div>
    </div>
  );
}
