import api from './admin-api.js';
import { admin, clearAdminSession } from './admin-state.js';
import { el, clear, qs, toast, field, input, skeleton, empty } from './util.js';
import * as S from './views/admin/sections.js';

/**
 * هيكل لوحة المنصة — مستقل تماماً عن هيكل المجمّعات.
 *
 * لا يشترك معه في قائمة جانبية ولا شريط علوي ولا جلسة: لا مبدّل فروع ولا فصول
 * (لا معنى لهما هنا)، ولا إشعارات مجمّع، ولا هوية مجمّع. والهوية البصرية داكنة
 * مميِّزة كي لا تلتبس اللوحتان على من يفتحهما معاً.
 */

const NAV = [
  { group: 'المنصة' },
  { path: '/admin', label: 'نظرة عامة', icon: 'gauge', build: S.overviewTab },
  { path: '/admin/growth', label: 'النمو', icon: 'trending-up', build: S.growthTab },
  { path: '/admin/health', label: 'صحة المجمّعات', icon: 'heart-pulse', build: S.healthTab },

  { group: 'المجمّعات' },
  { path: '/admin/tenants', label: 'المجمّعات', icon: 'landmark', build: S.tenantsTab },
  { path: '/admin/terms', label: 'قوالب الفصول', icon: 'calendar-range', build: S.termsTab },
  { path: '/admin/signups', label: 'طلبات التسجيل', icon: 'user-plus', build: S.signupsTab },

  { group: 'الواجهة العامة' },
  { path: '/admin/landing', label: 'الشاشة الرئيسية', icon: 'monitor', build: S.landingTab },
  { path: '/admin/announcements', label: 'الإعلانات', icon: 'megaphone', build: S.announceTab },

  { group: 'التجارة' },
  { path: '/admin/plans', label: 'الخطط', icon: 'layers', build: S.plansTab },
  { path: '/admin/coupons', label: 'الكوبونات', icon: 'ticket-percent', build: S.couponsTab },
  { path: '/admin/invoices', label: 'الفواتير', icon: 'receipt', build: S.invoicesTab },

  { group: 'التشغيل والحوكمة' },
  { path: '/admin/support', label: 'صندوق الدعم', icon: 'headset', build: S.supportTab },
  { path: '/admin/ops', label: 'التشغيل', icon: 'zap', build: S.opsTab },
  { path: '/admin/security', label: 'الأمن', icon: 'lock', build: S.securityTab },
  { path: '/admin/logs', label: 'سجل المنصة', icon: 'scroll-text', build: S.logsTab },

  { group: 'الإعدادات' },
  { path: '/admin/settings', label: 'إعدادات المنصة', icon: 'settings', build: S.settingsTab },
  { path: '/admin/admins', label: 'حسابات الادمن', icon: 'user-round', build: S.adminsTab }
];

const ROUTES = Object.fromEntries(NAV.filter(i => i.path).map(i => [i.path, i]));

export function adminNavigate(path, replace = false) {
  const u = new URL(path, location.origin);
  if (replace) history.replaceState({}, '', u.pathname + u.search);
  else history.pushState({}, '', u.pathname + u.search);
  renderAdmin();
}

function parse() {
  const path = location.pathname.replace(/\/+$/, '') || '/admin';
  return { path, query: Object.fromEntries(new URLSearchParams(location.search)) };
}

/* ═══════════════ شاشة الدخول ═══════════════ */
function loginScreen() {
  const email = input({ type: 'email', autocomplete: 'username', placeholder: 'admin@raqeem.sa' });
  const pass = input({ type: 'password', autocomplete: 'current-password' });
  const totp = input({ inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '••••••' });
  const totpField = field('رمز التحقّق بخطوتين', totp);
  totpField.hidden = true;
  const msg = el('div.hint', { style: { color: 'var(--danger)', minHeight: '20px' } });
  const btn = el('button.btn.gold.block', { type: 'submit', text: 'دخول لوحة المنصة' });

  const submit = async (e) => {
    e?.preventDefault();
    if (!email.value.trim() || !pass.value) { msg.textContent = 'أدخل البريد وكلمة المرور'; return; }
    btn.disabled = true; btn.textContent = 'جارٍ التحقّق…'; msg.textContent = '';
    try {
      await api.login(email.value.trim(), pass.value, totp.value.trim() || undefined);
      await renderAdmin();
    } catch (err) {
      if (err.code === 'TOTP_REQUIRED') {
        totpField.hidden = false; totp.focus();
      } else {
        msg.textContent = err.message || 'تعذّر الدخول';
        pass.value = '';
      }
      btn.disabled = false; btn.textContent = 'دخول لوحة المنصة';
    }
  };

  return el('div.admin-login', {}, [
    el('form.admin-login-card', { onsubmit: submit, novalidate: true }, [
      el('div.admin-login-brand', {}, [
        el('img', { src: '/assets/brand/monogram-primary.svg', alt: '', width: 64, height: 64 }),
        el('h1', { text: 'لوحة منصة رقيم' }),
        el('p', { text: 'الدخول مقصور على حسابات إدارة المنصة' })
      ]),
      field('البريد الإلكتروني', email, { required: true }),
      field('كلمة المرور', pass, { required: true }),
      totpField,
      btn,
      msg,
      /* «العودة» في RTL تشير يميناً — اتجاه القراءة (دليل الهوية · البند ٨) */
      el('a.admin-login-back', { href: '/', icon: 'arrow-right', iconSize: 16, text: 'العودة إلى المنصة' })
    ])
  ]);
}

