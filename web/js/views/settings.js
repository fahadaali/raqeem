import api from '../api.js';
import { state, setPref, can, clearSession } from '../state.js';
import {
  el, clear, card, chip, empty, table, toast, modal, field, input, select, textarea, tabs,
  AR_NUM, avatar, confirmDialog, skeleton, timeAgo, qs
} from '../util.js';
import { fmtDateTime } from '../hijri.js';
import { pushStatus, subscribePush, unsubscribePush, promptInstall, isStandalone, platform, canInstall } from '../push.js';

export async function render({ navigate }) {
  const items = [
    { label: 'حسابي', icon: 'user-round', build: profileTab },
    { label: 'الإشعارات', icon: 'bell', build: notifTab },
    { label: 'التطبيق', icon: 'smartphone', build: appTab }
  ];
  if (can('settings.manage')) items.push({ label: 'هوية الجهة', icon: 'landmark', build: tenantTab });
  if (can('settings.manage')) items.push({ label: 'النسخ الاحتياطي', icon: 'database', build: backupTab });
  items.push({ label: 'التحقّق بخطوتين', icon: 'shield-check', build: twoFactorTab });
  if (can('api.keys.manage')) items.push({ label: 'مفاتيح الربط', icon: 'key', build: apiTab });
  const t = tabs(items, (it) => { const n = el('div'); Promise.resolve(it.build(navigate)).then(x => n.replaceChildren(x)); return n; });
  return t.node;
}

/* ═══════════ الملف الشخصي ═══════════ */
async function profileTab() {
  const u = state.session.user;
  const name = input({ value: u.name });
  const phone = input({ value: u.phone || '', dir: 'ltr' });
  const cal = select([{ value: 'hijri', label: 'هجري (أم القرى)' }, { value: 'gregorian', label: 'ميلادي' }], { value: state.calendar });
  const theme = select([{ value: 'auto', label: 'تلقائي حسب النظام' }, { value: 'light', label: 'فاتح' }, { value: 'dark', label: 'داكن' }], { value: state.theme });

  const cur = input({ type: 'password', autocomplete: 'current-password' });
  const nw = input({ type: 'password', autocomplete: 'new-password' });
  const nw2 = input({ type: 'password', autocomplete: 'new-password' });

  const sessionsBox = el('div');
  api.get('/api/auth/sessions').then(rows => {
    clear(sessionsBox).append(table([
      { header: 'الجهاز', key: 'user_agent', render: r => (r.user_agent || 'غير معروف').slice(0, 46) },
      { header: 'العنوان', key: 'ip' },
      { header: 'بدأت', key: 'created_at', render: r => timeAgo(r.created_at) },
      { header: 'الحالة', key: 's', render: r => chip(r.revoked ? 'منتهية' : 'نشطة', r.revoked ? '' : 'ok') },
      { header: '', key: 'a', render: r => r.revoked ? '—' : el('button.btn.sm.ghost', { text: 'إنهاء', onclick: async () => {
          await api.del(`/api/auth/sessions/${r.id}`); toast('تم إنهاء الجلسة', 'ok');
          api.get('/api/auth/sessions').then(() => location.reload());
        } }) }
    ], rows));
  }).catch(() => {});

  return el('div.stack', {}, [
    card('البيانات الشخصية', [
      el('div.row', { style: { marginBottom: '14px' } }, [
        avatar(u.name, 'lg'),
        el('div', {}, [el('h3', { text: u.name }), el('div.hint', { text: `${u.role.name} · ${u.email}` })])
      ]),
      el('div.grid.g2', {}, [field('الاسم', name), field('الجوال', phone)]),
      el('div.grid.g2', {}, [
        field('التقويم المفضّل', cal, { hint: 'يُطبَّق على جميع التواريخ في المنصة' }),
        field('مظهر الواجهة', theme)
      ]),
      el('button.btn', { text: 'حفظ التفضيلات', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api.patch('/api/auth/me', { name: name.value, phone: phone.value, calendar_pref: cal.value, theme_pref: theme.value === 'auto' ? 'light' : theme.value });
          setPref('calendar', cal.value); setPref('theme', theme.value);
          toast('تم حفظ التفضيلات', 'ok'); setTimeout(() => location.reload(), 700);
        } finally { e.target.disabled = false; }
      } })
    ]),
    card('تغيير كلمة المرور', [
      field('كلمة المرور الحالية', cur), 
      el('div.grid.g2', {}, [field('كلمة المرور الجديدة', nw), field('تأكيد كلمة المرور', nw2)]),
      el('button.btn', { text: 'تغيير كلمة المرور', onclick: async (e) => {
        if (nw.value !== nw2.value) return toast('كلمتا المرور غير متطابقتين', 'warn');
        if (nw.value.length < 8) return toast('كلمة المرور يجب أن تكون ٨ أحرف فأكثر', 'warn');
        e.target.disabled = true;
        try {
          await api.post('/api/auth/change-password', { current: cur.value, next: nw.value });
          toast('تم تغيير كلمة المرور — سيُطلب منك الدخول مجدداً', 'ok');
          setTimeout(async () => { await api.logout(); location.href = '/'; }, 1600);
        } finally { e.target.disabled = false; }
      } })
    ]),
    card('الجلسات النشطة', sessionsBox, { p0: true }),
    card('الخروج من المنصة', [
      el('button.btn.danger', { icon: 'log-out', iconSize: 16, text: 'تسجيل الخروج', onclick: async () => {
        if (!await confirmDialog('سيتم إنهاء جلستك على هذا الجهاز.', { confirmText: 'خروج', danger: true })) return;
        await api.logout(); location.href = '/';
      } })
    ])
  ]);
}

