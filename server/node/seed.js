import { createNodeContainer } from './container.js';
import { migrate } from './migrate.js';
import { seed } from '../core/seed.js';

const app = createNodeContainer();
await migrate(app);
const id = await seed(app);
if (id) {
  console.log('✔ تمت تعبئة البيانات التجريبية للمستأجر رقم', id);
  console.log('  مدير المجمّع : admin@riyadh-qu.sa / Admin@123');
  console.log('  المحاسب      : finance@riyadh-qu.sa / Finance@123');
  console.log('  المعلم       : teacher@riyadh-qu.sa / Teach@123');
} else {
  console.log('ℹ البيانات التجريبية موجودة مسبقاً — تم تخطي التعبئة.');
}
await app.db.close();
