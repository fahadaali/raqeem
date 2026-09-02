import api from './api.js';
import { state } from './state.js';
import { el, toast, modal, qs } from './util.js';

/* ═══════════════════════════════════════════════════════════════════
   نظام الإشعارات المتكامل + تثبيت التطبيق على الشاشة الرئيسية
   يدعم: متصفحات سطح المكتب، أندرويد (Chrome/Edge/Samsung)،
   وآيفون/آيباد (iOS 16.4+ بعد تثبيت التطبيق على الشاشة الرئيسية).
   ═══════════════════════════════════════════════════════════════════ */

let registration = null;
let deferredPrompt = null;

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: window-controls-overlay)').matches ||
  window.navigator.standalone === true;

export const platform = () => {
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
};
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const b64ToU8 = (base64) => {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
};

/* ── تسجيل عامل الخدمة والتحديث الشامل ─────────────────────────── */
/*
 * دورة الإصدار الجديد:
 *   ١) المتصفّح يجد `sw.js` أو ختمَ الإصدار الذي يستورده مختلفاً → يثبّت العامل
 *      الجديد ويُبقيه «منتظراً» (لا يستولي على الصفحة وحده).
 *   ٢) الصفحة ترى المنتظر → لافتة سفلية: «يتوفّر إصدار جديد».
 *   ٣) بالضغط على «تحديث الآن» يُطلَب من المنتظر تحديثٌ شامل: يمحو كل الذواكر،
 *      يجلب هيكل التطبيق طازجاً، ثم يتسلّم الصفحة → `controllerchange` → إعادة
 *      تحميلٍ واحدة بشيفرة الإصدار الجديد كاملةً. لا حذف تطبيق ولا إعادة تثبيت.
 *
 * والبحث عن الإصدار لا يُترك لدورة المتصفّح اليومية وحدها: يُعاد عند كل عودةٍ
 * إلى الشاشة وعند عودة الشبكة وكل ساعة — فمن يُبقي التطبيق مفتوحاً أياماً
 * (شاشة الاستقبال، جهاز التحضير) يرى الإصدار الجديد في ساعته لا في يومه.
 */
const UPDATE_CHECK_MS = 60 * 60 * 1000;
/* صفحةٌ لم يكن لها عاملٌ مسيطر عند فتحها: تسلُّم أول عامل ليس تحديثاً فلا يُعاد تحميلها */
const hadController = !!navigator.serviceWorker?.controller;
let updating = false, reloading = false;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    /* `updateViaCache: 'none'`: ختم الإصدار المستورَد يُجلَب من الخادم لا من ذاكرة المتصفّح */
    registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });

    /* إصدارٌ سبق أن ثُبّت وانتظر — ربّما أُغلقت اللافتة أو فُتحت الصفحة بعده */
    if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner();
    registration.addEventListener('updatefound', () => {
      const sw = registration.installing;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
      });
    });

    /* تسلُّم العامل الجديد — من هذه النافذة أو من نافذةٍ أخرى ضغطت «تحديث» — إعادةُ تحميلٍ واحدة */
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController && !updating) return;
      reloadOnce();
    });

    navigator.serviceWorker.addEventListener('message', (e) => {
      const { type, url, payload } = e.data || {};
      if (type === 'navigate' && url) window.dispatchEvent(new CustomEvent('raqeem:navigate', { detail: url }));
      if (type === 'push') window.dispatchEvent(new CustomEvent('raqeem:push', { detail: payload }));
      if (type === 'resubscribe') subscribePush({ silent: true, ask: false });
      if (type === 'sync') window.dispatchEvent(new CustomEvent('raqeem:sync'));
    });

    const check = () => registration?.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    window.addEventListener('online', check);
    setInterval(check, UPDATE_CHECK_MS);
    return registration;
  } catch (e) {
    console.warn('[sw] فشل التسجيل:', e.message);
    return null;
  }
}

function reloadOnce() {
  if (reloading) return;
  reloading = true;
  location.reload();
}

/** إصدار العامل المسيطر على هذه الصفحة — أو null إن لم يكن عاملٌ بعد */
export function currentVersion() {
  const ctl = navigator.serviceWorker?.controller;
  if (!ctl) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data || null); };
    try { ctl.postMessage({ type: 'GET_VERSION' }, [ch.port2]); } catch { clearTimeout(t); resolve(null); }
  });
}

/**
 * بحثٌ فوري عن إصدار جديد — من زرّ الإعدادات.
 * @returns {'waiting'|'installing'|'current'|'unsupported'}
 */
