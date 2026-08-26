import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: [
      "extensions/**/*.{test,spec}.?(c|m)[jt]s",
      "scripts/**/*.{test,spec}.?(c|m)[jt]s",
    ],
    passWithNoTests: true,
  },
});
