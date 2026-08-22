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
    { label: '📈 النمو', build: growthTab },
    { label: '❤️ صحة الجهات', build: healthTab },
    { label: '🏛 الجهات', build: tenantsTab },
    { label: '💠 الخطط', build: plansTab },
    { label: '🎟 الكوبونات', build: couponsTab },
    { label: '🧾 الفواتير', build: invoicesTab },
    { label: '📝 طلبات التسجيل', build: signupsTab },
    { label: '📣 الإعلانات', build: announceTab },
    { label: '🎧 صندوق الدعم', build: supportTab },
    { label: '🔒 الأمن', build: securityTab },
    { label: '⚡ التشغيل', build: opsTab },
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

  const a = d.alerts || {};
  const alerts = [
    a.critical ? { text: `${AR_NUM(a.critical)} جهة في وضع حرج — راجع تبويب صحة الجهات`, kind: 'danger' } : null,
    a.at_risk ? { text: `${AR_NUM(a.at_risk)} جهة معرّضة للتسرّب`, kind: 'warn' } : null,
    a.failing_jobs?.length ? { text: `وظائف متعثّرة: ${a.failing_jobs.join('، ')} — راجع تبويب التشغيل`, kind: 'danger' } : null,
    a.open_support ? { text: `${AR_NUM(a.open_support)} تذكرة دعم مُصعَّدة بانتظار ردّك`, kind: 'warn' } : null,
    a.upsell_opportunities ? { text: `${AR_NUM(a.upsell_opportunities)} فرصة ترقية — جهات بلغت حدود خطتها`, kind: 'info' } : null
  ].filter(Boolean);

  return el('div.stack', {}, [
    !d.platform.saas_enabled
      ? el('div.alert.info', { text: 'طبقة الـ SaaS معطّلة — المنصة تعمل حالياً بواجهات أحادية المستأجر (المرحلة الأولى). فعّلها من إعدادات المنصة لإظهار صفحة الأسعار والتسجيل الذاتي.' })
      : null,
    ...alerts.map(x => el('div.alert.' + x.kind, { text: x.text })),
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
        hint: `${AR_NUM(d.pending_signups)} طلب تسجيل · ${AR_NUM(d.pending_payments)} إشعار سداد` }),
      stat('متوسط صحة الجهات', a.average_health === null ? '—' : `${AR_NUM(a.average_health)}٪`, {
        icon: '❤️', kind: a.average_health >= 70 ? 'ok' : a.average_health >= 50 ? 'warn' : 'danger',
        hint: `${AR_NUM(a.at_risk || 0)} معرّضة للتسرّب` })
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
  const domain = input({ value: t.custom_domain || '', dir: 'ltr', placeholder: 'raqeem.example.sa' });
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
    /* صحة الجهة */
    d.health ? card('مؤشّر الصحة', el('div.stack', {}, [
      el('div.row', { style: { gap: '10px', alignItems: 'center' } }, [
        el('b', { text: AR_NUM(d.health.health.score) + '٪',
          style: { fontSize: '24px', color: `var(--${d.health.health.score >= 70 ? 'ok' : d.health.health.score >= 50 ? 'warn' : 'danger'})` } }),
        chip(d.health.health.risk_label, d.health.health.score >= 70 ? 'ok' : d.health.health.score >= 50 ? 'warn' : 'danger')
      ]),
      el('div.grid-2', {}, [
        el('div', {}, [el('span.hint', { text: 'النشاط' }), progressBar(d.health.health.parts.activity)]),
        el('div', {}, [el('span.hint', { text: 'تبنّي المستخدمين' }), progressBar(d.health.health.parts.adoption)]),
        el('div', {}, [el('span.hint', { text: 'اتساع الاستخدام' }), progressBar(d.health.health.parts.breadth)]),
        el('div', {}, [el('span.hint', { text: 'انتظام السداد' }), progressBar(d.health.health.parts.billing)])
      ]),
      d.health.health.reasons.length
        ? el('ul.plan-perks', {}, d.health.health.reasons.map(r => el('li', { text: r })))
        : el('p.hint', { text: 'لا ملاحظات — الجهة في وضع سليم.' }),
      el('p.hint', { text: `الوحدات المستخدَمة: ${d.health.health.modules_used.join('، ') || 'لا شيء'}` })
    ])) : null,

    /* حدود ومزايا خاصة */
    card('حدود ومزايا خاصة بالجهة', el('div.stack', {}, [
      el('p.hint', { text: 'تجاوزات تعلو على الخطة — للصفقات المخصّصة. اتركها فارغة لاعتماد حدود الخطة.' }),
      el('button.btn.ghost', { text: '⚙ ضبط التجاوزات', onclick: () => overridesDialog(d, async () => { m.close(); await reload(); }) })
    ])),

    /* المتابعة التجارية */
    card('المتابعة التجارية', (() => {
      const cName = input({ value: t.contact_name || '', placeholder: 'جهة الاتصال' });
      const cPhone = input({ value: t.contact_phone || '', dir: 'ltr', placeholder: '05xxxxxxxx' });
      const stage = select([
        { value: '', label: '—' }, { value: 'lead', label: 'عميل محتمل' },
        { value: 'onboarding', label: 'قيد التهيئة' }, { value: 'active', label: 'نشط' },
        { value: 'at_risk', label: 'معرّض للتسرّب' }, { value: 'churned', label: 'متسرّب' }
      ], { value: t.crm_stage || '' });
      const source = input({ value: t.crm_source || '', placeholder: 'مصدر العميل' });
      const notes = el('div');
      const noteInput = input({ placeholder: 'أضف ملاحظة…' });

      const drawNotes = (list) => clear(notes).append(list.length ? el('div.stack', {},
        list.map(n => el('div.alert.info', { style: { padding: '8px 12px' } }, [
          el('div', { text: n.body }),
          el('div.hint', { text: `${n.author_name || '—'} · ${timeAgo(n.created_at)}` })
        ]))) : el('p.hint', { text: 'لا ملاحظات بعد' }));
      drawNotes(d.notes || []);

      return el('div.stack', {}, [
        el('div.grid-2', {}, [field('جهة الاتصال', cName), field('الجوال', cPhone)]),
        el('div.grid-2', {}, [field('مرحلة العميل', stage), field('المصدر', source)]),
        el('button.btn.sm', { text: '💾 حفظ المتابعة', onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api.put(`/api/platform/tenants/${id}/crm`, {
              contact_name: cName.value.trim(), contact_phone: cPhone.value.trim(),
              crm_stage: stage.value || null, crm_source: source.value.trim() });
            toast('حُفظت بيانات المتابعة', 'ok');
          } catch (err) { toast(err.message, 'warn'); }
          finally { e.target.disabled = false; }
        } }),
        el('h4.form-sec', { text: 'الملاحظات' }),
        notes,
        el('div.row', { style: { gap: '8px' } }, [
          el('div', { style: { flex: 1 } }, [noteInput]),
          el('button.btn.sm', { text: '＋ إضافة', onclick: async () => {
            if (!noteInput.value.trim()) return;
            await api.post(`/api/platform/tenants/${id}/notes`, { body: noteInput.value.trim() });
            noteInput.value = '';
            drawNotes(await api.get(`/api/platform/tenants/${id}/notes`));
          } })
        ])
      ]);
    })()),

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
      el('button.btn.ghost', { text: '⬇ تصدير بيانات الجهة', onclick: async () => {
        try { await api.downloadGet(`/api/platform/tenants/${id}/export`, `${t.code}-export.sql.gz`);
          toast('نُزّل التصدير الكامل', 'ok'); } catch (e) { toast(e.message, 'warn'); }
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


/* ═══════════ الكوبونات والخصومات (المستوى ٤) ═══════════ */
const COUPON_DURATION = { once: 'مرة واحدة', months: 'عدة شهور', forever: 'دائم' };

async function couponsTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(4));
    const [rows, plans] = await Promise.all([
      api.get('/api/platform/coupons'),
      api.get('/api/platform/plans').catch(() => [])
    ]);
    const granted = rows.reduce((s, c) => s + Number(c.total_discount || 0), 0);
    const live = rows.filter(c => c.is_active).length;

    clear(body).append(
      el('div.stat-grid', {}, [
        stat('كوبونات مفعّلة', AR_NUM(live), { icon: '🎟' }),
        stat('مرات الاستخدام', AR_NUM(rows.reduce((s, c) => s + Number(c.uses || 0), 0)), { icon: '🔁' }),
        stat('إجمالي الخصم الممنوح', money(granted), { icon: '💸', kind: granted ? 'warn' : '' }),
        stat('جهات مستفيدة', AR_NUM(rows.reduce((s, c) => s + Number(c.tenants || 0), 0)), { icon: '🏛' })
      ]),
      table([
        { header: 'الرمز', key: 'code', render: r => el('div', {}, [
          el('b', { text: r.code, style: { direction: 'ltr' } }),
          el('div.hint', { text: r.name })]) },
        { header: 'الخصم', key: 'value', num: true,
          render: r => (r.type === 'percent' ? `${AR_NUM(r.value)}٪` : money(r.value)) },
        { header: 'المدة', key: 'duration', render: r => chip(
          r.duration === 'months' ? `${AR_NUM(r.duration_months || 0)} شهر` : COUPON_DURATION[r.duration] || r.duration) },
        { header: 'يسري على', key: 'applies_to', render: (r) => {
          const list = (() => { try { return JSON.parse(r.applies_to || '[]'); } catch { return []; } })();
          return list.length ? el('div.hint', { text: list.join('، ') }) : chip('كل الخطط', 'info');
        } },
        { header: 'الاستخدام', key: 'uses', num: true, render: r =>
          `${AR_NUM(r.uses)}${r.max_redemptions ? ` / ${AR_NUM(r.max_redemptions)}` : ''}` },
        { header: 'الخصم الممنوح', key: 'total_discount', num: true, render: r => money(r.total_discount || 0) },
        { header: 'ينتهي', key: 'valid_until', render: r => (r.valid_until ? fmtDate(r.valid_until, state.calendar) : '—') },
        { header: 'الحالة', key: 'is_active', render: r => chip(r.is_active ? 'مفعّل' : 'معطّل', r.is_active ? 'ok' : '') },
        { header: '', key: 'a', render: r => el('div.row', { style: { gap: '4px' } }, [
          el('button.btn.sm.ghost', { text: r.is_active ? 'تعطيل' : 'تفعيل', onclick: async () => {
            try {
              await api.patch(`/api/platform/coupons/${r.id}`, { is_active: !r.is_active });
              toast(r.is_active ? 'عُطّل الكوبون' : 'فُعّل الكوبون', 'ok'); await load();
            } catch (e) { toast(e.message, 'warn'); }
          } }),
          el('button.btn.sm.ghost', { text: 'تحرير', onclick: () => couponDialog(r, plans, load) }),
          !r.uses ? el('button.btn.sm.ghost', { text: '🗑', onclick: async () => {
            if (!await confirmDialog(`حذف كوبون «${r.code}»؟`, { danger: true, confirmText: 'حذف' })) return;
            try { await api.del(`/api/platform/coupons/${r.id}`); toast('حُذف الكوبون', 'ok'); await load(); }
            catch (e) { toast(e.message, 'warn'); }
          } }) : null
        ]) }
      ], rows, { emptyText: 'لا توجد كوبونات — أنشئ كوبوناً ترويجياً لتسريع التحوّل من التجربة إلى الاشتراك' })
    );
  };
  load();
  return el('div', {}, [
    el('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } }, [
      el('h3', { text: 'الكوبونات والخصومات', style: { margin: 0 } }),
      el('button.btn.gold', { text: '＋ كوبون جديد', onclick: async () =>
        couponDialog(null, await api.get('/api/platform/plans').catch(() => []), load) })
    ]),
    el('div.hint', { style: { marginBottom: '10px' },
      text: 'الخصم يُطبَّق على المبلغ قبل ضريبة القيمة المضافة، والضريبة تُحسب على الصافي.' }),
    body
  ]);
}

