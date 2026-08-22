import api from '../api.js';
import { state, saveTokens } from '../state.js';
import {
  el, clear, card, chip, stat, table, toast, modal, field, input, select, textarea, tabs,
  AR_NUM, money, empty, skeleton, confirmDialog, timeAgo, progressBar
} from '../util.js';
import { fmtDate, fmtDateTime } from '../hijri.js';

/**
 * لوحة تحكم مالك المنصة (SaaS Owner Console) — المرحلة الثانية.
 * الجهات · الخطط · الاشتراكات · الفواتير والمدفوعات · طلبات التسجيل ·
 * إعدادات المنصة · سجل عمليات المالك.
 */
const SUB_KIND = { active: 'ok', trialing: 'info', past_due: 'warn', canceled: '', expired: 'danger' };
const INV_KIND = { paid: 'ok', open: 'warn', void: '', uncollectible: 'danger' };
const gb = (mb) => (mb >= 1024 ? `${AR_NUM(Math.round(mb / 1024 * 10) / 10)} جيجا` : `${AR_NUM(mb)} ميجا`);

export async function render({ navigate }) {
  if (!state.session?.platform?.is_platform_admin) {
    return empty('🔒', 'هذه اللوحة مخصّصة لمالك المنصة', 'راجع إدارة المنصة إن كنت تحتاج الوصول.');
  }

  const t = tabs([
    { label: '📊 نظرة عامة', build: overviewTab },
    { label: '🏛 الجهات', build: tenantsTab },
    { label: '💠 الخطط', build: plansTab },
    { label: '🧾 الفواتير', build: invoicesTab },
    { label: '📝 طلبات التسجيل', build: signupsTab },
    { label: '⚙️ إعدادات المنصة', build: settingsTab },
    { label: '🛡️ سجل المنصة', build: logsTab }
  ], (item) => {
    const n = el('div');
    n.append(skeleton(5));
    Promise.resolve(item.build()).then(x => n.replaceChildren(x))
      .catch(e => n.replaceChildren(empty('⚠️', 'تعذّر التحميل', e.message)));
    return n;
  });
  return t.node;
}

/* ═══════════ نظرة عامة ═══════════ */
async function overviewTab() {
  const d = await api.get('/api/platform/overview');
  const cur = d.platform.currency;

  return el('div.stack', {}, [
    !d.platform.saas_enabled
      ? el('div.alert.info', { text: 'طبقة الـ SaaS معطّلة — المنصة تعمل حالياً بواجهات أحادية المستأجر (المرحلة الأولى). فعّلها من إعدادات المنصة لإظهار صفحة الأسعار والتسجيل الذاتي.' })
      : null,
    el('div.stat-grid', {}, [
      stat('الجهات المشتركة', AR_NUM(d.tenants_total), { icon: '🏛', hint: `${AR_NUM(d.tenants.active || 0)} نشطة · ${AR_NUM(d.tenants.suspended || 0)} موقوفة` }),
      stat('الإيراد الشهري المتكرر', `${money(d.mrr)} ${cur}`, { icon: '📈', kind: 'ok', hint: `سنوياً: ${money(d.arr)} ${cur}` }),
      stat('المحصّل', `${money(d.revenue_collected)} ${cur}`, { icon: '💰', kind: 'ok' }),
      stat('المستحق', `${money(d.outstanding.due)} ${cur}`, { icon: '⏳', kind: d.outstanding.due > 0 ? 'warn' : '', hint: `${AR_NUM(d.outstanding.invoices)} فاتورة` }),
      stat('المستخدمون', AR_NUM(d.users_total), { icon: '👥' }),
      stat('الفروع', AR_NUM(d.branches_total), { icon: '🏢' }),
      stat('التخزين', gb(d.storage_mb), { icon: '🗄' }),
      stat('بانتظار الإجراء', AR_NUM(d.pending_signups + d.pending_payments), {
        icon: '🔔', kind: (d.pending_signups + d.pending_payments) ? 'warn' : '',
        hint: `${AR_NUM(d.pending_signups)} طلب تسجيل · ${AR_NUM(d.pending_payments)} إشعار سداد` })
    ]),
    card('حالات الاشتراك', el('div.row.wrap', { style: { gap: '8px' } },
      Object.entries(d.subscriptions).map(([k, v]) =>
        chip(`${({ active: 'نشط', trialing: 'تجريبي', past_due: 'متأخر', canceled: 'ملغى', expired: 'منتهٍ' })[k] || k}: ${AR_NUM(v)}`,
          SUB_KIND[k] || '')))),
    card('توزيع الجهات على الخطط', table([
      { header: 'الخطة', key: 'name' },
      { header: 'عدد الجهات', key: 'tenants', num: true, render: r => AR_NUM(r.tenants) }
    ], d.per_plan)),
    card('أحدث الجهات', table([
      { header: 'الجهة', key: 'name' },
      { header: 'الرمز', key: 'code', render: r => el('code', { text: r.code, style: { direction: 'ltr' } }) },
      { header: 'الخطة', key: 'plan_name', render: r => r.plan_name || '—' },
      { header: 'الاشتراك', key: 'sub_status', render: r => (r.sub_status ? chip(({ active: 'نشط', trialing: 'تجريبي', past_due: 'متأخر', canceled: 'ملغى', expired: 'منتهٍ' })[r.sub_status] || r.sub_status, SUB_KIND[r.sub_status]) : '—') },
      { header: 'الانضمام', key: 'created_at', render: r => timeAgo(r.created_at) }
    ], d.recent_tenants))
  ]);
}

