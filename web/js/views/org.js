import api from '../api.js';
import { state, can } from '../state.js';
import {
  el, clear, card, chip, empty, table, toast, modal, field, input, searchInput, select, tabs,
  AR_NUM, avatar, confirmDialog, skeleton, debounce, qs
} from '../util.js';
import { fmtDate } from '../hijri.js';
import { icon as luIcon } from '../icons.js';
import { openEmployeeFile } from './hr.js';

export async function render() {
  const items = [];
  if (can('users.view')) items.push({ label: 'المستخدمون', icon: 'users', build: usersTab });
  if (can('branches.view')) items.push({ label: 'الفروع', icon: 'building-2', build: branchesTab });
  if (can('roles.view')) items.push({ label: 'الأدوار والصلاحيات', icon: 'key-round', build: rolesTab });
  if (!items.length) return empty('lock', 'لا تملك صلاحية الوصول', '');
  const t = tabs(items, (it) => { const n = el('div'); Promise.resolve(it.build()).then(x => n.replaceChildren(x)); return n; });
  return t.node;
}

/* ═══════════ المستخدمون ═══════════ */
async function usersTab() {
  const [roles, branches] = await Promise.all([
    api.get('/api/org/roles').catch(() => []),
    api.get('/api/org/branches').catch(() => [])
  ]);
  const body = el('div');
  const filters = {};
  const q = searchInput({ placeholder: 'بحث بالاسم أو البريد...', style: { maxWidth: '230px' } });
  q.field.addEventListener('input', debounce((e) => { filters.q = e.target.value; load(); }, 340));
  const roleSel = select([{ value: '', label: 'كل الأدوار' }, ...roles.map(r => ({ value: r.id, label: r.name }))],
    { onchange: (e) => { filters.role_id = e.target.value; load(); } });
  const branchSel = select([{ value: '', label: 'كل الفروع' }, ...branches.map(b => ({ value: b.id, label: b.name }))],
    { onchange: (e) => { filters.branch_id = e.target.value; load(); } });

  async function load() {
    clear(body).append(skeleton(5));
    const rows = await api.get('/api/org/users' + api.qs(filters));
    clear(body).append(card(null, table([
      { header: 'المستخدم', key: 'name', render: r => el('div.row', { style: { gap: '8px', flexWrap: 'nowrap' } }, [
          avatar(r.name, 'sm'),
          el('div', {}, [el('div', { text: r.name, style: { fontSize: '12.8px', fontWeight: '600' } }),
            el('small', { text: r.email, style: { color: 'var(--text-3)', fontSize: '11px', direction: 'ltr', display: 'block' } })])]) },
      { header: 'الدور', key: 'role_name', render: r => chip(r.role_name, 'brand') },
      { header: 'الفرع', key: 'branch_name' },
      { header: 'الفروع المصرّحة', key: 'branch_ids', num: true, render: r => AR_NUM(r.branch_ids.length) },
      { header: 'الجوال', key: 'phone', render: r => el('span', { text: r.phone || '—', style: { direction: 'ltr', display: 'inline-block' } }) },
      { header: 'الحالة', key: 'status', render: r => chip(r.status === 'active' ? 'نشط' : 'موقوف', r.status === 'active' ? 'ok' : 'danger') },
      { header: 'آخر دخول', key: 'last_login_at', render: r => r.last_login_at ? fmtDate(r.last_login_at, state.calendar, 'short') : 'لم يدخل بعد' },
      { header: '', key: 'a', render: r => el('div.row', { style: { flexWrap: 'nowrap', gap: '5px' } }, [
          can('hr.employees.view') ? el('button.btn.sm.ghost', { icon: 'folder-open', iconSize: 16, title: 'الملف الشامل', 'aria-label': 'الملف الشامل', onclick: (e) => { e.stopPropagation(); openEmployeeFile(r.id); } }) : null,
          can('users.manage') ? el('button.btn.sm.ghost', { icon: 'pencil', iconSize: 16, title: 'تعديل', 'aria-label': 'تعديل', onclick: (e) => { e.stopPropagation(); openUser(r, roles, branches, load); } }) : null,
          can('users.manage') && r.status === 'active' && r.id !== state.session.user.id
            ? el('button.btn.sm.ghost', { icon: 'ban', iconSize: 16, title: 'إيقاف', 'aria-label': 'إيقاف', onclick: async (e) => {
                e.stopPropagation();
                if (!await confirmDialog(`سيتم إيقاف حساب «${r.name}» وإنهاء جلساته.`, { danger: true, confirmText: 'إيقاف' })) return;
                await api.del(`/api/org/users/${r.id}`); toast('تم إيقاف الحساب', 'ok'); load();
              } }) : null
        ]) }
    ], rows, { emptyText: 'لا يوجد مستخدمون مطابقون' }), { p0: true }));
  }
  await load();

  return el('div.stack', {}, [
    card(null, [el('div.row.between', {}, [
      el('div.row', {}, [q, roleSel, branchSel]),
      can('users.manage') ? el('button.btn.sm', { icon: 'plus', iconSize: 16, text: 'مستخدم جديد', onclick: () => openUser(null, roles, branches, load) }) : null
    ])]),
    body
  ]);
}

