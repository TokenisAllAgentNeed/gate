import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default environment is node
    environment: "node",
    globals: false,
    include: ["src/__tests__/**/*.test.ts"],
    exclude: [
      "src/__tests__/**/*.integration.test.ts",
      "src/__tests__/e2e-*.ts",
    ],
    // Enable console output for performance logs
    reporters: ["verbose"],
    // Timeout for slower tests
    testTimeout: 30000,
    // Pool settings for better isolation
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
