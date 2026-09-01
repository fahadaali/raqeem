/* ═══════════════════════════════════════════════════════════════════════
   منصة رقيم — عامل الخدمة (Service Worker)
   • تخزين هيكل التطبيق للعمل دون اتصال
   • استراتيجية الشبكة أولاً لواجهات البيانات مع رجوع إلى الذاكرة المؤقتة
   • استقبال إشعارات الدفع (Web Push) على المتصفح والأندرويد والآيفون
   • مزامنة خلفية لإعادة إرسال العمليات التي تمت أثناء انقطاع الشبكة
   ═══════════════════════════════════════════════════════════════════════ */
const VERSION = 'raqeem-v1.10.0';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;
const TILE_CACHE = `${VERSION}-tiles`;
/* سقفٌ لمربّعات الخريطة المحفوظة — نحو خمس عشرة شاشة، يكفي حيَّ المسجد ولا يتضخّم */
const TILE_KEEP = 320;

const SHELL = [
  '/', '/index.html', '/offline.html', '/manifest.webmanifest',
  '/css/app.css',
  '/js/app.js', '/js/api.js', '/js/state.js', '/js/util.js', '/js/icons.js',
  '/js/public-shell.js', '/js/map.js',
  '/js/push.js', '/js/realtime.js', '/js/hijri.js',
  '/js/views/login.js', '/js/views/dashboard.js', '/js/views/tasks.js',
  '/js/views/committees.js', '/js/views/terms.js', '/js/views/hr.js',
  '/js/views/workhours.js', '/js/views/chat.js',
  '/js/views/finance.js', '/js/views/forms.js', '/js/views/kpi.js',
  '/js/views/tickets.js', '/js/views/reports.js', '/js/views/imports.js',
  '/js/views/audit.js', '/js/views/org.js', '/js/views/settings.js',
  '/js/views/notifications.js', '/js/views/approvals.js',
  '/js/views/billing.js', '/js/views/pricing.js', '/js/views/signup.js',
  '/js/views/landing.js',
  '/js/admin-shell.js', '/js/admin-api.js', '/js/admin-state.js', '/js/views/admin/sections.js',
  '/assets/icons/icon-192.png', '/assets/icons/icon-512.png', '/assets/icons/favicon.png',
  /* ملفات الهوية — النمط الزخرفي والمونوغرام يظهران في كل شاشة */
  '/assets/brand/monogram-primary.svg', '/assets/brand/monogram-white.svg',
  '/assets/brand/pattern-overlay-cream.svg', '/assets/brand/pattern-overlay-green.svg',
  '/assets/brand/pattern-soft-cream.svg', '/assets/brand/pattern-soft-green.svg',
  '/assets/brand/pattern-tile-light.svg', '/assets/brand/pattern-tile-dark.svg'
];

/*
 * مربّعات الخريطة تُقصّ من ذاكرة قديمة حين تتجاوز السقف.
 * الأقدم أولاً لأن `cache.keys()` تعيدها بترتيب الإدراج، والمربّع الأقدم
 * أبعد ما يكون عن نطاق الفرع الذي يُفتح كل يوم.
 */
let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > TILE_KEEP) {
      await Promise.all(keys.slice(0, keys.length - TILE_KEEP).map(k => cache.delete(k)));
    }
  } catch { /* ذاكرةٌ ممتلئة أو محذوفة — لا يضرّ */ }
  finally { trimming = false; }
}

// استعلامات تُحفظ نسخة منها للعرض دون اتصال
const CACHEABLE_API = [/\/api\/auth\/me$/, /\/api\/dashboard/, /\/api\/tasks/, /\/api\/notifications/, /\/api\/hr\/attendance\/today/];

/*
 * نسخة نظيفة من الاستجابة بلا علَم إعادة التوجيه.
 * السبب: بعض المستضيفات (منها Cloudflare Static Assets) تعيد توجيه
 * `/index.html` إلى `/` بالرمز ٣٠٧، فتُخزَّن الاستجابة وعلَمها redirected=true،
 * والمتصفّح يرفض استجابةً موجَّهة داخل respondWith لطلب تنقّل فيسقط التنقّل
 * كلياً (ERR_FAILED) بدل أن يُخدَم هيكل التطبيق. إعادة بناء الاستجابة
 * تُسقط العلَم فتصلح للتنقّل دون اتصال.
 */
async function cleanCopy(res) {
  if (!res || !res.redirected) return res;
  return new Response(await res.blob(), {
    status: res.status, statusText: res.statusText, headers: res.headers
  });
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await Promise.allSettled(SHELL.map(async (u) => {
      const res = await fetch(new Request(u, { cache: 'reload' }));
      if (!res.ok) throw new Error(`${u}: ${res.status}`);
      await c.put(u, await cleanCopy(res));
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)));
    /*
     * التحميل المسبق للتنقّل (Navigation Preload) مُعطَّل عمداً.
     * حين يكون مُفعَّلاً وينقطع الاتصال، يُجهض المتصفّح التنقّل قبل أن يصل
     * حدث fetch إلى عامل الخدمة أصلاً — فلا يُخدَم هيكل التطبيق المخزّن
     * وتظهر شاشة «تعذّر الوصول». وهذا ما ثبت عملياً على بيئة Cloudflare.
     * ومكسبه ضئيل هنا: التطبيق صفحة واحدة (SPA) لا يقع فيه تنقّل كامل
     * بعد الإقلاع، فالعمل دون اتصال أولى من توفير جولة شبكة واحدة.
     */
    if (self.registration.navigationPreload) await self.registration.navigationPreload.disable();
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'CLEAR_CACHE') caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
});

