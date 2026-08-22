import { buildConfig } from '../core/config.js';
import { createD1 } from './db.js';
import { createR2Storage } from './storage.js';
import { createWorkerRealtime } from './realtime.js';

/**
 * يبني حاوية التطبيق لبيئة Cloudflare Workers.
 * البيئة تُمرَّر مع كل طلب (لا توجد متغيرات عامة على Workers) لذا تُبنى الحاوية لكل طلب،
 * وهي عملية رخيصة لأنها مجرد أغلفة حول الروابط (bindings).
 */
export function createWorkerContainer(env, ctx) {
  const waitUntil = ctx?.waitUntil ? ctx.waitUntil.bind(ctx) : null;
  const cfg = buildConfig(env);

  if (!env.DB) throw new Error('الربط DB (Cloudflare D1) غير معرّف في wrangler.toml');

  return {
    runtime: 'workers',
    cfg,
    env,
    db: createD1(env.DB),
    storage: env.FILES ? createR2Storage(env.FILES) : null,
    realtime: createWorkerRealtime(env, waitUntil),
    queueBinding: env.JOBS || null,
    assets: env.ASSETS || null,
    waitUntil
  };
}
