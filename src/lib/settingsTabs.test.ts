import { describe, expect, it } from "vitest";
import { SETTINGS_TABS, isSettingsTab } from "@/pages/Settings";

/** The tab id is persisted to localStorage so Settings reopens where you
 *  left it. That makes the id a stored value, and a stored value read back
 *  after a rename or a removed tab has to fail closed rather than leaving
 *  the screen on a tab that renders nothing (DCH-21). */
describe("settings tab ids", () => {
  it("accepts every tab it ships with", () => {
    for (const t of SETTINGS_TABS) expect(isSettingsTab(t.id)).toBe(true);
  });

  it("rejects anything else, including what localStorage can hand back", () => {
    // `getItem` returns null for a missing key, and a stale value survives
    // a rename — both reach the guard.
    expect(isSettingsTab(null)).toBe(false);
    expect(isSettingsTab(undefined)).toBe(false);
    expect(isSettingsTab("")).toBe(false);
    expect(isSettingsTab("appearance")).toBe(false);
    expect(isSettingsTab(0)).toBe(false);
  });

  it("keeps ids url-safe and stable-looking", () => {
    // They end up in localStorage, so a stray space or capital would be a
    // silent migration the next time someone tidied them.
    for (const t of SETTINGS_TABS) expect(t.id).toMatch(/^[a-z][a-z-]*$/);
  });

  it("has no duplicate ids or labels", () => {
    const ids = SETTINGS_TABS.map((t) => t.id);
    const labels = SETTINGS_TABS.map((t) => t.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
