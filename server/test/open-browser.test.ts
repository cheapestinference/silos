// open-browser.test.ts — the packaged `silos` opens the browser only where
// there is a screen to open it on.
import { describe, it, expect } from 'vitest'
import { browserCommand, openBrowser } from '../src/open-browser.js'

describe('browserCommand', () => {
  it('macOS opens; Linux only with a display; anything else prints the line only', () => {
    expect(browserCommand('darwin', {})).toBe('open')
    expect(browserCommand('linux', { DISPLAY: ':0' })).toBe('xdg-open')
    expect(browserCommand('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe('xdg-open')
    expect(browserCommand('linux', {})).toBeNull()
    expect(browserCommand('win32', {})).toBeNull()
  })

  it('a headless machine spawns nothing', () => {
    expect(openBrowser('http://127.0.0.1:1/?token=x', 'linux', {})).toBe(false)
  })
})
