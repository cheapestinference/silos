// Settings › Notifications: turn the doorbell on for
// THIS device, list and revoke devices, set the digest hour — and say which
// reason when this browser can't receive a push. jsdom has no push: the
// browser side is a fake (PushOps).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NotificationsTab, type PushOps } from '../src/components/NotificationsTab'
import { deviceLabel, keyBytes, pushCapability, type PushEnv } from '../src/lib/push'
import { api } from '../src/lib/api'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  isSecureContext: true,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: 'default',
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  standalone: false,
  ...over,
})
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

describe('pushCapability — which reason, said plainly', () => {
  it('names each blocker', () => {
    expect(pushCapability(env())).toEqual({ ok: true })
    expect(pushCapability(env({ isSecureContext: false }))).toMatchObject({ ok: false, reason: 'insecure' })
    expect(pushCapability(env({ userAgent: IPHONE }))).toMatchObject({ ok: false, reason: 'ios-install', words: expect.stringContaining('Add to Home Screen') })
    expect(pushCapability(env({ userAgent: IPHONE, standalone: true }))).toEqual({ ok: true })
    expect(pushCapability(env({ hasServiceWorker: false }))).toMatchObject({ ok: false, reason: 'no-sw' })
    expect(pushCapability(env({ hasPushManager: false }))).toMatchObject({ ok: false, reason: 'no-push' })
    expect(pushCapability(env({ permission: 'denied' }))).toMatchObject({ ok: false, reason: 'denied' })
  })

  it('device labels and the key bytes', () => {
    expect(deviceLabel(IPHONE)).toBe('iPhone · Safari')
    expect(deviceLabel(IPHONE, true)).toBe('iPhone · Silos app')
    expect(deviceLabel(env().userAgent)).toBe('Android phone · Chrome')
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Mac · Firefox')
    expect([...keyBytes('AQID_-8')]).toEqual([1, 2, 3, 255, 239])
  })
})

function ops(over: Partial<PushOps> = {}): PushOps {
  return {
    env: () => env(),
    current: vi.fn(async () => null),
    subscribe: vi.fn(async () => ({
      endpoint: 'https://fcm.googleapis.com/x',
      toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } }),
    })),
    unsubscribe: vi.fn(async () => 'https://fcm.googleapis.com/x'),
    ...over,
  }
}

const device = { id: 'd1', label: 'Android phone · Chrome', endpoint: 'https://fcm.googleapis.com/x', createdAt: '2026-10-31T08:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  mockedApi.push.get.mockResolvedValue({ publicKey: 'BKEY', devices: [] })
  mockedApi.digest.get.mockResolvedValue({ hour: '08:00', band: null })
})

describe('<NotificationsTab>', () => {
  it('Turn on asks the browser, registers this device with its plain label, then lists it as this device', async () => {
    const o = ops()
    mockedApi.push.subscribe.mockResolvedValue(device)
    render(<NotificationsTab ops={o} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }))
    mockedApi.push.get.mockResolvedValue({ publicKey: 'BKEY', devices: [device] })
    await waitFor(() =>
      expect(mockedApi.push.subscribe).toHaveBeenCalledWith(
        { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } },
        'Android phone · Chrome',
      ),
    )
    expect(o.subscribe).toHaveBeenCalledWith('BKEY')
    expect(await screen.findByText('this device')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send a test' })).toBeInTheDocument()
  })

  it('a device already on: test and turn off', async () => {
    mockedApi.push.get.mockResolvedValue({ publicKey: 'BKEY', devices: [{ ...device, lastAcceptedAt: new Date().toISOString() }] })
    mockedApi.push.test.mockResolvedValue({ status: 201, device })
    mockedApi.push.revoke.mockResolvedValue(undefined)
    const o = ops({ current: vi.fn(async () => ({ endpoint: device.endpoint, toJSON: () => ({}) })) })
    render(<NotificationsTab ops={o} />)
    expect(await screen.findByText(/On — this device is “Android phone · Chrome”/)).toBeInTheDocument()
    expect(screen.getByText(/last delivered/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Send a test' }))
    expect(await screen.findByText('Sent. It should arrive within a few seconds.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(mockedApi.push.revoke).toHaveBeenCalledWith('d1'))
    expect(o.unsubscribe).toHaveBeenCalled()
  })

  it("a browser that can't: the reason, and no switch", async () => {
    render(<NotificationsTab ops={ops({ env: () => env({ isSecureContext: false }) })} />)
    expect(await screen.findByText(/not on HTTPS/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull()
  })

  it('another device can be revoked from here', async () => {
    mockedApi.push.get.mockResolvedValue({
      publicKey: 'BKEY',
      devices: [
        {
          ...device,
          id: 'd2',
          label: 'iPhone · Silos app',
          endpoint: 'https://web.push.apple.com/y',
          lastError: { at: new Date().toISOString(), status: 403 },
        },
      ],
    })
    mockedApi.push.revoke.mockResolvedValue(undefined)
    render(<NotificationsTab ops={ops()} />)
    expect(await screen.findByText('iPhone · Silos app')).toBeInTheDocument()
    expect(screen.getByText(/didn’t go through \(403\)/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(mockedApi.push.revoke).toHaveBeenCalledWith('d2'))
  })

  it('the digest hour: one row, saved as HH:MM', async () => {
    mockedApi.digest.setHour.mockResolvedValue({ hour: '07:30' })
    render(<NotificationsTab ops={ops()} />)
    const input = await screen.findByLabelText('Morning digest')
    await waitFor(() => expect(input).toHaveValue('08:00'))
    fireEvent.change(input, { target: { value: '07:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mockedApi.digest.setHour).toHaveBeenCalledWith('07:30'))
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument()
  })

  it('an older server: says so plainly', async () => {
    mockedApi.push.get.mockRejectedValue(new Error('not found'))
    render(<NotificationsTab ops={ops()} />)
    expect(await screen.findByText(/can’t send notifications yet/)).toBeInTheDocument()
  })
})
