/**
 * تدقيق التوصيل: كل بند من المستويات الأربعة له مسار في الخادم *و* واجهة تستدعيه.
 *
 * السبب: تدقيق الواجهة البرمجية وحده لا يكشف مساراً بُني ولم تُبنَ له شاشة —
 * فيبدو كل شيء ناجحاً بينما القدرة غير متاحة للمستخدم أصلاً. هذا الفحص يقرأ
 * المصدر ويقارن الطرفين، ولا يحتاج خادماً يعمل.
 *
 *   node scripts/verify-wiring.js
 */
import { readFileSync } from 'node:fs';
const R = (p) => readFileSync(p, 'utf8');

const platform  = R('web/js/views/admin/sections.js') + R('web/js/admin-shell.js');
const chatUI    = R('web/js/views/chat.js');
const hoursUI   = R('web/js/views/workhours.js') + R('web/js/views/hr.js');
const billing   = R('web/js/views/billing.js');
const settings  = R('web/js/views/settings.js');
const tickets   = R('web/js/views/tickets.js');
const login     = R('web/js/views/login.js');
const app       = R('web/js/app.js');
const routes    = R('server/core/routes/admin.js');
const landing   = R('web/js/views/landing.js');
const bRoutes   = R('server/core/routes/billing.js');
const aRoutes   = R('server/core/routes/auth.js');
const cRoutes   = R('server/core/routes/comms.js');
const ALLUI = platform + billing + settings + tickets + login + app + landing + chatUI + hoursUI;
const ALLSRV = routes + bRoutes + aRoutes + cRoutes + R('server/core/routes/hr.js') + R('server/core/workhours.js')
  + R('server/core/http.js') + R('server/core/sql.js')
  + R('server/core/zatca.js') + R('server/core/health.js') + R('server/core/billing.js')
  + R('server/core/coupons.js') + R('server/core/announce.js') + R('server/core/payments.js')
  + R('server/core/features.js') + R('server/core/security.js') + R('server/core/jobs/backup.js')
  + R('server/core/routes/public.js') + R('server/core/landing.js')
  + R('server/core/provision.js') + R('server/core/term-templates.js');

let pass = 0, fail = 0;
const check = (level, item, srvNeedle, uiNeedle) => {
  const s = Array.isArray(srvNeedle) ? srvNeedle.every(n => ALLSRV.includes(n)) : ALLSRV.includes(srvNeedle);
  const u = uiNeedle === null ? true
    : Array.isArray(uiNeedle) ? uiNeedle.every(n => ALLUI.includes(n)) : ALLUI.includes(uiNeedle);
  const okAll = s && u;
  if (okAll) pass++; else fail++;
  console.log(`  ${okAll ? '✔' : '✘'} [${level}] ${item}${okAll ? '' : `  — خادم:${s ? '✔' : '✘'} واجهة:${u ? '✔' : '✘'}`}`);
};

console.log('\n▸ اكتمال المستوى ١ — إنفاذ ما وُعِد به');
check('١', 'حارس المزايا مركّب على المسارات', ["requireFeature('tickets')", "requireFeature('chat')"], null);
check('١', 'كتالوج المزايا معروض للمالك', "router.get('/features'", 'd.features');
check('١', 'مزايا الخطة تظهر للجهة', 'FEATURES.map(f => ({ ...f, enabled', 'features');
check('١', 'لقطة مؤشرات فورية', "router.post('/metrics/snapshot'", '/api/admin/metrics/snapshot');
check('١', 'سلسلة المؤشرات التاريخية', "router.get('/metrics'", '/api/admin/metrics?days=');
check('١', 'منحنى النمو مرسوم', null, 'function sparkline');
check('١', 'سجل تشغيل الوظائف', "router.get('/jobs/runs'", '/api/admin/jobs/runs');
check('١', 'صحة الوظائف الدورية', "router.get('/jobs/health'", '/api/admin/jobs/health');
check('١', 'تشغيل وظيفة يدوياً', "router.post('/jobs/:name/run'", '/api/admin/jobs/');
check('١', 'التناسب عند تغيير الخطة', ['prorationCredit', 'paidForCurrentPeriod'], 'proration');

