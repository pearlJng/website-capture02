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
import { spawn, execFileSync } from 'node:child_process';
import { DEVICES, contextOptionsFor } from './capture.mjs';
import { createBrowserHost, pickBrowser } from './browser.mjs';
import { extractSitemap, renderTree } from './sitemap.mjs';
import { shootAll, writeOutputs } from './shoot.mjs';
import { writeFileSync, copyFileSync, readFileSync as readBytes } from 'node:fs';
import { PDFDocument, rgb } from 'pdf-lib';
import { mergePngsVertically, stitchUserShots } from './png.mjs';
import { startManual, stateManual, scrollManual, shotManual, undoManual, finishManual, closeManual, closeAllManual, pressManual } from './manual.mjs';
import AdmZip from 'adm-zip';
import { applyLauncherIconOnce, syncLauncher } from './icon.mjs';
import { ensureMacApp } from './macapp.mjs';

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

/**
 * 고른 결과를 정보구조 순서대로 번호를 붙여 폴더에 복사한다.
 * 아주 긴 페이지는 20,000px 씩 여러 장으로 찍혀 있다 — 내보낼 때는 한 페이지 = 한 파일로
 * 이어 붙인다(Node 에서 바이트로). 붙이기에 실패하면 장 수대로 (1)(2)… 로 낸다.
 */
