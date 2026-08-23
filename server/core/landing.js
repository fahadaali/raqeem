import { j } from './sql.js';
import { platformSettings } from './billing.js';

/**
 * محتوى الشاشة الرئيسية العامة — كتلة JSON واحدة في `platform_settings.landing`.
 *
 * كتلة واحدة لا جدول: المحتوى يُقرأ كاملاً في كل مرة ولا يُستعلم عن أجزائه ولا
 * يُرتَّب ولا يُصفّى، فجدولٌ له مفاصل وارتباطات يكلّف ولا يعطي شيئاً.
 *
 * وكل ما يخرج من هنا **مطهَّر ومحدود**: هذه هي الكتلة الوحيدة في المنصة التي
 * يكتبها الادمن وتُقرأ بلا مصادقة، فحدّ الطول يمنع تضخيم الصفحة، وفلترة الروابط
 * تمنع `javascript:` من الوصول إلى زائر لا يملك حساباً أصلاً.
 */

const LIMITS = { features: 12, stats: 6, sections: 8, links: 10,
  showcase: 8, steps: 6, testimonials: 6, faq: 12 };
const MAX = { short: 160, long: 600, href: 400 };

const text = (v, max = MAX.short) => String(v ?? '').trim().slice(0, max);

/**
 * الروابط الداخلية والمطلقة الآمنة وحدها تمرّ.
 * ما عداها يصير سلسلة فارغة فيسقط الزر بدل أن يصير مسلكاً للتنفيذ.
 */
export function safeHref(v) {
  const s = String(v ?? '').trim().slice(0, MAX.href);
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^mailto:[^\s]+@[^\s]+$/i.test(s) || /^tel:[+\d\s-]+$/i.test(s)) return s;
  return '';
}

/**
 * الشاشات المشحونة مع المنصة — لقطات من الواجهة نفسها لا رسوماً تخيّلية،
 * بنسختَي فاتح وداكن حتى تتبع الصورةُ سمةَ الزائر لا تعانده.
 *
 * الادمن يختار منها في محرّره أو يكتب رابطاً خاصاً به، والكتالوج يُصدَّر ليقرأه
 * المحرّر — فلا يُكتب اسم ملفٍ بالذاكرة ولا يُخمَّن مسار.
 */
export const SCREEN_CATALOGUE = [
  { key: 'dashboard', label: 'لوحة التحكم',    caption: 'ما يحتاج انتباهك أولاً، ثم مؤشرات فصلك.' },
  { key: 'approvals', label: 'صندوق الاعتمادات', caption: 'مالية وإجازات في صفٍّ واحد، والقرار في السطر نفسه.' },
  { key: 'tasks',     label: 'المهام واللجان',  caption: 'لوحة مهام بالحالات والأولويات وتواريخ الاستحقاق.' },
  { key: 'checkin',   label: 'التحضير الذكي',   caption: 'حضورٌ من الجوال داخل نطاق الفرع وحده.' },
  { key: 'finance',   label: 'الدورة المالية',  caption: 'طلبٌ يمرّ بمساره حتى الاعتماد، وفواتير مرفقة.' },
  { key: 'kpi',       label: 'مؤشرات الأداء',   caption: 'مؤشرات تُحتسب من بيانات المنصة لا من جداول يدوية.' }
].map(s => ({ ...s, image: `/assets/screens/${s.key}-light.webp`,
  image_dark: `/assets/screens/${s.key}-dark.webp` }));