function couponDialog(coupon, plans, reload) {
  const existing = (() => { try { return JSON.parse(coupon?.applies_to || '[]'); } catch { return []; } })();
  const f = {
    code: input({ value: coupon?.code || '', dir: 'ltr', disabled: !!coupon, placeholder: 'RAMADAN25' }),
    name: input({ value: coupon?.name || '', placeholder: 'عرض رمضان' }),
    value: input({ type: 'number', step: '0.01', value: coupon?.value ?? 10, dir: 'ltr' }),
    duration_months: input({ type: 'number', value: coupon?.duration_months ?? 3, dir: 'ltr' }),
    max_redemptions: input({ type: 'number', value: coupon?.max_redemptions ?? '', placeholder: 'فارغ = بلا حد', dir: 'ltr' }),
    valid_until: input({ type: 'date', value: (coupon?.valid_until || '').slice(0, 10) })
  };
  const type = select([{ value: 'percent', label: 'نسبة مئوية ٪' }, { value: 'fixed', label: 'مبلغ ثابت (ر.س)' }],
    { value: coupon?.type || 'percent', disabled: !!coupon });
  const duration = select(Object.entries(COUPON_DURATION).map(([value, label]) => ({ value, label })),
    { value: coupon?.duration || 'once', disabled: !!coupon });
  const monthsField = field('عدد الشهور', f.duration_months);
  const syncMonths = () => { monthsField.hidden = duration.value !== 'months'; };
  duration.addEventListener('change', syncMonths);
  syncMonths();

  const planBoxes = plans.map(p => {
    const cb = input({ type: 'checkbox', checked: existing.includes(p.code) });
    cb.dataset.code = p.code;
    return el('label.row', { style: { gap: '6px' } }, [cb, el('span', { text: p.name })]);
  });

  const m = modal({
    title: coupon ? `تحرير كوبون «${coupon.code}»` : 'كوبون جديد', size: 'lg',
    body: el('div.stack', {}, [
      el('div.grid-2', {}, [field('الرمز (إنجليزي وأرقام)', f.code, { required: true }), field('الاسم', f.name, { required: true })]),
      el('div.grid-2', {}, [field('نوع الخصم', type), field('قيمة الخصم', f.value, { required: true })]),
      el('div.grid-2', {}, [field('مدة السريان', duration), monthsField]),
      el('div.grid-2', {}, [field('حد مرات الاستخدام', f.max_redemptions), field('تاريخ الانتهاء', f.valid_until)]),
      planBoxes.length ? card('الخطط المشمولة (بلا تحديد = كل الخطط)',
        el('div.row.wrap', { style: { gap: '14px' } }, planBoxes)) : null
    ]),
    footer: el('button.btn.gold', { text: coupon ? 'حفظ' : 'إنشاء', onclick: async (e) => {
      e.target.disabled = true;
      const applies_to = planBoxes
        .map(b => b.querySelector('input[type=checkbox]'))
        .filter(cb => cb.checked).map(cb => cb.dataset.code);
      const payload = {
        code: f.code.value.trim(), name: f.name.value.trim(),
        type: type.value, value: Number(f.value.value || 0),
        duration: duration.value,
        duration_months: duration.value === 'months' ? Number(f.duration_months.value || 1) : null,
        max_redemptions: f.max_redemptions.value === '' ? null : Number(f.max_redemptions.value),
        valid_until: f.valid_until.value || null,
        applies_to
      };
      try {
        if (coupon) await api.patch(`/api/platform/coupons/${coupon.id}`, payload);
        else await api.post('/api/platform/coupons', payload);
        toast('حُفظ الكوبون', 'ok'); m.close(); await reload();
      } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
    } })
  });
}