function exportImages(job, rows, { baseDir, name }) {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  const pad = String(rows.length).length;
  const files = [];
  rows.forEach((row, i) => {
    const base = `${String(i + 1).padStart(pad, '0')} ${safeName(row.path || row.name)}`;
    const list = row.files || [];
    if (list.length > 1 && list.every((f) => /\.png$/i.test(f))) {
      try {
        const merged = mergePngsVertically(list.map((f) => readBytes(join(job.outDir, f))));
        writeFileSync(join(dir, `${base}.png`), merged);
        files.push(`${base}.png`);
        return;
      } catch { /* 아래에서 장 수대로 */ }
    }
    list.forEach((f, k) => {
      const name = `${base}${list.length > 1 ? ` (${k + 1})` : ''}${extname(f).toLowerCase() || '.png'}`;
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
      const bytes = readBytes(join(job.outDir, f));
      const png = /\.jpe?g$/i.test(f) ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
      // 화면 픽셀을 그대로 pt 로 쓴다 (1px = 1pt). 배율 2 면 절반으로 줄여 실제 크기를 맞춘다.
      // 직접 올린 그림은 배율을 모른다 — 레티나로 찍어 폭이 1.5배 넘게 크면 작업 폭에 맞춘다.
      let k = 1 / (job.meta && job.meta.scale ? job.meta.scale : 1);
      if (row.manual && job.width && png.width >= job.width * 1.5) k = job.width / png.width;
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

/* ───────────── 보드: 큰 대지 한 장에 페이지를 늘어놓는다 ─────────────
 * 팀장님이 피그마처럼 큰 대지에서 한눈에 보도록. 1depth 메뉴마다 한 줄, 그 안의 페이지를 가로로.
 * 페이지마다 위에 이름, 줄마다 왼쪽 위에 메뉴 이름. 두 가지로 낸다:
 *   board — PDF 한 쪽(미리보기·Acrobat 에서 확대해 본다). 그림은 원래 해상도로 들어간다.
 *   figma — SVG(피그마에 끌어다 놓으면 페이지마다 이름 붙은 묶음이 된다). 피그마는 4096px 넘는
 *           그림을 줄여 흐려지므로, 긴 페이지는 4000px 조각으로 잘라 넣는다.
 * 그림은 이 앱의 /files 주소로 브라우저에 불러와 캔버스로 자른다(큰 그림을 CDP 로 넘기지 않는다). */
const xmlEsc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function exportBoard(job, rows, { baseDir, name, kind }) {
  await ensureBrowser();
  const browser = await host.get();
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const origin = `http://127.0.0.1:${PORT}`;
  if (PASSWORD) await ctx.addCookies([{ name: 'key', value: encodeURIComponent(PASSWORD), url: origin }]);
  const page = await ctx.newPage();
  try {
    await page.goto(`${origin}/icon.png`).catch(() => {});
    const FW = job.width || 1440;                                  // 대지 위 페이지 폭 (CSS px)
    const px = Math.round(FW * Math.min(job.meta && job.meta.scale ? job.meta.scale : 1, 2));   // 실제 그림 폭
    const TILE = 4000;
    const G = Math.round(Math.max(80, FW * 0.08)), LH = Math.round(Math.max(56, FW * 0.045)), GH = Math.round(Math.max(90, FW * 0.07)), RG = Math.round(Math.max(160, FW * 0.12)), M = Math.round(Math.max(120, FW * 0.1));
    // 1depth 메뉴로 묶는다 (요청 순서 그대로)
    const groups = [];
    for (const row of rows) {
      const head = String(row.path || row.name).split(' > ')[0];
      let g = groups.find((x) => x.name === head);
      if (!g) { g = { name: head, frames: [] }; groups.push(g); }
      g.frames.push({ row, label: row.path || row.name });
    }
    // 페이지마다 그림을 불러와 폭을 맞추고 조각으로 자른다
    for (const g of groups) {
      for (const f of g.frames) {
        const urls = (f.row.files || []).map((file) => `${origin}/files/${encodeURIComponent(job.id)}/${encodeURIComponent(file)}`);
        const r = await page.evaluate(async ({ urls, outW, tileH }) => {
          const imgs = await Promise.all(urls.map((u) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('그림을 못 불러옴: ' + u)); i.src = u; })));
          const k = outW / imgs[0].naturalWidth;
          const H = Math.round(imgs.reduce((n, i) => n + i.naturalHeight * k, 0));
          const tiles = [];
          for (let y = 0; y < H; y += tileH) {
            const h = Math.min(tileH, H - y);
            const cv = document.createElement('canvas'); cv.width = outW; cv.height = h;
            const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, outW, h);
            let off = 0;
            for (const im of imgs) { const ih = im.naturalHeight * k; if (off + ih > y && off < y + h) cx.drawImage(im, 0, off - y, outW, ih); off += ih; }
            tiles.push({ y, h, data: cv.toDataURL('image/jpeg', 0.86).split(',')[1] });
          }
          return { H, tiles };
        }, { urls, outW: px, tileH: TILE });
        const k = FW / px;                                           // 그림 px → 대지 단위
        f.h = Math.round(r.H * k);
        f.tiles = r.tiles.map((t) => ({ y: t.y * k, h: t.h * k, data: t.data }));
      }
    }
    // 배치
    let y = M, W = 0;
    for (const g of groups) {
      g.y = y;
      let x = M;
      const rowH = Math.max(...g.frames.map((f) => f.h));
      for (const f of g.frames) { f.x = x; f.y = y + GH + LH; x += FW + G; }
      W = Math.max(W, x - G + M);
      y += GH + LH + rowH + RG;
    }
    const H = y - RG + M;
    const title = `${(() => { try { return new URL(rows[0].url).hostname; } catch { return 'site'; } })()} · ${job.device || FW + 'px'} · ${rows.length}페이지`;

    if (kind === 'figma') {
      const font = "Pretendard, 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif";
      const out = [`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
        `<rect id="배경" width="${W}" height="${H}" fill="#F3F4F6"/>`,
        `<text id="제목" x="${M}" y="${Math.round(M * 0.6)}" font-family="${font}" font-size="${Math.round(GH * 0.45)}" fill="#6B7280">${xmlEsc(title)}</text>`];
      const idOf = (t) => xmlEsc(String(t).replace(/\s*>\s*/g, '-').replace(/\s+/g, '_'));
      for (const g of groups) {
        out.push(`<g id="${idOf('메뉴 ' + g.name)}">`, `<text x="${M}" y="${g.y + Math.round(GH * 0.7)}" font-family="${font}" font-size="${Math.round(GH * 0.55)}" font-weight="700" fill="#111827">${xmlEsc(g.name)} <tspan fill="#9CA3AF" font-weight="400">${g.frames.length}</tspan></text>`);
        for (const f of g.frames) {
          out.push(`<g id="${idOf(f.label)}">`, `<text x="${f.x}" y="${f.y - Math.round(LH * 0.35)}" font-family="${font}" font-size="${Math.round(LH * 0.5)}" fill="#374151">${xmlEsc(f.label)}</text>`,
            `<rect x="${f.x}" y="${f.y}" width="${FW}" height="${f.h}" fill="#fff"/>`);
          for (const t of f.tiles) out.push(`<image x="${f.x}" y="${(f.y + t.y).toFixed(2)}" width="${FW}" height="${t.h.toFixed(2)}" preserveAspectRatio="none" xlink:href="data:image/jpeg;base64,${t.data}"/>`);
          out.push(`<rect x="${f.x}" y="${f.y}" width="${FW}" height="${f.h}" fill="none" stroke="#D1D5DB" stroke-width="2"/>`, '</g>');
        }
        out.push('</g>');
      }
      out.push('</svg>');
      const file = join(baseDir, `${name}.svg`);
      writeFileSync(file, out.join('\n'));
      return { file, pages: rows.length, width: W, height: H };
    }

    // PDF 한 쪽 — 보통 뷰어가 14,400pt 까지 연다. 넘으면 전체를 줄인다(그림 해상도는 그대로).
    const s = Math.min(1, 14400 / Math.max(W, H));
    const pdf = await PDFDocument.create();
    pdf.setTitle(title);
    const pg = pdf.addPage([W * s, H * s]);
    pg.drawRectangle({ x: 0, y: 0, width: W * s, height: H * s, color: rgb(0.953, 0.957, 0.965) });
    // 글자는 한글 글꼴을 PDF 에 넣는 대신 브라우저에서 그림으로 그려 붙인다
    const textPng = async (text, size, color, bold) => {
      const r = await page.evaluate(({ text, size, color, bold }) => {
        const cv = document.createElement('canvas'); const cx = cv.getContext('2d');
        const font = `${bold ? 700 : 500} ${size}px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
        cx.font = font; const w = Math.ceil(cx.measureText(text).width) + 4;
        cv.width = w; cv.height = Math.ceil(size * 1.35);
        cx.font = font; cx.fillStyle = color; cx.textBaseline = 'top'; cx.fillText(text, 2, Math.round(size * 0.12));
        return { w: cv.width, h: cv.height, data: cv.toDataURL('image/png').split(',')[1] };
      }, { text, size: size * 2, color, bold });
      return { img: await pdf.embedPng(Buffer.from(r.data, 'base64')), w: r.w / 2, h: r.h / 2 };
    };
    const put = (img, x, yTop, w, h) => pg.drawImage(img, { x: x * s, y: (H - yTop - h) * s, width: w * s, height: h * s });
    const t0 = await textPng(title, Math.round(GH * 0.45), '#6B7280', false);
    put(t0.img, M, Math.round(M * 0.25), t0.w, t0.h);
    for (const g of groups) {
      const gt = await textPng(`${g.name}  ${g.frames.length}`, Math.round(GH * 0.55), '#111827', true);
      put(gt.img, M, g.y + Math.round(GH * 0.15), gt.w, gt.h);
      for (const f of g.frames) {
        const lt = await textPng(f.label, Math.round(LH * 0.5), '#374151', false);
        put(lt.img, f.x, f.y - Math.round(LH * 0.85), Math.min(lt.w, FW), lt.h);
        pg.drawRectangle({ x: f.x * s, y: (H - f.y - f.h) * s, width: FW * s, height: f.h * s, color: rgb(1, 1, 1), borderColor: rgb(0.82, 0.835, 0.86), borderWidth: Math.max(0.5, 2 * s) });
        for (const t of f.tiles) put(await pdf.embedJpg(Buffer.from(t.data, 'base64')), f.x, f.y + t.y, FW, t.h);
      }
    }
    const file = join(baseDir, `${name}.pdf`);
    writeFileSync(file, await pdf.save());
    return { file, pages: rows.length, width: W, height: H };
  } finally {
    await ctx.close().catch(() => {});
  }
}

