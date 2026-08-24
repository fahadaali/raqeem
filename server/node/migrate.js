import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileColumns, upgradeSchema } from '../core/upgrade.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(__dirname, '../core/schema.sql');

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
  await app.db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  const added = await upgradeSchema(app);
  if (added.length) console.log('▸ أُضيفت أعمدة مستجدّة:', added.join('، '));
  await app.db.run(`INSERT INTO schema_meta(key,value) VALUES('version','2')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  return true;
}
