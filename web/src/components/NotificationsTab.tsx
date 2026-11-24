// NotificationsTab — Settings › Notifications:
// the doorbell on THIS device (permission + subscribe), the devices it rings
// (plain words, revoke), and the hour of the morning digest. When this
// browser can't receive a push it says which reason, never a dead switch.
// What a push may say is fixed: counts and kinds only.
// A second section (one concept, one house) holds the other bell on
// this machine — Claude Code's own phone push, written in its settings.json.
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { relTime } from '../lib/rel-time'
import type { PushDeviceView } from '../lib/types'
import { currentSubscription, deviceLabel, pushCapability, readPushEnv, subscribeThisDevice, unsubscribeThisDevice, type PushEnv } from '../lib/push'

// the browser side, injectable for the tests (jsdom has no push)
export interface PushOps {
  env: () => PushEnv
  current: () => Promise<{ endpoint: string; toJSON: () => unknown } | null>
  subscribe: (publicKey: string) => Promise<{ endpoint: string; toJSON: () => unknown }>
  unsubscribe: () => Promise<string | null>
}
const browserOps: PushOps = { env: readPushEnv, current: currentSubscription, subscribe: subscribeThisDevice, unsubscribe: unsubscribeThisDevice }

const QUIET_BTN =
  'rounded-md border border-line bg-panel px-2.5 py-1 text-xs font-medium text-ink transition-colors duration-150 hover:border-ink-2 disabled:opacity-50'

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-t border-line py-3 first:border-t-0 first:pt-0">
      <div className="min-w-0 max-w-prose flex-1">
        <div className="text-sm text-ink">{label}</div>
        {hint ? <div className="mt-0.5 text-xs leading-relaxed text-ink-2">{hint}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  )
}