/* ═══════════ تفضيلات الإشعارات ═══════════ */
async function notifTab() {
  const d = await api.get('/api/notifications/preferences');
  const devices = await api.get('/api/notifications/devices').catch(() => []);
  const st = await pushStatus();
  const prefs = { ...d.preferences };

  const toggle = (key, label, desc) => el('label.check-row', {}, [
    el('input', { type: 'checkbox', checked: prefs[key] !== false, onchange: (e) => { prefs[key] = e.target.checked; } }),
    el('div.t', {}, [label, desc ? el('small', { text: desc }) : null])
  ]);

  return el('div.stack', {}, [
    card('حالة الإشعارات على هذا الجهاز', [
      el('div.row', {}, [
        chip(st.subscribed ? 'مفعّلة' : 'غير مفعّلة', st.subscribed ? 'ok' : 'warn', st.subscribed ? 'circle-check' : 'triangle-alert'),
        chip(d.push_enabled ? 'خدمة الدفع تعمل على الخادم' : 'خدمة الدفع معطّلة', d.push_enabled ? 'info' : 'danger'),
        d.online ? chip('متصل لحظياً', 'brand') : null
      ]),
      el('div.row', { style: { marginTop: '11px' } }, [
        st.subscribed
          ? el('button.btn.ghost', { text: 'إيقاف على هذا الجهاز', onclick: async (e) => { e.target.disabled = true; await unsubscribePush(); location.reload(); } })
          : el('button.btn', { icon: 'bell', iconSize: 16, text: 'تفعيل الإشعارات', onclick: async (e) => { e.target.disabled = true; const r = await subscribePush(); if (r.ok) location.reload(); else e.target.disabled = false; } }),
        el('button.btn.ghost', { icon: 'send', iconSize: 16, text: 'إشعار تجريبي', onclick: async () => {
          const r = await api.post('/api/notifications/test', {});
          toast(r.pushed ? 'أُرسل إشعار الدفع إلى جهازك' : 'أُنشئ الإشعار داخل المنصة', 'ok');
        } })
      ])
    ]),
    card('قنوات الإشعارات', [
      ...d.channels.map(c => toggle(c.key, c.label, c.description))
    ]),
    card('أنواع الإشعارات', [
      ...d.categories.map(c => toggle(c.key, c.label)),
      el('button.btn', { style: { marginTop: '11px' }, text: 'حفظ التفضيلات', onclick: async (e) => {
        e.target.disabled = true;
        try { await api.put('/api/notifications/preferences', { preferences: prefs }); toast('تم حفظ تفضيلات الإشعارات', 'ok'); }
        finally { e.target.disabled = false; }
      } })
    ]),
    card('الأجهزة المسجّلة', table([
      { header: 'الجهاز', key: 'user_agent', render: r => (r.user_agent || '—').slice(0, 52) },
      { header: 'المنصة', key: 'platform', render: r => chip(r.platform || 'غير محدد') },
      { header: 'سُجّل', key: 'created_at', render: r => timeAgo(r.created_at) },
      { header: 'آخر استخدام', key: 'last_used_at', render: r => r.last_used_at ? timeAgo(r.last_used_at) : '—' }
    ], devices, { emptyText: 'لم تُسجَّل أجهزة لاستقبال الإشعارات بعد' }), { p0: true })
  ]);
}

