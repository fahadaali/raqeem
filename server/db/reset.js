import fs from 'node:fs';
import config from '../config.js';

/**
 * يحذف قاعدة البيانات ويعيد بناءها بالبيانات التجريبية — للتطوير فقط.
 * الحذف يتم قبل فتح أي اتصال بالقاعدة (استيراد ديناميكي بعد الحذف).
 */
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const f = config.dbFile + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
console.log('✔ تم حذف قاعدة البيانات السابقة.');

const { seed } = await import('./seed.js');
const id = seed();
console.log('✔ أُعيد بناء قاعدة البيانات وتعبئتها للمستأجر رقم', id);
