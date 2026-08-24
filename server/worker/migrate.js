import schema from '../core/schema.sql';
import { reconcileColumns, upgradeSchema } from '../core/upgrade.js';

/**
 * تطبيق مخطط قاعدة البيانات على D1 من المصدر نفسه المستخدَم في Node
 * (يُحمَّل الملف كنص عبر قاعدة الحزم في wrangler.toml) — فلا يحدث انحراف بين البيئتين.
 */
export async function migrate(app) {
  /*
   * الأعمدة المستجدّة تُضاف **قبل** تنفيذ المخطط لا بعده.
   *
   * في المخطط فهارس تذكر أعمدةً مستجدّة (مثل `ix_fin_settle` على
   * `finance_requests.settle_status`)، و`CREATE TABLE IF NOT EXISTS` لا يمسّ
   * جدولاً قائماً — فقاعدةٌ أُنشئت قبل التوسعة تصل إلى جملة الفهرس وعمودُها
   * ناقصٌ فتسقط الترحيلة كلُّها. و`reconcileColumns` تتخطّى الجداول المعدومة
   * بلا خطأ، فالنداءُ قبل المخطط آمنٌ على قاعدةٍ فارغة كما على قاعدةٍ عامرة.
   */
  await reconcileColumns(app);
  await app.db.exec(schema);
  const added = await upgradeSchema(app);
  await app.db.run(`INSERT INTO schema_meta(key,value) VALUES('version','2')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  return { ok: true, added };
}

/** هل المخطط مطبَّق أصلاً؟ */
export async function isMigrated(app) {
  try {
    await app.db.get('SELECT 1 FROM tenants LIMIT 1');
    return true;
  } catch { return false; }
}

export { schema };
