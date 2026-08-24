import { Hono } from 'hono';
import { h } from '../http.js';
import { badRequest } from '../errors.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { platformSettings } from '../billing.js';

/**
 * مربّعات الخريطة وكتالوج طبقاتها.
 *
 * لماذا وسيطٌ على الخادم بدل استدعاء المزوّد من المتصفّح مباشرة؟ لأربعة أسباب:
 *   • المفتاح لا يغادر الخادم — ولو وُضع في الصفحة لقُرئ منها.
 *   • سياسة الأمان تبقى كما هي (`img-src 'self'`) بلا فتح نطاقٍ جديد.
 *   • خصوصية المُحضِّر: المزوّد يرى خادمنا لا جهازَ صاحب الموقع.
 *   • والمربّعات تُخزَّن مرّةً للجميع لا مرّةً لكل متصفّح — وهذا ما يجعل
 *     الحصص المجانية تكفي (انظر «ذاكرة المربّعات» أدناه).
 *
 * ولا مصادقة هنا: المربّعات صورٌ في وسم <img> ولا يحمل ترويسة `Authorization`،
 * والمعروض خرائط عامة لا بيانات جهة. فالحماية حدُّ طلبات ضيّق وتحقّقٌ صارم من
 * المُدخلات، حتى لا يصير المسار وسيطاً مفتوحاً لمن شاء.
 */
const router = new Hono();

/* ── الطبقة المفتوحة: تعمل بلا مفتاح ولا تسجيل، وهي المرجع حين يتعذّر غيرها ──
   بيانات OpenStreetMap مفتوحة للاستعمال التجاري برخصة ODbL مع النسبة، وخادمُ
   مربّعاتها تبرّعيّ «للاستعمال الخفيف» — فلا يُمرَّر عبر وسيطنا إلا احتياطاً،
   ويُعطى المتصفّحُ عنوانَه مباشرةً في الأحوال العادية. */
const OSM = {
  id: 'osm',
  label: 'خريطة مفتوحة',
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  subdomains: ['a', 'b', 'c'],
  max_zoom: 19,
  attribution: '© OpenStreetMap',
  attribution_url: 'https://www.openstreetmap.org/copyright',
  free: true
};

/* ── طبقات قوقل عبر Map Tiles API ──
   وحدها تعطي صور الأقمار والتضاريس. وحصّة «2D Map Tiles» مئة ألف مربّعٍ شهرياً
   بلا مقابل، وذاكرةُ الخادم أدناه تجعلها بعيدةً عن المنال: نطاقُ فرعٍ واحد بضع
   عشرات من المربّعات تُجلب مرّةً للجميع. والعائق مالٌ لا كثرة: قوقل يشترط بطاقةً
   وفوترةً مفعّلة في المشروع ولو لم يُحاسِب عليها شيئاً — ولذلك كانت Geoapify. */
const GOOGLE_LAYERS = {
  roadmap:   { label: 'خريطة قوقل',            mapType: 'roadmap',   layerTypes: [],                maxZoom: 20 },
  satellite: { label: 'قمر صناعي',             mapType: 'satellite', layerTypes: [],                maxZoom: 20 },
  hybrid:    { label: 'قمر صناعي بالأسماء',    mapType: 'satellite', layerTypes: ['layerRoadmap'],  maxZoom: 20 },
  terrain:   { label: 'تضاريس',                mapType: 'terrain',   layerTypes: ['layerRoadmap'],  maxZoom: 18 }
};

/* ── طبقات Geoapify ──
   مفتاحٌ مجاني بلا بطاقة ولا فوترة، وحصّته ثلاثة آلاف رصيدٍ يومياً والمربّع رُبع
   رصيد — اثنا عشر ألف مربّعٍ في اليوم، ويُسمح بالاستعمال التجاري ضمنها شرط بقاء
   نسبة «Powered by Geoapify» رابطاً متبوعاً في حاشية الخريطة.

   وهي أنظف أسلوباً من نمط OSM القياسي وأخفّ على العين تحت النطاق والدبّوس —
   لكنّها بلا صور أقمار، فبياناتها من OpenStreetMap نفسها. */
