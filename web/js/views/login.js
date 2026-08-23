import api from '../api.js';
import { el, field, input, toast, qs } from '../util.js';

const DEMO = [
  ['مدير المجمّع', 'admin@riyadh-qu.sa', 'Admin@123'],
  ['مدير فرع', 'branch1@riyadh-qu.sa', 'Branch@123'],
  ['مشرف تربوي', 'supervisor@riyadh-qu.sa', 'Super@123'],
  ['المحاسب', 'finance@riyadh-qu.sa', 'Finance@123'],
  ['الموارد البشرية', 'hr@riyadh-qu.sa', 'Hr@123456'],
  ['رئيس لجنة', 'committee@riyadh-qu.sa', 'Lead@123'],
  ['معلم', 'teacher@riyadh-qu.sa', 'Teach@123'],
  ['موظف', 'employee@riyadh-qu.sa', 'Emp@1234'],
  ['الدعم الفني', 'support@riyadh-qu.sa', 'Support@123'],
  ['المدقق', 'auditor@riyadh-qu.sa', 'Audit@123']
];

export async function render({ onSuccess, navigate }) {
  /* هوية النطاق وحالة طبقة الـ SaaS — تُقرأ من قاعدة البيانات لا من الكود */
  const brand = await api.get('/api/public/brand', { silent: true }).catch(() => null);
  const platform = await api.get('/api/public/platform', { silent: true }).catch(() => null);
  const tenant = brand?.tenant || null;
  const saas = !!brand?.platform?.saas_enabled;

  /* تخصيص الجهة يُبدّل توكنَي الهوية لا قيماً متفرّقة، فيسري على كل الشاشة */
  if (tenant?.colors?.primary) {
    document.documentElement.style.setProperty('--primary', tenant.colors.primary);
    if (tenant.colors.accent) document.documentElement.style.setProperty('--secondary', tenant.colors.accent);
  }

  const email = input({ type: 'email', name: 'email', placeholder: 'name@riyadh-qu.sa', autocomplete: 'username', required: true, dir: 'ltr' });
  const pass = input({ type: 'password', name: 'password', placeholder: '••••••••', autocomplete: 'current-password', required: true });
  const totp = input({ dir: 'ltr', inputmode: 'numeric', maxlength: 6, placeholder: '******',
    style: { textAlign: 'center', letterSpacing: '6px' } });
  const totpField = field('رمز التحقّق بخطوتين', totp, { hint: 'من تطبيق المصادقة، أو أحد رموز الاسترداد' });
  totpField.hidden = true;
  const btn = el('button.btn.lg.block.gold', { type: 'submit', text: 'تسجيل الدخول' });
  const msg = el('div.hint', { style: { color: 'var(--danger)', textAlign: 'center', minHeight: '18px' } });

  const submit = async (e) => {
    e?.preventDefault();
    if (!email.value || !pass.value) { msg.textContent = 'يرجى إدخال البريد وكلمة المرور'; return; }
    btn.disabled = true; msg.textContent = '';
    const original = btn.textContent;
    btn.textContent = ''; btn.append(el('span.spinner'), document.createTextNode(' جارٍ التحقق...'));
    try {
      await api.login(email.value.trim(), pass.value, totpField.hidden ? undefined : totp.value.trim());
      toast('مرحباً بك في منصة رقيم', 'ok');
      await onSuccess();
    } catch (err) {
      /* الحساب يطلب طبقة ثانية — نُظهر حقل الرمز ولا نُفرغ كلمة المرور */
      if (err.code === 'TOTP_REQUIRED') {
        totpField.hidden = false;
        msg.textContent = '';
        btn.disabled = false; btn.textContent = original;
        totp.focus();
        return;
      }
      msg.textContent = err.message || 'تعذّر تسجيل الدخول';
      btn.disabled = false; btn.textContent = original;
      if (!totpField.hidden) { totp.value = ''; totp.focus(); }
      else { pass.value = ''; pass.focus(); }
    }
  };

  const form = el('form', { onsubmit: submit, novalidate: true }, [
    field('البريد الإلكتروني', email, { required: true }),
    field('كلمة المرور', pass, { required: true }),
    totpField, btn, msg
  ]);

  const demoGrid = el('div.demo-grid', {}, DEMO.map(([role, e, p]) =>
    el('button.demo-btn', {
      type: 'button',
      onclick: () => { email.value = e; pass.value = p; submit(); }
    }, [el('b', { text: role }), 'دخول تجريبي'])
  ));

  return el('div.login-wrap', {}, [
    el('div.login-card', {}, [
      el('div.login-brand', {}, [
        el('img', { src: tenant?.logo_url || '/assets/brand/monogram-primary.svg', alt: '' }),
        el('h1', { text: tenant?.name || brand?.platform?.name || 'منصة رقيم' }),
        el('p', { text: tenant
          ? (brand?.platform?.tagline || 'الإدارة المتكاملة لمجمعات تحفيظ القرآن الكريم')
          : (brand?.platform?.tagline || 'الإدارة المتكاملة لمجمعات تحفيظ القرآن الكريم') })
      ]),
      form,
      saas ? el('div.row', { style: { justifyContent: 'center', gap: '10px', marginTop: '14px' } }, [
        el('button.btn.sm.ghost', { type: 'button', text: 'عرض خطط الاشتراك',
          onclick: () => navigate?.('/pricing') }),
        platform?.signup_enabled
          ? el('button.btn.sm', { type: 'button', text: 'إنشاء جهة جديدة',
              onclick: () => navigate?.('/signup') }) : null
      ]) : null,
      /* لا تظهر إلا حين يأذن بها الخادم صراحةً — أي على نسخة تطوير فقط */
      (!saas && platform?.demo_logins) ? el('div.login-demo', {}, [
        el('h4', { text: 'حسابات تجريبية — اختر دوراً لتجربة صلاحياته' }),
        demoGrid
      ]) : null
    ])
  ]);
}
