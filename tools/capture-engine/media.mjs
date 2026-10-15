/**
 * media.mjs — 늦게 뜨는 큰 배경 영상을 앱이 대신 받아 두고, 브라우저에는 이 컴퓨터에서 건넨다.
 *
 * 글로쿼드텍 홈의 히어로 배경 영상은 50MB 넘는 MP4 다. 늘 쓰는 크롬은 받아 둔 게 있어 바로 뜨지만,
 * 캡처용 브라우저는 매번 빈 상태라 처음부터 받아야 하고 — 한 줄로 받으면 회사 망에선 수십 초 —
 * 그동안 영상 자리가 덮개 색만 찍혔다.
 *
 * 그래서 재생이 늦는 배경 영상은 앱(Node)이 여러 줄로 나눠(Range) 한꺼번에 받아 이 컴퓨터에 두고
 * (~/.website-snapshot/media-cache), 브라우저가 그 주소를 달라고 하면 받아 둔 파일에서 잘라 준다.
 * 한 번 받으면 다음 페이지·다음 캡처·직접 찍기 창 어디서든 바로 뜬다.
 */
import { createHash } from 'node:crypto';
import { open, mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dir = () => process.env.CAP_MEDIA_DIR || join(homedir(), '.website-snapshot', 'media-cache');
const MAX_BYTES = 1.5 * 1024 ** 3;   // 이보다 큰 영상은 받지 않는다
const PARTS = 6;                     // 동시에 받는 줄 수
const SLICE = 8 * 1024 * 1024;       // 브라우저에 한 번에 건네는 크기 — 나머지는 브라우저가 이어서 달라고 한다

const jobs = new Map();
const base = (url) => join(dir(), createHash('sha1').update(url).digest('hex').slice(0, 24));

/** 받아 둔 영상이 있으면 { file, total, type } */
export function cachedMedia(url) {
  const b = base(url);
  try {
    const meta = JSON.parse(readFileSync(b + '.json', 'utf8'));
    return existsSync(b + '.bin') ? { file: b + '.bin', ...meta } : null;
  } catch { return null; }
}

/** 받기 시작한다(이미 받는 중이면 그 일을 돌려준다). { state: 'loading'|'done'|'error', got, total, error } */
export function fetchMedia(url, { referer, ua } = {}) {
  const c = cachedMedia(url);
  if (c) return { state: 'done', got: c.total, total: c.total };
  let j = jobs.get(url);
  if (j && j.state !== 'error') return j;
  j = { state: 'loading', got: 0, total: 0, error: '', started: Date.now() };
  jobs.set(url, j);
  j.promise = download(url, j, { referer, ua }).then(
    () => { j.state = 'done'; },
    (e) => { j.state = 'error'; j.error = String(e && e.message || e).split('\n')[0]; },
  );
  return j;
}

/** 받는 일의 지금 상태 (없으면 null) */
export function mediaJob(url) {
  const c = cachedMedia(url);
  if (c) return { state: 'done', got: c.total, total: c.total };
  return jobs.get(url) || null;
}

async function download(url, j, { referer, ua }) {
  if (!/^https?:\/\//i.test(url)) throw new Error('받을 수 없는 주소');
  await mkdir(dir(), { recursive: true });
  const headers = { ...(ua ? { 'user-agent': ua } : {}), ...(referer ? { referer } : {}), accept: '*/*' };
  // 나눠 받을 수 있는지(206) 1바이트만 달라고 해 본다
  const probe = await fetch(url, { headers: { ...headers, range: 'bytes=0-0' }, signal: AbortSignal.timeout(20000) });
  const type = (probe.headers.get('content-type') || 'video/mp4').split(';')[0].trim();
  const cr = probe.headers.get('content-range') || '';
  const total = probe.status === 206 ? Number(cr.split('/')[1]) : Number(probe.headers.get('content-length') || 0);
  await probe.body?.cancel().catch(() => {});
  if (probe.status >= 400) throw new Error(`서버가 영상을 주지 않았어요 (${probe.status})`);
  if (/^text\//i.test(type)) throw new Error(`영상이 아니에요 (${type})`);
  if (total > MAX_BYTES) throw new Error(`영상이 너무 커요 (${Math.round(total / 1024 / 1024)}MB)`);
  j.total = total;
  const tmp = base(url) + '.part';
  const fh = await open(tmp, 'w');
  try {
    if (probe.status === 206 && total > 0) {
      const size = Math.ceil(total / PARTS);
      await Promise.all(Array.from({ length: PARTS }, async (_, i) => {
        const end = Math.min(total, (i + 1) * size) - 1;
        let pos = i * size;
        for (let tries = 0; pos <= end; tries++) {
          try {
            const r = await fetch(url, { headers: { ...headers, range: `bytes=${pos}-${end}` }, signal: AbortSignal.timeout(300000) });
            if (r.status !== 206) throw new Error(`나눠 받기를 거절했어요 (${r.status})`);
            for await (const chunk of r.body) {
              const n = Math.min(chunk.length, end - pos + 1);
              await fh.write(chunk, 0, n, pos);
              pos += n; j.got += n;
              if (pos > end) break;
            }
          } catch (e) { if (tries >= 3) throw e; }
        }
      }));
    } else {
      // 나눠 받기를 못 하는 서버 — 한 줄로 끝까지
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(600000) });
      if (!r.ok) throw new Error(`서버가 영상을 주지 않았어요 (${r.status})`);
      let pos = 0;
      for await (const chunk of r.body) {
        await fh.write(chunk, 0, chunk.length, pos);
        pos += chunk.length; j.got = pos;
        if (pos > MAX_BYTES) throw new Error('영상이 너무 커요');
      }
      j.total = pos;
    }
  } catch (e) {
    await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  }
  await fh.close();
  await writeFile(base(url) + '.json', JSON.stringify({ url, total: j.total, type }));
  await rename(tmp, base(url) + '.bin');
}

/**
 * 이 페이지가 그 영상 주소를 달라고 하면 받아 둔 파일에서 잘라 준다(206).
 * 브라우저는 영상을 나눠 달라고(Range) 하므로 그대로 답하면 장면 넘기기(seek)도 된다.
 */
export async function serveCachedMedia(page, url) {
  const c = cachedMedia(url);
  if (!c) return false;
  page.__capMedia = page.__capMedia || new Set();
  if (page.__capMedia.has(url)) return true;
  page.__capMedia.add(url);
  await page.route((u) => u.href === url, async (route) => {
    let fh;
    try {
      const m = /bytes=(\d*)-(\d*)/.exec(route.request().headers().range || '');
      let a = 0, b = c.total - 1;
      if (m && m[1]) { a = Number(m[1]); if (m[2]) b = Number(m[2]); }
      else if (m && m[2]) a = Math.max(0, c.total - Number(m[2]));
      if (a >= c.total) { await route.fulfill({ status: 416, headers: { 'content-range': `bytes */${c.total}` } }); return; }
      b = Math.min(b, a + SLICE - 1, c.total - 1);
      const len = b - a + 1;
      const buf = Buffer.alloc(len);
      fh = await open(c.file, 'r');
      await fh.read(buf, 0, len, a);
      await route.fulfill({
        status: 206, body: buf,
        headers: { 'content-type': c.type, 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${c.total}`, 'content-length': String(len), 'access-control-allow-origin': '*' },
      });
    } catch { await route.continue().catch(() => {}); }
    finally { if (fh) await fh.close().catch(() => {}); }
  });
  return true;
}

/** 그 주소의 영상을 처음부터 다시 불러 재생시킨다 (이제 받아 둔 파일에서 온다) */
export function inPageReloadVideo(url) {
  let n = 0;
  for (const v of document.querySelectorAll('video')) {
    if (v.currentSrc !== url && v.src !== url) continue;
    try { v.muted = true; v.src = url; v.load(); const p = v.play(); if (p && p.catch) p.catch(() => {}); n++; } catch { /* 무시 */ }
  }
  return n;
}

export const mb = (n) => `${Math.round((n || 0) / 1024 / 1024)}MB`;