/* ═══════════ الجهات ═══════════ */
async function tenantsTab() {
  const body = el('div');
  const search = input({ placeholder: 'ابحث بالاسم أو الرمز أو البريد…' });

  const load = async () => {
    clear(body).append(skeleton(4));
    const q = search.value.trim() ? `?q=${encodeURIComponent(search.value.trim())}` : '';
    const d = await api.get(`/api/platform/tenants${q}`);
    clear(body).append(d.items.length ? table([
      { header: 'الجهة', key: 'name', render: r => el('div', {}, [
        el('b', { text: r.name }),
        el('div.hint', { text: r.owner_email || '—', style: { direction: 'ltr' } })
      ]) },
      { header: 'الرمز', key: 'code', render: r => el('code', { text: r.code, style: { direction: 'ltr' } }) },
      { header: 'الخطة', key: 'plan_name', render: r => r.plan_name || '—' },
      { header: 'الاشتراك', key: 'sub_status', render: r => (r.sub_status ? chip(r.sub_status_label, SUB_KIND[r.sub_status]) : '—') },
      { header: 'الحالة', key: 'status', render: r => chip(r.status === 'active' ? 'نشطة' : 'موقوفة', r.status === 'active' ? 'ok' : 'danger') },
      { header: 'المستخدمون', key: 'users', num: true, render: r => AR_NUM(r.users) },
      { header: 'الفروع', key: 'branches', num: true, render: r => AR_NUM(r.branches) },
      { header: 'التخزين', key: 'storage_mb', num: true, render: r => gb(r.storage_mb) },
      { header: 'المستحق', key: 'due', num: true, render: r => (r.due ? el('b', { text: money(r.due), style: { color: 'var(--warn)' } }) : '—') },
      { header: '', key: 'a', render: r => el('button.btn.sm.ghost', { text: 'إدارة', onclick: () => tenantDialog(r.id, load) }) }
    ], d.items) : empty('🏛', 'لا توجد جهات مطابقة', 'جرّب بحثاً آخر أو أنشئ جهة جديدة.'));
  };

  search.addEventListener('input', (() => { let t; return () => { clearTimeout(t); t = setTimeout(load, 320); }; })());
  load();

  return el('div', {}, [
    el('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '12px' } }, [
      el('div', { style: { flex: '1', minWidth: '180px' } }, [search]),
      el('button.btn.gold', { text: '＋ جهة جديدة', onclick: () => newTenantDialog(load) })
    ]),
    body
  ]);
}

