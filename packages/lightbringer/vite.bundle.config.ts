import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Production build of the bundle fixture. manualChunks splits the graph so the
// build-dependent metrics have something real to find: vendor-react (framework),
// a "features" chunk (imported as a namespace and dispatched dynamically, so it's
// shipped whole but mostly unused → coverage dead code), and the entry. A
// production build also extracts CSS into a render-blocking <link> and emits real
// hashed asset bytes (so media over-fetch and uncompressed checks have data).
export default defineConfig({
  root: "fixtures/bundle",
  build: {
    outDir: path.resolve("dist-bundle"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler"))
            return "vendor-react";
          if (id.includes("fixtures/bundle/features")) return "features";
          return undefined;
        },
      },
    },
  },
  plugins: [react()],
});
