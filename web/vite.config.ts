import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { calmRun, yieldCpu } from '../scripts/yield-cpu'

// a test run yields the machine (scripts/yield-cpu.ts) — only under vitest:
// this config also serves `vite build` and the dev server
if (process.env.VITEST) yieldCpu()

export default defineConfig(({ command }) => {
  // The stale-tab banner's stamp (see lib/build.ts): every `vite build`
  // mints an id that lives in TWO places — inside the bundle (define) and
  // in dist/build-id.json for the server to announce on /api/overview. A
  // long-lived tab compares both and offers a reload when they diverge.
  // In dev there is nothing to compare (HMR keeps the page current, and
  // the :3210 proxy would always mismatch), so the id is the literal
  // 'dev', which updateAvailable() ignores.
  const buildId = command === 'build' ? new Date().toISOString() : 'dev'
  let outDir = 'dist'
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'silos-build-id',
        apply: 'build' as const,
        // the stamp goes NEXT TO the bundle it belongs to (the resolved
        // outDir) — never into dist/ from another build: an e2e build
        // (--outDir dist-e2e) used to restamp dist/build-id.json while the
        // served bundle kept its old embedded id, and every open tab saw
        // "a new version is ready" for good, reload or not.
        // resolve(), not join(): an absolute --outDir must stay absolute
        // (join glued it under web/, leaving a stray web/tmp/... behind).
        configResolved(config) {
          outDir = resolve(config.root, config.build.outDir)
        },
        // writeBundle, never closeBundle: Vite closes the bundle in a
        // `finally`, so closeBundle runs on a FAILED build too — it stamped
        // a new id beside the old bundle and the banner stayed for good,
        // reload or not (23-11). writeBundle runs only once the files are
        // written: the stamp and the bundle it names land together.
        writeBundle() {
          mkdirSync(outDir, { recursive: true })
          writeFileSync(join(outDir, 'build-id.json'), JSON.stringify({ id: buildId }) + '\n')
        },
      },
    ],
    define: { __BUILD_ID__: JSON.stringify(buildId) },
    server: {
      proxy: {
        '/api': 'http://127.0.0.1:3210',
        '/ws': { target: 'ws://127.0.0.1:3210', ws: true },
      },
    },
    test: {
      ...calmRun,
      // worker threads, not forked processes: measured −21 s wall and
      // −15 % CPU on the web suite with 0 failures (server stays on forks:
      // node-pty aborts inside a worker thread)
      pool: 'threads',
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      // every run's temp dirs live in one private dir removed at the end
      globalSetup: ['../server/test/global-tmp.ts'],
      globals: false,
      // e2e/ is the Playwright harness (test.describe from @playwright/test, not vitest) — vitest must never pick it up.
      exclude: [...configDefaults.exclude, 'e2e/**'],
    },
  }
})
