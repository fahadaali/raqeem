import { isSafeKey } from '../core/storage.js';

/** محوّل التخزين على Cloudflare R2 */
export function createR2Storage(bucket) {
  return {
    driver: 'r2',
    async put(key, data, meta = {}) {
      if (!isSafeKey(key)) throw new Error('مسار تخزين غير صالح');
      await bucket.put(key, data, {
        httpMetadata: meta.contentType ? { contentType: meta.contentType } : undefined,
        customMetadata: meta.custom
      });
      return { key, size: data.length };
    },
    async get(key) {
      if (!isSafeKey(key)) return null;
      const obj = await bucket.get(key);
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
    /** بثّ الملف مباشرة دون تحميله في الذاكرة (أفضل للملفات الكبيرة) */
    async getStream(key) {
      if (!isSafeKey(key)) return null;
      const obj = await bucket.get(key);
      if (!obj) return null;
      return { body: obj.body, size: obj.size, contentType: obj.httpMetadata?.contentType };
    },
    async remove(key) {
      if (!isSafeKey(key)) return false;
      await bucket.delete(key);
      return true;
    },
    /** يسرد المفاتيح تحت بادئة معيّنة (يُستخدم في تنظيف النسخ الاحتياطية) */
    async list(prefix = '') {
      const keys = [];
      let cursor;
      do {
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        for (const o of page.objects) keys.push(o.key);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return keys.sort();
    },
    async purgeTenant(tenantId) {
      const prefix = `tenants/${tenantId}/`;
      let cursor;
      do {
        const list = await bucket.list({ prefix, cursor, limit: 1000 });
        if (list.objects.length) await bucket.delete(list.objects.map(o => o.key));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
      return true;
    }
  };
}
