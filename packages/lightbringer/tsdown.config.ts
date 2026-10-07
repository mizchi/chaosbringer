import { defineConfig } from "tsdown";

// Bundled ESM plus bundled .d.ts. tsdown (rather than tsup) because tsup's
// declaration bundler needs TypeScript's JS API, which TypeScript 7 no longer
// ships; tsdown's runs on 7.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/core.ts",
    "src/fixture.ts",
    "src/cli.ts",
    "src/auto.ts",
    "src/autowrap.ts",
    "src/analyze/index.ts",
  ],
  format: "esm",
  dts: true,
  clean: true,
  // `.js` / `.d.ts`, as the package's exports and bin name them.
  fixedExtension: false,
});