const reveal = (path) => { if (process.platform === 'darwin') spawn('open', ['-R', path], { stdio: 'ignore', detached: true }).unref(); };

/**
 * macOS 의 "별도 저장" 창을 띄워 이름과 위치를 받는다. 앱이 이 컴퓨터에서 돌기
 * 때문에 가능하다 — 브라우저 화면 안에서 이름·위치를 적게 하는 것보다 익숙하다.
 * 취소하면 { cancelled: true }. 맥이 아니면 { native: false } — 화면이 기본 위치를 쓴다.
 */
function pickSavePath({ defaultName, format }) {
  if (process.platform !== 'darwin' || PUBLIC) return Promise.resolve({ ok: true, native: false });
  const ext = format === 'pdf' || format === 'board' ? '.pdf' : format === 'figma' ? '.svg' : '';
  const name = safeName(defaultName) + (format === 'board' ? ' 보드' : format === 'figma' ? ' 피그마' : '') + ext;
  const prompt = { pdf: 'PDF 로 저장', board: '보드 PDF 로 저장', figma: '피그마용 SVG 로 저장' }[format] || '이미지 폴더로 저장';
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
      if (ext && !path.toLowerCase().endsWith(ext)) path += ext;
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
        args: { concurrency: 1, mode: tweaks.fullpage ? 'fullpage' : 'stitch', keepPieces: true, lang: job.lang },
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
    if (job.lang) writeLangReport(job);
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
  '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.csv': 'text/csv; charset=utf-8',
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

/** 언어 검수 결과를 결과 폴더에 글로 남긴다 — 보고 전에 고칠 곳 목록으로 쓴다 */
function writeLangReport(job) {
  const NAME = { ko: '국문', ja: '일문(가나)', zh: '한자' };
  const T = { en: '영문', ja: '일문', zh: '중문' }[job.lang] || job.lang;
  const L = [`언어 검수 — ${T} 사이트 (${new Date().toLocaleString('ko-KR')})`,
    `규칙: 국문은 어디서도 안 됨 · 영문 사이트는 영문만 · 일문·중문 사이트는 그 언어와 영문까지`,
    '그림 속 글자(로고·배너 이미지)는 읽지 못합니다 — 화면의 글자만 봅니다', ''];
  let bad = 0;
  for (const r of job.rows) {
    if (!r.lang) continue;
    if (!r.lang.total) { L.push(`✓ ${r.path || r.name}  ${r.url}`); continue; }
    bad++;
    L.push(`✗ ${r.path || r.name}  ${r.url}  — ${Object.entries(r.lang.counts).map(([k, v]) => `${NAME[k] || k} ${v}곳`).join(' · ')}`);
    for (const it of r.lang.items.slice(0, 60)) L.push(`    ${String(it.y).padStart(6)}px  [${NAME[it.lang] || it.lang}] ${it.text}`);
    if (r.lang.items.length > 60) L.push(`    … ${r.lang.items.length - 60}곳 더`);
  }
  L.splice(3, 0, bad ? `걸린 페이지 ${bad}곳` : '모든 페이지 통과');
  try { writeFileSync(join(job.outDir, '언어검수.txt'), L.join('\n') + '\n'); } catch { /* 무시 */ }
}

function startJob({ pages, width, check, lang = null }) {
  const device = DEVICES[width] || DEVICES[1920];
  const id = `${Date.now().toString(36)}-${++seq}`;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
  let hostName = 'site';
  try { hostName = new URL(pages[0].url).hostname; } catch { /* 무시 */ }
  const outDir = join(OUT_ROOT, `${stamp} ${hostName} ${device.width}`);
  mkdirSync(outDir, { recursive: true });

  const job = { id, status: '대기', device: device.label, width: device.width, check, lang, outDir, total: pages.length,
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
        args: { concurrency: 2, keepPieces: true, lang: job.lang },
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
      if (job.lang) writeLangReport(job);
      job.status = '완료';
    } catch (e) {
      job.status = '실패';
      job.error = e.message.split('\n')[0];
    }
    job.finishedAt = Date.now();
  });
  return job;
}