async function tenantDialog(id, reload) {
  const d = await api.get(`/api/platform/tenants/${id}`);
  const t = d.tenant;
  const box = el('div.stack');

  const name = input({ value: t.name });
  const domain = input({ value: t.custom_domain || '', dir: 'ltr', placeholder: 'noor.example.sa' });
  const primary = input({ type: 'color', value: t.primary_color });
  const accent = input({ type: 'color', value: t.accent_color });

  const usageBlock = d.subscription?.limits ? el('div.stack', {}, [
    ['branches', 'الفروع'], ['users', 'المستخدمون'], ['storage_mb', 'التخزين']
  ].map(([k, label]) => {
    const limit = d.subscription.limits[k];
    const used = d.usage[k];
    const p = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    return el('div', {}, [
      el('div.row', { style: { justifyContent: 'space-between' } }, [
        el('span', { text: label }),
        el('span.hint', { text: `${k === 'storage_mb' ? gb(used) : AR_NUM(used)} من ${limit === null ? 'بلا حدود' : (k === 'storage_mb' ? gb(limit) : AR_NUM(limit))}` })
      ]),
      progressBar(p, p >= 100 ? 'danger' : p >= 80 ? 'warn' : 'ok')
    ]);
  })) : el('p.hint', { text: 'بلا حدود' });

  box.append(
    el('div.row.wrap', { style: { gap: '8px' } }, [
      chip(t.status === 'active' ? 'نشطة' : `موقوفة — ${t.suspend_reason || ''}`, t.status === 'active' ? 'ok' : 'danger'),
      d.subscription ? chip(`${d.subscription.plan?.name} · ${d.subscription.status_label}`, SUB_KIND[d.subscription.status]) : chip('بلا اشتراك'),
      chip(`الرصيد المستحق: ${money(d.balance.due)}`, d.balance.due ? 'warn' : ''),
      d.last_activity ? chip(`آخر نشاط ${timeAgo(d.last_activity)}`) : null
    ]),
    d.owner ? el('div.kv', {}, [
      el('span.k', { text: 'مدير الجهة' }), el('span.v', { text: d.owner.name }),
      el('span.k', { text: 'البريد' }), el('span.v', { text: d.owner.email, style: { direction: 'ltr', textAlign: 'right' } }),
      el('span.k', { text: 'آخر دخول' }), el('span.v', { text: d.owner.last_login_at ? timeAgo(d.owner.last_login_at) : 'لم يدخل بعد' })
    ]) : null,
    card('الاستهلاك', usageBlock),
    card('الهوية والنطاق', el('div.stack', {}, [
      field('اسم الجهة', name),
      field('النطاق المخصّص', domain, { hint: 'وجّه النطاق إلى المنصة ثم أدخله هنا ليظهر بهوية الجهة' }),
      el('div.grid-2', {}, [field('اللون الأساسي', primary), field('اللون المساعد', accent)]),
      el('button.btn', { text: '💾 حفظ', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api.patch(`/api/platform/tenants/${id}`, {
            name: name.value.trim(), custom_domain: domain.value.trim() || null,
            primary_color: primary.value, accent_color: accent.value
          });
          toast('حُفظت بيانات الجهة', 'ok'); m.close(); await reload();
        } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
      } })
    ])),
    card('الاشتراك', el('div.stack', {}, [
      el('button.btn.ghost', { text: '⭑ تغيير الخطة', onclick: () => changePlanDialog(id, d, async () => { m.close(); await reload(); }) }),
      el('button.btn.ghost', { text: '🧾 إصدار فاتورة', onclick: async () => {
        try { const inv = await api.post('/api/platform/invoices', { tenant_id: id });
          toast(`صدرت الفاتورة ${inv.number}`, 'ok'); m.close(); await reload();
        } catch (err) { toast(err.message, 'warn'); }
      } })
    ])),
    card('فواتير الجهة', d.invoices.length ? table([
      { header: 'الرقم', key: 'number', render: r => el('code', { text: r.number, style: { direction: 'ltr', fontSize: '11px' } }) },
      { header: 'الإجمالي', key: 'total', num: true, render: r => money(r.total) },
      { header: 'الحالة', key: 'status', render: r => chip(r.status_label, INV_KIND[r.status]) },
      { header: 'التاريخ', key: 'issued_at', render: r => fmtDate(r.issued_at, state.calendar) }
    ], d.invoices) : empty('🧾', 'لا فواتير', '')),
    card('إجراءات إدارية', el('div.row.wrap', { style: { gap: '8px' } }, [
      el('button.btn.ghost', { text: '🔑 دخول إداري للمساندة', onclick: async () => {
        if (!await confirmDialog('ستدخل بحساب مدير هذه الجهة للمساندة الفنية، وسيُسجَّل ذلك في سجلّي المنصة والجهة.',
          { confirmText: 'دخول إداري' })) return;
        try {
          const r = await api.post(`/api/platform/tenants/${id}/impersonate`, {});
          /* جلسة مساندة قصيرة بلا رمز تجديد — تنتهي بانتهاء الرمز */
          saveTokens(r.accessToken, null);
          toast(`دخول إداري إلى ${r.tenant.name}`, 'ok');
          location.href = '/';
        } catch (err) { toast(err.message, 'warn'); }
      } }),
      t.status === 'active'
        ? el('button.btn.ghost', { text: '⏸ إيقاف الجهة', onclick: async () => {
            const reason = prompt('سبب الإيقاف:', 'عدم سداد الاشتراك');
            if (reason === null) return;
            try { await api.patch(`/api/platform/tenants/${id}`, { status: 'suspended', suspend_reason: reason });
              toast('أُوقفت الجهة', 'ok'); m.close(); await reload();
            } catch (err) { toast(err.message, 'warn'); }
          } })
        : el('button.btn', { text: '▶ إعادة التفعيل', onclick: async () => {
            await api.patch(`/api/platform/tenants/${id}`, { status: 'active' });
            toast('أُعيد تفعيل الجهة', 'ok'); m.close(); await reload();
          } }),
      el('button.btn.danger', { text: '🗑 محو الجهة نهائياً', onclick: async () => {
        if (!await confirmDialog(
          `سيُمحى كل ما يخص «${t.name}»: المستخدمون والفروع والمهام والفواتير والملفات وسجل التدقيق. لا يمكن التراجع.`,
          { confirmText: 'فهمت، تابع', danger: true })) return;
        const typed = prompt(`للتأكيد اكتب رمز الجهة: ${t.code}`);
        if (typed !== t.code) return void toast('لم يتطابق الرمز — أُلغيت العملية', 'warn');
        try {
          const r = await api.del(`/api/platform/tenants/${id}?confirm=${encodeURIComponent(t.code)}`);
          toast(`مُحيت الجهة (${AR_NUM(r.purged.users)} مستخدم، ${AR_NUM(r.purged.audit_logs)} سجل)`, 'ok');
          m.close(); await reload();
        } catch (err) { toast(err.message, 'warn'); }
      } })
    ]))
  );

  const m = modal({ title: `إدارة الجهة — ${t.name}`, size: 'lg', body: box });
  return m;
}

