// sw.js — Service Worker for Push Notifications
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {}
  const title = data.title || '📡 EMA Signal Hunter'
  const options = {
    body: data.body || 'New signal detected',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'ema-signal',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' }
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(clients.openWindow(url))
})
