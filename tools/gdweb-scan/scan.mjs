#!/usr/bin/env node
/**
 * scan.mjs — GDWEB 선정작 목록을 훑어 각 사이트의 캡처 난이도를 실측하고 분류한다.
 *
 *   node scan.mjs --list "<GDWEB 목록 URL>" --pages 1-3 --limit 60 --concurrency 4
 *   node scan.mjs --urls urls.txt            # 직접 만든 URL 목록으로 측정만
 *
 * 산출물
 *   results.json   사이트별 원 신호 + 티어 + 판정 근거
 *   report.html    사람이 읽는 분류 결과
 *
 * 설계 원칙: 판정 근거를 전부 남긴다. "AI가 그렇다더라"는 결과는 만들지 않는다.
 */

import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeSite, classify, TIERS, TAGS, VIEWPORT } from './probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function parseArgs(argv) {
  const out = { pages: '1', limit: 60, concurrency: 4, outDir: HERE };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (k === 'limit' || k === 'concurrency') out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

function expandPages(spec) {
  const pages = [];
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) for (let i = +m[1]; i <= +m[2]; i++) pages.push(i);
    else pages.push(Number(part));
  }
  return pages;
}

/** 목록 페이지에서 상세 페이지 링크를 긁는다. GDWEB의 마크업 구조에 의존하지 않는다. */
async function collectDetailLinks(context, listUrl, pageNums) {
  const page = await context.newPage();
  const links = new Set();
  try {
    for (const n of pageNums) {
      const url = listUrl.replace(/([?&]Page=)\d+/i, `$1${n}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);
      const found = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="view.asp"]'))
          .map((a) => a.href)
          .filter((h) => /str_no=\d+/.test(h))
      );
      found.forEach((h) => links.add(h));
      process.stderr.write(`  목록 ${n}쪽 → 누적 ${links.size}건\n`);
      if (found.length === 0) break; // 더 이상 결과가 없으면 중단
    }
  } finally {
    await page.close().catch(() => {});
  }
  return [...links];
}

const SKIP_HOSTS =
  /gdweb\.co\.kr|facebook\.|twitter\.|x\.com|instagram\.|youtube\.|youtu\.be|blog\.naver|naver\.me|kakao|linkedin\.|pinterest\.|google\.|w3\.org|adobe\.com|whatap|channel\.io/i;

/** 상세 페이지에서 실제 수상 사이트의 외부 URL과 메타데이터를 뽑는다. */
async function resolveEntry(context, detailUrl) {
  const page = await context.newPage();
  try {
    await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(800);
    return await page.evaluate(() => {
      const externals = Array.from(document.querySelectorAll('a[href^="http"]'))
        .map((a) => ({ href: a.href, text: (a.textContent || '').trim() }))
        .filter((l) => {
          try {
            return new URL(l.href).hostname !== location.hostname;
          } catch {
            return false;
          }
        });
      const title =
        document.querySelector('h1, h2, .tit, .title, .subject')?.textContent?.trim() ||
        document.title;
      return { title, externals, source: location.href };
    });
  } catch (e) {
    return { error: e.message.split('\n')[0], source: detailUrl, externals: [] };
  } finally {
    await page.close().catch(() => {});
  }
}

function pickSiteUrl(externals) {
  const candidates = externals.filter((l) => !SKIP_HOSTS.test(l.href));
  if (!candidates.length) return null;
  // "홈페이지 바로가기" 류의 링크를 우선한다.
  const labelled = candidates.find((l) => /바로가기|사이트|홈페이지|visit|view site/i.test(l.text));
  return (labelled || candidates[0]).href;
}

/** 동시성 제한 실행기 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(rows) {
  const byTier = {};
  const byTag = {};
  let gated = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.ok) { failed++; continue; }
    if (r.gate) { gated++; continue; }
    byTier[r.tier] = (byTier[r.tier] || 0) + 1;
    for (const t of r.tags || []) byTag[t] = (byTag[t] || 0) + 1;
  }
  return { total: rows.length, measured: rows.length - gated - failed, gated, failed, byTier, byTag };
}

function renderReport(rows, summary, meta) {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tierRow = (n) => {
    const t = TIERS[n];
    const count = summary.byTier[n] || 0;
    const pct = summary.measured ? Math.round((count / summary.measured) * 100) : 0;
    return `<tr><td><b>${t.key} ${t.name}</b></td><td>${esc(t.short)}</td><td class="n">${count}</td><td class="n">${pct}%</td></tr>`;
  };
  const siteRow = (r) => {
    if (!r.ok) return `<tr class="err"><td>${esc(r.name || r.url)}</td><td colspan="4">측정 실패 — ${esc(r.error)}</td></tr>`;
    if (r.gate) return `<tr class="gate"><td>${esc(r.name || r.title || r.url)}</td><td>차단 (${esc(r.gate)})</td><td colspan="3">${esc(r.url)}</td></tr>`;
    return `<tr>
      <td>${esc(r.name || r.title || '')}</td>
      <td><b>${TIERS[r.tier].key}</b> ${esc(TIERS[r.tier].name)}</td>
      <td>${(r.tags || []).join(' ')}</td>
      <td>${esc((r.reasons || []).join(', '))}</td>
      <td><a href="${esc(r.url)}">${esc(r.url)}</a></td>
    </tr>`;
  };
  return `<!doctype html><meta charset="utf-8"><title>GDWEB 캡처 난이도 스캔</title>
<style>
body{font:14px/1.7 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif;margin:2rem auto;max-width:1200px;padding:0 1rem;color:#1b1720}
table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border-bottom:1px solid #e1dde8;padding:.5rem .7rem;text-align:left;vertical-align:top}
th{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:#6e677a}
td.n{text-align:right;font-variant-numeric:tabular-nums}tr.err td{color:#a93529}tr.gate td{color:#9c610a}
a{color:#8e1560}code{background:#efedf3;padding:.1em .3em;border-radius:3px}
</style>
<h1>GDWEB 선정작 — 캡처 난이도 스캔</h1>
<p>측정 ${summary.measured}건 · 차단 ${summary.gated}건 · 실패 ${summary.failed}건 / 총 ${summary.total}건<br>
스캔 시각 ${esc(meta.scannedAt)} · 뷰포트 ${VIEWPORT.width}×${VIEWPORT.height}</p>
<h2>티어 분포</h2>
<table><thead><tr><th>티어</th><th>정의</th><th>사이트</th><th>비중</th></tr></thead>
<tbody>${[0, 1, 2, 3, 4].map(tierRow).join('')}</tbody></table>
<h2>태그 분포</h2>
<table><thead><tr><th>태그</th><th>의미</th><th>사이트</th></tr></thead><tbody>
${Object.entries(TAGS).map(([k, v]) => `<tr><td><b>${k}</b></td><td>${esc(v)}</td><td class="n">${summary.byTag[k] || 0}</td></tr>`).join('')}
</tbody></table>
<h2>사이트별 결과</h2>
<table><thead><tr><th>이름</th><th>티어</th><th>태그</th><th>판정 근거</th><th>URL</th></tr></thead>
<tbody>${rows.map(siteRow).join('')}</tbody></table>
<p><small>원 신호 전체는 <code>results.json</code>의 <code>evidence</code> 필드를 보세요.</small></p>`;
}

/** 스프레드시트에 바로 붙일 수 있는 CSV. 엑셀 한글 깨짐을 막으려 BOM을 붙인다. */
function renderCsv(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['이름', 'URL', '티어', '티어명', '태그', '판정근거', '라이브러리', '문서높이', '고정요소', '상태'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const status = !r.ok ? `실패: ${r.error}` : r.gate ? `차단: ${r.gate}` : '측정됨';
    const ev = r.evidence || {};
    lines.push(
      [
        r.name || r.title || '',
        r.url,
        r.ok && !r.gate ? TIERS[r.tier].key : '',
        r.ok && !r.gate ? TIERS[r.tier].name : '',
        (r.tags || []).join(' '),
        (r.reasons || []).join(' / '),
        (ev.libs || []).join(' '),
        ev.docHeight ?? '',
        ev.fixedOrSticky ?? '',
        status,
      ].map(cell).join(',')
    );
  }
  return '\ufeff' + lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv);
  const browser = await chromium.launch({
    args: ['--disable-dev-shm-usage'],
    // 사내 이미지처럼 브라우저 경로가 다를 때를 위한 탈출구
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {}),
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: UA,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    reducedMotion: 'no-preference', // 사이트의 진짜 모습을 봐야 하므로 줄이지 않는다
  });

  let entries = [];

  if (args.urls) {
    const lines = readFileSync(args.urls, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    entries = lines.map((l) => {
      const [url, ...rest] = l.split(/\s+/);
      return { url, name: rest.join(' ') || null, source: 'urls.txt' };
    });
  } else if (args.list) {
    process.stderr.write('목록 페이지 수집 중…\n');
    const details = await collectDetailLinks(context, args.list, expandPages(args.pages));
    process.stderr.write(`상세 페이지 ${details.length}건에서 사이트 URL 추출 중…\n`);
    const resolved = await mapLimit(details.slice(0, args.limit), args.concurrency, (d) =>
      resolveEntry(context, d)
    );
    entries = resolved
      .map((r) => ({ url: pickSiteUrl(r.externals || []), name: r.title, source: r.source }))
      .filter((e) => e.url);
    process.stderr.write(`외부 URL ${entries.length}건 확보\n`);
  } else {
    console.error('--list <GDWEB 목록 URL> 또는 --urls <파일> 중 하나가 필요합니다.');
    process.exit(1);
  }

  entries = entries.slice(0, args.limit);

  if (args['dry-run'] !== undefined) {
    // 네트워크 없이 목록이 제대로 파싱됐는지만 확인한다.
    process.stderr.write(`\n${entries.length}개 항목 파싱 완료 (측정 안 함)\n\n`);
    entries.forEach((e, i) => {
      let host = '?';
      try { host = new URL(e.url).host; } catch { host = '!! URL 파싱 실패'; }
      process.stderr.write(`  ${String(i + 1).padStart(3)}. ${(e.name || '(이름 없음)').padEnd(24)} ${host}\n`);
    });
    await context.close();
    await browser.close();
    return;
  }

  process.stderr.write(`\n${entries.length}개 사이트 측정 시작 (동시 ${args.concurrency})\n`);

  let done = 0;
  const rows = await mapLimit(entries, args.concurrency, async (e) => {
    const r = await probeSite(context, e.url);
    done++;
    const label = r.ok ? (r.gate ? `차단(${r.gate})` : TIERS[r.tier].key) : '실패';
    process.stderr.write(`  [${done}/${entries.length}] ${label.padEnd(8)} ${e.url}\n`);
    return { ...e, ...r };
  });

  await context.close();
  await browser.close();

  const summary = summarize(rows);
  const meta = { scannedAt: new Date().toISOString(), viewport: VIEWPORT, args };
  writeFileSync(join(args.outDir, 'results.json'), JSON.stringify({ meta, summary, rows }, null, 2));
  writeFileSync(join(args.outDir, 'report.html'), renderReport(rows, summary, meta));
  writeFileSync(join(args.outDir, 'results.csv'), renderCsv(rows));

  process.stderr.write('\n== 티어 분포 ==\n');
  for (const n of [0, 1, 2, 3, 4]) {
    process.stderr.write(`  ${TIERS[n].key} ${TIERS[n].name.padEnd(8)} ${summary.byTier[n] || 0}\n`);
  }
  process.stderr.write(`  차단 ${summary.gated} · 실패 ${summary.failed}\n`);
  process.stderr.write(`\nresults.json / results.csv / report.html 생성 완료 (${args.outDir})\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { classify, summarize, renderReport, renderCsv, pickSiteUrl, expandPages };
