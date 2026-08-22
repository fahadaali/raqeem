/**
 * التخزين المعزول بمعرّف الجهة (المقدمة الاستراتيجية §٣)
 * كل ملف يُحفظ تحت المسار: tenants/{tenant_id}/{context}/{date}/{random}{ext}
 * الواجهة واحدة، والمحوّل يختلف: القرص المحلي في التشغيل الذاتي، وR2 على Cloudflare.
 */
import { b64uEncode, randomBytes } from './crypto.js';

export function buildKey(tenantId, context, originalName) {
  const dot = String(originalName || '').lastIndexOf('.');
  const ext = dot > 0 ? String(originalName).slice(dot).toLowerCase().slice(0, 10).replace(/[^.a-z0-9]/g, '') : '';
  const stamp = new Date().toISOString().slice(0, 10);
  const rand = b64uEncode(randomBytes(9)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const safeCtx = String(context || 'general').replace(/[^a-z0-9_-]/gi, '') || 'general';
  return `tenants/${tenantId}/${safeCtx}/${stamp}/${rand}${ext}`;
}

/** يمنع الخروج من مجلد الجهة عبر مسارات ملتوية */
export function isSafeKey(key) {
  const k = String(key || '');
  return /^tenants\/\d+\//.test(k) && !k.includes('..') && !k.includes('\\') && !k.startsWith('/');
}
