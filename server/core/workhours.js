import { j, isMissingSchema } from './sql.js';

/**
 * جداول الدوام — أيام العمل وساعاته، وعليها يُقاس التأخّر ويُبنى مسير الرواتب.
 *
 * كان الدوام قيمتين في `tenants.settings`: بدايةٌ ونهايةٌ للمجمّع كلّه. فالفرع
 * الذي يفتح حلقاته بعد العصر يُحسب منسوبوه متأخّرين كلَّ يوم، والمتعاون الذي
 * دوامه ثلاثة أيام يُحسب غائباً في الأربعة الباقية فيُخصم من راتبه ما لم يجب.
 *
 * فصار الجدول ثلاث طبقات يرث بعضُها بعضاً:
 *
 *     المجمّع  ←  الفرع  ←  الموظف
 *
 * ويُقرأ الأخصُّ فالأعمّ: جدولُ الموظف إن وُضع له، وإلا جدولُ فرعه، وإلا جدولُ
 * المجمّع، وإلا الافتراض المحفوظ في إعدادات الجهة (توافقاً مع ما قبل الجداول).
 *
 * والأيام سبعةٌ بترتيب الأحد ← السبت، موافقةً لـ `Date.getUTCDay()` فلا يحتاج
 * أحدٌ إلى جدول تحويل.
 */

/** ترتيب الأسبوع كما تقرؤه جافاسكربت — الأحد صفراً */
export const WEEK = [
  { i: 0, name: 'الأحد' }, { i: 1, name: 'الاثنين' }, { i: 2, name: 'الثلاثاء' },
  { i: 3, name: 'الأربعاء' }, { i: 4, name: 'الخميس' }, { i: 5, name: 'الجمعة' },
  { i: 6, name: 'السبت' }
];

export const DAY_NAMES = WEEK.map(d => d.name);

const RIYADH_OFFSET_MIN = 180;   // +03:00 — التوقيت الذي تُكتب به تواريخ الحضور

/** "07:30" ← ٤٥٠ دقيقة. وما لا يُقرأ يعود إلى البديل لا إلى صفرٍ صامت */
export function hhmmToMin(value, fallback = 450) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return fallback;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return fallback;
  return hh * 60 + mm;
}

/** ٤٥٠ ← "07:30" — تُعاد دائماً بصيغة ثابتة يقبلها حقل الوقت في المتصفح */
export const minToHHMM = (min) => {
  const v = Math.max(0, Math.min(24 * 60 - 1, Math.round(Number(min) || 0)));
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};

/** يوم الأسبوع لتاريخ YYYY-MM-DD — بلا انزلاقٍ بسبب المنطقة الزمنية */
export const weekdayOf = (dateISO) => new Date(`${String(dateISO).slice(0, 10)}T00:00:00Z`).getUTCDay();

/** التاريخ المحلي للجهة (الرياض) من طابع UTC */
export const localDate = (iso = new Date()) =>
  new Date((iso instanceof Date ? iso : new Date(iso)).getTime() + RIYADH_OFFSET_MIN * 60000)
    .toISOString().slice(0, 10);

/** دقائق اليوم المحلية (٠–١٤٣٩) من طابع UTC */
export function localMinutes(iso = new Date()) {
  const l = new Date((iso instanceof Date ? iso : new Date(iso)).getTime() + RIYADH_OFFSET_MIN * 60000);
  return l.getUTCHours() * 60 + l.getUTCMinutes();
}

/* ═══════════ بناء الجدول والتحقّق منه ═══════════ */

/**
 * الجدول الافتراضي: الأحد ← الخميس من ٧:٣٠ إلى ١:٣٠، والجمعة والسبت راحة.
 * ويُبنى من إعدادات الجهة إن كانت فيها — فالجهات القائمة لا يتغيّر دوامها فجأةً
 * لمجرّد أنّ الجداول أُضيفت.
 */
export function defaultDays(settings = {}) {
  const wd = settings?.workday || {};
  const start = /^\d{1,2}:\d{2}$/.test(wd.start || '') ? wd.start : '07:30';
  const end = /^\d{1,2}:\d{2}$/.test(wd.end || '') ? wd.end : '13:30';
  const on = Array.isArray(wd.days) && wd.days.length ? wd.days.map(Number) : [0, 1, 2, 3, 4];
  return WEEK.map(d => ({ on: on.includes(d.i) ? 1 : 0, start, end }));
}

/**
 * تطهير أيامٍ واردة من الواجهة — سبعةُ أيامٍ دائماً، ونهايةٌ بعد بداية.
 * ودوامٌ يعبر منتصف الليل لا تعرفه حلقات القرآن، فتُصحَّح النهايةُ إلى ما بعد
 * البداية بساعةٍ بدل أن تُقبل مدّةٌ سالبة تُفسد الاحتساب صامتةً.
 */
