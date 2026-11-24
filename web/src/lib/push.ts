// push.ts — this device and the doorbell: can this
// browser receive Silos' pushes, and if not, which reason — said plainly.
// The service worker (/sw.js) handles push and notificationclick only: no
// fetch handler, scoped to /push/ where no page lives, so it never touches
// navigation, the new-version banner or a reload.
export const SW_URL = '/sw.js'
export const SW_SCOPE = '/push/'

export type PushCapability = { ok: true } | { ok: false; reason: 'insecure' | 'no-sw' | 'ios-install' | 'no-push' | 'denied'; words: string }

// what the browser offers, read once — injectable for the tests
export interface PushEnv {
  isSecureContext: boolean
  hasServiceWorker: boolean
  hasPushManager: boolean
  hasNotification: boolean
  permission: 'default' | 'granted' | 'denied' | null
  userAgent: string
  standalone: boolean // opened from the Home Screen
}

export function readPushEnv(): PushEnv {
  const w = window as Window & { navigator: Navigator & { standalone?: boolean } }
  return {
    isSecureContext: w.isSecureContext,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in w,
    hasNotification: 'Notification' in w,
    permission: 'Notification' in w ? Notification.permission : null,
    userAgent: navigator.userAgent,
    standalone: w.matchMedia?.('(display-mode: standalone)').matches === true || w.navigator.standalone === true,
  }
}

const isIOS = (ua: string): boolean => /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))

export function pushCapability(env: PushEnv): PushCapability {
  if (!env.isSecureContext)
    return {
      ok: false,
      reason: 'insecure',
      words:
        'This page is not on HTTPS, so the browser won’t deliver notifications here. Open Silos through its https address (or on this machine at localhost).',
    }
  // iOS offers push only to an installed web app (iOS 16.4+)
  if (isIOS(env.userAgent) && !env.standalone)
    return {
      ok: false,
      reason: 'ios-install',
      words:
        'On iPhone and iPad, notifications reach Silos only once it is on your Home Screen: tap Share, then “Add to Home Screen”, open Silos from there and come back here.',
    }
  if (!env.hasServiceWorker)
    return {
      ok: false,
      reason: 'no-sw',
      words: 'This browser can’t run the small background script notifications need (no service workers — a private window often turns them off).',
    }
  if (!env.hasPushManager || !env.hasNotification) return { ok: false, reason: 'no-push', words: 'This browser doesn’t support web push notifications.' }
  if (env.permission === 'denied')
    return { ok: false, reason: 'denied', words: 'Notifications are blocked for this site. Allow them in the browser’s site settings, then come back here.' }
  return { ok: true }
}

// a device's name, from its user agent, in plain words («iPhone · Safari»)
export function deviceLabel(ua: string, standalone = false): string {
  const device = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? /Mobile/.test(ua)
          ? 'Android phone'
          : 'Android tablet'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /CrOS/.test(ua)
              ? 'Chromebook'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'A device'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua) || /FxiOS/.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua) || /CriOS/.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'browser'
  return standalone ? `${device} · Silos app` : `${device} · ${browser}`
}

// the VAPID public key (base64url) as the bytes PushManager.subscribe wants
export function keyBytes(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4)
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// this browser's current subscription, if any (never registers anything)
export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE)
  return reg ? reg.pushManager.getSubscription() : null
}

// ask permission, register the worker, subscribe with the instance's key
export async function subscribeThisDevice(publicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications were blocked for this site.' : 'Notifications were not allowed.')
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE })
  // subscribe needs an ACTIVE worker. (`navigator.serviceWorker.ready` would
  // never resolve: the worker controls /push/, not this page — on purpose.)
  await activated(reg)
  const existing = await reg.pushManager.getSubscription()
  if (existing) return existing
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource })
}

function activated(reg: ServiceWorkerRegistration): Promise<void> {
  if (reg.active) return Promise.resolve()
  const sw = reg.installing ?? reg.waiting
  if (!sw) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The notification worker did not start.')), 15_000)
    const on = (): void => {
      if (sw.state === 'activated') {
        clearTimeout(t)
        sw.removeEventListener('statechange', on)
        resolve()
      }
      if (sw.state === 'redundant') {
        clearTimeout(t)
        reject(new Error('The notification worker failed to install.'))
      }
    }
    sw.addEventListener('statechange', on)
    on()
  })
}

export async function unsubscribeThisDevice(): Promise<string | null> {
  const sub = await currentSubscription()
  if (!sub) return null
  const endpoint = sub.endpoint
  await sub.unsubscribe()
  return endpoint
}