export async function checkForUpdate() {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  const reg = registration || await navigator.serviceWorker.getRegistration();
  if (!reg) return 'unsupported';
  await reg.update().catch(() => {});
  if (reg.waiting) { showUpdateBanner(); return 'waiting'; }
  if (reg.installing) return 'installing';
  return 'current';
}

/**
 * تنفيذ التحديث الشامل على الإصدار المنتظر.
 * إن لم يكن منتظرٌ (تسلّم في نافذةٍ أخرى مثلاً) كفت إعادةُ التحميل، فالعامل
 * المسيطر هو الجديد أصلاً. وإن تأخّر التسلّم — شبكةٌ بطيئة تُعيد جلب الهيكل —
 * تُعاد الصفحة بعد مهلةٍ على كل حال: العامل يكمل الجلب في الخلفية.
 */
export async function applyUpdate() {
  updating = true;
  const reg = registration || await navigator.serviceWorker?.getRegistration();
  const target = reg?.waiting || reg?.installing;
  if (!target) return reloadOnce();
  target.postMessage({ type: 'FULL_UPDATE' });
  setTimeout(reloadOnce, 15000);
}

function showUpdateBanner() {
  if (document.querySelector('.update-banner')) return;
  /* لافتة الإصدار أولى من لافتتَي التثبيت والإشعارات — لا تتزاحم اللافتات في أسفل الشاشة */
  document.querySelectorAll('.install-banner').forEach(b => b.remove());
  const bar = el('div.install-banner.update-banner', { role: 'status' }, [
    el('span.ic', { icon: 'refresh-cw', iconSize: 30, style: { flex: '0 0 auto' } }),
    el('div.tx', {}, [
      el('b', { text: 'يتوفّر إصدار جديد من المنصة' }),
      el('p', { text: 'حدّث الآن لتعمل بأحدث نسخة كاملةً — دون حذف التطبيق أو إعادة تثبيته.' })
    ]),
    el('button.btn.sm', {
      text: 'تحديث الآن',
      onclick: (e) => {
        bar.classList.add('busy');
        e.currentTarget.textContent = 'جارٍ التحديث...';
        applyUpdate();
      }
    }),
    el('button.icon-btn', { icon: 'x', iconSize: 16, 'aria-label': 'لاحقاً', onclick: () => bar.remove() })
  ]);
  document.body.append(bar);
}

/* ── الاشتراك في إشعارات الدفع ─────────────────────────────────── */
export async function subscribePush({ silent = false, ask = true } = {}) {
  if (!pushSupported()) {
    if (!silent) toast('متصفحك لا يدعم إشعارات الدفع', 'warn');
    return { ok: false, reason: 'unsupported' };
  }
  if (platform() === 'ios' && !isStandalone()) {
    if (!silent) showIosInstallGuide(true);
    return { ok: false, reason: 'ios-needs-install' };
  }

  let permission = Notification.permission;
  if (permission === 'default' && ask) permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    if (!silent) toast(permission === 'denied'
      ? 'الإشعارات محظورة — فعّلها من إعدادات المتصفح لهذا الموقع'
      : 'لم يتم تفعيل الإشعارات', 'warn');
    return { ok: false, reason: permission };
  }

  const reg = registration || await navigator.serviceWorker.ready;
  const { enabled, publicKey } = state.session?.push?.publicKey
    ? { enabled: state.session.push.enabled, publicKey: state.session.push.publicKey }
    : await api.get('/api/push/vapid', { silent: true });
  if (!enabled || !publicKey) {
    if (!silent) toast('إشعارات الدفع غير مفعّلة على الخادم', 'warn');
    return { ok: false, reason: 'server-disabled' };
  }

  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options?.applicationServerKey) {
    const current = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (current !== publicKey) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
  }

  await api.post('/api/notifications/subscribe', { subscription: sub.toJSON(), platform: platform() });
  localStorage.setItem('raqeem_push', '1');
  if (!silent) toast('تم تفعيل الإشعارات على هذا الجهاز بنجاح', 'ok', 'الإشعارات مفعّلة');
  return { ok: true };
}

