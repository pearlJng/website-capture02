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
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSite, STEPS, DEVICES, contextOptionsFor } from './capture.mjs';
import { compareCaptures, renderDiffStrip, VERDICT } from './diff.mjs';
import { createBrowserHost, isBrowserDeath, pickBrowser } from './browser.mjs';
import { writeTable } from './csv.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
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

// 주소 목록은 tools/gdweb-scan/ 에 모여 있고 실행은 여기서 한다.
// 파일 이름만 적어도 찾아 주지 않으면 매번 경로를 틀린다 — 실제로 틀렸다.
function findUrlFile(name) {
  const tried = [resolve(process.cwd(), name), resolve(HERE, name),
    resolve(HERE, '..', 'gdweb-scan', name)];
  for (const p of tried) if (existsSync(p)) return p;
  throw new Error(`주소 목록을 못 찾았습니다: ${name}\n찾아본 곳:\n  ` + tried.join('\n  '));
}

/**
 * --width 1440 또는 --width 1440,1920,375.
 * 아무 폭이나 받지 않는다 — 크기마다 UA·터치·기본 배율이 다르고,
 * 그걸 정해 두지 않으면 "375px 짜리 데스크탑 페이지" 같은 게 나온다.
 */
function parseWidths(v) {
  if (!v) return [1440];
  const want = String(v).split(',').map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const w of want) {
    if (!DEVICES[w]) {
      throw new Error(`--width ${w} 는 없습니다. 쓸 수 있는 값: ` +
        Object.keys(DEVICES).map((k) => `${k}(${DEVICES[k].label})`).join(', '));
    }
    if (!out.includes(Number(w))) out.push(Number(w));
  }
  return out;
}

