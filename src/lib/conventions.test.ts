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
/** A line that is entirely a comment. These rules are about what the code
 *  does, and prose explaining *why* a rule exists routinely has to name the
 *  thing it forbids — the comment above `ActivityBar`'s z-index says "it was
 *  z-50", and that must not read as a violation. Only whole-line comments
 *  are skipped; a trailing `// z-50` after real code still counts, because
 *  the code on that line is what matters. */
const COMMENT_LINE = /^\s*(\/\/|\/?\*|\{\/\*)/;

function violations(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles()) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (COMMENT_LINE.test(line)) return;
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

describe("dialogs go through the shared Modal", () => {
  /** The hand-rolled dialog shape DCH-32 replaced: a full-viewport backdrop
   *  with a tint. Ten of these disagreed on z-layer, vertical placement,
   *  Escape handling and whether a screen reader was told a dialog had
   *  opened. `Modal` owns all of it now.
   *
   *  Deliberately narrower than `fixed inset-0` on its own — that also
   *  matches the invisible click-catching scrims under dropdown menus, which
   *  are not dialogs and must stay. The `bg-black/` tint is what makes it a
   *  modal backdrop. */
  const BACKDROP = /fixed inset-0[^"'`]*bg-black\//;

  it("has no hand-rolled modal backdrops outside Modal.tsx", () => {
    const hits = violations(BACKDROP).filter(
      (h) => !h.startsWith("src/components/Modal.tsx"),
    );
    expect(hits).toEqual([]);
  });

  it("keeps every dialog's ARIA contract in one place", () => {
    // A second `role="dialog"` in the tree means someone rebuilt the
    // wrapper rather than using Modal, and with it the odds that Escape,
    // aria-modal or the accessible name were forgotten.
    const hits = violations(/role="dialog"/).filter(
      (h) => !h.startsWith("src/components/Modal.tsx"),
    );
    expect(hits).toEqual([]);
  });
});

describe("the z-scale stays documented", () => {
  /** 30 dropdown scrim and sticky page furniture · 40 dropdown menus and
   *  app banners · 50 modal · 60 modal-over-modal. See CLAUDE.md.
   *
   *  Arbitrary bracket values are what the scale is meant to replace: they
   *  read as one-off decisions and can't be grepped as a set. `z-60` is a
   *  real class because tailwind.config.js extends Tailwind's scale, which
   *  stops at 50.
   *
   *  Note the wording avoids spelling out a bracketed z-class literally.
   *  Tailwind scans this file — `src/**` is its content glob, comments
   *  included — so naming one here would emit a real, unused utility. */
  const ALLOWED = new Set(["z-30", "z-40", "z-50", "z-60"]);

  it("uses only the four named layers", () => {
    const bad = violations(/\bz-\[?\d+\]?/).filter((hit) => {
      const cls = hit.match(/\bz-\[?\d+\]?/)?.[0] ?? "";
      return !ALLOWED.has(cls);
    });
    expect(bad).toEqual([]);
  });

  it("reserves z-50 and above for dialogs", () => {
    // A banner or dropdown that reaches the modal layer paints over an open
    // dialog, which is the bug that put ActivityBar at z-50 before DCH-32.
    const hits = violations(/\bz-(50|60)\b/).filter(
      (h) => !h.startsWith("src/components/Modal.tsx"),
    );
    expect(hits).toEqual([]);
  });
});