const GEOAPIFY_LAYERS = {
  bright: { label: 'خريطة ملوّنة', style: 'osm-bright-smooth', maxZoom: 20 },
  quiet:  { label: 'خريطة هادئة',  style: 'positron',          maxZoom: 20 },
  night:  { label: 'خريطة داكنة',  style: 'dark-matter',       maxZoom: 20 }
};

const GEOAPIFY_ATTR = { attribution: 'Powered by Geoapify · © OpenStreetMap', attribution_url: 'https://www.geoapify.com/' };
const GOOGLE_ATTR = { attribution: 'خرائط قوقل', attribution_url: 'https://www.google.com/maps' };

/*
 * رمز الجلسة الذي تشترطه Map Tiles API — يُطلب مرة لكل طبقة ويُعاد استعماله.
 * والذاكرة هنا لكل عزلة تشغيل، فأسوأ ما يحدث عند تعدّدها طلبُ رمزٍ زائد لا خطأ.
 */
const sessions = new Map();

/**
 * مفاتيح المزوّدين — من لوحة المنصة أولاً ثم من بيئة التشغيل.
 *
 * وضعُها في اللوحة يجعل تفعيل مزوّدٍ قراراً يُتَّخذ من الشاشة لا نشرةً تُعاد،
 * ومتغيّرُ البيئة يبقى لمن ينشر بلا لوحة أو يُفضّل الأسرار خارج القاعدة.
 *
 * وتُحفَظ دقيقةً في الذاكرة: المربّعات تأتي عشرينَ في الشاشة الواحدة، فقراءةُ
 * الإعدادات مع كل مربّع استعلامٌ بلا داعٍ. وتُسقَط فور الحفظ من اللوحة.
 */
const KEY_TTL_MS = 60_000;
let keyCache = { at: 0, google: '', geoapify: '' };

/** تُسقط ذاكرة المفاتيح وتعليقَ المزوّدين — تُنادى من لوحة المنصة فور حفظ الإعدادات */
export function forgetMapsKey() {
  keyCache = { at: 0, google: '', geoapify: '' };
  downUntil.google = 0; downUntil.geoapify = 0;
  sessions.clear();
}

