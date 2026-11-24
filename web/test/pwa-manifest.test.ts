import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The operator lives in Silos as its OWN app window (Chrome "Install page
// as app" / iOS "Add to Home Screen"), not as one tab among forty.
// Chrome only offers the install when the manifest is linked from
// the page, is valid, declares a standalone display and ships at least a
// 192px and a 512px PNG icon. This pins every one of those conditions.
const pub = join(import.meta.dirname, '..', 'public')
const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')

describe('PWA manifest', () => {
  const manifest = JSON.parse(readFileSync(join(pub, 'manifest.webmanifest'), 'utf8'))

  it('index.html links the manifest, the apple icon and a theme-color per scheme', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(html).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="#faf9f5" \/>/)
    expect(html).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#262624" \/>/)
  })

  it('declares a standalone app rooted at / with the brand name', () => {
    expect(manifest.name).toBe('Silos')
    expect(manifest.short_name).toBe('Silos')
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.id).toBe('/')
    // the app window's chrome paints these — they are the app's own paper
    // (theme.css --canvas light), never a foreign color.
    expect(manifest.background_color).toBe('#faf9f5')
    expect(manifest.theme_color).toBe('#faf9f5')
  })

  it('ships the icons Chrome requires (192 + 512 PNG, one maskable) and every icon file exists', () => {
    const icons: Array<{ src: string; sizes: string; type: string; purpose: string }> = manifest.icons
    const png = (sizes: string, purpose: string) => icons.find((i) => i.type === 'image/png' && i.sizes === sizes && i.purpose === purpose)
    expect(png('192x192', 'any')).toBeTruthy()
    expect(png('512x512', 'any')).toBeTruthy()
    expect(png('512x512', 'maskable')).toBeTruthy()
    for (const icon of icons) {
      expect(icon.src.startsWith('/')).toBe(true)
      expect(existsSync(join(pub, icon.src.slice(1))), icon.src).toBe(true)
    }
    expect(existsSync(join(pub, 'apple-touch-icon.png'))).toBe(true)
  })

  it('the PNGs really are PNGs of the size they claim', () => {
    const dims = (file: string) => {
      const buf = readFileSync(join(pub, file))
      expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
    }
    expect(dims('icon-192.png')).toEqual([192, 192])
    expect(dims('icon-512.png')).toEqual([512, 512])
    expect(dims('icon-maskable-512.png')).toEqual([512, 512])
    expect(dims('apple-touch-icon.png')).toEqual([180, 180])
  })
})