/* ═══════════ الإعلانات والبث (المستوى ٢) ═══════════ */
const SEV_KIND = { info: 'info', warning: 'warn', critical: 'danger' };

async function announceTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(4));
    const d = await api.get('/api/platform/announcements');
    const sevLabel = Object.fromEntries(d.severities.map(s => [s.key, s.label]));
    const audLabel = Object.fromEntries(d.audiences.map(a => [a.key, a.label]));

    clear(body).append(table([
      { header: 'الإعلان', key: 'title', render: r => el('div', {}, [
        el('b', { text: r.title }),
        r.body ? el('div.hint', { text: r.body.slice(0, 90) }) : null]) },
      { header: 'الأهمية', key: 'severity', render: r => chip(sevLabel[r.severity] || r.severity, SEV_KIND[r.severity] || '') },
      { header: 'الجمهور', key: 'audience', render: r => chip(
        r.audience_value ? `${audLabel[r.audience] || r.audience}: ${r.audience_value}` : (audLabel[r.audience] || r.audience)) },
      { header: 'الجهات', key: 'tenants_count', num: true, render: r => AR_NUM(r.tenants_count) },
      { header: 'المستقبِلون', key: 'recipients', num: true, render: r => AR_NUM(r.recipients || 0) },
      { header: 'شريط', key: 'banner', render: r => (r.banner ? chip('نعم', 'info') : '—') },
      { header: 'ينتهي', key: 'ends_at', render: r => (r.ends_at ? fmtDate(r.ends_at, state.calendar) : 'بلا انتهاء') },
      { header: 'أُرسل', key: 'sent_at', render: r => (r.sent_at ? timeAgo(r.sent_at) : chip('لم يُرسل', 'warn')) },
      { header: '', key: 'a', render: r => el('button.btn.sm.ghost', { text: '🗑', onclick: async () => {
        if (!await confirmDialog(`حذف إعلان «${r.title}»؟`, { danger: true, confirmText: 'حذف' })) return;
        try { await api.del(`/api/platform/announcements/${r.id}`); toast('حُذف الإعلان', 'ok'); await load(); }
        catch (e) { toast(e.message, 'warn'); }
      } }) }
    ], d.items, { emptyText: 'لا توجد إعلانات — ابثّ إشعاراً بالتحديثات أو أعمال الصيانة المجدولة' }));
  };
  load();
  return el('div', {}, [
    el('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } }, [
      el('h3', { text: 'الإعلانات والبثّ', style: { margin: 0 } }),
      el('button.btn.gold', { text: '＋ إعلان جديد', onclick: () => announceDialog(load) })
    ]),
    el('div.hint', { style: { marginBottom: '10px' },
      text: 'الإعلان يصل كإشعار داخل المنصة وكإشعار دفع للجوال، ويظهر شريطاً أعلى شاشة الجهات المستهدفة.' }),
    body
  ]);
}

async function announceDialog(reload) {
  const meta = await api.get('/api/platform/announcements');
  const [plans, tenants] = await Promise.all([
    api.get('/api/platform/plans').catch(() => []),
    api.get('/api/platform/tenants').catch(() => ({ items: [] }))
  ]);
  const title = input({ placeholder: 'تحديث مجدول للمنصة' });
  const bodyTxt = textarea({ rows: 4, placeholder: 'تفاصيل الإعلان كما ستصل للجهات...' });
  const url = input({ placeholder: '/billing', dir: 'ltr' });
  const severity = select(meta.severities.map(s => ({ value: s.key, label: s.label })), { value: 'info' });
  const audience = select(meta.audiences.map(a => ({ value: a.key, label: a.label })), { value: 'all' });
  const endsAt = input({ type: 'date' });
  const banner = input({ type: 'checkbox', checked: true });
  const push = input({ type: 'checkbox', checked: true });

  const valueSel = select([], {});
  const valueField = field('قيمة الجمهور', valueSel, { required: true });
  const syncValue = () => {
    const a = audience.value;
    valueField.hidden = a === 'all';
    if (a === 'plan') valueSel.replaceChildren(...plans.map(p => el('option', { value: p.code, text: p.name })));
    else if (a === 'tenant') valueSel.replaceChildren(...(tenants.items || []).map(t => el('option', { value: String(t.id), text: t.name })));
    else if (a === 'status') valueSel.replaceChildren(...['active', 'trialing', 'past_due', 'canceled']
      .map(s => el('option', { value: s, text: s })));
  };
  audience.addEventListener('change', syncValue);
  syncValue();

  const m = modal({
    title: 'بثّ إعلان جديد', size: 'lg',
    body: el('div.stack', {}, [
      field('العنوان', title, { required: true }),
      field('النص', bodyTxt),
      el('div.grid-2', {}, [field('الأهمية', severity), field('الجمهور', audience)]),
      valueField,
      el('div.grid-2', {}, [field('رابط الإجراء (اختياري)', url), field('تاريخ الانتهاء', endsAt)]),
      el('div.row.wrap', { style: { gap: '16px' } }, [
        el('label.row', { style: { gap: '6px' } }, [banner, el('span', { text: 'يظهر شريطاً أعلى الشاشة' })]),
        el('label.row', { style: { gap: '6px' } }, [push, el('span', { text: 'يُرسَل إشعار دفع للجوال' })])
      ])
    ]),
    footer: el('button.btn.gold', { text: 'بثّ الإعلان', onclick: async (e) => {
      if (!title.value.trim()) return void toast('العنوان إلزامي', 'warn');
      e.target.disabled = true;
      try {
        const out = await api.post('/api/platform/announcements', {
          title: title.value.trim(), body: bodyTxt.value.trim() || null,
          url: url.value.trim() || null, severity: severity.value,
          audience: audience.value,
          audience_value: audience.value === 'all' ? null : valueSel.value,
          banner: banner.checked, push: push.checked,
          ends_at: endsAt.value || null
        });
        toast(`بُثّ الإعلان إلى ${AR_NUM(out.tenants)} جهة (${AR_NUM(out.recipients)} مستخدم)`, 'ok');
        m.close(); await reload();
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
        { header: '', key: 'a', render: r => el('div.row', { style: { gap: '4px' } }, [
          r.status === 'open' ? el('button.btn.sm', { text: 'تسديد', onclick: async () => {
            if (!await confirmDialog(`اعتماد سداد الفاتورة ${r.number} بمبلغ ${money(r.total)}؟`, { confirmText: 'اعتماد' })) return;
            await api.post(`/api/platform/invoices/${r.id}/mark-paid`, {}); toast('اعتُمد السداد', 'ok'); await load(); } }) : null,
          r.status === 'open' ? el('button.btn.sm.ghost', { text: 'إلغاء', onclick: async () => {
            const reason = prompt('سبب الإلغاء:'); if (reason === null) return;
            await api.post(`/api/platform/invoices/${r.id}/void`, { reason }); toast('أُلغيت الفاتورة', 'ok'); await load(); } }) : null,
          /* الإشعار الدائن يصلح على المسدَّدة والمفتوحة، لا على الملغاة ولا على إشعار دائن */
          r.doc_type !== 'credit_note' && ['open', 'paid'].includes(r.status)
            ? el('button.btn.sm.ghost', { text: '↩ إشعار دائن', onclick: () => creditNoteDialog(r, load) }) : null,
          r.zatca_qr ? el('button.btn.sm.ghost', { text: '🧾', title: 'الفاتورة الإلكترونية',
            onclick: () => eInvoiceDialog(r) }) : null
        ]) }
      ], d.items) : empty('🧾', 'لا توجد فواتير', ''),
      { sub: `المحصّل ${money(d.totals.paid)} · المستحق ${money(d.totals.due)}` })
    );
  };
  load();
  return body;
}

/** إشعار دائن على فاتورة صادرة — يفرّق بين المسدَّدة وغير المسدَّدة */
function creditNoteDialog(inv, reload) {
  const amount = input({ type: 'number', step: '0.01', value: inv.total, dir: 'ltr' });
  const reason = textarea({ rows: 3, placeholder: 'سبب الإشعار الدائن — يظهر على المستند' });
  const m = modal({
    title: `إشعار دائن على ${inv.number}`,
    body: el('div.stack', {}, [
      el('div.kv', {}, [
        el('span.k', { text: 'الجهة' }), el('span.v', { text: inv.tenant_name || '—' }),
        el('span.k', { text: 'إجمالي الفاتورة' }), el('span.v', { text: money(inv.total) }),
        el('span.k', { text: 'حالتها' }), el('span.v', {}, [chip(inv.status_label, INV_KIND[inv.status])])
      ]),
      field('المبلغ (شامل الضريبة)', amount, { required: true }),
      field('السبب', reason),
      el('div.alert.' + (inv.status === 'paid' ? 'info' : 'warn'), {
        text: inv.status === 'paid'
          ? 'الفاتورة مسدَّدة: القيمة تُرحَّل رصيداً للجهة يُخصم من فاتورتها التالية.'
          : 'الفاتورة غير مسدَّدة: الإشعار يخفّض المستحق فقط، وتُلغى الفاتورة متى غُطّيت بالكامل — ولا يُمنح رصيد لم يُدفع.' })
    ]),
    footer: [
      el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn.gold', { text: 'إصدار الإشعار', onclick: async (e) => {
        const v = Number(amount.value);
        if (!(v > 0)) return void toast('أدخل مبلغاً أكبر من صفر', 'warn');
        e.target.disabled = true;
        try {
          const note = await api.post(`/api/platform/invoices/${inv.id}/credit-note`,
            { amount: v, reason: reason.value.trim() });
          toast(`صدر الإشعار الدائن ${note.number} بمبلغ ${money(note.total)}`, 'ok');
          m.close(); await reload();
        } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
      } })
    ]
  });
}