export function sanitizeDays(input, fallback) {
  const base = fallback || defaultDays();
  const list = Array.isArray(input) ? input : [];
  return WEEK.map(d => {
    const raw = list[d.i] || {};
    const ref = base[d.i] || { on: 0, start: '07:30', end: '13:30' };
    const start = hhmmToMin(raw.start, hhmmToMin(ref.start));
    let end = hhmmToMin(raw.end, hhmmToMin(ref.end));
    if (end <= start) end = Math.min(24 * 60 - 1, start + 60);
    return {
      on: (raw.on === undefined ? ref.on : (raw.on ? 1 : 0)),
      start: minToHHMM(start),
      end: minToHHMM(end)
    };
  });
}

/** دقائق العمل الأسبوعية — تُعرض في اللوحة فيُقرأ أثرُ التعديل قبل الحفظ */
export const weeklyMinutes = (days) => (days || []).reduce(
  (sum, d) => sum + (d.on ? Math.max(0, hhmmToMin(d.end) - hhmmToMin(d.start)) : 0), 0);

/** عدد أيام العمل في الأسبوع */
export const weeklyDays = (days) => (days || []).filter(d => d.on).length;

/** متوسّط دقائق اليوم الواحد — مقسوم الأسبوع على أيام عمله */
export const dailyMinutes = (days) => {
  const n = weeklyDays(days);
  return n ? Math.round(weeklyMinutes(days) / n) : 0;
};

/* ═══════════ القراءة من قاعدة البيانات ═══════════ */

/** صفُّ `work_schedules` كما تقرؤه بقية المنصة — أيامٌ مطهَّرة وسماحٌ مضبوط */
export const scheduleFromRow = (row, settings = {}) => ({
  id: row.id,
  scope: row.scope,
  branch_id: row.branch_id || null,
  user_id: row.user_id || null,
  days: sanitizeDays(j(row.days, null), defaultDays(settings)),
  grace_min: Number.isFinite(Number(row.grace_min)) ? Number(row.grace_min) : 15,
  note: row.note || null,
  updated_at: row.updated_at || null
});

/** الجدول الموروث من إعدادات الجهة — أساسٌ لا يحتاج جدولاً في القاعدة */
const fallbackSchedule = (settings = {}) => ({
  id: null, scope: 'tenant', branch_id: null, user_id: null,
  days: defaultDays(settings),
  grace_min: Number(settings?.late_after_minutes ?? 15),
  note: null, updated_at: null, source: 'default'
});

/**
 * قراءةٌ من `work_schedules` تتنحّى إن لم يُطبَّق المخطط بعد.
 *
 * بين نشرِ الشيفرة وتطبيقِ المخطط نافذةٌ لا يوجد فيها الجدول (انظر
 * `isMissingSchema`). ولو سقط التحضيرُ فيها لتعطّل أكثرُ ما تُستعمل شاشةٍ في
 * المنصة على كل منسوب — فيرجع الدوامُ إلى ما كان عليه قبل الجداول: إعدادُ
 * الجهة. ولا شيء يُكتب في هذه النافذة، والقراءةُ وحدها هي التي تتسامح.
 */
const readOrNull = async (fn) => {
  try { return await fn(); }
  catch (e) { if (isMissingSchema(e)) return null; throw e; }
};

/**
 * جدولُ المجمّع نفسه — صفُّ `tenant` إن وُجد، وإلا افتراضُ إعدادات الجهة.
 * `source` تقول من أين جاء، فتعرف الشاشةُ أهو موضوعٌ أم موروث.
 */
export async function tenantSchedule(app, tenantId, settings = {}) {
  const row = await readOrNull(() => app.db.get(
    `SELECT * FROM work_schedules WHERE tenant_id=? AND scope='tenant'`, tenantId));
  if (row) return { ...scheduleFromRow(row, settings), source: 'tenant' };
  return fallbackSchedule(settings);
}

/**
 * الجدول النافذ على موظفٍ بعينه.
 *
 * `branchId` هو الفرع الذي يُنسب إليه دوامُه — فرعُ ملفّه في العادة. ومن لا
 * ملفَّ له يُقاس بفرعه الرئيس، ومن لا فرع له يقع على جدول المجمّع.
 */
export async function effectiveSchedule(app, tenantId, { userId = null, branchId = null, settings = {} } = {}) {
  if (userId) {
    const own = await readOrNull(() => app.db.get(
      `SELECT * FROM work_schedules WHERE tenant_id=? AND scope='user' AND user_id=?`, tenantId, userId));
    if (own) return { ...scheduleFromRow(own, settings), source: 'user' };
  }
  if (branchId) {
    const br = await readOrNull(() => app.db.get(
      `SELECT * FROM work_schedules WHERE tenant_id=? AND scope='branch' AND branch_id=?`, tenantId, branchId));
    if (br) return { ...scheduleFromRow(br, settings), source: 'branch' };
  }
  return tenantSchedule(app, tenantId, settings);
}

