import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/ui",
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:3101",
    headless: true,
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  },
  webServer: {
    command: "node tests/ui-server.mjs",
    url: "http://127.0.0.1:3101/api/health",
    reuseExistingServer: false,
  },
  reporter: "list",
  workers: 1,
});
