#!/usr/bin/env node
/**
 * shoot.mjs — 웹사이트 풀페이지 스크린샷을 뽑는다.
 *
 * score.mjs 가 "우리가 몇 %를 제대로 찍나"를 재는 도구라면, 이건 실제로
 * 쓰는 도구다. URL 을 넣으면 PNG 가 나온다.
 *
 * 다른 캡처 도구와 다른 점은 하나다 — **찍고 나서 스스로 검사한다.**
 * 같은 페이지를 두 번 찍어 픽셀이 다르면 뭔가 아직 움직이고 있다는 뜻이므로
 * 다시 찍는다. 그래도 다르면 "검수 필요"로 표시하고 무엇이 달랐는지
 * 잘라낸 그림을 같이 남긴다. 사람이 전부 눈으로 볼 필요가 없다.
 *
 *   node shoot.mjs --file ../gdweb-scan/urls.imweb10.txt --out ./결과
 *   node shoot.mjs --urls https://example.com --out ./결과 --scale 2
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { captureSite, STEPS, VIEWPORT } from './capture.mjs';
import { compareCaptures, renderDiffStrip, VERDICT } from './diff.mjs';
import { createBrowserHost, isBrowserDeath } from './browser.mjs';
import { writeTable } from './csv.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FLAGS = new Set(['help', 'no-check']);
const NUMERIC = new Set(['scale', 'concurrency', 'retry']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (FLAGS.has(key)) { out[key] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${key} 에 값이 필요합니다`);
    out[key] = NUMERIC.has(key) ? Number(v) : v;
  }
  return out;
}

function loadUrls(args) {
  if (args.urls) return args.urls.split(',').map((s) => s.trim()).filter(Boolean);
  return readFileSync(resolve(HERE, args.file), 'utf8')
    .split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** 파일 이름으로 쓸 수 있게 다듬는다. 제목이 없으면 주소에서 딴다. */
function fileNameFor(url, title, used) {
  let base = (title || '').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim();
  if (!base) { try { base = new URL(url).hostname; } catch { base = 'page'; } }
  base = base.replace(/\s+/g, ' ').slice(0, 60).trim() || 'page';
  let name = base, n = 2;
  while (used.has(name)) name = `${base} (${n++})`;
  used.add(name);
  return name;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// 한글은 터미널에서 두 칸을 먹는다. 글자 수가 아니라 칸 수로 자르고 채워야
// 표가 어긋나지 않는다.
const cw = (ch) => (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1);
const width = (s) => [...String(s)].reduce((a, ch) => a + cw(ch), 0);
const clip = (s, n) => {
  let out = '', w = 0;
  for (const ch of String(s)) {
    if (w + cw(ch) > n) return out.trimEnd() + '…';
    out += ch; w += cw(ch);
  }
  return out;
};
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)));

function renderReport(rows, meta) {
  const ok = rows.filter((r) => r.status === '확인됨').length;
  const review = rows.filter((r) => r.status === '검수 필요').length;
  const fail = rows.filter((r) => r.status === '실패').length;
  const L = [];
  L.push('');
  L.push('  풀페이지 스크린샷 결과');
  L.push('  ' + '─'.repeat(70));
  L.push(`  대상        ${rows.length}건`);
  L.push(`  배율        ${meta.scale}배  ·  가로 ${VIEWPORT.width}px 기준`);
  L.push(`  저장 위치   ${meta.out}`);
  L.push('');
  L.push(`  확인됨      ${String(ok).padStart(3)}건   두 번 찍어 같았습니다. 그대로 쓰셔도 됩니다`);
  if (review) L.push(`  검수 필요   ${String(review).padStart(3)}건   두 번이 다르거나, 화면에 덜 뜬 것이 있습니다`);
  if (fail) L.push(`  실패        ${String(fail).padStart(3)}건   캡처 자체가 안 됐습니다`);
  L.push('');
  L.push('  ' + '─'.repeat(70));
  for (const r of rows) {
    const mark = r.status === '확인됨' ? '✓' : r.status === '검수 필요' ? '△' : '✗';
    const tail = r.status === '실패' ? r.error
      : r.status === '검수 필요' ? (r.gaps && r.gaps.length ? r.gaps.join(' · ')
        : `${(r.ratio * 100).toFixed(2)}% 다름 · ${r.where || ''}`)
      // 검사 때문에 기본 2번 찍는다. 3번 이상이어야 "다시 찍어서 안정됐다"는 뜻이다.
      : `${r.docHeight.toLocaleString('en-US')}px${r.tries > 2 ? ` · ${r.tries}번 만에 안정` : ''}`;
    L.push(`  ${mark} ${pad(clip(r.name, 30), 32)}${tail}`);
  }
  L.push('');
  return L.join('\n');
}

