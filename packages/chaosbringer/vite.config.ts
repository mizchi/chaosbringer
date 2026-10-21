import { defineConfig } from "vite-plus";

// `vp lint src` settings (vp lint does not read .oxlintrc.json). Type-aware
// rules and type checking stay off until the test-file type errors are fixed.
export default defineConfig({
  lint: {
    categories: { correctness: "error" },
    options: { typeAware: false, typeCheck: false },
  },
});
