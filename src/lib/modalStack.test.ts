import { beforeEach, describe, expect, it } from "vitest";
import {
  depthOf,
  isTopmost,
  openCount,
  popModal,
  pushModal,
  resetModalStack,
} from "./modalStack";
import { layerClass } from "@/components/Modal";

beforeEach(resetModalStack);

describe("modal stack", () => {
  it("reports the last-opened dialog as topmost", () => {
    pushModal("groups");
    expect(isTopmost("groups")).toBe(true);

    pushModal("group-editor");
    // The whole point: with two dialogs open, Escape must reach only the
    // inner one. Both have a window listener attached.
    expect(isTopmost("group-editor")).toBe(true);
    expect(isTopmost("groups")).toBe(false);
  });

  it("restores the parent to topmost when the child closes", () => {
    pushModal("groups");
    pushModal("group-editor");
    popModal("group-editor");

    expect(isTopmost("groups")).toBe(true);
    expect(openCount()).toBe(1);
  });

  it("treats an unregistered id as neither topmost nor nested", () => {
    // A modal that somehow missed registration should stay inert rather
    // than steal Escape from whatever is actually on top.
    pushModal("groups");
    expect(isTopmost("ghost")).toBe(false);
    expect(depthOf("ghost")).toBe(0);
  });

  it("reports nothing as topmost when nothing is open", () => {
    expect(isTopmost("groups")).toBe(false);
    expect(openCount()).toBe(0);
  });

  it("assigns depth by open order", () => {
    pushModal("a");
    pushModal("b");
    pushModal("c");

    expect(depthOf("a")).toBe(0);
    expect(depthOf("b")).toBe(1);
    expect(depthOf("c")).toBe(2);
  });

  it("ignores a duplicate push", () => {
    // React invokes effects twice in StrictMode. A second push of the same
    // id would otherwise leave a stale entry behind on unmount and make
    // every subsequent depth wrong.
    pushModal("groups");
    pushModal("groups");

    expect(openCount()).toBe(1);
    popModal("groups");
    expect(openCount()).toBe(0);
  });

  it("tolerates popping something that was never pushed", () => {
    pushModal("groups");
    popModal("never-opened");

    expect(openCount()).toBe(1);
    expect(isTopmost("groups")).toBe(true);
  });

  it("closes out of order without stranding entries", () => {
    // Not a normal flow, but a parent whose state clears while a child is
    // still mounted would produce it, and the survivor must still be
    // reachable by Escape.
    pushModal("outer");
    pushModal("inner");
    popModal("outer");

    expect(openCount()).toBe(1);
    expect(isTopmost("inner")).toBe(true);
    expect(depthOf("inner")).toBe(0);
  });
});

describe("layerClass", () => {
  it("puts the base modal at z-50 and anything nested at z-60", () => {
    expect(layerClass(0)).toBe("z-50");
    expect(layerClass(1)).toBe("z-60");
  });

  it("clamps rather than inventing a layer for deep nesting", () => {
    // Three-deep isn't a flow the app has, but if one appears it should
    // stack above the page rather than fall off the documented scale.
    expect(layerClass(2)).toBe("z-60");
    expect(layerClass(9)).toBe("z-60");
  });
});