function openUser(u, roles, branches, reload) {
  const name = input({ value: u?.name || '', required: true });
  const email = input({ type: 'email', value: u?.email || '', dir: 'ltr', required: true });
  const phone = input({ value: u?.phone || '', dir: 'ltr' });
  const role = select(roles.map(r => ({ value: r.id, label: `${r.name} — ${r.description || ''}` })), { value: u?.role_id || '' });
  const primary = select([{ value: '', label: '— بدون فرع —' }, ...branches.map(b => ({ value: b.id, label: b.name }))], { value: u?.primary_branch_id || '' });
  const pass = input({ type: 'text', placeholder: u ? 'اتركه فارغاً لعدم التغيير' : 'كلمة مرور مبدئية (٨ أحرف فأكثر)' });
  const statusSel = select([{ value: 'active', label: 'نشط' }, { value: 'suspended', label: 'موقوف' }], { value: u?.status || 'active' });

  const allowed = new Set(u?.branch_ids || []);
  const branchBox = el('div', { style: { maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '10px', padding: '6px' } },
    branches.map(b => el('label.check-row', {}, [
      el('input', { type: 'checkbox', value: b.id, checked: allowed.has(b.id) }),
      el('div.t', {}, [b.name, el('small', { text: b.address || b.code })])
    ])));

  const m = modal({
    title: u ? 'تعديل المستخدم' : 'مستخدم جديد',
    body: el('div', {}, [
      el('div.grid.g2', {}, [field('الاسم الكامل', name, { required: true }), field('البريد الإلكتروني', email, { required: true })]),
      el('div.grid.g2', {}, [field('الجوال', phone), field('الدور', role, { required: true })]),
      el('div.grid.g2', {}, [field('الفرع الأساسي', primary), u ? field('الحالة', statusSel) : el('div')]),
      field('كلمة المرور', pass, { required: !u, hint: 'سيُطلب من المستخدم تغييرها عند أول دخول' }),
      field('الفروع المصرّح له بالاطلاع عليها', branchBox, { hint: 'جدول التقاطعات — يفلتر الخادم بياناته آلياً بناءً عليها' })
    ]),
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'حفظ', onclick: async (e) => {
        if (!name.value.trim() || !email.value.trim()) return toast('الاسم والبريد إلزاميان', 'warn');
        if (!u && pass.value.length < 8) return toast('كلمة المرور يجب أن تكون ٨ أحرف فأكثر', 'warn');
        e.target.disabled = true;
        const branch_ids = [...branchBox.querySelectorAll('input:checked')].map(i => Number(i.value));
        const payload = { name: name.value.trim(), email: email.value.trim(), phone: phone.value,
          role_id: Number(role.value), primary_branch_id: primary.value || null, branch_ids };
        if (pass.value) payload.password = pass.value;
        if (u) payload.status = statusSel.value;
        try {
          if (u) await api.patch(`/api/org/users/${u.id}`, payload);
          else await api.post('/api/org/users', payload);
          toast('تم الحفظ بنجاح', 'ok'); m.close(); reload();
        } finally { e.target.disabled = false; }
      } })]
  });
}

