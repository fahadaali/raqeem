import { toHijri, toGregorian } from './hijri.js';

/**
 * محرك التقارير والطباعة (البند ١٣)
 * يولّد مستنداً رسمياً مُروّساً بشعار الجهة التعليمية، بدعم عربي كامل (RTL)
 * وجداول محافظة على التنسيق. يُفتح في المتصفح ويُحفَظ PDF عبر الطباعة،
 * وهو الأسلوب الذي يضمن تشكيل الحروف العربية وربطها بشكل صحيح ١٠٠٪.
 */
const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export function buildReportHTML({
  tenant, title, subtitle = '', columns, rows, filters = [], summary = [],
  calendar = 'hijri', generatedBy = '', orientation = 'portrait'
}) {
  const now = new Date();
  const dateLine = `${toHijri(now)}  —  ${toGregorian(now)}`;
  /* ألوان الهوية: أخضر سنا أساساً، ومشمشي سنا تمييزاً — والجهة قد تُخصّصهما */
  const primary = tenant?.primary_color || '#2F8A6F';
  const accent = tenant?.accent_color || '#E8A25C';

  const logo = tenant?.logo_url
    ? `<img src="${esc(tenant.logo_url)}" alt="" class="logo">`
    /* مونوغرام رقيم كما في `web/assets/brand/monogram-primary.svg` حرفاً بحرف —
       الشعار لا يُعاد رسمه ولا تُقارَب هندسته (دليل الهوية · البند ٤). */
    : `<div class="logo-fallback" aria-hidden="true">
         <svg viewBox="0 0 64 64" width="56" height="56">
           <rect width="64" height="64" rx="19" fill="${primary}"/>
           <path d="M46 16a4 4 0 0 1 4 4v14a16 16 0 0 1-16 16H18a4 4 0 0 1-4-4v-3a4 4 0 0 1 4-4h15a6 6 0 0 0 6-6V20a4 4 0 0 1 4-4z" fill="#FBF7EF"/>
           <circle cx="19" cy="27" r="5" fill="${accent}"/>
         </svg>
       </div>`;

  const filterChips = filters.filter(f => f.value !== undefined && f.value !== null && f.value !== '')
    .map(f => `<span class="chip"><b>${esc(f.label)}:</b> ${esc(f.value)}</span>`).join('');

  const summaryCards = summary.map(s =>
    `<div class="sum"><span class="sum-label">${esc(s.label)}</span><span class="sum-value">${esc(s.value)}</span></div>`).join('');

  const head = columns.map(c => `<th style="width:${c.width || 'auto'}">${esc(c.header)}</th>`).join('');
  const body = rows.length
    ? rows.map((r, i) => `<tr><td class="idx">${i + 1}</td>${columns.map(c => {
        const v = r[c.key];
        const cls = typeof v === 'number' ? ' class="num"' : '';
        return `<td${cls}>${esc(c.format ? c.format(v, r) : v)}</td>`;
      }).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length + 1}" class="empty">لا توجد بيانات مطابقة لعوامل التصفية المحددة</td></tr>`;

  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(tenant?.name || '')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Zain:wght@700;800;900&display=swap">
<style>
  @page { size: A4 ${orientation}; margin: 14mm 12mm 16mm; }
  *{box-sizing:border-box}
  /* ألوان الهوية: قشدي #FBF7EF · حدود #EDE5D8 · حبر #22302B · نعناعي #CBE7DC */
  body{font-family:"IBM Plex Sans Arabic","Segoe UI","Tahoma",system-ui,-apple-system,"Noto Naskh Arabic",sans-serif;
       margin:0;color:#22302B;background:#FBF7EF;font-size:12.5px;line-height:1.7}
  h1,h2{font-family:"Zain","IBM Plex Sans Arabic","Segoe UI",Tahoma,sans-serif}
  .sheet{background:#fff;max-width:1000px;margin:16px auto;padding:24px 28px;
         box-shadow:0 10px 45px rgba(34,48,43,.05);border-radius:16px}
  header{display:flex;gap:16px;align-items:center;border-bottom:3px solid ${primary};padding-bottom:14px}
  .logo,.logo-fallback{width:56px;height:56px;flex:0 0 56px;border-radius:16px;overflow:hidden}
  .org h1{margin:0;font-size:22px;color:${primary};font-weight:800}
  .org p{margin:2px 0 0;font-size:11.5px;color:#8A9790}
  .doc{margin-inline-start:auto;text-align:left;font-size:11px;color:#8A9790}
  .doc b{display:block;color:${primary};font-size:13px;margin-bottom:2px}
  h2.title{margin:18px 0 4px;font-size:21px;text-align:center;color:#22302B;font-weight:800}
  p.sub{margin:0 0 14px;text-align:center;color:#8A9790;font-size:11.5px}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;justify-content:center}
  .chip{background:#CBE7DC;border:1px solid #CBE7DC;color:#1C5E4C;border-radius:999px;padding:3px 12px;font-size:10.5px}
  .sums{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 14px}
  .sum{flex:1 1 140px;border:1px solid #EDE5D8;border-radius:12px;padding:9px 12px;background:#F6F0E6}
  .sum-label{display:block;font-size:10.5px;color:#8A9790}
  .sum-value{display:block;font-family:"Zain","IBM Plex Sans Arabic",sans-serif;
             font-size:19px;font-weight:800;color:${primary};margin-top:2px}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  thead{display:table-header-group}
  th{background:${primary};color:#fff;font-weight:600;font-size:11.5px;padding:8px 6px;
     border:1px solid ${primary};text-align:center}
  td{border:1px solid #EDE5D8;padding:6px;font-size:11.5px;vertical-align:middle;color:#55645C}
  td.idx{text-align:center;color:#8A9790;width:34px}
  td.num{text-align:center;font-variant-numeric:tabular-nums}
  tbody tr:nth-child(even){background:#FBF7EF}
  tr{page-break-inside:avoid}
  .empty{text-align:center;color:#8A9790;padding:26px}
  footer{margin-top:16px;border-top:1px solid #EDE5D8;padding-top:8px;display:flex;
         justify-content:space-between;font-size:10px;color:#8A9790}
  .toolbar{max-width:1000px;margin:12px auto;display:flex;gap:8px;justify-content:flex-end}
  /* الطباعة هي الإجراء الرئيسي هنا، فتأخذ المشمشي وحدها */
  .toolbar button{background:${accent};color:#fff;border:0;border-radius:999px;padding:10px 22px;
                  font-size:13px;font-family:inherit;cursor:pointer;font-weight:600}
  .toolbar button.ghost{background:#fff;color:${primary};border:1px solid ${primary}}
  @media print{ body{background:#fff} .toolbar{display:none} .sheet{box-shadow:none;margin:0;max-width:none;padding:0;border-radius:0} }
</style></head><body>
<div class="toolbar">
  <button onclick="window.print()">طباعة / حفظ PDF</button>
  <button class="ghost" onclick="window.close()">إغلاق</button>
</div>
<div class="sheet">
  <header>
    ${logo}
    <div class="org">
      <h1>${esc(tenant?.name || 'الجهة التعليمية')}</h1>
      <p>${esc(tenant?.name_en || '')}${tenant?.code ? ' · ' + esc(tenant.code) : ''}</p>
    </div>
    <div class="doc"><b>تقرير رسمي</b>${esc(dateLine)}</div>
  </header>
  <h2 class="title">${esc(title)}</h2>
  ${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
  ${filterChips ? `<div class="chips">${filterChips}</div>` : ''}
  ${summaryCards ? `<div class="sums">${summaryCards}</div>` : ''}
  <table><thead><tr><th style="width:34px">#</th>${head}</tr></thead><tbody>${body}</tbody></table>
  <footer>
    <span>عدد السجلات: ${rows.length}</span>
    <span>${generatedBy ? 'أصدره: ' + esc(generatedBy) : ''}</span>
    <span>وُلّد آلياً من منصة رقيم</span>
  </footer>
</div>
</body></html>`;
}