/** 결과를 한눈에 넘겨보는 목록 페이지. 브라우저로 열면 된다. */
function renderIndex(rows, meta) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const card = (r) => {
    const badge = r.status === '확인됨' ? '<span class="b ok">확인됨</span>'
      : r.status === '검수 필요' ? '<span class="b warn">검수 필요</span>'
      : '<span class="b bad">실패</span>';
    const img = r.files && r.files[0]
      ? `<a href="${esc(r.files[0])}" target="_blank"><img src="${esc(r.files[0])}" alt="${esc(r.name)}"></a>`
      : `<div class="none">${esc(r.error || '이미지 없음')}</div>`;
    const extra = [
      r.diffFile ? `<p class="d">두 번이 ${(r.ratio * 100).toFixed(2)}% 달랐습니다 — <a href="${esc(r.diffFile)}" target="_blank">차이 보기</a></p>` : '',
      r.gaps && r.gaps.length ? `<p class="d">덜 뜬 것: ${esc(r.gaps.join(' · '))}</p>` : '',
    ].join('');
    return `<figure>${img}<figcaption><b>${esc(r.name)}</b>${badge}
      <p class="d">${esc(r.url)}</p>${extra}</figcaption></figure>`;
  };
  return `<!doctype html><meta charset="utf-8"><title>스크린샷 결과 ${rows.length}건</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#F5F4F7;--card:#fff;--ink:#1B1720;--muted:#6E677A;--line:#E1DDE8;
      --ok:#1C6F53;--okbg:#E4F1EB;--warn:#9C610A;--warnbg:#F6EEDD;--bad:#A93529;--badbg:#F7E9E7;}
@media (prefers-color-scheme:dark){:root{--bg:#141219;--card:#1D1A23;--ink:#EEEBF3;--muted:#A099AE;--line:#2F2A38;
  --ok:#5BC79C;--okbg:#14291F;--warn:#E2A947;--warnbg:#2C2314;--bad:#F0827A;--badbg:#2E1917;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 "IBM Plex Sans KR",-apple-system,"Apple SD Gothic Neo",sans-serif;padding:2rem 1.5rem 4rem}
h1{font-size:1.5rem;margin:0 0 .3rem;letter-spacing:-.02em}
.sum{color:var(--muted);font-size:.9rem;margin:0 0 2rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1.25rem;max-width:80rem}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:4px;overflow:hidden;display:flex;flex-direction:column}
figure img{display:block;width:100%;height:230px;object-fit:cover;object-position:top;background:var(--bg)}
.none{height:230px;display:grid;place-items:center;color:var(--bad);font-size:.85rem;padding:1rem;text-align:center}
figcaption{padding:.8rem .9rem 1rem;display:flex;flex-direction:column;gap:.25rem}
figcaption b{font-size:.95rem;letter-spacing:-.01em}
.d{margin:0;font-size:.76rem;color:var(--muted);word-break:break-all;font-family:ui-monospace,Menlo,monospace}
.d a{color:inherit}
.b{align-self:flex-start;font-size:.68rem;font-weight:600;padding:.12rem .45rem;border-radius:2px;font-family:ui-monospace,Menlo,monospace}
.b.ok{background:var(--okbg);color:var(--ok)} .b.warn{background:var(--warnbg);color:var(--warn)} .b.bad{background:var(--badbg);color:var(--bad)}
</style>
<h1>스크린샷 결과 ${rows.length}건</h1>
<p class="sum">확인됨 ${rows.filter((r) => r.status === '확인됨').length} ·
  검수 필요 ${rows.filter((r) => r.status === '검수 필요').length} ·
  실패 ${rows.filter((r) => r.status === '실패').length}
  &nbsp;|&nbsp; ${meta.scale}배율 · 가로 ${VIEWPORT.width}px · ${meta.when}</p>
<div class="grid">${rows.map(card).join('\n')}</div>`;
}

