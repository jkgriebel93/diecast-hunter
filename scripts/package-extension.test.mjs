import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  exclusionReason,
  packageExtension,
  selectFiles,
  walk,
} from "./package-extension.mjs";

const require = createRequire(import.meta.url);

describe("selectFiles", () => {
  it("keeps the real extension assets", () => {
    const kept = selectFiles([
      "manifest.json",
      "background.js",
      "content.js",
      "options.html",
      "options.css",
      "options.js",
      "icons/16.png",
      "icons/48.png",
      "icons/128.png",
    ]);
    expect(kept).toContain("manifest.json");
    expect(kept).toContain("icons/128.png");
    expect(kept).toHaveLength(9);
  });

  it("includes a newly added file without any script edit", () => {
    // The whole point of globbing: this is what the old hand-maintained
    // allowlist got wrong twice.
    expect(selectFiles(["manifest.json", "popup.js"])).toContain("popup.js");
    expect(selectFiles(["manifest.json", "vendor/lib.js"])).toContain(
      "vendor/lib.js",
    );
  });

  it("drops a previous build so archives don't nest", () => {
    expect(selectFiles(["manifest.json", "diecast-hunter-ebay.zip"])).toEqual([
      "manifest.json",
    ]);
  });

  it("drops docs, source maps, and scratch files", () => {
    const kept = selectFiles([
      "manifest.json",
      "README.md",
      "NOTES.MD",
      "content.js.map",
      ".DS_Store",
      ".git/config",
      "options.js~",
      "Thumbs.db",
      "node_modules/left-pad/index.js",
    ]);
    expect(kept).toEqual(["manifest.json"]);
  });

  it("drops unit tests but keeps the modules they pin", () => {
    // DCH-70 put panel-state.js and its vitest file side by side; the
    // module ships, the test never should.
    const kept = selectFiles([
      "manifest.json",
      "panel-state.js",
      "panel-state.test.mjs",
      "vendor/lib.test.ts",
    ]);
    expect(kept).toEqual(["manifest.json", "panel-state.js"]);
  });

  it("sorts, so identical inputs give identical archive order", () => {
    expect(selectFiles(["b.js", "a.js", "icons/z.png"])).toEqual([
      "a.js",
      "b.js",
      "icons/z.png",
    ]);
  });
});

describe("exclusionReason", () => {
  it("explains why a file was left out, and stays null for kept files", () => {
    expect(exclusionReason("README.md")).toBe("documentation");
    expect(exclusionReason("old.zip")).toBe("previous build output");
    expect(exclusionReason("manifest.json")).toBeNull();
  });
});

/** Build a throwaway extension tree and return its directory. */
async function fixture(files) {
  const dir = await mkdtemp(path.join(tmpdir(), "ext-pkg-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body);
  }
  return dir;
}

const VALID_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "Diecast Hunter",
  version: "0.1.0",
});

describe("packageExtension", () => {
  it("writes a zip a browser can read, containing exactly the kept files", async () => {
    const dir = await fixture({
      "manifest.json": VALID_MANIFEST,
      "content.js": "console.log('hi');",
      "icons/16.png": "not-really-a-png",
      "README.md": "# docs",
      "diecast-hunter-ebay.zip": "stale build",
    });
    const out = path.join(dir, "out.zip");
    const result = await packageExtension({
      extensionDir: dir,
      outFile: out,
      log: () => {},
    });

    expect(result.included).toEqual([
      "content.js",
      "icons/16.png",
      "manifest.json",
    ]);
    expect(result.skipped.sort()).toEqual([
      "README.md",
      "diecast-hunter-ebay.zip",
    ]);

    // Read it back with an independent unzip so we're asserting on a real
    // archive, not on our own bookkeeping.
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(await readFile(out));
    // No implicit directory entries — they're optional, and JSZip would
    // stamp them with the current time, breaking reproducibility.
    expect(Object.keys(zip.files).sort()).toEqual([
      "content.js",
      "icons/16.png",
      "manifest.json",
    ]);
    // DOS timestamps start at 1980; a pre-1980 date reads back as 2098.
    expect(zip.file("manifest.json").date.getUTCFullYear()).toBe(1980);
    expect(await zip.file("manifest.json").async("string")).toBe(
      VALID_MANIFEST,
    );
    expect(await zip.file("content.js").async("string")).toBe(
      "console.log('hi');",
    );
  });

  it("is byte-identical across builds of identical input", async () => {
    // Timestamps are pinned, so a rebuild that changed nothing produces the
    // same archive — otherwise every CI run uploads a "different" artifact.
    const files = { "manifest.json": VALID_MANIFEST, "content.js": "x" };
    const a = await fixture(files);
    const b = await fixture(files);
    await packageExtension({
      extensionDir: a,
      outFile: path.join(a, "o.zip"),
      log: () => {},
    });
    await packageExtension({
      extensionDir: b,
      outFile: path.join(b, "o.zip"),
      log: () => {},
    });
    expect(await readFile(path.join(a, "o.zip"))).toEqual(
      await readFile(path.join(b, "o.zip")),
    );
  });

  it("fails loudly on a manifest that would not load", async () => {
    const bad = await fixture({ "manifest.json": "{ not json" });
    await expect(
      packageExtension({
        extensionDir: bad,
        outFile: path.join(bad, "o.zip"),
        log: () => {},
      }),
    ).rejects.toThrow(/missing or invalid/);

    const incomplete = await fixture({
      "manifest.json": JSON.stringify({ name: "no version" }),
    });
    await expect(
      packageExtension({
        extensionDir: incomplete,
        outFile: path.join(incomplete, "o.zip"),
        log: () => {},
      }),
    ).rejects.toThrow(/manifest_version, name, and version/);
  });
});

describe("walk", () => {
  it("returns nested paths with forward slashes on every platform", async () => {
    const dir = await fixture({
      "manifest.json": VALID_MANIFEST,
      "icons/deep/16.png": "x",
    });
    const found = (await walk(dir)).sort();
    expect(found).toEqual(["icons/deep/16.png", "manifest.json"]);
  });
});

describe("the real extension directory", () => {
  it("packages cleanly and keeps its documentation out", async () => {
    // Guards the actual tree, not a fixture: if someone adds a file that the
    // rules would drop, this is where it shows up.
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const extensionDir = path.join(repoRoot, "extension");
    const included = selectFiles(await walk(extensionDir));
    expect(included).toContain("manifest.json");
    expect(included).toContain("background.js");
    expect(included).toContain("content.js");
    expect(included).toContain("options.js");
    expect(included.some((p) => p.startsWith("icons/"))).toBe(true);
    expect(included).not.toContain("README.md");
  });
});
