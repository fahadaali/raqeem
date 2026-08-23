import api from './api.js';
import { state, setState, setPref, saveTokens, clearSession, can, activeTerm, currentTermObj } from './state.js';
import { el, clear, qs, qsa, toast, timeAgo, T, avatar, skeleton, AR_NUM } from './util.js';
import { icon as luIcon } from './icons.js';
import * as rt from './realtime.js';
import * as pwa from './push.js';

/* ═══════════════ خريطة الشاشات (الواجهة المرنة بحسب الصلاحيات) ═══════════════ */
const NAV = [
  { group: 'الرئيسية' },
  { path: '/', label: 'لوحة التحكم', icon: 'layout-dashboard', view: 'dashboard' },
  { path: '/checkin', label: 'تسجيل الحضور', icon: 'map-pin', view: 'hr', perm: ['hr.attendance.self'], sub: 'checkin' },
  { path: '/notifications', label: 'الإشعارات', icon: 'bell', view: 'notifications', badge: 'notifications' },

  { group: 'العمل التشغيلي' },
  { path: '/tasks', label: 'المهام', icon: 'clipboard-list', view: 'tasks', perm: ['tasks.view', 'tasks.view_all'] },
  { path: '/committees', label: 'اللجان', icon: 'users-round', view: 'committees', perm: ['committees.view'] },
  { path: '/terms', label: 'الفصول الدراسية', icon: 'calendar-days', view: 'terms', perm: ['terms.view'] },
  { path: '/forms', label: 'النماذج والتقييم', icon: 'file-pen-line', view: 'forms', perm: ['forms.view', 'forms.submit'] },
  { path: '/kpi', label: 'مؤشرات الأداء', icon: 'chart-line', view: 'kpi', perm: ['kpi.view', 'kpi.view_all'] },

  { group: 'الموارد والمالية' },
  { path: '/hr', label: 'الموارد البشرية', icon: 'briefcase-business', view: 'hr', perm: ['hr.attendance.self'] },
  { path: '/finance', label: 'النظام المالي', icon: 'banknote', view: 'finance', perm: ['finance.view', 'finance.request'] },

  { group: 'التواصل' },
  { path: '/tickets', label: 'الدعم الفني', icon: 'headset', view: 'tickets', perm: ['tickets.create', 'tickets.view_all'] },

  { group: 'الإدارة والحوكمة' },
  { path: '/reports', label: 'التقارير', icon: 'chart-column', view: 'reports', perm: ['reports.view'] },
  { path: '/imports', label: 'استيراد البيانات', icon: 'import', view: 'imports', perm: ['imports.manage'] },
  { path: '/org', label: 'المستخدمون والفروع', icon: 'building-2', view: 'org', perm: ['users.view', 'branches.view'] },
  { path: '/audit', label: 'سجل النشاطات', icon: 'shield-check', view: 'audit', perm: ['audit.view'] },
  { path: '/billing', label: 'الاشتراك والفوترة', icon: 'credit-card', view: 'billing', perm: ['billing.view'], saas: true },
  { path: '/settings', label: 'الإعدادات', icon: 'settings', view: 'settings' },

];

const BOTTOM = [
  { path: '/', label: 'الرئيسية', icon: 'layout-dashboard' },
  { path: '/tasks', label: 'المهام', icon: 'clipboard-list', perm: ['tasks.view', 'tasks.view_all'] },
  { path: '/checkin', label: 'تحضير', icon: 'map-pin', perm: ['hr.attendance.self'] },
  { path: '/notifications', label: 'الإشعارات', icon: 'bell', badge: 'notifications' },
  { path: '/settings', label: 'حسابي', icon: 'user-round' }
];

