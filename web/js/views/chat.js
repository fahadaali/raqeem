import api from '../api.js';
import { state } from '../state.js';
import {
  el, clear, mount, chip, empty, toast, modal, field, input, textarea, searchInput, picker,
  avatar, timeAgo, clockOf, AR_NUM, counted, confirmDialog, skeleton, debounce, qs
} from '../util.js';

/**
 * شاشة المحادثات — صندوقٌ مستقلٌّ لا مربَّعٌ مُعلَّقٌ بمهمّةٍ أو طلب.
 *
 * وفيها نوعان: خاصّةٌ بين اثنين، ومجموعةٌ لها اسمٌ ووصفٌ وصورة. وتظهر معها
 * المحادثات السياقية (مهمّة، طلب مالي، تذكرة، لجنة) للقراءة والردّ في مكانٍ
 * واحد — فمن يبحث عن كلمةٍ قيلت له لا يدور على الشاشات ليجدها.
 *
 * ومن يُضاف محكومٌ بالصلاحية المتدرّجة التي يُنفذها الخادم: مديرُ المجمّع يضمّ
 * الجميع، ومديرُ الفرع من يعمل في فروعه ولو عمل في غيرها، ومديرُ اللجنة أعضاءَ
 * لجانه. والمنتقي لا يعرض إلا من يُقبل ضمُّه — فلا يُعرض اسمٌ يُردّ اختياره.
 */

const KIND_LABEL = { direct: 'خاصة', group: 'مجموعة', context: 'مرتبطة بالعمل' };
const FILTERS = [
  { key: 'all', label: 'الكل', icon: 'inbox' },
  { key: 'direct', label: 'الخاصة', icon: 'user-round' },
  { key: 'group', label: 'المجموعات', icon: 'users-round' },
  { key: 'context', label: 'مرتبطة بالعمل', icon: 'clipboard-list' }
];

/* ═════════ الملفّات المحمية ═════════ */
/*
 * `/api/files/:id` يطلب ترويسة مصادقة، و`<img src>` و`<audio src>` لا تحملها.
 * فتُجلَب المرفقات عبر عميل الواجهة ثم تُعرض من رابط كائنٍ محليّ. والروابط
 * تُحرَّر عند مغادرة الشاشة، وإلا تراكمت نسخُ الصوت والصور في الذاكرة.
 */
const blobs = new Map();
async function fileURL(id) {
  const key = Number(id);
  if (blobs.has(key)) return blobs.get(key);
  const p = api.get(`/api/files/${key}`, { raw: true, silent: true })
    .then(({ blob }) => URL.createObjectURL(blob))
    .catch(() => null);
  blobs.set(key, p);
  return p;
}
function releaseBlobs() {
  for (const p of blobs.values()) Promise.resolve(p).then(u => u && URL.revokeObjectURL(u)).catch(() => {});
  blobs.clear();
}
const fileIdOf = (url) => Number(String(url || '').match(/\/api\/files\/(\d+)/)?.[1] || 0);

/**
 * صورةُ عرضٍ تُستبدل بالأحرف الأولى ريثما تصل.
 * وإن تعذّر تحميلها — ملفٌّ تالفٌ أو مُزال — رجعت الأحرفُ مكانها، فلا تبقى
 * أيقونةُ صورةٍ مكسورة في صدر المحادثة.
 */
function avatarNode(name, url, cls = '') {
  const node = avatar(name, cls);
  const id = fileIdOf(url);
  if (!id) return node;
  const initials = node.textContent;
  fileURL(id).then(u => {
    if (!u || !node.isConnected) return;
    const img = el('img', { src: u, alt: '', class: 'av-img',
      onerror: () => { clear(node).append(document.createTextNode(initials)); } });
    clear(node).append(img);
  });
  return node;
}

const isImage = (a) => String(a?.mime || '').startsWith('image/');
const sizeText = (n) => (n >= 1048576
  ? `${(n / 1048576).toLocaleString('ar-SA', { maximumFractionDigits: 1 })} م.ب`
  : `${Math.max(1, Math.round(n / 1024)).toLocaleString('ar-SA')} ك.ب`);

