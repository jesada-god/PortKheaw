/* PortKheaw app-shell service worker.
 * Account, authentication, market data, and API responses are never cached here.
 */

const CACHE_NAME = 'nexora-shell-v2';

const SHELL = [
  '/offline',
  '/manifest.json',
  '/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL)),
  );

  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        const oldCaches = keys.filter((key) => key !== CACHE_NAME);

        return Promise.all(
          oldCaches.map((key) => caches.delete(key)),
        );
      })
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // ไม่จัดการ request จาก domain อื่น
  if (url.origin !== self.location.origin) {
    return;
  }

  // ห้าม cache API, auth callback และข้อมูลที่ขึ้นกับบัญชีผู้ใช้
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/login') ||
    url.pathname.startsWith('/signup')
  ) {
    return;
  }

  // หน้าเว็บไซต์ใช้ network-first และ fallback ไปหน้า offline
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const offlineResponse = await caches.match('/offline');

        if (offlineResponse) {
          return offlineResponse;
        }

        return new Response('คุณกำลังออฟไลน์', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
          },
        });
      }),
    );

    return;
  }

  const isStaticAsset =
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/icon.svg' ||
    url.pathname === '/manifest.json';

  if (!isStaticAsset) {
    return;
  }

  // Static assets ใช้ cache-first
  event.respondWith(
    caches.match(request).then(async (cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      const networkResponse = await fetch(request);

      if (!networkResponse || !networkResponse.ok) {
        return networkResponse;
      }

      /*
       * ต้อง clone ทันที ก่อนส่ง response กลับหรือส่งให้ cache.put()
       * เพราะ Response body อ่านได้เพียงครั้งเดียว
       */
      const responseForCache = networkResponse.clone();

      event.waitUntil(
        caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(request, responseForCache))
          .catch(() => {
            // ไม่ทำให้หน้าเว็บล้ม หากเขียน cache ไม่สำเร็จ
          }),
      );

      return networkResponse;
    }),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const notificationOptions = {
    body: payload.body || 'มีการแจ้งเตือนใหม่',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || 'nexora-alert',
    renotify: false,
    data: {
      url: payload.url || '/notifications',
    },
  };

  event.waitUntil(
    self.registration.showNotification(
      payload.title || 'PortKheaw',
      notificationOptions,
    ),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || '/notifications',
    self.location.origin,
  ).href;

  event.waitUntil(
    self.clients
      .matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      .then(async (windowClients) => {
        const existingClient = windowClients.find((client) =>
          client.url.startsWith(self.location.origin),
        );

        if (existingClient) {
          await existingClient.navigate(targetUrl);
          return existingClient.focus();
        }

        return self.clients.openWindow(targetUrl);
      }),
  );
});