/**
 * جداول جماعة من الموظفين دفعةً واحدة — مسير الرواتب يمرّ على مئةِ موظفٍ،
 * وثلاثةُ استعلاماتٍ لكلٍّ منهم تُثقل التوليد بلا فائدة.
 *
 * @param {Array<{user_id:number, branch_id:number|null}>} people
 * @returns {Promise<Map<number, object>>} معرّف المستخدم ← جدوله النافذ
 */
export async function schedulesFor(app, tenantId, people = [], settings = {}) {
  const base = await tenantSchedule(app, tenantId, settings);
  const rows = await readOrNull(() => app.db.all(
    `SELECT * FROM work_schedules WHERE tenant_id=? AND scope IN ('branch','user')`, tenantId)) || [];
  const byUser = new Map(), byBranch = new Map();
  for (const r of rows) {
    if (r.scope === 'user' && r.user_id) byUser.set(r.user_id, scheduleFromRow(r, settings));
    if (r.scope === 'branch' && r.branch_id) byBranch.set(r.branch_id, scheduleFromRow(r, settings));
  }
  const out = new Map();
  for (const p of people) {
    const own = byUser.get(p.user_id);
    if (own) { out.set(p.user_id, { ...own, source: 'user' }); continue; }
    const br = p.branch_id ? byBranch.get(p.branch_id) : null;
    out.set(p.user_id, br ? { ...br, source: 'branch' } : base);
  }
  return out;
}

/* ═══════════ الاحتساب ═══════════ */

/** خطّة يومٍ بعينه من الجدول: أهو يوم عمل، ومتى يبدأ وينتهي، وكم مدّته */
export function dayPlan(schedule, dateISO) {
  const d = (schedule?.days || defaultDays())[weekdayOf(dateISO)] || { on: 0, start: '07:30', end: '13:30' };
  const start = hhmmToMin(d.start);
  const end = hhmmToMin(d.end);
  return {
    working: !!d.on, start: minToHHMM(start), end: minToHHMM(end),
    start_min: start, end_min: end,
    minutes: d.on ? Math.max(0, end - start) : 0,
    weekday: weekdayOf(dateISO), day_name: DAY_NAMES[weekdayOf(dateISO)]
  };
}

/**
 * كم تأخّر من حضر في الدقيقة `atMin` من يوم `dateISO`؟
 *
 * يُعاد صفرٌ لمن حضر داخل السماح أو قبله، ولمن حضر في يوم راحةٍ — فالحاضر
 * تطوّعاً في إجازته لا يُعاقَب على ساعة قدومه.
 */
export function lateMinutes(schedule, dateISO, atMin) {
  const plan = dayPlan(schedule, dateISO);
  if (!plan.working) return 0;
  const grace = Math.max(0, Number(schedule?.grace_min ?? 15));
  return Math.max(0, Math.round(atMin) - plan.start_min - grace);
}

/** أيام العمل بين تاريخين (شاملين) بحسب الجدول */
export function workingDaysBetween(schedule, fromISO, toISO) {
  const out = [];
  const start = new Date(`${String(fromISO).slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${String(toISO).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return out;
  const days = schedule?.days || defaultDays();
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    if (days[new Date(t).getUTCDay()]?.on) out.push(iso);
  }
  return out;
}

/** عدد أيام العمل في مدى — أساسُ احتساب الغياب في مسير الرواتب */
export const countWorkingDays = (schedule, fromISO, toISO) =>
  workingDaysBetween(schedule, fromISO, toISO).length;

/** وصفٌ عربيٌّ مختصر للجدول — يُطبع في الشاشة والتقرير */
export function describeSchedule(schedule) {
  const days = schedule?.days || defaultDays();
  const on = WEEK.filter(d => days[d.i]?.on);
  if (!on.length) return 'بلا أيام عمل';
  const uniq = [...new Set(on.map(d => `${days[d.i].start}-${days[d.i].end}`))];
  const names = on.map(d => d.name).join('، ');
  return uniq.length === 1
    ? `${names} · ${days[on[0].i].start} — ${days[on[0].i].end}`
    : `${names} · بأوقاتٍ مختلفة`;
}

export default {
  WEEK, DAY_NAMES, defaultDays, sanitizeDays, scheduleFromRow, weeklyMinutes, weeklyDays, dailyMinutes,
  tenantSchedule, effectiveSchedule, schedulesFor, dayPlan, lateMinutes,
  workingDaysBetween, countWorkingDays, describeSchedule, hhmmToMin, minToHHMM,
  weekdayOf, localDate, localMinutes
};
