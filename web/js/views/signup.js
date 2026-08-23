import api from '../api.js';
import { el, clear, field, input, toast, AR_NUM, money } from '../util.js';

/**
 * التسجيل الآلي للجهات الجديدة.
 *
 * كان نموذجاً واحداً طويلاً: أحد عشر حقلاً وقائمتان في شاشة واحدة، يُقرأ عبئاً
 * ويُترَك قبل تمامه. صار ثلاث خطوات: الجهة ← حساب المدير ← الخطة، لا يُطلَب في
 * الواحدة إلا ما يخصّها، ولا تُفتَح التالية قبل أن تصحّ السابقة، وشريطٌ أعلى
 * الشاشة يقول أين نحن وكم بقي.
 *
 * ولا شيء يُرسَل إلى الخادم قبل الخطوة الثالثة: عقد `POST /api/public/signup`
 * كما هو، والخطوات تقسيمُ عرضٍ لا تقسيمُ طلبات.
 */

const STEPS = [
  { key: 'tenant', label: 'الجهة',       title: 'بيانات الجهة',
    why: 'اسمُ مجمّعك كما تريده أن يظهر في التقارير الرسمية.' },
  { key: 'admin',  label: 'حساب المدير', title: 'حساب مدير الجهة',
    why: 'أول حساب في مجمّعك، وبه تدعو بقية الفريق لاحقاً.' },
  { key: 'plan',   label: 'الخطة',       title: 'اختر خطتك' }
];

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

  /* ── الحقول ────────────────────────────────────────────── */
  const tenantName = input({ placeholder: 'مجمّع … لتحفيظ القرآن الكريم', required: true });
  const code = input({ placeholder: 'RQ2', dir: 'ltr', maxlength: 12, required: true,
    style: { textTransform: 'uppercase' } });
  const adminName = input({ placeholder: 'الاسم الثلاثي', required: true });
  const email = input({ type: 'email', placeholder: 'name@example.sa', dir: 'ltr', autocomplete: 'username', required: true });
  const phone = input({ placeholder: '05xxxxxxxx', dir: 'ltr' });
  const password = input({ type: 'password', autocomplete: 'new-password', required: true, placeholder: '٨ خانات فأكثر' });
  const password2 = input({ type: 'password', autocomplete: 'new-password', required: true });

  const codeHint = el('div.hint');
  const mailHint = el('div.hint');
  const msg = el('div.hint', { style: { color: 'var(--error)', minHeight: '18px' } });

  const plans = (plansData.plans || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
  /* «ريال» لا «SAR» — كما في شاشة الأسعار المجاورة في الرحلة نفسها */
  const curOf = (c) => (c === 'SAR' || !c ? 'ريال' : c);
  const cur = curOf(plansData.currency);
  const st = {
    step: 0,
    plan: params.get('plan') || platform.default_plan_code || plans[0]?.code || '',
    cycle: params.get('cycle') === 'yearly' ? 'yearly' : 'monthly',
    done: null,          /* نتيجة التسجيل — تُبدّل الشاشة كلها */
    busy: false,
    ok: { code: null, email: null }   /* آخر ردّ توفّر من الخادم */
  };
  if (!plans.some(p => p.code === st.plan)) st.plan = plans[0]?.code || '';

  /* ── فحص التوفّر ───────────────────────────────────────── */
  const probe = async (kind, node, hint) => {
    const v = node.value.trim();
    st.ok[kind] = null;
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
      st.ok[kind] = !!info.available;
      hint.style.color = info.available ? 'var(--success)' : 'var(--error)';
    } catch { hint.textContent = ''; }
  };
  code.addEventListener('blur', () => probe('code', code, codeHint));
  email.addEventListener('blur', () => probe('email', email, mailHint));

  /* اقتراح رمز من اسم الجهة */
  tenantName.addEventListener('blur', () => {
    if (code.value.trim()) return;
    const words = tenantName.value.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return;
    code.value = 'Q' + String(words.length) + String(Date.now()).slice(-3);
    code.dataset.suggested = '1';
    st.ok.code = null; codeHint.textContent = '';
  });
  /* الاقتراح يُملأ لحظةَ الانتقال إلى الحقل، فلو بقي لالتصق أوّلُ حرفٍ يكتبه
     المستخدم بذيله. فيُحدَّد كاملاً عند الدخول: أوّل حرفٍ يحلّ محلّه. */
  code.addEventListener('focus', () => { if (code.dataset.suggested) code.select(); });
  /* وتعديلُ القيمة يُبطل حكم التوفّر السابق: ما صحّ لرمزٍ لا يصحّ لغيره */
  code.addEventListener('input', () => {
    delete code.dataset.suggested; st.ok.code = null; codeHint.textContent = '';
  });
  email.addEventListener('input', () => { st.ok.email = null; mailHint.textContent = ''; });

  /* ── صحّة كل خطوة ──────────────────────────────────────
     الرسالة تُعيَّن هنا لا في زرّ التالي: من يُمنَع يستحق أن يعرف لماذا. */
  const validate = (i) => {
    if (i === 0) {
      if (!tenantName.value.trim()) return 'اكتب اسم الجهة التعليمية';
      if (!code.value.trim()) return 'اكتب رمز الجهة';
      if (st.ok.code === false) return codeHint.textContent || 'رمز الجهة غير متاح';
      return '';
    }
    if (i === 1) {
      if (!adminName.value.trim()) return 'اكتب اسم مدير الجهة';
      if (!email.value.trim()) return 'اكتب البريد الإلكتروني';
      if (st.ok.email === false) return mailHint.textContent || 'البريد غير متاح';
      if (password.value.length < 8) return 'كلمة المرور يجب ألا تقل عن ٨ خانات';
      if (password.value !== password2.value) return 'كلمتا المرور غير متطابقتين';
      return '';
    }
    if (!st.plan) return 'اختر خطةً للمتابعة';
    return '';
  };

  /* ── الإرسال ───────────────────────────────────────────── */
  const submit = async () => {
    msg.textContent = '';
    st.busy = true; paint();
    try {
      const r = await api.post('/api/public/signup', {
        code: code.value.trim(), tenant_name: tenantName.value.trim(),
        admin_name: adminName.value.trim(), email: email.value.trim(),
        phone: phone.value.trim() || null, password: password.value,
        plan_code: st.plan, cycle: st.cycle
      });

      if (r.status === 'pending_review') {
        toast(r.message, 'ok');
        return void navigate('/login');
      }
      /* الدخول يتمّ هنا، والانتقال يتركه المستخدم لاختياره في شاشة التمام */
      await api.login(email.value.trim(), password.value);
      st.done = r;
    } catch (err) {
      msg.textContent = err.message || 'تعذّر إتمام التسجيل';
      /* خطأ التوفّر يُعيد صاحبه إلى الخطوة التي يُصلحه فيها */
      if (/رمز/.test(msg.textContent)) st.step = 0;
      else if (/بريد|مرور/.test(msg.textContent)) st.step = 1;
    } finally {
      st.busy = false; paint();
    }
  };

  const go = async (d) => {
    if (d > 0) {
      /* من أدخل رمزاً أو بريداً ثم ضغط «التالي» دون مغادرة الحقل: نسأل الآن */
      if (st.step === 0 && st.ok.code === null && code.value.trim()) await probe('code', code, codeHint);
      if (st.step === 1 && st.ok.email === null && email.value.trim()) await probe('email', email, mailHint);
      const err = validate(st.step);
      if (err) { msg.textContent = err; return; }
      if (st.step === STEPS.length - 1) return submit();
    }
    msg.textContent = '';
    st.step = Math.max(0, Math.min(STEPS.length - 1, st.step + d));
    paint();
    body.scrollIntoView({ block: 'nearest' });
  };

  /* ── الرسم ─────────────────────────────────────────────── */
  const chosen = () => plans.find(p => p.code === st.plan);
  const priceOf = (p) => st.cycle === 'yearly' ? p.price_yearly : p.price_monthly;

  const rail = () => el('div.rail', {}, STEPS.flatMap((s, i) => {
    const cls = i < st.step ? '.done' : i === st.step ? '.now' : '';
    const node = el('div.node' + cls, {}, [
      el('span.bead', i < st.step ? { icon: 'check', iconSize: 17 } : { text: AR_NUM(i + 1) }),
      el('small', { text: s.label })
    ]);
    return i ? [el('div.bar' + (i <= st.step ? '.done' : '')), node] : [node];
  }));

  const pane = () => {
    const s = STEPS[st.step];
    if (st.step === 0) {
      return [
        field('اسم الجهة التعليمية', tenantName, { required: true }),
        field('رمز الجهة (إنجليزي — يظهر في الروابط والتقارير)',
          el('div', {}, [code, codeHint]), { required: true })
      ];
    }
    if (st.step === 1) {
      return [
        field('اسم المدير', adminName, { required: true }),
        el('div.grid-2', {}, [
          field('البريد الإلكتروني', el('div', {}, [email, mailHint]), { required: true }),
          field('رقم الجوال', phone)
        ]),
        el('div.grid-2', {}, [
          field('كلمة المرور', password, { required: true,
            hint: 'تُستعمل للدخول، ويُفعَّل التحقّق بخطوتين من الإعدادات لاحقاً.' }),
          field('تأكيد كلمة المرور', password2, { required: true })
        ])
      ];
    }
    const c = chosen();
    return [
      el('div.cycle-toggle', {}, [
        el('button.btn.sm' + (st.cycle === 'monthly' ? '.active' : '.ghost'),
          { type: 'button', text: 'اشتراك شهري',
            onclick: () => { st.cycle = 'monthly'; paint(); } }),
        el('button.btn.sm' + (st.cycle === 'yearly' ? '.active' : '.ghost'),
          { type: 'button', text: 'اشتراك سنوي — شهران مجاناً',
            onclick: () => { st.cycle = 'yearly'; paint(); } })
      ]),
      el('div.stack', { style: { gap: '10px' } }, plans.map(p => {
        const pr = priceOf(p);
        return el('button.plan-pick' + (p.code === st.plan ? '.on' : ''), {
          type: 'button', 'aria-pressed': String(p.code === st.plan),
          onclick: () => { st.plan = p.code; paint(); }
        }, [
          el('div.tx', {}, [
            el('div.nm', {}, [
              el('b', { text: p.name }),
              p.highlight ? el('span.plan-tag', { text: 'الأكثر اختياراً' }) : null
            ]),
            el('p', { text: p.tagline || p.description || '' })
          ]),
          el('div.price', pr
            ? {}
            : { text: 'مجانية' },
            pr ? [`${money(pr)} `, el('small', { text: `${curOf(p.currency)} / ${st.cycle === 'yearly' ? 'سنة' : 'شهر'}` })] : [])
        ]);
      })),
      el('div.summary', { style: { marginTop: '16px' } }, [
        el('div.sum-row', {}, [
          el('span.ic', { icon: 'landmark', iconSize: 16, style: { color: 'var(--primary)' } }),
          el('span', { text: 'الجهة' }),
          el('b', { text: `${tenantName.value.trim() || '—'} · ${code.value.trim() || '—'}` })
        ]),
        el('div.sum-row', {}, [
          el('span.ic', { icon: 'shield-check', iconSize: 16, style: { color: 'var(--primary)' } }),
          el('span', { text: 'الخطة' }),
          el('b', { text: c ? `${c.name} · ${st.cycle === 'yearly' ? 'سنوي' : 'شهري'}` : '—' })
        ]),
        el('div.sum-row.total', {}, [
          el('span.ic', { icon: 'receipt', iconSize: 16, style: { color: 'var(--secondary)' } }),
          el('span', { text: c?.trial_days ? 'يُخصم عليك اليوم' : 'المستحق' }),
          el('b', { text: c?.trial_days ? `${money(0)} ${cur}` : `${money(priceOf(c) || 0)} ${cur}` })
        ])
      ]),
      c?.trial_days
        ? el('p.hint', { style: { marginTop: '9px' },
            text: `تبدأ بتجربة ${AR_NUM(c.trial_days)} يوماً بلا بطاقة، ولك تغيير الخطة متى شئت دون فقد بياناتك. والأسعار لا تشمل ضريبة القيمة المضافة.` })
        : el('p.hint', { style: { marginTop: '9px' },
            text: 'لك تغيير الخطة متى شئت من شاشة الاشتراك، والأسعار لا تشمل ضريبة القيمة المضافة.' })
    ];
  };

  const donePane = () => el('div', { style: { textAlign: 'center', padding: '22px 0 8px' } }, [
    el('div.done-mark', {}, [el('span.ic', { icon: 'circle-check', iconSize: 36 })]),
    el('h3', { style: { fontSize: '23px' }, text: 'مجمّعك جاهز' }),
    el('p', { style: { fontSize: '13.5px', marginTop: '8px', maxWidth: '44ch',
      marginInline: 'auto', lineHeight: '1.85' },
      text: `أنشأنا جهة «${st.done.tenant?.name || tenantName.value.trim()}» وأدوارها وحسابك، ودخولك جاهز. `
        + 'وتنتظرك خطوات قصيرة لتجهيز الفروع والفريق وأول فصل — تجدها في صدر لوحتك.' }),
    el('div.row', { style: { gap: '10px', justifyContent: 'center', marginTop: '22px' } }, [
      /* تحميلٌ كامل لا تنقّلٌ داخلي: الجلسة أُنشئت الآن ويجب أن تُقلع بها الواجهة */
      el('button.btn.gold', { icon: 'rocket', iconSize: 16, text: 'ابدأ بأول خطوة',
        onclick: () => { location.href = '/org'; } }),
      el('button.btn.ghost', { icon: 'layout-dashboard', iconSize: 16, text: 'اذهب إلى لوحتي',
        onclick: () => { location.href = '/dashboard'; } })
    ])
  ]);

  const body = el('div.wiz');
  const head = el('div.login-brand');

  const paint = () => {
    if (st.done) {
      clear(head).append(
        el('img', { src: '/assets/brand/monogram-primary.svg', alt: '' }),
        el('h1', { text: 'تمّ التسجيل' })
      );
      clear(body).append(donePane());
      foot.hidden = true;   /* دخلَ فعلاً — فلا يُعرَض عليه الدخول ولا الخطط */
      return;
    }
    const s = STEPS[st.step];
    const c = chosen();
    clear(head).append(
      el('img', { src: '/assets/brand/monogram-primary.svg', alt: '' }),
      el('h1', { text: 'إنشاء جهة تعليمية جديدة' }),
      el('p', { text: `ابدأ خلال دقيقة${c?.trial_days ? ` — تجربة مجانية ${AR_NUM(c.trial_days)} يوماً بلا بطاقة` : ''}` })
    );
    clear(body).append(
      rail(),
      el('h3', { text: s.title }),
      s.why ? el('p.hint', { text: s.why }) : el('p.hint', {
        text: `تبدأ بتجربة${c?.trial_days ? ` ${AR_NUM(c.trial_days)} يوماً` : ''} على أي خطة، وتغيّرها متى شئت دون فقد بياناتك.` }),
      ...pane(),
      msg,
      el('div.wiz-nav', {}, [
        st.step > 0
          ? el('button.btn.ghost', { type: 'button', icon: 'arrow-right', iconSize: 16,
              text: 'السابق', disabled: st.busy, onclick: () => go(-1) })
          : el('span', { style: { width: '96px' } }),
        el('span.step-of', { text: `الخطوة ${AR_NUM(st.step + 1)} من ${AR_NUM(STEPS.length)}` }),
        st.busy
          ? el('button.btn.gold', { type: 'button', disabled: true }, [el('span.spinner'), ' جارٍ تجهيز جهتك…'])
          : el('button.btn.gold', { type: 'button', icon: 'arrow-left', iconSize: 16,
              text: st.step === STEPS.length - 1 ? 'إنشاء الجهة والبدء' : 'التالي',
              onclick: () => go(1) })
      ])
    );
    /* التركيز يتبع الخطوة: أوّل حقلٍ فيها جاهزٌ للكتابة دون بحثٍ بالفأرة */
    if (!st.busy) setTimeout(() => body.querySelector('.input:not([disabled])')?.focus(), 40);
  };

  paint();

  const foot = el('div.row', { style: { justifyContent: 'center', gap: '12px', marginTop: '10px' } }, [
    el('button.btn.sm.ghost', { icon: 'arrow-right', iconSize: 15, text: 'عرض الخطط', onclick: () => navigate('/pricing') }),
    el('button.btn.sm.ghost', { text: 'لديّ حساب — تسجيل الدخول', onclick: () => navigate('/login') })
  ]);
  return el('div.public-wrap', {}, [
    el('div.login-card.wide', {}, [head, body]),
    foot
  ]);
}
