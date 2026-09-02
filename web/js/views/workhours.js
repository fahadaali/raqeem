import api from '../api.js';
import {
  el, clear, card, chip, table, toast, modal, field, input, searchInput, select,
  AR_NUM, counted, confirmDialog, skeleton, debounce
} from '../util.js';

/**
 * لوحة أوقات الدوام — أيام العمل وساعاته على ثلاث طبقات من مكانٍ واحد.
 *
 *     المجمّع  ←  الفرع  ←  الموظف
 *
 * والأخصُّ يعلو الأعمّ: من وُضع له جدولٌ خاصّ عمل به، ومن لم يوضع له ورث جدول
 * فرعه، ومن لا فرع له ورث جدول المجمّع. وعلى هذا يُقاس التأخّر ويُبنى المسير،
 * فالشاشة تقول لكلِّ صفٍّ من أين جاء جدولُه — «موروث» أو «خاصّ» — حتى لا يُظنّ
 * أن تعديل الفرع لم يُحفظ وهو إنما ورثه من فوقه.
 */

const SOURCE = {
  user: { label: 'خاصّ بالمنسوب', chip: 'brand' },
  branch: { label: 'من الفرع', chip: 'info' },
  tenant: { label: 'من المجمّع', chip: '' },
  default: { label: 'الافتراضي', chip: '' }
};

const hhmm = (v) => (/^\d{1,2}:\d{2}$/.test(String(v || '')) ? v : '07:30');
const toMin = (v) => { const [h, m] = hhmm(v).split(':').map(Number); return h * 60 + m; };

/** «٥ ساعات و٣٠ دقيقة» — لا «5.5h» ولا كسرٌ عشريّ في شاشةٍ عربية */
export function hoursText(minutes) {
  const t = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(t / 60), m = t % 60;
  if (!h && !m) return 'لا شيء';
  const hp = h ? counted(h, { one: 'ساعة', two: 'ساعتان', few: 'ساعات', many: 'ساعة' }) : '';
  const mp = m ? counted(m, { one: 'دقيقة', two: 'دقيقتان', few: 'دقائق', many: 'دقيقة' }) : '';
  return [hp, mp].filter(Boolean).join(' و');
}

const weekTotals = (days) => {
  const on = days.filter(d => d.on);
  const mins = on.reduce((s, d) => s + Math.max(0, toMin(d.end) - toMin(d.start)), 0);
  return { days: on.length, minutes: mins };
};

/* ═════════ محرّر الجدول ═════════ */
/**
 * سبعة أسطر: يومٌ في كل سطر، ومفتاحٌ يُطفئه، وساعتا بدايةٍ ونهاية.
 * والحصيلة الأسبوعية تُحسب تحت الأسطر مع كل نقرة — فيُقرأ أثرُ التعديل قبل حفظه
 * لا بعد أن يُخصم من راتب أحدهم.
 */