/* ═══════════ التطبيق والتثبيت ═══════════ */
async function appTab() {
  const p = platform();
  const installed = isStandalone();
  return el('div.stack', {}, [
    card('تثبيت التطبيق على جهازك', [
      el('div.row', { style: { marginBottom: '12px' } }, [
        el('img', { src: '/assets/brand/monogram-primary.svg', alt: '', style: { width: '64px', height: '64px', borderRadius: '26%' } }),
        el('div', { style: { flex: 1, minWidth: '190px' } }, [
          el('h3', { text: 'منصة رقيم' }),
          el('div.hint', { text: 'تطبيق ويب تقدمي (PWA) يعمل بملء الشاشة ودون اتصال، ويستقبل الإشعارات كتطبيق أصلي.' })
        ]),
        chip(installed ? 'مثبّت' : 'غير مثبّت', installed ? 'ok' : 'warn', installed ? 'circle-check' : 'download')
      ]),
      el('div.row', {}, [
        chip(p === 'ios' ? 'iOS / iPadOS' : p === 'android' ? 'Android' : 'سطح المكتب', 'brand',
          p === 'desktop' ? 'monitor' : 'smartphone'),
        chip(navigator.onLine ? 'متصل' : 'دون اتصال', navigator.onLine ? 'ok' : 'warn'),
        chip('يعمل دون اتصال', 'info')
      ]),
      !installed ? el('button.btn.lg.gold', { style: { marginTop: '14px' }, icon: 'download', iconSize: 18, text: 'تثبيت التطبيق الآن', onclick: () => promptInstall() }) : null,
      el('div', { style: { marginTop: '16px' } }, [
        el('h4', { style: { fontSize: '13px', marginBottom: '8px' }, text: p === 'ios' ? 'خطوات التثبيت على الآيفون / الآيباد' : p === 'android' ? 'خطوات التثبيت على الأندرويد' : 'خطوات التثبيت على الحاسب' }),
        ...(p === 'ios'
          ? ['افتح المنصة في متصفح Safari', 'اضغط زر المشاركة في الشريط السفلي', 'اختر «إضافة إلى الشاشة الرئيسية»', 'اضغط «إضافة» — ستظهر أيقونة رقيم بين تطبيقاتك', 'افتح التطبيق من الأيقونة ثم فعّل الإشعارات']
          : p === 'android'
          ? ['اضغط زر التثبيت أعلاه أو افتح قائمة المتصفح (⋮)', 'اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية»', 'أكّد التثبيت', 'افتح التطبيق وفعّل الإشعارات من تبويب الإشعارات']
          : ['اضغط أيقونة التثبيت ⊕ في شريط عنوان المتصفح', 'أو من قائمة المتصفح اختر «تثبيت منصة رقيم»', 'سيُفتح التطبيق في نافذة مستقلة']
        ).map((t, i) => el('div.check-row', { style: { cursor: 'default' } }, [el('div.avatar.sm', { text: AR_NUM(i + 1) }), el('div.t', { text: t })]))
      ])
    ]),
    card('الذاكرة المؤقتة والتحديثات', [
      el('div.hint', { text: 'تحتفظ المنصة بنسخة من الشاشات والبيانات الأخيرة للعمل دون اتصال. امسح الذاكرة إن واجهت مشكلة في التحديث.' }),
      el('div.row', { style: { marginTop: '11px' } }, [
        el('button.btn.ghost', { icon: 'refresh-cw', iconSize: 16, text: 'التحقق من التحديثات', onclick: async () => {
          const reg = await navigator.serviceWorker?.getRegistration();
          await reg?.update(); toast('تم التحقق من وجود تحديثات', 'info');
        } }),
        el('button.btn.ghost', { icon: 'eraser', iconSize: 16, text: 'مسح الذاكرة المؤقتة', onclick: async () => {
          if (!await confirmDialog('سيُعاد تحميل التطبيق بعد مسح الذاكرة المؤقتة.')) return;
          const reg = await navigator.serviceWorker?.getRegistration();
          reg?.active?.postMessage({ type: 'CLEAR_CACHE' });
          if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
          toast('تم المسح — جارٍ إعادة التحميل', 'ok');
          setTimeout(() => location.reload(true), 1000);
        } })
      ])
    ])
  ]);
}

