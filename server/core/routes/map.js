import { Hono } from 'hono';
import { h } from '../http.js';
import { badRequest } from '../errors.js';
import { rateLimit } from '../middleware/rateLimit.js';

/**
 * مربّعات الخريطة وكتالوج طبقاتها.
 *
 * لماذا وسيطٌ على الخادم بدل استدعاء قوقل من المتصفّح مباشرة؟ لثلاثة أسباب:
 *   • المفتاح لا يغادر الخادم — ولو وُضع في الصفحة لقُرئ منها.
 *   • سياسة الأمان تبقى كما هي (`img-src 'self'`) بلا فتح نطاقٍ جديد.
 *   • خصوصية المُحضِّر: قوقل يرى خادمنا لا جهازَ صاحب الموقع. وهذا هو التعهّد
 *     نفسه الذي في `web/js/map.js` منذ أول نسخة، ويبقى قائماً بعد أن صارت
 *     الخريطة تتحرّك وتتمركز على المستخدم حين يطلب ذلك.
 *
 * ولا مصادقة هنا: المربّعات صورٌ في وسم <img> ولا يحمل ترويسة `Authorization`،
 * والمعروض خرائط عامة لا بيانات جهة. فالحماية حدُّ طلبات ضيّق وتحقّقٌ صارم من
 * المُدخلات، حتى لا يصير المسار وسيطاً مفتوحاً لمن شاء.
 */
const router = new Hono();

/* طبقات قوقل عبر Map Tiles API — الاسم كما تعرفه الواجهة، والمواصفة كما يطلبها قوقل */
const GOOGLE_LAYERS = {
  roadmap: { label: 'خريطة', mapType: 'roadmap', layerTypes: [], maxZoom: 20 },
  satellite: { label: 'قمر صناعي', mapType: 'satellite', layerTypes: [], maxZoom: 20 },
  hybrid: { label: 'قمر صناعي بالأسماء', mapType: 'satellite', layerTypes: ['layerRoadmap'], maxZoom: 20 },
  terrain: { label: 'تضاريس', mapType: 'terrain', layerTypes: ['layerRoadmap'], maxZoom: 18 }
};

/* الطبقة المفتوحة — تعمل بلا مفتاح، وهي المرجع حين يتعذّر قوقل */
const OSM = {
  id: 'osm',
  label: 'خريطة مفتوحة',
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  subdomains: ['a', 'b', 'c'],
  max_zoom: 19,
  attribution: '© OpenStreetMap',
  attribution_url: 'https://www.openstreetmap.org/copyright'
};

const googleKey = (app) => app.cfg.maps?.googleKey || '';

/*
 * قوقل يسقط أحياناً: مفتاحٌ خاطئ، أو Map Tiles API غير مفعّلة، أو حصّةٌ نفدت.
 * ولو طاردناه مع كل مربّع لأرسلنا عشرين طلباً فاشلاً في كل شاشة. فتُعلَّق طبقاته
 * دقيقةً كاملة، وتُخدَم المربّعات من الطبقة المفتوحة، ويُقال ذلك في السجلّ مرّة
 * ليصلح المشغّل المفتاح — والخريطة تبقى تعمل طوال ذلك.
 */
const GOOGLE_COOLDOWN_MS = 60_000;
let googleDownUntil = 0;
const googleUp = (app) => Boolean(googleKey(app)) && Date.now() >= googleDownUntil;
function googleFailed(reason) {
  if (Date.now() < googleDownUntil) return;
  googleDownUntil = Date.now() + GOOGLE_COOLDOWN_MS;
  sessions.clear();
  console.warn(`[map] تعذّرت خرائط قوقل (${reason}) — الخريطة على الطبقة المفتوحة لدقيقة`);
}

/**
 * كتالوج الطبقات — تقرؤه الواجهة مرة واحدة فتبني منه مبدّل الطبقات.
 * حين لا مفتاح لقوقل — أو حين تكون طبقاته معلّقة — تبقى الطبقة المفتوحة وحدها،
 * ويختفي المبدّل من الخريطة من تلقاء نفسه: زرٌّ لخيارٍ واحد زينةٌ لا أداة.
 * وبذلك تبقى نسبةُ المصدر في حاشية الخريطة صادقةً على ما يُعرَض فعلاً.
 */
router.get('/layers', h(async (req) => {
  if (!googleUp(req.app)) return { provider: 'osm', default: OSM.id, layers: [OSM] };
  return {
    provider: 'google',
    default: 'roadmap',
    layers: [
      ...Object.entries(GOOGLE_LAYERS).map(([id, spec]) => ({
        id,
        label: spec.label,
        url: `/api/map/tile/${id}/{z}/{x}/{y}`,
        max_zoom: spec.maxZoom,
        attribution: 'خرائط قوقل',
        attribution_url: 'https://www.google.com/maps'
      })),
      OSM
    ]
  };
}));

