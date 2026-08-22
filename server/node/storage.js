import fs from 'node:fs';
import path from 'node:path';
import { isSafeKey } from '../core/storage.js';

/** محوّل التخزين على القرص المحلي (تشغيل ذاتي) */
export function createNodeStorage(root) {
  const full = (key) => path.join(root, key);
  const inside = (p) => path.resolve(p).startsWith(path.resolve(root) + path.sep);

  return {
    driver: 'local',
    async put(key, data) {
      if (!isSafeKey(key)) throw new Error('مسار تخزين غير صالح');
      const f = full(key);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, Buffer.from(data));
      return { key, size: data.length };
    },
    async get(key) {
      if (!isSafeKey(key)) return null;
      const f = full(key);
      if (!inside(f) || !fs.existsSync(f)) return null;
      return new Uint8Array(fs.readFileSync(f));
    },
    async remove(key) {
      if (!isSafeKey(key)) return false;
      const f = full(key);
      if (inside(f) && fs.existsSync(f)) fs.unlinkSync(f);
      return true;
    },
    /** يسرد المفاتيح تحت بادئة معيّنة (يُستخدم في تنظيف النسخ الاحتياطية) */
    async list(prefix = '') {
      const base = path.join(root, prefix);
      if (!fs.existsSync(base)) return [];
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : [path.relative(root, p).split(path.sep).join('/')];
      });
      return walk(base).sort();
    },
    async purgeTenant(tenantId) {
      const dir = path.join(root, 'tenants', String(tenantId));
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      return true;
    }
  };
}