/* ═══════════ هوية الجهة (White-labeling) ═══════════ */
async function tenantTab() {
  const t = await api.get('/api/org/tenant');
  const name = input({ value: t.name });
  const nameEn = input({ value: t.name_en || '', dir: 'ltr' });
  const logo = input({ value: t.logo_url || '', dir: 'ltr', placeholder: 'https://... أو /assets/logo.png' });
  const primary = input({ type: 'color', value: t.primary_color, style: { height: '42px' } });
  const accent = input({ type: 'color', value: t.accent_color, style: { height: '42px' } });
  const cal = select([{ value: 'hijri', label: 'هجري' }, { value: 'gregorian', label: 'ميلادي' }], { value: t.calendar_default });
  const s = t.settings || {};
  const wdStart = input({ type: 'time', value: s.workday?.start || '07:30' });
  const wdEnd = input({ type: 'time', value: s.workday?.end || '13:30' });
  const late = input({ type: 'number', min: 0, max: 120, value: s.late_after_minutes ?? 15 });
  const sla = input({ type: 'number', min: 1, max: 168, value: s.ticket_sla_hours ?? 24 });
  const vat = input({ type: 'number', min: 0, max: 100, step: '0.5', value: s.vat_rate ?? 15 });

  return el('div.stack', {}, [
    card('هوية الجهة التعليمية', [
      el('div.hint', { style: { marginBottom: '12px' },
        text: 'تقرأ الواجهات هذه البيانات ديناميكياً من سجل الجهة (Tenant) — أساس التخصيص للعملاء الجدد في مرحلة SaaS.' }),
      el('div.grid.g2', {}, [field('اسم الجهة', name), field('الاسم بالإنجليزية', nameEn)]),
      field('رابط الشعار', logo, { hint: 'يظهر في القائمة الجانبية وفي رأس التقارير المطبوعة' }),
      el('div.grid.g3', {}, [field('اللون الأساسي', primary), field('اللون المميّز', accent), field('التقويم الافتراضي', cal)])
    ]),
    card('إعدادات التشغيل', [
      el('div.grid.g2', {}, [field('بداية الدوام', wdStart), field('نهاية الدوام', wdEnd)]),
      el('div.grid.g3', {}, [
        field('سماح التأخير (دقيقة)', late, { hint: 'بعدها يُسجَّل الحضور كتأخير' }),
        field('مدة الاستجابة للتذاكر (ساعة)', sla, { hint: 'بعدها تُصعّد التذكرة آلياً' }),
        field('نسبة ضريبة القيمة المضافة ٪', vat)
      ]),
      el('button.btn', { text: 'حفظ إعدادات الجهة', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api.patch('/api/org/tenant', {
            name: name.value, name_en: nameEn.value, logo_url: logo.value || null,
            primary_color: primary.value, accent_color: accent.value, calendar_default: cal.value,
            settings: { workday: { ...(s.workday || {}), start: wdStart.value, end: wdEnd.value },
              late_after_minutes: Number(late.value), ticket_sla_hours: Number(sla.value), vat_rate: Number(vat.value) }
          });
          toast('تم حفظ إعدادات الجهة', 'ok'); setTimeout(() => location.reload(), 800);
        } finally { e.target.disabled = false; }
      } })
    ]),
    can('notifications.broadcast') ? card('بث إشعار عام', [
      (() => {
        const title = input({ placeholder: 'عنوان الإشعار' });
        const body = textarea({ placeholder: 'نص الإشعار الذي سيصل جميع المنسوبين...' });
        const branch = select([{ value: '', label: 'كل منسوبي الجهة' }, ...state.session.branches.map(b => ({ value: b.id, label: b.name }))]);
        return el('div', {}, [
          field('العنوان', title, { required: true }), field('النص', body), field('الفئة المستهدفة', branch),
          el('button.btn.gold', { icon: 'megaphone', iconSize: 16, text: 'بث الإشعار', onclick: async (e) => {
            if (!title.value.trim()) return toast('عنوان الإشعار إلزامي', 'warn');
            if (!await confirmDialog('سيصل هذا الإشعار لجميع المستهدفين على أجهزتهم فوراً.', { confirmText: 'بث الآن' })) return;
            e.target.disabled = true;
            try {
              const r = await api.post('/api/notifications/broadcast', { title: title.value, body: body.value, branch_id: branch.value || null });
              toast(`وصل الإشعار إلى ${AR_NUM(r.created)} مستخدم (${AR_NUM(r.pushed)} إشعار دفع)`, 'ok');
              title.value = ''; body.value = '';
            } finally { e.target.disabled = false; }
          } })
        ]);
      })()
    ]) : null
  ]);
}

