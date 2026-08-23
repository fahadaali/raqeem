import api from '../api.js';
import { el, field, input, select, toast, AR_NUM, chip } from '../util.js';

/**
 * التسجيل الآلي للجهات الجديدة (Onboarding — المرحلة الثانية).
 * ثلاث خطوات: بيانات الجهة ← حساب المدير ← اختيار الخطة، ثم تجهيز فوري.
 */
export async function render({ navigate }) {
  const params = new URLSearchParams(location.search);
  const [platform, plansData] = await Promise.all([
    api.get('/api/public/platform', { silent: true }).catch(() => ({})),
    api.get('/api/public/plans', { silent: true }).catch(() => ({ plans: [] }))
  ]);

  if (!platform.signup_enabled) {
    return el('div.public-wrap', {}, [
      el('div.login-card', {}, [
        el('div.empty', {}, [
          el('span.ic', { icon: 'lock', iconSize: 'card' }),
          el('h4', { text: 'التسجيل الذاتي مغلق حالياً' }),
          el('p', { text: 'تواصل مع إدارة المنصة لفتح حساب جهتك التعليمية.' }),
          platform.support_email ? el('a.btn.ghost', { href: `mailto:${platform.support_email}`, text: platform.support_email, dir: 'ltr' }) : null,
          el('button.btn', { text: 'العودة لتسجيل الدخول', onclick: () => navigate('/login') })
        ])
      ])
    ]);
  }

  const tenantName = input({ placeholder: 'مجمّع … لتحفيظ القرآن الكريم', required: true });
  const code = input({ placeholder: 'RQ2', dir: 'ltr', maxlength: 12, required: true,
    style: { textTransform: 'uppercase' } });
  const adminName = input({ placeholder: 'الاسم الثلاثي', required: true });
  const email = input({ type: 'email', placeholder: 'name@example.sa', dir: 'ltr', autocomplete: 'username', required: true });
  const phone = input({ placeholder: '05xxxxxxxx', dir: 'ltr' });
  const password = input({ type: 'password', autocomplete: 'new-password', required: true, placeholder: '٨ خانات فأكثر' });
  const password2 = input({ type: 'password', autocomplete: 'new-password', required: true });

  const plans = plansData.plans || [];
  const planSel = select(plans.map(p => ({ value: p.code, label: `${p.name} — ${p.price_monthly ? AR_NUM(p.price_monthly) + ' ر.س/شهر' : 'مجانية'}` })),
    { value: params.get('plan') || platform.default_plan_code || plans[0]?.code });
  const cycleSel = select([{ value: 'monthly', label: 'اشتراك شهري' }, { value: 'yearly', label: 'اشتراك سنوي (شهران مجاناً)' }],
    { value: params.get('cycle') === 'yearly' ? 'yearly' : 'monthly' });

  const codeHint = el('div.hint');
  const mailHint = el('div.hint');
  const msg = el('div.hint', { style: { color: 'var(--danger)', minHeight: '18px' } });
  const btn = el('button.btn.lg.block.gold', { type: 'submit', text: 'إنشاء الجهة والبدء' });

  const probe = async (kind, node, hint) => {
    const v = node.value.trim();
    if (!v) { hint.textContent = ''; return; }
    try {
      const r = await api.get(`/api/public/signup/availability?${kind}=${encodeURIComponent(v)}`, { silent: true });
      const info = r[kind];
      if (kind === 'code') {
        node.value = info.code;
        hint.textContent = info.available ? 'الرمز متاح'
          : (info.reserved ? 'الرمز محجوز للمنصة' : 'الرمز مستخدم مسبقاً');
      } else {
        hint.textContent = info.invalid ? 'صيغة البريد غير صحيحة'
          : (info.available ? 'البريد متاح' : 'البريد مسجّل مسبقاً');
      }
      /* التوفّر يُعرَف من الاستجابة نفسها لا من نصّ الرسالة */
      hint.style.color = info.available ? 'var(--success)' : 'var(--error)';
    } catch { hint.textContent = ''; }
  };
  code.addEventListener('blur', () => probe('code', code, codeHint));
  email.addEventListener('blur', () => probe('email', email, mailHint));

  /* اقتراح رمز من اسم الجهة */
  tenantName.addEventListener('blur', () => {
    if (code.value.trim()) return;
    const words = tenantName.value.trim().split(/\s+/).filter(Boolean);
    if (words.length) code.value = 'Q' + String(words.length) + String(Date.now()).slice(-3);
  });

  const submit = async (e) => {
    e?.preventDefault();
    msg.textContent = '';
    if (password.value !== password2.value) { msg.textContent = 'كلمتا المرور غير متطابقتين'; return; }
    if (password.value.length < 8) { msg.textContent = 'كلمة المرور يجب ألا تقل عن ٨ خانات'; return; }

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = ''; btn.append(el('span.spinner'), document.createTextNode(' جارٍ تجهيز جهتك...'));
    try {
      const r = await api.post('/api/public/signup', {
        code: code.value.trim(), tenant_name: tenantName.value.trim(),
        admin_name: adminName.value.trim(), email: email.value.trim(),
        phone: phone.value.trim() || null, password: password.value,
        plan_code: planSel.value, cycle: cycleSel.value
      });

      if (r.status === 'pending_review') {
        toast(r.message, 'ok');
        return void navigate('/login');
      }
      toast('تم إنشاء جهتك — جارٍ تسجيل الدخول', 'ok');
      await api.login(email.value.trim(), password.value);
      location.href = '/';
    } catch (err) {
      msg.textContent = err.message || 'تعذّر إتمام التسجيل';
      btn.disabled = false; btn.textContent = label;
    }
  };

  const chosen = plans.find(p => p.code === planSel.value);

  return el('div.public-wrap', {}, [
    el('div.login-card.wide', {}, [
      el('div.login-brand', {}, [
        el('img', { src: '/assets/brand/monogram-primary.svg', alt: '' }),
        el('h1', { text: 'إنشاء جهة تعليمية جديدة' }),
        el('p', { text: `ابدأ خلال دقيقة${chosen?.trial_days ? ` — تجربة مجانية ${AR_NUM(chosen.trial_days)} يوماً بلا بطاقة` : ''}` })
      ]),
      el('form', { onsubmit: submit, novalidate: true }, [
        el('h4.form-sec', {}, [el('span.n', { text: '١' }), 'بيانات الجهة']),
        field('اسم الجهة التعليمية', tenantName, { required: true }),
        field('رمز الجهة (إنجليزي — يظهر في الروابط)', el('div', {}, [code, codeHint]), { required: true }),

        el('h4.form-sec', {}, [el('span.n', { text: '٢' }), 'حساب مدير الجهة']),
        field('اسم المدير', adminName, { required: true }),
        field('البريد الإلكتروني', el('div', {}, [email, mailHint]), { required: true }),
        field('رقم الجوال', phone),
        el('div.grid-2', {}, [
          field('كلمة المرور', password, { required: true }),
          field('تأكيد كلمة المرور', password2, { required: true })
        ]),

        el('h4.form-sec', {}, [el('span.n', { text: '٣' }), 'الخطة']),
        el('div.grid-2', {}, [field('الخطة', planSel), field('دورة الاشتراك', cycleSel)]),
        el('p.hint', { text: 'يمكنك تغيير الخطة في أي وقت من شاشة الاشتراك، والأسعار لا تشمل ضريبة القيمة المضافة.' }),

        btn, msg
      ]),
      el('div.row', { style: { justifyContent: 'center', gap: '12px', marginTop: '10px' } }, [
        el('button.btn.sm.ghost', { text: '‹ عرض الخطط', onclick: () => navigate('/pricing') }),
        el('button.btn.sm.ghost', { text: 'لديّ حساب — تسجيل الدخول', onclick: () => navigate('/login') })
      ])
    ])
  ]);
}