async function keys(app) {
  if (keyCache.at && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache;
  let s = null;
  try { s = await platformSettings(app); }
  catch { /* الجدول لم يُنشأ بعد — تبقى البيئة */ }
  keyCache = {
    at: Date.now(),
    google: s?.maps_google_key || app.cfg.maps?.googleKey || '',
    geoapify: s?.maps_geoapify_key || app.cfg.maps?.geoapifyKey || ''
  };
  return keyCache;
}

/*
 * المزوّد يسقط أحياناً: مفتاحٌ خاطئ، أو خدمةٌ غير مفعّلة في المشروع، أو حصّةٌ نفدت.
 * ولو طاردناه مع كل مربّع لأرسلنا عشرين طلباً فاشلاً في كل شاشة وعشرين سطراً في
 * السجلّ. فيُعلَّق دقيقةً كاملة، وتُخدَم المربّعات من الطبقة المفتوحة، ويُقال ذلك
 * مرّةً واحدة ليصلح المشغّل المفتاح — والخريطة تبقى تعمل طوال ذلك.
 *
 * ويُسقَط الكتالوج معه: من فتح الشاشة أثناء التعليق يرى «خريطة مفتوحة» في
 * الحاشية، فتبقى نسبةُ المصدر صادقةً على ما يُعرَض فعلاً لا على ما كان مضبوطاً.
 */
const COOLDOWN_MS = 60_000;
const NAMES = { google: 'خرائط قوقل', geoapify: 'Geoapify' };
const downUntil = { google: 0, geoapify: 0 };

const providerUp = async (app, name) =>
  Boolean((await keys(app))[name]) && Date.now() >= downUntil[name];

function providerFailed(name, reason) {
  if (Date.now() < downUntil[name]) return;
  downUntil[name] = Date.now() + COOLDOWN_MS;
  if (name === 'google') sessions.clear();
  keyCache = { at: 0, google: '', geoapify: '' };   /* لعلّ المفتاح بُدّل من اللوحة إصلاحاً للعطل */
  console.warn(`[map] تعذّرت ${NAMES[name]} (${reason}) — الخريطة على الطبقة المفتوحة لدقيقة`);
}

const proxied = (id, spec, attr) => ({
  id, label: spec.label, url: `/api/map/tile/${id}/{z}/{x}/{y}`, max_zoom: spec.maxZoom, ...attr
});

/**
 * كتالوج الطبقات — تقرؤه الواجهة مرة واحدة فتبني منه مبدّل الطبقات.
 *
 * يُبنى ممّا هو مضبوطٌ فعلاً: طبقاتُ قوقل إن كان مفتاحه، وطبقاتُ Geoapify إن
 * كان مفتاحها، والمفتوحةُ دائماً. وبلا مفتاحٍ أصلاً تبقى المفتوحة وحدها فيختفي
 * المبدّل من تلقاء نفسه — زرٌّ لخيارٍ واحد زينةٌ لا أداة. وبذلك تبقى نسبةُ
 * المصدر في حاشية الخريطة صادقةً على ما يُعرَض فعلاً.
 */
router.get('/layers', h(async (req) => {
  const layers = [];
  if (await providerUp(req.app, 'google')) {
    for (const [id, spec] of Object.entries(GOOGLE_LAYERS)) layers.push(proxied(id, spec, GOOGLE_ATTR));
  }
  if (await providerUp(req.app, 'geoapify')) {
    for (const [id, spec] of Object.entries(GEOAPIFY_LAYERS)) layers.push(proxied(id, spec, GEOAPIFY_ATTR));
  }
  layers.push(OSM);
  return {
    provider: layers[0].id === OSM.id ? 'osm' : (GOOGLE_LAYERS[layers[0].id] ? 'google' : 'geoapify'),
    default: layers[0].id,
    layers
  };
}));

async function googleSession(app, layerId) {
  const cached = sessions.get(layerId);
  if (cached && cached.expiry > Date.now() + 60_000) return cached.token;
  if (cached?.pending) return cached.pending;

  const spec = GOOGLE_LAYERS[layerId];
  const key = (await keys(app)).google;
  const pending = (async () => {
    const res = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
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

/** مربّع من الطبقة المفتوحة — المرجع حين يتعذّر المزوّد المضبوط */
const osmTile = (z, x, y) =>
  fetch(`https://${OSM.subdomains[(x + y) % OSM.subdomains.length]}.tile.openstreetmap.org/${z}/${x}/${y}.png`,
    { headers: { 'user-agent': 'Raqeem/1.0 (+https://github.com/fahadaali/raqeem)' } });

/* ── ذاكرة المربّعات على الخادم ─────────────────────────────────────────
 *
 * هذه هي التي تجعل الحصص المجانية تكفي.
 *
 * نطاقُ فرعٍ واحد — مسجدٌ ودائرةُ ثمانين متراً حوله — بضعُ عشرات من المربّعات
 * عبر مستويات التكبير كلّها. وبلا ذاكرةٍ على الخادم يدفع كلُّ متصفّحٍ ثمنَها من
 * حصّة المزوّد: ثلاثون معلّماً يفتحون الشاشة يومياً = آلافُ المربّعات شهرياً.
 * وبها تُجلب المربّعات مرّةً واحدةً للجميع وتُخدَم من الحافّة بعدها.
 *
 * على Cloudflare تُستعمل ذاكرة الحافّة (`caches.default`) فتُشارَك بين الطلبات
 * كلِّها. وعلى التشغيل الذاتي ذاكرةٌ في العملية بسقفٍ معلوم — المربّع نحو ٢٠
 * كيلوبايت، فأربعمئة منها ثمانية ميغابايت لا أكثر.
 */
const MEM_MAX = 400;
const mem = new Map();
const edgeCache = () => { try { return typeof caches !== 'undefined' ? caches.default : null; } catch { return null; } };

function memGet(key) {
  const hit = mem.get(key);
  if (!hit) return null;
  /* الأحدث استعمالاً يعود إلى ذيل الترتيب فلا يُطرَح قبل غيره */
  mem.delete(key); mem.set(key, hit);
  return hit;
}
function memPut(key, value) {
  mem.set(key, value);
  while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

const tileHeaders = (type, source) => ({
  'Content-Type': type || 'image/png',
  /* المربّعات لا تتغيّر إلا نادراً — أسبوعٌ يوفّر طلباً ويُبقيها حاضرة */
  'Cache-Control': 'public, max-age=604800',
  'X-Map-Layer': source
});

/*
 * حدٌّ واسع نسبياً لأن المربّعات تأتي دفعةً واحدة: شاشةٌ كاملة نحو عشرين مربّعاً،
 * والتحريك والتكبير يطلبان مثلها. والضيقُ هنا يكسر الخريطة لا يحميها.
 */
router.use('/tile/*', rateLimit({ windowMs: 60_000, max: 900, key: (r) => `tile:${r.ip}` }));

router.get('/tile/:layer/:z/:x/:y', h(async (req, c) => {
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
  if (layer !== OSM.id && !GOOGLE_LAYERS[layer] && !GEOAPIFY_LAYERS[layer]) throw badRequest('طبقة غير معروفة');

  /* ذاكرة الحافّة أولاً، ثم ذاكرة العملية — قبل أن يُمَسّ المزوّد */
  const raw = c?.req?.raw;
  const cache = edgeCache();
  if (cache && raw) {
    const hit = await cache.match(raw).catch(() => null);
    if (hit) return hit;
  }
  const memKey = `${layer}/${z}/${x}/${y}`;
  const cached = memGet(memKey);
  if (cached) return new Response(cached.body, { headers: tileHeaders(cached.type, cached.source) });

  const k = await keys(req.app);
  let res = null, source = null;

  if (GOOGLE_LAYERS[layer] && await providerUp(req.app, 'google')) {
    const googleTile = async (token) => fetch(
      `https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}`
      + `?session=${encodeURIComponent(token)}&key=${encodeURIComponent(k.google)}`);
    try {
      res = await googleTile(await googleSession(req.app, layer));
      /* رمزٌ انتهت صلاحيته: يُسقَط ويُطلب غيره مرة واحدة لا أكثر */
      if (res.status === 401 || res.status === 403) {
        sessions.delete(layer);
        res = await googleTile(await googleSession(req.app, layer));
      }
      if (res.ok) source = layer; else providerFailed('google', `رمز ${res.status}`);
    } catch (e) { providerFailed('google', e?.message || 'خطأ شبكة'); res = null; }
  } else if (GEOAPIFY_LAYERS[layer] && await providerUp(req.app, 'geoapify')) {
    try {
      res = await fetch(`https://maps.geoapify.com/v1/tile/${GEOAPIFY_LAYERS[layer].style}/${z}/${x}/${y}.png`
        + `?apiKey=${encodeURIComponent(k.geoapify)}`);
      if (res.ok) source = layer; else providerFailed('geoapify', `رمز ${res.status}`);
    } catch (e) { providerFailed('geoapify', e?.message || 'خطأ شبكة'); res = null; }
  }

  /*
   * تعذّر المزوّد فالمربّع المفتوح أنفع من خطأ: الخريطة تبقى تعمل والنطاق يبقى
   * مقروءاً. وكتالوج الطبقات يعود إلى «المفتوحة» طوال مدّة التعليق، فمن يفتح
   * الشاشة بعدها يرى المصدر الصحيح في الحاشية.
   */
  if (!source) {
    try { res = await osmTile(z, x, y); source = OSM.id; } catch { res = null; }
  }
  if (!res || !res.ok) return new Response(null, { status: 502 });

  const type = res.headers.get('content-type') || 'image/png';
  const body = new Uint8Array(await res.arrayBuffer());
  memPut(memKey, { body, type, source });

  const out = new Response(body, { headers: tileHeaders(type, source) });
  if (cache && raw) {
    const store = cache.put(raw, out.clone()).catch(() => {});
    /* على Workers يجب أن يُعلَن عن العمل بعد الاستجابة وإلا قُطع */
    if (req.app.waitUntil) req.app.waitUntil(store);
  }
  return out;
}));

export default router;
