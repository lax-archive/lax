import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup-env.ts"],
    // Real-lake pipeline tests build Lean packages; the fast unit tests never
    // come near these budgets.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: "forks",
  },
});
