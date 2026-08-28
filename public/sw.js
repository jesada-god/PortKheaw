/* PortKheaw app-shell service worker.
 * Account, authentication, market data, and API responses are never cached here.
 */

/* Bumped to v5 to evict build output cached under v4: `/_next/static/` was
 * served cache-first with no revalidation, so a chunk that landed in the cache
 * stayed served forever. The `activate` handler below deletes every cache that
 * is not the current name, which is what clears those entries from installs
 * made before the change. (v4 was the manifest move, on the same mechanism.) */
const CACHE_NAME = 'nexora-shell-v5';

/*
 * A DEVELOPMENT HOST NEVER SERVES BUILD OUTPUT FROM THE CACHE.
 *
 * In production `/_next/static/` is content-addressed — a rebuild changes the
 * filename, so cache-first is both safe and the point of it. In development it
 * is not: `next dev` serves chunks from stable paths, so the URL for a component
 * is the SAME file before and after an edit. Cache-first therefore pins the
 * first version the browser ever saw and re-serves it indefinitely.
 *
 * That is invisible in the ways anyone would look for it. The navigation is
 * network-first, so the server render and its data are always current — the page
 * shows live numbers while running the old JavaScript beside them. Deleting
 * `.next`, restarting the dev server and hard-refreshing all leave it in place,
 * because none of them touches Cache Storage and a service worker intercepts
 * subresource requests regardless of a reload's cache mode.
 *
 * It cost a full day of chasing a portfolio card that had already been fixed,
 * committed and proved green in tests: the browser was running the JavaScript
 * from before the fix and nothing on disk disagreed.
 */
const IS_DEVELOPMENT_HOST = self.location.hostname === 'localhost'
  || self.location.hostname === '127.0.0.1'
  || self.location.hostname === '[::1]';

const SHELL = [
  '/offline',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon-180.png',
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
    (async () => {
      /*
       * ON A DEV HOST THE WORKER REMOVES ITSELF, whatever installed it.
       *
       * The guard in the fetch handler stops this worker pinning build output,
       * but it cannot speak for a worker installed before that guard existed —
       * and such a worker goes on controlling loaded tabs after its registration
       * is gone, serving whatever it cached. So any worker reaching `activate`
       * on a development host purges every cache and unregisters, which leaves
       * nothing behind that could answer a request with stale JavaScript.
       */
      const keys = await caches.keys();

      if (IS_DEVELOPMENT_HOST) {
        await Promise.all(keys.map((key) => caches.delete(key)));
        await self.registration.unregister();
        return;
      }

      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
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

  const isBuildOutput = url.pathname.startsWith('/_next/static/');

  const isStaticAsset =
    isBuildOutput ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/icon.svg' ||
    url.pathname === '/manifest.webmanifest';

  if (!isStaticAsset) {
    return;
  }

  // Build output on a dev host goes to the network every time. See above.
  if (isBuildOutput && IS_DEVELOPMENT_HOST) {
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
    const parsed = event.data ? event.data.json() : {};
    payload = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    payload = {};
  }

  const notificationOptions = {
    body: typeof payload.body === 'string'
      ? payload.body.slice(0, 1000)
      : 'มีการแจ้งเตือนใหม่',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: typeof payload.tag === 'string'
      ? payload.tag.slice(0, 200)
      : 'portkheaw-alert',
    renotify: false,
    data: {
      url: typeof payload.url === 'string'
        ? payload.url.slice(0, 500)
        : '/notifications',
    },
  };

  event.waitUntil(
    self.registration.showNotification(
      typeof payload.title === 'string'
        ? payload.title.slice(0, 160)
        : 'PortKheaw',
      notificationOptions,
    ),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  let targetUrl = new URL('/notifications', self.location.origin).href;
  try {
    const requestedUrl = new URL(
      event.notification.data?.url || '/notifications',
      self.location.origin,
    );
    if (requestedUrl.origin === self.location.origin) {
      targetUrl = requestedUrl.href;
    }
  } catch {
    // Keep the safe Inbox fallback for malformed legacy payloads.
  }

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
          try {
            await existingClient.navigate(targetUrl);
            return await existingClient.focus();
          } catch {
            // A tab can close between matchAll() and navigate().
            return self.clients.openWindow(targetUrl);
          }
        }

        return self.clients.openWindow(targetUrl);
      }),
  );
});
