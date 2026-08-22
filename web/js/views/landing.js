import api from '../api.js';
import { el, AR_NUM } from '../util.js';

/**
 * الشاشة الرئيسية العامة — ما يراه الزائر على `/` قبل أن يملك حساباً.
 *
 * كل محتواها من `GET /api/public/landing`، ولا شيء منها مكتوب هنا: الادمن يحرّرها
 * من لوحته فتتغيّر دون نشر. والبناء بـ `textContent` لا `innerHTML` — فما يكتبه
 * الادمن نصٌّ يُعرَض دائماً، لا وسمٌ يُنفَّذ ولو كان يملك صلاحية كتابته.
 */

const link = (label, href, cls, navigate) => {
  if (!label || !href) return null;
  const internal = href.startsWith('/');
  return el(`a.${cls}`, {
    href, text: label,
    ...(internal ? { onclick: (e) => { e.preventDefault(); navigate(href); } } : { rel: 'noopener' })
  });
};

export async function render({ navigate }) {
  const d = await api.get('/api/public/landing', { silent: true });
  const p = d.platform || {};
  const h = d.hero || {};

  /*
   * الأزرار تتبع حال المنصة: زرٌّ إلى تسجيل مغلق يصير زرَّ دخول، فلا يقود الزائر
   * إلى باب موصد. والقاعدة عامة لا خاصّة بالواجهة الأولى — أقسام الدعوة تتبعها.
   */
  const dest = (href) => (href === '/signup' && !p.signup_enabled ? '/login' : href);
  const label = (text, href) =>
    (href === '/signup' && !p.signup_enabled ? 'تسجيل الدخول' : text);
  const cta = (text, href, cls) => link(label(text, href), dest(href), cls, navigate);

  const primary = cta(h.cta_label, h.cta_href, 'btn.gold.lg');
  /* ولا يُكرَّر زران إلى الوجهة نفسها بعد التحويل */
  const secondary = dest(h.secondary_href) === dest(h.cta_href)
    ? null : cta(h.secondary_label, h.secondary_href, 'btn.ghost.lg');

  const section = (s) => el('section.land-sec' + (s.type === 'cta' ? '.cta' : ''), {}, [
    s.title ? el('h2', { text: s.title }) : null,
    s.body ? el('p', { text: s.body }) : null,
    s.type === 'cta' ? cta(s.cta_label, s.cta_href, 'btn.gold') : null
  ]);

  return el('div.landing', {}, [
    el('header.land-top', {}, [
      el('a.land-brand', {
        href: '/', onclick: (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      }, [
        el('img', { src: '/assets/icons/icon-192.png', alt: '', width: 34, height: 34 }),
        el('b', { text: p.name || 'منصة رقيم' })
      ]),
      el('nav.land-nav', {}, [
        p.saas_enabled ? link('الأسعار', '/pricing', 'land-link', navigate) : null,
        link('دخول', '/login', 'btn.sm.ghost', navigate)
      ])
    ]),

    /* عمودان حين توجد صورة فقط — وإلا فعمود واحد لا نصفٌ فارغ */
    el('section.land-hero' + (h.image_url ? '.has-art' : ''), {}, [
      el('div.land-hero-text', {}, [
        el('h1', { text: h.title || p.name || 'منصة رقيم' }),
        h.subtitle ? el('p', { text: h.subtitle }) : null,
        el('div.land-cta', {}, [primary, secondary])
      ]),
      h.image_url ? el('div.land-hero-art', {}, [
        el('img', { src: h.image_url, alt: '', loading: 'lazy' })
      ]) : null
    ]),

    d.stats?.length ? el('section.land-stats', {}, d.stats.map(s => el('div.land-stat', {}, [
      el('b', { text: /^\d+$/.test(s.value) ? AR_NUM(s.value) : s.value }),
      el('span', { text: s.label })
    ]))) : null,

    d.features?.length ? el('section.land-features', {}, d.features.map(f => el('article.land-card', {}, [
      f.icon ? el('span.ic', { text: f.icon }) : null,
      el('h3', { text: f.title }),
      f.body ? el('p', { text: f.body }) : null
    ]))) : null,

    ...(d.sections || []).map(section),

    el('footer.land-foot', {}, [
      el('div.land-foot-links', {},
        (d.footer?.links || []).map(l => link(l.label, l.href, 'land-link', navigate))),
      d.footer?.note ? el('p', { text: d.footer.note }) : null,
      p.support_email
        ? el('a.land-link', { href: `mailto:${p.support_email}`, text: p.support_email, dir: 'ltr' }) : null,
      el('p.land-copy', { text: `${p.name || 'منصة رقيم'} — جميع الحقوق محفوظة` })
    ])
  ]);
}
