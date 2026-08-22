import schema from '../core/schema.sql';

/**
 * تطبيق مخطط قاعدة البيانات على D1 من المصدر نفسه المستخدَم في Node
 * (يُحمَّل الملف كنص عبر قاعدة الحزم في wrangler.toml) — فلا يحدث انحراف بين البيئتين.
 */
export async function migrate(app) {
  await app.db.exec(schema);
  await app.db.run(`INSERT INTO schema_meta(key,value) VALUES('version','1')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  return true;
}

/** هل المخطط مطبَّق أصلاً؟ */
export async function isMigrated(app) {
  try {
    await app.db.get('SELECT 1 FROM tenants LIMIT 1');
    return true;
  } catch { return false; }
}

export { schema };
