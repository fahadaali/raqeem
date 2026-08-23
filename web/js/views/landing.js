import api from '../api.js';
import { el, AR_NUM } from '../util.js';
import { hasIcon } from '../icons.js';

/**
 * الشاشة الرئيسية العامة — ما يراه الزائر على `/` قبل أن يملك حساباً.
 *
 * كل محتواها من `GET /api/public/landing`، ولا شيء منها مكتوب هنا: الادمن يحرّرها
 * من لوحته فتتغيّر دون نشر. والبناء بـ `textContent` لا `innerHTML` — فما يكتبه
 * الادمن نصٌّ يُعرَض دائماً، لا وسمٌ يُنفَّذ ولو كان يملك صلاحية كتابته.
 *
 * وأقسامها كلُّها تسقط وحدها إن فرغت: من حذف المعرض من لوحته لا يرى فجوةً مكانه.
 */

const link = (label, href, cls, navigate) => {
  if (!label || !href) return null;
  const internal = href.startsWith('/');
  return el(`a.${cls}`, {
    href, text: label,
    ...(internal ? { onclick: (e) => { e.preventDefault(); navigate(href); } } : { rel: 'noopener' })
  });
};

/** رابطٌ داخل الصفحة نفسها — يمرّر التركيز إلى القسم لا إلى فراغ */
const jump = (label, id) => el('a.land-link', {
  href: `#${id}`, text: label,
  onclick: (e) => {
    const t = document.getElementById(id);
    if (!t) return;
    e.preventDefault();
    const soft = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    t.scrollIntoView({ behavior: soft ? 'smooth' : 'auto', block: 'start' });
    /* القفز البصري وحده يترك قارئ الشاشة مكانه — فيُنقَل التركيز معه */
    t.setAttribute('tabindex', '-1');
    t.focus({ preventScroll: true });
  }
});

/**
 * صورةٌ تتبع سمة الزائر.
 *
 * اللقطة راسترٌ لا يقلب ألوانه، فلقطةٌ فاتحة وسط صفحةٍ داكنة تُقرأ خطأً مطبعياً.
 * ولا يكفي `prefers-color-scheme`: المستخدم قد يختار الفاتح وجهازه داكن، والسمة
 * المعتمدة هي `data-theme` على الجذر — فتُراقَب ما دامت الصورة معروضة.
 */
function themedImg(lightSrc, darkSrc, props = {}) {
  const img = el('img', { src: lightSrc, ...props });
  if (!darkSrc) return img;
  const pick = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    const want = dark ? darkSrc : lightSrc;
    if (img.getAttribute('src') !== want) img.setAttribute('src', want);
  };
  pick();
  new MutationObserver(pick).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-theme'] });
  return img;
}

/** عنوان قسمٍ متمركز — يسقط كلّه إن لم يُكتب له عنوان */
const heading = (h, id) => (h?.title
  ? el('div.land-h', { id: id || null }, [
      el('h2', { text: h.title }),
      h.subtitle ? el('p', { text: h.subtitle }) : null
    ])
  : null);

