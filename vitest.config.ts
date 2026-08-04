import path from "node:path";
import { defineConfig } from "vitest/config";

// App-only tests. The Cloudflare Worker under worker/ is its own pnpm
// project with its own vitest — run those with `pnpm test` from worker/.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