/** عرض الفاتورة الإلكترونية المختومة: الوسوم المفكوكة ورمز QR وسلسلة التجزئة */
async function eInvoiceDialog(inv) {
  let d;
  try { d = await api.get(`/api/platform/einvoice/${inv.id}`); }
  catch (e) { return void toast(e.message, 'warn'); }
  const LABELS = { 1: 'اسم البائع', 2: 'الرقم الضريبي', 3: 'تاريخ ووقت الإصدار',
    4: 'الإجمالي شامل الضريبة', 5: 'قيمة الضريبة', 6: 'تجزئة المستند', 7: 'التوقيع', 8: 'المفتاح العام' };
  modal({
    title: `الفاتورة الإلكترونية — ${d.number}`, size: 'lg',
    body: el('div.stack', {}, [
      el('div.kv', {}, Object.entries(d.fields).flatMap(([tag, v]) => [
        el('span.k', { text: LABELS[tag] || `الوسم ${tag}` }),
        el('span.v', { text: v, style: Number(tag) >= 6 ? { direction: 'ltr', fontSize: '11px', wordBreak: 'break-all' } : {} })
      ])),
      card('رمز QR (TLV بترميز Base64)',
        el('code', { text: d.qr, style: { direction: 'ltr', fontSize: '10.5px', wordBreak: 'break-all', lineHeight: '1.8' } })),
      el('div.kv', {}, [
        el('span.k', { text: 'المعرّف الفريد' }),
        el('span.v', { text: d.uuid, style: { direction: 'ltr', fontSize: '11px' } }),
        el('span.k', { text: 'تجزئة السابقة (PIH)' }),
        el('span.v', { text: d.previous_hash, style: { direction: 'ltr', fontSize: '11px', wordBreak: 'break-all' } })
      ])
    ])
  });
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
  /* قائمة البوابات من الخادم لا مكرّرة في الواجهة، فلا تتباعد النسختان */
  const gw = await api.get('/api/platform/gateways').catch(() => ({ options: [], configured: false }));

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
    bankNote: input({ value: s.bank_details?.note || '' }),
    street: input({ value: s.seller_address?.street || '' }),
    district: input({ value: s.seller_address?.district || '' }),
    city: input({ value: s.seller_address?.city || '' }),
    postal: input({ value: s.seller_address?.postal_code || '', dir: 'ltr' }),
    idleDays: input({ type: 'number', value: s.health_idle_days, dir: 'ltr' }),
    upsell: input({ type: 'number', value: s.upsell_threshold, dir: 'ltr' }),
    gwSecret: input({ type: 'password', placeholder: '••••••••', dir: 'ltr' })
  };
  const zatca = input({ type: 'checkbox', checked: !!s.zatca_enabled });
  const require2fa = input({ type: 'checkbox', checked: !!s.require_2fa_admins });
  const gateway = select(
    (gw.options.length ? gw.options : [{ key: 'manual', label: 'تحويل بنكي يدوي' }])
      .map(o => ({ value: o.key, label: o.label })),
    { value: s.payment_gateway });
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
      field('ملاحظة للعميل', f.bankNote),
      el('h4.form-sec', { text: 'بوابة الدفع' }),
      field('البوابة المفعّلة', gateway),
      el('div.row', {}, [
        chip(gw.configured ? '✅ البوابة مهيّأة بمفتاحها السرّي' : '⚠️ لم يُدخَل المفتاح السرّي بعد',
          gw.configured ? 'ok' : 'warn'),
        (gw.options.find(o => o.key === gateway.value)?.redirects)
          ? chip('السداد يتم على صفحة البوابة') : null
      ]),
      field('المفتاح السرّي للبوابة', f.gwSecret, {
        hint: 'يُحفظ مشفَّراً في قاعدة البيانات ولا يُعاد عرضه. اتركه فارغاً للإبقاء على الحالي.' })
    ])),
    card('الفاتورة الإلكترونية (ZATCA)', el('div.stack', {}, [
      el('label.row', { style: { gap: '8px' } }, [zatca,
        el('span', { text: 'ختم الفواتير برمز QR ومستند XML وسلسلة تجزئة' })]),
      el('h4.form-sec', { text: 'عنوان المنشأة (إلزامي في مستند الفاتورة)' }),
      el('div.grid-2', {}, [field('الشارع', f.street), field('الحي', f.district)]),
      el('div.grid-2', {}, [field('المدينة', f.city), field('الرمز البريدي', f.postal)]),
      el('p.hint', { text: 'يُولَّد رمز QR بالحقول الإلزامية الخمسة ومستند UBL 2.1 وسلسلة تجزئة مترابطة. الختم التشفيري يتطلّب شهادة CSID من الهيئة بعد تسجيل المنشأة.' })
    ])),
    card('الأمن', el('div.stack', {}, [
      el('label.row', { style: { gap: '8px' } }, [require2fa,
        el('span', { text: 'إلزام مالكي المنصة بالتحقّق بخطوتين' })]),
      el('p.hint', { text: 'هذه اللوحة تتجاوز عزل الجهات — الطبقة الثانية ليست ترفاً.' })
    ])),
    card('عتبات صحة الجهات', el('div.stack', {}, [
      el('div.grid-2', {}, [
        field('تُعدّ الجهة خاملة بعد (أيام)', f.idleDays),
        field('فرصة الترقية عند بلوغ (٪ من الحدّ)', f.upsell)
      ])
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
            iban: f.iban.value.trim(), note: f.bankNote.value.trim() },
          seller_address: { street: f.street.value.trim(), district: f.district.value.trim(),
            city: f.city.value.trim(), postal_code: f.postal.value.trim() },
          zatca_enabled: zatca.checked,
          require_2fa_admins: require2fa.checked,
          payment_gateway: gateway.value,
          ...(f.gwSecret.value.trim() ? { gateway_config: { secret_key: f.gwSecret.value.trim() } } : {}),
          health_idle_days: Number(f.idleDays.value),
          upsell_threshold: Number(f.upsell.value)
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

/* ═══════════ النمو والمؤشرات (المستوى ١) ═══════════ */

/** رسم خطّي بسيط بـ SVG — بلا مكتبات، ويرث ألوان السمة */
function sparkline(points, { height = 90, color = 'var(--brand)', fill = true } = {}) {
  const vals = points.map(p => Number(p) || 0);
  if (vals.length < 2) return el('div.hint', { text: 'تحتاج نقطتين على الأقل لرسم الاتجاه' });
  const max = Math.max(...vals), min = Math.min(...vals);
  const span = max - min || 1;
  const w = 100, h = 100;
  const xy = vals.map((v, i) => [(i / (vals.length - 1)) * w, h - ((v - min) / span) * (h - 8) - 4]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.style.width = '100%';
  svg.style.height = height + 'px';
  if (fill) {
    const a = document.createElementNS(svg.namespaceURI, 'path');
    a.setAttribute('d', area); a.setAttribute('fill', color); a.setAttribute('opacity', '0.12');
    svg.append(a);
  }
  const pth = document.createElementNS(svg.namespaceURI, 'path');
  pth.setAttribute('d', line);
  pth.setAttribute('fill', 'none');
  pth.setAttribute('stroke', color);
  pth.setAttribute('stroke-width', '2');
  pth.setAttribute('vector-effect', 'non-scaling-stroke');
  pth.setAttribute('stroke-linejoin', 'round');
  svg.append(pth);
  return svg;
}

const trend = (v, suffix = '') => {
  const n = Number(v || 0);
  const kind = n > 0 ? 'ok' : n < 0 ? 'danger' : '';
  return chip(`${n > 0 ? '▲' : n < 0 ? '▼' : '—'} ${AR_NUM(Math.abs(n))}${suffix}`, kind);
};

async function growthTab() {
  const body = el('div');
  const range = select([
    { value: '7', label: 'آخر ٧ أيام' }, { value: '30', label: 'آخر ٣٠ يوماً' },
    { value: '90', label: 'آخر ٩٠ يوماً' }, { value: '365', label: 'آخر سنة' }
  ], { value: '30' });

  const load = async () => {
    clear(body).append(skeleton(5));
    const d = await api.get(`/api/platform/metrics?days=${range.value}`);
    const c = d.change;
    const pts = d.points;

    clear(body).append(
      pts.length < 2
        ? el('div.alert.info', { text: 'اللقطات تُلتقط يومياً — سيظهر الاتجاه بعد يومين من التشغيل. يمكنك التقاط لقطة الآن من تبويب التشغيل.' })
        : null,
      el('div.stat-grid', {}, [
        stat('الإيراد الشهري المتكرر', `${money(d.current.mrr)}`, {
          icon: '📈', kind: c.mrr >= 0 ? 'ok' : 'danger',
          hint: `${c.mrr >= 0 ? '+' : ''}${money(c.mrr)} خلال الفترة (${AR_NUM(c.mrr_growth)}٪)` }),
        stat('الجهات', AR_NUM(d.current.tenants_total), {
          icon: '🏛', hint: `+${AR_NUM(c.new_tenants)} جديدة · −${AR_NUM(c.churned_tenants)} متسرّبة` }),
        stat('معدّل التسرّب', `${AR_NUM(c.churn_rate)}٪`, {
          icon: '📉', kind: c.churn_rate > 5 ? 'danger' : c.churn_rate > 0 ? 'warn' : 'ok',
          hint: 'خلال الفترة المختارة' }),
        stat('تحوّل التجارب', `${AR_NUM(d.trial_conversion.rate)}٪`, {
          icon: '🎯', kind: d.trial_conversion.rate >= 25 ? 'ok' : 'warn',
          hint: `${AR_NUM(d.trial_conversion.converted)} من ${AR_NUM(d.trial_conversion.started)} تجربة` }),
        stat('متوسط الإيراد لكل جهة', money(d.current.arpu), { icon: '💵' }),
        stat('تجديدات الشهر القادم', `${money(d.forecast.expected)}`, {
          icon: '🔮', hint: `${AR_NUM(d.forecast.renewals)} تجديد · معرّض للفقد ${money(d.forecast.at_risk)}` })
      ]),
      card('اتجاه الإيراد الشهري المتكرر', el('div', {}, [
        sparkline(pts.map(p => p.mrr)),
        el('div.row', { style: { justifyContent: 'space-between', marginTop: '6px' } }, [
          el('span.hint', { text: fmtDate(pts[0]?.date, state.calendar) }),
          trend(c.mrr_growth, '٪'),
          el('span.hint', { text: fmtDate(pts[pts.length - 1]?.date, state.calendar) })
        ])
      ])),
      el('div.grid.g2', {}, [
        card('عدد الجهات', sparkline(pts.map(p => p.tenants_total), { color: 'var(--gold)' })),
        card('المستخدمون', sparkline(pts.map(p => p.users_total), { color: 'var(--info)' }))
      ]),
      card('اللقطات', table([
        { header: 'التاريخ', key: 'date', render: r => fmtDate(r.date, state.calendar) },
        { header: 'الجهات', key: 'tenants_total', num: true, render: r => AR_NUM(r.tenants_total) },
        { header: 'الإيراد المتكرر', key: 'mrr', num: true, render: r => money(r.mrr) },
        { header: 'المستخدمون', key: 'users_total', num: true, render: r => AR_NUM(r.users_total) },
        { header: 'جديدة', key: 'new_tenants', num: true, render: r => AR_NUM(r.new_tenants) },
        { header: 'متسرّبة', key: 'churned_tenants', num: true, render: r => AR_NUM(r.churned_tenants) },
        { header: 'نشطة (٧ أيام)', key: 'active_tenants_7d', num: true, render: r => AR_NUM(r.active_tenants_7d) }
      ], pts.slice().reverse()))
    );
  };
  range.addEventListener('change', load);
  load();
  return el('div', {}, [
    el('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } }, [
      el('h3', { text: 'نمو المنصة', style: { margin: 0 } }),
      el('div', { style: { minWidth: '160px' } }, [range])
    ]),
    body
  ]);
}

/* ═══════════ صحة الجهات (المستوى ٢) ═══════════ */

const HEALTH_KIND = (score) => (score >= 70 ? 'ok' : score >= 50 ? 'warn' : 'danger');

async function healthTab() {
  const d = await api.get('/api/platform/health');
  const s = d.summary;

  const scoreCell = (t) => el('div', {}, [
    el('div.row', { style: { gap: '6px' } }, [
      el('b', { text: AR_NUM(t.health.score), style: { color: `var(--${HEALTH_KIND(t.health.score)})` } }),
      chip(t.health.risk_label, HEALTH_KIND(t.health.score))
    ]),
    progressBar(t.health.score, HEALTH_KIND(t.health.score))
  ]);

  const tenantRow = (t) => el('div', {}, [
    el('b', { text: t.name }),
    el('div.hint', { text: t.health.reasons.join(' · ') || 'لا ملاحظات' })
  ]);

  return el('div.stack', {}, [
    el('div.stat-grid', {}, [
      stat('متوسط الصحة', `${AR_NUM(s.average_score)}٪`, { icon: '❤️', kind: HEALTH_KIND(s.average_score) }),
      stat('سليمة', AR_NUM(s.by_risk.healthy), { icon: '✅', kind: 'ok' }),
      stat('تحت المراقبة', AR_NUM(s.by_risk.watch), { icon: '👀', kind: s.by_risk.watch ? 'warn' : '' }),
      stat('معرّضة للتسرّب', AR_NUM(s.by_risk.at_risk + s.by_risk.critical), {
        icon: '⚠️', kind: (s.by_risk.at_risk + s.by_risk.critical) ? 'danger' : 'ok' }),
      stat('فرص الترقية', AR_NUM(s.upsell_opportunities), {
        icon: '⬆️', kind: s.upsell_opportunities ? 'ok' : '',
        hint: s.upsell_value ? `قيمة شهرية ${money(s.upsell_value)}` : 'جهات بلغت حدود خطتها' })
    ]),

    d.at_risk.length ? card(`تحتاج تدخّلاً (${AR_NUM(d.at_risk.length)})`, table([
      { header: 'الجهة', key: 'name', render: tenantRow },
      { header: 'الدرجة', key: 'score', render: scoreCell },
      { header: 'آخر نشاط', key: 'la', render: t => (t.last_activity ? timeAgo(t.last_activity) : 'لا يوجد') },
      { header: 'المستخدمون النشطون', key: 'ua', render: t => `${AR_NUM(t.users_active_30d)} / ${AR_NUM(t.users)}` },
      { header: 'الخطة', key: 'plan_name', render: t => t.plan_name || '—' },
      { header: '', key: 'a', render: t => el('button.btn.sm.ghost', { text: 'إدارة', onclick: () => tenantDialog(t.id, () => {}) }) }
    ], d.at_risk)) : el('div.alert.ok', { text: '✔ لا توجد جهات معرّضة للتسرّب حالياً' }),

    d.upsells.length ? card(`فرص ترقية (${AR_NUM(d.upsells.length)})`, table([
      { header: 'الجهة', key: 'name', render: t => el('div', {}, [
        el('b', { text: t.name }), el('div.hint', { text: `${t.plan_name || '—'} · ${t.owner_email || ''}` })]) },
      { header: 'الضغط على الحدود', key: 'u', render: t => el('div.row', { style: { gap: '4px' } },
        t.upsell.resources.map(r => chip(`${r.label} ${AR_NUM(r.percent)}٪`, r.percent >= 100 ? 'danger' : 'warn'))) },
      { header: 'قيمة الاشتراك', key: 'v', render: t => (t.upsell.monthly_value ? money(t.upsell.monthly_value) : 'مجانية') },
      { header: '', key: 'a', render: t => el('button.btn.sm', { text: 'ترقية', onclick: () => tenantDialog(t.id, () => {}) }) }
    ], d.upsells)) : null,

    card('كل الجهات مرتّبة بالصحة', table([
      { header: 'الجهة', key: 'name', render: tenantRow },
      { header: 'الدرجة', key: 'score', render: scoreCell },
      { header: 'النشاط', key: 'p1', render: t => `${AR_NUM(t.health.parts.activity)}٪` },
      { header: 'التبنّي', key: 'p2', render: t => `${AR_NUM(t.health.parts.adoption)}٪` },
      { header: 'الاتساع', key: 'p3', render: t => `${AR_NUM(t.health.parts.breadth)}٪` },
      { header: 'السداد', key: 'p4', render: t => `${AR_NUM(t.health.parts.billing)}٪` },
      { header: 'الوحدات', key: 'm', render: t => el('div.hint', { text: t.health.modules_used.join('، ') || 'لا شيء' }) }
    ], d.items)),
    el('p.hint', { text: `تُحتسب «الخاملة» بعد ${AR_NUM(d.settings.idle_days)} يوماً بلا نشاط، وفرصة الترقية عند بلوغ ${AR_NUM(d.settings.upsell_threshold)}٪ من الحدّ — كلاهما قابل للضبط من إعدادات المنصة.` })
  ]);
}

/* ═══════════ صندوق الدعم الموحّد (المستوى ٢) ═══════════ */

async function supportTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(3));
    const d = await api.get('/api/platform/support');
    clear(body).append(
      el('div.row.wrap', { style: { gap: '8px', marginBottom: '12px' } }, [
        chip(`مفتوحة: ${AR_NUM(d.open)}`, d.open ? 'warn' : 'ok'),
        chip(`الإجمالي: ${AR_NUM(d.total)}`)
      ]),
      d.items.length ? table([
        { header: 'التذكرة', key: 'subject', render: r => el('div', {}, [
          el('b', { text: r.subject }),
          el('div.hint', { text: (r.body || '').slice(0, 110) })]) },
        { header: 'الجهة', key: 'tenant_name', render: r => el('div', {}, [
          el('span', { text: r.tenant_name }),
          el('div.hint', { text: `${r.plan_name || '—'} · ${r.requester_name || ''}` })]) },
        { header: 'الأولوية', key: 'priority', render: r => chip(
          ({ low: 'منخفضة', medium: 'متوسطة', high: 'عالية', urgent: 'عاجلة' })[r.priority] || r.priority,
          ({ high: 'warn', urgent: 'danger' })[r.priority] || '') },
        { header: 'الحالة لدى المنصة', key: 'vendor_status', render: r => chip(
          ({ open: 'بانتظار الرد', answered: 'أُجيبت', closed: 'مغلقة' })[r.vendor_status] || r.vendor_status,
          ({ open: 'warn', answered: 'info', closed: 'ok' })[r.vendor_status] || '') },
        { header: 'صُعّدت', key: 'vendor_escalated_at', render: r => timeAgo(r.vendor_escalated_at) },
        { header: '', key: 'a', render: r => el('button.btn.sm', {
          text: r.vendor_status === 'open' ? '✍ الرد' : 'عرض',
          onclick: () => supportDialog(r, load) }) }
      ], d.items) : empty('🎧', 'لا توجد تذاكر مُصعَّدة', 'تظهر هنا التذاكر التي يصعّدها مدراء الجهات إلى دعم المنصة.'));
  };
  load();
  return el('div', {}, [
    el('h3', { text: 'صندوق الدعم الموحّد', style: { marginTop: 0 } }),
    el('p.hint', { text: 'التذاكر تُدار داخل كل جهة، وما يُصعَّد منها إلى مزوّد المنصة يظهر هنا.' }),
    body
  ]);
}