function scheduleForm(data, dayNames) {
  const days = (data.days || []).map(d => ({ on: !!d.on, start: hhmm(d.start), end: hhmm(d.end) }));
  const rows = [];
  const totals = el('div.wh-total');

  const paintTotals = () => {
    const t = weekTotals(days);
    clear(totals).append(
      chip(counted(t.days, { one: 'يوم عملٍ واحد', two: 'يوما عمل', few: 'أيام عمل', many: 'يوم عمل' })
        + ' أسبوعياً', t.days ? 'ok' : 'danger', 'calendar-days'),
      chip(hoursText(t.minutes) + ' أسبوعياً', 'info', 'timer'),
      chip('معدّل اليوم: ' + hoursText(t.days ? t.minutes / t.days : 0), '', 'hourglass')
    );
  };

  const grid = el('div.wh-days');
  dayNames.forEach((name, i) => {
    const d = days[i];
    const on = input({ type: 'checkbox', checked: d.on, 'aria-label': `يوم عمل: ${name}` });
    const start = input({ type: 'time', value: d.start, disabled: !d.on });
    const end = input({ type: 'time', value: d.end, disabled: !d.on });
    const span = el('span.wh-span');

    const sync = () => {
      d.on = on.checked; d.start = hhmm(start.value); d.end = hhmm(end.value);
      /* نهايةٌ قبل بدايةٍ ليست دواماً عابراً لمنتصف الليل بل خطأُ إدخال —
         تُقوَّم هنا كما يقوّمها الخادم، فيرى المستخدم ما سيُحفظ لا ما كتب */
      if (toMin(d.end) <= toMin(d.start)) {
        const fixed = Math.min(23 * 60 + 59, toMin(d.start) + 60);
        d.end = `${String(Math.floor(fixed / 60)).padStart(2, '0')}:${String(fixed % 60).padStart(2, '0')}`;
        end.value = d.end;
      }
      start.disabled = end.disabled = !d.on;
      row.classList.toggle('off', !d.on);
      span.textContent = d.on ? hoursText(toMin(d.end) - toMin(d.start)) : 'راحة';
      paintTotals();
    };
    on.addEventListener('change', sync);
    start.addEventListener('change', sync);
    end.addEventListener('change', sync);

    /* مدّة اليوم تُكتب عند البناء أيضاً لا عند التغيير وحده — وإلا بقي
       العمودُ فارغاً حتى يمسّ المستخدمُ صفّاً، فيبدو الجدولُ ناقصاً */
    span.textContent = d.on ? hoursText(toMin(d.end) - toMin(d.start)) : 'راحة';
    const row = el('div.wh-day' + (d.on ? '' : '.off'), {}, [
      el('label.wh-name', {}, [on, el('span', { text: name })]),
      el('div.wh-times', {}, [start, el('span.sep', { text: '—' }), end]),
      span
    ]);
    rows.push(row);
    grid.append(row);
  });

  const grace = input({ type: 'number', min: 0, max: 240, value: data.grace_min ?? 15, dir: 'ltr' });
  const note = input({ value: data.note || '', placeholder: 'سببُ الاستثناء — يظهر في سجل النشاطات' });
  paintTotals();

  /* أزرارٌ سريعة تختصر النقر: أسبوعُ الحلقات المعتاد، أو تعميمُ توقيتِ يومٍ على بقيّته */
  const preset = (label, fn) => el('button.btn.sm.ghost', { text: label, type: 'button', onclick: () => {
    fn(); rows.forEach((r, i) => {
      const [chk] = r.querySelectorAll('input[type=checkbox]');
      const [st, en] = r.querySelectorAll('input[type=time]');
      chk.checked = days[i].on; st.value = days[i].start; en.value = days[i].end;
      st.disabled = en.disabled = !days[i].on;
      r.classList.toggle('off', !days[i].on);
      r.querySelector('.wh-span').textContent = days[i].on
        ? hoursText(toMin(days[i].end) - toMin(days[i].start)) : 'راحة';
    });
    paintTotals();
  } });

  const node = el('div.stack', {}, [
    el('div.row', {}, [
      preset('الأحد — الخميس', () => days.forEach((d, i) => { d.on = i <= 4; })),
      preset('السبت — الأربعاء', () => days.forEach((d, i) => { d.on = i === 6 || i <= 3; })),
      preset('توحيد التوقيت', () => {
        const first = days.find(d => d.on) || days[0];
        days.forEach(d => { d.start = first.start; d.end = first.end; });
      })
    ]),
    grid,
    totals,
    el('div.grid.g2', {}, [
      field('سماح التأخير (دقيقة)', grace, { hint: 'بعده يُسجَّل الحضور تأخيراً وتُحسب دقائقه في المسير' }),
      field('ملاحظة', note)
    ])
  ]);

  return {
    node,
    read: () => ({
      days: days.map(d => ({ on: d.on ? 1 : 0, start: d.start, end: d.end })),
      grace_min: Math.max(0, Math.min(240, Number(grace.value) || 0)),
      note: note.value.trim()
    }),
    valid: () => days.some(d => d.on)
  };
}

