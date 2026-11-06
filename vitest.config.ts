import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The DMG staging tree contains an Applications symlink; never scan it for tests.
    include: ["tests/**/*.test.ts"],
  },
});
