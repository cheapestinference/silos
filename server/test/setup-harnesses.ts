import '../src/harnesses/index.js'
import { scrubInheritedEngineEnv } from '../src/inherited-env.js'

// the tests run the way the server does: never on the environment of the
// shell that launched them (a Claude Code session leaked ANTHROPIC_AUTH_TOKEN
// into the OpenCode headless test — inherited-env.ts)
scrubInheritedEngineEnv()
