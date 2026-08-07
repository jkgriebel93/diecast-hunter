import { beforeEach, describe, expect, it, vi } from "vitest";

/** The store reads localStorage once at module load, so each case needs a
 *  fresh module with storage already seeded. */
async function loadStore(seed?: Record<string, string>) {
  const backing = new Map<string, string>(Object.entries(seed ?? {}));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  });
  vi.resetModules();
  const mod = await import("./minimized");
  return { mod, backing };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("collapse state defaults", () => {
  it("returns the caller's default when the user has no opinion", async () => {
    // The whole reason for v2 (DCH-20): Saved Listings wants cards collapsed
    // by default while Collection wants them open. With a bare set of
    // collapsed keys, absence had to mean expanded and no page could differ.
    const { mod } = await loadStore();
    expect(mod.minimizedState("listing:1")).toBeNull();
  });

  it("remembers an explicit choice that matches the default", async () => {
    // Collapsing a card on a default-collapsed screen, expanding it, then
    // collapsing it again must persist — not fall back to "no opinion".
    const { mod } = await loadStore();
    mod.setMinimized("listing:1", false);
    expect(mod.minimizedState("listing:1")).toBe(false);
    mod.setMinimized("listing:1", true);
    expect(mod.minimizedState("listing:1")).toBe(true);
  });
});

describe("v1 → v2 migration", () => {
  it("carries collapsed cards across the format change", async () => {
    // v1 stored an array of collapsed keys. Dropping it would spring every
    // collapsed card open on upgrade.
    const { mod } = await loadStore({
      "minimized-items.v1": JSON.stringify(["registry:abc", "listing:7"]),
    });
    expect(mod.minimizedState("registry:abc")).toBe(true);
    expect(mod.minimizedState("listing:7")).toBe(true);
    expect(mod.minimizedState("listing:8")).toBeNull();
  });

  it("prefers v2 when both exist", async () => {
    const { mod } = await loadStore({
      "minimized-items.v1": JSON.stringify(["listing:7"]),
      "minimized-items.v2": JSON.stringify({ "listing:7": false }),
    });
    expect(mod.minimizedState("listing:7")).toBe(false);
  });

  it("survives junk in storage rather than throwing at import", async () => {
    // A corrupt value must not take the whole app down on load.
    const { mod } = await loadStore({ "minimized-items.v2": "{not json" });
    expect(mod.minimizedState("listing:1")).toBeNull();
  });

  it("ignores non-boolean values", async () => {
    const { mod } = await loadStore({
      "minimized-items.v2": JSON.stringify({ a: "yes", b: true }),
    });
    expect(mod.minimizedState("a")).toBeNull();
    expect(mod.minimizedState("b")).toBe(true);
  });
});

describe("bulk set", () => {
  it("writes an explicit value for every key", async () => {
    const { mod } = await loadStore();
    mod.setManyMinimized(["a", "b"], true);
    expect(mod.minimizedState("a")).toBe(true);
    expect(mod.minimizedState("b")).toBe(true);

    mod.setManyMinimized(["a", "b"], false);
    expect(mod.minimizedState("a")).toBe(false);
    expect(mod.minimizedState("b")).toBe(false);
  });

  it("persists so the choice survives a reload", async () => {
    const { mod, backing } = await loadStore();
    mod.setMinimized("listing:1", true);
    expect(
      JSON.parse(backing.get("minimized-items.v2") ?? "{}")["listing:1"],
    ).toBe(true);
  });
});