/* ═══════════ التحقّق بخطوتين ═══════════ */
async function twoFactorTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(3));
    const st = await api.get('/api/auth/2fa');

    if (st.enabled) {
      const pw = input({ type: 'password', autocomplete: 'current-password' });
      clear(body).append(
        el('div.alert.ok', { icon: 'shield-check', iconSize: 16, text: 'التحقّق بخطوتين مفعّل على حسابك' }),
        el('p.hint', { text: `رموز الاسترداد المتبقية: ${AR_NUM(st.backup_codes_left)}` }),
        st.required
          ? el('div.alert.info', { text: 'التحقّق بخطوتين إلزامي على مالكي المنصة ولا يمكن تعطيله.' })
          : card('تعطيل التحقّق', el('div.stack', {}, [
              field('أكّد كلمة مرورك', pw, { required: true }),
              el('button.btn.danger', { text: 'تعطيل التحقّق بخطوتين', onclick: async (e) => {
                if (!await confirmDialog('سيصبح حسابك محمياً بكلمة المرور وحدها.', { danger: true, confirmText: 'تعطيل' })) return;
                e.target.disabled = true;
                try { await api.post('/api/auth/2fa/disable', { password: pw.value });
                  toast('عُطّل التحقّق بخطوتين', 'ok'); await load();
                } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
              } })
            ]))
      );
      return;
    }

    clear(body).append(
      st.required
        ? el('div.alert.warn', { icon: 'triangle-alert', iconSize: 16, text: 'التحقّق بخطوتين إلزامي على مالكي المنصة — فعّله الآن.' })
        : el('div.alert.info', { text: 'طبقة حماية ثانية: رمز متغيّر كل ٣٠ ثانية من تطبيق مصادقة على جوالك.' }),
      el('button.btn.gold', { icon: 'shield-check', iconSize: 16, text: 'بدء التفعيل', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const setup = await api.post('/api/auth/2fa/setup', {});
          setupDialog(setup, load);
        } catch (err) { toast(err.message, 'warn'); }
        finally { e.target.disabled = false; }
      } })
    );
  };
  load();
  return el('div', {}, [el('h3', { text: 'التحقّق بخطوتين', style: { marginTop: 0 } }), body]);
}

