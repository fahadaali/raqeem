/* أدوات مشتركة لبناء الواجهة */
import { icon as luIcon } from './icons.js';

/**
 * منشئ عناصر DOM مختصر: el('div.card', {onclick}, [children]).
 *
 * الخاصية `icon` تأخذ اسم أيقونة لوسايد فتُدرَج قبل النص:
 *   el('button.btn', { icon: 'save', text: 'حفظ', onclick })
 * وهي المدخل الوحيد للأيقونات في الواجهة — لا رموز تعبيرية ولا أي حزمة أخرى
 * (دليل الهوية · البند ٦). حجمها الافتراضي ٢٠px وهو مقاس الأسطر في الدليل.
 */
export function el(spec, props = {}, children = []) {
  let str = String(spec);
  let id = '';
  const hash = str.indexOf('#');
  if (hash !== -1) {
    const m = str.slice(hash + 1).match(/^[\w-]+/);
    id = m ? m[0] : '';
    str = str.slice(0, hash) + str.slice(hash + 1 + id.length);
  }
  const [tag, ...classes] = str.split('.');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.filter(Boolean).join(' ');
  if (Array.isArray(props)) { children = props; props = {}; }
  let iconName = null, iconSize;
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'icon') { iconName = v; continue; }
    if (k === 'iconSize') { iconSize = v; continue; }
    if (k === 'class') node.className = (node.className + ' ' + v).trim();
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') node[k] = !!v;
    else node.setAttribute(k, v);
  }
  /* بعد `text` لأنه يمسح المحتوى، وقبل الأبناء ليبقى ترتيب: أيقونة ← نص */
  if (iconName) node.prepend(luIcon(iconName, iconSize ? { size: iconSize } : {}));
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
export const frag = (children) => { const f = document.createDocumentFragment(); for (const c of [].concat(children)) if (c) f.append(c instanceof Node ? c : document.createTextNode(String(c))); return f; };
export const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
/** إضافة آمنة تتجاهل القيم الفارغة (append الأصلية تحوّل null إلى نص "null") */
export const mount = (parent, ...kids) => {
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
};
export const qs = (s, r = document) => r.querySelector(s);
export const qsa = (s, r = document) => [...r.querySelectorAll(s)];