function supportDialog(t, reload) {
  const reply = textarea({ rows: 5, value: t.vendor_reply || '', placeholder: 'اكتب ردّك لصاحب التذكرة…' });
  const close = input({ type: 'checkbox', checked: true });

  const m = modal({
    title: `تذكرة ${t.number || t.id} — ${t.tenant_name}`, size: 'lg',
    body: el('div.stack', {}, [
      el('div.kv', {}, [
        el('span.k', { text: 'الموضوع' }), el('span.v', { text: t.subject }),
        el('span.k', { text: 'مقدّمها' }), el('span.v', { text: `${t.requester_name || '—'} (${t.requester_email || ''})` }),
        el('span.k', { text: 'الخطة' }), el('span.v', { text: t.plan_name || '—' }),
        el('span.k', { text: 'صُعّدت' }), el('span.v', { text: fmtDateTime(t.vendor_escalated_at, state.calendar) })
      ]),
      card('نص التذكرة', el('p', { text: t.body || '—', style: { whiteSpace: 'pre-wrap', margin: 0 } })),
      t.vendor_reply ? el('div.alert.info', {}, [
        el('b', { text: 'ردّك السابق: ' }),
        el('span', { text: t.vendor_reply })
      ]) : null,
      field('الرد', reply, { required: true }),
      el('label.row', { style: { gap: '6px' } }, [close, el('span', { text: 'إغلاق التذكرة بعد الرد' })])
    ]),
    footer: el('button.btn.gold', { text: '📨 إرسال الرد', onclick: async (e) => {
      if (!reply.value.trim()) return void toast('نص الرد إلزامي', 'warn');
      e.target.disabled = true;
      try {
        await api.post(`/api/platform/support/${t.id}/reply`, { reply: reply.value.trim(), close: close.checked });
        toast('أُرسل الرد وأُشعر صاحب التذكرة', 'ok'); m.close(); await reload();
      } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
    } })
  });
}