function setupDialog(setup, done) {
  const token = input({ dir: 'ltr', inputmode: 'numeric', maxlength: 6, placeholder: '******',
    style: { textAlign: 'center', fontSize: '20px', letterSpacing: '6px' } });

  const m = modal({
    title: 'تفعيل التحقّق بخطوتين', size: 'lg',
    body: el('div.stack', {}, [
      el('p', { text: '١) افتح تطبيق مصادقة (Google Authenticator أو Microsoft Authenticator أو ما شابه).' }),
      el('p', { text: '٢) أضف حساباً جديداً بإدخال هذا المفتاح يدوياً:' }),
      card('المفتاح السرّي', el('div.stack', {}, [
        el('code', { text: setup.secret, style: { direction: 'ltr', fontSize: '15px', letterSpacing: '2px', wordBreak: 'break-all' } }),
        el('button.btn.sm.ghost', { icon: 'copy', iconSize: 16, text: 'نسخ المفتاح', onclick: async () => {
          try { await navigator.clipboard.writeText(setup.secret); toast('نُسخ المفتاح', 'ok'); }
          catch { toast('حدّد المفتاح وانسخه يدوياً', 'warn'); }
        } })
      ])),
      el('details', {}, [
        el('summary', { text: 'أو انسخ رابط الإعداد الكامل (otpauth)' }),
        el('code', { text: setup.uri, style: { direction: 'ltr', fontSize: '10.5px', wordBreak: 'break-all' } })
      ]),
      el('p', { text: '٣) أدخل الرمز المعروض في التطبيق لتأكيد التفعيل:' }),
      field('رمز التحقّق', token, { required: true })
    ]),
    footer: el('button.btn.gold', { text: 'تأكيد التفعيل', onclick: async (e) => {
      e.target.disabled = true;
      try {
        const r = await api.post('/api/auth/2fa/enable', { token: token.value.trim() });
        m.close();
        modal({
          title: 'فُعّل التحقّق بخطوتين', icon: 'shield-check',
          body: el('div.stack', {}, [
            el('div.alert.warn', { text: 'احفظ رموز الاسترداد التالية في مكان آمن — تُعرض مرة واحدة فقط، وكل رمز يُستخدم مرة واحدة عند فقد جوالك.' }),
            el('div.grid-2', {}, r.backup_codes.map(c =>
              el('code', { text: c, style: { direction: 'ltr', fontSize: '14px', letterSpacing: '2px', padding: '6px' } }))),
            el('button.btn.ghost', { icon: 'copy', iconSize: 16, text: 'نسخ كل الرموز', onclick: async () => {
              try { await navigator.clipboard.writeText(r.backup_codes.join('\n')); toast('نُسخت الرموز', 'ok'); }
              catch { toast('انسخها يدوياً', 'warn'); }
            } })
          ])
        });
        await done();
      } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
    } })
  });
}