export async function unsubscribePush() {
  try {
    const reg = registration || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await api.post('/api/notifications/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    localStorage.removeItem('raqeem_push');
    toast('تم إيقاف الإشعارات على هذا الجهاز', 'info');
    return true;
  } catch { return false; }
}

export async function pushStatus() {
  if (!pushSupported()) return { supported: false, subscribed: false, permission: 'unsupported' };
  try {
    const reg = registration || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return { supported: true, subscribed: !!sub, permission: Notification.permission };
  } catch { return { supported: true, subscribed: false, permission: Notification.permission }; }
}

/** إعادة الاشتراك تلقائياً عند الدخول إن سبق تفعيله على هذا الجهاز */
export async function autoResubscribe() {
  if (localStorage.getItem('raqeem_push') !== '1') return;
  /* `Notification` غير معرَّفة أصلاً في سفاري iOS خارج التطبيق المثبَّت — والوصول
     إلى معرِّفٍ غير معرَّف يرمي خطأً لا يمنعه `?.`، فيُقرأ من `globalThis` */
  if (globalThis.Notification?.permission !== 'granted') return;
  await subscribePush({ silent: true, ask: false }).catch(() => {});
}

/* ── تثبيت التطبيق ─────────────────────────────────────────────── */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  window.dispatchEvent(new CustomEvent('raqeem:installable'));
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  localStorage.setItem('raqeem_installed', '1');
  toast('تم تثبيت منصة رقيم على جهازك بنجاح', 'ok', 'تم التثبيت');
  /* بلا طلب إذن: طلبُ الإذن خارج نقرةِ المستخدم يُرفَض صامتاً على سفاري ويُدفن
     على كروم — فيُكتفى بمن سبق أن أذِن، ويُسأل الباقون من لافتة الإشعارات بنقرتهم */
  setTimeout(() => subscribePush({ silent: true, ask: false }), 1800);
});

export const canInstall = () => !!deferredPrompt;

export async function promptInstall() {
  if (platform() === 'ios') return showIosInstallGuide();
  if (!deferredPrompt) {
    return showManualInstallGuide();
  }
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  if (outcome === 'accepted') toast('جارٍ تثبيت التطبيق...', 'ok');
  return outcome === 'accepted';
}

function guideRow(n, text) {
  return el('div.check-row', { style: { cursor: 'default' } }, [
    el('div.avatar.sm', { text: Number(n).toLocaleString('ar-SA') }), el('div.t', { text })
  ]);
}

export function showIosInstallGuide(forNotifications = false) {
  modal({
    title: forNotifications ? 'لتفعيل الإشعارات على الآيفون' : 'تثبيت التطبيق على الآيفون / الآيباد',
    size: 'narrow',
    body: el('div', {}, [
      el('p', { style: { marginTop: 0, color: 'var(--text-2)', fontSize: '13px' },
        text: forNotifications
          ? 'نظام iOS يتيح الإشعارات للمواقع بعد إضافتها للشاشة الرئيسية فقط (iOS 16.4 فأحدث). اتبع الخطوات ثم فعّل الإشعارات من داخل التطبيق:'
          : 'أضف منصة رقيم إلى شاشتك الرئيسية لتعمل كتطبيق مستقل بملء الشاشة:' }),
      guideRow(1, 'افتح المنصة في متصفح Safari (وليس Chrome).'),
      guideRow(2, 'اضغط زر المشاركة في شريط المتصفح السفلي.'),
      guideRow(3, 'اختر «إضافة إلى الشاشة الرئيسية» Add to Home Screen.'),
      guideRow(4, 'اضغط «إضافة»، وسيظهر تطبيق رقيم بين تطبيقاتك.'),
      forNotifications ? guideRow(5, 'افتح التطبيق من الأيقونة الجديدة ثم فعّل الإشعارات من الإعدادات.') : null,
      el('div.hint', { style: { marginTop: '12px' },
        text: 'ملاحظة: يجب فتح التطبيق من الأيقونة المثبّتة حتى تعمل الإشعارات.' })
    ]),
    footer: [el('button.btn', { text: 'فهمت', onclick: () => qs('.modal-back')?.remove() })]
  });
}

function showManualInstallGuide() {
  const p = platform();
  modal({
    title: 'تثبيت التطبيق على جهازك', size: 'narrow',
    body: el('div', {}, [
      el('p', { style: { marginTop: 0, color: 'var(--text-2)', fontSize: '13px' },
        text: p === 'android'
          ? 'من قائمة المتصفح (⋮) اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية».'
          : 'من شريط العنوان اضغط أيقونة التثبيت ⊕، أو من قائمة المتصفح اختر «تثبيت منصة رقيم».' }),
      el('div.hint', { text: 'قد يظهر خيار التثبيت بعد تصفح المنصة لبضع دقائق.' })
    ]),
    footer: [el('button.btn', { text: 'حسناً', onclick: () => qs('.modal-back')?.remove() })]
  });
  return false;
}