async function changePlanDialog(tenantId, detail, done) {
  const plans = await api.get('/api/platform/plans');
  const planSel = select(plans.map(p => ({ value: p.code, label: p.name })), { value: detail.subscription?.plan?.code });
  const cycleSel = select([{ value: 'monthly', label: 'شهري' }, { value: 'yearly', label: 'سنوي' }],
    { value: detail.subscription?.cycle || 'monthly' });
  const statusSel = select([
    { value: 'active', label: 'نشط مباشرةً' },
    { value: 'trialing', label: 'فترة تجريبية' }
  ], { value: 'active' });
  const trialDays = input({ type: 'number', value: 14, min: 0 });

  const m = modal({
    title: 'تغيير خطة الجهة',
    body: el('div.stack', {}, [
      field('الخطة', planSel), field('الدورة', cycleSel),
      field('الحالة', statusSel), field('أيام التجربة (عند اختيار فترة تجريبية)', trialDays),
      el('p.hint', { text: 'التغيير من لوحة المالك لا يصدر فاتورة تلقائياً — أصدرها يدوياً عند الحاجة.' })
    ]),
    footer: el('button.btn.gold', { text: 'تطبيق', onclick: async (e) => {
      e.target.disabled = true;
      try {
        await api.post(`/api/platform/tenants/${tenantId}/plan`, {
          plan_code: planSel.value, cycle: cycleSel.value, status: statusSel.value,
          trial_days: Number(trialDays.value)
        });
        toast('حُدّثت خطة الجهة', 'ok'); m.close(); await done();
      } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
    } })
  });
}

function newTenantDialog(reload) {
  const code = input({ dir: 'ltr', placeholder: 'RQ2', style: { textTransform: 'uppercase' } });
  const name = input({ placeholder: 'مجمّع … لتحفيظ القرآن' });
  const adminName = input({ placeholder: 'اسم المدير' });
  const email = input({ type: 'email', dir: 'ltr' });
  const password = input({ type: 'password', placeholder: 'اتركه فارغاً لتوليد كلمة مرور' });
  const planSel = el('select.input');
  api.get('/api/platform/plans').then(plans => {
    planSel.replaceChildren(el('option', { value: '', text: 'بلا اشتراك' }),
      ...plans.map(p => el('option', { value: p.code, text: p.name })));
  });

  const m = modal({
    title: 'إنشاء جهة تعليمية جديدة',
    body: el('div.stack', {}, [
      field('رمز الجهة', code, { required: true }),
      field('اسم الجهة', name, { required: true }),
      field('اسم مدير الجهة', adminName, { required: true }),
      field('بريد المدير', email, { required: true }),
      field('كلمة المرور', password),
      field('الخطة', planSel)
    ]),
    footer: el('button.btn.gold', { text: 'إنشاء', onclick: async (e) => {
      e.target.disabled = true;
      try {
        const r = await api.post('/api/platform/tenants', {
          code: code.value.trim(), name: name.value.trim(), admin_name: adminName.value.trim(),
          email: email.value.trim(), password: password.value || undefined,
          plan_code: planSel.value || null
        });
        m.close();
        if (r.temporary_password) {
          modal({ title: 'أُنشئت الجهة', body: el('div.stack', {}, [
            el('p', { text: `الجهة «${r.tenant.name}» جاهزة. سلّم المدير بيانات الدخول التالية (تُعرض مرة واحدة):` }),
            el('div.kv', {}, [
              el('span.k', { text: 'البريد' }), el('span.v', { text: r.owner.email, style: { direction: 'ltr', textAlign: 'right' } }),
              el('span.k', { text: 'كلمة المرور' }), el('span.v', {}, [el('code', { text: r.temporary_password, style: { direction: 'ltr' } })])
            ])
          ]) });
        } else toast('أُنشئت الجهة بنجاح', 'ok');
        await reload();
      } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
    } })
  });
}