/* ═══════════ النسخ الاحتياطي (البند ١٠) ═══════════ */
async function backupTab() {
  const body = el('div');

  const load = async () => {
    clear(body).append(skeleton(3));
    const data = await api.get('/api/org/backups');
    const rows = data.items || [];
    clear(body).append(
      el('div.row.wrap', { style: { gap: '10px', marginBottom: '14px' } }, [
        chip(`التخزين: ${data.driver === 'r2' ? 'Cloudflare R2' : 'قرص محلي'}`, 'ok'),
        chip(data.automatic ? 'النسخ اليومي التلقائي مفعّل' : 'النسخ التلقائي معطّل', data.automatic ? 'ok' : 'warn'),
        chip(`يُحتفظ بآخر ${AR_NUM(data.keep || 0)} نسخة`)
      ]),
      card('النسخ المحفوظة', rows.length ? table([
        { header: 'الملف', key: 'name', render: r => el('code', { text: r.name, style: { direction: 'ltr', fontSize: '11px' } }) },
        { header: 'التاريخ', key: 'created_at', render: r => (r.created_at ? fmtDateTime(r.created_at) : '—') },
        { header: '', key: 'a', render: r => el('button.btn.sm.ghost', {
            icon: 'download', iconSize: 16, text: 'تنزيل',
            onclick: () => api.downloadGet(`/api/org/backups/${encodeURIComponent(r.name)}/download`, r.name)
          }) }
      ], rows) : empty('database', 'لا توجد نسخ بعد', 'أنشئ نسخة يدوية أو انتظر النسخ التلقائي اليومي.')),
      el('p.hint', { text: 'تُخزَّن كل نسخة داخل مجلّد الجهة المعزول، وهي ملف SQL مضغوط يمكن استعادته مباشرةً على قاعدة البيانات.' })
    );
  };

  load();
  return el('div', {}, [
    el('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' } }, [
      el('h3', { icon: 'database', text: 'النسخ الاحتياطي' }),
      el('button.btn.gold', { icon: 'plus', iconSize: 16, text: 'إنشاء نسخة الآن', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const r = await api.post('/api/org/backups', {});
          toast(`تم حفظ نسخة تضم ${AR_NUM(r.rows)} سجل من ${AR_NUM(r.tables)} جدول`, 'ok');
          await load();
        } finally { e.target.disabled = false; }
      } })
    ]),
    body
  ]);
}

/* ═══════════ مفاتيح الربط (Developer Settings) ═══════════ */
async function apiTab() {
  const scopes = await api.get('/api/api-keys/scopes');
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(3));
    const keys = await api.get('/api/api-keys');
    clear(body).append(card('المفاتيح المُصدَرة', table([
      { header: 'الاسم', key: 'name' },
      { header: 'البادئة', key: 'key_prefix', render: r => el('code', { text: r.key_prefix, style: { direction: 'ltr', fontSize: '11px' } }) },
      { header: 'النطاقات', key: 'scopes', render: r => el('div.row', { style: { gap: '4px' } }, r.scopes.map(s => chip(scopes.find(x => x.key === s)?.label || s))) },
      { header: 'حد الطلبات/دقيقة', key: 'rate_limit', num: true, render: r => AR_NUM(r.rate_limit) },
      { header: 'آخر استخدام', key: 'last_used_at', render: r => r.last_used_at ? timeAgo(r.last_used_at) : 'لم يُستخدم' },
      { header: 'الحالة', key: 'revoked', render: r => chip(r.revoked ? 'مُبطَل' : 'فعّال', r.revoked ? 'danger' : 'ok') },
      { header: '', key: 'a', render: r => r.revoked ? '—' : el('button.btn.sm.ghost', { text: 'إبطال', onclick: async () => {
          if (!await confirmDialog(`سيتوقف المفتاح «${r.name}» عن العمل فوراً لدى الأنظمة المرتبطة.`, { danger: true, confirmText: 'إبطال' })) return;
          await api.del(`/api/api-keys/${r.id}`); toast('تم إبطال المفتاح', 'ok'); load();
        } }) }
    ], keys, { emptyText: 'لم تُصدر أي مفاتيح ربط بعد' }), { p0: true }));
  };
  await load();

  const base = location.origin;
  return el('div.stack', {}, [
    card(null, [el('div.row.between', {}, [
      el('div', {}, [el('h3', { text: 'إعدادات المطورين — مفاتيح الربط' }),
        el('div.hint', { text: 'أصدر مفاتيح للأنظمة الخارجية (مثل منصة الطلاب) للوصول لبيانات محددة فقط، مع حد أقصى للطلبات لحماية الخوادم.' })]),
      el('button.btn.sm', { icon: 'plus', iconSize: 16, text: 'إصدار مفتاح', onclick: () => openKey(scopes, load) })
    ])]),
    body,
    card('توثيق الواجهة البرمجية', [
      el('div.hint', { text: 'استخدم المفتاح في ترويسة الطلب:' }),
      el('div.code', { text: `curl -H "Authorization: Bearer raqeem_rq_xxx.xxxxx" \\\n  ${base}/api/v1/teachers` }),
      el('h4', { style: { fontSize: '13px', margin: '14px 0 8px' }, text: 'نقاط الاتصال المتاحة' }),
      table([
        { header: 'المسار', key: 'p', render: r => el('code', { text: r.p, style: { direction: 'ltr', fontSize: '11.5px' } }) },
        { header: 'الوصف', key: 'd' }, { header: 'النطاق المطلوب', key: 's', render: r => chip(r.s) }
      ], [
        { p: 'GET /api/v1/teachers', d: 'قائمة المعلمين النشطين', s: 'teachers.read' },
        { p: 'GET /api/v1/teachers/:id', d: 'بيانات معلم محدد وملخص حضوره', s: 'teachers.read' },
        { p: 'GET /api/v1/branches', d: 'قائمة الفروع', s: 'branches.read' },
        { p: 'GET /api/v1/terms', d: 'الفصول الدراسية والفصل الحالي', s: 'terms.read' },
        { p: 'GET /api/v1/attendance/summary', d: 'ملخص الحضور خلال فترة', s: 'attendance.read' },
        { p: 'GET /api/v1/committees', d: 'اللجان وأعضاؤها', s: 'committees.read' },
        { p: 'GET /api/v1/kpi', d: 'مؤشرات الأداء', s: 'kpi.read' }
      ])
    ])
  ]);
}

