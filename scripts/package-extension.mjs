/**
 * Packages `extension/` into a loadable browser-extension zip (DCH-31).
 *
 * Replaces a PowerShell `Compress-Archive` one-liner that (a) couldn't run
 * outside Windows, so a Linux or WSL dev box could not build the extension at
 * all, and (b) carried a hand-maintained list of files — adding a file to
 * `extension/` and forgetting to add it to that list produced a zip silently
 * missing it. Twice, extension work reached `main` and never reached a
 * browser.
 *
 * So the file set is discovered by walking the directory, and what's left out
 * is expressed as *rules* rather than an allowlist: a new asset ships without
 * anyone editing this file, while things that must never ship (the previous
 * build's zip, docs, source maps, editor scratch) stay out no matter what
 * they're named.
 */

import { createRequire } from "node:module";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** Zip stores DOS timestamps, which cannot represent anything before 1980. */
const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1));

/** Paths are compared with forward slashes on every platform so these rules
 *  behave the same on Windows as on Linux. */
export const EXCLUDE_RULES = [
  // The previous build. Including it would nest each build inside the next.
  { why: "previous build output", test: (p) => p.endsWith(".zip") },
  // Developer docs — the old allowlist left README.md out, and shipping docs
  // to users' browsers is noise.
  { why: "documentation", test: (p) => p.toLowerCase().endsWith(".md") },
  // Source maps leak original sources and bloat the package.
  { why: "source map", test: (p) => p.endsWith(".map") },
  // Editor/OS scratch and anything hidden.
  {
    why: "hidden or scratch file",
    test: (p) =>
      p.split("/").some((seg) => seg.startsWith(".")) ||
      p.endsWith("~") ||
      p.toLowerCase().endsWith("thumbs.db"),
  },
  // Never package dependencies into an extension.
  {
    why: "dependency directory",
    test: (p) => p.split("/").includes("node_modules"),
  },
  // Unit tests live beside the modules they pin (DCH-70) and run in
  // vitest, never in a browser.
  {
    why: "test file",
    test: (p) => /\.test\.[cm]?[jt]s$/.test(p),
  },
];

/**
 * Decide which discovered paths belong in the archive.
 *
 * `entries` are POSIX-style paths relative to the extension directory.
 * Returns them sorted, so two builds of identical inputs produce identical
 * archive ordering — a zip that differs only by file order is needlessly hard
 * to compare between runs.
 */
export function selectFiles(entries) {
  return entries
    .filter((p) => !EXCLUDE_RULES.some((rule) => rule.test(p)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Why a given path was left out, or null if it's included. Used by the
 *  script's own output so a missing file is diagnosable without guesswork. */
export function exclusionReason(entry) {
  return EXCLUDE_RULES.find((rule) => rule.test(entry))?.why ?? null;
}

/** Recursively list files under `dir` as POSIX-relative paths. */
export async function walk(dir, prefix = "") {
  const found = [];
  for (const name of await readdir(dir)) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if ((await stat(abs)).isDirectory()) {
      found.push(...(await walk(abs, rel)));
    } else {
      found.push(rel);
    }
  }
  return found;
}

/** A manifest that won't parse produces an extension Chrome refuses to load,
 *  and the failure surfaces at install time rather than build time. Cheaper to
 *  catch here. */
async function assertLoadableManifest(extensionDir) {
  const manifestPath = path.join(extensionDir, "manifest.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(
      `extension/manifest.json is missing or invalid: ${e.message}`,
    );
  }
  if (!parsed.manifest_version || !parsed.name || !parsed.version) {
    throw new Error(
      "extension/manifest.json needs manifest_version, name, and version",
    );
  }
  return parsed;
}

export async function packageExtension({
  extensionDir,
  outFile,
  log = console.log,
}) {
  const manifest = await assertLoadableManifest(extensionDir);
  const all = await walk(extensionDir);
  const included = selectFiles(all);

  if (!included.includes("manifest.json")) {
    throw new Error("manifest.json was excluded — the zip would not load");
  }

  // Required lazily so importing this module for its pure helpers (as the
  // tests do) doesn't pay for the zip library.
  const JSZip = require("jszip");
  const zip = new JSZip();
  for (const rel of included) {
    zip.file(rel, await readFile(path.join(extensionDir, rel)), {
      // Fixed date so the archive differs only when its contents do, not
      // because it was built at a different time. 1980-01-01 rather than the
      // Unix epoch because zip stores DOS timestamps, whose epoch *is* 1980 —
      // a 1970 date underflows and reads back as 2098.
      date: ZIP_EPOCH,
      // Skip implicit directory entries. They're optional in a zip, Chrome
      // doesn't need them, and JSZip stamps them with the current time —
      // which would make two builds of identical input differ.
      createFolders: false,
    });
  }

  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  await writeFile(outFile, buf);

  const skipped = all.filter((p) => !included.includes(p));
  log(
    `Packaged ${manifest.name} ${manifest.version}: ` +
      `${included.length} files → ${outFile} (${(buf.length / 1024).toFixed(1)} KB)`,
  );
  for (const p of skipped) log(`  skipped ${p} (${exclusionReason(p)})`);
  return { included, skipped, bytes: buf.length };
}

// Only run when invoked directly, so the module stays importable by tests.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const extensionDir = path.join(repoRoot, "extension");
  const outFile = path.join(extensionDir, "diecast-hunter-ebay.zip");
  packageExtension({ extensionDir, outFile }).catch((e) => {
    console.error(`ext:package failed: ${e.message}`);
    process.exit(1);
  });
}
