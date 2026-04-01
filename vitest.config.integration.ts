import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    root: ".",
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 5_000,
    hookTimeout: 5_000,
    teardownTimeout: 2_000,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
  },
})
