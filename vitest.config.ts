/**
 * Unit + integration tests run inside workerd (Miniflare) with the real
 * bindings from wrangler.jsonc: SQLite-backed Durable Objects, the Queue
 * producer, R2 and the Workflow. Nothing is mocked that the platform can run.
 *
 * Gate: `npm run test:coverage` fails below the thresholds in `coverage`.
 * The thresholds are a ratchet: raise them when coverage rises, never lower them.
 */
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Test values win over .dev.vars and wrangler.jsonc vars, so a run is the
      // same on every machine. Secrets (CHAOS_TOKEN) are never read from the
      // real file here.
      miniflare: {
        bindings: {
          CHAOS_TOKEN: "test-token",
          IDLE_MS: "1000",
          ARCHIVE_GRACE: "1 second",
          ACCESS_AUD: "",
          ACCESS_TEAM: "hypnagogia",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    silent: "passed-only", // the structured log lines are useful only when something fails
    // The chaos tests inject failures inside the Durable Object on purpose; the
    // RPC rejection is asserted in the test, but workerd also reports the
    // object-side throw. Ignore exactly those, nothing else.
    onUnhandledError(error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.startsWith("chaos: injected")) return false;
    },
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      // Ratchet. Measured 2026-11-06 at 94 / 95 / 87 / 93; see HARNESS.md for the policy.
      thresholds: { lines: 90, functions: 90, branches: 82, statements: 88 },
    },
  },
});