const VIEWS = {
  dashboard: () => import('./views/dashboard.js'),
  tasks: () => import('./views/tasks.js'),
  committees: () => import('./views/committees.js'),
  terms: () => import('./views/terms.js'),
  hr: () => import('./views/hr.js'),
  finance: () => import('./views/finance.js'),
  forms: () => import('./views/forms.js'),
  kpi: () => import('./views/kpi.js'),
  tickets: () => import('./views/tickets.js'),
  reports: () => import('./views/reports.js'),
  imports: () => import('./views/imports.js'),
  audit: () => import('./views/audit.js'),
  org: () => import('./views/org.js'),
  settings: () => import('./views/settings.js'),
  notifications: () => import('./views/notifications.js'),
  billing: () => import('./views/billing.js')
};

/* شاشات عامة لا تتطلّب تسجيل دخول (المرحلة الثانية) */
const PUBLIC_VIEWS = {
  '/pricing': () => import('./views/pricing.js'),
  '/signup': () => import('./views/signup.js')
};

const allowed = (item) => {
  if (item.platformOnly) return !!state.session?.platform?.is_platform_admin;
  /* شاشة الاشتراك تظهر فقط عندما تكون طبقة الـ SaaS مفعّلة */
  if (item.saas && !state.session?.platform?.saas_enabled) return false;
  return !item.perm || can(...item.perm);
};

/* ═══════════════ التوجيه ═══════════════ */
export function navigate(url, replace = false) {
  const u = new URL(url, location.origin);
  if (replace) history.replaceState({}, '', u.pathname + u.search);
  else history.pushState({}, '', u.pathname + u.search);
  render();
}
window.navigate = navigate;

function parseRoute() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const query = Object.fromEntries(new URLSearchParams(location.search));
  return { path, query };
}

/* ═══════════════ الهيكل العام ═══════════════ */
function buildSidebar() {
  const nav = el('nav.side-nav');
  const s = state.session;
  let pending = null;
  for (const item of NAV) {
    if (item.group) { pending = item.group; continue; }
    if (!allowed(item)) continue;
    if (pending) { nav.append(el('div.side-group', { text: pending })); pending = null; }
    const link = el('a.side-link', {
      dataset: { path: item.path },
      onclick: (e) => { e.preventDefault(); closeSidebar(); navigate(item.path); }
    }, [
      el('span.ic', { icon: item.icon }),
      el('span', { text: item.label }),
      item.badge === 'notifications' && state.notifications.unread
        ? el('span.badge', { text: state.notifications.unread > 99 ? '٩٩+' : AR_NUM(state.notifications.unread) }) : null
    ]);
    nav.append(link);
  }
  return el('aside.sidebar#sidebar', {}, [
    el('div.side-head', {}, [
      el('img', { src: s.tenant.logo_url || '/assets/brand/monogram-primary.svg', alt: '' }),
      el('div.t', {}, [
        el('b', { text: s.tenant.name }),
        el('span', { text: s.user.role.name })
      ])
    ]),
    nav,
    el('div.side-foot', { text: `منصة رقيم · ${s.tenant.code} · إصدار ١٫٠` })
  ]);
}