const CSV_COLS = ['이름', 'URL', '상태', '덜뜬것', '파일', '문서높이', '분할수', '차이비율', '차이구간', '시도횟수', '메모', '오류'];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.urls && !args.file)) {
    console.log(`
웹사이트 풀페이지 스크린샷

  node shoot.mjs --file <urls.txt> --out <폴더>
  node shoot.mjs --urls <url1,url2> --out <폴더>

옵션
  --out <폴더>        저장 위치 (기본 ./결과)
  --scale <n>         배율 (기본 1, 선명하게 하려면 2)
  --retry <n>         두 번이 다를 때 다시 찍는 횟수 (기본 2)
  --concurrency <n>   동시 실행 (기본 2)
  --no-check          검사 없이 한 번만 찍기 (빠르지만 품질 보장 없음)

찍은 뒤 같은 페이지를 한 번 더 찍어 비교합니다. 다르면 아직 움직이는
중이라는 뜻이므로 다시 찍습니다. 그래도 다르면 '검수 필요'로 표시하고
무엇이 달랐는지 <이름>__차이.png 로 남깁니다.
`);
    return;
  }

  const urls = loadUrls(args);
  if (!urls.length) { console.error('URL 이 없습니다.'); process.exitCode = 1; return; }

  const scale = args.scale || 1;
  const retry = args.retry ?? 2;
  const check = !args['no-check'];
  const outDir = resolve(HERE, args.out || './결과');
  mkdirSync(outDir, { recursive: true });

  const host = createBrowserHost();
  let closed = false;
  const shutdown = async () => { if (!closed) { closed = true; await host.close().catch(() => {}); } };
  process.on('SIGINT', () => { shutdown().finally(() => process.exit(130)); });

  const ctxOpts = { viewport: VIEWPORT, deviceScaleFactor: scale, userAgent: UA, locale: 'ko-KR', timezoneId: 'Asia/Seoul' };
  let diffPage = null;
  async function getDiffPage() {
    if (diffPage && !diffPage.isClosed()) return diffPage;
    const b = await host.get();
    diffPage = await (await b.newContext({ viewport: { width: 200, height: 200 } })).newPage();
    return diffPage;
  }

  const shootOnce = async (url) => {
    const browser = await host.get();
    const ctx = await browser.newContext(ctxOpts);
    try {
      return await captureSite(ctx, url, { steps: [...STEPS], scale });
    } finally {
      await ctx.close().catch(() => {});
    }
  };

  console.error(`${urls.length}곳 캡처 시작 — ${scale}배율${check ? ' · 찍고 나서 스스로 검사합니다' : ' · 검사 없음'}`);
  const used = new Set();
  let done = 0;
  let rows;

  try {
    rows = await mapLimit(urls, args.concurrency || 2, async (url) => {
      let last = null, prev = null, cmp = null, tries = 0;
      let err = null;

      for (let attempt = 0; attempt <= (check ? retry : 0); attempt++) {
        let shot;
        try {
          shot = await shootOnce(url);
        } catch (e) {
          const msg = e.message.split('\n')[0];
          if (isBrowserDeath(msg) && attempt === 0) continue;   // 브라우저가 죽었으면 다시 띄우고 재시도
          shot = { ok: false, error: msg };
        }
        if (!shot.ok) { err = shot.error; break; }
        tries++;
        if (!check) { last = shot; break; }
        if (last) {
          cmp = await compareCaptures(await getDiffPage(), last.slices, shot.slices);
          prev = last;   // 달랐을 때 무엇이 달랐는지 보여주려면 직전 것도 들고 있어야 한다
          if (cmp.verdict === VERDICT.SAME || cmp.verdict === VERDICT.SAME_PIXELS) { last = shot; break; }
        }
        last = shot;
      }

      const name = fileNameFor(url, last && last.title, used);
      if (err || !last) {
        console.error(`  [${++done}/${urls.length}] ✗ ${name} — ${err}`);
        return { name, url, status: '실패', error: err || '알 수 없는 오류', files: [], tries };
      }

      const stable = !check || !cmp || cmp.verdict === VERDICT.SAME || cmp.verdict === VERDICT.SAME_PIXELS;

      // 두 번이 같다고 제대로 찍힌 건 아니다. 두 번 다 똑같이 비어 있을 수 있다 —
      // 아임웹에서 실제로 그 일이 났다. 화면에 있어야 할 것이 없는지 따로 본다.
      const rd = last.ready || {};
      const gaps = [];
      if (rd.loading) gaps.push(`안 뜬 이미지 ${rd.loading}개`);
      if (rd.broken) gaps.push(`깨진 이미지 ${rd.broken}개`);
      if (rd.invisible) gaps.push(`투명한 요소 ${rd.invisible}개`);
      if (rd.blankVideos) gaps.push(`빈 비디오 ${rd.blankVideos}개`);
      const complete = gaps.length === 0;
      const files = last.slices.map((buf, i) => {
        const f = last.slices.length === 1 ? `${name}.png` : `${name} (${i + 1}).png`;
        writeFileSync(join(outDir, f), buf);
        return f;
      });

      let diffFile = null;
      if (!stable && cmp.region && prev) {
        const i = cmp.sliceIndex || 0;
        const strip = await renderDiffStrip(await getDiffPage(), prev.slices[i], last.slices[i], cmp.region)
          .catch(() => null);
        if (strip) { diffFile = `${name}__차이.png`; writeFileSync(join(outDir, diffFile), strip); }
      }

      const mark = stable && complete ? '✓' : '△';
      const why = !stable ? `두 번이 ${(cmp.ratio * 100).toFixed(2)}% 다름` : gaps.join(' · ');
      console.error(`  [${++done}/${urls.length}] ${mark} ${name} — ${last.docHeight.toLocaleString('en-US')}px${why ? ' · ' + why : ''}`);

      return {
        name, url, status: stable && complete ? '확인됨' : '검수 필요',
        gaps, files, diffFile, tries,
        docHeight: last.docHeight, sliceCount: last.sliceCount,
        ratio: cmp ? cmp.ratio : 0,
        where: cmp && cmp.region ? `y ${cmp.region.y}~${cmp.region.y + cmp.region.h}` : '',
        notes: last.notes,
      };
    });
  } finally {
    await shutdown();
  }

  const meta = { scale, out: outDir, when: new Date().toLocaleString('ko-KR') };
  const report = renderReport(rows, meta);
  console.log(report);

  writeFileSync(join(outDir, '보고서.txt'), report + '\n');
  writeFileSync(join(outDir, '목록.html'), renderIndex(rows, meta));
  writeFileSync(join(outDir, '목록.csv'), writeTable(CSV_COLS, rows.map((r) => ({
    '이름': r.name, 'URL': r.url, '상태': r.status, '덜뜬것': (r.gaps || []).join(' · '),
    '파일': (r.files || []).join(' / '),
    '문서높이': r.docHeight ?? '', '분할수': r.sliceCount ?? '',
    '차이비율': r.ratio ? (r.ratio * 100).toFixed(4) + '%' : '',
    '차이구간': r.where || '', '시도횟수': r.tries ?? '',
    '메모': (r.notes || []).join(' / '), '오류': r.error || '',
  }))));

  console.error(`\n저장: ${outDir}`);
  console.error(`목록을 한눈에 보시려면 → open "${join(outDir, '목록.html')}"`);
  if (host.restarts) console.error(`브라우저가 ${host.restarts}번 죽어서 다시 띄웠습니다.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