function deliveryWords(d: PushDeviceView, now: number): string {
  const added = `added ${new Date(d.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
  if (d.lastError && (!d.lastAcceptedAt || d.lastError.at > d.lastAcceptedAt)) {
    return `${added} · the last push didn’t go through (${d.lastError.status === 0 ? 'no answer' : d.lastError.status}) ${relTime(Date.parse(d.lastError.at), now)}`
  }
  return d.lastAcceptedAt ? `${added} · last delivered ${relTime(Date.parse(d.lastAcceptedAt), now)}` : `${added} · nothing sent yet`
}

export function NotificationsTab({ ops = browserOps }: { ops?: PushOps } = {}) {
  const [server, setServer] = useState<{ publicKey: string; devices: PushDeviceView[] } | null | 'missing'>(null)
  const [mine, setMine] = useState<string | null | undefined>(undefined) // this browser's endpoint
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [hour, setHour] = useState<string | null>(null)
  const [hourDraft, setHourDraft] = useState('')
  const [hourStatus, setHourStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const capability = pushCapability(ops.env())
  const now = Date.now()

  const reload = async (): Promise<void> => {
    try {
      setServer(await api.push.get())
    } catch {
      setServer('missing')
    }
  }

  useEffect(() => {
    void reload()
    api.digest
      .get()
      .then((r) => {
        setHour(r.hour)
        setHourDraft(r.hour)
      })
      .catch(() => setHour(''))
    if (capability.ok)
      ops
        .current()
        .then((s) => setMine(s?.endpoint ?? null))
        .catch(() => setMine(null))
    else setMine(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const devices = server && server !== 'missing' ? server.devices : []
  const thisDevice = mine ? (devices.find((d) => d.endpoint === mine) ?? null) : null

  async function turnOn(): Promise<void> {
    if (!server || server === 'missing') return
    setBusy(true)
    setNotice(null)
    try {
      const env = ops.env()
      const sub = await ops.subscribe(server.publicKey)
      await api.push.subscribe(sub.toJSON(), deviceLabel(env.userAgent, env.standalone))
      setMine(sub.endpoint)
      await reload()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function turnOff(): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      if (thisDevice) await api.push.revoke(thisDevice.id)
      await ops.unsubscribe()
      setMine(null)
      await reload()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function test(id: string): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const r = await api.push.test(id)
      setNotice(
        typeof r.status === 'number' && r.status >= 200 && r.status < 300
          ? 'Sent. It should arrive within a few seconds.'
          : r.status === 404 || r.status === 410
            ? 'That device unsubscribed — it was removed. Turn it on again from the device.'
            : `The push service refused it (${r.status === 'error' ? 'no answer' : r.status}).`,
      )
      await reload()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string): Promise<void> {
    setBusy(true)
    try {
      await api.push.revoke(id)
      if (thisDevice?.id === id) {
        await ops.unsubscribe().catch(() => null)
        setMine(null)
      }
      await reload()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveHour(): Promise<void> {
    setHourStatus('saving')
    try {
      const r = await api.digest.setHour(hourDraft)
      setHour(r.hour)
      setHourStatus('saved')
    } catch {
      setHourStatus('error')
    }
  }

  // this device's row: what it can do, said plainly
  let deviceHint: ReactNode
  let deviceControl: ReactNode = null
  if (server === 'missing') {
    deviceHint = 'This Silos server can’t send notifications yet — restart it after updating.'
  } else if (!capability.ok) {
    deviceHint = capability.words
  } else if (server === null || mine === undefined) {
    deviceHint = 'Checking this browser…'
  } else if (thisDevice) {
    deviceHint = `On — this device is “${thisDevice.label}”.`
    deviceControl = (
      <>
        <button type="button" className={QUIET_BTN} disabled={busy} onClick={() => void test(thisDevice.id)}>
          Send a test
        </button>
        <button type="button" className={QUIET_BTN} disabled={busy} onClick={() => void turnOff()}>
          Turn off
        </button>
      </>
    )
  } else {
    deviceHint = 'Off. Your browser will ask for permission once.'
    deviceControl = (
      <button type="button" className={QUIET_BTN} disabled={busy} onClick={() => void turnOn()}>
        {busy ? 'Turning on…' : 'Turn on'}
      </button>
    )
  }

  const hourValid = /^([01]\d|2[0-3]):[0-5]\d$/.test(hourDraft)

  return (
    <div className="mx-auto w-full max-w-2xl px-6 pb-16 md:px-10">
      <section className="py-8">
        <header className="mb-4">
          <h2 className="font-display text-[19px] leading-tight text-ink">Notifications</h2>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-2">
            Silos rings your devices when something new needs you — a question, an approval, a failed run — and once each morning with the digest. A
            notification says how many and what kind, never a name or what a row says. Tapping it opens Home.
          </p>
        </header>
        <div className="text-sm text-ink-2">
          <Row label="This device" hint={deviceHint}>
            {deviceControl}
          </Row>
          {notice ? (
            <p role="status" className="-mt-1 pb-3 text-xs text-ink-2">
              {notice}
            </p>
          ) : null}
          {server && server !== 'missing' ? (
            <Row
              label="Devices"
              hint={
                devices.length === 0
                  ? 'None yet. Turn this on from each phone or computer that should ring.'
                  : 'Every device here gets the same notifications. Revoke one you no longer use.'
              }
            />
          ) : null}
          {devices.length > 0 ? (
            <ul className="-mt-1 mb-2 divide-y divide-line/60" data-testid="push-devices">
              {devices.map((d) => (
                <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                  <div className="min-w-0">
                    <span className="text-[13px] text-ink">{d.label}</span>
                    {thisDevice?.id === d.id ? <span className="ml-2 font-mono text-[10.5px] text-terracotta">this device</span> : null}
                    <div className="text-xs text-ink-3">{deliveryWords(d, now)}</div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void revoke(d.id)}
                    className="shrink-0 text-xs text-ink-2 underline-offset-2 hover:text-terracotta hover:underline disabled:opacity-50"
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {hour !== '' ? (
            <Row
              label={<label htmlFor="digest-hour">Morning digest</label>}
              hint={
                <>
                  Every day at this hour Silos writes down what waits, what happened and what’s coming. Home shows it until you mark it seen; each device above
                  gets one notification.
                  {hourStatus === 'saved' ? ' Saved.' : ''}
                  {hourStatus === 'error' ? <span className="text-terracotta"> Could not save the hour.</span> : null}
                </>
              }
            >
              <input
                id="digest-hour"
                type="time"
                value={hourDraft}
                onChange={(e) => {
                  setHourDraft(e.target.value)
                  setHourStatus('idle')
                }}
                disabled={hour === null}
                className="rounded-md border border-line bg-panel px-2 py-1 font-mono text-xs text-ink"
              />
              <button
                type="button"
                className={QUIET_BTN}
                disabled={hour === null || !hourValid || hourDraft === hour || hourStatus === 'saving'}
                onClick={() => void saveHour()}
              >
                {hourStatus === 'saving' ? 'Saving…' : 'Save'}
              </button>
            </Row>
          ) : null}
        </div>
      </section>
      <ClaudeCodePush />
    </div>
  )
}

// Claude Code's mobile app pings the phone when an agent is left waiting —
// Claude Code's own bell, not Silos': the switch writes agentPushNotifEnabled
// in ~/.claude/settings.json (a documented setting; Claude Code is sacred).
function ClaudeCodePush() {
  const [on, setOn] = useState<boolean | null | undefined>(undefined)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  useEffect(() => {
    let cancelled = false
    Promise.resolve(api.claudeSettings())
      .then((v) => {
        if (!cancelled) setOn(v?.agentPushNotifEnabled ?? null)
      })
      .catch(() => {
        if (!cancelled) setOn(null)
      })
    return () => {
      cancelled = true
    }
  }, [])
  async function toggle(): Promise<void> {
    if (typeof on !== 'boolean') return
    setStatus('saving')
    try {
      const r = await api.setAgentPushNotif(!on)
      setOn(r.view.agentPushNotifEnabled)
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }
  return (
    <section className="border-t border-line py-8" data-testid="claude-code-push">
      <header className="mb-4">
        <h2 className="font-display text-[19px] leading-tight text-ink">From Claude Code&rsquo;s app</h2>
        <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-2">
          Claude Code rings your phone on its own, through its mobile app — separate from Silos&rsquo; notifications above.
        </p>
      </header>
      <div className="text-sm text-ink-2">
        <Row
          label={<label htmlFor="cc-push">Push notifications on your phone</label>}
          hint={
            on === undefined ? (
              'Reading Claude Code’s settings…'
            ) : on === null ? (
              <span className="text-terracotta">Could not read ~/.claude/settings.json.</span>
            ) : (
              <>
                When an agent is left waiting — a question open, a long task finished unattended.
                {status === 'saved' ? ' Saved.' : ''}
                {status === 'error' ? <span className="text-terracotta"> Could not write settings.json.</span> : null}
              </>
            )
          }
        >
          {typeof on === 'boolean' ? (
            <input
              id="cc-push"
              type="checkbox"
              checked={on}
              onChange={() => void toggle()}
              disabled={status === 'saving'}
              className="h-4 w-4 accent-terracotta"
            />
          ) : null}
        </Row>
      </div>
    </section>
  )
}
