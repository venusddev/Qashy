import { defineConfig, devices } from '@playwright/test';

const pwaTest = /registers the service worker and starts offline/;
const functionalUse = { serviceWorkers: 'block' as const };
const pwaUse = { serviceWorkers: 'allow' as const };

export default defineConfig({
  testDir: './e2e',
  webServer: {
    // Build before serving. `serve dist` on its own happily boots a stale export,
    // which silently validates whatever was last built instead of the working tree.
    command: 'npm run build:web && npx serve dist -l 4173 --no-clipboard',
    port: 4173,
    reuseExistingServer: false,
    timeout: 300_000,
  },
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      grepInvert: pwaTest,
      use: {
        ...devices['Desktop Chrome'],
        ...functionalUse,
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: 'mobile',
      grepInvert: pwaTest,
      use: { ...devices['Pixel 7'], ...functionalUse },
    },
    // WebKit coverage: Safari and every iOS browser share this engine, so
    // safe-area, PWA, and layout regressions there are invisible to Chromium.
    {
      name: 'mobile-safari',
      grepInvert: pwaTest,
      use: { ...devices['iPhone 14'], ...functionalUse },
    },
    // Service workers persist beyond a page and WebKit can retain them between
    // otherwise-isolated test contexts. Give PWA behavior a dedicated worker in
    // every viewport instead of letting it contaminate unrelated finance flows.
    {
      name: 'pwa-desktop',
      grep: pwaTest,
      use: {
        ...devices['Desktop Chrome'],
        ...pwaUse,
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: 'pwa-mobile',
      grep: pwaTest,
      use: { ...devices['Pixel 7'], ...pwaUse },
    },
    {
      name: 'pwa-mobile-safari',
      grep: pwaTest,
      use: { ...devices['iPhone 14'], ...pwaUse },
    },
  ],
});
