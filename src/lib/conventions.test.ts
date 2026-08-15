/** Mechanical enforcement of the UI conventions in CLAUDE.md — number and
 *  date formatting (DCH-34), `ErrorBanner` (DCH-18/34), `Modal` and the
 *  z-scale (DCH-32), and the danger classes (DCH-33).
 *
 *  These are tests rather than checklist lines because the checklist has
 *  been tried. DCH-17 shipped `formatCount` and DCH-18 shipped `ErrorBanner`,
 *  and
 *  both were bypassed at call sites for months afterwards — DCH-19's audit
 *  found nineteen raw `toLocaleString()` calls and counting. Fixing those
 *  once only holds until the next page is written.
 *
 *  A reviewer will not reliably notice the twentieth violation. `pnpm test`
 *  will, and it names the file and line.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isConventionalSortValue } from "./sortOptions";

const ROOTS = ["src/pages", "src/components"];

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
          out.push(posix(p));
      }
    };
    walk(root);
  }
  return out.sort();
}

/** Forward slashes regardless of platform. Every allowlist entry below is
 *  written `src/components/Foo.tsx`, and `join` yields backslashes on
 *  Windows — which is the app's only shipping target, so the whole suite
 *  failed there while passing on the Linux CI runner. An exemption that only
 *  matches on some machines is worse than none: it turns "this rule is
 *  satisfied" into "this rule wasn't checked here". */
function posix(p: string): string {
  return p.split(sep).join("/");
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
    //
    // `toLocaleTimeString` and `toLocaleDateString` are matched too. The
    // original DCH-34 rule only caught `toLocaleString` exactly, and a
    // `toLocaleTimeString` in Settings sat under it untouched — same
    // defect, different method name.
    expect(violations(/\.toLocale(String|TimeString|DateString)\(/)).toEqual(
      [],
    );
  });
});

describe("errors go through ErrorBanner", () => {
  /** The error-box look DCH-18 replaced: a tinted red container holding a
   *  message. Status glyphs and destructive-control styling are different
   *  things and deliberately not matched here — the latter is DCH-33's, and
   *  has its own rule below. */
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

describe("destructive controls use the shared danger classes", () => {
  /** `.link-danger` and `.btn-danger` (DCH-33) are the only two treatments
   *  for a Remove / Delete / Disconnect / Unwatch. Before them, sixteen
   *  controls were styled inline across three different reds, and most sat
   *  at `text-fg-subtle` at rest — fainter than the harmless "Edit" beside
   *  them, which is backwards.
   *
   *  A red *hover* is the giveaway: it only ever appears on something
   *  interactive, so it is a precise proxy for "someone hand-styled a
   *  destructive control" without needing to parse JSX to find out whether
   *  a given `text-red-*` sits on a button or on a status glyph. Static
   *  reds are left alone deliberately — error text, validation lists,
   *  the deal-score badge and the sync-failure ✗ are not controls. */
  it("has no hand-styled destructive hover states", () => {
    expect(violations(/hover:(text|bg|border)-red-/)).toEqual([]);
  });

  it("keeps the danger ramp in the stylesheet, not at call sites", () => {
    // `.btn-danger`/`.link-danger` resolve `--color-danger*`, so a red that
    // needs to differ per theme is defined once. A raw palette red on an
    // interactive element bypasses the light-mode contrast handling too.
    const css = readFileSync("src/index.css", "utf8");
    expect(css).toMatch(/\.btn-danger\s*\{/);
    expect(css).toMatch(/\.link-danger\s*\{/);
    expect(css).toMatch(/--color-danger:/);
  });
});

describe("sort dropdowns share one vocabulary", () => {
  /** DCH-35. The same concept was spelled three ways: driver A–Z was
   *  `driver-asc`, a bare `driver`, and `name`. A value with no direction in
   *  it is the specific defect — two screens can't agree on which way
   *  `driver` sorts, and the label is the only clue.
   *
   *  `isConventionalSortValue` lives in `lib/sortOptions.ts` so the rule and
   *  the vocabulary can't drift apart, and so its exemptions (eBay's wire
   *  values, orderings with no axis) are stated once. */
  it("uses field-asc / field-desc for every option value", () => {
    const bad: string[] = [];
    for (const file of sourceFiles()) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (COMMENT_LINE.test(line)) return;
          for (const m of line.matchAll(/<option value="([^"]*)"/g)) {
            const v = m[1];
            // Option values are also used for non-sort selects (a group
            // picker, a condition list). Only flag ones that look like an
            // ordering: a known sort field, or something already carrying a
            // direction suffix.
            if (
              !/^(driver|year|name|title|price|total|deal|retail|qty|count|value|seen|ending|production)/.test(
                v,
              )
            ) {
              continue;
            }
            if (!isConventionalSortValue(v)) {
              bad.push(`${file}:${i + 1} — value="${v}"`);
            }
          }
        });
    }
    expect(bad).toEqual([]);
  });

  it("has no parenthesised arrow labels", () => {
    // Listings had "Name (A→Z)" against everyone else's "Driver A → Z".
    expect(violations(/\([A-Za-z]+\s*→\s*[A-Za-z]+\)/)).toEqual([]);
  });
});

describe("authored messages don't go through ErrorBanner", () => {
  /** `ErrorBanner` runs its input through `describeError`, which classifies
   *  Rust `AppError` strings. Hand it a sentence we wrote and nothing
   *  matches, so it renders "Something went wrong." with the real text
   *  collapsed into a disclosure (DCH-36). Two watch actions hit that and
   *  told the user the opposite of what happened — the eBay side had
   *  succeeded.
   *
   *  A template literal passed to a `set*Error` setter is the precise
   *  signature: interpolation means a sentence was composed here rather than
   *  thrown by the backend. Every other error setter in the app passes
   *  `String(e)` or a caught value, so this rule currently has no
   *  exemptions — authored text goes to `NoticeBanner` instead. */
  it("has no set*Error called with a composed string", () => {
    const hits: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/set[A-Za-z]*Error\(\s*\n?\s*`([^`]*)`/g)) {
        // Only flag interpolated prose. A bare backtick string with no
        // substitution is just a quoted constant.
        if (!m[1].includes("${")) continue;
        const line = src.slice(0, m.index).split("\n").length;
        hits.push(`${file}:${line} — ${m[0].slice(0, 60)}…`);
      }
    }
    expect(hits).toEqual([]);
  });
});
