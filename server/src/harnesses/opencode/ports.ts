// harnesses/opencode/ports — a free loopback port for an OpenCode TUI's
// own HTTP server (`opencode --port <n>`): bind 127.0.0.1:0, read the port
// the kernel picked, close. The usual small race (something else may take
// it before opencode binds) is accepted: the console then fails to start
// and reopening it picks another port.

import { createServer } from 'node:net'

export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('could not allocate a port'))))
    })
  })
}
