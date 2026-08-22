/**
 * التقويم المزدوج (البند ١١)
 * التخزين دائماً UTC، والتحويل إلى هجري (أم القرى) يتم عبر ICU المدمج في Node.
 * تُستخدم هنا فقط لتوليد التقارير المطبوعة على الخادم؛ الواجهة تحوّل لحظياً.
 */
const HIJRI = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-arab', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Riyadh'
});
const HIJRI_NUM = new Intl.DateTimeFormat('en-US-u-ca-islamic-umalqura', {
  day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Riyadh'
});
const GREG = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-arab', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Riyadh'
});

export function toHijri(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return HIJRI.format(d).replace(/\s*هـ\s*$/, '') + ' هـ';
}
export function toHijriNumeric(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const parts = Object.fromEntries(HIJRI_NUM.formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function toGregorian(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return GREG.format(d).replace(/\s*م\s*$/, '') + ' م';
}
export function fmt(value, calendar = 'hijri') {
  return calendar === 'gregorian' ? toGregorian(value) : toHijri(value);
}
