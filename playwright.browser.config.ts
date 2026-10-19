import { defineConfig } from '@playwright/test';

/**
 * Fork (Wnt/webmail): real-engine checks of library code that need no app
 * server and no network. Each spec bundles the module under test with esbuild
 * and answers every request locally (page.route), so nothing leaves the
 * machine.
 *
 * Run:  npx playwright test -c playwright.browser.config.ts
 * One engine:  ... --project webkit
 * PW_WEBKIT_EXECUTABLE points WebKit at another launcher, for a host that
 * lacks some of WebKit's system libraries (see the spec header).
 */
const webkitExecutable = process.env.PW_WEBKIT_EXECUTABLE;

export default defineConfig({
  testDir: './lib/__browser__',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  fullyParallel: true,
  reporter: [['list']],
  outputDir: 'test-results/browser',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    {
      name: 'webkit',
      use: { browserName: 'webkit', launchOptions: webkitExecutable ? { executablePath: webkitExecutable } : {} },
    },
  ],
});
