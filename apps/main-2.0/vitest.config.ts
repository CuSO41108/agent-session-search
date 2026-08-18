import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 10_000,
    minWorkers: 1,
    maxWorkers: "50%",
  },
});
