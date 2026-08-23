import api from '../api.js';
import { publicTop, publicPage, landingPublished } from '../public-shell.js';
import { el, AR_NUM, chip, toast } from '../util.js';

/**
 * صفحة الأسعار العامة (المرحلة الثانية) — تُعرض بلا تسجيل دخول.
 * تقرأ الخطط من قاعدة البيانات لا من الكود، فتتغيّر بتغيير خطط مالك المنصة.
 */
const price = (v) => (Number(v) === 0 ? 'مجاناً' : AR_NUM(Number(v)));
const limitText = (v, unit) => (v === null || v === undefined ? 'بلا حدود' : `${AR_NUM(v)} ${unit}`);

export async function render({ navigate }) {
  const home = await landingPublished();
  const [platform, data] = await Promise.all([
    api.get('/api/public/platform', { silent: true }).catch(() => ({ name: 'منصة رقيم' })),
    api.get('/api/public/plans')
  ]);

  let cycle = 'monthly';
  const grid = el('div.plan-grid');

  const priceOf = (p) => (cycle === 'yearly' ? p.price_yearly : p.price_monthly);
  const perLabel = () => (cycle === 'yearly' ? 'سنوياً' : 'شهرياً');

  const draw = () => {
    grid.replaceChildren(...data.plans.map(p => el('article.plan-card' + (p.highlight ? '.featured' : ''), {}, [
      p.highlight ? el('div.plan-tag', { text: 'الأكثر اختياراً' }) : null,
      el('h3', { text: p.name }),
      p.tagline ? el('p.plan-tagline', { text: p.tagline }) : null,
      el('div.plan-price', {}, [
        el('b', { text: price(priceOf(p)) }),
        priceOf(p) > 0 ? el('span', { text: `${p.currency === 'SAR' ? 'ريال' : p.currency} / ${perLabel()}` }) : null
      ]),
      cycle === 'yearly' && p.yearly_savings
        ? el('div.plan-save', { text: `توفير ${AR_NUM(p.yearly_savings)}٪ عن الدفع الشهري` }) : null,
      el('ul.plan-perks', {}, [
        el('li', { text: `الفروع: ${limitText(p.limits.branches, 'فرع')}` }),
        el('li', { text: `المستخدمون: ${limitText(p.limits.users, 'مستخدم')}` }),
        el('li', { text: `التخزين: ${p.limits.storage_mb === null ? 'بلا حدود' : AR_NUM(Math.round(p.limits.storage_mb / 1024 * 10) / 10) + ' جيجابايت'}` }),
        ...p.perks.map(t => el('li', { text: t }))
      ]),
      p.trial_days > 0 ? el('div.hint', { text: `تجربة مجانية ${AR_NUM(p.trial_days)} يوماً بلا بطاقة` }) : null,
      el('button.btn.block' + (p.highlight ? '.gold' : ''), {
        text: priceOf(p) > 0 ? 'ابدأ التجربة المجانية' : 'ابدأ مجاناً',
        onclick: () => navigate(`/signup?plan=${p.code}&cycle=${cycle}`)
      })
    ])));
  };

  const toggle = el('div.cycle-toggle', {}, [
    el('button.btn.sm.active', { text: 'شهري', onclick: (e) => { cycle = 'monthly'; mark(e); draw(); } }),
    el('button.btn.sm.ghost', { text: 'سنوي — شهران مجاناً', onclick: (e) => { cycle = 'yearly'; mark(e); draw(); } })
  ]);
  const mark = (e) => {
    for (const b of toggle.children) { b.classList.remove('active'); b.classList.add('ghost'); }
    e.currentTarget.classList.add('active'); e.currentTarget.classList.remove('ghost');
  };

  draw();

  return publicPage(
    publicTop({ navigate, name: platform.name, home, actions: [
      el('button.btn.sm.ghost', { type: 'button', text: 'تسجيل الدخول',
        onclick: () => navigate('/login') }),
      platform.signup_enabled
        ? el('button.btn.sm.gold', { type: 'button', text: 'إنشاء جهة',
            onclick: () => navigate('/signup') }) : null
    ].filter(Boolean) }),
    el('div.public-wrap', {}, [
    el('header.public-head', {}, [
      el('img', { src: '/assets/brand/monogram-primary.svg', alt: '', width: 60, height: 60 }),
      el('h1', { text: platform.name || 'منصة رقيم' }),
      el('p', { text: platform.tagline || 'الإدارة المتكاملة لمجمعات تحفيظ القرآن الكريم' }),
      platform.tenants_count
        ? chip(`تخدم ${AR_NUM(platform.tenants_count)} جهة تعليمية`, 'ok') : null
    ]),
    el('section.public-body', {}, [
      el('h2', { text: 'خطط الاشتراك' }),
      el('p.hint', { text: `الأسعار لا تشمل ضريبة القيمة المضافة (${AR_NUM(data.vat_rate)}٪).` }),
      toggle,
      grid
    ]),
    el('footer.public-foot', {}, [
      el('button.btn.ghost', { text: 'تسجيل الدخول', onclick: () => navigate('/login') }),
      platform.signup_enabled
        ? el('button.btn', { text: 'إنشاء جهة جديدة', onclick: () => navigate('/signup') })
        : el('span.hint', { text: 'التسجيل الذاتي مغلق حالياً — تواصل مع إدارة المنصة' }),
      platform.support_email
        ? el('a.hint', { href: `mailto:${platform.support_email}`, text: platform.support_email, dir: 'ltr' }) : null
    ])
  ]));
}
