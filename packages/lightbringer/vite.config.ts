import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Serves a delayed /api/slow?ms= endpoint for the network-waterfall bench.
const slowApi = (): Plugin => ({
  name: "slow-api",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (u.pathname !== "/api/slow") return next();
      const ms = Number(u.searchParams.get("ms") ?? "200");
      setTimeout(() => {
        res.setHeader("content-type", "text/plain");
        res.end("ok");
      }, ms);
    });
  },
});

// Emulates third-party assets (analytics, tag manager, ads) for the third-party
// bench. The page loads from localhost; this serves /3p/* — the spec references
// it via 127.0.0.1 so it lands on a different registrable domain and the
// collector classifies it as third-party. tag.js burns `cpu` iterations (so it
// shows up in the drilldown's third-party self time) and is padded to `bytes`
// (so it shows up in network.thirdParty). `ms` delays the response (slow 3p).
const thirdParty = (): Plugin => ({
  name: "third-party",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (!u.pathname.startsWith("/3p/")) return next();
      const ms = Number(u.searchParams.get("ms") ?? "0");
      const send = () => {
        if (u.pathname === "/3p/tag.js") {
          const cpu = Number(u.searchParams.get("cpu") ?? "0");
          const bytes = Number(u.searchParams.get("bytes") ?? "0");
          const pad = "/*" + "x".repeat(Math.max(0, bytes)) + "*/";
          res.setHeader("content-type", "application/javascript");
          res.setHeader("access-control-allow-origin", "*");
          res.end(
            `(function(){var s=0;for(var i=0;i<${cpu};i++)s+=Math.sqrt(i);` +
              `(window).__tp=((window).__tp||0)+s;})();\n${pad}`,
          );
        } else {
          // beacon / pixel
          res.setHeader("access-control-allow-origin", "*");
          res.end("ok");
        }
      };
      if (ms > 0) setTimeout(send, ms);
      else send();
    });
  },
});

// Serves the bench fixture app (fixtures/app) for the local bench specs.
export default defineConfig({
  root: "fixtures/app",
  // host: true binds 0.0.0.0 so the page (localhost) and the third-party
  // endpoint (127.0.0.1) resolve to the same server on different hosts.
  server: { host: true },
  plugins: [react(), slowApi(), thirdParty()],
});
