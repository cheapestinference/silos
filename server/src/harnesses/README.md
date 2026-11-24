# server/src/harnesses

Each engine (harness) Silos drives has a folder here. Adding one is that folder (its `index.ts` exports a `Harness`), one `registerHarness(yours)` line in `index.ts`, and a conformance fixture in `server/test/conformance/<id>.fixture.ts`; nothing else in the server or the web changes. **[`docs/harnesses.md`](../../../docs/harnesses.md) explains every member and lists the known limits. Start there**, with the test-only fake engine `server/test/fixtures/fake-harness.ts` as the smallest complete example.

- `contract.ts`: what an engine provides (`Harness`, `HarnessReader`, `HarnessConsole`, runtime, headless, versions and server-hook types), plus `isFileBacked`.
- `registry.ts`: the registry and every lookup (`registerHarness`, `harnessOf`, `harnessForId`, `fallbackHarness`, `fencePermissionFor`…). A leaf: it imports nothing at runtime, so neutral modules and engine folders import it.
- `index.ts`: the registration list, the one module that names every engine. Only `server/src/index.ts` (and the test setup) imports it.
- `fence-rules.ts`, `validate.ts`, `roster-text.ts`: neutral helpers shared by every engine.
- `claude-code/`: Claude Code, the fallback. JSONL reader (the index's fallback reader), SDK chat turns, console argv, accounts, trash.
- `opencode/`: OpenCode. Read-only SQLite reader, `opencode run` chat turns, TUI console and its server hooks, plugin-reported ids, fence dialect.
- Tests: `server/test/harness-conformance.test.ts` (every engine, same assertions, one fixture each) and `server/test/harness-boundary.test.ts` (engine folders never import each other; no engine id spelled outside `harnesses/`).
