/** csv.mjs — 스캐너가 남긴 CSV 를 읽고 쓴다. 따옴표 안의 쉼표·줄바꿈을 견딘다. */

export function parseCsv(text) {
  const rows = [];
  let field = '', row = [], quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // BOM 제거
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c !== '"') { field += c; continue; }
      if (s[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** 첫 줄을 헤더로 보고 객체 배열로 바꾼다. */
export function readTable(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => c !== ''));
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const quote = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 엑셀이 UTF-8 로 읽도록 BOM 을 붙인다. */
export function writeTable(columns, rows) {
  const lines = [columns.map(quote).join(',')];
  for (const r of rows) lines.push(columns.map((c) => quote(r[c])).join(','));
  return '﻿' + lines.join('\n') + '\n';
}
