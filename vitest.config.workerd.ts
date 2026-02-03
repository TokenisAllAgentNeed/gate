/**
 * Vitest config for workerd environment (miniflare).
 *
 * Run with: pnpm test:workerd
 *
 * This config runs tests inside the actual CF Workers runtime
 * to catch platform-specific issues like CBOR parsing differences.
 */
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: false,
    include: ["src/__tests__/decode-workerd.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityDate: "2025-01-01",
          compatibilityFlags: ["nodejs_compat_v2"],
        },
      },
    },
    reporters: ["verbose"],
    testTimeout: 30000,
  },
});
