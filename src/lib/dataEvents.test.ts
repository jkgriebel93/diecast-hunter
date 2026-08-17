// The bus half of DCH-71. The refresh behaviour itself lives in the pages
// (each subscriber re-runs its own load function, which only replaces state
// on success — that's the failed-refresh-keeps-the-old-list guarantee);
// what's pinned here is the delivery contract those pages rely on.
import { beforeEach, describe, expect, it } from "vitest";
import {
  emitDataChanged,
  onDataChanged,
  resetDataListeners,
} from "./dataEvents";

beforeEach(() => resetDataListeners());

describe("dataEvents", () => {
  it("delivers an emit to subscribers of that topic only", () => {
    const calls: string[] = [];
    onDataChanged("drivers", () => calls.push("drivers"));
    onDataChanged("registry-options", () => calls.push("options"));

    emitDataChanged("drivers");

    expect(calls).toEqual(["drivers"]);
  });

  it("stops delivering after unsubscribe", () => {
    let calls = 0;
    const off = onDataChanged("drivers", () => calls++);
    emitDataChanged("drivers");
    off();
    emitDataChanged("drivers");
    expect(calls).toBe(1);
  });

  it("keeps notifying later subscribers when an earlier one throws", () => {
    // One page's broken handler must not leave every other page stale.
    let reached = false;
    onDataChanged("drivers", () => {
      throw new Error("broken subscriber");
    });
    onDataChanged("drivers", () => {
      reached = true;
    });

    expect(() => emitDataChanged("drivers")).not.toThrow();
    expect(reached).toBe(true);
  });

  it("tolerates a subscriber unsubscribing itself mid-emit", () => {
    const calls: string[] = [];
    const off = onDataChanged("drivers", () => {
      calls.push("first");
      off();
    });
    onDataChanged("drivers", () => calls.push("second"));

    emitDataChanged("drivers");

    expect(calls).toEqual(["first", "second"]);
  });

  it("is a no-op with no subscribers", () => {
    expect(() => emitDataChanged("registry-options")).not.toThrow();
  });
});
