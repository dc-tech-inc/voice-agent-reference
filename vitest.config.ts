import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/demo/**", "src/index.ts"],
      reporter: ["text", "json-summary"],
      // Guard rails, set a little below the measured numbers so a real regression fails CI.
      thresholds: { lines: 90, branches: 80 },
    },
  },
});
