/**
 * قوالب الفصول الدراسية — تعريف عام في المنصة يُنسخ إلى كل مجمّع.
 *
 * كان الفصل الافتراضي مكتوباً في `provision.js`: فصل واحد اسمه «الفصل الحالي»
 * مدّته ١٥٠ يوماً، لا يُضبط من أي واجهة. القوالب تنقل التعريف إلى قاعدة البيانات.
 *
 * والتواريخ **نسبية** (شهر/يوم البداية + المدّة) لا مطلقة، فيصلح القالب لكل سنة
 * دون تحرير — وهو الفرق بين قالبٍ يُكتب مرّة وقائمةِ تواريخ تُراجَع كل عام.
 */

const DAY = 86_400_000;
const iso = (d) => d.toISOString().slice(0, 10);
const at = (s) => new Date(`${s}T00:00:00Z`);

/** الفصول النشطة مرتّبة — والمصفوفة الفارغة إشارة «لا قوالب» لا خطأ */
export async function activeTemplates(app) {
  try {
    return await app.db.all(
      'SELECT * FROM term_templates WHERE is_active=1 ORDER BY sort_order, start_month, start_day, id');
  } catch { return []; }
}

/** وقوع القالب في سنة بعينها — واليوم غير الموجود في الشهر يُردّ لآخر يوم فيه */
function occurrence(tpl, year) {
  const start = new Date(Date.UTC(year, tpl.start_month - 1, tpl.start_day));
  if (start.getUTCMonth() !== tpl.start_month - 1) start.setUTCDate(0);
  return { start, end: new Date(start.getTime() + (tpl.duration_days - 1) * DAY) };
}

const shape = (tpl, c, ref) => ({
  code: tpl.code, name: tpl.name,
  start_date: iso(c.start), end_date: iso(c.end),
  is_current: ref >= c.start && ref <= c.end
});

/**
 * يحوّل قالباً إلى فصل بتواريخ فعلية حول تاريخ مرجعي.
 *
 * `prefer: 'nearest'` — أقرب وقوع (ولو كان ماضياً): يصلح لمعرفة الفصل الذي يقع
 * فيه اليوم. و`prefer: 'upcoming'` — الوقوع الجاري أو القادم لا الماضي: هذا ما
 * يريده من يفرض قالباً على مجمّعات قائمة، فهو يجدول للأمام لا يملأ الماضي.
 */
export function expandTemplate(tpl, refISO, { prefer = 'nearest' } = {}) {
  const ref = at(refISO);
  const y = ref.getUTCFullYear();
  const years = [y - 1, y, y + 1, y + 2];

  for (const year of years) {
    const c = occurrence(tpl, year);
    if (ref >= c.start && ref <= c.end) return shape(tpl, c, ref);
  }
  if (prefer === 'upcoming') {
    for (const year of years) {
      const c = occurrence(tpl, year);
      if (c.start > ref) return shape(tpl, c, ref);
    }
  }
  let best = null;
  for (const year of years) {
    const c = occurrence(tpl, year);
    if (!best || Math.abs(c.start - ref) < Math.abs(best.start - ref)) best = c;
  }
  return shape(tpl, best, ref);
}

/**
 * فصول مجمّع جديد من القوالب النشطة — **سنة دراسية واحدة متّسقة**.
 *
 * لا يُوسَّع كل قالب على حدة: القالب الذي يبدأ في مايو وقُرئ في أغسطس ينتهي به
 * أقربُ وقوعٍ إلى مايو الماضي، فيخرج مجمّعٌ فصولُه غير مرتّبة وفيها فصل منتهٍ.
 * فيُثبَّت **الفصل الذي يقع فيه اليوم** محوراً، ثم تُبنى السلسلة حوله: ما بعده
 * يلاحق ما قبله، وما قبله يسبق ما بعده — فتخرج سلسلة صاعدة هي السنة الدراسية
 * الجارية كما يفهمها من ينشئ المجمّع، لا سنةً تبدأ بعد شهور ويُتخطّى فيها فصل قائم.
 *
 * وإن لم توجد قوالب رجع السلوك المكتوب في الشيفرة — فلا يتعطّل الإنشاء بجدول فارغ.
 */