/* ═══════════ الخطط ═══════════ */
async function plansTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(4));
    const plans = await api.get('/api/platform/plans');
    clear(body).append(table([
      { header: 'الخطة', key: 'name', render: r => el('div', {}, [
        el('b', { text: r.name }), el('div.hint', { text: r.code, style: { direction: 'ltr' } })]) },
      { header: 'شهري', key: 'price_monthly', num: true, render: r => (r.price_monthly ? money(r.price_monthly) : 'مجاناً') },
      { header: 'سنوي', key: 'price_yearly', num: true, render: r => (r.price_yearly ? money(r.price_yearly) : '—') },
      { header: 'الحدود', key: 'lim', render: r => el('div.hint', { text:
        `${r.max_branches === null ? '∞' : AR_NUM(r.max_branches)} فرع · ${r.max_users === null ? '∞' : AR_NUM(r.max_users)} مستخدم · ${r.max_storage_mb === null ? '∞' : gb(r.max_storage_mb)}` }) },
      { header: 'المشتركون', key: 'subscribers', num: true, render: r => AR_NUM(r.subscribers) },
      { header: 'الحالة', key: 'st', render: r => el('div.row', { style: { gap: '4px' } }, [
        chip(r.is_active ? 'مفعّلة' : 'معطّلة', r.is_active ? 'ok' : ''),
        r.is_public ? chip('معروضة') : chip('مخفية', 'warn'),
        r.highlight ? chip('مميّزة', 'info') : null]) },
      { header: '', key: 'a', render: r => el('div.row', { style: { gap: '4px' } }, [
        el('button.btn.sm.ghost', { text: 'تحرير', onclick: () => planDialog(r, load) }),
        !r.subscribers ? el('button.btn.sm.ghost', { text: '🗑', onclick: async () => {
          if (!await confirmDialog(`حذف خطة «${r.name}»؟`, { danger: true, confirmText: 'حذف' })) return;
          try { await api.del(`/api/platform/plans/${r.id}`); toast('حُذفت الخطة', 'ok'); await load(); }
          catch (e) { toast(e.message, 'warn'); }
        } }) : null
      ]) }
    ], plans));
  };
  load();
  return el('div', {}, [
    el('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } }, [
      el('h3', { text: 'خطط الأسعار', style: { margin: 0 } }),
      el('button.btn.gold', { text: '＋ خطة جديدة', onclick: () => planDialog(null, load) })
    ]),
    body
  ]);
}

function planDialog(plan, reload) {
  const f = {
    code: input({ value: plan?.code || '', dir: 'ltr', disabled: !!plan }),
    name: input({ value: plan?.name || '' }),
    tagline: input({ value: plan?.tagline || '' }),
    price_monthly: input({ type: 'number', step: '0.01', value: plan?.price_monthly ?? 0, dir: 'ltr' }),
    price_yearly: input({ type: 'number', step: '0.01', value: plan?.price_yearly ?? 0, dir: 'ltr' }),
    trial_days: input({ type: 'number', value: plan?.trial_days ?? 14, dir: 'ltr' }),
    max_branches: input({ type: 'number', value: plan?.max_branches ?? '', placeholder: 'فارغ = بلا حدود', dir: 'ltr' }),
    max_users: input({ type: 'number', value: plan?.max_users ?? '', placeholder: 'فارغ = بلا حدود', dir: 'ltr' }),
    max_storage_mb: input({ type: 'number', value: plan?.max_storage_mb ?? '', placeholder: 'فارغ = بلا حدود', dir: 'ltr' }),
    perks: textarea({ rows: 5, value: (plan?.perks || []).join('\n'), placeholder: 'ميزة في كل سطر' })
  };
  const isPublic = input({ type: 'checkbox', checked: plan ? !!plan.is_public : true });
  const isActive = input({ type: 'checkbox', checked: plan ? !!plan.is_active : true });
  const highlight = input({ type: 'checkbox', checked: !!plan?.highlight });

  const m = modal({
    title: plan ? `تحرير خطة «${plan.name}»` : 'خطة جديدة', size: 'lg',
    body: el('div.stack', {}, [
      el('div.grid-2', {}, [field('الرمز (إنجليزي)', f.code, { required: true }), field('الاسم', f.name, { required: true })]),
      field('العبارة التسويقية', f.tagline),
      el('div.grid-2', {}, [field('السعر الشهري', f.price_monthly), field('السعر السنوي', f.price_yearly)]),
      field('أيام التجربة المجانية', f.trial_days),
      el('div.grid-2', {}, [field('حد الفروع', f.max_branches), field('حد المستخدمين', f.max_users)]),
      field('حد التخزين (ميجابايت)', f.max_storage_mb),
      field('المزايا المعروضة', f.perks),
      el('div.row.wrap', { style: { gap: '16px' } }, [
        el('label.row', { style: { gap: '6px' } }, [isPublic, el('span', { text: 'تُعرض في صفحة الأسعار' })]),
        el('label.row', { style: { gap: '6px' } }, [isActive, el('span', { text: 'مفعّلة' })]),
        el('label.row', { style: { gap: '6px' } }, [highlight, el('span', { text: 'الأكثر اختياراً' })])
      ])
    ]),
    footer: el('button.btn.gold', { text: plan ? 'حفظ' : 'إنشاء', onclick: async (e) => {
      e.target.disabled = true;
      const payload = {
        code: f.code.value.trim(), name: f.name.value.trim(), tagline: f.tagline.value.trim() || null,
        price_monthly: Number(f.price_monthly.value || 0), price_yearly: Number(f.price_yearly.value || 0),
        trial_days: Number(f.trial_days.value || 0),
        max_branches: f.max_branches.value === '' ? null : Number(f.max_branches.value),
        max_users: f.max_users.value === '' ? null : Number(f.max_users.value),
        max_storage_mb: f.max_storage_mb.value === '' ? null : Number(f.max_storage_mb.value),
        perks: f.perks.value.split('\n').map(s => s.trim()).filter(Boolean),
        is_public: isPublic.checked, is_active: isActive.checked, highlight: highlight.checked
      };
      try {
        if (plan) await api.patch(`/api/platform/plans/${plan.id}`, payload);
        else await api.post('/api/platform/plans', payload);
        toast('حُفظت الخطة', 'ok'); m.close(); await reload();
      } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
    } })
  });
}