console.log('\n▸ اكتمال المستوى ٢ — النمو وإدارة العلاقة');
check('٢', 'تقييم صحة الجهات', "router.get('/health'", '/api/admin/health');
check('٢', 'تسميات الخطورة بالعربية', "router.get('/health/risk-labels'", 'risk_label');
check('٢', 'قائمة الجهات المعرّضة للخطر', 'at_risk:', 'at_risk');
check('٢', 'فرص الترقية', 'upsells', 'upsell');
check('٢', 'بثّ الإعلانات', "router.post('/announcements'", '/api/admin/announcements');
check('٢', 'حذف الإعلان', "router.delete('/announcements/:id'", 'announcements/${r.id}');
check('٢', 'شريط الإعلان في شاشة الجهة', 'activeBanners', 'banners');
check('٢', 'صندوق الدعم الموحّد', "router.get('/support'", '/api/admin/support');
check('٢', 'ردّ المزوّد على تذكرة', "router.post('/support/:id/reply'", 'support/${t.id}/reply');
check('٢', 'تصعيد الجهة تذكرةً للمزوّد', "router.post('/tickets/:id/escalate-vendor'", 'escalate-vendor');
check('٢', 'ردّ المزوّد يظهر للجهة', 'vendor_reply', 'VENDOR_STATE');
check('٢', 'ملاحظات الجهة', "router.post('/tenants/:id/notes'", '/notes');
check('٢', 'متابعة العلاقة التجارية', "router.put('/tenants/:id/crm'", '/crm');

console.log('\n▸ اكتمال المستوى ٣ — الامتثال والأمن');
check('٣', 'ختم ZATCA على الفاتورة', 'stampZatca', null);
check('٣', 'رمز QR بترميز TLV', ['buildQR', 'decodeQR'], 'رمز QR');
check('٣', 'مستند UBL 2.1', 'buildUBL', '/xml');
check('٣', 'سلسلة تجزئة الفواتير', "router.get('/einvoice/chain'", '/api/admin/einvoice/chain');
check('٣', 'تفاصيل الفاتورة الإلكترونية للمالك', "router.get('/einvoice/:id'", null);
check('٣', 'الفاتورة الإلكترونية للجهة', "router.get('/invoices/:id/einvoice'", '/einvoice');
check('٣', 'بدء التحقّق بخطوتين', "router.post('/2fa/setup'", '/api/auth/2fa/setup');
check('٣', 'تفعيل التحقّق بخطوتين', "router.post('/2fa/enable'", '/api/auth/2fa/enable');
check('٣', 'إلغاء التحقّق بخطوتين', "router.post('/2fa/disable'", '/api/auth/2fa/disable');
check('٣', 'رموز الاسترداد', 'generateBackupCodes', 'backup_codes');
check('٣', 'حقل الرمز في شاشة الدخول', "code: 'TOTP_REQUIRED'", 'TOTP_REQUIRED');
check('٣', 'إلزام مدراء المنصة', 'require_2fa_admins', 'require_2fa_admins');
check('٣', 'تقرير محاولات الدخول', "router.get('/security'", '/api/admin/security');
check('٣', 'تصدير بيانات جهة', "router.get('/tenants/:id/export'", '/export');

console.log('\n▸ اكتمال المستوى ٤ — عمق الفوترة');
check('٤', 'إنشاء كوبون', "router.post('/coupons'", '/api/admin/coupons');
check('٤', 'تحرير وتعطيل الكوبون', "router.patch('/coupons/:id'", 'coupons/${coupon.id}');
check('٤', 'حذف الكوبون', "router.delete('/coupons/:id'", 'coupons/${r.id}');
check('٤', 'تقرير أداء الكوبونات', 'couponsReport', 'total_discount');
check('٤', 'الجهة تفعّل كوبوناً', "router.post('/coupon'", '/api/billing/coupon');
check('٤', 'الجهة تزيل الكوبون', "router.delete('/coupon'", null);
check('٤', 'إشعار دائن', "router.post('/invoices/:id/credit-note'", 'credit-note');
check('٤', 'بوابات الدفع', "router.get('/gateways'", '/api/admin/gateways');
check('٤', 'الدفع الإلكتروني للجهة', "router.post('/invoices/:id/pay'", '/pay');
check('٤', 'إشعار البوابة', 'paymentWebhook', null);
check('٤', 'تجاوزات الحدود والمزايا', "router.put('/tenants/:id/overrides'", '/overrides');
check('٤', 'بيانات المشتري والرقم الضريبي', "router.put('/billing-entity'", 'billing-entity');
check('٤', 'رقم أمر الشراء', 'po_number', 'po_number');

console.log('\n▸ اكتمال المرحلة ٣ — الشاشة الرئيسية العامة');
check('٣', 'قراءة عامة للشاشة الرئيسية', "router.get('/landing'", '/api/public/landing');
check('٣', 'تحرير الشاشة من اللوحة', "router.put('/landing'", '/api/admin/landing');
check('٣', 'تطهير روابط المحتوى العام', 'export function safeHref', null);
check('٣', 'مفتاح النشر يفصل التحرير عن العرض', 'enabled: !!b.enabled', 'منشورة للزوّار');
check('٣', 'الصفحة العامة مربوطة بالجذر', null, 'landingPublished');
check('٣', 'محرّر الشاشة في قائمة اللوحة', null, "'/admin/landing'");

