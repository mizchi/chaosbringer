import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3300);

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `node site/server.mjs`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
  },
});
