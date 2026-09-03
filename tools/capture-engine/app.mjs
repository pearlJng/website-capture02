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
import { shootAll } from './shoot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || 8890);
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

  const job = { id, status: '대기', device: device.label, width: device.width, outDir, total: pages.length, rows: [], log: [], startedAt: Date.now() };
  jobs.set(id, job);
  const labelOf = new Map(pages.map((p) => [normUrl(p.url), p.path.join(' > ')]));

  serial(async () => {
    job.status = '진행 중';
    await ensureBrowser();
    try {
      await shootAll({
        args: { concurrency: 2 },
        urls: pages.map((p) => p.url), host, pick, device, scale: device.scale,
        outDir, check, retry: 2,
        log: (m) => { if (m && !/^\s*$/.test(m)) job.log.push(String(m).trimEnd()); if (job.log.length > 400) job.log.shift(); },
        onRow: (row) => { job.rows.push({ ...row, path: labelOf.get(normUrl(row.url)) || row.name }); },
      });
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

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
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
        try { return await extractSitemap(ctx, url, { depth: 0 }); }
        finally { await ctx.close().catch(() => {}); }
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
    if (req.method === 'GET' && u.pathname === '/api/job') {
      const job = jobs.get(u.searchParams.get('id'));
      if (!job) return json(res, 404, { ok: false, error: '없는 작업' });
      return json(res, 200, { ok: true, ...job });
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

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`\n  열렸습니다 → ${url}`);
  console.log(`  결과 저장 위치: ${OUT_ROOT}`);
  console.log('  끝내려면 Ctrl+C\n');
  if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
});

process.on('SIGINT', async () => {
  console.log('\n정리하고 끝냅니다…');
  server.close();
  if (host) await host.close().catch(() => {});
  process.exit(0);
});