function loadUrls(args) {
  if (args.urls) return args.urls.split(',').map((s) => s.trim()).filter(Boolean);
  return readFileSync(findUrlFile(args.file), 'utf8')
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
  L.push(`  화면        ${meta.device} (가로 ${meta.width}px)  ·  ${meta.scale}배율`);
  L.push(`  브라우저     ${meta.browser}${meta.codecs ? '' : '  ← H.264·AAC 코덱 없음. 동영상이 오류 화면으로 찍힙니다'}`);
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
p.warn{background:var(--warnbg);color:var(--warn);border-radius:4px;padding:.8rem 1rem;margin:0 0 1.5rem;max-width:60rem;font-size:.88rem}
</style>
<h1>스크린샷 결과 ${rows.length}건</h1>
<p class="sum">확인됨 ${rows.filter((r) => r.status === '확인됨').length} ·
  검수 필요 ${rows.filter((r) => r.status === '검수 필요').length} ·
  실패 ${rows.filter((r) => r.status === '실패').length}
  &nbsp;|&nbsp; ${esc(meta.device)} · 가로 ${meta.width}px · ${meta.scale}배율 · ${esc(meta.browser)} · ${meta.when}</p>
${meta.codecs ? '' : '<p class="warn">이 컴퓨터에 크롬이 없어 번들 크로미움으로 찍었습니다. H.264·AAC 코덱이 없어 동영상 영역이 플레이어 오류 화면으로 찍힙니다 — 크롬을 설치하면 해결됩니다.</p>'}
<div class="grid">${rows.map(card).join('\n')}</div>`;
}

/** 폭을 여러 개 찍었을 때, 어느 폭으로 들어갈지 고르는 표지 페이지. */
function renderRootIndex(runs, meta) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const card = (run) => {
    const ok = run.rows.filter((r) => r.status === '확인됨').length;
    const review = run.rows.filter((r) => r.status === '검수 필요').length;
    const fail = run.rows.filter((r) => r.status === '실패').length;
    const first = run.rows.find((r) => r.files && r.files.length);
    const thumb = first ? `<img src="${esc(run.device.width)}/${esc(encodeURIComponent(first.files[0]))}" alt="">` : '';
    return `<a class="c" href="${esc(run.device.width)}/목록.html">
      <div class="t">${thumb}</div>
      <h2>${esc(run.device.label)}</h2>
      <p>가로 ${run.device.width}px · ${run.meta.scale}배율</p>
      <p><b class="ok">확인됨 ${ok}</b>${review ? ` · <b class="warn">검수 ${review}</b>` : ''}${fail ? ` · <b class="bad">실패 ${fail}</b>` : ''}</p>
    </a>`;
  };
  return `<!doctype html><meta charset=utf-8><title>스크린샷 — 화면 크기별</title>
<style>
:root{color-scheme:light dark}
body{margin:0;padding:32px;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;background:#f6f6f7;color:#111}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#666;margin:0 0 28px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:20px}
.c{display:block;background:#fff;border:1px solid #e3e3e6;border-radius:12px;padding:16px;text-decoration:none;color:inherit}
.c:hover{border-color:#999}
.t{height:180px;overflow:hidden;border-radius:8px;background:#eee;margin-bottom:12px}
.t img{width:100%;display:block}
h2{font-size:16px;margin:0 0 2px}
.c p{margin:0;color:#666;font-size:13px}
b{font-weight:600}.ok{color:#0a7d3c}.warn{color:#a06000}.bad{color:#b3261e}
@media (prefers-color-scheme:dark){body{background:#161617;color:#eee}.c{background:#1f1f21;border-color:#333}.sub,.c p{color:#999}}
</style>
<h1>화면 크기별 스크린샷</h1>
<p class="sub">${esc(meta.browser)} · ${esc(meta.when)} — 크기를 골라 들어가세요</p>
<div class="g">${runs.map(card).join('')}</div>`;
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
  --width <px>        화면 크기. 1440(기본) | 1920 | 375
                      쉼표로 여러 개: --width 1440,1920,375
                      375 는 모바일로 찍습니다 (아이폰 UA·터치·기본 2배율).
                      여러 개면 폭마다 하위 폴더가 생깁니다
  --scale <n>         배율 (기본: 데스크탑 1, 모바일 2)
  --retry <n>         두 번이 다를 때 다시 찍는 횟수 (기본 2)
  --concurrency <n>   동시 실행 (기본 2)
  --no-check          검사 없이 한 번만 찍기 (빠르지만 품질 보장 없음)
  --browser <이름>    auto(기본) | chrome | msedge | chromium
                      기본은 설치된 크롬을 먼저 찾습니다. 번들 크로미움에는
                      H.264·AAC 코덱이 없어 동영상이 플레이어 오류로 찍힙니다
  --mode <방식>       stitch(기본) 또는 fullpage
                      stitch   화면 단위로 찍어 이어 붙입니다. 등장 애니메이션이
                               화면을 벗어날 때 다시 숨는 사이트도 온전히 나옵니다
                      fullpage 한 방에 찍습니다. 빠르지만 위 경우 아래쪽이 빕니다

찍은 뒤 같은 페이지를 한 번 더 찍어 비교합니다. 다르면 아직 움직이는
중이라는 뜻이므로 다시 찍습니다. 그래도 다르면 '검수 필요'로 표시하고
무엇이 달랐는지 <이름>__차이.png 로 남깁니다.
`);
    return;
  }

  const urls = loadUrls(args);
  if (!urls.length) { console.error('URL 이 없습니다.'); process.exitCode = 1; return; }

  let widths;
  try { widths = parseWidths(args.width); }
  catch (e) { console.error(e.message); process.exitCode = 1; return; }

  const retry = args.retry ?? 2;
  const check = !args['no-check'];
  const outRoot = resolve(HERE, args.out || './결과');
  mkdirSync(outRoot, { recursive: true });

  const pick = await pickBrowser(args.browser);
  const host = createBrowserHost({ prefer: args.browser });
  let closed = false;
  const shutdown = async () => { if (!closed) { closed = true; await host.close().catch(() => {}); } };
  process.on('SIGINT', () => { shutdown().finally(() => process.exit(130)); });

  if (!pick.codecs) {
    console.error('');
    console.error('  ⚠ 이 컴퓨터에 크롬이 없어 번들 크로미움으로 찍습니다.');
    console.error('    크로미움에는 H.264(MP4)·AAC 코덱이 없습니다 — 특허가 걸려 있어');
    console.error('    브랜드 크롬에만 들어갑니다. 유튜브 임베드나 MP4 비디오가 있는');
    console.error('    페이지는 플레이어 오류 화면이 그대로 찍힙니다.');
    console.error('    크롬을 설치하면 자동으로 크롬을 씁니다.');
    console.error('');
  }

  // 폭이 여러 개면 폭마다 하위 폴더를 만든다. 하나면 예전처럼 평평하게 둔다.
  const many = widths.length > 1;
  const runs = [];
  try {
    for (const w of widths) {
      const device = DEVICES[w];
      const scale = args.scale || device.scale;
      const dir = many ? join(outRoot, String(w)) : outRoot;
      mkdirSync(dir, { recursive: true });
      runs.push(await runWidth({ args, urls, host, pick, device, scale, outDir: dir, check, retry, shutdown }));
    }
  } finally {
    await shutdown();
  }

  if (many) {
    const rootIndex = join(outRoot, '목록.html');
    writeFileSync(rootIndex, renderRootIndex(runs, { browser: pick.name, when: new Date().toLocaleString('ko-KR') }));
    console.error(`\n폭 ${widths.join('·')} 전체를 한눈에 → open "${rootIndex}"`);
  }
  if (host.restarts) console.error(`브라우저가 ${host.restarts}번 죽어서 다시 띄웠습니다.`);
}

/** 화면 크기 하나로 전부 찍는다. 브라우저는 밖에서 받아 폭이 바뀌어도 다시 안 띄운다. */
async function runWidth({ args, urls, host, pick, device, scale, outDir, check, retry, shutdown }) {
  const ctxOpts = contextOptionsFor(device, scale);
  let diffPage = null;
  async function getDiffPage() {
    if (diffPage && !diffPage.isClosed()) return diffPage;
    const b = await host.get();
    diffPage = await (await b.newContext({ viewport: { width: 200, height: 200 } })).newPage();
    return diffPage;
  }
  // 조각을 이어 붙일 캔버스를 두는 페이지. 대상 사이트와 섞이면 안 되므로 따로 둔다.
  let stitchPage = null;
  async function getStitchPage() {
    if (stitchPage && !stitchPage.isClosed()) return stitchPage;
    const b = await host.get();
    stitchPage = await (await b.newContext({ viewport: { width: 200, height: 200 } })).newPage();
    return stitchPage;
  }

  const shootOnce = async (url) => {
    const browser = await host.get();
    const ctx = await browser.newContext(ctxOpts);
    try {
      return await captureSite(ctx, url, {
        steps: [...STEPS], scale, mode: args.mode || 'stitch',
        stitchPage: await getStitchPage(),
      });
    } finally {
      await ctx.close().catch(() => {});
    }
  };

  console.error(`\n${device.label} — ${urls.length}곳 · ${pick.name} · ${scale}배율${check ? ' · 찍고 나서 스스로 검사합니다' : ' · 검사 없음'}`);
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
      // 투명한 요소는 이어붙이기에서는 정상이다. 마지막 스크롤 위치 기준으로
      // 화면 밖이라 숨은 것뿐이고, 그 칸은 화면에 있었을 때 이미 찍었다.
      // 한 방 캡처(fullpage)에서만 진짜 문제다.
      if (rd.invisible && last.mode !== 'stitch') gaps.push(`투명한 요소 ${rd.invisible}개`);
      if (rd.blankVideos) gaps.push(`빈 비디오 ${rd.blankVideos}개`);
      // 스크롤이 도중에 멈췄으면 그 아래는 아예 안 찍힌 것이다. 가장 심각하다.
      if (last.stalled) {
        gaps.unshift(`스크롤이 ${last.stalled.at.toLocaleString('en-US')}px 에서 멈춤 ` +
          `(문서 ${last.stalled.of.toLocaleString('en-US')}px)`);
      }
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
  } catch (e) {
    await shutdown();   // 폭이 여러 개라도 여기서 끝난다
    throw e;
  }

  const meta = {
    scale, out: outDir, when: new Date().toLocaleString('ko-KR'),
    browser: pick.name, codecs: pick.codecs,
    device: device.label, width: device.width,
  };
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

  console.error(`저장: ${outDir}`);
  console.error(`목록을 한눈에 보시려면 → open "${join(outDir, '목록.html')}"`);

  return { rows, meta, outDir, device };
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