function buildTopbar() {
  const s = state.session;
  const branchSel = el('select', {
    onchange: (e) => { setPref('branchId', e.target.value); refreshView(); }
  }, [
    s.all_branches || s.branches.length > 1 ? el('option', { value: 'all', text: 'كل الفروع' }) : null,
    ...s.branches.map(b => el('option', { value: String(b.id), text: b.name }))
  ]);
  branchSel.value = state.branchId;
  if (!branchSel.value) { branchSel.value = s.branches.length > 1 ? 'all' : String(s.branches[0]?.id || ''); setPref('branchId', branchSel.value); }

  const termSel = el('select', {
    onchange: (e) => { setPref('termId', e.target.value); refreshView(); }
  }, s.terms.map(t => el('option', { value: String(t.id), text: t.name + (t.status !== 'open' ? ' (مؤرشف)' : '') })));
  termSel.value = String(activeTerm() || '');

  const bell = el('button.icon-btn', {
    'aria-label': 'الإشعارات', dataset: { role: 'bell' }, onclick: toggleNotifPanel
  }, [
    el('span.ic', { icon: 'bell' }),
    state.notifications.unread ? el('span.dot', { text: state.notifications.unread > 99 ? '٩٩+' : AR_NUM(state.notifications.unread) }) : null
  ]);

  return el('header.topbar', {}, [
    el('button.icon-btn.menu-btn', { icon: 'menu', 'aria-label': 'القائمة', onclick: openSidebar }),
    el('h2#page-title', { text: 'لوحة التحكم' }),
    el('div.spacer'),
    s.branches.length ? el('div.switcher.branch', { title: 'مبدّل الفروع' }, [el('span.ic', { icon: 'building-2', iconSize: 16 }), branchSel]) : null,
    s.terms.length ? el('div.switcher.term', { title: 'الفصل الدراسي' }, [el('span.ic', { icon: 'calendar-days', iconSize: 16 }), termSel]) : null,
    el('button.icon-btn', {
      title: 'تبديل التقويم الهجري/الميلادي',
      text: state.calendar === 'hijri' ? 'هـ' : 'م',
      onclick: async (e) => {
        const next = state.calendar === 'hijri' ? 'gregorian' : 'hijri';
        setPref('calendar', next);
        e.target.textContent = next === 'hijri' ? 'هـ' : 'م';
        api.patch('/api/auth/me', { calendar_pref: next }).catch(() => {});
        toast(next === 'hijri' ? 'تم التحويل إلى التقويم الهجري (أم القرى)' : 'تم التحويل إلى التقويم الميلادي', 'info');
        refreshView();
      }
    }),
    el('button.icon-btn', {
      title: 'المظهر', 'aria-label': 'تبديل المظهر',
      icon: document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon',
      onclick: (e) => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        applyTheme(next); setPref('theme', next);
        const btn = e.currentTarget;
        clear(btn).append(luIcon(next === 'dark' ? 'sun' : 'moon'));
      }
    }),
    bell,
    el('button.icon-btn', {
      title: s.user.name, onclick: () => navigate('/settings'),
      style: { padding: 0, border: 'none', background: 'transparent' }
    }, [avatar(s.user.name)])
  ]);
}

function buildBottomNav() {
  return el('nav.bottom-nav', {}, [el('div.items', {}, BOTTOM.filter(allowed).map(item =>
    el('a', {
      dataset: { path: item.path },
      onclick: (e) => { e.preventDefault(); navigate(item.path); }
    }, [
      el('span.ic', { icon: item.icon, iconSize: 22 }),
      el('span', { text: item.label }),
      item.badge === 'notifications' && state.notifications.unread
        ? el('span.badge', { text: AR_NUM(Math.min(99, state.notifications.unread)) }) : null
    ])
  ))]);
}

const openSidebar = () => {
  qs('#sidebar')?.classList.add('open');
  const back = el('div.side-back', { onclick: closeSidebar });
  document.body.append(back);
};
const closeSidebar = () => { qs('#sidebar')?.classList.remove('open'); qs('.side-back')?.remove(); };

function applyTheme(pref) {
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  /* لونا الهوية: أخضر سنا فاتحاً، والغامق في الوضع الداكن */
  qs('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1C5E4C' : '#2F8A6F');
}

