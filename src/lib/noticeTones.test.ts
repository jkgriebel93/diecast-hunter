import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** `NoticeBanner` is the third message channel (DCH-36), and its whole job is
 *  being *distinguishable* from the other two. That's a claim about the
 *  colours it resolves, so it's worth asserting rather than eyeballing —
 *  a tone that silently reused `ErrorBanner`'s red would look correct in
 *  review and be wrong in exactly the case the ticket exists for. */
/** Comments stripped: the component's own doc comment explains the defect by
 *  naming `describeError` and the disclosure, and prose about a rule must not
 *  read as a breach of it. */
const SRC = readFileSync("src/components/NoticeBanner.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const CSS = readFileSync("src/index.css", "utf8");

describe("notice tones", () => {
  it("ships both tones", () => {
    expect(SRC).toMatch(/success:\s*\{/);
    expect(SRC).toMatch(/warning:\s*\{/);
  });

  it("never uses the danger ramp", () => {
    // Partial success is not failure. Colouring it red tells the user to
    // undo something that actually went through.
    expect(SRC).not.toMatch(/danger/);
    expect(SRC).not.toMatch(/text-red-|bg-red-|border-red-/);
  });

  it("resolves warning through theme variables, not a raw palette amber", () => {
    // The amber used elsewhere was chosen against the dark page and has no
    // light-mode override, so it washes out on white.
    expect(SRC).toMatch(/text-warning-fg/);
    expect(SRC).not.toMatch(/text-amber-/);
  });

  it("defines the warning ramp for both themes", () => {
    const light = CSS.slice(CSS.indexOf(":root"), CSS.indexOf("html.dark"));
    const dark = CSS.slice(CSS.indexOf("html.dark"));
    expect(light).toMatch(/--color-warning-fg:/);
    expect(dark).toMatch(/--color-warning-fg:/);
  });

  it("gives the two themes different warning text colours", () => {
    // If they matched, one of them is wrong — that's the bug being fixed.
    const grab = (scope: string) =>
      scope.match(/--color-warning-fg:\s*([^;]+);/)?.[1].trim();
    const light = grab(
      CSS.slice(CSS.indexOf(":root"), CSS.indexOf("html.dark")),
    );
    const dark = grab(CSS.slice(CSS.indexOf("html.dark")));
    expect(light).toBeTruthy();
    expect(dark).toBeTruthy();
    expect(light).not.toBe(dark);
  });

  it("renders authored text verbatim — never re-titled, never collapsed", () => {
    // The defect this component exists to fix was authored prose being
    // retitled and hidden behind a disclosure triangle.
    expect(SRC).not.toMatch(/describeError/);
    expect(SRC).not.toMatch(/<details/);
    expect(SRC).not.toMatch(/Technical details/);
  });

  it("announces as status rather than alert", () => {
    // These fire after an action completed; interrupting a screen reader
    // would overstate them.
    expect(SRC).toMatch(/role="status"/);
    expect(SRC).not.toMatch(/role="alert"/);
  });
});