/* ═══════════ الأمن (المستوى ٣) ═══════════ */

async function securityTab() {
  const body = el('div');
  const range = select([
    { value: '24', label: 'آخر ٢٤ ساعة' }, { value: '168', label: 'آخر ٧ أيام' }, { value: '720', label: 'آخر ٣٠ يوماً' }
  ], { value: '24' });

  const load = async () => {
    clear(body).append(skeleton(4));
    const [d, chain] = await Promise.all([
      api.get(`/api/platform/security?hours=${range.value}`),
      api.get('/api/platform/einvoice/chain').catch(() => null)
    ]);
    const failRate = d.total ? Math.round((d.failed / d.total) * 100) : 0;

    clear(body).append(
      el('div.stat-grid', {}, [
        stat('محاولات الدخول', AR_NUM(d.total), { icon: '🔑' }),
        stat('محاولات فاشلة', AR_NUM(d.failed), {
          icon: '🚫', kind: failRate > 30 ? 'danger' : failRate > 10 ? 'warn' : 'ok',
          hint: `${AR_NUM(failRate)}٪ من الإجمالي` }),
        stat('دخول ناجح', AR_NUM(d.succeeded), { icon: '✅', kind: 'ok' }),
        stat('عناوين مختلفة', AR_NUM(d.distinct_ips), { icon: '🌐' }),
        stat('حسابات موقوفة', AR_NUM(d.suspended_accounts), { icon: '⏸', kind: d.suspended_accounts ? 'warn' : '' })
      ]),

      chain ? el('div.alert.' + (chain.intact ? 'ok' : 'danger'), {
        text: chain.intact
          ? `✔ سلسلة تجزئة الفواتير الإلكترونية سليمة (${AR_NUM(chain.checked)} فاتورة)`
          : `✘ انقطاع في سلسلة التجزئة عند ${chain.breaks.length} فاتورة — راجع فوراً` }) : null,

      d.top_failed_accounts.length ? card('حسابات بأكثر محاولات فاشلة', table([
        { header: 'البريد', key: 'email', render: r => el('code', { text: r.email, style: { direction: 'ltr', fontSize: '11px' } }) },
        { header: 'المحاولات', key: 'attempts', num: true, render: r => el('b', {
          text: AR_NUM(r.attempts), style: { color: r.attempts >= 8 ? 'var(--danger)' : 'inherit' } }) },
        { header: 'عناوين', key: 'ips', num: true, render: r => AR_NUM(r.ips) },
        { header: 'آخر محاولة', key: 'last_at', render: r => timeAgo(r.last_at) }
      ], d.top_failed_accounts)) : null,

      d.top_failed_ips.length ? card('عناوين شبكة مشبوهة', table([
        { header: 'العنوان', key: 'ip', render: r => el('code', { text: r.ip, style: { direction: 'ltr', fontSize: '11px' } }) },
        { header: 'المحاولات', key: 'attempts', num: true, render: r => AR_NUM(r.attempts) },
        { header: 'حسابات مستهدفة', key: 'emails', num: true, render: r => el('b', {
          text: AR_NUM(r.emails), style: { color: r.emails > 3 ? 'var(--danger)' : 'inherit' } }) },
        { header: 'آخر محاولة', key: 'last_at', render: r => timeAgo(r.last_at) }
      ], d.top_failed_ips)) : null,

      card('آخر المحاولات', d.recent.length ? table([
        { header: 'الوقت', key: 'created_at', render: r => timeAgo(r.created_at) },
        { header: 'البريد', key: 'email', render: r => el('code', { text: r.email, style: { direction: 'ltr', fontSize: '11px' } }) },
        { header: 'الجهة', key: 'tenant_name', render: r => r.tenant_name || '—' },
        { header: 'النتيجة', key: 'success', render: r => chip(r.success ? 'نجح' : 'فشل', r.success ? 'ok' : 'danger') },
        { header: 'السبب', key: 'reason', render: r => r.reason || '—' },
        { header: 'العنوان', key: 'ip', render: r => el('code', { text: r.ip || '—', style: { direction: 'ltr', fontSize: '11px' } }) }
      ], d.recent) : empty('🔒', 'لا توجد محاولات مسجّلة', ''))
    );
  };
  range.addEventListener('change', load);
  load();

  return el('div', {}, [
    el('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } }, [
      el('h3', { text: 'الأمن والامتثال', style: { margin: 0 } }),
      el('div', { style: { minWidth: '160px' } }, [range])
    ]),
    body
  ]);
}