/**
 * نافذة تحرير جدولٍ لمستوى بعينه.
 * @param {{scope:string, id?:number, title:string, sub?:string, schedule:object,
 *          dayNames:string[], overridden:boolean, extra?:Node, onDone:Function}} o
 */
export function openScheduleEditor(o) {
  const form = scheduleForm(o.schedule, o.dayNames);
  const body = el('div.stack', {}, [
    o.sub ? el('div.hint', { text: o.sub }) : null,
    o.extra || null,
    form.node
  ]);

  const footer = [];
  if (o.overridden && o.scope !== 'tenant') {
    footer.push(el('button.btn.ghost.danger', {
      icon: 'undo-2', iconSize: 16, text: 'إعادة إلى الموروث',
      onclick: async (e) => {
        if (!await confirmDialog(
          `سيُحذف الجدول الخاص، ويعود ${o.title} إلى الجدول الموروث من فوقه.`,
          { confirmText: 'إعادة', danger: true })) return;
        e.target.disabled = true;
        try {
          await api.del(`/api/hr/schedules/${o.scope}/${o.id}`);
          toast('عاد إلى الجدول الموروث', 'ok');
          m.close(); await o.onDone();
        } catch { e.target.disabled = false; }
      }
    }));
  }
  footer.push(el('button.btn.ghost', { text: 'إلغاء', onclick: () => m.close() }));
  footer.push(el('button.btn', {
    icon: 'save', iconSize: 16, text: 'حفظ الجدول',
    onclick: async (e) => {
      if (!form.valid()) return toast('لا بدّ من يوم عملٍ واحدٍ على الأقل', 'warn');
      e.target.disabled = true;
      try {
        const payload = { scope: o.scope, ...form.read() };
        if (o.scope === 'branch') payload.branch_id = o.id;
        if (o.scope === 'user') payload.user_id = o.id;
        if (o.scope === 'tenant' && o.unify?.()) payload.apply_to_branches = true;
        const r = await api.put('/api/hr/schedules', payload);
        toast(r.cleared_branches
          ? `حُفظ الجدول ووُحِّد عليه ${AR_NUM(r.cleared_branches)} فرعاً`
          : 'حُفظ جدول الدوام', 'ok');
        m.close(); await o.onDone();
      } catch { e.target.disabled = false; }
    }
  }));

  const m = modal({ title: `أوقات دوام — ${o.title}`, icon: 'alarm-clock', size: 'wide', body, footer });
  return m;
}

