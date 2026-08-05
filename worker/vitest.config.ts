import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  // Vite searches parent directories for a PostCSS config and finds the
  // desktop app's `postcss.config.js` at the repo root, which loads
  // tailwindcss — a dependency of that project, not of this one. It resolves
  // by accident from a dev machine's root node_modules, and fails in CI where
  // only worker/ is installed. An inline config stops the upward search;
  // nothing here processes CSS anyway.
  css: { postcss: { plugins: [] } },
});
