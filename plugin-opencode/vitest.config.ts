import { defineConfig } from 'vitest/config'
import { calmRun, yieldCpu } from '../scripts/yield-cpu'

// a test run yields the machine (scripts/yield-cpu.ts)
yieldCpu()

// its own config, so a run here never climbs to the repo root's projects
// config; temp dirs stay in the run's private dir like the other workspaces
export default defineConfig({ test: { ...calmRun, globalSetup: ['../server/test/global-tmp.ts'] } })