function openKey(scopes, reload) {
  const name = input({ placeholder: 'منصة الطلاب', required: true });
  const rate = input({ type: 'number', min: 10, max: 6000, value: 120 });
  const box = el('div', {}, scopes.map(s => el('label.check-row', {}, [
    el('input', { type: 'checkbox', value: s.key }), el('div.t', {}, [s.label, el('small', { text: s.key, style: { direction: 'ltr' } })])
  ])));
  const m = modal({
    title: 'إصدار مفتاح ربط جديد',
    body: el('div', {}, [
      field('اسم النظام المرتبط', name, { required: true }),
      field('حد الطلبات في الدقيقة', rate, { hint: 'حماية من الإغراق — يُرفض ما زاد برمز 429' }),
      field('نطاقات الوصول', box, { required: true })
    ]),
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'إصدار المفتاح', onclick: async (e) => {
        const chosen = [...box.querySelectorAll('input:checked')].map(i => i.value);
        if (!name.value.trim()) return toast('اسم النظام إلزامي', 'warn');
        if (!chosen.length) return toast('اختر نطاق وصول واحداً على الأقل', 'warn');
        e.target.disabled = true;
        try {
          const r = await api.post('/api/api-keys', { name: name.value, scopes: chosen, rate_limit: Number(rate.value) });
          m.close(); showKey(r); reload();
        } finally { e.target.disabled = false; }
      } })]
  });
}

function showKey(r) {
  const m = modal({
    title: 'مفتاح الربط الجديد', icon: 'key', size: 'narrow',
    body: el('div', {}, [
      el('div.archived-bar', { icon: 'triangle-alert', iconSize: 16 }, [r.warning]),
      el('div.code', { text: r.key }),
      el('button.btn.block', { style: { marginTop: '11px' }, icon: 'copy', iconSize: 16, text: 'نسخ المفتاح', onclick: async () => {
        try { await navigator.clipboard.writeText(r.key); toast('تم نسخ المفتاح', 'ok'); }
        catch { toast('انسخ المفتاح يدوياً', 'warn'); }
      } })
    ]),
    footer: [el('button.btn', { text: 'حفظته — إغلاق', onclick: () => m.close() })]
  });
}
