import { defineConfig, devices } from '@playwright/test'
import { yieldCpu } from '../scripts/yield-cpu'

// an e2e run yields the machine too (scripts/yield-cpu.ts): its workers,
// browsers and seeded server inherit the niceness
yieldCpu()

export default defineConfig({
  testDir: './e2e',
  // one private temp dir per run, removed at the end (e2e/global-tmp.ts)
  globalSetup: './e2e/global-tmp.ts',
  timeout: 30_000,
  // A hosted CI runner (2 cores, shared) paints and boots slower than a dev
  // machine: give every expect more room and one more retry there. Locally
  // nothing changes.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 1,
  workers: 2,
  reporter: 'list',
  use: {
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
