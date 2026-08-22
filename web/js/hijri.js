/**
 * التقويم المزدوج (البند ١١)
 * التخزين UTC دائماً، والتحويل اللحظي (On-the-fly) إلى هجري أم القرى
 * أو ميلادي في الواجهة الأمامية فقط بحسب تفضيل المستخدم.
 */
const cache = new Map();
function fmtr(key, opts) {
  if (!cache.has(key)) cache.set(key, new Intl.DateTimeFormat(key.split('|')[0], opts));
  return cache.get(key);
}
const TZ = 'Asia/Riyadh';

export const hijriLong = (d) => fmtr('ar-SA-u-ca-islamic-umalqura-nu-arab|long',
  { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(d);
export const hijriShort = (d) => fmtr('ar-SA-u-ca-islamic-umalqura-nu-arab|short',
  { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }).format(d);
export const gregLong = (d) => fmtr('ar-SA-u-ca-gregory-nu-arab|long',
  { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(d);
export const gregShort = (d) => fmtr('ar-SA-u-ca-gregory-nu-arab|short',
  { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }).format(d);

const clean = (s, era) => s.replace(/\s*(هـ|م)\s*$/, '').trim() + ' ' + era;

/** يحوّل أي تاريخ إلى النص المناسب لتفضيل المستخدم */
export function fmtDate(value, calendar = 'hijri', style = 'long') {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  if (calendar === 'gregorian') return clean(style === 'long' ? gregLong(d) : gregShort(d), 'م');
  return clean(style === 'long' ? hijriLong(d) : hijriShort(d), 'هـ');
}

/** يعرض التقويمين معاً (للتقارير والرؤوس الرسمية) */
export const fmtBoth = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return `${clean(hijriShort(d), 'هـ')} · ${clean(gregShort(d), 'م')}`;
};

export const fmtDateTime = (value, calendar = 'hijri') => {
  if (!value) return '—';
  const d = new Date(value);
  const t = d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
  return `${fmtDate(d, calendar, 'short')} — ${t}`;
};

/** اسم اليوم بالعربية */
export const dayName = (value) => new Date(value)
  .toLocaleDateString('ar-SA', { weekday: 'long', timeZone: TZ });

/** التاريخ الحالي بصيغة YYYY-MM-DD بتوقيت الرياض */
export const todayISO = () => {
  const d = new Date(Date.now() + 3 * 3600000);
  return d.toISOString().slice(0, 10);
};
export const addDaysISO = (iso, n) =>
  new Date(new Date(iso).getTime() + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a, b) =>
  Math.round((new Date(b) - new Date(a)) / 86400000);
