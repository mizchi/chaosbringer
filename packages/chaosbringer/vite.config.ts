import { defineConfig } from "vite-plus";

// `vp lint src` settings (vp lint does not read .oxlintrc.json). Type-aware
// rules and type checking stay off until what they report is fixed: type
// errors in the tests, and rule hits in both src/ and the tests.
export default defineConfig({
  lint: {
    categories: { correctness: "error" },
    options: { typeAware: false, typeCheck: false },
  },
});
