/** Mechanical enforcement of the two UI conventions in DCH-34.
 *
 *  DCH-17 shipped `formatCount` and DCH-18 shipped `ErrorBanner`, and both
 *  were then bypassed at call sites that already existed — DCH-19's audit
 *  found nineteen raw `toLocaleString()` calls and a hand-rolled error box
 *  months after the helpers landed. Fixing those once only holds until the
 *  next page is written.
 *
 *  So these are tests rather than a checklist line. A reviewer will not
 *  reliably notice a twentieth `toLocaleString()`; `pnpm test` will.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src/pages", "src/components"];

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
          out.push(p);
      }
    };
    walk(root);
  }
  return out.sort();
}

/** Every `file:line` whose text matches, as "path:N — <line>" for readable
 *  failure output. A bare count would tell you a rule broke but not where. */
function violations(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles()) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${file}:${i + 1} — ${line.trim()}`);
      });
  }
  return hits;
}

describe("number formatting goes through the shared helpers", () => {
  it("has no raw toLocaleString() under src/pages or src/components", () => {
    // `formatCount` for quantities, `formatCents` for money, and
    // `formatDateTime` for stored Unix timestamps. Each renders an em dash
    // for null; `toLocaleString()` renders "" or "Invalid Date" instead,
    // which is the actual user-visible defect this rule prevents.
    //
    // The one legitimate call lives inside `formatDateTime` in format.ts,
    // which is outside the scanned roots.
    expect(violations(/\.toLocaleString\(/)).toEqual([]);
  });
});

describe("errors go through ErrorBanner", () => {
  /** The error-box look DCH-18 replaced: a tinted red container holding a
   *  message. Hover states on destructive buttons (`hover:text-red-400`)
   *  and status glyphs are a different thing and deliberately not matched —
   *  the button-styling question is DCH-33's. */
  const ERROR_BOX = /border-red-500\/40[^"'`]*bg-red-500\/10/;

  /** Two exemptions, both checked by eye:
   *
   *  - `TrainingBanner` tints itself red on a failed training run, but the
   *    message is ours and it is a status banner, not an error report.
   *  - `ManualEntryDialog`'s list is client-side validation text, already
   *    written for a person. `describeError` would retitle it "Something
   *    went wrong." and hide the real message behind a disclosure. Its
   *    *save* failure is a backend error and does use `ErrorBanner`. */
  const ALLOWED = [
    "src/components/TrainingBanner.tsx",
    "src/components/ManualEntryDialog.tsx",
  ];

  it("has no hand-rolled error boxes outside the known exemptions", () => {
    const hits = violations(ERROR_BOX).filter(
      (h) => !ALLOWED.some((a) => h.startsWith(a)),
    );
    expect(hits).toEqual([]);
  });

  it("keeps the exemption list honest", () => {
    // An exemption that no longer matches anything is stale, and a stale
    // allowlist quietly widens over time. Fail so it gets deleted.
    const hits = violations(ERROR_BOX);
    for (const allowed of ALLOWED) {
      expect(
        hits.some((h) => h.startsWith(allowed)),
        `${allowed} is on the allowlist but has no error box — drop it`,
      ).toBe(true);
    }
  });
});
