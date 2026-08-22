/** تصدير/استيراد CSV مع دعم كامل للعربية (BOM) */
export function toCSV(columns, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map(c => esc(c.header)).join(',');
  const body = rows.map(r => columns.map(c => esc(r[c.key])).join(',')).join('\r\n');
  return '﻿' + head + '\r\n' + body;   // BOM ليفتح Excel العربية بشكل صحيح
}

/** محلل CSV يدعم الاقتباس والفواصل داخل النص */
export function parseCSV(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const delimiter = detectDelimiter(s);
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function detectDelimiter(s) {
  const sample = s.slice(0, 4000);
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of sample) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ',';
}