/* ═══════════ الفروع ═══════════ */
async function branchesTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(4));
    const rows = await api.get('/api/org/branches');
    clear(body).append(el('div.grid.g3', {}, rows.map(b => el('div.card', {}, [el('div.card-body', {}, [
      el('div.row.between', {}, [el('h4', { text: b.name }), chip(b.code, 'brand')]),
      el('div.hint', { text: b.address || '—' }),
      el('div.row', { style: { marginTop: '10px' } }, [
        chip(`${AR_NUM(b.users_count)} منسوب`, '', 'users'), chip(`${AR_NUM(b.tasks_count)} مهمة`, '', 'clipboard-list'),
        chip(`نطاق ${AR_NUM(b.geofence_radius)} م`, 'info', 'map-pin'),
        b.is_active ? null : chip('معطّل', 'danger')
      ]),
      b.manager_name ? el('div.hint', { style: { marginTop: '7px' }, text: 'مدير الفرع: ' + b.manager_name }) : null,
      b.lat ? el('div.hint', { style: { direction: 'ltr', fontSize: '11px' }, text: `${b.lat}, ${b.lng}` }) : el('div.hint', { style: { color: 'var(--warn)' }, text: 'لم تُضبط الإحداثيات — لن يعمل التحضير الجغرافي' }),
      can('branches.manage') ? el('div.row', { style: { marginTop: '10px' } }, [
        el('button.btn.sm.ghost', { icon: 'pencil', iconSize: 16, text: 'تعديل', onclick: () => openBranch(b, load) })
      ]) : null
    ])]))));
  };
  await load();
  return el('div.stack', {}, [
    card(null, [el('div.row.between', {}, [
      el('div', {}, [el('h3', { text: 'الفروع' }), el('div.hint', { text: 'حدّد إحداثيات كل فرع ونطاق التحضير المسموح به بالمتر.' })]),
      can('branches.manage') ? el('button.btn.sm', { icon: 'plus', iconSize: 16, text: 'فرع جديد', onclick: () => openBranch(null, load) }) : null
    ])]),
    body
  ]);
}

function openBranch(b, reload) {
  const code = input({ value: b?.code || '', dir: 'ltr', required: true, disabled: !!b });
  const name = input({ value: b?.name || '', required: true });
  const address = input({ value: b?.address || '' });
  const lat = input({ type: 'number', step: 'any', value: b?.lat ?? '', dir: 'ltr', placeholder: '24.8247' });
  const lng = input({ type: 'number', step: 'any', value: b?.lng ?? '', dir: 'ltr', placeholder: '46.6216' });
  const radius = input({ type: 'number', min: 20, max: 1000, value: b?.geofence_radius || 50 });
  const phone = input({ value: b?.phone || '', dir: 'ltr' });

  /* إعادة الزر إلى حاله تُعيد بناء محتواه: `textContent` وحده يمحو الأيقونة */
  const resetLocate = () => { clear(locate); locate.append(luIcon('map-pin', { size: 16 }), 'استخدام موقعي الحالي'); };
  const locate = el('button.btn.sm.ghost', { type: 'button', icon: 'map-pin', iconSize: 16, text: 'استخدام موقعي الحالي', onclick: () => {
    if (!navigator.geolocation) return toast('جهازك لا يدعم تحديد الموقع', 'warn');
    locate.disabled = true; locate.textContent = 'جارٍ التحديد...';
    navigator.geolocation.getCurrentPosition((p) => {
      lat.value = p.coords.latitude.toFixed(6); lng.value = p.coords.longitude.toFixed(6);
      locate.disabled = false; resetLocate();
      toast('تم تعبئة الإحداثيات من موقعك', 'ok');
    }, () => { locate.disabled = false; resetLocate(); toast('تعذّر تحديد الموقع', 'err'); },
    { enableHighAccuracy: true });
  } });

  const m = modal({
    title: b ? 'تعديل الفرع' : 'فرع جديد',
    body: el('div', {}, [
      el('div.grid.g2', {}, [field('رمز الفرع', code, { required: true }), field('اسم الفرع', name, { required: true })]),
      field('العنوان', address),
      el('div.grid.g2', {}, [field('خط العرض (Latitude)', lat), field('خط الطول (Longitude)', lng)]),
      locate,
      el('div.grid.g2', { style: { marginTop: '12px' } }, [
        field('نطاق التحضير (متر)', radius, { hint: 'يرفض النظام أي تحضير خارج هذا النطاق' }),
        field('الهاتف', phone)
      ])
    ]),
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'حفظ', onclick: async (e) => {
        if (!code.value || !name.value) return toast('الرمز والاسم إلزاميان', 'warn');
        e.target.disabled = true;
        const payload = { name: name.value, address: address.value, lat: lat.value ? Number(lat.value) : null,
          lng: lng.value ? Number(lng.value) : null, geofence_radius: Number(radius.value) || 50, phone: phone.value };
        try {
          if (b) await api.patch(`/api/org/branches/${b.id}`, payload);
          else await api.post('/api/org/branches', { ...payload, code: code.value });
          toast('تم الحفظ', 'ok'); m.close(); reload();
        } finally { e.target.disabled = false; }
      } })]
  });
}