/** 직접 찍기 결과를 카드(행)에 넣는다 — 창 안의 "완성" 버튼과 HTTP 둘 다 여기로 온다. */
function applyManualResult(job, row, r) {
  row.manual = (row.manual || 0) + 1;
  const base = (row.name || 'page').replace(/ \((다시|직접) \d+\)$/, '');
  const files = r.slices.map((buf, i) => {
    const f = r.slices.length === 1 ? `${base} (직접 ${row.manual}).png` : `${base} (직접 ${row.manual}) (${i + 1}).png`;
    writeFileSync(join(job.outDir, f), buf);
    return f;
  });
  row.previous = [...(row.previous || []), ...(row.files || [])];
  Object.assign(row, { files, status: '직접 찍음', error: '', gaps: [], diffFile: '', pieceFiles: [], docHeight: r.height,
    notes: r.notes, manualNote: r.notes.join(' · '), manualKey: null });
  job.log.push(`  ✎ ${row.path || row.name} 크롬 창에서 직접 찍음 (${files.join(', ')})`);
  try { writeOutputs(job.rows, { ...job.meta, when: new Date().toLocaleString('ko-KR') }, job.outDir); } catch { /* 무시 */ }
  return { files, notes: r.notes };
}

/* ───────────── HTTP ───────────── */