/* ── التنسيق ─────────────────────────────────────────────── */
export const AR_NUM = (n) => Number(n || 0).toLocaleString('ar-SA');
export const pct = (n) => Number(n || 0).toLocaleString('ar-SA', { maximumFractionDigits: 1 }) + '٪';
export const money = (n) => Number(n || 0).toLocaleString('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/**
 * صيغة المعدود في العربية — مفرد ومثنّى وجمعُ قلّةٍ وجمعُ كثرة.
 *
 * «٤ طلباً» و«٢ أيام» خطأ يتكرّر كلّما وُصل عددٌ بنصّ. القاعدة:
 *   ١   مفردٌ بلا عدد        «طلب ينتظر»
 *   ٢   مثنّى بلا عدد        «طلبان ينتظران»
 *   ٣–١٠ عددٌ ثم جمع        «٤ طلبات تنتظر»
 *   ١١+ عددٌ ثم مفرد منصوب  «١٥ طلباً ينتظر»
 *
 * @param {number} n العدد
 * @param {{one:string, two:string, few:string, many:string}} f الصيغ الأربع
 */
export function counted(n, f) {
  const c = Number(n) || 0;
  if (c === 1) return f.one;
  if (c === 2) return f.two;
  if (c >= 3 && c <= 10) return `${AR_NUM(c)} ${f.few}`;
  return `${AR_NUM(c)} ${f.many}`;
}

export const initials = (name) => String(name || '؟').replace(/^(المعلمة?|المهندس|الأستاذ|د\.)\s*/, '')
  .split(/[\s—-]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('');

export function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'الآن';
  if (s < 3600) return `قبل ${Math.floor(s / 60)} دقيقة`;
  if (s < 86400) return `قبل ${Math.floor(s / 3600)} ساعة`;
  if (s < 604800) return `قبل ${Math.floor(s / 86400)} يوم`;
  return new Date(iso).toLocaleDateString('ar-SA', { day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh' });
}
export const clockOf = (iso) => iso
  ? new Date(iso).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' })
  : '—';

/* ── القواميس ────────────────────────────────────────────── */
export const T = {
  taskStatus: { todo: 'لم تبدأ', in_progress: 'قيد التنفيذ', review: 'قيد المراجعة', done: 'مكتملة', blocked: 'متوقفة' },
  taskStatusChip: { todo: '', in_progress: 'info', review: 'warn', done: 'ok', blocked: 'danger' },
  priority: { low: 'منخفضة', medium: 'متوسطة', high: 'عالية', urgent: 'عاجلة' },
  priorityChip: { low: '', medium: 'info', high: 'warn', urgent: 'danger' },
  attendance: { present: 'حاضر', late: 'متأخر', absent: 'غائب', leave: 'إجازة' },
  attendanceChip: { present: 'ok', late: 'warn', absent: 'danger', leave: 'info' },
  finance: { pending: 'بانتظار الاعتماد', in_review: 'قيد الاعتماد', approved: 'معتمد', rejected: 'مرفوض', paid: 'مصروف' },
  financeChip: { pending: 'warn', in_review: 'info', approved: 'ok', rejected: 'danger', paid: 'brand' },
  financeType: { expense: 'مصروف', custody: 'عهدة', purchase: 'شراء', reimbursement: 'تعويض' },
  ticket: { open: 'مفتوحة', in_progress: 'قيد المعالجة', resolved: 'تم حلها', closed: 'مغلقة' },
  ticketChip: { open: 'warn', in_progress: 'info', resolved: 'ok', closed: '' },
  term: { open: 'مفتوح', closed: 'مغلق', archived: 'مؤرشف' },
  leave: { pending: 'بانتظار الاعتماد', approved: 'معتمدة', rejected: 'مرفوضة' },
  audit: { create: 'إنشاء', update: 'تعديل', delete: 'حذف', approve: 'اعتماد', reject: 'رفض', login: 'دخول', export: 'تصدير' },
  notifIcon: { tasks: 'clipboard-list', finance: 'banknote', hr: 'user-check', chat: 'message-circle',
    tickets: 'headset', system: 'bell', general: 'bell' }
};

/* ── التنبيهات ───────────────────────────────────────────── */
const ICONS = { ok: 'circle-check', err: 'octagon-x', warn: 'triangle-alert', info: 'info' };
export function toast(message, type = 'info', title = '') {
  const root = qs('#toasts');
  if (!root) return;
  const node = el('div.toast.' + type, {}, [
    el('span.ic', { icon: ICONS[type] || 'info' }),
    el('div.tx', {}, [title ? el('b', { text: title }) : null, el('p', { text: message })])
  ]);
  root.append(node);
  const kill = () => { node.classList.add('out'); setTimeout(() => node.remove(), 260); };
  node.addEventListener('click', kill);
  setTimeout(kill, type === 'err' ? 7000 : 4200);
}

/* ── النوافذ ─────────────────────────────────────────────── */
export function modal({ title, body, footer, size = '', icon = '', onClose, closeOnBack = true }) {
  const root = qs('#modal-root');
  const back = el('div.modal-back');
  const box = el('div.modal' + (size ? '.' + size : ''));
  const close = () => { back.remove(); document.body.style.overflow = ''; onClose?.(); };
  box.append(
    el('div.modal-head', {}, [el('h3', { icon: icon || null, text: title }), el('button.x', { icon: 'x', onclick: close, 'aria-label': 'إغلاق' })]),
    el('div.modal-body', {}, [body]),
    footer ? el('div.modal-foot', {}, footer) : null
  );
  back.append(box);
  back.addEventListener('click', (e) => { if (e.target === back && closeOnBack) close(); });
  const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
  document.addEventListener('keydown', esc);
  root.append(back);
  document.body.style.overflow = 'hidden';
  return { close, box, body: qs('.modal-body', box) };
}

export function drawer({ title, body, footer, icon = '', onClose }) {
  const root = qs('#modal-root');
  const back = el('div.drawer-back');
  const panel = el('div.drawer');
  const close = () => { back.remove(); panel.remove(); document.body.style.overflow = ''; onClose?.(); };
  panel.append(
    el('div.modal-head', {}, [el('h3', { icon: icon || null, text: title }), el('button.x', { icon: 'x', onclick: close, 'aria-label': 'إغلاق' })]),
    el('div.modal-body', {}, [body]),
    footer ? el('div.modal-foot', {}, footer) : null
  );
  back.addEventListener('click', close);
  root.append(back, panel);
  document.body.style.overflow = 'hidden';
  return { close, panel, body: qs('.modal-body', panel) };
}

export function confirmDialog(message, { title = 'تأكيد الإجراء', confirmText = 'تأكيد', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, size: 'narrow',
      body: el('p', { text: message, style: { margin: 0, lineHeight: '1.9' } }),
      footer: [
        el('button.btn.ghost', { text: 'إلغاء', onclick: () => { done = true; m.close(); resolve(false); } }),
        el('button.btn' + (danger ? '.danger' : ''), { text: confirmText, onclick: () => { done = true; m.close(); resolve(true); } })
      ],
      onClose: () => { if (!done) resolve(false); }
    });
  });
}

/* ── مكوّنات صغيرة ───────────────────────────────────────── */
export const chip = (text, kind = '', ic = '') =>
  el('span.chip' + (kind ? '.' + kind : ''), { icon: ic || null, iconSize: 14, text });