/* ═══════════════ الهيكل ═══════════════ */
function sidebar(active) {
  const nav = el('nav.admin-nav');
  let pending = null;
  for (const item of NAV) {
    if (item.group) { pending = item.group; continue; }
    if (pending) { nav.append(el('div.admin-group', { text: pending })); pending = null; }
    nav.append(el('a.admin-link', {
      dataset: { path: item.path },
      class: item.path === active ? 'admin-link active' : 'admin-link',
      onclick: (e) => { e.preventDefault(); document.body.classList.remove('admin-open'); adminNavigate(item.path); }
    }, [el('span.ic', { icon: item.icon }), el('span', { text: item.label })]));
  }
  return el('aside.admin-side', {}, [
    el('div.admin-brand', {}, [
      el('img', { src: '/assets/brand/monogram-primary.svg', alt: '' }),
      el('div', {}, [
        el('b', { text: 'لوحة المنصة' }),
        el('span', { text: admin.session?.platform?.name || 'منصة رقيم' })
      ])
    ]),
    nav,
    el('div.admin-foot', { text: 'طبقة إدارة المنصة · إصدار ١٫٠' })
  ]);
}

function topbar(item) {
  return el('header.admin-top', {}, [
    el('button.icon-btn.admin-burger', {
      icon: 'menu', 'aria-label': 'القائمة',
      onclick: () => document.body.classList.toggle('admin-open')
    }),
    el('h2#admin-title', { text: item?.label || 'لوحة المنصة' }),
    el('div.spacer'),
    el('span.admin-who', { text: admin.session?.admin?.name || '' }),
    el('button.icon-btn', {
      icon: 'log-out', title: 'خروج', 'aria-label': 'خروج',
      onclick: async () => { await api.logout(); await renderAdmin(); }
    })
  ]);
}

/* ═══════════════ العرض ═══════════════ */
export async function renderAdmin() {
  const app = qs('#app');
  document.documentElement.classList.add('admin-mode');

  if (!admin.accessToken) {
    clear(app).append(loginScreen());
    app.hidden = false;
    document.getElementById('boot')?.remove();
    return;
  }

  if (!admin.session) {
    try { await api.me(); }
    catch { clearAdminSession(); clear(app).append(loginScreen()); app.hidden = false;
      document.getElementById('boot')?.remove(); return; }
  }

  const route = parse();
  admin.route = route;
  const item = ROUTES[route.path] || ROUTES['/admin'];

  if (!qs('.admin-shell')) {
    clear(app).append(el('div.admin-shell', {}, [
      sidebar(item.path),
      el('div.admin-back', { onclick: () => document.body.classList.remove('admin-open') }),
      el('main.admin-main', {}, [topbar(item), el('div.admin-content#admin-content')])
    ]));
    app.hidden = false;
  } else {
    for (const a of app.querySelectorAll('.admin-link')) {
      a.classList.toggle('active', a.dataset.path === item.path);
    }
    const t = qs('#admin-title'); if (t) t.textContent = item.label;
  }
  document.getElementById('boot')?.remove();

  const content = qs('#admin-content');
  clear(content).append(skeleton(5));
  try {
    const node = await item.build({ navigate: adminNavigate, route });
    clear(content).append(node);
    content.scrollTop = 0;
  } catch (e) {
    if (e?.code === 'ABORTED' || route.path !== parse().path) return;
    clear(content).append(empty('triangle-alert', 'تعذّر تحميل الشاشة', e.message || 'حدث خطأ غير متوقع'));
  }
}

window.addEventListener('raqeem:admin-signout', async () => {
  clearAdminSession();
  if (location.pathname.startsWith('/admin')) {
    toast('انتهت الجلسة، يرجى تسجيل الدخول', 'warn');
    await renderAdmin();
  }
});