/* ═════════ التبويب ═════════ */
export async function schedulesTab() {
  const wrap = el('div.stack');
  const box = el('div.stack');
  wrap.append(box);

  let data = null;
  const reload = async () => { data = await api.get('/api/hr/schedules'); paint(); };

  const sourceChip = (sc, overridden) => {
    const k = overridden ? sc.source : (sc.source === 'user' ? 'user' : sc.source);
    const s = SOURCE[k] || SOURCE.default;
    return chip(overridden ? 'جدول خاصّ' : s.label, overridden ? s.chip : '', overridden ? 'pen-line' : 'arrow-down');
  };

  const paint = () => {
    const names = data.day_names;
    const may = data.can_manage;
    clear(box);

    /* ── دوام المجمّع ── */
    const t = data.tenant;
    const tw = weekTotals(t.days);
    box.append(card('دوام المجمّع', [
      el('div.hint', {
        text: 'هذا الأساس الذي ترثه الفروع والمنسوبون جميعاً. وما يُوضع لفرعٍ أو لمنسوبٍ بعده يعلوه.'
      }),
      el('div.grid.g3', { style: { marginTop: '12px' } }, [
        el('div.stat', {}, [
          el('div.label', { icon: 'calendar-days', iconSize: 16 }, ['أيام العمل']),
          el('div.value', { text: AR_NUM(tw.days) }),
          el('div.hint', { text: t.summary })
        ]),
        el('div.stat.ok', {}, [
          el('div.label', { icon: 'timer', iconSize: 16 }, ['ساعات الأسبوع']),
          el('div.value', { text: AR_NUM(Math.round(tw.minutes / 60)) }),
          el('div.hint', { text: hoursText(tw.minutes) })
        ]),
        el('div.stat.gold', {}, [
          el('div.label', { icon: 'hourglass', iconSize: 16 }, ['سماح التأخير']),
          el('div.value', { text: AR_NUM(t.grace_min) }),
          el('div.hint', { text: 'دقيقة قبل أن يُسجَّل الحضور تأخيراً' })
        ])
      ]),
      may && data.can_manage_tenant ? el('div.row', { style: { marginTop: '13px' } }, [
        el('button.btn', {
          icon: 'pen-line', iconSize: 16, text: 'تعديل دوام المجمّع',
          onclick: () => {
            const unify = input({ type: 'checkbox' });
            openScheduleEditor({
              scope: 'tenant', id: null, title: 'المجمّع كلّه', dayNames: names,
              schedule: t, overridden: t.source === 'tenant',
              sub: 'ما يُحفظ هنا يسري على كل فرعٍ ومنسوبٍ لم يُوضع له جدول خاصّ.',
              extra: el('label.row.wh-unify', {}, [unify, el('span', {
                text: 'وحِّد كل الفروع على هذا الدوام — تُحذف جداولها الخاصة وتعود إلى الوراثة' })]),
              unify: () => unify.checked,
              onDone: reload
            });
          }
        }),
        el('span.hint', { text: 'الجداول الخاصة الآن: '
          + counted(data.branches.filter(b => b.overridden).length,
            { one: 'فرعٌ واحد', two: 'فرعان', few: 'فروع', many: 'فرعاً' })
          + ' · '
          + counted(data.users.filter(u => u.overridden).length,
            { one: 'منسوبٌ واحد', two: 'منسوبان', few: 'منسوبين', many: 'منسوباً' }) })
      ]) : null
    ], { icon: 'landmark' }));

    /* ── دوام الفروع ── */
    box.append(card('دوام الفروع', table([
      { header: 'الفرع', key: 'name', render: r => el('div', {}, [
        el('div', { text: r.name, style: { fontWeight: '600', fontSize: '12.5px' } }),
        el('small', { text: r.code, style: { color: 'var(--text-3)', fontSize: '11px' } })
      ]) },
      { header: 'الجدول', key: 's', render: r => el('span', { text: r.schedule.summary, style: { fontSize: '12.5px' } }) },
      { header: 'الأسبوع', key: 'w', render: r => hoursText(r.schedule.weekly_minutes) },
      { header: 'السماح', key: 'g', num: true, render: r => `${AR_NUM(r.schedule.grace_min)} د` },
      { header: 'المصدر', key: 'src', render: r => sourceChip(r.schedule, r.overridden) },
      { header: '', key: 'a', render: r => may ? el('button.btn.sm.ghost', {
        icon: 'pen-line', iconSize: 15, text: 'ضبط',
        onclick: () => openScheduleEditor({
          scope: 'branch', id: r.id, title: r.name, dayNames: names,
          schedule: r.schedule, overridden: r.overridden,
          sub: r.overridden
            ? 'لهذا الفرع جدولٌ خاصّ. وحذفُه يعيده إلى دوام المجمّع.'
            : 'يرث هذا الفرع دوام المجمّع الآن — والحفظ هنا يجعل له جدولاً خاصاً.',
          onDone: reload
        })
      }) : '—' }
    ], data.branches, { emptyText: 'لا توجد فروع ضمن نطاقك' }), { p0: true, icon: 'building-2' }));

    /* ── استثناءات المنسوبين ── */
    box.append(peopleCard(data, names, may, reload));
  };

  clear(box).append(skeleton(6));
  await reload();
  return wrap;
}

