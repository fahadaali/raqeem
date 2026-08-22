import path from 'node:path';
import { loadEnv, ROOT } from './env.js';
import { buildConfig } from '../core/config.js';
import { createNodeDB } from './db.js';
import { createNodeStorage } from './storage.js';
import { createNodeRealtime } from './realtime.js';
import { drain } from '../core/queue.js';

/** يبني حاوية التطبيق لبيئة التشغيل الذاتي (Node) */
export function createNodeContainer({ dbFile } = {}) {
  const env = loadEnv();
  const cfg = buildConfig(env);
  const db = createNodeDB(path.resolve(ROOT, dbFile || cfg.dbFile));
  const storage = createNodeStorage(path.resolve(ROOT, cfg.storageRoot));
  const realtime = createNodeRealtime();

  const app = { runtime: 'node', cfg, db, storage, realtime, root: ROOT };
  let pending = null;
  app.scheduleDrain = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; drain(app).catch(e => console.error('[queue]', e.message)); }, 50);
    pending.unref?.();
  };
  return app;
}