console.log('\n▸ اكتمال المرحلة ٤ — قوالب الفصول');
check('٤', 'قوالب الفصول تُقرأ وتُنشأ', ["router.get('/terms'", "router.post('/terms'"], '/api/admin/terms');
check('٤', 'تحرير القالب وحذفه', ["router.patch('/terms/:id'", "router.delete('/terms/:id'"], 'terms/${row.id}');
check('٤', 'فرض القالب على المجمّعات', "router.post('/terms/:id/apply'", '/apply');
check('٤', 'الإنشاء يقرأ القوالب لا فصلاً مكتوباً', 'termsForNewTenant', null);
check('٤', 'المعاينة تُقرأ من الخادم', 'preview: expandTemplate', 'r.preview.start_date');
check('٤', 'فصول المجمّع ظاهرة في اللوحة', 'terms: terms.map', 'الفصول الدراسية');
check('٤', 'شاشة القوالب في قائمة اللوحة', null, "'/admin/terms'");

console.log('\n▸ اكتمال أوقات الدوام — أيامٌ وساعاتٌ يُقاس عليها التأخّر والمسير');
check('دوام', 'ثلاث طبقاتٍ ترث بعضها', ['effectiveSchedule', "scope='user'", "scope='branch'"], null);
check('دوام', 'اللوحة تقرأ الجداول الثلاثة', "router.get('/schedules'", '/api/hr/schedules');
check('دوام', 'ضبط دوام المجمّع أو فرعٍ أو منسوب', "router.put('/schedules'", "scope: 'branch'");
check('دوام', 'تعديل جدول كل موظف على حدة', 'assertUserInScope', "scope: 'user'");
check('دوام', 'توحيد كل الفروع من لوحةٍ واحدة', 'apply_to_branches', 'apply_to_branches');
check('دوام', 'الرجوع إلى الجدول الموروث', "router.delete('/schedules/:scope/:id'", 'إعادة إلى الموروث');
check('دوام', 'التأخّر يُقاس بجدول صاحبه', ['lateMinutes(schedule', 'late_minutes'], 'late_minutes');
check('دوام', 'المسير يبني الغياب على أيام الجدول', ['workingDaysBetween', 'expected_month_days'], 'expected_days');
check('دوام', 'لوحة الدوام في شاشة الموارد البشرية', null, ["'أوقات الدوام'", 'schedulesTab']);
/* نشرُ الشيفرة قبل الترحيلة نافذةٌ حقيقية — والتحضير أوّلُ ما يسقط فيها إن لم يتنحَّ */
check('دوام', 'قراءة الجداول تتنحّى قبل تطبيق الترحيلة', ['isMissingSchema', 'readOrNull'], null);
check('دوام', 'والتحضير يُكتب بلا عمود الدقائق إن غاب', 'INSERT INTO attendance(${COLS}) VALUES', null);
check('دوام', 'وما لا يتنحّى يقول سببه لا «خطأ غير متوقع»', "code: 'SCHEMA_PENDING'", null);

console.log('\n▸ اكتمال المحادثات المستقلة — خاصّة ومجموعات');
check('محادثات', 'صندوق المحادثات', "router.get('/chats'", '/api/comms/chats');
check('محادثات', 'محادثة خاصّة ومجموعة', ["kind === 'direct'", "'group'"], "kind: 'group'");
check('محادثات', 'الدليل يحكمه تدرّج الصلاحية', ['reachableUsers', 'assertReachable'], '/api/comms/directory');
check('محادثات', 'تعديل الاسم والوصف وصورة العرض', ["router.patch('/chats/:id'", 'resolveAvatar'], 'avatar_file_id');
check('محادثات', 'إدارة الأعضاء وأدوارهم', ["router.post('/chats/:id/members'", "router.patch('/chats/:id/members/:uid'"], 'members');
check('محادثات', 'المغادرة والإخراج', "router.delete('/chats/:id/members/:uid'", 'مغادرة المجموعة');
check('محادثات', 'الرسائل الصوتية', ["'voice'", 'duration_ms'], ['MediaRecorder', "kind: 'voice'"]);
check('محادثات', 'المرفقات تُبنى من مخزن الجهة', 'resolveAttachments', 'attachment_ids');
check('محادثات', 'تحرير الرسالة وحذفها', ["router.patch('/chats/:id/messages/:mid'", "router.delete('/chats/:id/messages/:mid'"], 'تعديل الرسالة');
check('محادثات', 'عدّاد غير المقروء في الهيكل', "router.get('/unread'", ['loadChatUnread', "path: '/chat'"]);

console.log(`\n  ${fail ? '✘' : '✔'} ${pass} مكتمل · ${fail} ناقص\n`);
process.exit(fail ? 1 : 0);