/**
 * جدول المنسوبين — بحثٌ بالاسم وتصفيةٌ بالفرع وبمن له جدولٌ خاصّ.
 * ومن له مئةُ منسوبٍ لا يقلّب القائمة بالعين ليجد المتعاون الذي دوامه يومان.
 */
function peopleCard(data, names, may, reload) {
  const search = searchInput({ placeholder: 'بحث باسم المنسوب أو مسمّاه...' });
  const branchSel = select(
    [{ value: '', label: 'كل الفروع' }, ...data.branches.map(b => ({ value: String(b.id), label: b.name }))],
    { style: { maxWidth: '190px' } });
  const onlyOwn = select([
    { value: '', label: 'الجميع' },
    { value: '1', label: 'من له جدول خاصّ' },
    { value: '0', label: 'من يرث جدوله' }
  ], { style: { maxWidth: '170px' } });
  const body = el('div');

  const draw = () => {
    const q = search.field.value.trim().toLowerCase();
    const rows = data.users.filter(u => {
      if (q && !`${u.name} ${u.job_title || ''} ${u.employee_no || ''}`.toLowerCase().includes(q)) return false;
      if (branchSel.value && String(u.branch_id || '') !== branchSel.value) return false;
      if (onlyOwn.value === '1' && !u.overridden) return false;
      if (onlyOwn.value === '0' && u.overridden) return false;
      return true;
    });
    clear(body).append(table([
      { header: 'المنسوب', key: 'name', render: r => el('div', {}, [
        el('div', { text: r.name, style: { fontWeight: '600', fontSize: '12.5px' } }),
        el('small', { text: [r.job_title, r.branch_name].filter(Boolean).join(' · ') || '—',
          style: { color: 'var(--text-3)', fontSize: '11px' } })
      ]) },
      { header: 'الجدول', key: 's', render: r => el('span', { text: r.schedule.summary, style: { fontSize: '12.5px' } }) },
      { header: 'الأسبوع', key: 'w', render: r => hoursText(r.schedule.weekly_minutes) },
      { header: 'السماح', key: 'g', num: true, render: r => `${AR_NUM(r.schedule.grace_min)} د` },
      { header: 'المصدر', key: 'src', render: r => r.overridden
        ? chip('جدول خاصّ', 'brand', 'pen-line')
        : chip(r.schedule.source === 'branch' ? 'من فرعه' : 'من المجمّع', '', 'arrow-down') },
      { header: '', key: 'a', render: r => may ? el('button.btn.sm.ghost', {
        icon: 'pen-line', iconSize: 15, text: 'ضبط',
        onclick: () => openScheduleEditor({
          scope: 'user', id: r.user_id, title: r.name, dayNames: names,
          schedule: r.schedule, overridden: r.overridden,
          sub: r.overridden
            ? 'لهذا المنسوب جدولٌ خاصّ يعلو جدول فرعه. وحذفُه يعيده إلى ما يرثه.'
            : `يرث الآن ${r.schedule.source === 'branch' ? 'جدول فرعه' : 'جدول المجمّع'} — والحفظ هنا يجعل له جدولاً خاصاً به وحده.`,
          onDone: reload
        })
      }) : '—' }
    ], rows, { emptyText: 'لا يوجد منسوبون مطابقون' }));
  };

  const redraw = debounce(draw, 160);
  search.field.addEventListener('input', redraw);
  [branchSel, onlyOwn].forEach(n => n.addEventListener('change', draw));
  draw();

  return card('دوام المنسوبين', [
    el('div.hint', { text: 'لكل منسوبٍ أن يُفرَد بأيامه وساعاته — المتعاون، والمعلم المسائي، ومن دوامه يومان في الأسبوع.' }),
    el('div.row', { style: { margin: '11px 0' } }, [search, branchSel, onlyOwn]),
    body
  ], { icon: 'users', p0: false });
}

export default { schedulesTab, openScheduleEditor, hoursText };
