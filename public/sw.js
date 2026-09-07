const CACHE = 'jelovnik-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Јавља отвореним прозорима да је стигао свежији јеловник. */
async function announceUpdate() {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) client.postMessage({ type: 'menu-updated' });
}

/**
 * Прво кеш, па освежавање у позадини.
 *
 * Бесплатан хостинг гаси услугу после петнаестак минута нерада, а буђење
 * траје и по двадесет секунди. Без овога би корисник све то време гледао
 * празан екран. Овако види јеловник одмах, а нови подаци стижу кад
 * сервер оживи. Јеловник се мења двапут месечно, па је оно из кеша
 * готово увек и тачно.
 */
async function cacheFirst(request, { notify = false, done = () => {} } = {}) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);

  const update = fetch(request)
    .then(async (response) => {
      if (!response.ok) return response;
      const copy = response.clone();
      if (notify && cached) {
        const [before, after] = await Promise.all([cached.clone().text(), copy.clone().text()]);
        await cache.put(request, copy);
        if (before !== after) await announceUpdate();
      } else {
        await cache.put(request, copy);
      }
      return response;
    })
    .catch(() => null)
    // Прегледач сме да угаси service worker чим одговор оде кориснику.
    // Тек кад ово јави да је готово, освежавање је стварно завршено.
    .finally(done);

  if (cached) return cached;

  const fresh = await update;
  if (fresh) return fresh;
  if (request.mode === 'navigate') return (await cache.match('/index.html')) || Response.error();
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Стање сервера и руте за распоред никад не иду из кеша.
  if (url.pathname === '/health' || url.pathname.startsWith('/api/cron')) return;

  // Одговор иде из кеша одмах, али освежавање тече и после тога. Без овог
  // продужетка живота прегледач га прекине чим пошаље одговор, па кеш
  // остане заувек стар. Тако је телефон и после промене времена најаве
  // наставио да приказује старо.
  let finished;
  event.waitUntil(new Promise((resolve) => { finished = resolve; }));

  event.respondWith(cacheFirst(request, {
    notify: url.pathname.startsWith('/api/'),
    done: finished,
  }));
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Јеловник', body: 'Отвори да видиш шта се служи.' };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Јеловник', {
      body: payload.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: payload.tag || 'jelovnik',
      renotify: true,
      data: { url: payload.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