/* ═══════════ الفواتير والمدفوعات ═══════════ */
async function invoicesTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(4));
    const [d, payments] = await Promise.all([
      api.get('/api/platform/invoices'),
      api.get('/api/platform/payments?status=pending')
    ]);
    clear(body).append(
      payments.length ? card(`إشعارات سداد بانتظار الاعتماد (${AR_NUM(payments.length)})`, table([
        { header: 'الجهة', key: 'tenant_name' },
        { header: 'الفاتورة', key: 'invoice_number', render: r => el('code', { text: r.invoice_number, style: { direction: 'ltr', fontSize: '11px' } }) },
        { header: 'المبلغ', key: 'amount', num: true, render: r => money(r.amount) },
        { header: 'المرجع', key: 'reference', render: r => r.reference || '—' },
        { header: 'أبلغ به', key: 'declared_by_name', render: r => `${r.declared_by_name || '—'} · ${timeAgo(r.created_at)}` },
        { header: '', key: 'a', render: r => el('div.row', { style: { gap: '4px' } }, [
          el('button.btn.sm', { text: '✔ اعتماد', onclick: async () => {
            try { await api.post(`/api/platform/payments/${r.id}/confirm`, {}); toast('اعتُمد السداد', 'ok'); await load(); }
            catch (e) { toast(e.message, 'warn'); } } }),
          el('button.btn.sm.ghost', { text: '✕ رفض', onclick: async () => {
            const reason = prompt('سبب الرفض:'); if (reason === null) return;
            await api.post(`/api/platform/payments/${r.id}/reject`, { reason }); toast('رُفض الإشعار', 'ok'); await load(); } })
        ]) }
      ], payments)) : null,

      card('كل الفواتير', d.items.length ? table([
        { header: 'الرقم', key: 'number', render: r => el('code', { text: r.number, style: { direction: 'ltr', fontSize: '11px' } }) },
        { header: 'الجهة', key: 'tenant_name' },
        { header: 'الخطة', key: 'plan_name' },
        { header: 'الإجمالي', key: 'total', num: true, render: r => money(r.total) },
        { header: 'الحالة', key: 'status', render: r => chip(r.status_label, INV_KIND[r.status]) },
        { header: 'التاريخ', key: 'issued_at', render: r => fmtDate(r.issued_at, state.calendar) },
        { header: '', key: 'a', render: r => (r.status === 'open' ? el('div.row', { style: { gap: '4px' } }, [
          el('button.btn.sm', { text: 'تسديد', onclick: async () => {
            if (!await confirmDialog(`اعتماد سداد الفاتورة ${r.number} بمبلغ ${money(r.total)}؟`, { confirmText: 'اعتماد' })) return;
            await api.post(`/api/platform/invoices/${r.id}/mark-paid`, {}); toast('اعتُمد السداد', 'ok'); await load(); } }),
          el('button.btn.sm.ghost', { text: 'إلغاء', onclick: async () => {
            const reason = prompt('سبب الإلغاء:'); if (reason === null) return;
            await api.post(`/api/platform/invoices/${r.id}/void`, { reason }); toast('أُلغيت الفاتورة', 'ok'); await load(); } })
        ]) : '—') }
      ], d.items) : empty('🧾', 'لا توجد فواتير', ''),
      { sub: `المحصّل ${money(d.totals.paid)} · المستحق ${money(d.totals.due)}` })
    );
  };
  load();
  return body;
}

/* ═══════════ طلبات التسجيل ═══════════ */
async function signupsTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(3));
    const rows = await api.get('/api/platform/signups');
    clear(body).append(rows.length ? table([
      { header: 'الجهة المطلوبة', key: 'tenant_name', render: r => el('div', {}, [
        el('b', { text: r.tenant_name }), el('div.hint', { text: r.code, style: { direction: 'ltr' } })]) },
      { header: 'المدير', key: 'admin_name', render: r => el('div', {}, [
        el('span', { text: r.admin_name }), el('div.hint', { text: r.email, style: { direction: 'ltr' } })]) },
      { header: 'الخطة', key: 'plan_code' },
      { header: 'الحالة', key: 'status', render: r => chip(
        ({ pending: 'بانتظار المراجعة', verified: 'جاهز للتفعيل', provisioned: 'مفعّل', rejected: 'مرفوض' })[r.status] || r.status,
        ({ provisioned: 'ok', rejected: 'danger', pending: 'warn', verified: 'info' })[r.status] || '') },
      { header: 'التاريخ', key: 'created_at', render: r => timeAgo(r.created_at) },
      { header: '', key: 'a', render: r => (['pending', 'verified'].includes(r.status) ? el('div.row', { style: { gap: '4px' } }, [
        el('button.btn.sm', { text: '✔ تفعيل', onclick: async () => {
          try { await api.post(`/api/platform/signups/${r.id}/approve`, {}); toast('فُعّلت الجهة', 'ok'); await load(); }
          catch (e) { toast(e.message, 'warn'); } } }),
        el('button.btn.sm.ghost', { text: '✕ رفض', onclick: async () => {
          const reason = prompt('سبب الرفض:'); if (reason === null) return;
          await api.post(`/api/platform/signups/${r.id}/reject`, { reason }); toast('رُفض الطلب', 'ok'); await load(); } })
      ]) : '—') }
    ], rows) : empty('📝', 'لا توجد طلبات تسجيل', 'ستظهر هنا طلبات الجهات الجديدة عند فتح التسجيل الذاتي.'));
  };
  load();
  return body;
}