/* ═════════ الشاشة ═════════ */
export async function render({ route, navigate }) {
  releaseBlobs();
  const S = {
    list: [], activeId: Number(route?.query?.id) || null,
    detail: null, messages: [], filter: 'all', query: ''
  };

  const listBox = el('div.chat-list-body');
  const threadBox = el('div.chat-thread');
  const page = el('div.chat-page');

  /* ── عمود المحادثات ── */
  const search = searchInput({ placeholder: 'بحث في المحادثات...' });
  const filterBar = el('div.chat-filters');
  const paintFilters = () => {
    clear(filterBar);
    for (const f of FILTERS) {
      filterBar.append(el('button.chat-filter' + (S.filter === f.key ? '.on' : ''), {
        icon: f.icon, iconSize: 14, text: f.label,
        onclick: () => { S.filter = f.key; paintFilters(); paintList(); }
      }));
    }
  };

  const paintList = () => {
    const q = S.query.trim().toLowerCase();
    const rows = S.list.filter(c => {
      if (S.filter !== 'all' && c.kind !== S.filter) return false;
      if (q && !`${c.title} ${c.last_message || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    clear(listBox);
    if (!rows.length) {
      listBox.append(empty('message-circle', 'لا توجد محادثات',
        S.query || S.filter !== 'all' ? 'جرّب بحثاً آخر أو غيّر التصنيف.' : 'ابدأ محادثةً خاصة أو أنشئ مجموعة.'));
      return;
    }
    for (const c of rows) {
      listBox.append(el('button.chat-item' + (c.id === S.activeId ? '.on' : '') + (c.unread ? '.unread' : ''), {
        onclick: () => openChat(c.id)
      }, [
        avatarNode(c.title, c.avatar_url, c.kind === 'group' ? 'group' : ''),
        el('div.t', {}, [
          el('div.line', {}, [
            el('b', { text: c.title }),
            el('span.at', { text: c.last_at ? timeAgo(c.last_at) : '' })
          ]),
          el('div.line', {}, [
            el('span.pv', { text: c.last_message
              ? (c.kind === 'direct' ? c.last_message : `${c.last_by ? c.last_by.split(' ').pop() + ': ' : ''}${c.last_message}`)
              : 'لا رسائل بعد' }),
            c.unread ? el('span.badge', { text: AR_NUM(Math.min(99, c.unread)) }) : null
          ]),
          c.kind !== 'direct' ? el('div.meta', {}, [
            chip(KIND_LABEL[c.kind], c.kind === 'group' ? 'brand' : '', c.kind === 'group' ? 'users-round' : 'clipboard-list'),
            c.kind === 'group' ? el('small', { text: counted(c.members_count, { one: 'عضو واحد', two: 'عضوان', few: 'أعضاء', many: 'عضواً' }) }) : null,
            c.muted ? chip('مكتومة', '', 'bell-off') : null
          ]) : null
        ])
      ]));
    }
  };

  search.field.addEventListener('input', debounce(() => { S.query = search.field.value; paintList(); }, 140));

  const listPane = el('div.chat-pane', {}, [
    el('div.chat-pane-head', {}, [
      el('h3', { icon: 'message-square-text', text: 'المحادثات' }),
      el('button.btn.sm', { icon: 'plus', iconSize: 15, text: 'جديدة', onclick: () => newChatDialog(S, refreshList, openChat) })
    ]),
    search, filterBar, listBox
  ]);

  const refreshList = async (keepOpen = true) => {
    S.list = await api.get('/api/comms/chats', { silent: true }).catch(() => S.list);
    paintList();
    window.dispatchEvent(new CustomEvent('raqeem:chat-unread'));
    if (keepOpen && S.activeId && !S.list.some(c => c.id === S.activeId)) {
      S.activeId = null; S.detail = null; paintThread();
    }
  };

  /* ── عمود الخيط ── */
  let composer = null;

  const paintThread = () => {
    clear(threadBox);
    if (!S.detail) {
      threadBox.append(empty('message-circle', 'اختر محادثة',
        'اختر محادثةً من القائمة، أو ابدأ محادثةً جديدة من زرّ «جديدة».'));
      page.classList.remove('open');
      return;
    }
    page.classList.add('open');
    const d = S.detail;
    const sub = d.kind === 'direct'
      ? (d.members.find(m => m.user_id !== state.session.user.id)?.role_name || 'محادثة خاصة')
      : d.kind === 'group'
        ? counted(d.members.length, { one: 'عضو واحد', two: 'عضوان', few: 'أعضاء', many: 'عضواً' })
        : 'محادثة مرتبطة بالعمل';

    const actions = [
      el('button.icon-btn', {
        title: d.muted ? 'إلغاء الكتم' : 'كتم الإشعارات',
        icon: d.muted ? 'bell-off' : 'bell', iconSize: 18,
        onclick: async (e) => {
          const r = await api.post(`/api/comms/chats/${d.id}/mute`, { muted: !d.muted });
          d.muted = r.muted; toast(r.muted ? 'كُتمت إشعارات المحادثة' : 'أُعيدت إشعارات المحادثة', 'info');
          paintThread(); refreshList();
        }
      })
    ];
    if (d.kind === 'group') actions.push(el('button.icon-btn', {
      title: 'معلومات المجموعة', icon: 'users-round', iconSize: 18,
      onclick: () => groupDialog(d, async () => { await openChat(d.id); await refreshList(); })
    }));

    const head = el('div.chat-head', {}, [
      el('button.icon-btn.back', { icon: 'arrow-right', iconSize: 20, 'aria-label': 'رجوع للقائمة',
        onclick: () => { S.activeId = null; S.detail = null; paintThread(); paintList(); } }),
      avatarNode(d.title, d.avatar_url, d.kind === 'group' ? 'group' : ''),
      el('div.t', {}, [
        el('b', { text: d.title }),
        el('span', { text: d.description || sub })
      ]),
      el('div.row', { style: { gap: '2px', flexWrap: 'nowrap' } }, actions)
    ]);

    const body = el('div.chat-scroll');
    paintMessages(body);

    /* الصندوق السابق يُفكّ قبل بناء بديله — وإلا تراكمت مستمعاتُ الردّ مع كل رسم */
    composer?.dispose?.();
    composer = buildComposer(S, body, refreshList);
    mount(threadBox, head, body, composer.node);
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  };

  const paintMessages = (body) => {
    clear(body);
    if (!S.messages.length) {
      body.append(empty('message-circle', 'لا رسائل بعد', 'اكتب أول رسالة في هذه المحادثة.'));
      return;
    }
    let lastDay = '';
    for (const m of S.messages) {
      const day = String(m.created_at).slice(0, 10);
      if (day !== lastDay) { lastDay = day; body.append(el('div.chat-day', {}, [el('span', { text: dayLabel(day) })])); }
      body.append(bubble(m, S, () => reloadMessages(body)));
    }
  };

  const reloadMessages = async (body) => {
    const data = await api.get(`/api/comms/chats/${S.activeId}/messages?limit=60`, { silent: true });
    S.messages = data.messages;
    paintMessages(body || qs('.chat-scroll', threadBox));
    const sc = qs('.chat-scroll', threadBox);
    if (sc) sc.scrollTop = sc.scrollHeight;
  };

  const openChat = async (id) => {
    S.activeId = Number(id);
    history.replaceState({}, '', `/chat?id=${S.activeId}`);
    clear(threadBox).append(skeleton(6));
    try {
      const [detail, msgs] = await Promise.all([
        api.get(`/api/comms/chats/${S.activeId}`),
        api.get(`/api/comms/chats/${S.activeId}/messages?limit=60`)
      ]);
      S.detail = detail; S.messages = msgs.messages;
      paintThread(); paintList();
      await refreshList();
    } catch (e) {
      S.detail = null; S.activeId = null;
      clear(threadBox).append(empty('lock', 'تعذّر فتح المحادثة', e.message || ''));
    }
  };

  /* ── الأحداث اللحظية ── */
  const onIncoming = async (e) => {
    if (!page.isConnected) return teardown();
    const det = e.detail || {};
    if (det.conversationId && det.conversationId === S.activeId && det.message) {
      S.messages.push({ ...det.message, mine: false });
      paintMessages(qs('.chat-scroll', threadBox));
      const sc = qs('.chat-scroll', threadBox);
      if (sc) sc.scrollTop = sc.scrollHeight;
      api.post(`/api/comms/chats/${S.activeId}/read`, {}, { silent: true }).catch(() => {});
    }
    await refreshList();
  };
  const onUpdated = async () => {
    if (!page.isConnected) return teardown();
    await refreshList();
    if (S.activeId) {
      S.detail = await api.get(`/api/comms/chats/${S.activeId}`, { silent: true }).catch(() => S.detail);
      if (S.detail) paintThread();
    }
  };
  const onPoll = async () => {
    if (!page.isConnected) return teardown();
    await refreshList();
    if (S.activeId) await reloadMessages().catch(() => {});
  };
  const teardown = () => {
    window.removeEventListener('raqeem:chat', onIncoming);
    window.removeEventListener('raqeem:chat-meta', onUpdated);
    window.removeEventListener('raqeem:poll', onPoll);
    composer?.dispose?.();
    releaseBlobs();
  };
  window.addEventListener('raqeem:chat', onIncoming);
  window.addEventListener('raqeem:chat-meta', onUpdated);
  window.addEventListener('raqeem:poll', onPoll);

  paintFilters();
  clear(listBox).append(skeleton(5));
  page.append(listPane, threadBox);
  await refreshList(false);
  if (S.activeId) await openChat(S.activeId); else paintThread();
  return page;
}

const dayLabel = (iso) => {
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (iso === today) return 'اليوم';
  if (iso === yest) return 'أمس';
  return new Date(iso).toLocaleDateString('ar-SA', { day: 'numeric', month: 'long', timeZone: 'Asia/Riyadh' });
};

/* ═════════ الفقاعة ═════════ */
function bubble(m, S, reload) {
  if (m.kind === 'system') return el('div.chat-system', { text: m.body });

  const box = el('div.msg' + (m.mine ? '.mine' : ''));
  if (!m.mine && S.detail?.kind !== 'direct') box.append(el('div.who', { text: m.user_name }));

  if (m.reply_body !== null && m.reply_body !== undefined && m.reply_to_id) {
    box.append(el('div.quote', {}, [
      el('b', { text: m.reply_name || '' }),
      el('span', { text: String(m.reply_body).slice(0, 120) })
    ]));
  }

  if (m.deleted) {
    box.append(el('div.gone', { icon: 'ban', iconSize: 14, text: 'حُذفت هذه الرسالة' }));
  } else {
    if (m.kind === 'voice') box.append(voicePlayer(m));
    for (const a of (m.attachments || [])) {
      if (m.kind === 'voice') break;
      box.append(isImage(a) ? imageAttachment(a) : fileAttachment(a));
    }
    if (m.body) box.append(el('div.tx', { text: m.body }));
  }

  const at = el('div.at', {}, [
    el('span', { text: clockOf(m.created_at) }),
    m.edited_at ? el('span', { text: ' · مُعدَّلة' }) : null
  ]);
  box.append(at);

  /* أدواتُ الرسالة تظهر عند التحويم، وتبقى في متناول اللمس على الجوال */
  const tools = el('div.msg-tools');
  tools.append(el('button', { icon: 'reply', iconSize: 14, title: 'ردّ',
    onclick: () => window.dispatchEvent(new CustomEvent('raqeem:chat-reply', { detail: m })) }));
  if (m.mine && !m.deleted && ['text', 'file'].includes(m.kind)) {
    tools.append(el('button', { icon: 'pen-line', iconSize: 14, title: 'تعديل', onclick: () => editMessage(S, m, reload) }));
  }
  if (!m.deleted && (m.mine || S.detail?.my_role === 'admin')) {
    tools.append(el('button', { icon: 'trash-2', iconSize: 14, title: 'حذف', onclick: async () => {
      if (!await confirmDialog('سيُحذف نصُّ الرسالة ويبقى موضعها في الخيط.', { confirmText: 'حذف', danger: true })) return;
      await api.del(`/api/comms/chats/${S.activeId}/messages/${m.id}`);
      await reload();
    } }));
  }

  return el('div.msg-row' + (m.mine ? '.mine' : ''), {}, [box, tools]);
}

function imageAttachment(a) {
  const holder = el('a.msg-img', { href: '#', onclick: (e) => { e.preventDefault(); previewAttachment(a); } },
    [el('span.ph', { icon: 'image', iconSize: 20, text: a.name })]);
  fileURL(a.id).then(u => { if (u && holder.isConnected) clear(holder).append(el('img', { src: u, alt: a.name })); });
  return holder;
}

function fileAttachment(a) {
  return el('button.msg-file', { onclick: () => previewAttachment(a) }, [
    el('span.ic', { icon: a.mime === 'application/pdf' ? 'file-text' : 'paperclip', iconSize: 18 }),
    el('span.t', {}, [el('b', { text: a.name }), el('small', { text: sizeText(a.size || 0) })]),
    el('span.ic', { icon: 'download', iconSize: 16 })
  ]);
}

async function previewAttachment(a) {
  const m = modal({ title: a.name, size: 'wide', body: skeleton(3) });
  const url = await fileURL(a.id);
  if (!url) return clear(m.body).append(empty('triangle-alert', 'تعذّر فتح المرفق', ''));
  clear(m.body).append(el('div', { style: { textAlign: 'center' } }, [
    isImage(a)
      ? el('img', { src: url, alt: a.name, style: { maxWidth: '100%', borderRadius: '10px' } })
      : el('iframe', { src: url, style: { width: '100%', height: '64vh', border: '1px solid var(--border)', borderRadius: '10px' } }),
    el('div', { style: { marginTop: '12px' } }, [
      el('button.btn.sm.ghost', { icon: 'download', iconSize: 16, text: 'تنزيل الملف',
        onclick: () => api.downloadGet(`/api/files/${a.id}?download=1`, a.name) })
    ])
  ]));
}

/** مشغّل الرسالة الصوتية — زرٌّ ومدّةٌ وشريطُ تقدّم، بلا مشغّل المتصفّح العريض */
function voicePlayer(m) {
  const a = (m.attachments || [])[0];
  const wrap = el('div.voice');
  const btn = el('button.voice-btn', { icon: 'play', iconSize: 16, 'aria-label': 'تشغيل الرسالة الصوتية' });
  const bar = el('div.voice-bar', {}, [el('span')]);
  const time = el('span.voice-time', { text: msText(m.duration_ms) });
  wrap.append(btn, bar, time);
  if (!a) return wrap;

  let audio = null;
  btn.addEventListener('click', async () => {
    if (!audio) {
      const url = await fileURL(a.id);
      if (!url) return toast('تعذّر تشغيل الرسالة الصوتية', 'err');
      audio = new Audio(url);
      audio.addEventListener('timeupdate', () => {
        const p = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
        bar.firstChild.style.width = `${p}%`;
        time.textContent = msText(audio.currentTime * 1000);
      });
      audio.addEventListener('ended', () => {
        clear(btn).append(el('span.ic', { icon: 'play', iconSize: 16 }));
        bar.firstChild.style.width = '0%'; time.textContent = msText(m.duration_ms);
      });
    }
    if (audio.paused) { await audio.play(); clear(btn).append(el('span.ic', { icon: 'pause', iconSize: 16 })); }
    else { audio.pause(); clear(btn).append(el('span.ic', { icon: 'play', iconSize: 16 })); }
  });
  return wrap;
}

const msText = (ms) => {
  const t = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${AR_NUM(Math.floor(t / 60))}:${String(t % 60).padStart(2, '0').replace(/\d/g, d => AR_NUM(d))}`;
};

function editMessage(S, m, reload) {
  const box = textarea({ value: m.body, style: { minHeight: '110px' } });
  const dlg = modal({
    title: 'تعديل الرسالة', size: 'narrow', icon: 'pen-line', body: box,
    footer: [
      el('button.btn.ghost', { text: 'إلغاء', onclick: () => dlg.close() }),
      el('button.btn', { icon: 'save', iconSize: 16, text: 'حفظ', onclick: async (e) => {
        const v = box.value.trim();
        if (!v) return toast('لا يمكن ترك الرسالة فارغة', 'warn');
        e.target.disabled = true;
        try { await api.patch(`/api/comms/chats/${S.activeId}/messages/${m.id}`, { body: v }); dlg.close(); await reload(); }
        catch { e.target.disabled = false; }
      } })
    ]
  });
}

/* ═════════ صندوق الكتابة ═════════ */
function buildComposer(S, body, refreshList) {
  const box = textarea({ placeholder: 'اكتب رسالتك...', rows: 1, class: 'chat-write' });
  const files = el('input', { type: 'file', multiple: true, hidden: true,
    accept: 'image/*,application/pdf,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt' });
  const replyBar = el('div.chat-reply', { hidden: true });
  let replyTo = null;

  const setReply = (m) => {
    replyTo = m;
    replyBar.hidden = !m;
    if (!m) return;
    clear(replyBar).append(
      el('span.ic', { icon: 'reply', iconSize: 14 }),
      el('div.t', {}, [el('b', { text: m.user_name }), el('span', { text: (m.body || 'مرفق').slice(0, 90) })]),
      el('button.x', { icon: 'x', iconSize: 14, 'aria-label': 'إلغاء الردّ', onclick: () => setReply(null) })
    );
  };
  const onReply = (e) => { if (!box.isConnected) return dispose(); setReply(e.detail); box.focus(); };
  const dispose = () => window.removeEventListener('raqeem:chat-reply', onReply);
  window.addEventListener('raqeem:chat-reply', onReply);

  const push = async (payload) => {
    const msg = await api.post(`/api/comms/chats/${S.activeId}/messages`, {
      ...payload, ...(replyTo ? { reply_to_id: replyTo.id } : {})
    });
    S.messages.push(msg);
    body.append(bubble(msg, S, async () => {
      const d = await api.get(`/api/comms/chats/${S.activeId}/messages?limit=60`, { silent: true });
      S.messages = d.messages;
    }));
    body.scrollTop = body.scrollHeight;
    setReply(null);
    await refreshList();
  };

  const send = async () => {
    const v = box.value.trim();
    if (!v) return;
    box.value = ''; box.style.height = 'auto'; box.disabled = true;
    try { await push({ body: v, kind: 'text' }); }
    catch { box.value = v; }
    finally { box.disabled = false; box.focus(); }
  };

  box.addEventListener('keydown', (e) => {
    /* Enter يُرسل، وShift+Enter سطرٌ جديد — كما تعوّد الناس في المحادثات */
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  box.addEventListener('input', () => {
    box.style.height = 'auto';
    box.style.height = Math.min(140, box.scrollHeight) + 'px';
  });

  files.addEventListener('change', async () => {
    const picked = [...files.files];
    files.value = '';
    if (!picked.length) return;
    const fd = new FormData();
    for (const f of picked) fd.append('files', f);
    fd.append('context', 'chat');
    try {
      const up = await api.post('/api/files', fd);
      await push({ kind: 'file', body: box.value.trim(), attachment_ids: (up.files || []).map(f => f.id) });
      box.value = '';
    } catch { /* رُفعت الرسالة للمستخدم في طبقة الواجهة البرمجية */ }
  });

  const bar = el('div.chat-compose', {}, [
    el('button.icon-btn', { icon: 'paperclip', iconSize: 19, title: 'إرفاق ملف', onclick: () => files.click() }),
    micButton(push),
    box,
    el('button.btn.send', { icon: 'send-horizontal', iconSize: 18, 'aria-label': 'إرسال', onclick: send })
  ]);
  return { node: el('div.chat-foot', {}, [replyBar, bar, files]), dispose };
}

/**
 * زرّ التسجيل الصوتي.
 *
 * المتصفّحات تختلف فيما تُخرجه: ويب-إم على أندرويد وسطح المكتب، وإم-بي-فور
 * على آبل — فيُسأل `MediaRecorder` عمّا يدعمه بدل فرض صيغةٍ واحدة تسقط عند
 * نصف المستخدمين. والمجرى يُغلَق بعد كل تسجيل، وإلا بقي ضوء الميكروفون مضاءً.
 */
function micButton(push) {
  const btn = el('button.icon-btn', { icon: 'mic', iconSize: 19, title: 'رسالة صوتية' });
  let rec = null, chunks = [], started = 0, timer = null, panel = null, cancelled = false;

  const pickType = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
    .find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';

  const stopTracks = () => rec?.stream?.getTracks?.().forEach(t => t.stop());

  const showPanel = () => {
    const time = el('span.t', { text: '٠:٠٠' });
    panel = el('div.rec-bar', {}, [
      el('span.dot'),
      el('span', { text: 'جارٍ التسجيل' }), time,
      el('button.btn.sm.ghost.danger', { icon: 'trash-2', iconSize: 15, text: 'إلغاء',
        onclick: () => { cancelled = true; rec?.stop(); } }),
      el('button.btn.sm', { icon: 'square', iconSize: 15, text: 'إرسال', onclick: () => rec?.stop() })
    ]);
    btn.after(panel);
    timer = setInterval(() => { time.textContent = msText(Date.now() - started); }, 250);
  };
  const killPanel = () => { clearInterval(timer); panel?.remove(); panel = null; };

  btn.addEventListener('click', async () => {
    if (rec && rec.state === 'recording') return rec.stop();
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      return toast('متصفّحك لا يدعم التسجيل الصوتي', 'warn');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { return toast('تعذّر الوصول إلى الميكروفون — اسمح به من إعدادات المتصفح', 'err'); }

    const mimeType = pickType();
    rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = []; cancelled = false; started = Date.now();
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = async () => {
      const ms = Date.now() - started;
      killPanel(); stopTracks();
      btn.classList.remove('rec');
      const blob = new Blob(chunks, { type: (mimeType || 'audio/webm').split(';')[0] });
      rec = null;
      if (cancelled || blob.size < 1200 || ms < 700) return;
      const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      const fd = new FormData();
      fd.append('files', new File([blob], `رسالة-صوتية.${ext}`, { type: blob.type }));
      fd.append('context', 'chat');
      try {
        const up = await api.post('/api/files', fd);
        await push({ kind: 'voice', attachment_ids: [up.files[0].id], duration_ms: ms });
      } catch { /* رسالة الخطأ وصلت من طبقة الواجهة البرمجية */ }
    };
    rec.start();
    btn.classList.add('rec');
    showPanel();
  });
  return btn;
}

/* ═════════ محادثة جديدة ═════════ */
async function newChatDialog(S, refreshList, openChat) {
  const dlg = modal({ title: 'محادثة جديدة', icon: 'message-square-text', size: 'wide', body: skeleton(4) });
  const dir = await api.get('/api/comms/directory').catch(() => null);
  if (!dir) return clear(dlg.body).append(empty('triangle-alert', 'تعذّر تحميل دليل المنسوبين', ''));

  const opts = dir.users.map(u => ({ value: u.id, label: u.name, sub: [u.job_title || u.role_name, u.branch_name].filter(Boolean).join(' · '), group: u.group }));
  const one = picker(opts, { placeholder: '— اختر المنسوب —', ariaLabel: 'المنسوب' });

  const title = input({ placeholder: 'اسم المجموعة' });
  const desc = textarea({ placeholder: 'وصف مختصر لغرض المجموعة...' });
  const chosen = new Set();
  const chosenBox = el('div.row');
  const adder = picker(opts, { placeholder: '— أضف عضواً —', ariaLabel: 'إضافة عضو' });
  const paintChosen = () => {
    clear(chosenBox);
    if (!chosen.size) return chosenBox.append(el('span.hint', { text: 'لم تختر أحداً بعد.' }));
    for (const id of chosen) {
      const u = dir.users.find(x => x.id === id);
      chosenBox.append(el('span.chip.brand', {}, [
        el('span', { text: u?.name || '' }),
        el('button.x', { icon: 'x', iconSize: 12, 'aria-label': 'إزالة', onclick: () => { chosen.delete(id); paintChosen(); } })
      ]));
    }
  };
  adder.addEventListener('change', () => { if (adder.value) { chosen.add(Number(adder.value)); adder.value = ''; paintChosen(); } });
  paintChosen();

  const avatarPick = avatarField();

  let mode = 'direct';
  const modeBar = el('div.chat-filters');
  const panes = el('div');
  const paintMode = () => {
    clear(modeBar);
    for (const m of [{ k: 'direct', l: 'محادثة خاصة', i: 'user-round' }, { k: 'group', l: 'مجموعة', i: 'users-round' }]) {
      modeBar.append(el('button.chat-filter' + (mode === m.k ? '.on' : ''), { icon: m.i, iconSize: 15, text: m.l,
        onclick: () => { mode = m.k; paintMode(); } }));
    }
    clear(panes).append(mode === 'direct'
      ? el('div.stack', {}, [field('المنسوب', one, { required: true })])
      : el('div.stack', {}, [
        field('اسم المجموعة', title, { required: true }),
        field('الوصف', desc),
        field('صورة العرض', avatarPick.node, { hint: 'صورةٌ تُميّز المجموعة في قائمة المحادثات' }),
        field('الأعضاء', adder, { hint: dir.scope_label }),
        chosenBox
      ]));
  };
  paintMode();

  clear(dlg.body).append(el('div.stack', {}, [
    el('div.hint', { text: `يمكنك محادثة وإضافة: ${dir.scope_label} — وعددهم ${AR_NUM(dir.users.length)}.` }),
    modeBar, panes
  ]));

  dlg.box.querySelector('.modal-foot')?.remove();
  dlg.box.append(el('div.modal-foot', {}, [
    el('button.btn.ghost', { text: 'إلغاء', onclick: () => dlg.close() }),
    el('button.btn', { icon: 'message-square-text', iconSize: 16, text: 'بدء المحادثة', onclick: async (e) => {
      e.target.disabled = true;
      try {
        let r;
        if (mode === 'direct') {
          if (!one.value) { e.target.disabled = false; return toast('اختر المنسوب أولاً', 'warn'); }
          r = await api.post('/api/comms/chats', { kind: 'direct', user_id: Number(one.value) });
        } else {
          if (!title.value.trim()) { e.target.disabled = false; return toast('اسم المجموعة إلزامي', 'warn'); }
          r = await api.post('/api/comms/chats', {
            kind: 'group', title: title.value.trim(), description: desc.value.trim(),
            member_ids: [...chosen], avatar_file_id: avatarPick.fileId()
          });
        }
        dlg.close(); await refreshList(); await openChat(r.id);
      } catch { e.target.disabled = false; }
    } })
  ]));
}

/** حقل صورة العرض — يرفع الملف فوراً ويُرجع معرّفه، فالخادم لا يقبل رابطاً حرّاً */
function avatarField(currentUrl = null) {
  let id = null;
  const preview = el('div.av-pick');
  const inp = el('input', { type: 'file', accept: 'image/*', hidden: true });
  const paint = (url) => {
    clear(preview);
    if (url) preview.append(el('img', { src: url, alt: '' }));
    else preview.append(el('span.ic', { icon: 'image', iconSize: 22 }));
  };
  paint(null);
  if (currentUrl) fileURL(fileIdOf(currentUrl)).then(u => u && paint(u));

  inp.addEventListener('change', async () => {
    const f = inp.files?.[0]; inp.value = '';
    if (!f) return;
    const fd = new FormData(); fd.append('files', f); fd.append('context', 'chat');
    try {
      const up = await api.post('/api/files', fd);
      id = up.files[0].id;
      paint(URL.createObjectURL(f));
      toast('رُفعت الصورة — احفظ لتُثبَّت', 'ok');
    } catch { /* الرسالة وصلت */ }
  });

  const node = el('div.row', {}, [
    preview,
    el('button.btn.sm.ghost', { icon: 'camera', iconSize: 16, text: 'اختيار صورة', onclick: () => inp.click() }),
    el('button.btn.sm.ghost', { icon: 'x', iconSize: 15, text: 'بلا صورة', onclick: () => { id = ''; paint(null); } }),
    inp
  ]);
  return { node, fileId: () => id };
}

/* ═════════ معلومات المجموعة ═════════ */
async function groupDialog(d, reload) {
  const may = d.can_manage;
  const dlg = modal({ title: d.title, icon: 'users-round', size: 'wide', body: skeleton(4) });

  const title = input({ value: d.title, disabled: !may });
  const desc = textarea({ value: d.description || '', disabled: !may, placeholder: 'وصف المجموعة...' });
  const avatarPick = avatarField(d.avatar_url);
  const membersBox = el('div.stack');

  const paintMembers = () => {
    clear(membersBox);
    for (const m of d.members) {
      const me = m.user_id === state.session.user.id;
      membersBox.append(el('div.member-row', {}, [
        avatarNode(m.name, m.avatar_url, 'sm'),
        el('div.t', {}, [
          el('b', { text: m.name + (me ? ' (أنت)' : '') }),
          el('small', { text: [m.role_name, m.branch_name].filter(Boolean).join(' · ') })
        ]),
        m.role_in === 'admin' ? chip('مشرف', 'brand', 'shield-check') : null,
        may && !me ? el('button.btn.sm.ghost', {
          icon: m.role_in === 'admin' ? 'arrow-down' : 'arrow-up', iconSize: 14,
          text: m.role_in === 'admin' ? 'إنزال' : 'ترقية',
          onclick: async () => {
            await api.patch(`/api/comms/chats/${d.id}/members/${m.user_id}`,
              { role_in: m.role_in === 'admin' ? 'member' : 'admin' });
            dlg.close(); await reload();
          }
        }) : null,
        may && !me ? el('button.btn.sm.ghost.danger', {
          icon: 'x', iconSize: 14, 'aria-label': `إخراج ${m.name}`,
          onclick: async () => {
            if (!await confirmDialog(`إخراج ${m.name} من المجموعة؟`, { confirmText: 'إخراج', danger: true })) return;
            await api.del(`/api/comms/chats/${d.id}/members/${m.user_id}`);
            dlg.close(); await reload();
          }
        }) : null
      ]));
    }
  };
  paintMembers();

  const addBox = el('div');
  if (may) {
    const dir = await api.get('/api/comms/directory').catch(() => ({ users: [], scope_label: '' }));
    const inGroup = new Set(d.members.map(m => m.user_id));
    const pool = dir.users.filter(u => !inGroup.has(u.id));
    const chosen = new Set();
    const chosenBox = el('div.row');
    const adder = picker(pool.map(u => ({ value: u.id, label: u.name,
      sub: [u.job_title || u.role_name, u.branch_name].filter(Boolean).join(' · '), group: u.group })),
    { placeholder: '— أضف عضواً —', ariaLabel: 'إضافة عضو' });
    const paintChosen = () => {
      clear(chosenBox);
      for (const id of chosen) {
        const u = pool.find(x => x.id === id);
        chosenBox.append(el('span.chip.brand', {}, [
          el('span', { text: u?.name || '' }),
          el('button.x', { icon: 'x', iconSize: 12, 'aria-label': 'إزالة', onclick: () => { chosen.delete(id); paintChosen(); } })
        ]));
      }
    };
    adder.addEventListener('change', () => { if (adder.value) { chosen.add(Number(adder.value)); adder.value = ''; paintChosen(); } });
    addBox.append(el('div.stack', {}, [
      field('إضافة أعضاء', adder, { hint: pool.length ? dir.scope_label : 'كل من تبلغهم صلاحيتك أعضاءٌ في المجموعة بالفعل' }),
      chosenBox,
      el('button.btn.sm', { icon: 'user-plus', iconSize: 15, text: 'إضافة المختارين', onclick: async (e) => {
        if (!chosen.size) return toast('اختر من تريد إضافته', 'warn');
        e.target.disabled = true;
        try { await api.post(`/api/comms/chats/${d.id}/members`, { user_ids: [...chosen] }); dlg.close(); await reload(); }
        catch { e.target.disabled = false; }
      } })
    ]));
  }

  clear(dlg.body).append(el('div.stack', {}, [
    may ? el('div.stack', {}, [
      field('اسم المجموعة', title, { required: true }),
      field('الوصف', desc),
      field('صورة العرض', avatarPick.node)
    ]) : el('div', {}, [
      el('h3', { text: d.title }),
      d.description ? el('p.hint', { text: d.description }) : null
    ]),
    el('h4', { text: `الأعضاء (${AR_NUM(d.members.length)})`, style: { margin: '6px 0 0' } }),
    membersBox,
    addBox
  ]));

  dlg.box.querySelector('.modal-foot')?.remove();
  dlg.box.append(el('div.modal-foot', {}, [
    d.can_leave ? el('button.btn.ghost.danger', { icon: 'log-out', iconSize: 16, text: 'مغادرة المجموعة',
      onclick: async (e) => {
        if (!await confirmDialog('ستغادر المجموعة ولن تصلك رسائلها بعد الآن.', { confirmText: 'مغادرة', danger: true })) return;
        e.target.disabled = true;
        try { await api.del(`/api/comms/chats/${d.id}/members/${state.session.user.id}`); dlg.close(); await reload(); }
        catch { e.target.disabled = false; }
      } }) : null,
    el('button.btn.ghost', { text: 'إغلاق', onclick: () => dlg.close() }),
    may ? el('button.btn', { icon: 'save', iconSize: 16, text: 'حفظ', onclick: async (e) => {
      if (!title.value.trim()) return toast('اسم المجموعة إلزامي', 'warn');
      e.target.disabled = true;
      try {
        const fid = avatarPick.fileId();
        await api.patch(`/api/comms/chats/${d.id}`, {
          title: title.value.trim(), description: desc.value.trim(),
          ...(fid === null ? {} : { avatar_file_id: fid })
        });
        dlg.close(); await reload();
      } catch { e.target.disabled = false; }
    } }) : null
  ]));
}

export default { render };
