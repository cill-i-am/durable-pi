import { fileURLToPath } from "node:url"

import { defineConfig } from "@playwright/test"

const packageRoot = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
  testDir: "./tests",
  testMatch: "primitives.spec.ts",
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: "./test-results/browser",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "test-results/browser-results.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:6007",
    browserName: "chromium",
    locale: "en-GB",
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-light",
      metadata: { theme: "light" },
      use: { viewport: { width: 1280, height: 900 } },
    },
    {
      name: "desktop-night",
      metadata: { theme: "dark" },
      use: { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
    },
    {
      name: "phone-light",
      metadata: { theme: "light" },
      use: {
        viewport: { width: 320, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "phone-night",
      metadata: { theme: "dark" },
      use: {
        viewport: { width: 320, height: 844 },
        isMobile: true,
        hasTouch: true,
        colorScheme: "dark",
      },
    },
  ],
  webServer: {
    command:
      "pnpm exec vite preview --outDir storybook-static --port 6007 --strictPort --host 127.0.0.1",
    cwd: packageRoot,
    url: "http://127.0.0.1:6007/iframe.html",
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
