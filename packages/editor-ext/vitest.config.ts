import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.ts"],
    // Coverage gate. v8 provider avoids the istanbul AST-rewrite
    // that broke on this package's ESM barrel. Thresholds sit a few points
    // below the level measured on develop, over the files the suite exercises
    // (`all: false`), so the gate passes today and catches a real regression.
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text-summary", "text"],
      all: false,
      // The markdown behavior lives in — and is tested by —
      // @docmost/prosemirror-markdown, not editor-ext; thresholds sit a few
      // points below the measured level.
      thresholds: {
        statements: 54,
        branches: 44,
        functions: 57,
        lines: 54,
      },
    },
  },
});