/*
 * رمز الجلسة الذي تشترطه Map Tiles API قبل أول مربّع — يُطلب مرة لكل طبقة
 * ويُعاد استعماله حتى انتهاء صلاحيته. والذاكرة هنا لكل عزلة تشغيل، فأسوأ ما
 * يحدث عند تعدّدها طلبُ رمزٍ زائد لا خطأ.
 */
const sessions = new Map();

async function googleSession(app, layerId) {
  const cached = sessions.get(layerId);
  if (cached && cached.expiry > Date.now() + 60_000) return cached.token;
  if (cached?.pending) return cached.pending;

  const spec = GOOGLE_LAYERS[layerId];
  const pending = (async () => {
    const res = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(googleKey(app))}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mapType: spec.mapType,
        language: 'ar',
        region: 'SA',
        scale: 'scaleFactor1x',
        highDpi: false,
        ...(spec.layerTypes.length ? { layerTypes: spec.layerTypes } : {})
      })
    });
    if (!res.ok) throw new Error(`createSession ${res.status}`);
    const data = await res.json();
    /* `expiry` ثوانٍ منذ الحقبة نصّاً — وقد تنقص، فنطرح دقيقةً احتياطاً */
    const expiry = (Number(data.expiry) * 1000) || (Date.now() + 60 * 60_000);
    sessions.set(layerId, { token: data.session, expiry });
    return data.session;
  })();

  sessions.set(layerId, { token: cached?.token, expiry: 0, pending });
  try { return await pending; } catch (e) { sessions.delete(layerId); throw e; }
}

/** مربّع من الطبقة المفتوحة — المرجع حين يتعذّر قوقل أو لا مفتاح له */
const osmTile = (z, x, y) =>
  fetch(`https://${OSM.subdomains[(x + y) % OSM.subdomains.length]}.tile.openstreetmap.org/${z}/${x}/${y}.png`,
    { headers: { 'user-agent': 'Raqeem/1.0 (+https://github.com/fahadaali/raqeem)' } });

/*
 * حدٌّ واسع نسبياً لأن المربّعات تأتي دفعةً واحدة: شاشةٌ كاملة نحو عشرين مربّعاً،
 * والتحريك والتكبير يطلبان مثلها. والضيقُ هنا يكسر الخريطة لا يحميها.
 */
router.use('/tile/*', rateLimit({ windowMs: 60_000, max: 900, key: (r) => `tile:${r.ip}` }));

router.get('/tile/:layer/:z/:x/:y', h(async (req) => {
  const layer = String(req.params.layer || '');
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);

  /* تحقّقٌ صارم قبل أي طلبٍ خارجي — المسار عام، فلا يُمرَّر إليه إلا عددٌ في مداه */
  if (!Number.isInteger(z) || z < 0 || z > 22) throw badRequest('تكبير خارج المدى');
  const n = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) {
    throw badRequest('إحداثيات مربّع خارج المدى');
  }
  if (layer !== OSM.id && !GOOGLE_LAYERS[layer]) throw badRequest('طبقة غير معروفة');

  const googleTile = async (token) => fetch(
    `https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}`
    + `?session=${encodeURIComponent(token)}&key=${encodeURIComponent(googleKey(req.app))}`);

  let res = null;
  if (layer !== OSM.id && googleUp(req.app)) {
    try {
      res = await googleTile(await googleSession(req.app, layer));
      /* رمزٌ انتهت صلاحيته: يُسقَط ويُطلب غيره مرة واحدة لا أكثر */
      if (res.status === 401 || res.status === 403) {
        sessions.delete(layer);
        res = await googleTile(await googleSession(req.app, layer));
      }
      if (!res.ok) googleFailed(`رمز ${res.status}`);
    } catch (e) { googleFailed(e?.message || 'خطأ شبكة'); res = null; }
  }
  const fromGoogle = Boolean(res?.ok);

  /*
   * تعذّر قوقل فالمربّع المفتوح أنفع من خطأ: الخريطة تبقى تعمل والنطاق يبقى
   * مقروءاً. وكتالوج الطبقات يعود إلى «المفتوحة» طوال مدّة التعليق، فمن يفتح
   * الشاشة بعدها يرى المصدر الصحيح في الحاشية.
   */
  if (!fromGoogle) {
    try { res = await osmTile(z, x, y); } catch { res = null; }
  }
  if (!res || !res.ok) return new Response(null, { status: 502 });

  return new Response(res.body, {
    headers: {
      'Content-Type': res.headers.get('content-type') || 'image/png',
      /* المربّعات لا تتغيّر إلا نادراً — أسبوعٌ يوفّر طلباً ويُبقيها حاضرة */
      'Cache-Control': 'public, max-age=604800',
      'X-Map-Layer': fromGoogle ? layer : OSM.id
    }
  });
}));

export default router;