/* ═══════════ إعدادات المنصة ═══════════ */
async function settingsTab() {
  const s = await api.get('/api/platform/settings');
  const plans = await api.get('/api/platform/plans');

  const f = {
    platform_name: input({ value: s.platform_name }),
    tagline: input({ value: s.tagline || '' }),
    support_email: input({ value: s.support_email || '', dir: 'ltr' }),
    support_phone: input({ value: s.support_phone || '', dir: 'ltr' }),
    trial_days: input({ type: 'number', value: s.trial_days, dir: 'ltr' }),
    grace_days: input({ type: 'number', value: s.grace_days, dir: 'ltr' }),
    vat_rate: input({ type: 'number', step: '0.01', value: s.vat_rate, dir: 'ltr' }),
    currency: input({ value: s.currency, dir: 'ltr' }),
    vat_number: input({ value: s.vat_number || '', dir: 'ltr' }),
    cr_number: input({ value: s.cr_number || '', dir: 'ltr' }),
    invoice_prefix: input({ value: s.invoice_prefix, dir: 'ltr' }),
    bank: input({ value: s.bank_details?.bank || '' }),
    beneficiary: input({ value: s.bank_details?.beneficiary || '' }),
    iban: input({ value: s.bank_details?.iban || '', dir: 'ltr' }),
    bankNote: input({ value: s.bank_details?.note || '' })
  };
  const defaultPlan = select(plans.map(p => ({ value: p.code, label: p.name })), { value: s.default_plan_code });
  const saas = input({ type: 'checkbox', checked: !!s.saas_enabled });
  const signup = input({ type: 'checkbox', checked: !!s.signup_enabled });
  const review = input({ type: 'checkbox', checked: !!s.signup_needs_review });

  const admins = el('div');
  const loadAdmins = async () => {
    const rows = await api.get('/api/platform/admins');
    clear(admins).append(table([
      { header: 'المالك', key: 'name' },
      { header: 'البريد', key: 'email', render: r => el('code', { text: r.email, style: { direction: 'ltr', fontSize: '11px' } }) },
      { header: 'الجهة', key: 'tenant_name' },
      { header: 'آخر دخول', key: 'last_login_at', render: r => (r.last_login_at ? timeAgo(r.last_login_at) : '—') },
      { header: '', key: 'a', render: r => (r.id === state.session.user.id ? chip('أنت', 'ok')
        : el('button.btn.sm.ghost', { text: 'سحب الصلاحية', onclick: async () => {
            if (!await confirmDialog(`سحب صلاحية مالك المنصة من «${r.name}»؟`, { danger: true, confirmText: 'سحب' })) return;
            try { await api.del(`/api/platform/admins/${r.id}`); toast('سُحبت الصلاحية', 'ok'); await loadAdmins(); }
            catch (e) { toast(e.message, 'warn'); } } })) }
    ], rows));
  };
  loadAdmins();
  const newAdminEmail = input({ type: 'email', dir: 'ltr', placeholder: 'بريد مستخدم قائم' });

  return el('div.stack', {}, [
    card('هوية المنصة', el('div.stack', {}, [
      field('اسم المنصة', f.platform_name),
      field('العبارة التعريفية', f.tagline),
      el('div.grid-2', {}, [field('بريد الدعم', f.support_email), field('هاتف الدعم', f.support_phone)])
    ])),
    card('طبقة الـ SaaS', el('div.stack', {}, [
      el('label.row', { style: { gap: '8px' } }, [saas, el('span', { text: 'تفعيل طبقة الـ SaaS (إظهار صفحة الأسعار وهوية المنصة)' })]),
      el('label.row', { style: { gap: '8px' } }, [signup, el('span', { text: 'فتح التسجيل الذاتي للجهات الجديدة' })]),
      el('label.row', { style: { gap: '8px' } }, [review, el('span', { text: 'مراجعة يدوية لكل طلب تسجيل قبل التفعيل' })]),
      el('div.grid-2', {}, [field('الخطة الافتراضية', defaultPlan), field('أيام التجربة', f.trial_days)]),
      field('مهلة السداد بعد الاستحقاق (أيام)', f.grace_days),
      el('p.hint', { text: 'إبقاء الطبقة معطّلة يُشغّل المنصة بواجهات أحادية المستأجر كما في المرحلة الأولى.' })
    ])),
    card('الفوترة', el('div.stack', {}, [
      el('div.grid-2', {}, [field('نسبة ضريبة القيمة المضافة (٪)', f.vat_rate), field('العملة', f.currency)]),
      el('div.grid-2', {}, [field('الرقم الضريبي', f.vat_number), field('السجل التجاري', f.cr_number)]),
      field('بادئة أرقام الفواتير', f.invoice_prefix),
      el('h4.form-sec', { text: 'بيانات التحويل البنكي' }),
      el('div.grid-2', {}, [field('البنك', f.bank), field('المستفيد', f.beneficiary)]),
      field('الآيبان', f.iban),
      field('ملاحظة للعميل', f.bankNote)
    ])),
    el('button.btn.gold.block', { text: '💾 حفظ إعدادات المنصة', onclick: async (e) => {
      e.target.disabled = true;
      try {
        await api.put('/api/platform/settings', {
          platform_name: f.platform_name.value.trim(), tagline: f.tagline.value.trim(),
          support_email: f.support_email.value.trim(), support_phone: f.support_phone.value.trim(),
          saas_enabled: saas.checked, signup_enabled: signup.checked, signup_needs_review: review.checked,
          default_plan_code: defaultPlan.value,
          trial_days: Number(f.trial_days.value), grace_days: Number(f.grace_days.value),
          vat_rate: Number(f.vat_rate.value), currency: f.currency.value.trim(),
          vat_number: f.vat_number.value.trim() || null, cr_number: f.cr_number.value.trim() || null,
          invoice_prefix: f.invoice_prefix.value.trim(),
          bank_details: { bank: f.bank.value.trim(), beneficiary: f.beneficiary.value.trim(),
            iban: f.iban.value.trim(), note: f.bankNote.value.trim() }
        });
        toast('حُفظت إعدادات المنصة', 'ok');
      } catch (err) { toast(err.message, 'warn'); }
      finally { e.target.disabled = false; }
    } }),
    card('مالكو المنصة', el('div.stack', {}, [
      admins,
      el('div.row', { style: { gap: '8px' } }, [
        el('div', { style: { flex: 1 } }, [newAdminEmail]),
        el('button.btn', { text: '＋ منح الصلاحية', onclick: async () => {
          if (!newAdminEmail.value.trim()) return;
          try { await api.post('/api/platform/admins', { email: newAdminEmail.value.trim() });
            toast('مُنحت الصلاحية', 'ok'); newAdminEmail.value = ''; await loadAdmins();
          } catch (e) { toast(e.message, 'warn'); } } })
      ]),
      el('p.hint', { text: 'مالك المنصة يرى كل الجهات ويتجاوز عزل البيانات — امنح الصلاحية بحذر شديد.' })
    ]))
  ]);
}

