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

const LIMITS = { features: 12, stats: 6, sections: 8, links: 10 };
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

export const DEFAULT_LANDING = {
  /* منشورة ابتداءً: صفحةٌ رئيسية تُشحن مطفأة تعني أن الزائر يرى الدخول
     حتى ينتبه أحدٌ لمفتاحٍ لا يعرف مكانه. والمحتوى الافتراضي أدناه كافٍ. */
  enabled: true,
  hero: {
    title: 'إدارة مجمّعات التحفيظ في مكان واحد',
    subtitle: 'حلقات ومعلمون وطلاب وحضور ومالية وتقارير — منصّة واحدة تعمل على الجوال والحاسب.',
    cta_label: 'ابدأ الآن',
    cta_href: '/signup',
    secondary_label: 'تسجيل الدخول',
    secondary_href: '/login',
    image_url: ''
  },
  /* الأيقونات بأسماء لوسايد كما في `web/js/icons.js` — لا رموز تعبيرية */
  features: [
    { icon: 'clipboard-list', title: 'المهام واللجان', body: 'توزيع المهام ومتابعتها ولجان العمل بخطة زمنية واضحة.' },
    { icon: 'map-pin', title: 'الحضور والتحضير', body: 'تحضير الحلقات من الجوال، وتقارير غياب فورية لكل فرع.' },
    { icon: 'banknote', title: 'المالية', body: 'إيرادات ومصروفات وميزانيات وتقارير مالية جاهزة للاعتماد.' },
    { icon: 'chart-line', title: 'المؤشرات', body: 'مؤشرات أداء تُحتسب من بيانات المنصّة لا من جداول يدوية.' }
  ],
  stats: [],
  sections: [],
  footer: { links: [], note: '' },
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

  return {
    enabled: !!b.enabled,
    hero: {
      title: text(h.title ?? d.hero.title),
      subtitle: text(h.subtitle ?? d.hero.subtitle, MAX.long),
      cta_label: text(h.cta_label ?? d.hero.cta_label, 40),
      cta_href: safeHref(h.cta_href ?? d.hero.cta_href),
      secondary_label: text(h.secondary_label ?? '', 40),
      secondary_href: safeHref(h.secondary_href ?? ''),
      image_url: safeHref(h.image_url ?? '')
    },
    features: arr(b.features).slice(0, LIMITS.features).map(x => ({
      /* ٤٠ حرفاً تكفي أطول اسم في لوسايد؛ والواجهة تتحقّق من الاسم قبل عرضه */
      icon: text(x?.icon, 40), title: text(x?.title), body: text(x?.body, MAX.long)
    })).filter(x => x.title || x.body),
    stats: arr(b.stats).slice(0, LIMITS.stats).map(x => ({
      label: text(x?.label), value: text(x?.value, 40)
    })).filter(x => x.label || x.value),
    sections: arr(b.sections).slice(0, LIMITS.sections).map(x => ({
      type: x?.type === 'cta' ? 'cta' : 'text',
      title: text(x?.title), body: text(x?.body, MAX.long),
      cta_label: text(x?.cta_label, 40), cta_href: safeHref(x?.cta_href)
    })).filter(x => x.title || x.body),
    footer: {
      links: arr(f.links).slice(0, LIMITS.links)
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