/* ═══════════ الأدوار والصلاحيات ═══════════ */
async function rolesTab() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(4));
    const [roles, perms] = await Promise.all([api.get('/api/org/roles'), api.get('/api/org/permissions')]);
    clear(body).append(el('div.grid.g2', {}, roles.map(r => el('div.card', {}, [el('div.card-body', {}, [
      el('div.row.between', {}, [
        el('div', {}, [el('h4', { text: r.name }), el('div.hint', { text: r.description || '' })]),
        chip(`${AR_NUM(r.users_count)} مستخدم`, 'brand')
      ]),
      el('div.row', { style: { marginTop: '10px' } }, [
        chip(`${AR_NUM(r.permissions.length)} صلاحية`, 'info'),
        r.is_system ? chip('دور نظامي') : null,
        chip(`المستوى ${r.level}`)
      ]),
      can('roles.manage') && r.key !== 'owner'
        ? el('button.btn.sm.ghost', { style: { marginTop: '11px' }, icon: 'key-round', iconSize: 16, text: 'تعديل الصلاحيات', onclick: () => openPerms(r, perms, load) })
        : el('div.hint', { style: { marginTop: '11px' }, text: r.key === 'owner' ? 'صلاحيات كاملة غير قابلة للتعديل' : '' })
    ])]))));
  };
  await load();
  return el('div.stack', {}, [
    card(null, [el('div', {}, [el('h3', { text: 'الأدوار والصلاحيات (RBAC)' }),
      el('div.hint', { text: 'كل مستخدم يملك دوراً واحداً، والدور يحدد ما يراه في الشاشات وما يستطيع فعله — تتغير الواجهات آلياً بحسبه.' })])]),
    body
  ]);
}

function openPerms(role, perms, reload) {
  const chosen = new Set(role.permissions);
  const box = el('div');
  for (const [module, list] of Object.entries(perms.grouped)) {
    const groupBox = el('div', { style: { marginBottom: '13px' } });
    const allOn = list.every(p => chosen.has(p.key));
    groupBox.append(el('div.row.between', { style: { marginBottom: '5px' } }, [
      el('b', { text: module, style: { fontSize: '12.5px', color: 'var(--brand)' } }),
      el('button.btn.sm.ghost', { text: allOn ? 'إلغاء الكل' : 'تحديد الكل', onclick: (e) => {
        const on = !list.every(p => chosen.has(p.key));
        list.forEach(p => on ? chosen.add(p.key) : chosen.delete(p.key));
        groupBox.querySelectorAll('input').forEach(i => { i.checked = on; });
        e.target.textContent = on ? 'إلغاء الكل' : 'تحديد الكل';
      } })
    ]));
    for (const p of list) {
      groupBox.append(el('label.check-row', {}, [
        el('input', { type: 'checkbox', checked: chosen.has(p.key),
          onchange: (e) => { e.target.checked ? chosen.add(p.key) : chosen.delete(p.key); } }),
        el('div.t', {}, [p.name, el('small', { text: p.key, style: { direction: 'ltr', fontSize: '10.5px' } })])
      ]));
    }
    box.append(groupBox);
  }
  const m = modal({
    title: `صلاحيات دور: ${role.name}`, size: 'wide', body: box,
    footer: [el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }),
      el('button.btn', { text: 'حفظ الصلاحيات', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api.put(`/api/org/roles/${role.id}/permissions`, { permissions: [...chosen] });
          toast('تم تحديث الصلاحيات', 'ok'); m.close(); reload();
        } finally { e.target.disabled = false; }
      } })]
  });
}