export const DEFAULT_LANDING = {
  /* منشورة ابتداءً: صفحةٌ رئيسية تُشحن مطفأة تعني أن الزائر يرى الدخول
     حتى ينتبه أحدٌ لمفتاحٍ لا يعرف مكانه. والمحتوى الافتراضي أدناه كافٍ. */
  enabled: true,
  hero: {
    title: 'إدارة مجمّعات التحفيظ في مكان واحد',
    subtitle: 'حلقات ومعلمون وطلاب وحضور ومالية وتقارير — منصّة واحدة تعمل على الجوال والحاسب.',
    cta_label: 'ابدأ تجربتك',
    cta_href: '/signup',
    secondary_label: 'شاهد الأسعار',
    secondary_href: '/pricing',
    image_url: '/assets/screens/dashboard-light.webp',
    image_dark_url: '/assets/screens/dashboard-dark.webp'
  },
  /* الأيقونات بأسماء لوسايد كما في `web/js/icons.js` — لا رموز تعبيرية */
  features: [
    { icon: 'clipboard-list', title: 'المهام واللجان', body: 'توزيع المهام ومتابعتها ولجان العمل بخطة زمنية واضحة.' },
    { icon: 'map-pin', title: 'التحضير الذكي', body: 'حضورٌ من الجوال داخل نطاق الفرع وحده، وتقارير غياب فورية.' },
    { icon: 'banknote', title: 'الدورة المالية', body: 'طلبٌ يمرّ بمسار اعتمادٍ تضبطه أنت، بفواتير مرفقة وميزانيات.' },
    { icon: 'file-pen-line', title: 'التقييم والنماذج', body: 'نماذج تُبنى بلا برمجة، وتقييمٌ يُحفظ في ملفّ المنسوب.' },
    { icon: 'file-text', title: 'التقارير الرسمية', body: 'تقارير تُصدَّر PDF وExcel بترويسة جهتك وتقويم مستخدمها.' },
    { icon: 'scroll-text', title: 'سجل التدقيق', body: 'كل إجراءٍ حسّاس مسجَّلٌ باسم صاحبه ووقته — ولا يُحذف.' }
  ],
  stats: [
    { value: '١٢', label: 'وحدة عمل في منصّة واحدة' },
    { value: '٦', label: 'أدوار بصلاحيات منفصلة' },
    { value: '٢', label: 'تقويمان — هجري وميلادي' },
    { value: '٪١٠٠', label: 'عربية واتجاه من اليمين' }
  ],

  /* عناوين الأقسام في مكان واحد — فلا يُبعثَر نصُّ العنوان بين كتلةٍ وأخرى */
  headings: {
    features:     { title: 'ما الذي تديره من مكان واحد',
                    subtitle: 'وحدات المنصّة تعمل على البيانات نفسها — لا تصدير ولا إعادة إدخال.' },
    showcase:     { title: 'انظر إليها وهي تعمل',
                    subtitle: 'لقطات من المنصّة نفسها، بالعربية واتجاهها، على بيانات مجمّع حقيقي.' },
    steps:        { title: 'كيف تبدأ',
                    subtitle: 'من إنشاء الجهة إلى أول تقرير — في يوم واحد.' },
    testimonials: { title: 'من يعمل عليها', subtitle: '' },
    faq:          { title: 'أسئلة قبل أن تبدأ', subtitle: '' }
  },

  /* معرض الشاشات — تبويبات تُقلَّب، وصورةُ كلِّ تبويب من الكتالوج أعلاه */
  showcase: SCREEN_CATALOGUE.map(s => ({
    label: s.label, caption: s.caption, image: s.image, image_dark: s.image_dark
  })),

  steps: [
    { icon: 'building-2', title: 'أنشئ جهتك',
      body: 'اسمٌ ورمزٌ وحساب مدير — دقيقة واحدة، ولا بطاقة في التجربة.' },
    { icon: 'users', title: 'ادعُ فريقك',
      body: 'كل دورٍ يرى ما يخصّه وحده: المعلّم غير المحاسب، والمشرف غير المدقّق.' },
    { icon: 'calendar-days', title: 'افتح الفصل',
      body: 'المهام والحضور والتقارير كلّها معلّقة بفصلٍ مفتوح — وبفتحه تبدأ المنصّة.' }
  ],

  testimonials: [],

  faq: [
    { q: 'هل بياناتنا معزولة عن بقية المجمّعات؟',
      a: 'نعم. كل استعلامٍ في المنصّة محصورٌ بمعرّف جهتك، والصلاحيات تُفحص على الخادم لا في المتصفّح، وكل إجراءٍ حسّاس يُسجَّل في سجل تدقيقٍ لا يُحذف.' },
    { q: 'هل تعمل بالتقويم الهجري؟',
      a: 'التقويمان معاً. يختار كلُّ مستخدمٍ تقويمه من إعداداته، فتُعرَض التواريخ كلُّها به — في الشاشات والتقارير والملفات المصدَّرة.' },
    { q: 'ماذا لو انقطع الإنترنت أثناء العمل؟',
      a: 'المنصّة تطبيقُ ويبٍ مثبَّت: تُشحن من ذاكرة الجهاز فتفتح بلا اتصال، وتعرض آخر بياناتٍ محفوظة مع شريطٍ يقول إنك بلا اتصال، ثم تُزامن حين يعود.' },
    { q: 'هل يمكن تصدير بياناتنا؟',
      a: 'نعم — التقارير تُصدَّر PDF وExcel، والبيانات الأساسية تُستورد وتُصدَّر بملفات جدولية. لا حبس للبيانات.' },
    { q: 'كم يستغرق التجهيز؟',
      a: 'الجهة تُنشأ في دقيقة، وقائمة تجهيزٍ من خمس خطواتٍ قصيرة تنتظرك في صدر لوحتك — تُكمِلها متى شئت، وتُحتسَب من بياناتك نفسها.' }
  ],

  /* خاتمةٌ تدعو إلى الإجراء — من قرأ الصفحة كلَّها يستحق باباً في آخرها لا فراغاً */
  sections: [
    { type: 'cta', title: 'ابدأ بمجمّعك اليوم',
      body: 'أنشئ جهتك في دقيقة، وجرّب المنصّة على بيانات مجمّعك — بلا بطاقة ولا التزام.',
      cta_label: 'أنشئ جهتك', cta_href: '/signup' }
  ],
  footer: {
    links: [
      { label: 'الأسعار', href: '/pricing' },
      { label: 'إنشاء جهة', href: '/signup' },
      { label: 'تسجيل الدخول', href: '/login' }
    ],
    note: 'سكينةُ الحلقة، وإتقانُ الإدارة.'
  },
  seo: { title: '', description: '' }
};

