#!/usr/bin/env node
/**
 * app.mjs — 브라우저에서 쓰는 화면.
 *
 *   1. 주소를 넣는다
 *   2. 정보구조를 분석해 보여 준다 → 전부 찍을지, 고른 것만 찍을지 정한다
 *   3. 화면 크기를 고른다 (기본 1920)
 *   4. 고른 페이지를 전부 찍고, 결과를 바로 본다
 *
 *   node app.mjs            → http://127.0.0.1:8890 이 열린다
 *   node app.mjs --port 9000 --out ~/Desktop/캡처
 *
 * 밖으로 열지 않는다. 127.0.0.1 에만 붙는다.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DEVICES, contextOptionsFor } from './capture.mjs';
import { createBrowserHost, pickBrowser } from './browser.mjs';
import { extractSitemap, renderTree } from './sitemap.mjs';
import { shootAll, writeOutputs } from './shoot.mjs';
import { writeFileSync, copyFileSync, readFileSync as readBytes } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import AdmZip from 'adm-zip';

/* 브라우저로 내려받기 — 서버에 올렸을 때(맥 저장 창을 못 띄울 때) 쓰는 길.
 * 만든 파일을 잠깐 들고 있다가 한 번 내려주고 지운다. */
const downloads = new Map();
function offerDownload(filePath, name, mime) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  downloads.set(token, { filePath, name, mime, at: Date.now() });
  for (const [k, v] of downloads) if (Date.now() - v.at > 30 * 60 * 1000) downloads.delete(k);
  return `/download/${token}`;
}

/* ───────────── 내보내기: 이미지 폴더 또는 PDF 한 권 ───────────── */

const safeName = (t) => String(t || 'page').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'page';
const stampNow = () => new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');

/** 고른 결과를 정보구조 순서대로 번호를 붙여 폴더에 복사한다. */
function exportImages(job, rows, { baseDir, name }) {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  const pad = String(rows.length).length;
  const files = [];
  rows.forEach((row, i) => {
    (row.files || []).forEach((f, k) => {
      const name = `${String(i + 1).padStart(pad, '0')} ${safeName(row.path || row.name)}${row.files.length > 1 ? ` (${k + 1})` : ''}.png`;
      copyFileSync(join(job.outDir, f), join(dir, name));
      files.push(name);
    });
  });
  return { dir, files };
}

/** 고른 결과를 PDF 한 권으로 묶는다. 쪽마다 그림 크기 그대로 — 긴 페이지는 긴 쪽이 된다. */
async function exportPdf(job, rows, { baseDir, name }) {
  const dir = baseDir;
  mkdirSync(dir, { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${rows[0] && rows[0].url ? new URL(rows[0].url).hostname : 'site'} ${job.device}`);
  let pages = 0;
  for (const row of rows) {
    for (const f of row.files || []) {
      const png = await pdf.embedPng(readBytes(join(job.outDir, f)));
      // 화면 픽셀을 그대로 pt 로 쓴다 (1px = 1pt). 배율 2 면 절반으로 줄여 실제 크기를 맞춘다.
      const k = 1 / (job.meta && job.meta.scale ? job.meta.scale : 1);
      const w = png.width * k, h = png.height * k;
      const page = pdf.addPage([w, h]);
      page.drawImage(png, { x: 0, y: 0, width: w, height: h });
      pages++;
    }
  }
  const file = join(dir, `${name}.pdf`);
  writeFileSync(file, await pdf.save());
  return { file, pages };
}

const reveal = (path) => { if (process.platform === 'darwin') spawn('open', ['-R', path], { stdio: 'ignore', detached: true }).unref(); };

/**
 * macOS 의 "별도 저장" 창을 띄워 이름과 위치를 받는다. 앱이 이 컴퓨터에서 돌기
 * 때문에 가능하다 — 브라우저 화면 안에서 이름·위치를 적게 하는 것보다 익숙하다.
 * 취소하면 { cancelled: true }. 맥이 아니면 { native: false } — 화면이 기본 위치를 쓴다.
 */
function pickSavePath({ defaultName, format }) {
  if (process.platform !== 'darwin' || PUBLIC) return Promise.resolve({ ok: true, native: false });
  const name = safeName(defaultName) + (format === 'pdf' ? '.pdf' : '');
  const prompt = format === 'pdf' ? 'PDF 로 저장' : '이미지 폴더로 저장';
  const script = [
    'tell application "System Events" to activate',
    `set f to choose file name with prompt "${prompt}" default name "${name.replace(/"/g, '\\"')}" default location (path to downloads folder)`,
    'POSIX path of f',
  ];
  return new Promise((res) => {
    const args = script.flatMap((l) => ['-e', l]);
    const p = spawn('osascript', args);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      if (code !== 0 || !out.trim()) {
        if (/cancel/i.test(err) || /-128/.test(err)) return res({ ok: true, cancelled: true });
        return res({ ok: false, error: err.trim() || '저장 창을 띄우지 못했습니다' });
      }
      let path = out.trim();
      if (format === 'pdf' && !/\.pdf$/i.test(path)) path += '.pdf';
      res({ ok: true, native: true, path });
    });
    p.on('error', (e) => res({ ok: false, error: e.message }));
  });
}