const readBody = (req) => new Promise((res, rej) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
  req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); } });
  req.on('error', rej);
});
/** 그림 파일 같은 날것 본문. 80MB 까지 — 긴 페이지를 레티나로 찍으면 수십 MB 가 된다. */
const readRaw = (req, max = 80e6) => new Promise((res, rej) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > max) { req.destroy(); rej(new Error('그림이 너무 큽니다 (80MB 까지)')); return; } chunks.push(c); });
  req.on('end', () => res(Buffer.concat(chunks)));
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

// 지금 켜진 앱이 어느 코드로 켜졌는지. 실행 파일이 이걸 보고, 예전 코드로 켜져 있으면 끄고 새로 켠다.
const HEAD = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } })();

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    // 비밀번호와 상관없이 이 컴퓨터에서만 — 코드 버전과 캡처 중인지
    if (req.method === 'GET' && u.pathname === '/api/version' && isLocalRequest(req)) {
      const busy = [...jobs.values()].some((j) => j.status === '진행 중' || j.status === '대기');
      return json(res, 200, { ok: true, head: HEAD, busy, pid: process.pid });
    }
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
    // 앱 아이콘 (화면 머리·탭 아이콘)
    if (req.method === 'GET' && u.pathname === '/icon.png') {
      const f = join(HERE, 'icon', 'icon.png');
      if (existsSync(f)) { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=3600' }).end(readFileSync(f)); return; }
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
      // 판정이 틀렸을 때 보내 달라고 할 수 있게 헤더 원문과 진단을 남긴다
      let diagDir = '';
      try {
        let hostName = 'site'; try { hostName = new URL(r.finalUrl || url).hostname; } catch { /* 무시 */ }
        diagDir = join(OUT_ROOT, '분석', `${stampNow()} ${safeName(hostName)}`);
        mkdirSync(diagDir, { recursive: true });
        if (headerHtml) writeFileSync(join(diagDir, '헤더원문.html'), headerHtml);
        writeFileSync(join(diagDir, '진단.json'), JSON.stringify({ url, finalUrl: r.finalUrl, method: r.method, aliases: r.aliases, languages: r.languages, diag: r.diag, menu: r.menu, utility: r.utility, loose: r.loose }, null, 2));
        writeFileSync(join(diagDir, '메뉴구조.txt'), renderTree(r));
      } catch { /* 무시 */ }
      return json(res, 200, { ...rest, pages: pagesFrom(r, url), tree: renderTree(r), browser: pick && pick.name, diagDir });
    }
    if (req.method === 'POST' && u.pathname === '/api/capture') {
      const { pages, width, check, lang } = await readBody(req);
      if (!Array.isArray(pages) || !pages.length) return json(res, 400, { ok: false, error: '찍을 페이지가 없습니다' });
      if (!DEVICES[width]) return json(res, 400, { ok: false, error: `화면 크기 ${width} 는 없습니다` });
      const job = startJob({ pages, width, check: check !== false, lang: ['en', 'ja', 'zh'].includes(lang) ? lang : null });
      return json(res, 200, { ok: true, id: job.id, outDir: job.outDir });
    }
    if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, { ok: true, ...activity });
    // 터미널 없이 켠 앱은 여기서 끈다 (이 컴퓨터에서만)
    if (req.method === 'POST' && u.pathname === '/api/quit') {
      if (PUBLIC || !isLocalRequest(req)) return json(res, 200, { ok: false, error: '이 컴퓨터에서만 끌 수 있습니다' });
      const busy = [...jobs.values()].some((j) => j.status === '진행 중' || j.status === '대기');
      if (busy && u.searchParams.get('force') !== '1') return json(res, 200, { ok: false, busy: true, error: '지금 캡처 중입니다' });
      json(res, 200, { ok: true });
      setTimeout(() => shutdown(), 200);
      return;
    }
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
    // 직접 찍은 그림으로 바꾼다. 자동 캡처가 못 잡는 페이지(스크롤 위치마다 모양이 바뀌는 연혁 등)는
    // 사람이 크롬 전체 페이지 캡처로 찍어 올리는 편이 낫다. 이전 그림은 '이전'에 남긴다.
    if (req.method === 'POST' && u.pathname === '/api/replace') {
      const job = jobs.get(u.searchParams.get('id'));
      if (!job) return json(res, 404, { ok: false, error: '없는 작업' });
      const row = job.rows.find((r) => normUrl(r.url) === normUrl(u.searchParams.get('url') || ''));
      if (!row) return json(res, 404, { ok: false, error: '그 페이지의 결과가 없습니다' });
      const type = String(req.headers['content-type'] || '');
      // 여러 장(화면 조각)은 application/x-cap-parts: 첫 줄에 길이 목록(JSON), 그 뒤에 PNG 들을 이어 붙인 본문
      const multi = /x-cap-parts/i.test(type);
      const ext = multi || /png/i.test(type) ? '.png' : /jpe?g/i.test(type) ? '.jpg' : null;
      if (!ext) return json(res, 400, { ok: false, error: 'PNG 나 JPG 그림만 올릴 수 있습니다' });
      let buf;
      try { buf = await readRaw(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      if (buf.length < 100) return json(res, 400, { ok: false, error: '빈 파일입니다' });
      let stitchNotes = [];
      if (multi) {
        const nl = buf.indexOf(10);
        let lens;
        try { lens = JSON.parse(buf.subarray(0, nl).toString()); } catch { return json(res, 400, { ok: false, error: '조각 목록을 읽을 수 없습니다' }); }
        const parts = []; let o = nl + 1;
        for (const L of lens) { parts.push(buf.subarray(o, o + L)); o += L; }
        try {
          const r = stitchUserShots(parts);
          buf = r.png; stitchNotes = r.notes;
        } catch (e) { return json(res, 400, { ok: false, error: `이어 붙이지 못했습니다: ${e.message}` }); }
      }
      row.manual = (row.manual || 0) + 1;
      const base = (row.name || 'page').replace(/ \((다시|직접) \d+\)$/, '');
      const name = `${base} (직접 ${row.manual})${ext}`;
      writeFileSync(join(job.outDir, name), buf);
      row.previous = [...(row.previous || []), ...(row.files || [])];
      Object.assign(row, { files: [name], status: '직접 찍음', error: '', gaps: [], diffFile: '', pieceFiles: [],
        notes: ['직접 찍은 그림으로 바꿨습니다', ...stitchNotes],
        manualNote: multi ? `직접 찍은 조각을 이어 붙였습니다 — ${stitchNotes.join(' · ') || '겹침 없음'}` : '직접 찍은 그림으로 바꿨습니다' });
      job.log.push(`  ✎ ${row.path || row.name} 직접 찍은 그림으로 바꿈 (${name})`);
      try { writeOutputs(job.rows, { ...job.meta, when: new Date().toLocaleString('ko-KR') }, job.outDir); } catch { /* 무시 */ }
      return json(res, 200, { ok: true, file: name });
    }
    // ── 직접 찍기: 앱이 크롬 창을 띄우고, 사용자가 만든 화면을 "이 화면 찍기"로 찍어 위치대로 잇는다 ──
    if (req.method === 'POST' && u.pathname.startsWith('/api/manual/')) {
      const action = u.pathname.slice('/api/manual/'.length);
      const body = await readBody(req);
      if (action === 'start') {
        // 창은 이 컴퓨터에 뜬다. 터널·다른 컴퓨터에서 온 요청이면 그 사람은 창을 못 본다.
        if (PUBLIC || !isLocalRequest(req)) return json(res, 200, { ok: false, local: false, error: '크롬 창은 앱을 띄운 컴퓨터에만 뜹니다 — 이 컴퓨터에서 연 화면에서 눌러 주세요' });
        const job = jobs.get(body.id);
        if (!job) return json(res, 404, { ok: false, error: '없는 작업' });
        const row = job.rows.find((r) => normUrl(r.url) === normUrl(body.url || ''));
        if (!row) return json(res, 404, { ok: false, error: '그 페이지의 결과가 없습니다' });
        await ensureBrowser();
        const device = DEVICES[job.width] || DEVICES[1920];
        try {
          const r = await startManual({
            url: row.url, device, scale: device.scale, channel: pick && pick.channel, headless: process.env.CAP_MANUAL_HEADLESS === '1',
            onFinish: (result) => applyManualResult(job, row, result),   // 창 안의 "완성" 버튼이 여기로 온다
          });
          return json(res, 200, { ok: true, ...r });
        } catch (e) { return json(res, 500, { ok: false, error: `크롬 창을 못 띄웠습니다: ${e.message.split('\n')[0]}` }); }
      }
      try {
        if (action === 'state') return json(res, 200, await stateManual(body.key));
        if (action === 'scroll') return json(res, 200, await scrollManual(body.key, { delta: body.delta, y: body.y, page: body.page }));
        if (action === 'shot') return json(res, 200, await shotManual(body.key));
        if (action === 'undo') return json(res, 200, await undoManual(body.key));
        if (action === 'press') return json(res, 200, await pressManual(body.key, body.name));
        if (action === 'cancel') { await closeManual(body.key); return json(res, 200, { ok: true }); }
        if (action === 'finish') {
          const job = jobs.get(body.id);
          if (!job) return json(res, 404, { ok: false, error: '없는 작업' });
          const row = job.rows.find((r) => normUrl(r.url) === normUrl(body.url || ''));
          if (!row) return json(res, 404, { ok: false, error: '그 페이지의 결과가 없습니다' });
          const r = await finishManual(body.key);
          return json(res, 200, { ok: true, ...applyManualResult(job, row, r) });
        }
        return json(res, 404, { ok: false, error: '없는 동작' });
      } catch (e) { return json(res, 200, { ok: false, error: e.message.split('\n')[0] }); }
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
      if (format === 'board' || format === 'figma') {
        const r = await exportBoard(job, rows, { baseDir, name: outName, kind: format });
        const fname = `${outName}.${format === 'figma' ? 'svg' : 'pdf'}`;
        if (viaBrowser) return json(res, 200, { ok: true, format, pages: r.pages, count: rows.length, download: offerDownload(r.file, fname, format === 'figma' ? 'image/svg+xml' : 'application/pdf') });
        reveal(r.file);
        return json(res, 200, { ok: true, format, path: r.file, pages: r.pages, count: rows.length, size: [r.width, r.height] });
      }
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
  // 바탕화면의 실행 파일에 카메라 아이콘을 (한 번) 입힌다
  // 바탕화면에 터미널 없이 켜지는 "웹사이트 스냅샷.app" 을 만들거나 고쳐 쓴다
  if (process.platform === 'darwin' && !PUBLIC) { syncLauncher(); applyLauncherIconOnce(); ensureMacApp(); }
});

async function shutdown() {
  console.log('\n정리하고 끝냅니다…');
  server.close();
  await closeAllManual().catch(() => {});
  if (host) await host.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