export const avatar = (name, cls = '') => el('div.avatar' + (cls ? '.' + cls : ''), { text: initials(name), title: name || '' });
export const progressBar = (pct, kind = '') => el('div.progress' + (kind ? '.' + kind : ''), {}, [
  el('span', { style: { width: Math.max(0, Math.min(100, pct || 0)) + '%' } })
]);
/** شاشة فراغ: أيقونة بمقاس البطاقة (٤٨) داخل قرص نعناعي، ثم عنوان وشرح */
export const empty = (ic, title, text, action) => el('div.empty', {}, [
  el('span.ic', { icon: ic, iconSize: 'card' }), el('h4', { text: title }),
  text ? el('p', { text }) : null, action || null
]);
export const skeleton = (n = 5) => el('div.stack', {},
  Array.from({ length: n }, (_, i) => el('div.skeleton', { style: { width: (60 + (i % 4) * 12) + '%', height: '15px' } })));

export function field(label, input, { required = false, hint = '' } = {}) {
  return el('label.field', {}, [
    el('span', {}, [label, required ? el('span.req', { text: ' *' }) : null]),
    input, hint ? el('div.hint', { text: hint }) : null
  ]);
}
export function input(props = {}) { return el('input.input', props); }
/**
 * قيمة توكن هوية من `:root` — الطريق الوحيد لأخذ لونٍ إلى جافاسكربت.
 * (منتقي الألوان مثلاً يحتاج قيمة `#rrggbb` لا `var(--…)`.)
 */
export const token = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** لوحة الهوية للاختيار اليدوي — ألوان اللجان والوسوم لا تخرج عنها */
export const PALETTE = () => [
  ['--primary', 'أخضر سنا'], ['--primary-dark', 'أخضر غامق'], ['--secondary', 'مشمشي سنا'],
  ['--info', 'أزرق معلومة'], ['--warning', 'أصفر تنبيه'], ['--error', 'طيني']
].map(([v, label]) => ({ value: token(v), label }));
/**
 * حقل بحث: أيقونة العدسة داخل الحقل في جهة البداية (RTL: يميناً).
 * يُعيد العنصر الحاوي، والحقل نفسه في `node.field` لقراءة القيمة والأحداث.
 */
export function searchInput(props = {}) {
  const fieldEl = el('input.input.has-icon', { type: 'search', ...props });
  const wrap = el('div.search-field', {}, [luIcon('search', { size: 16 }), fieldEl]);
  wrap.field = fieldEl;
  return wrap;
}
export function textarea(props = {}) { return el('textarea.input', props); }
export function select(options, props = {}) {
  const s = el('select.input', props);
  for (const o of options) {
    const opt = el('option', { value: o.value ?? '' , text: o.label });
    if (String(o.value) === String(props.value)) opt.selected = true;
    s.append(opt);
  }
  if (props.value !== undefined) s.value = props.value;
  return s;
}
export const card = (title, bodyChildren, { actions, sub, p0, icon = '' } = {}) => el('div.card', {}, [
  title ? el('div.card-head', {}, [
    el('h3', { icon: icon || null }, [title, sub ? el('span.sub', { text: sub }) : null]),
    ...(actions ? [].concat(actions) : [])
  ]) : null,
  el('div.card-body' + (p0 ? '.p0' : ''), {}, bodyChildren)
]);
export const stat = (label, value, { hint, kind = '', icon = '', onclick } = {}) =>
  el('div.stat' + (kind ? '.' + kind : '') + (onclick ? '.clickable' : ''), { onclick }, [
    el('div.label', { icon: icon || null, iconSize: 16 }, [label]),
    el('div.value', { text: value }),
    hint ? el('div.hint', { text: hint }) : null
  ]);

export function table(columns, rows, { onRow, emptyText = 'لا توجد بيانات', cls = '' } = {}) {
  if (!rows.length) return empty('inbox', emptyText, '');
  const t = el('table.tbl' + (cls ? '.' + cls : ''));
  t.append(el('thead', {}, [el('tr', {}, columns.map(c => el('th', { text: c.header, style: c.width ? { width: c.width } : {} })))]));
  const tb = el('tbody');
  rows.forEach((r, i) => {
    const tr = el('tr', onRow ? { onclick: () => onRow(r, i), style: { cursor: 'pointer' } } : {});
    for (const c of columns) {
      const v = c.render ? c.render(r, i) : r[c.key];
      tr.append(el('td' + (c.num ? '.num' : ''), v instanceof Node ? {} : { text: v ?? '—' }, v instanceof Node ? [v] : []));
    }
    tb.append(tr);
  });
  t.append(tb);
  return el('div.table-wrap', {}, [t]);
}

export function tabs(items, onChange, active = 0) {
  const bar = el('div.tabs');
  const panel = el('div');
  const render = (i) => {
    qsa('.tab', bar).forEach((b, k) => b.classList.toggle('active', k === i));
    clear(panel).append(onChange(items[i], i) || el('div'));
  };
  items.forEach((it, i) => bar.append(el('button.tab', { icon: it.icon || null, iconSize: 16, text: it.label, onclick: () => render(i) })));
  setTimeout(() => render(active), 0);
  return { node: el('div', {}, [bar, panel]), go: render };
}

export const debounce = (fn, ms = 320) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const download = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
};
