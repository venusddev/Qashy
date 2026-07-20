import { defineConfig, devices } from '@playwright/test';

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
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    // WebKit coverage: Safari and every iOS browser share this engine, so
    // safe-area, PWA, and layout regressions there are invisible to Chromium.
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } },
  ],
});