/* ═══════════════ لوحة الإشعارات ═══════════════ */
async function toggleNotifPanel() {
  const existing = qs('.notif-panel');
  if (existing) return existing.remove();
  const panel = el('div.notif-panel', {}, [
    el('div.card-head', {}, [
      el('h3', { text: 'الإشعارات' }),
      el('button.btn.sm.ghost', {
        text: 'تعليم الكل كمقروء',
        onclick: async () => { await api.post('/api/notifications/read', {}); await loadNotifications(); panel.remove(); }
      })
    ]),
    el('div.notif-list', {}, [skeleton(4)])
  ]);
  document.body.append(panel);
  const off = (e) => {
    if (!panel.contains(e.target) && !e.target.closest('.icon-btn')) { panel.remove(); document.removeEventListener('click', off); }
  };
  setTimeout(() => document.addEventListener('click', off), 60);

  const data = await api.get('/api/notifications?limit=25', { silent: true }).catch(() => null);
  const list = qs('.notif-list', panel);
  clear(list);
  if (!data?.items?.length) {
    list.append(el('div.empty', {}, [el('span.ic', { icon: 'bell-off', iconSize: 'card' }), el('h4', { text: 'لا توجد إشعارات' })]));
  } else {
    for (const n of data.items) {
      list.append(el('div.notif' + (n.is_read ? '' : '.unread'), {
        onclick: async () => {
          await api.post('/api/notifications/read', { ids: [n.id] }, { silent: true }).catch(() => {});
          panel.remove(); await loadNotifications();
          if (n.url) navigate(n.url);
        }
      }, [
        el('span.ic', { icon: T.notifIcon[n.category] || 'bell' }),
        el('div.tx', {}, [
          el('b', { text: n.title }),
          n.body ? el('p', { text: n.body }) : null,
          el('div.at', { text: timeAgo(n.created_at) })
        ])
      ]));
    }
    list.append(el('div', { style: { padding: '10px', textAlign: 'center' } }, [
      el('button.btn.sm.ghost', { text: 'عرض كل الإشعارات', onclick: () => { panel.remove(); navigate('/notifications'); } })
    ]));
  }
}

export async function loadNotifications() {
  try {
    const data = await api.get('/api/notifications?limit=25', { silent: true });
    setState({ notifications: { items: data.items, unread: data.unread } });
    updateBadges();
  } catch { /* دون اتصال */ }
}

function updateBadges() {
  const n = state.notifications.unread;
  const bell = qs('.topbar .icon-btn[data-role="bell"]');
  if (bell) {
    bell.querySelector('.dot')?.remove();
    if (n) bell.append(el('span.dot', { text: n > 99 ? '٩٩+' : AR_NUM(n) }));
  }
  for (const holder of [qs('#sidebar'), qs('.bottom-nav')]) {
    const link = holder?.querySelector('[data-path="/notifications"]');
    if (!link) continue;
    link.querySelector('.badge')?.remove();
    if (n) link.append(el('span.badge', { text: n > 99 ? '٩٩+' : AR_NUM(n) }));
  }
  document.title = n ? `(${n}) منصة رقيم` : 'منصة رقيم — الإدارة المتكاملة لمجمعات تحفيظ القرآن';
  if ('setAppBadge' in navigator) navigator.setAppBadge?.(n).catch(() => {});
}

/** شرائط إعلانات المنصة — يقرؤها كل مستخدم في جهته، ويخفيها لنفسه */
function buildBanners() {
  const list = state.session?.banners || [];
  const box = el('div.banners');
  const dismissed = new Set(JSON.parse(localStorage.getItem('raqeem_dismissed_banners') || '[]'));
  for (const b of list) {
    if (dismissed.has(b.id)) continue;
    box.append(el('div.platform-banner.' + (b.severity || 'info'), {}, [
      el('div', {}, [
        el('b', { text: b.title }),
        b.body ? el('span', { text: ' — ' + b.body }) : null
      ]),
      el('button.x', { icon: 'x', iconSize: 16, 'aria-label': 'إخفاء', onclick: (e) => {
        dismissed.add(b.id);
        localStorage.setItem('raqeem_dismissed_banners', JSON.stringify([...dismissed]));
        e.currentTarget.closest('.platform-banner').remove();
      } })
    ]));
  }
  return box;
}

/* ═══════════════ العرض ═══════════════ */
let currentView = null;

