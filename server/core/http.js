/**
 * طبقة HTTP محمولة فوق Hono — تُوحّد شكل الطلب والاستجابة
 * حتى تبقى شيفرة المسارات واحدة على Node و Cloudflare Workers.
 */
import { AppError } from './errors.js';

/** يبني كائن طلب موحّد الشكل من سياق Hono */
export async function buildRequest(c) {
  const raw = c.req.raw;
  const method = c.req.method;
  let body = {};
  if (!['GET', 'HEAD', 'DELETE'].includes(method)) {
    const type = c.req.header('content-type') || '';
    if (type.includes('application/json')) {
      try { body = await c.req.json(); } catch { body = {}; }
    } else if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
      try { body = await c.req.parseBody({ all: true }); } catch { body = {}; }
    }
  }
  return {
    method,
    path: new URL(raw.url).pathname,
    body: body || {},
    query: c.req.query(),
    params: {},
    headers: raw.headers,
    get: (name) => c.req.header(String(name).toLowerCase()) || undefined,
    ip: c.get('ip') || '',
    app: c.get('app'),
    ctx: c.get('ctx') || null,
    hono: c
  };
}

export const created = (data) => ({ __status: 201, data });
export const accepted = (data) => ({ __status: 202, data });
export const status = (code, data) => ({ __status: code, data });

/**
 * يغلّف معالج مسار: يستقبل (req, c) ويعيد بيانات أو Response.
 * تُقرأ معاملات المسار هنا تحديداً لأن Hono لا يحلّها إلا بعد مطابقة المسار،
 * أي بعد انتهاء الوسائط العامة.
 */
export function h(fn) {
  return async (c) => {
    const req = c.get('request') || await buildRequest(c);
    req.params = c.req.param() || {};
    c.set('request', req);
    const out = await fn(req, c);
    if (out instanceof Response) return out;
    if (out === undefined || out === null) return c.body(null, 204);
    if (out && typeof out === 'object' && '__status' in out) return c.json(out.data, out.__status);
    return c.json(out);
  };
}

/** وسيط يحضّر كائن الطلب قبل المعالجات */
export const withRequest = async (c, next) => {
  c.set('request', await buildRequest(c));
  await next();
};

/** معالج الأخطاء الموحّد */
export function errorHandler(err, c) {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  const msg = String(err?.message || '');
  if (msg.includes('TERM_CLOSED')) {
    return c.json({ error: { code: 'TERM_CLOSED', message: 'هذا الفصل مؤرشف ومغلق للقراءة فقط — لا يمكن التعديل عليه' } }, 423);
  }
  if (msg.includes('AUDIT_APPEND_ONLY')) {
    return c.json({ error: { code: 'AUDIT_APPEND_ONLY', message: 'سجلات التدقيق غير قابلة للتعديل أو الحذف' } }, 423);
  }
  if (msg.includes('UNIQUE constraint failed') || msg.includes('D1_ERROR: UNIQUE')) {
    return c.json({ error: { code: 'CONFLICT', message: 'القيمة مستخدمة مسبقاً' } }, 409);
  }
  const dev = c.get('app')?.cfg?.env !== 'production';
  console.error('[error]', err?.stack || err);
  return c.json({ error: { code: 'SERVER_ERROR', message: dev ? msg : 'حدث خطأ غير متوقع في الخادم' } }, 500);
}

export const notFoundHandler = (c) =>
  c.json({ error: { code: 'NOT_FOUND', message: 'المسار غير موجود' } }, 404);

/**
 * رؤوس الأمان — مصدر واحد تُشتقّ منه:
 *   • الوسيط أدناه (Node وWorkers)
 *   • ملف web/_headers الذي تقرأه شبكة Cloudflare للملفات الثابتة
 */
export function securityHeaderMap({ env = 'production' } = {}) {
  const map = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      /* مربّعات الخريطة من OpenStreetMap: صورٌ فقط، ولا `connect-src` لها —
         فلا يُرسَل إليها شيء. والخريطة تتمركز على الفرع دائماً، فالطلب يكشف
         موضع الفرع لا موضع المُحضِّر، وموقعُه يُرسَم فوقها من جهازه. */
      "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'self'", "base-uri 'self'", "form-action 'self'"
    ].join('; ')
  };
  if (env === 'production') map['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return map;
}

export function securityHeaders(cfg) {
  const map = securityHeaderMap(cfg || {});
  return async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(map)) c.res.headers.set(k, v);
  };
}