/* ───────────── 수정 요청 → 캡처 옵션 ─────────────
 * 사람 말을 정해진 조정으로 옮긴다. AI 가 아니라 낱말 맞추기다 — 알아들은
 * 것과 못 알아들은 것을 그대로 돌려준다. */
const RULES = [
  { re: /(gnb|헤더|header|상단\s*메뉴|내비|메뉴\s*바).*(빼|없|지우|숨|제거|삭제)|(빼|없|지우|숨|제거|삭제).*(gnb|헤더|header)/i, key: 'hideHeader', text: '첫 화면에서도 헤더(GNB)를 숨김' },
  { re: /팝업|모달|modal|popup|레이어|딤|dim|배너\s*닫|쿠키/i, key: 'closePopups', text: '팝업·모달·딤을 지움' },
  { re: /천천|느리게|느긋|더\s*기다|오래\s*기다|로딩.*(기다|안\s*뜨|덜)|이미지.*(안\s*뜨|덜|깨)|늦게/i, key: 'slow', text: '기다리는 시간을 2배로' },
  { re: /선명|고해상|2배|두\s*배|확대|크게|레티나|retina/i, key: 'scale2', text: '2배율로 선명하게' },
  { re: /한\s*방|한번에|fullpage|풀페이지\s*모드|이어\s*붙이지/i, key: 'fullpage', text: '한 방에 찍는 방식으로' },
  { re: /검사\s*(없|빼|끄)|한\s*번만|빨리/i, key: 'noCheck', text: '검사 없이 한 번만' },
  { re: /모바일|375|폰|아이폰/i, key: 'w375', text: '모바일 375 로' },
  { re: /1440/i, key: 'w1440', text: '데스크탑 1440 으로' },
  { re: /1920|큰\s*화면|와이드/i, key: 'w1920', text: '데스크탑 1920 으로' },
];
function parseRequest(text) {
  const tweaks = {}; const applied = []; const ignored = [];
  // 문장 단위로 본다 — "GNB 빼줘. 로고 색도 바꿔줘" 에서 뒤 문장은 못 알아들은 것으로 남겨야 한다
  const parts = String(text || '').split(/[.\n,]|그리고|그리구|또/).map((x) => x.trim()).filter(Boolean);
  for (const part of parts) {
    let hit = false;
    for (const r of RULES) if (r.re.test(part)) { hit = true; if (!tweaks[r.key]) { tweaks[r.key] = true; applied.push(r.text); } }
    if (!hit) ignored.push(part);
  }
  return { tweaks, applied, ignored: ignored.join(' / ') };
}

