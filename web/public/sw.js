// sw.js — Silos' doorbell on this device.
// Two handlers and nothing else: `push` shows the notification the server
// sent (counts and kinds only — server/src/doorbell.ts), `notificationclick`
// brings Silos to Home. NO fetch handler and a scope (/push/) where no page
// lives: this worker never sees a request, never caches, never touches
// navigation, the new-version banner or a reload.
// To retire it, ship a version that calls self.registration.unregister().
self.addEventListener('install', () => {
  self.skipWaiting()
})
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === 'string' ? data.title : 'Silos'
  const body = typeof data.body === 'string' ? data.body : 'Something needs you'
  const tag = typeof data.tag === 'string' ? data.tag : 'silos'
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const c of windows) {
        if (new URL(c.url).origin !== self.location.origin) continue
        // an open Silos: bring it forward and send it Home (it isn't controlled
        // by this worker, so it is told, not navigated)
        c.postMessage({ silos: 'open-home' })
        if ('focus' in c) return c.focus()
        return undefined
      }
      return self.clients.openWindow('/')
    })(),
  )
})
