/**
 * واجهة وصول موحّدة لقاعدة البيانات — غير متزامنة، تعمل فوق محرّكين:
 *   • better-sqlite3  (تشغيل ذاتي / تطوير محلي)
 *   • Cloudflare D1   (تشغيل على Workers)
 * كل استدعاء يمر عبر هذه الواجهة، فتبقى شيفرة التطبيق واحدة للبيئتين
 * (مبدأ «مركزية التحديثات» في وثيقة المتطلبات).
 *
 * العقد المطلوب من أي محوّل (adapter):
 *   get(sql, ...params)   → صف واحد أو null
 *   all(sql, ...params)   → مصفوفة صفوف
 *   run(sql, ...params)   → { lastId, changes }
 *   batch(statements)     → تنفيذ ذرّي؛ statements = [[sql, params], ...]
 *   exec(script)          → تنفيذ سكربت SQL متعدد الجمل (الترحيلات فقط)
 */

/** الطابع الزمني الموحّد UTC (البند ١١) */
export const nowUTC = () => new Date().toISOString();

/**
 * خطأُ مخطَّطٍ لم يُطبَّق بعد — جدولٌ أو عمودٌ مستجدٌّ لم يصل قاعدةَ التشغيل.
 *
 * نشرُ الشيفرة وتطبيقُ المخطط خطوتان منفصلتان عن قصد (انظر تعليق
 * `.github/workflows/deploy.yml`): تغييرُ مخطَّطِ قاعدةٍ فيها بيانات قرارٌ
 * يُتَّخذ بعينين مفتوحتين لا أثراً جانبياً لدفعةِ شيفرة. وبين الخطوتين نافذةٌ
 * تعمل فيها الشيفرةُ الجديدة على مخطَّطٍ قديم — فما بُني على عمودٍ مستجدّ
 * يتنحّى فيها إلى سلوكه السابق بدل أن يردّ المستخدمَ بخطأٍ لا حيلة له فيه.
 */
export const isMissingSchema = (e) =>
  /no such table|no such column|has no column/i.test(String(e?.message || ''));

/** قراءة حقل JSON بأمان */
export function j(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
export const s = (obj) => JSON.stringify(obj ?? null);

/** يحوّل القيم غير المدعومة في D1 (undefined/boolean) إلى قيم صالحة */
export function normalizeParams(params) {
  return params.map(p => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}

/** يقسّم سكربت SQL إلى جمل مع مراعاة كتل BEGIN...END في المُشغّلات */
export function splitStatements(script) {
  const out = [];
  let buf = '';
  let inBlock = false;
  for (const raw of script.split('\n')) {
    const line = raw.replace(/--.*$/, '');
    if (!line.trim() && !buf.trim()) continue;
    buf += line + '\n';
    const upper = line.toUpperCase();
    if (/\bBEGIN\b/.test(upper) && /CREATE\s+TRIGGER/i.test(buf)) inBlock = true;
    if (inBlock) {
      if (/\bEND\s*;/.test(upper)) { out.push(buf.trim()); buf = ''; inBlock = false; }
      continue;
    }
    if (line.trim().endsWith(';')) { out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(x => x.replace(/;/g, '').trim().length > 0);
}
