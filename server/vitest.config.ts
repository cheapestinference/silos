import { defineConfig } from 'vitest/config'
import { calmRun, yieldCpu } from '../scripts/yield-cpu'

// a test run yields the machine (scripts/yield-cpu.ts)
yieldCpu()

// every server test sees the registry production sees (harnesses/index.ts fills it)
// every run's temp dirs live in one private dir removed at the end (test/global-tmp.ts)
export default defineConfig({ test: { ...calmRun, setupFiles: ['./test/setup-harnesses.ts'], globalSetup: ['./test/global-tmp.ts'] } })
