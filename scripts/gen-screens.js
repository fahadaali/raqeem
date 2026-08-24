/**
 * يلتقط لقطات الشاشة الرئيسية من المنصّة نفسها — `npm run gen:screens`
 *
 * اللقطات في `web/assets/screens/` ليست رسوماً تخيّلية بل الواجهةُ العاملة على
 * بيانات التجربة، ولذلك تُولَّد بأمرٍ لا تُلتقط باليد: تشيخ اللقطة كلّما تغيّرت
 * شاشة، ومن التقطها بيده لا يعيد اثنتي عشرة لقطةً في وضعين.
 *
 * وثلاثة عروضٍ لكل لقطة (٩٦٠ · ١٤٤٠ · ٢١٦٠) لأن الصفحة الرئيسية تُقرأ على الجوال
 * كما تُقرأ على شاشةٍ كبيرة: `srcset` يُنزّل ما يناسب الجهاز لا أعرضَ ما وُلِّد.
 * والأوسط بلا لاحقةٍ في اسمه — فهو `src` الافتراضي الذي تعرفه الكتل المحفوظة.
 *
 * التشغيل:
 *   npm start                 # في طرفيةٍ أخرى — التوليد يحتاج خادماً يعمل
 *   npm run gen:screens
 *
 * المتغيرات:
 *   BASE            عنوان الخادم (افتراضاً http://localhost:3000)
 *   SHOT_EMAIL      حساب الالتقاط (افتراضاً حساب مدير المجمّع في بيانات التجربة)
 *   SHOT_PASSWORD
 *   SHOT_FONTS      ملف CSS يحلّ محلّ خطوط قوقل — للتوليد بلا إنترنت
 *   SHOT_BROWSER    مسار متصفّح كروميوم إن لم يكن المثبَّت مع Playwright
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnv } from '../server/node/env.js';

loadEnv();

const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.SHOT_EMAIL || 'admin@riyadh-qu.sa';
const PASSWORD = process.env.SHOT_PASSWORD || 'Admin@123';
const DIR = path.join(ROOT, 'web/assets/screens');

/* عرض الالتقاط ونسبته — ١٦:١٠ كنسبة الشاشات، ومضاعفُ ثلاثةٍ يعطي أوسعَ عرضٍ نحتاجه */
const VIEW = { width: 1440, height: 900 };
const SCALE = 3;
/* الأوسط أوّلاً: هو الملف بلا لاحقة، وعليه يقع `src` حين لا يقرأ المتصفّح `srcset` */
const WIDTHS = [1440, 960, 2160];
const QUALITY = 0.9;

/**
 * الشاشات الملتقطة.
 *
 * `tab` اسمُ تبويبٍ داخل الشاشة يُضغط قبل الالتقاط — الشاشة قد تفتح على تبويبٍ
 * ليس أدلَّ ما فيها (الموارد البشرية تفتح على «حضوري» وأدلُّها ملفات الموظفين).
 */
const SCREENS = [
  { key: 'dashboard', route: '/dashboard' },
  { key: 'approvals', route: '/approvals' },
  { key: 'tasks',     route: '/tasks' },
  { key: 'checkin',   route: '/checkin' },
  { key: 'finance',   route: '/finance' },
  { key: 'hr',        route: '/hr', tab: 'ملفات الموظفين' },
  { key: 'kpi',       route: '/kpi' },
  { key: 'audit',     route: '/audit' }
];

const THEMES = ['light', 'dark'];

/* ── المتصفّح: تبعيةٌ للتوليد وحده، فلا تُثقَّل بها كل تثبيتة ── */
async function loadPlaywright() {
  try { return (await import('playwright')).chromium; }
  catch {
    console.error('\n  ✘ يحتاج التوليد متصفّحاً آلياً — ثبّته مرّةً واحدة:\n'
      + '      npm i -D playwright && npx playwright install chromium\n');
    process.exit(1);
  }
}

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });
  if (!r.ok) throw new Error(`تعذّر الدخول بـ ${EMAIL} — تأكّد أن الخادم يعمل وأن البيانات التجريبية مُعبّأة`);
  return r.json();
}

/**
 * الترميز داخل المتصفّح نفسه.
 *
 * كروميوم يحمل مرمّز WebP ومقيّاساً عالي الجودة، فلا حاجة إلى مكتبة صور تُضاف
 * إلى الاعتماديات لتفعل ما يفعله المتصفّح الذي نلتقط به أصلاً.
 */