/* هيكل التطبيق من الذاكرة المؤقتة، منظَّفاً من علَم إعادة التوجيه */
async function shellResponse() {
  for (const key of ['/index.html', '/']) {
    const hit = await caches.match(key, { ignoreVary: true });
    if (hit) return cleanCopy(hit);
  }
  return null;
}

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
        const res = await fetch(request);
        if (res && res.ok) return res;
        /* استجابة خطأ من الخادم: هيكل التطبيق أنفع للمستخدم من صفحة خطأ */
        return (await shellResponse()) || res;
      } catch {
        /* دون اتصال: هيكل التطبيق ثم صفحة الانقطاع، ولا نعيد undefined أبداً */
        return (await shellResponse())
          || (await cleanCopy(await caches.match('/offline.html', { ignoreVary: true })))
          || new Response('<!doctype html><meta charset="utf-8"><title>دون اتصال</title>'
            + '<body style="font-family:system-ui;text-align:center;padding:3rem" dir="rtl">'
            + '<h1>لا يوجد اتصال</h1><p>أعد المحاولة بعد عودة الشبكة.</p>',
            { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  /*
   * مربّعات الخريطة → الذاكرة أولاً.
   *
   * صورةٌ ثابتة لا تتغيّر، وإعادةُ جلبها في كل فتحةٍ لشاشة التحضير هدرٌ في
   * الشبكة وفي حصّة مزوّد الخرائط. والفائدة الأكبر: من فتح الشاشة مرّةً يرى
   * خريطةَ مسجده ونطاقَه دون اتصال — وهو أكثر ما يُحتاج في فناء المسجد.
   */
  if (url.pathname.startsWith('/api/map/tile/')) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(request, { ignoreVary: true });
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok) { await cache.put(request, res.clone()); trimTiles(cache); }
        return res;
      } catch {
        /* لا اتصال ولا نسخة: الخريطة تُخفي المربّع وتبقي الدائرة والعلامات */
        return new Response(null, { status: 504 });
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
            headers: { 'content-type': 'application/json', 'x-raqeem-offline': '1' }
          });
        }
        return new Response(JSON.stringify({ error: { code: 'OFFLINE', message: 'لا يوجد اتصال بالإنترنت' } }),
          { status: 503, headers: { 'content-type': 'application/json' } });
      }
    })());
    return;
  }

  /*
   * شيفرة التطبيق (js/css) → الشبكة أولاً، والذاكرة عند انقطاعها.
   *
   * كانت الذاكرةُ أولاً مع تحديثٍ في الخلفية: تُعرَض النسخة القديمة الآن وتُخزَّن
   * الجديدة للزيارة القادمة. فيبقى المستخدم دائماً وراء نسخةٍ كاملة، والأسوأ أن
   * الملفّات لا تتأخّر معاً — فيجتمع عنده جافاسكربت جديد مع تنسيقٍ قديم: عناصرُ
   * الشاشة الجديدة موجودةٌ في الصفحة بلا تنسيقٍ يعرفها، وألوانٌ من لوحةٍ سابقة.
   * ولا يُصلحه إلا تحديثٌ أو تحديثان — وهو ما كان يبدو أنّ التعديل لم يُنشر.
   *
   * والمهلة تحمي من الشبكة البطيئة: ثانيتان ثم تُخدَم الذاكرة، فلا يقف الإقلاع.
   */
  const isCode = /\.(?:js|css|webmanifest)$/.test(url.pathname);
  if (isCode) {
    event.respondWith((async () => {
      const fresh = fetch(request).then(async (res) => {
        if (res.ok) (await caches.open(SHELL_CACHE)).put(request, await cleanCopy(res.clone()));
        return res;
      });
      try {
        const res = await Promise.race([
          fresh,
          new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 2000))
        ]);
        if (res && res.ok) return res;
      } catch { /* بطيئة أو منقطعة — تُخدَم الذاكرة أدناه، والجلب يكمل للتخزين */ }
      return (await caches.match(request, { ignoreVary: true }))
        || fresh.catch(() => new Response('', { status: 504 }));
    })());
    return;
  }

  // بقية الأصول (صور وأيقونات وخطوط) → الذاكرة أولاً: ثابتةٌ وثقيلة
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreVary: true });
    if (cached) {
      fetch(request).then(r => { if (r.ok) caches.open(SHELL_CACHE).then(c => c.put(request, r)); }).catch(() => {});
      return cached;
    }
    try {
      const res = await fetch(request);
      if (res.ok) (await caches.open(SHELL_CACHE)).put(request, await cleanCopy(res.clone()));
      return res;
    } catch {
      return (await caches.match('/offline.html', { ignoreVary: true }))
        || new Response('', { status: 504 });
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
  let payload = { title: 'منصة رقيم', body: 'لديك تحديث جديد', url: '/' };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; }
  catch { if (event.data) payload.body = event.data.text(); }

  const options = {
    body: payload.body,
    icon: CATEGORY_ICON[payload.category] || '/assets/icons/icon-192.png',
    badge: '/assets/icons/badge-72.png',
    dir: 'rtl',
    lang: 'ar',
    tag: payload.tag || 'raqeem',
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
  if (event.tag === 'raqeem-sync') {
    event.waitUntil((async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) c.postMessage({ type: 'sync' });
    })());
  }
});
