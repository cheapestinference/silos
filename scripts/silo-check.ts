// silo-check — validate a silo.json the way the install door will, and print
// what the install dialog will tell the owner (server/src/silos/check.ts).
//
//   npm run silo-check -- path/to/my.silo.json
//
// Relative paths resolve from where npm was invoked (INIT_CWD). Exit 0 when
// every file validates, 1 when one does not, 2 on usage.
import { runSiloCheck } from '../server/src/silos/check.ts'

process.exitCode = runSiloCheck(process.argv.slice(2), {
  cwd: process.env.INIT_CWD ?? process.cwd(),
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
})