const ENCODE = async ([dataUrl, widths, quality]) => {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const out = [];
  for (const w of widths) {
    const h = Math.round((bmp.height / bmp.width) * w);
    const cv = new OffscreenCanvas(w, h);
    const cx = cv.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bmp, 0, 0, w, h);
    const blob = await cv.convertToBlob({ type: 'image/webp', quality });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    out.push({ w, h, b64: btoa(s) });
  }
  return out;
};

async function main() {
  const chromium = await loadPlaywright();
  const session = await login();
  fs.mkdirSync(DIR, { recursive: true });

  /* خطوط الهوية: من الشبكة عادةً، ومن ملفٍّ محلّي حين يُطلب توليدٌ بلا إنترنت */
  const fontsCss = process.env.SHOT_FONTS ? fs.readFileSync(process.env.SHOT_FONTS, 'utf8') : null;

  const browser = await chromium.launch({
    ...(process.env.SHOT_BROWSER ? { executablePath: process.env.SHOT_BROWSER } : {}),
    args: ['--font-render-hinting=none', '--force-color-profile=srgb', '--hide-scrollbars']
  });

  const ctx = await browser.newContext({
    viewport: VIEW, deviceScaleFactor: SCALE,
    locale: 'ar-SA', timezoneId: 'Asia/Riyadh',
    /* الحركة تُطفأ: اللقطة لحظةٌ واحدة، وانتقالٌ نصفُ منتهٍ يُصوَّر ضبابياً */
    reducedMotion: 'reduce',
    /* عامل الخدمة يقدّم نسخةً مخزّنة — واللقطة تُلتقط من الشيفرة الحيّة */
    serviceWorkers: 'block'
  });
  if (fontsCss) {
    await ctx.route('https://fonts.googleapis.com/**',
      (r) => r.fulfill({ status: 200, contentType: 'text/css', body: fontsCss }));
    await ctx.route('https://fonts.gstatic.com/**', (r) => r.abort());
  }
  await ctx.addInitScript(([at, rt]) => {
    localStorage.setItem('raqeem_at', at);
    localStorage.setItem('raqeem_rt', rt);
    localStorage.setItem('raqeem_cal', 'hijri');
  }, [session.accessToken, session.refreshToken]);

  const page = await ctx.newPage();
  const coder = await ctx.newPage();
  await coder.goto('about:blank');

  let bytes = 0;
  for (const theme of THEMES) {
    await page.addInitScript((t) => localStorage.setItem('raqeem_theme', t), theme);
    for (const s of SCREENS) {
      await page.goto(`${BASE}${s.route}`, { waitUntil: 'networkidle' });
      if (s.tab) {
        const tab = page.locator('.tab', { hasText: s.tab }).first();
        await tab.click({ timeout: 10_000 });
      }
      await page.evaluate(() => document.fonts.ready);
      /* شاشةُ الإقلاع تنزاح والبطاقات تصل تباعاً — فتُترك تستقرّ قبل اللقطة */
      await page.waitForTimeout(1800);

      if (!await page.evaluate(() => document.fonts.check('800 20px Zain'))) {
        console.warn(`  ⚠ خطّا الهوية لم يصلا — اللقطة بخطٍّ بديل (${s.key}/${theme})`);
      }

      const shot = await page.screenshot({ type: 'png' });
      const files = await coder.evaluate(ENCODE,
        [`data:image/png;base64,${shot.toString('base64')}`, WIDTHS, QUALITY]);

      for (const f of files) {
        /* الأوسط بلا لاحقة: هو ما تحمله الكتل المحفوظة وما يقع عليه `src` */
        const suffix = f.w === WIDTHS[0] ? '' : `-${f.w}`;
        const file = path.join(DIR, `${s.key}-${theme}${suffix}.webp`);
        const buf = Buffer.from(f.b64, 'base64');
        fs.writeFileSync(file, buf);
        bytes += buf.length;
      }
      const kb = files.map(f => Math.round(Buffer.byteLength(f.b64, 'base64') / 1024)).join('/');
      console.log(`  ✔ ${s.key}-${theme}  ${WIDTHS.join('/')}px  ${kb} ك.ب`);
    }
  }

  await browser.close();
  const count = SCREENS.length * THEMES.length * WIDTHS.length;
  console.log(`\n✔ ${count} لقطة في web/assets/screens — ${Math.round(bytes / 1024)} ك.ب\n`);
}

main().catch((e) => { console.error('\n  ✘', e.message, '\n'); process.exit(1); });