/** يطهّر كتلة قادمة من الادمن ويحدّها — يُستدعى قبل الحفظ وبعد القراءة معاً */
export function normalizeLanding(raw) {
  const b = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const d = DEFAULT_LANDING;
  const h = b.hero && typeof b.hero === 'object' ? b.hero : {};
  const f = b.footer && typeof b.footer === 'object' ? b.footer : {};
  const seo = b.seo && typeof b.seo === 'object' ? b.seo : {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  /*
   * كتلةٌ غائبة ≠ كتلةٌ مفرَّغة: من حفظ الصفحة قبل إضافة هذه الأقسام لا تحمل
   * كتلته مفاتيحها أصلاً، فيأخذ الافتراضي. ومن حذف عناصرها عمداً تبقى فارغة.
   */
  const arrOr = (v, dflt) => (v === undefined ? dflt : arr(v));
  const head = (v, dflt) => {
    const o = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    return { title: text(o.title ?? dflt.title), subtitle: text(o.subtitle ?? dflt.subtitle, MAX.long) };
  };
  const hs = (b.headings && typeof b.headings === 'object') ? b.headings : {};

  return {
    enabled: !!b.enabled,
    hero: {
      title: text(h.title ?? d.hero.title),
      subtitle: text(h.subtitle ?? d.hero.subtitle, MAX.long),
      cta_label: text(h.cta_label ?? d.hero.cta_label, 40),
      cta_href: safeHref(h.cta_href ?? d.hero.cta_href),
      secondary_label: text(h.secondary_label ?? '', 40),
      secondary_href: safeHref(h.secondary_href ?? ''),
      image_url: safeHref(h.image_url ?? d.hero.image_url),
      image_dark_url: safeHref(h.image_dark_url ?? d.hero.image_dark_url)
    },
    features: arrOr(b.features, d.features).slice(0, LIMITS.features).map(x => ({
      /* ٤٠ حرفاً تكفي أطول اسم في لوسايد؛ والواجهة تتحقّق من الاسم قبل عرضه */
      icon: text(x?.icon, 40), title: text(x?.title), body: text(x?.body, MAX.long)
    })).filter(x => x.title || x.body),
    stats: arrOr(b.stats, d.stats).slice(0, LIMITS.stats).map(x => ({
      label: text(x?.label), value: text(x?.value, 40)
    })).filter(x => x.label || x.value),
    headings: {
      features:     head(hs.features,     d.headings.features),
      showcase:     head(hs.showcase,     d.headings.showcase),
      steps:        head(hs.steps,        d.headings.steps),
      testimonials: head(hs.testimonials, d.headings.testimonials),
      faq:          head(hs.faq,          d.headings.faq)
    },
    /* الصورتان مساران داخليان أو روابط كاملة — `safeHref` يُسقط ما عداهما */
    showcase: arrOr(b.showcase, d.showcase).slice(0, LIMITS.showcase).map(x => ({
      label: text(x?.label), caption: text(x?.caption, MAX.long),
      image: safeHref(x?.image), image_dark: safeHref(x?.image_dark)
    })).filter(x => x.label && x.image),
    steps: arrOr(b.steps, d.steps).slice(0, LIMITS.steps).map(x => ({
      icon: text(x?.icon, 40), title: text(x?.title), body: text(x?.body, MAX.long)
    })).filter(x => x.title || x.body),
    testimonials: arrOr(b.testimonials, d.testimonials).slice(0, LIMITS.testimonials).map(x => ({
      quote: text(x?.quote, MAX.long), name: text(x?.name), role: text(x?.role)
    })).filter(x => x.quote),
    faq: arrOr(b.faq, d.faq).slice(0, LIMITS.faq).map(x => ({
      q: text(x?.q, MAX.short), a: text(x?.a, MAX.long)
    })).filter(x => x.q && x.a),
    sections: arrOr(b.sections, d.sections).slice(0, LIMITS.sections).map(x => ({
      type: x?.type === 'cta' ? 'cta' : 'text',
      title: text(x?.title), body: text(x?.body, MAX.long),
      cta_label: text(x?.cta_label, 40), cta_href: safeHref(x?.cta_href)
    })).filter(x => x.title || x.body),
    footer: {
      links: arrOr(f.links, d.footer.links).slice(0, LIMITS.links)
        .map(x => ({ label: text(x?.label, 40), href: safeHref(x?.href) }))
        .filter(x => x.label && x.href),
      note: text(f.note, MAX.long)
    },
    seo: { title: text(seo.title), description: text(seo.description, MAX.long) }
  };
}

/** الكتلة المخزّنة مطهَّرةً — والافتراضية إن لم يُحرَّر شيء بعد */
export async function readLanding(app) {
  const s = await platformSettings(app);
  const stored = j(s.landing, null);
  if (!stored || !Object.keys(stored).length) return { ...DEFAULT_LANDING };
  return normalizeLanding(stored);
}
