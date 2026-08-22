import api from '../api.js';
import { state, can } from '../state.js';
import { el, clear, card, chip, empty, table, toast, progressBar, AR_NUM, pct, avatar, skeleton } from '../util.js';
import { T } from '../util.js';

export async function render() {
  const body = el('div');
  const load = async () => {
    clear(body).append(skeleton(5));
    const d = await api.get('/api/forms/kpi/overview');
    const totalTasks = Object.values(d.task_stats).reduce((a, b) => a + b, 0);
    const done = d.task_stats.done || 0;
    const rate = totalTasks ? Math.round(done * 100 / totalTasks) : 0;

    clear(body).append(
      el('div.grid.g4', {}, [
        el('div.stat.ok', {}, [el('div.label', { text: 'نسبة إنجاز المهام' }), el('div.value', { text: pct(rate) }),
          el('div.hint', { text: `${AR_NUM(done)} من ${AR_NUM(totalTasks)}` })]),
        el('div.stat.danger', {}, [el('div.label', { text: 'مهام متأخرة' }), el('div.value', { text: AR_NUM(d.overdue) })]),
        el('div.stat.gold', {}, [el('div.label', { text: 'متوسط التقييم' }),
          el('div.value', { text: d.evaluation.avg !== null ? pct(d.evaluation.avg) : '—' }),
          el('div.hint', { text: `${AR_NUM(d.evaluation.count)} تقييم` })]),
        el('div.stat.info', {}, [el('div.label', { text: 'المنسوبون المقيَّمون' }), el('div.value', { text: AR_NUM(d.leaderboard.filter(k => k.user_id).length) })])
      ]),
      card('توزيع حالات المهام', el('div.bars', {}, ['todo', 'in_progress', 'review', 'done', 'blocked'].map(s => {
        const max = Math.max(1, ...Object.values(d.task_stats));
        return el('div.bar-col', {}, [
          el('div.bar', {
            style: {
              height: Math.round(((d.task_stats[s] || 0) / max) * 100) + '%',
              background: { todo: 'var(--text-3)', in_progress: 'var(--info)', review: 'var(--warn)', done: 'var(--ok)', blocked: 'var(--danger)' }[s]
            }
          }, [el('span', { text: AR_NUM(d.task_stats[s] || 0) })]),
          el('div.lb', { text: T.taskStatus[s] })
        ]);
      }))),
      card('🏆 لوحة مؤشرات الأداء', table([
        { header: '#', key: 'r', render: (r, i) => el('b', { text: i < 3 ? ['🥇', '🥈', '🥉'][i] : AR_NUM(i + 1) }) },
        { header: 'المنسوب', key: 'user_name', render: r => r.user_name
            ? el('div.row', { style: { gap: '7px', flexWrap: 'nowrap' } }, [avatar(r.user_name, 'sm'), el('span', { text: r.user_name, style: { fontSize: '12.5px' } })])
            : el('b', { text: '🧑‍🤝‍🧑 ' + (r.committee_name || '—') }) },
        { header: 'الفرع', key: 'branch_name' },
        { header: 'المهام', key: 't', render: r => `${AR_NUM(r.tasks_done)} / ${AR_NUM(r.tasks_total)}` },
        { header: 'متأخرة', key: 'tasks_overdue', num: true, render: r => r.tasks_overdue ? chip(AR_NUM(r.tasks_overdue), 'danger') : '—' },
        { header: 'نسبة الإنجاز', key: 'completion_rate', render: r => el('div.row', { style: { gap: '7px', flexWrap: 'nowrap', minWidth: '110px' } }, [
            progressBar(r.completion_rate, r.completion_rate >= 70 ? 'ok' : r.completion_rate >= 40 ? 'gold' : 'danger'),
            el('span', { text: pct(r.completion_rate), style: { fontSize: '11.5px' } })]) },
        { header: 'الحضور', key: 'attendance_rate', num: true, render: r => r.attendance_rate ? pct(r.attendance_rate) : '—' },
        { header: 'التقييم', key: 'eval_avg', num: true, render: r => r.eval_avg ? pct(r.eval_avg) : '—' },
        { header: 'المؤشر العام', key: 'score', render: r => chip(r.score.toFixed(1), r.score >= 70 ? 'ok' : r.score >= 45 ? 'gold' : 'danger') }
      ], d.leaderboard, { emptyText: 'لم تُحتسب المؤشرات بعد' }), {
        p0: true,
        actions: can('kpi.view_all') ? el('button.btn.sm.ghost', {
          text: '🔄 إعادة الاحتساب',
          onclick: async (e) => { e.target.disabled = true; const r = await api.post('/api/forms/kpi/recompute', {}); toast(`تم تحديث ${AR_NUM(r.updated)} مؤشر`, 'ok'); load(); }
        }) : null
      })
    );
  };
  await load();
  return el('div.stack', {}, [
    card(null, [el('div', {}, [el('h3', { text: 'مؤشرات الأداء (KPI)' }),
      el('div.hint', { text: 'تُحدَّث آلياً كل ساعة: ٥٠٪ إنجاز المهام + ٣٠٪ الحضور + ٢٠٪ التقييم، مع خصم للمهام المتأخرة.' })])]),
    body
  ]);
}
