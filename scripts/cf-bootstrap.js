/**
 * تهيئة قاعدة بيانات D1 بعد النشر — يُطبّق المخطط ثم يعبّئ بيانات المستأجر رقم ١.
 *
 *   npm run cf:bootstrap -- https://noor-erp.example.workers.dev
 *   npm run cf:bootstrap -- http://localhost:8787            (مع wrangler dev)
 *
 * الرمز يُقرأ من متغيّر البيئة BOOTSTRAP_TOKEN أو من ملف .dev.vars محلياً،
 * ويجب أن يطابق السرّ المضبوط بـ:  npx wrangler secret put BOOTSTRAP_TOKEN
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(a => a !== '--');
const url = (args.find(a => a.startsWith('http')) || process.env.APP_URL || 'http://localhost:8787').replace(/\/+$/, '');
const force = args.includes('--force');
const schemaOnly = args.includes('--schema-only');

function readToken() {
  if (process.env.BOOTSTRAP_TOKEN) return process.env.BOOTSTRAP_TOKEN;
  const f = path.join(ROOT, '.dev.vars');
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f, 'utf8').match(/^\s*BOOTSTRAP_TOKEN\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

const token = readToken();
if (!token) {
  console.error('✘ لم يُعثر على BOOTSTRAP_TOKEN — اضبطه في البيئة أو في ملف .dev.vars');
  process.exit(1);
}

const target = new URL(url + '/__bootstrap');
if (force) target.searchParams.set('force', '1');
if (schemaOnly) target.searchParams.set('schema-only', '1');

console.log(`▸ تهيئة  ${target.origin}  ...`);
const res = await fetch(target, { method: 'POST', headers: { 'x-bootstrap-token': token } });
const data = await res.json().catch(() => ({}));

if (!res.ok) {
  console.error(`✘ فشلت التهيئة (${res.status}):`, data.error || JSON.stringify(data));
  process.exit(1);
}

console.log('✔ تمت التهيئة بنجاح');
console.log(`  قاعدة البيانات : ${data.database}`);
console.log(`  التخزين        : ${data.storage}`);
console.log(`  البثّ اللحظي   : ${data.realtime}`);
console.log(`  البيانات       : ${typeof data.seeded === 'object' ? 'مستأجر رقم ' + data.seeded.tenant_id : data.seeded}`);
if (typeof data.seeded === 'object') {
  console.log('\n  حسابات الدخول الأولية (غيّر كلمات المرور فوراً):');
  console.log('    مدير المجمّع : admin@riyadh-qu.sa / Admin@123');
  console.log('    المحاسب      : finance@riyadh-qu.sa / Finance@123');
  console.log('    المعلم       : teacher@riyadh-qu.sa / Teach@123');
}