/** لافتة الترويج للتثبيت — تظهر مرة واحدة بعد الدخول */
export function maybeShowInstallBanner() {
  if (isStandalone() || localStorage.getItem('raqeem_installed') === '1') return;
  if (localStorage.getItem('raqeem_install_dismissed') === '1') return;
  const p = platform();
  if (p === 'desktop' && !canInstall()) return;

  setTimeout(() => {
    if (document.querySelector('.install-banner')) return;
    const bar = el('div.install-banner', {}, [
      el('img', { src: '/assets/icons/icon-192.png', alt: '' }),
      el('div.tx', {}, [
        el('b', { text: 'ثبّت منصة رقيم على جهازك' }),
        el('p', { text: p === 'ios'
          ? 'أضفها لشاشتك الرئيسية لتعمل كتطبيق وتستقبل الإشعارات.'
          : 'وصول أسرع، عمل دون اتصال، وإشعارات فورية.' })
      ]),
      el('button.btn.sm', { text: 'تثبيت', onclick: async () => { bar.remove(); await promptInstall(); } }),
      el('button.icon-btn', {
        icon: 'x', iconSize: 16, 'aria-label': 'إخفاء',
        onclick: () => { bar.remove(); localStorage.setItem('raqeem_install_dismissed', '1'); }
      })
    ]);
    document.body.append(bar);
    setTimeout(() => bar.remove(), 22000);
  }, 6000);
}

/** طلب تفعيل الإشعارات بلطف — لافتة غير معترضة، لا تُقاطع عمل المستخدم */
/* لا يُعاد العرض قبل أسبوع — ولا يُحرَق العرض على لافتةٍ لم يرها أحد */
const ASK_AGAIN_AFTER = 7 * 24 * 60 * 60 * 1000;

export async function maybeAskNotifications() {
  if (!pushSupported()) return;
  if (localStorage.getItem('raqeem_push') === '1') return;
  if (Notification.permission === 'denied') return;
  if (platform() === 'ios' && !isStandalone()) return;

  /*
   * لا يُعرَض ما لا يعمل.
   *
   * خدمة الدفع تحتاج مفتاحَي VAPID على الخادم، وبدونهما يضغط المستخدم «تفعيل»
   * فيُمنَح الإذن ثم يسقط الاشتراك — فيبقى ظانّاً أن إشعاراته تعمل وهي لا تعمل.
   * فيُسأل الخادمُ أولاً، والصمتُ أصدق من عرضٍ لا يُنجَز.
   */
  try {
    /* المصدر نفسه الذي يقرؤه `subscribePush` — الجلسة أولاً ثم الخادم */
    const st = state.session?.push?.publicKey
      ? state.session.push
      : await api.get('/api/push/vapid', { silent: true });
    if (!st?.enabled || !st?.publicKey) return;
  } catch { return; }

  /* الطلب السابق: يُعاد بعد أسبوع لا يُدفَن إلى الأبد */
  const asked = Number(localStorage.getItem('raqeem_notif_asked') || 0);
  if (asked && Date.now() - asked < ASK_AGAIN_AFTER) return;

  const show = () => {
    // لا نقاطع المستخدم أثناء فتح نافذة أو لوحة جانبية أو لافتة أخرى
    if (document.querySelector('.modal-back, .drawer, .install-banner')) return setTimeout(show, 15000);
    const bar = el('div.install-banner', {}, [
      el('span.ic', { icon: 'bell', iconSize: 32, style: { flex: '0 0 auto' } }),
      el('div.tx', {}, [
        el('b', { text: 'فعّل الإشعارات الفورية' }),
        el('p', { text: 'تنبيهات المهام والاعتمادات المالية والرسائل — تصلك حتى والتطبيق مغلق.' })
      ]),
      /* الوسم يُكتَب عند التصرّف لا عند العرض: لافتةٌ انقضت مدّتها ولم يرها
         أحدٌ لا تُسقط الطلبَ إلى الأبد */
      el('button.btn.sm', {
        text: 'تفعيل',
        onclick: async (e) => {
          e.stopPropagation(); localStorage.setItem('raqeem_notif_asked', String(Date.now()));
          bar.remove(); await subscribePush();
        }
      }),
      el('button.icon-btn', {
        icon: 'x', iconSize: 18, 'aria-label': 'لاحقاً',
        onclick: (e) => {
          e.stopPropagation(); localStorage.setItem('raqeem_notif_asked', String(Date.now()));
          bar.remove();
        }
      })
    ]);
    document.body.append(bar);
    setTimeout(() => bar.remove(), 20000);
  };
  setTimeout(show, 14000);
}
