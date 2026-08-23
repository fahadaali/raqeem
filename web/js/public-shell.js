import api from './api.js';
import { el, clear } from './util.js';
import { icon as luIcon } from './icons.js';
import { setPref, applyTheme } from './state.js';

/**
 * الشريط العلوي المشترك للشاشات العامة — الرئيسية والدخول والأسعار والتسجيل.
 *
 * كانت كلُّ شاشةٍ عامّة جزيرةً: من دخل «الأسعار» أو «الدخول» لم يجد باباً يعود منه
 * إلى الصفحة الرئيسية، ولا مفتاحاً للمظهر يجده في اللوحة. فصار الشريط واحداً:
 * شعارٌ يعود إلى الجذر، ومفتاح مظهر، ثم إجراء الشاشة.
 */

let landingState;

/** هل الشاشة الرئيسية منشورة؟ يُقرأ مرّة واحدة لكل إقلاع */
export async function landingPublished() {
  if (landingState !== undefined) return landingState;
  try {
    const d = await api.get('/api/public/landing', { silent: true });
    landingState = !!d?.enabled;
  } catch { landingState = false; }
  return landingState;
}

/** مفتاح المظهر — هو مفتاح اللوحة نفسه واختيارُه يُحفَظ للجلستين معاً */
export function themeToggle() {
  const dark = () => document.documentElement.dataset.theme === 'dark';
  const btn = el('button.icon-btn.land-theme', {
    type: 'button', title: 'المظهر', 'aria-label': 'تبديل المظهر',
    onclick: () => {
      const next = dark() ? 'light' : 'dark';
      applyTheme(next); setPref('theme', next);
    }
  });
  /* الأيقونة تتبع السمة لا الضغطة: من ترك «تلقائي» وبدّل جهازُه ليلاً يجدها صحيحة */
  const sync = () => {
    clear(btn).append(luIcon(dark() ? 'sun' : 'moon', { size: 18 }));
    btn.setAttribute('aria-pressed', String(dark()));
  };
  sync();
  new MutationObserver(sync).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] });
  return btn;
}

/**
 * شريطٌ علويّ لشاشةٍ عامّة.
 *
 * @param {object}   o
 * @param {Function} o.navigate  المُوجِّه
 * @param {string}   o.name      اسم المنصّة كما يعرضه الخادم
 * @param {boolean}  o.home      هل الصفحة الرئيسية منشورة؟ فإن لم تكن، لا يقود
 *                               الشعار إلى جذرٍ يُعيد إلى الدخول — يبقى نصّاً.
 * @param {Node[]}   o.actions   إجراءات الشاشة، تُوضع بعد مفتاح المظهر
 */
export function publicTop({ navigate, name, home = false, actions = [] }) {
  const mark = [
    el('img', { src: '/assets/brand/monogram-primary.svg', alt: '', width: 34, height: 34 }),
    el('b', { text: name || 'منصة رقيم' })
  ];
  return el('header.land-top.pub-top', {}, [
    home
      ? el('a.land-brand', { href: '/', title: 'الصفحة الرئيسية',
          onclick: (e) => { e.preventDefault(); navigate('/'); } }, mark)
      : el('div.land-brand', {}, mark),
    el('nav.land-nav', { 'aria-label': 'روابط عامة' }, [
      /* «العودة للرئيسية» صريحةً إلى جانب الشعار: الشعارُ وحده لا يُقرأ زرَّ رجوع */
      home ? el('button.btn.sm.ghost', { type: 'button', icon: 'arrow-right', iconSize: 15,
        text: 'الرئيسية', onclick: () => navigate('/') }) : null,
      themeToggle(),
      ...actions
    ])
  ]);
}

/** يلفّ شاشةً عامّة بشريطها العلوي — الحاوية الأصلية تبقى كما هي تحته */
export const publicPage = (top, body) => el('div.pub-page', {}, [top, body]);
