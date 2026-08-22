import config from '../config.js';
import { tooMany } from '../lib/errors.js';

/**
 * الحماية والحد من الطلبات (البند ٩) — نافذة منزلقة في الذاكرة.
 * في بيئة متعددة الخوادم يُستبدل المخزن بـ Redis دون تغيير الواجهة.
 */
const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now - v.start > v.windowMs * 2) buckets.delete(k);
}, 60_000).unref?.();

export function rateLimit({ windowMs = config.rateLimit.windowMs, max = config.rateLimit.max, key } = {}) {
  return (req, res, next) => {
    const id = key ? key(req) : `${req.ip}:${req.baseUrl}`;
    const limit = typeof max === 'function' ? (max(req) || config.rateLimit.max) : max;
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || now - b.start > windowMs) b = { start: now, count: 0, windowMs };
    b.count += 1;
    buckets.set(id, b);
    const remaining = Math.max(0, limit - b.count);
    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil((b.start + windowMs) / 1000)));
    if (b.count > limit) {
      res.set('Retry-After', String(Math.ceil((b.start + windowMs - now) / 1000)));
      return next(tooMany());
    }
    next();
  };
}