/** 한 페이지를 다시 찍는다. 이전 그림은 남기고 새 그림을 "(다시 N)" 으로 옆에 둔다. */
function retake(job, row, { tweaks, applied, ignored, request }) {
  const width = tweaks.w375 ? 375 : tweaks.w1440 ? 1440 : tweaks.w1920 ? 1920 : job.width;
  const device = DEVICES[width];
  const scale = tweaks.scale2 ? 2 : device.scale;
  row.retakes = (row.retakes || 0) + 1;
  const n = row.retakes;
  const base = (row.name || 'page').replace(/ \(다시 \d+\)$/, '');
  const fixedName = `${base} (다시 ${n})`;
  row.status = '다시 찍는 중';
  row.request = request; row.applied = applied; row.ignored = ignored;
  job.status = '진행 중';
  job.log.push(`  ↻ ${row.path || row.name} 다시 찍기${applied.length ? ' — ' + applied.join(', ') : ''}${ignored ? ` (못 알아들음: "${ignored}")` : ''}`);
  writeFileSync(join(job.outDir, `${fixedName} 수정요청.txt`),
    `요청: ${request}\n적용: ${applied.join(', ') || '(없음)'}\n못 알아들음: ${ignored || '(없음)'}\n`);
  serial(async () => {
    await ensureBrowser();
    try {
      await shootAll({
        args: { concurrency: 1, mode: tweaks.fullpage ? 'fullpage' : 'stitch', keepPieces: true },
        urls: [row.url], host, pick, device, scale, outDir: job.outDir,
        check: job.check && !tweaks.noCheck, retry: 2, fixedName, writeIndex: false,
        tweaks: { hideHeader: !!tweaks.hideHeader, closePopups: !!tweaks.closePopups, slow: !!tweaks.slow },
        log: (m) => { if (m && !/^\s*$/.test(m)) job.log.push(String(m).trimEnd()); if (job.log.length > 400) job.log.shift(); },
        onProgress: (url, label, m) => { job.activity[normUrl(url)] = `${label} · ${m}`; },
        onRow: (fresh) => {
          const prev = { files: row.files, status: row.status };
          Object.assign(row, fresh, { path: row.path, retakes: n, request, applied, ignored, previous: [...(row.previous || []), ...(prev.files || [])] });
          delete job.activity[normUrl(row.url)];
        },
      });
    } catch (e) {
      row.status = '실패'; row.error = e.message.split('\n')[0];
    }
    // 목록·보고서는 전체 결과로 다시 쓴다 — 한 장만 다시 찍었다고 목록이 한 장이 되면 안 된다
    try { writeOutputs(job.rows, { ...job.meta, when: new Date().toLocaleString('ko-KR') }, job.outDir); } catch { /* 무시 */ }
    job.status = '완료';
    job.finishedAt = Date.now();
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.PORT || 8890);
// 기본은 내 컴퓨터 안(127.0.0.1). 서버에 올려 밖에서 쓰려면 --host 0.0.0.0 (Dockerfile 이 그렇게 띄운다).
const HOST = args.host || process.env.HOST || '127.0.0.1';
const PUBLIC = HOST !== '127.0.0.1' && HOST !== 'localhost';
// 밖으로 열 때는 비밀번호를 건다. 아무나 남의 사이트를 캡처하게 두면 안 된다.
const PASSWORD = process.env.APP_PASSWORD || args.password || '';
const OUT_ROOT = resolve(HERE, args.out || './결과/앱');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

/* ───────────── 브라우저는 하나만 띄워 두고, 일은 한 번에 하나씩 ───────────── */

let pick = null;
let host = null;
let chain = Promise.resolve();
const serial = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};

let activity = { text: '', at: 0 };
const say = (text) => { activity = { text, at: Date.now() }; };

async function ensureBrowser() {
  if (!host) { pick = await pickBrowser(); host = createBrowserHost(); }
}

/* ───────────── 정보구조에서 찍을 페이지 목록을 뽑는다 ───────────── */

const normUrl = (href) => {
  try { const u = new URL(href); u.hash = ''; return u.href.replace(/\/$/, ''); } catch { return href; }
};

function pagesFrom(result, entered) {
  const seen = new Set();
  const pages = [];
  const add = (label, href, path) => {
    const k = normUrl(href);
    if (seen.has(k)) return;
    seen.add(k);
    pages.push({ label, url: href, path });
  };
  add('홈', result.finalUrl || entered, ['홈']);
  const walk = (items, path) => {
    for (const it of items) {
      const p = [...path, it.label];
      if (it.kind === '페이지' || it.home) add(it.label, it.href, p);
      walk(it.children || [], p);
    }
  };
  walk(result.menu, []);
  return pages;
}

/* ───────────── 작업(캡처) 관리 ───────────── */

const jobs = new Map();
let seq = 0;

function startJob({ pages, width, check }) {
  const device = DEVICES[width] || DEVICES[1920];
  const id = `${Date.now().toString(36)}-${++seq}`;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
  let hostName = 'site';
  try { hostName = new URL(pages[0].url).hostname; } catch { /* 무시 */ }
  const outDir = join(OUT_ROOT, `${stamp} ${hostName} ${device.width}`);
  mkdirSync(outDir, { recursive: true });

  const job = { id, status: '대기', device: device.label, width: device.width, check, outDir, total: pages.length,
    requested: pages.map((p) => ({ url: p.url, path: p.path.join(' > ') })),
    rows: [], log: [], activity: {}, startedAt: Date.now() };
  writeFileSync(join(outDir, '요청목록.txt'), pages.map((p) => `${p.path.join(' > ')}\t${p.url}`).join('\n') + '\n');
  jobs.set(id, job);
  const labelOf = new Map(pages.map((p) => [normUrl(p.url), p.path.join(' > ')]));

  serial(async () => {
    job.status = '진행 중';
    await ensureBrowser();
    job.meta = { scale: device.scale, out: outDir, browser: pick.name, codecs: pick.codecs, device: device.label, width: device.width };
    try {
      await shootAll({
        args: { concurrency: 2, keepPieces: true },
        urls: pages.map((p) => p.url), host, pick, device, scale: device.scale,
        outDir, check, retry: 2,
        log: (m) => { if (m && !/^\s*$/.test(m)) job.log.push(String(m).trimEnd()); if (job.log.length > 400) job.log.shift(); },
        onRow: (row) => { job.rows.push({ ...row, path: labelOf.get(normUrl(row.url)) || row.name }); delete job.activity[normUrl(row.url)]; },
        onProgress: (url, label, m) => { job.activity[normUrl(url)] = `${label} · ${m}`; },
      });
      // 요청했는데 결과가 안 온 페이지는 조용히 넘기지 않는다
      for (const p of pages) {
        if (!job.rows.some((r) => normUrl(r.url) === normUrl(p.url))) {
          job.rows.push({ name: p.path.join(' > '), path: p.path.join(' > '), url: p.url, status: '실패', error: '결과가 돌아오지 않았습니다 (보고서.txt 를 보내 주세요)', files: [] });
          job.log.push(`  ✗ ${p.path.join(' > ')} — 결과 없음`);
        }
      }
      job.status = '완료';
    } catch (e) {
      job.status = '실패';
      job.error = e.message.split('\n')[0];
    }
    job.finishedAt = Date.now();
  });
  return job;
}

/* ───────────── HTTP ───────────── */

const readBody = (req) => new Promise((res, rej) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
  req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); } });
  req.on('error', rej);
});
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(obj)); };