/* ═══════════ التشغيل والصيانة (المستوى ١) ═══════════ */

const JOB_AR = {
  subscriptions: 'دورة الاشتراكات والفوترة', sla: 'تصعيد تذاكر مستوى الخدمة',
  kpi: 'إعادة احتساب مؤشرات الأداء', deadlines: 'تذكير المهام المستحقة',
  backup: 'النسخ الاحتياطي اليومي', metrics: 'لقطة المؤشرات والصيانة', queue: 'تصريف طابور المعالجة'
};

async function opsTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(4));
    const [health, runs] = await Promise.all([
      api.get('/api/platform/jobs/health'),
      api.get('/api/platform/jobs/runs?limit=40')
    ]);

    clear(body).append(
      health.failing ? el('div.alert.danger', { text: `${AR_NUM(health.failing)} وظيفة فشلت في آخر تشغيل — راجع الخطأ أدناه` }) : null,
      health.stale ? el('div.alert.warn', { text: `${AR_NUM(health.stale)} وظيفة لم تعمل منذ أكثر من ٤٨ ساعة` }) : null,

      card('الوظائف الدورية', table([
        { header: 'الوظيفة', key: 'job', render: r => el('div', {}, [
          el('b', { text: JOB_AR[r.job] || r.job }),
          el('code.hint', { text: r.job, style: { direction: 'ltr', fontSize: '10.5px' } })]) },
        { header: 'آخر تشغيل', key: 'started_at', render: r => (r.started_at ? el('div', {}, [
          el('span', { text: timeAgo(r.started_at) }),
          el('div.hint', { text: fmtDateTime(r.started_at, state.calendar) })
        ]) : el('span.hint', { text: 'لم تعمل بعد' })) },
        { header: 'الحالة', key: 'status', render: r => chip(
          ({ success: 'نجحت', failed: 'فشلت', running: 'قيد التنفيذ', never: 'لم تعمل' })[r.status] || r.status,
          ({ success: 'ok', failed: 'danger', running: 'info' })[r.status] || '') },
        { header: 'المدة', key: 'duration_ms', render: r => (r.duration_ms != null ? `${AR_NUM(r.duration_ms)} ms` : '—') },
        { header: 'إخفاقات ٢٤س', key: 'failures_24h', num: true, render: r => (r.failures_24h
          ? el('b', { text: AR_NUM(r.failures_24h), style: { color: 'var(--danger)' } }) : '—') },
        { header: 'الخطأ', key: 'error', render: r => (r.error ? el('span.hint', {
          text: String(r.error).slice(0, 70), style: { color: 'var(--danger)' } }) : '—') },
        { header: '', key: 'a', render: r => el('button.btn.sm.ghost', { text: '▶ تشغيل', onclick: async (e) => {
          e.target.disabled = true;
          try {
            const out = await api.post(`/api/platform/jobs/${r.job}/run`, {});
            toast(`${out.label}: تمّت في ${AR_NUM(out.ms)} ms`, 'ok');
            await load();
          } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
        } }) }
      ], health.jobs)),

      card('سجل التشغيل', runs.length ? table([
        { header: 'الوقت', key: 'started_at', render: r => timeAgo(r.started_at) },
        { header: 'الوظيفة', key: 'job', render: r => JOB_AR[r.job] || r.job },
        { header: 'المصدر', key: 'trigger', render: r => chip(
          ({ cron: 'مؤقّت', manual: 'يدوي', system: 'النظام' })[r.trigger] || r.trigger,
          r.trigger === 'manual' ? 'info' : '') },
        { header: 'المنفّذ', key: 'actor_name', render: r => r.actor_name || '—' },
        { header: 'الحالة', key: 'status', render: r => chip(
          ({ success: 'نجحت', failed: 'فشلت', running: 'جارية' })[r.status] || r.status,
          ({ success: 'ok', failed: 'danger' })[r.status] || '') },
        { header: 'المدة', key: 'duration_ms', render: r => (r.duration_ms != null ? `${AR_NUM(r.duration_ms)} ms` : '—') },
        { header: 'النتيجة', key: 'result', render: r => el('span.hint', {
          text: r.error || (typeof r.result === 'object' ? JSON.stringify(r.result) : String(r.result || '—')).slice(0, 80),
          style: r.error ? { color: 'var(--danger)' } : {} }) }
      ], runs) : empty('⚡', 'لا سجلّ تشغيل بعد', 'شغّل وظيفة يدوياً أو انتظر مؤقّتها.'))
    );
  };
  load();

  return el('div', {}, [
    el('div.row', { style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } }, [
      el('h3', { text: 'التشغيل والصيانة', style: { margin: 0 } }),
      el('button.btn.ghost', { text: '📸 التقاط لقطة مؤشرات', onclick: async (e) => {
        e.target.disabled = true;
        try { const m = await api.post('/api/platform/metrics/snapshot', {});
          toast(`التُقطت لقطة ${m.date}`, 'ok'); } catch (err) { toast(err.message, 'warn'); }
        finally { e.target.disabled = false; }
      } })
    ]),
    el('p.hint', { text: 'كل تشغيل يُحفظ بنتيجته ومدّته وخطئه — فتُعرف حالة النظام دون تخمين.' }),
    body
  ]);
}