export async function render({ navigate, signedIn = false }) {
  const d = await api.get('/api/public/landing', { silent: true });
  const p = d.platform || {};
  const h = d.hero || {};
  const H = d.headings || {};

  /* عنوان التبويب ووصفه من كتلة الادمن — الصفحة العامة هي واجهة المنصة للبحث */
  document.title = d.seo?.title || `${p.name || 'منصة رقيم'} — ${h.title || ''}`.trim().replace(/—\s*$/, '');
  const meta = document.querySelector('meta[name="description"]');
  if (meta && (d.seo?.description || h.subtitle)) {
    meta.setAttribute('content', d.seo?.description || h.subtitle);
  }

  /*
   * الأزرار تتبع حال المنصة: زرٌّ إلى تسجيل مغلق يصير زرَّ دخول، فلا يقود الزائر
   * إلى باب موصد. والقاعدة عامة لا خاصّة بالواجهة الأولى — أقسام الدعوة تتبعها.
   */
  const dest = (href) => (href === '/signup' && !p.signup_enabled ? '/login' : href);
  const label = (text, href) =>
    (href === '/signup' && !p.signup_enabled ? 'تسجيل الدخول' : text);
  const cta = (text, href, cls) => link(label(text, href), dest(href), cls, navigate);

  /* الداخل لا يُدعى للتسجيل ولا للدخول: بابه من هنا إلى لوحته */
  const primary = signedIn
    ? link('لوحتي', '/dashboard', 'btn.gold.lg', navigate)
    : cta(h.cta_label, h.cta_href, 'btn.gold.lg');
  /* ولا يُكرَّر زران إلى الوجهة نفسها بعد التحويل */
  const secondary = signedIn || dest(h.secondary_href) === dest(h.cta_href)
    ? null : cta(h.secondary_label, h.secondary_href, 'btn.ghost.lg');

  const section = (s) => el('section.land-sec' + (s.type === 'cta' ? '.cta' : ''), {}, [
    s.title ? el('h2', { text: s.title }) : null,
    s.body ? el('p', { text: s.body }) : null,
    s.type === 'cta' ? cta(s.cta_label, s.cta_href, 'btn.gold') : null
  ]);

  const page = el('div.landing', {}, [
    el('header.land-top', {}, [
      el('a.land-brand', {
        href: '/', onclick: (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      }, [
        el('img', { src: '/assets/brand/monogram-primary.svg', alt: '', width: 38, height: 38 }),
        el('b', { text: p.name || 'منصة رقيم' })
      ]),
      el('nav.land-nav', { 'aria-label': 'روابط الصفحة' }, [
        d.features?.length ? jump('المزايا', 'features') : null,
        d.showcase?.length ? jump('الشاشات', 'showcase') : null,
        d.steps?.length ? jump('كيف تبدأ', 'steps') : null,
        p.saas_enabled ? link('الأسعار', '/pricing', 'land-link', navigate) : null,
        signedIn ? link('لوحتي', '/dashboard', 'btn.sm.ghost', navigate)
                 : link('دخول', '/login', 'btn.sm.ghost', navigate)
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
        el('div.land-frame', {}, [
          /* المقاس معلَنٌ فلا تقفز الصفحة حين تصل الصورة (CLS) */
          themedImg(h.image_url, h.image_dark_url, {
            alt: 'لوحة تحكّم المنصّة', width: 1600, height: 1000, fetchpriority: 'high', decoding: 'async'
          })
        ])
      ]) : null
    ]),

    d.stats?.length ? el('section.land-stats', {}, d.stats.map(s => el('div.land-stat', {}, [
      el('b', { text: /^\d+$/.test(s.value) ? AR_NUM(s.value) : s.value }),
      el('span', { text: s.label })
    ]))) : null,

    d.features?.length ? el('section.land-block.reveal', {}, [
      heading(H.features, 'features'),
      el('div.land-features', {}, d.features.map(f => el('article.land-card', {}, [
        /* الأيقونة اسمُ لوسايد يحرّره الادمن — واسمٌ مجهول يسقط إلى «سنا» لا يكسر البطاقة */
        el('span.ic', { icon: hasIcon(f.icon) ? f.icon : 'sparkles', iconSize: 'card' }),
        el('h3', { text: f.title }),
        f.body ? el('p', { text: f.body }) : null
      ])))
    ]) : null,

    showcase(d.showcase, H.showcase),

    d.steps?.length ? el('section.land-block.land-steps-wrap.reveal', {}, [
      heading(H.steps, 'steps'),
      el('ol.land-steps', {}, d.steps.map((s, i) => el('li.land-step', {}, [
        el('span.n', { text: AR_NUM(i + 1) }),
        el('span.ic', { icon: hasIcon(s.icon) ? s.icon : 'sparkles', iconSize: 24 }),
        el('h3', { text: s.title }),
        s.body ? el('p', { text: s.body }) : null
      ])))
    ]) : null,

    d.testimonials?.length ? el('section.land-block.reveal', {}, [
      heading(H.testimonials),
      el('div.land-quotes', {}, d.testimonials.map(t => el('figure.land-quote', {}, [
        el('span.ic', { icon: 'sparkles', iconSize: 18 }),
        el('blockquote', { text: t.quote }),
        (t.name || t.role) ? el('figcaption', {}, [
          t.name ? el('b', { text: t.name }) : null,
          t.role ? el('span', { text: t.role }) : null
        ]) : null
      ])))
    ]) : null,

    d.faq?.length ? el('section.land-block.reveal', {}, [
      heading(H.faq, 'faq'),
      el('div.land-faq', {}, d.faq.map(f =>
        /* `details` أصليّة: تعمل بلا جافاسكربت، ولوحة المفاتيح وقارئ الشاشة
           يعرفانها بلا وصفٍ نكتبه. و`name` تجعل المفتوحة واحدةً حيث تُدعم. */
        el('details.land-fq', { name: 'landing-faq' }, [
          el('summary', {}, [el('span', { text: f.q }), el('span.ic', { icon: 'chevron-down', iconSize: 18 })]),
          el('p', { text: f.a })
        ])))
    ]) : null,

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

  reveal(page);
  return page;
}

/**
 * معرض الشاشات — تبويباتٌ تُقلَّب على لقطاتٍ من المنصّة نفسها.
 *
 * ولوحاتها كلُّها في الشجرة والمخفيّ منها `hidden`: الصورة المؤجَّلة لا تُجلَب
 * ما دامت مخفيّة، فالزائر لا يحمّل ستَّ لقطاتٍ ليرى واحدة.
 */
function showcase(items, head) {
  if (!items?.length) return null;
  const tabs = [], panels = [];

  const select = (i, focus = false) => {
    tabs.forEach((t, k) => {
      const on = k === i;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;          /* تبويبٌ واحد في مسار Tab، والبقية بالأسهم */
      panels[k].hidden = !on;
    });
    if (focus) tabs[i].focus();
  };

  items.forEach((s, i) => {
    const id = `shw-${i}`;
    tabs.push(el('button.land-tab', {
      type: 'button', role: 'tab', id: `${id}-t`, 'aria-controls': id,
      'aria-selected': String(i === 0), tabIndex: i === 0 ? 0 : -1, text: s.label,
      onclick: () => select(i),
      onkeydown: (e) => {
        /* في اتجاه اليمين إلى اليسار: السهم الأيسر يتقدّم والأيمن يرجع */
        const step = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1
          : e.key === 'Home' ? -i : e.key === 'End' ? items.length - 1 - i : null;
        if (step === null) return;
        e.preventDefault();
        select((i + step + items.length) % items.length, true);
      }
    }));
    panels.push(el('div.land-panel', {
      id, role: 'tabpanel', 'aria-labelledby': `${id}-t`, tabIndex: 0, hidden: i !== 0
    }, [
      el('div.land-frame', {}, [
        themedImg(s.image, s.image_dark, {
          alt: s.label, width: 1600, height: 1000, decoding: 'async',
          ...(i === 0 ? {} : { loading: 'lazy' })
        })
      ]),
      s.caption ? el('p.land-cap', { text: s.caption }) : null
    ]));
  });

  return el('section.land-block.land-show.reveal', {}, [
    heading(head, 'showcase'),
    el('div.land-tabs', { role: 'tablist', 'aria-label': 'شاشات المنصّة' }, tabs),
    ...panels
  ]);
}

/**
 * ظهورٌ متدرّج للأقسام عند بلوغها.
 * ومن طلب تقليل الحركة يراها ظاهرةً من أول لحظة — لا حركة تُفرض عليه.
 */
function reveal(root) {
  const nodes = [...root.querySelectorAll('.reveal')];
  if (!nodes.length) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    nodes.forEach(n => n.classList.add('in'));
    return;
  }
  /* الإخفاء يُعلَن هنا لا في التنسيق: ما لم نصل إلى هذا السطر تبقى الأقسام ظاهرة */
  root.classList.add('js-anim');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
  nodes.forEach(n => io.observe(n));
}
