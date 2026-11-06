import { defineConfig } from "@playwright/test";

const PORT = 4173;
// On Windows use the preinstalled Edge; elsewhere run `npx playwright install chromium` once.
const channel = process.env.PW_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined);

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel, trace: "retain-on-failure" },
  webServer: {
    // Requires `npm run build` (api + web) first; serves the built dashboard from the API.
    command: "node e2e/prepare.mjs && node ../api/dist/index.js",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORT: String(PORT), GRASP_DATA_JSON: "e2e/.data", GRASP_WEB_DIST: "dist" },
  },
});