/* ═══════════ تجاوزات الحدود والمزايا (المستوى ٤) ═══════════ */

function overridesDialog(d, done) {
  const t = d.tenant;
  const over = t.limit_overrides || {};
  const planLimits = d.subscription?.plan_limits || {};
  const AR = { branches: 'الفروع', users: 'المستخدمون', storage_mb: 'التخزين (ميجابايت)' };

  const fields = {};
  for (const key of ['branches', 'users', 'storage_mb']) {
    fields[key] = input({
      type: 'number', dir: 'ltr',
      value: over[key] === null ? '' : (over[key] ?? ''),
      placeholder: planLimits[key] === null ? 'بلا حدود في الخطة' : `حدّ الخطة: ${planLimits[key]}`
    });
  }
  const unlimited = {};
  for (const key of ['branches', 'users', 'storage_mb']) {
    unlimited[key] = input({ type: 'checkbox', checked: key in over && over[key] === null });
  }

  const featureBoxes = (d.features || []).map(f => {
    const cb = input({ type: 'checkbox', checked: f.enabled });
    return { key: f.key, cb, node: el('label.row', { style: { gap: '6px' } }, [
      cb, el('span', { text: f.label }),
      f.in_plan ? chip('في الخطة', 'ok') : chip('خارج الخطة', 'warn')
    ]) };
  });

  const m = modal({
    title: `تجاوزات خاصة — ${t.name}`, size: 'lg',
    body: el('div.stack', {}, [
      el('div.alert.info', { text: 'التجاوزات تعلو على الخطة لهذه الجهة وحدها، ولا تغيّر الخطة ولا سعرها. تُستخدم للصفقات المخصّصة.' }),
      el('h4.form-sec', { text: 'الحدود' }),
      ...['branches', 'users', 'storage_mb'].map(key => el('div', {}, [
        field(AR[key], fields[key]),
        el('label.row', { style: { gap: '6px', marginTop: '-6px' } }, [
          unlimited[key], el('span.hint', { text: 'بلا حدود لهذه الجهة' })])
      ])),
      el('h4.form-sec', { text: 'المزايا' }),
      el('div.grid-2', {}, featureBoxes.map(f => f.node))
    ]),
    footer: el('button.btn.gold', { text: '💾 حفظ التجاوزات', onclick: async (e) => {
      e.target.disabled = true;
      const limits = {};
      for (const key of ['branches', 'users', 'storage_mb']) {
        if (unlimited[key].checked) limits[key] = null;
        else if (fields[key].value !== '') limits[key] = Number(fields[key].value);
      }
      /* لا تُرسَل إلا المزايا المختلفة عن الخطة، فلا تتجمّد الجهة على قائمة قديمة */
      const features = {};
      for (const f of featureBoxes) {
        const inPlan = (d.features.find(x => x.key === f.key) || {}).in_plan;
        if (f.cb.checked !== inPlan) features[f.key] = f.cb.checked;
      }
      try {
        const out = await api.put(`/api/platform/tenants/${t.id}/overrides`, { limits, features });
        toast('حُفظت التجاوزات', 'ok');
        m.close(); await done(out);
      } catch (err) { toast(err.message, 'warn'); e.target.disabled = false; }
    } })
  });
}