async function refreshView() {
  const route = parseRoute();
  setState({ route });
  const item = NAV.find(i => i.path === route.path && !i.group);
  const viewKey = item?.view || 'dashboard';
  const title = item?.label || 'لوحة التحكم';
  const titleEl = qs('#page-title'); if (titleEl) titleEl.textContent = title;

  for (const holder of [qs('#sidebar'), qs('.bottom-nav')]) {
    qsa('[data-path]', holder || document).forEach(a =>
      a.classList.toggle('active', a.dataset.path === route.path));
  }

  const content = qs('#content');
  if (!content) return;
  clear(content).append(skeleton(6));

  if (item && !allowed(item)) {
    clear(content).append(el('div.empty', {}, [
      el('span.ic', { icon: 'lock', iconSize: 'card' }), el('h4', { text: 'لا تملك صلاحية الوصول لهذه الشاشة' }),
      el('p', { text: 'راجع مدير النظام لمنحك الصلاحية المناسبة.' })
    ]));
    return;
  }

  try {
    const mod = await (VIEWS[viewKey] || VIEWS.dashboard)();
    currentView = mod;
    const node = await mod.render({ route, sub: item?.sub, navigate });
    clear(content).append(node);
    content.scrollTop = 0;
    window.scrollTo(0, 0);
  } catch (e) {
    /* الانتقال لشاشة أخرى أثناء التحميل يُلغي الطلب — ليس خطأً يُعرض */
    if (e?.code === 'ABORTED' || route.path !== parseRoute().path) return;
    console.error(e);
    clear(content).append(el('div.empty', {}, [
      el('span.ic', { icon: 'triangle-alert', iconSize: 'card' }), el('h4', { text: 'تعذّر تحميل الشاشة' }),
      el('p', { text: e.message || 'حدث خطأ غير متوقع' }),
      el('button.btn', { text: 'إعادة المحاولة', onclick: () => refreshView() })
    ]));
  }
}

/**
 * هل نشر الادمن الشاشة الرئيسية؟ يُقرأ مرّة واحدة لكل إقلاع.
 * الافتراض عند أي تعذّر: «غير منشورة» — فيرى الزائر شاشة الدخول لا شاشة فارغة.
 */
let landingState;
async function landingPublished() {
  if (landingState !== undefined) return landingState;
  try {
    const d = await api.get('/api/public/landing', { silent: true });
    landingState = !!d?.enabled;
  } catch { landingState = false; }
  return landingState;
}

async function render() {
  const app = qs('#app');

  /*
   * لوحة المنصة طبقة مستقلة: تُسلَّم كاملةً لهيكلها ولا يُبنى هيكل المجمّعات
   * إطلاقاً — فلا تتسرّب قائمة مجمّع ولا مبدّل فروع ولا جلسة مستأجر إليها.
   */
  if (location.pathname.startsWith('/admin')) {
    const { renderAdmin } = await import('./admin-shell.js');
    return renderAdmin();
  }

  if (!state.session) {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const pub = PUBLIC_VIEWS[path];
    if (pub) {
      try {
        const { render: view } = await pub();
        clear(app).append(await view({ navigate, onSuccess: boot }));
        app.hidden = false; hideBoot();
        return;
      } catch (e) { console.error(e); }
    }
    /*
     * `/` للزائر: الشاشة الرئيسية إن نشرها الادمن، وشاشة الدخول إن لم ينشرها.
     * الرجوع إلى الدخول عند الإطفاء — أو عند تعذّر الجلب — يعني أن المنصة لا
     * تنكسر لا قبل تحرير المحتوى ولا حين يسقط المسار العام.
     */
    /*
     * والتطبيق المثبَّت يتخطّاها: من ثبّت التطبيق قصد الدخول لا القراءة عن
     * المنصة، فإقلاعه على صفحة تعريفية في كل مرة تراجعٌ لا ترحيب.
     */
    if (path === '/' && !pwa.isStandalone() && await landingPublished()) {
      try {
        const { render: view } = await import('./views/landing.js');
        clear(app).append(await view({ navigate }));
        app.hidden = false; hideBoot();
        return;
      } catch (e) { console.error(e); }
    }
    const { render: loginView } = await import('./views/login.js');
    clear(app).append(await loginView({ onSuccess: boot, navigate }));
    app.hidden = false;
    hideBoot();
    return;
  }
  /*
   * مسارات الزائر لا معنى لها بعد الدخول: تُستبدل بالجذر في التاريخ نفسه فلا
   * يبقى شريط العنوان يقول `/login` والمستخدم داخلٌ فعلاً.
   */
  if (['/login', '/signup', '/pricing'].includes(parseRoute().path)) {
    history.replaceState({}, '', '/');
  }

  if (!qs('.shell')) {
    clear(app).append(el('div.shell', {}, [
      buildSidebar(),
      el('main.main', {}, [buildTopbar(), buildBanners(), el('div.content#content')]),
    ]), buildBottomNav());
    app.hidden = false;
  }
  await refreshView();
  hideBoot();
}