export async function termsForNewTenant(app, refISO = new Date().toISOString().slice(0, 10)) {
  const tpls = await activeTemplates(app);
  const ref = at(refISO);

  if (!tpls.length) {
    return [{
      code: 'T-1', name: 'الفصل الحالي', start_date: refISO,
      end_date: iso(new Date(ref.getTime() + 150 * DAY)), is_current: true
    }];
  }

  const y = ref.getUTCFullYear();
  const YEARS = [y - 2, y - 1, y, y + 1, y + 2];

  /*
   * المحور: الفصل الذي يقع فيه اليوم. من أنشأ مجمّعه في يونيو يجب أن يقع في
   * فصل السنة الجارية، لا أن تبدأ سنته من أغسطس القادم فيُتخطّى فصلٌ قائم.
   * وإن لم يقع اليوم في فصل فالمحور أقربُ فصلٍ قادم — والبداية دائماً أمامه.
   */
  let pivot = -1, chosen = null;
  for (let i = 0; i < tpls.length && pivot < 0; i++) {
    for (const year of YEARS) {
      const c = occurrence(tpls[i], year);
      if (ref >= c.start && ref <= c.end) { pivot = i; chosen = c; break; }
    }
  }
  if (pivot < 0) {
    let best = null;
    tpls.forEach((tpl, i) => {
      for (const year of YEARS) {
        const c = occurrence(tpl, year);
        if (c.start > ref && (!best || c.start < best.c.start)) best = { i, c };
      }
    });
    if (!best) {
      tpls.forEach((tpl, i) => {
        for (const year of YEARS) {
          const c = occurrence(tpl, year);
          if (!best || Math.abs(c.start - ref) < Math.abs(best.c.start - ref)) best = { i, c };
        }
      });
    }
    pivot = best.i; chosen = best.c;
  }

  const picked = new Array(tpls.length);
  picked[pivot] = chosen;

  /* ما بعد المحور: أول وقوع يبدأ بعد الفصل السابق */
  for (let i = pivot + 1; i < tpls.length; i++) {
    const prev = picked[i - 1].start;
    let c = null;
    for (const year of YEARS) {
      const o = occurrence(tpls[i], year);
      if (o.start > prev && (!c || o.start < c.start)) c = o;
    }
    picked[i] = c || occurrence(tpls[i], prev.getUTCFullYear() + 1);
  }
  /* وما قبله: آخر وقوع يبدأ قبل الفصل التالي */
  for (let i = pivot - 1; i >= 0; i--) {
    const next = picked[i + 1].start;
    let c = null;
    for (const year of YEARS) {
      const o = occurrence(tpls[i], year);
      if (o.start < next && (!c || o.start > c.start)) c = o;
    }
    picked[i] = c || occurrence(tpls[i], next.getUTCFullYear() - 1);
  }

  const terms = tpls.map((tpl, i) => shape(tpl, picked[i], ref));

  /* لا بدّ من فصل جارٍ واحد: إن لم يقع اليوم في أيٍّ منها فأقربها بداية */
  if (!terms.some(t => t.is_current)) {
    let idx = 0, best = Infinity;
    terms.forEach((t, i) => {
      const gap = Math.abs(at(t.start_date) - ref);
      if (gap < best) { best = gap; idx = i; }
    });
    terms[idx].is_current = true;
  }
  /* وليس أكثر من واحد */
  let seen = false;
  for (const t of terms) {
    if (t.is_current && seen) t.is_current = false;
    else if (t.is_current) seen = true;
  }
  return terms;
}

export const DEFAULT_TEMPLATES = [
  { code: 'T-1', name: 'الفصل الدراسي الأول', start_month: 8, start_day: 24, duration_days: 120, sort_order: 1 },
  { code: 'T-2', name: 'الفصل الدراسي الثاني', start_month: 1, start_day: 4, duration_days: 120, sort_order: 2 },
  { code: 'T-3', name: 'الفصل الدراسي الثالث', start_month: 5, start_day: 10, duration_days: 60, sort_order: 3 }
];
