/* ═══════════════════════════════════════════════════════════════════════
   منصة نور — عامل الخدمة (Service Worker)
   • تخزين هيكل التطبيق للعمل دون اتصال
   • استراتيجية الشبكة أولاً لواجهات البيانات مع رجوع إلى الذاكرة المؤقتة
   • استقبال إشعارات الدفع (Web Push) على المتصفح والأندرويد والآيفون
   • مزامنة خلفية لإعادة إرسال العمليات التي تمت أثناء انقطاع الشبكة
   ═══════════════════════════════════════════════════════════════════════ */
const VERSION = 'noor-v1.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

const SHELL = [
  '/', '/index.html', '/offline.html', '/manifest.webmanifest',
  '/css/app.css',
  '/js/app.js', '/js/api.js', '/js/state.js', '/js/util.js',
  '/js/push.js', '/js/realtime.js', '/js/hijri.js',
  '/js/views/login.js', '/js/views/dashboard.js', '/js/views/tasks.js',
  '/js/views/committees.js', '/js/views/terms.js', '/js/views/hr.js',
  '/js/views/finance.js', '/js/views/forms.js', '/js/views/kpi.js',
  '/js/views/tickets.js', '/js/views/reports.js', '/js/views/imports.js',
  '/js/views/audit.js', '/js/views/org.js', '/js/views/settings.js',
  '/js/views/notifications.js',
  '/assets/icons/icon-192.png', '/assets/icons/icon-512.png', '/assets/icons/favicon.png'
];

// استعلامات تُحفظ نسخة منها للعرض دون اتصال
const CACHEABLE_API = [/\/api\/auth\/me$/, /\/api\/dashboard/, /\/api\/tasks/, /\/api\/notifications/, /\/api\/hr\/attendance\/today/];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'CLEAR_CACHE') caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return;

  // التنقل بين الصفحات → هيكل التطبيق
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;
        return await fetch(request);
      } catch {
        return (await caches.match('/index.html')) || (await caches.match('/offline.html'));
      }
    })());
    return;
  }

  // واجهات البيانات → الشبكة أولاً ثم الذاكرة المؤقتة
  if (url.pathname.startsWith('/api/')) {
    if (!CACHEABLE_API.some(re => re.test(url.pathname))) return;
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        if (res.ok) (await caches.open(DATA_CACHE)).put(request, res.clone());
        return res;
      } catch {
        const cached = await caches.match(request);
        if (cached) {
          const body = await cached.json();
          return new Response(JSON.stringify({ ...body, _offline: true }), {
            headers: { 'content-type': 'application/json', 'x-noor-offline': '1' }
          });
        }
        return new Response(JSON.stringify({ error: { code: 'OFFLINE', message: 'لا يوجد اتصال بالإنترنت' } }),
          { status: 503, headers: { 'content-type': 'application/json' } });
      }
    })());
    return;
  }

  // الأصول الثابتة → الذاكرة المؤقتة أولاً
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      fetch(request).then(r => { if (r.ok) caches.open(SHELL_CACHE).then(c => c.put(request, r)); }).catch(() => {});
      return cached;
    }
    try {
      const res = await fetch(request);
      if (res.ok) (await caches.open(SHELL_CACHE)).put(request, res.clone());
      return res;
    } catch {
      return caches.match('/offline.html');
    }
  })());
});

/* ─────────────────── إشعارات الدفع ─────────────────── */
const CATEGORY_ICON = {
  tasks: '/assets/icons/shortcut-tasks.png',
  finance: '/assets/icons/shortcut-new.png',
  tickets: '/assets/icons/shortcut-check.png'
};

self.addEventListener('push', (event) => {
  let payload = { title: 'منصة نور', body: 'لديك تحديث جديد', url: '/' };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; }
  catch { if (event.data) payload.body = event.data.text(); }

  const options = {
    body: payload.body,
    icon: CATEGORY_ICON[payload.category] || '/assets/icons/icon-192.png',
    badge: '/assets/icons/badge-72.png',
    dir: 'rtl',
    lang: 'ar',
    tag: payload.tag || 'noor',
    renotify: true,
    requireInteraction: payload.urgency === 'high',
    vibrate: payload.urgency === 'high' ? [200, 80, 200] : [120],
    timestamp: Date.now(),
    data: { url: payload.url || '/', ...(payload.data || {}) },
    actions: [
      { action: 'open', title: 'فتح' },
      { action: 'dismiss', title: 'تجاهل' }
    ]
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(payload.title, options);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: 'push', payload });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.location.origin)) {
        await c.focus();
        c.postMessage({ type: 'navigate', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) c.postMessage({ type: 'resubscribe' });
  })());
});

/* ─────────────────── المزامنة الخلفية ─────────────────── */
self.addEventListener('sync', (event) => {
  if (event.tag === 'noor-sync') {
    event.waitUntil((async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) c.postMessage({ type: 'sync' });
    })());
  }
});
