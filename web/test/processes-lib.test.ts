// processes-lib.test.ts — how a process is named beside its ports (the
// delete confirmation's «Still running: vite :5193») and how a long line is
// cut in the middle (the tail stays).
import { describe, expect, it } from 'vitest'
import { processLabel, processName, splitTail } from '../src/lib/processes'

describe('processName', () => {
  it("the program past its interpreter, a runner's script whole", () => {
    expect(processName('node /srv/app/node_modules/.bin/vite --port 5193')).toBe('vite')
    expect(processName('python3 -m http.server 4391')).toBe('http.server')
    expect(processName('npm run dev')).toBe('npm run dev')
    expect(processName('PORT=3000 node server.js')).toBe('server')
    expect(processName('/usr/bin/redis-server *:6379')).toBe('redis-server')
  })
  it('with its ports', () => {
    expect(processLabel({ command: 'npm run dev', ports: '5193, 5194' })).toBe('npm run dev :5193 :5194')
    expect(processLabel({ command: 'npm test' })).toBe('npm test')
  })
})

describe('splitTail', () => {
  it('keeps the last words of a long line, whole', () => {
    expect(splitTail('node /srv/app/node_modules/.bin/vite --port 5193')).toEqual({ head: 'node /srv/app/node_modules/.bin/vite', tail: '--port 5193' })
  })
  it('a short line, or one ending in one long word, is not split', () => {
    expect(splitTail('npm run dev')).toEqual({ head: 'npm run dev', tail: '' })
    expect(splitTail('node /a/very/long/path/to/some/deeply/nested/script-name-that-is-long.js')).toEqual({
      head: 'node /a/very/long/path/to/some/deeply/nested/script-name-that-is-long.js',
      tail: '',
    })
  })
})
