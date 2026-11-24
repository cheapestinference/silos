import { defineConfig } from 'vitest/config'
import { calmRun, yieldCpu } from './scripts/yield-cpu'

// a test run yields the machine (scripts/yield-cpu.ts)
yieldCpu()

// A vitest run from the repo root (`npx vitest run server/test/x.test.ts`)
// runs each file under ITS workspace's config — its setupFiles and the
// globalSetup that keeps every temp dir inside one private dir removed at
// the end (server/test/global-tmp.ts). Without this, a root run skipped both:
// the harness registry was empty and thousands of deck-* dirs leaked into /tmp.
export default defineConfig({ test: { ...calmRun, projects: ['server', 'web', 'plugin-opencode', 'silos-id'] } })
