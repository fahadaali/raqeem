import api from '../api.js';
import { state } from '../state.js';
import { el, clear, card, chip, empty, toast, T, timeAgo, skeleton, AR_NUM } from '../util.js';
import { fmtDateTime } from '../hijri.js';
import { pushStatus, subscribePush, unsubscribePush, platform, isStandalone, showIosInstallGuide } from '../push.js';
import { loadNotifications } from '../app.js';

export async function render({ navigate }) {
  const wrap = el('div.stack');
  const st = await pushStatus();

  // حالة الإشعارات على الجهاز
  const statusCard = card('إشعارات هذا الجهاز', el('div', {}, [
    el('div.row', { style: { marginBottom: '11px' } }, [
      chip(st.subscribed ? 'مفعّلة على هذا الجهاز' : 'غير مفعّلة', st.subscribed ? 'ok' : 'warn'),
      chip(platform() === 'ios' ? 'iOS' : platform() === 'android' ? 'Android' : 'سطح المكتب'),
      isStandalone() ? chip('يعمل كتطبيق مثبّت', 'brand') : chip('يعمل داخل المتصفح'),
      st.permission === 'denied' ? chip('محظورة من المتصفح', 'danger') : null
    ]),
    el('p', { style: { fontSize: '12.5px', color: 'var(--text-2)', marginTop: 0 },
      text: st.subscribed
        ? 'ستصلك تنبيهات المهام والاعتمادات المالية والرسائل فور حدوثها حتى والتطبيق مغلق.'
        : platform() === 'ios' && !isStandalone()
          ? 'على الآيفون يجب إضافة المنصة إلى الشاشة الرئيسية أولاً حتى تعمل الإشعارات (iOS 16.4 فأحدث).'
          : 'فعّل الإشعارات لتصلك التنبيهات المهمة فور حدوثها.' }),
    el('div.row', {}, [
      st.subscribed
        ? el('button.btn.ghost', { text: 'إيقاف الإشعارات', onclick: async (e) => { e.target.disabled = true; await unsubscribePush(); navigate('/notifications'); } })
        : el('button.btn', { icon: 'bell', iconSize: 16, text: 'تفعيل الإشعارات', onclick: async (e) => {
            e.target.disabled = true;
            if (platform() === 'ios' && !isStandalone()) { showIosInstallGuide(true); e.target.disabled = false; return; }
            const r = await subscribePush(); if (r.ok) navigate('/notifications'); else e.target.disabled = false;
          } }),
      st.subscribed ? el('button.btn.ghost', { icon: 'send', iconSize: 16, text: 'إرسال إشعار تجريبي', onclick: async (e) => {
        e.target.disabled = true;
        const r = await api.post('/api/notifications/test', {});
        toast(r.pushed ? 'أُرسل إشعار تجريبي إلى جهازك' : 'أُنشئ الإشعار داخل المنصة', 'ok');
        setTimeout(() => { e.target.disabled = false; loadNotifications(); }, 900);
      } }) : null,
      el('button.btn.ghost', { icon: 'settings', iconSize: 16, text: 'تفضيلات الإشعارات', onclick: () => navigate('/settings') })
    ])
  ]));
  wrap.append(statusCard);

  const list = el('div');
  wrap.append(card('كل الإشعارات', list, {
    p0: true,
    actions: el('button.btn.sm.ghost', { text: 'تعليم الكل كمقروء', onclick: async () => {
      await api.post('/api/notifications/read', {}); await loadNotifications(); paint();
    } })
  }));

  async function paint() {
    clear(list).append(skeleton(5));
    const d = await api.get('/api/notifications?limit=100');
    clear(list);
    if (!d.items.length) return list.append(empty('bell-off', 'لا توجد إشعارات', 'ستظهر هنا تنبيهات المهام والاعتمادات والرسائل.'));
    for (const n of d.items) {
      list.append(el('div.notif' + (n.is_read ? '' : '.unread'), {
        onclick: async () => {
          await api.post('/api/notifications/read', { ids: [n.id] }, { silent: true }).catch(() => {});
          await loadNotifications();
          if (n.url) navigate(n.url); else paint();
        }
      }, [
        el('span.ic', { icon: T.notifIcon[n.category] || 'bell' }),
        el('div.tx', {}, [
          el('b', { text: n.title }),
          n.body ? el('p', { text: n.body }) : null,
          el('div.at', { text: `${fmtDateTime(n.created_at, state.calendar)} · ${timeAgo(n.created_at)}` })
        ]),
        n.is_read ? null : chip('جديد', 'brand')
      ]));
    }
  }
  await paint();
  return wrap;
}
