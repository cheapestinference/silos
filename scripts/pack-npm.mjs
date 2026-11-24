#!/usr/bin/env node
// pack-npm.mjs — assembles the ONE publishable npm package (`silosplatform`,
// installed command `silos`) from the three private workspaces, and packs
// it into a tarball. It never publishes: `npm publish <tarball>` is the
// owner's act (q4 t26/t33).
//
// The package keeps the repo's runtime layout, because the server resolves
// its siblings relative to its own files (config.ts webDist, index.ts
// plugin skills, launch.ts plugin-opencode/silos.ts, silos/catalog.ts
// docs/standard): the same list the Dockerfile copies into its runtime
// stage. Dependencies = the server's (the web is prebuilt static files).
//
//   node scripts/pack-npm.mjs            build web + server, stage, pack
//   node scripts/pack-npm.mjs --no-build stage and pack the current builds
//   --root <dir> / --out <dir>           another tree / output dir (the
//                                        smoke test, server/test/pack-npm.test.ts)
//
// Output: .pack/silosplatform/ (the staged package) and
// .pack/silosplatform-<version>.tgz.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'

const NAME = 'silosplatform'
const argOf = (flag) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const root = resolve(argOf('--root') ?? join(import.meta.dirname, '..'))
const out = resolve(argOf('--out') ?? join(root, '.pack'))
const stage = join(out, NAME)
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })

if (!process.argv.includes('--no-build')) {
  // tsc never deletes: a stale file from a renamed module would ship
  rmSync(join(root, 'server', 'dist'), { recursive: true, force: true })
  run('npm', ['exec', '-w', 'web', '--', 'vite', 'build'])
  run('npm', ['run', 'build', '-w', 'server'])
}
for (const need of ['server/dist/index.js', 'web/dist/index.html']) {
  if (!existsSync(join(root, need))) throw new Error(`missing ${need} — run without --no-build`)
}

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// the runtime layout (keep in step with the Dockerfile's runtime stage)
const COPY = [
  'server/dist',
  'web/dist',
  'plugin',
  'plugin-opencode/silos.ts',
  'plugin-opencode/package.json',
  'plugin-opencode/README.md',
  'docs/standard',
  'LICENSE',
  'README.md',
]
for (const rel of COPY) cpSync(join(root, rel), join(stage, rel), { recursive: true })

mkdirSync(join(stage, 'bin'))
const bin = join(stage, 'bin', 'silos.mjs')
writeFileSync(
  bin,
  `#!/usr/bin/env node
// silos — starts the Silos server (http://127.0.0.1:3210 by default).
// Settings ride the environment, exactly as in the repo: SILOS_PORT,
// SILOS_HOST, SILOS_DATA_DIR (default ~/.silos), SILOS_ROOT (default
// ~/.claude/projects), SILOS_TOKEN.
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(\`silos needs Node.js 22.13 or newer (this is \${process.versions.node}).\`)
  process.exit(1)
}
const arg = process.argv[2]
if (arg === '--help' || arg === '-h') {
  console.log(\`silos — a local web console for your fleet of Claude Code agents

Usage: silos                    start the server, print its URL and open it in the browser
       silos --no-open          start without opening the browser
       silos doctor             check what this machine needs, with the fix for what is missing
       silos service install    keep Silos running in the background, after a reboot too
       silos service status · logs · start · stop · restart · uninstall
       silos update             move to the newest version (--check to only ask, --version x.y.z for that one)
       silos uninstall          remove the service and the program; your data stays

Environment:
  SILOS_PORT      port (default 3210)
  SILOS_HOST      bind address (default 127.0.0.1 — keep it local)
  SILOS_DATA_DIR  Silos' own state (default ~/.silos)
  SILOS_ROOT      Claude Code transcripts (default ~/.claude/projects)
  SILOS_TOKEN     fix the access token instead of the generated one

Needs: the Claude CLI (claude), tmux (the real console), git — silos doctor checks them.\`)
  process.exit(0)
}
if (arg === '--version' || arg === '-v') {
  const { readFileSync } = await import('node:fs')
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  process.exit(0)
}
// the subcommands live with the server's code (server/src/cli/)
if (['doctor', 'service', 'update', 'uninstall'].includes(arg)) {
  const { main } = await import('../server/dist/cli/main.js')
  process.exitCode = await main(process.argv.slice(2))
} else if (arg !== undefined && !arg.startsWith('-')) {
  console.error(\`silos: unknown command «\${arg}» — silos --help lists them.\`)
  process.exit(1)
} else {
// node-pty (the console in the browser) is an optional dependency: on Linux
// it compiles on install, and a machine without a toolchain would otherwise
// fail the whole install on a wall of node-gyp output. Here it says why and
// what to do instead.
try {
  await import('node-pty')
} catch (err) {
  console.error(\`silos: the terminal module (node-pty) did not install or does not load on this machine
  (\${String(err?.message ?? err).split('\\n')[0]}).
It compiles on install on Linux. Install a C/C++ toolchain, then install Silos again:
  Debian/Ubuntu:  sudo apt install build-essential python3
  macOS:          xcode-select --install
  then:           npm install -g silosplatform   (and start it with: silos)\`)
  process.exit(1)
}
// the printed address carries the token: opening it pairs this browser
// (server open-browser.ts — skipped where there is no screen)
if (!process.argv.includes('--no-open')) process.argv.push('--open')
await import('../server/dist/index.js')
}
`,
)
chmodSync(bin, 0o755)

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const serverPkg = JSON.parse(readFileSync(join(root, 'server', 'package.json'), 'utf8'))
const OPTIONAL = ['node-pty']
const pkg = {
  name: NAME,
  version: rootPkg.version,
  description: rootPkg.description,
  keywords: rootPkg.keywords,
  license: rootPkg.license,
  ...(rootPkg.author ? { author: rootPkg.author } : {}),
  ...(rootPkg.homepage ? { homepage: rootPkg.homepage } : {}),
  ...(rootPkg.repository?.url ? { repository: rootPkg.repository } : {}),
  ...(rootPkg.bugs ? { bugs: rootPkg.bugs } : {}),
  type: 'module',
  engines: rootPkg.engines,
  os: ['linux', 'darwin'],
  bin: { silos: 'bin/silos.mjs' },
  files: ['bin', ...COPY.filter((p) => p !== 'LICENSE' && p !== 'README.md')],
  // node-pty optional: a failed native build must not abort the install —
  // bin/silos.mjs then names the fix (toolchain + install again)
  dependencies: Object.fromEntries(Object.entries(serverPkg.dependencies).filter(([n]) => !OPTIONAL.includes(n))),
  optionalDependencies: Object.fromEntries(Object.entries(serverPkg.dependencies).filter(([n]) => OPTIONAL.includes(n))),
}
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

const tgz = execFileSync('npm', ['pack', '--pack-destination', out], { cwd: stage, encoding: 'utf8' }).trim().split('\n').pop()
console.log(`\npacked ${join(out, tgz)} — not published (npm publish is the owner's call)`)
