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
  const primary = tenant?.primary_color || '#0F5132';
  const accent = tenant?.accent_color || '#C9A227';

  const logo = tenant?.logo_url
    ? `<img src="${esc(tenant.logo_url)}" alt="" class="logo">`
    : `<div class="logo-fallback" aria-hidden="true">
         <svg viewBox="0 0 64 64" width="56" height="56">
           <rect width="64" height="64" rx="14" fill="${primary}"/>
           <path d="M32 12l4.6 9.4 10.4 1.5-7.5 7.3 1.8 10.3L32 35.6l-9.3 4.9 1.8-10.3-7.5-7.3 10.4-1.5z" fill="${accent}"/>
           <path d="M20 46h24v3H20zM24 52h16v2.5H24z" fill="${accent}" opacity=".7"/>
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
<style>
  @page { size: A4 ${orientation}; margin: 14mm 12mm 16mm; }
  *{box-sizing:border-box}
  body{font-family:"Segoe UI","Tahoma",system-ui,-apple-system,"Noto Naskh Arabic",sans-serif;
       margin:0;color:#111827;background:#f3f4f6;font-size:12.5px;line-height:1.7}
  .sheet{background:#fff;max-width:1000px;margin:16px auto;padding:24px 28px;
         box-shadow:0 4px 24px rgba(0,0,0,.08);border-radius:8px}
  header{display:flex;gap:16px;align-items:center;border-bottom:3px solid ${primary};padding-bottom:14px}
  .logo,.logo-fallback{width:56px;height:56px;flex:0 0 56px;border-radius:12px;overflow:hidden}
  .org h1{margin:0;font-size:17px;color:${primary};font-weight:800}
  .org p{margin:2px 0 0;font-size:11.5px;color:#6b7280}
  .doc{margin-inline-start:auto;text-align:left;font-size:11px;color:#6b7280}
  .doc b{display:block;color:${primary};font-size:13px;margin-bottom:2px}
  h2.title{margin:18px 0 4px;font-size:16px;text-align:center;color:#111827}
  p.sub{margin:0 0 14px;text-align:center;color:#6b7280;font-size:11.5px}
  .chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;justify-content:center}
  .chip{background:#f0fdf4;border:1px solid #bbf7d0;color:#14532d;border-radius:999px;padding:3px 10px;font-size:10.5px}
  .sums{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 14px}
  .sum{flex:1 1 140px;border:1px solid #e5e7eb;border-radius:8px;padding:9px 12px;background:#fafafa}
  .sum-label{display:block;font-size:10.5px;color:#6b7280}
  .sum-value{display:block;font-size:16px;font-weight:800;color:${primary};margin-top:2px}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  thead{display:table-header-group}
  th{background:${primary};color:#fff;font-weight:700;font-size:11.5px;padding:8px 6px;
     border:1px solid ${primary};text-align:center}
  td{border:1px solid #e5e7eb;padding:6px;font-size:11.5px;vertical-align:middle}
  td.idx{text-align:center;color:#9ca3af;width:34px}
  td.num{text-align:center;font-variant-numeric:tabular-nums}
  tbody tr:nth-child(even){background:#f9fafb}
  tr{page-break-inside:avoid}
  .empty{text-align:center;color:#9ca3af;padding:26px}
  footer{margin-top:16px;border-top:1px solid #e5e7eb;padding-top:8px;display:flex;
         justify-content:space-between;font-size:10px;color:#9ca3af}
  .toolbar{max-width:1000px;margin:12px auto;display:flex;gap:8px;justify-content:flex-end}
  .toolbar button{background:${primary};color:#fff;border:0;border-radius:8px;padding:9px 18px;
                  font-size:13px;font-family:inherit;cursor:pointer;font-weight:600}
  .toolbar button.ghost{background:#fff;color:${primary};border:1px solid ${primary}}
  @media print{ body{background:#fff} .toolbar{display:none} .sheet{box-shadow:none;margin:0;max-width:none;padding:0;border-radius:0} }
</style></head><body>
<div class="toolbar">
  <button onclick="window.print()">🖨️ طباعة / حفظ PDF</button>
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
    <span>وُلّد آلياً من منصة نور</span>
  </footer>
</div>
</body></html>`;
}