/** 이 요청이 이 컴퓨터의 브라우저에서 온 것인가. 터널(ngrok·cloudflared)이나 다른
 *  컴퓨터에서 온 요청에는 맥 저장 창을 띄우면 안 된다 — 창은 여기 뜨고 그 사람은 못 본다. */
const isLocalRequest = (req) => {
  const ip = req.socket.remoteAddress || '';
  const host = (req.headers.host || '').split(':')[0];
  return !req.headers['x-forwarded-for'] && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip)
    && (host === '127.0.0.1' || host === 'localhost');
};

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    // 비밀번호가 걸려 있으면 ?key= 로 한 번 들어온 뒤 쿠키로 통과한다.
    if (PASSWORD) {
      const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('key='));
      const given = u.searchParams.get('key') || (cookie ? decodeURIComponent(cookie.slice(4)) : '');
      if (given !== PASSWORD) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }).end(
          `<meta charset="utf-8"><body style="font:16px/1.6 -apple-system,sans-serif;padding:40px"><h2>웹사이트 스냅샷</h2>
           <form><p>비밀번호 <input name="key" type="password" autofocus> <button>들어가기</button></p></form></body>`);
        return;
      }
      if (u.searchParams.get('key')) {
        res.setHeader('set-cookie', `key=${encodeURIComponent(PASSWORD)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
        if (u.pathname === '/') { res.writeHead(302, { location: '/' }).end(); return; }
      }
    }
    if (req.method === 'GET' && u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(join(HERE, 'app.html')));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/sitemap') {
      const { url } = await readBody(req);
      if (!url || !/^https?:\/\//i.test(url)) return json(res, 400, { ok: false, error: '주소는 http:// 또는 https:// 로 시작해야 합니다' });
      const r = await serial(async () => {
        await ensureBrowser();
        const browser = await host.get();
        const ctx = await browser.newContext(contextOptionsFor(DEVICES[1440], 1));
        say('브라우저를 띄우는 중');
        try { return await extractSitemap(ctx, url, { depth: 0, onProgress: say }); }
        finally { say(''); await ctx.close().catch(() => {}); }
      });
      if (!r.ok) return json(res, 200, r);
      const { headerHtml, ...rest } = r;
      return json(res, 200, { ...rest, pages: pagesFrom(r, url), tree: renderTree(r), browser: pick && pick.name });
    }
    if (req.method === 'POST' && u.pathname === '/api/capture') {
      const { pages, width, check } = await readBody(req);
      if (!Array.isArray(pages) || !pages.length) return json(res, 400, { ok: false, error: '찍을 페이지가 없습니다' });
      if (!DEVICES[width]) return json(res, 400, { ok: false, error: `화면 크기 ${width} 는 없습니다` });
      const job = startJob({ pages, width, check: check !== false });
      return json(res, 200, { ok: true, id: job.id, outDir: job.outDir });
    }
    if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, { ok: true, ...activity });
    if (req.method === 'POST' && u.pathname === '/api/retake') {
      const { id, url, request } = await readBody(req);
      const job = jobs.get(id);
      if (!job) return json(res, 404, { ok: false, error: '없는 작업' });
      const row = job.rows.find((r) => normUrl(r.url) === normUrl(url || ''));
      if (!row) return json(res, 404, { ok: false, error: '그 페이지의 결과가 없습니다' });
      const { tweaks, applied, ignored } = parseRequest(request || '');
      retake(job, row, { tweaks, applied, ignored, request: request || '' });
      return json(res, 200, { ok: true, applied, ignored });
    }
    if (req.method === 'GET' && u.pathname.startsWith('/download/')) {
      const d = downloads.get(u.pathname.slice('/download/'.length));
      if (!d || !existsSync(d.filePath)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('없거나 만료된 파일'); return; }
      res.writeHead(200, {
        'content-type': d.mime, 'cache-control': 'no-store',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}`,
        'content-length': statSync(d.filePath).size,
      });
      createReadStream(d.filePath).pipe(res);
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/pickSave') {
      const { id, format } = await readBody(req);
      const job = jobs.get(id);
      if (!job) return json(res, 404, { ok: false, error: '없는 작업' });
      let hostName = 'site';
      try { hostName = new URL(job.requested[0].url).hostname; } catch { /* 무시 */ }
      if (!isLocalRequest(req)) return json(res, 200, { ok: true, native: false });
      return json(res, 200, await pickSavePath({ defaultName: `${hostName} ${job.width}`, format }));
    }
    if (req.method === 'POST' && u.pathname === '/api/export') {
      const { id, urls, format, dir, name } = await readBody(req);
      const job = jobs.get(id);
      if (!job) return json(res, 404, { ok: false, error: '없는 작업' });
      // 저장 위치·이름은 사용자가 정한다. 비우면 작업 폴더의 내보내기/ 와 "<사이트> <폭>".
      let hostName = 'site';
      try { hostName = new URL(job.requested[0].url).hostname; } catch { /* 무시 */ }
      const baseDir = resolve(String(dir || '').trim().replace(/^~(?=$|\/)/, process.env.HOME || '') || join(job.outDir, '내보내기'));
      const outName = safeName(name) === 'page' && !String(name || '').trim() ? `${hostName} ${job.width}` : safeName(name);
      try { mkdirSync(baseDir, { recursive: true }); } catch (e) { return json(res, 400, { ok: false, error: `저장 위치를 만들 수 없습니다: ${e.message}` }); }
      const want = Array.isArray(urls) && urls.length ? new Set(urls.map(normUrl)) : null;
      // 정보구조 순서(요청 순서)대로
      const order = new Map(job.requested.map((p, i) => [normUrl(p.url), i]));
      const rows = job.rows
        .filter((r) => r.files && r.files.length && (!want || want.has(normUrl(r.url))))
        .sort((a, b) => (order.get(normUrl(a.url)) ?? 999) - (order.get(normUrl(b.url)) ?? 999));
      if (!rows.length) return json(res, 400, { ok: false, error: '내보낼 그림이 없습니다' });
      const viaBrowser = PUBLIC || process.platform !== 'darwin' || !isLocalRequest(req);
      if (format === 'pdf') {
        const r = await exportPdf(job, rows, { baseDir, name: outName });
        if (viaBrowser) return json(res, 200, { ok: true, format, pages: r.pages, count: rows.length, download: offerDownload(r.file, `${outName}.pdf`, 'application/pdf') });
        reveal(r.file);
        return json(res, 200, { ok: true, format, path: r.file, pages: r.pages, count: rows.length });
      }
      const r = exportImages(job, rows, { baseDir, name: outName });
      if (viaBrowser) {
        // 폴더는 브라우저로 못 내려준다. zip 으로 묶어 준다 — 풀면 같은 폴더가 된다.
        const zip = new AdmZip();
        zip.addLocalFolder(r.dir, outName);
        const zipPath = join(baseDir, `${outName}.zip`);
        zip.writeZip(zipPath);
        return json(res, 200, { ok: true, format: 'img', files: r.files, count: rows.length, download: offerDownload(zipPath, `${outName}.zip`, 'application/zip') });
      }
      reveal(join(r.dir, r.files[0]));
      return json(res, 200, { ok: true, format: 'img', path: r.dir, files: r.files, count: rows.length });
    }
    if (req.method === 'GET' && u.pathname === '/api/job') {
      const job = jobs.get(u.searchParams.get('id'));
      if (!job) return json(res, 404, { ok: false, error: '없는 작업' });
      let hostName = 'site';
      try { hostName = new URL(job.requested[0].url).hostname; } catch { /* 무시 */ }
      return json(res, 200, { ok: true, ...job, exportDefaults: { dir: join(job.outDir, '내보내기'), name: `${hostName} ${job.width}` } });
    }
    // 결과 파일. /files/<작업>/<파일>
    if (req.method === 'GET' && u.pathname.startsWith('/files/')) {
      const [, , id, ...rest] = u.pathname.split('/').map(decodeURIComponent);
      const job = jobs.get(id);
      const name = rest.join('/');
      if (!job || !name || name.includes('..')) { res.writeHead(404).end(); return; }
      const file = join(job.outDir, name);
      if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('없는 주소');
  } catch (e) {
    json(res, 500, { ok: false, error: e.message.split('\n')[0] });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? '<서버 주소>' : HOST}:${PORT}/`;
  console.log(`\n  열렸습니다 → ${url}`);
  console.log(`  결과 저장 위치: ${OUT_ROOT}`);
  if (PUBLIC && !PASSWORD) console.log('  ⚠ 밖으로 열었는데 비밀번호가 없습니다. APP_PASSWORD 를 거세요.');
  if (PASSWORD) console.log('  비밀번호가 걸려 있습니다 (APP_PASSWORD)');
  console.log('  끝내려면 Ctrl+C\n');
  if (process.platform === 'darwin' && !PUBLIC) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
});

process.on('SIGINT', async () => {
  console.log('\n정리하고 끝냅니다…');
  server.close();
  if (host) await host.close().catch(() => {});
  process.exit(0);
});