/* ═══════════ سجل المنصة ═══════════ */
async function logsTab() {
  const body = el('div');
  const search = input({ placeholder: 'ابحث في السجل…' });
  const load = async () => {
    clear(body).append(skeleton(4));
    const q = search.value.trim() ? `?q=${encodeURIComponent(search.value.trim())}` : '';
    const d = await api.get(`/api/platform/logs${q}`);
    clear(body).append(d.items.length ? table([
      { header: 'الوقت', key: 'created_at', render: r => el('div', {}, [
        el('span', { text: fmtDateTime(r.created_at, state.calendar) }),
        el('div.hint', { text: timeAgo(r.created_at) })]) },
      { header: 'المنفّذ', key: 'actor_name', render: r => r.actor_name || 'النظام' },
      { header: 'الإجراء', key: 'action', render: r => chip(
        ({ create: 'إنشاء', update: 'تعديل', delete: 'حذف', suspend: 'إيقاف', resume: 'تفعيل',
           approve: 'اعتماد', reject: 'رفض', impersonate: 'دخول إداري' })[r.action] || r.action,
        ({ delete: 'danger', suspend: 'warn', impersonate: 'warn', approve: 'ok' })[r.action] || '') },
      { header: 'الوصف', key: 'summary' }
    ], d.items) : empty('🛡️', 'السجل فارغ', 'تظهر هنا كل عمليات مالك المنصة.'));
  };
  search.addEventListener('input', (() => { let t; return () => { clearTimeout(t); t = setTimeout(load, 320); }; })());
  load();
  return el('div', {}, [
    el('div.row', { style: { marginBottom: '12px' } }, [el('div', { style: { flex: 1 } }, [search])]),
    el('p.hint', { text: 'هذا السجل مقفل ضد التعديل والحذف على مستوى قاعدة البيانات — كسجل تدقيق الجهات تماماً.' }),
    body
  ]);
}
