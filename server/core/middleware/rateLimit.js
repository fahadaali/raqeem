import { tooMany } from '../errors.js';

/**
 * الحماية والحد من الطلبات (البند ٩)
 * مخزن في الذاكرة لكل عقدة/عزلة تشغيل.
 */
const buckets = new Map();
const failures = new Map();

function sweep() {
  const now = Date.now();
  for (const [k, v] of buckets) if (now - v.start > v.windowMs * 3) buckets.delete(k);
  for (const [k, v] of failures) if (now - v.start > 30 * 60_000) failures.delete(k);
}
let lastSweep = 0;

export function hit(id, windowMs, max) {
  const now = Date.now();
  if (now - lastSweep > 60_000) { lastSweep = now; sweep(); }
  let b = buckets.get(id);
  if (!b || now - b.start > windowMs) b = { start: now, count: 0, windowMs };
  b.count += 1;
  buckets.set(id, b);
  return {
    allowed: b.count <= max,
    remaining: Math.max(0, max - b.count),
    reset: Math.ceil((b.start + windowMs) / 1000),
    retryAfter: Math.ceil((b.start + windowMs - now) / 1000)
  };
}

/** عدّاد المحاولات الفاشلة — يقيّد تخمين كلمات المرور بحسب الحساب
 *  لا بحسب عنوان الشبكة، حتى لا تُحجب جهة كاملة تشترك في عنوان واحد. */
export function recordFailure(id, windowMs = 15 * 60_000) {
  const now = Date.now();
  const b = failures.get(id);
  if (!b || now - b.start > windowMs) failures.set(id, { start: now, count: 1 });
  else b.count += 1;
}
export const clearFailures = (id) => failures.delete(id);
export function failureCount(id, windowMs = 15 * 60_000) {
  const b = failures.get(id);
  if (!b) return 0;
  if (Date.now() - b.start > windowMs) { failures.delete(id); return 0; }
  return b.count;
}

export function rateLimit({ windowMs, max, key } = {}) {
  return async (c, next) => {
    const cfg = c.get('app').cfg;
    const w = windowMs ?? cfg.rateLimit.windowMs;
    const req = c.get('request');
    const limit = typeof max === 'function' ? (max(req, c) || cfg.rateLimit.max) : (max ?? cfg.rateLimit.max);
    const id = key ? key(req, c) : `${c.get('ip')}:${new URL(c.req.raw.url).pathname}`;

    const r = hit(id, w, limit);
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(r.remaining));
    c.header('X-RateLimit-Reset', String(r.reset));
    if (!r.allowed) {
      c.header('Retry-After', String(Math.max(1, r.retryAfter)));
      throw tooMany();
    }
    await next();
  };
}