function hideBoot() {
  const b = qs('#boot');
  if (b && !b.classList.contains('hide')) { b.classList.add('hide'); setTimeout(() => b.remove(), 400); }
}

/* ═══════════════ الإقلاع ═══════════════ */
/**
 * تسليم جلسة المساندة القادمة من لوحة المنصة.
 * الرمز يصل في معامل عابر ويُستهلك فوراً ثم يُمحى من شريط العنوان، فلا يبقى
 * في التاريخ ولا يُشارَك بالنسخ. وهو رمز قصير بلا رمز تجديد.
 */
function consumeImpersonation() {
  const u = new URL(location.href);
  const token = u.searchParams.get('impersonate');
  if (!token) return;
  saveTokens(token, null);
  u.searchParams.delete('impersonate');
  history.replaceState({}, '', u.pathname + (u.search || '') );
}

async function boot() {
  applyTheme(state.theme);
  consumeImpersonation();
  if (state.accessToken) {
    try {
      const s = await api.me();
      if (s.user.calendar_pref) setPref('calendar', s.user.calendar_pref);
      if (s.user.theme_pref && state.theme === 'auto') applyTheme(s.user.theme_pref);
      if (!state.termId && s.current_term) setPref('termId', String(s.current_term.id));
    } catch { clearSession(); }
  }
  clear(qs('#app'));
  await render();

  if (state.session && !location.pathname.startsWith('/admin')) {
    rt.connect();
    loadNotifications();
    pwa.autoResubscribe();
    pwa.maybeShowInstallBanner();
    pwa.maybeAskNotifications();
  }
}

/* الأحداث اللحظية */
rt.on('notification', ({ notification }) => {
  setState({ notifications: { items: [{ ...notification, id: Date.now(), is_read: 0 }, ...state.notifications.items].slice(0, 25),
    unread: state.notifications.unread + 1 } });
  updateBadges();
  toast(notification.body || '', 'info', notification.title);
});
rt.on('chat.message', (m) => window.dispatchEvent(new CustomEvent('raqeem:chat', { detail: m })));
rt.on('task.updated', (m) => window.dispatchEvent(new CustomEvent('raqeem:task', { detail: m })));

/* وضع التراجع: إن تعذّرت القناة الدائمة تُحدَّث البيانات بالاستطلاع الدوري */
rt.on('poll', () => { loadNotifications(); window.dispatchEvent(new CustomEvent('raqeem:poll')); });

window.addEventListener('popstate', () => {
  if (location.pathname.startsWith('/admin')) return void render();
  refreshView();
});
window.addEventListener('raqeem:signout', async () => { clearSession(); rt.disconnect(); clear(qs('#app')); await render(); });
window.addEventListener('raqeem:navigate', (e) => navigate(e.detail));
window.addEventListener('raqeem:push', () => loadNotifications());
window.addEventListener('online', () => { setState({ online: true }); qs('.offline-bar')?.remove(); rt.connect(); loadNotifications(); });
window.addEventListener('offline', () => {
  setState({ online: false });
  if (!qs('.offline-bar')) document.body.append(el('div.offline-bar', { icon: 'triangle-alert', iconSize: 16, text: 'لا يوجد اتصال بالإنترنت — تعرض المنصة آخر بيانات محفوظة' }));
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session) { rt.connect(); loadNotifications(); }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.theme === 'auto') applyTheme('auto'); });

pwa.registerServiceWorker();
boot();

export { refreshView };
