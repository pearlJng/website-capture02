/**
 * manual.mjs — 사람이 직접 찍는 모드.
 *
 * 앱이 크롬 창을 띄우고(사용자가 보고 만질 수 있는 창), 사용자가 스크롤해 원하는 화면을
 * 만든 뒤 "이 화면 찍기"를 누르면 앱이 그 창을 찍는다. 스크롤 위치를 앱이 아니까
 * 겹침을 추측할 필요 없이 정확히 잇는다. 움직이는 것이 많아 자동 캡처가 안 맞는 페이지용.
 */
import { chromium } from 'playwright';
import { stitchShots } from './stitch.mjs';
import { SAFE_PIXELS, contextOptionsFor } from './capture.mjs';

const sessions = new Map();
let seq = 0;

function inPageWhere() {
  const se = document.scrollingElement || document.documentElement;
  return {
    y: Math.round(se.scrollTop || window.scrollY || 0),
    innerHeight: window.innerHeight,
    height: Math.max(se.scrollHeight, document.body ? document.body.scrollHeight : 0),
  };
}

/** 둘째 조각부터 따라붙는 것(fixed·sticky)을 잠깐 숨기고 찍는다. 찍고 나면 되돌린다. */
function inPageHideFixed(hide) {
  if (!hide) {
    for (const el of document.querySelectorAll('[data-cap-mhide]')) {
      el.style.removeProperty('visibility');
      const was = el.getAttribute('data-cap-mhide');
      if (was) el.style.visibility = was;
      el.removeAttribute('data-cap-mhide');
    }
    return 0;
  }
  let n = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    el.setAttribute('data-cap-mhide', el.style.visibility || '');
    el.style.setProperty('visibility', 'hidden', 'important');
    n++;
  }
  return n;
}

function inPageScrollBy(arg) {
  const se = document.scrollingElement || document.documentElement;
  const max = Math.max(0, se.scrollHeight - se.clientHeight);
  const cur = se.scrollTop || window.scrollY || 0;
  const target = arg.y != null ? arg.y : arg.page ? cur + window.innerHeight * arg.page : cur + (arg.delta || 0);
  window.scrollTo(0, Math.max(0, Math.min(max, target)));
}

/** 찍은 조각들이 문서를 어디까지 덮는지, 빈틈은 어디인지. */
function coverage(shots, docHeight) {
  const segs = shots.map((s) => [s.y, s.y + s.height]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  const gaps = [];
  let cursor = 0;
  for (const m of merged) {
    if (m[0] > cursor + 1) gaps.push([cursor, m[0]]);
    cursor = Math.max(cursor, m[1]);
  }
  const bottom = merged.length ? merged[merged.length - 1][1] : 0;
  const tail = docHeight && bottom < docHeight - 2 ? [bottom, docHeight] : null;
  return { merged, gaps, bottom, tail };
}

export async function startManual({ url, device, scale, channel, headless = false }) {
  const key = 'm' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);
  const win = { width: device.width, height: device.height + 120 };
  const browser = await chromium.launch({
    headless, channel: channel || undefined,
    args: ['--disable-dev-shm-usage', `--window-size=${win.width},${win.height}`],
  });
  const ctx = await browser.newContext(contextOptionsFor(device, scale));
  const page = await ctx.newPage();
  const s = { key, url, device, scale, browser, ctx, page, shots: [], closed: false };
  sessions.set(key, s);
  page.on('close', () => { s.closed = true; });
  browser.on('disconnected', () => { s.closed = true; });
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch { /* 늦어도 창은 떠 있다 */ }
  return { key, width: device.width, height: device.height };
}

const get = (key) => {
  const s = sessions.get(key);
  if (!s) throw new Error('찍기 창이 없습니다 (이미 닫혔거나 끝났습니다)');
  if (s.closed) { sessions.delete(key); throw new Error('크롬 창이 닫혔습니다. 직접 찍기를 다시 눌러 주세요'); }
  return s;
};

export async function stateManual(key) {
  const s = get(key);
  const at = await s.page.evaluate(inPageWhere);
  const cov = coverage(s.shots, at.height);
  return { ok: true, at, shots: s.shots.map((x) => ({ y: x.y, height: x.height })), ...cov };
}

export async function scrollManual(key, arg) {
  const s = get(key);
  await s.page.evaluate(inPageScrollBy, arg);
  await s.page.waitForTimeout(250);
  return stateManual(key);
}

export async function shotManual(key) {
  const s = get(key);
  const at = await s.page.evaluate(inPageWhere);
  let hidden = 0;
  if (s.shots.length) hidden = await s.page.evaluate(inPageHideFixed, true);
  let buf;
  try { buf = await s.page.screenshot({ timeout: 30000 }); } finally { if (hidden) await s.page.evaluate(inPageHideFixed, false).catch(() => {}); }
  s.shots.push({ y: at.y, height: at.innerHeight, buf });
  const cov = coverage(s.shots, at.height);
  return { ok: true, at, hidden, shots: s.shots.map((x) => ({ y: x.y, height: x.height })), ...cov };
}

export async function undoManual(key) {
  const s = get(key);
  s.shots.pop();
  return stateManual(key);
}

/** 찍은 조각을 위치대로 이어 붙여 PNG 들(길면 여러 장)을 돌려주고 창을 닫는다. */
export async function finishManual(key) {
  const s = get(key);
  if (!s.shots.length) throw new Error('찍은 화면이 없습니다');
  const at = await s.page.evaluate(inPageWhere).catch(() => ({ height: 0 }));
  const cov = coverage(s.shots, at.height);
  const shots = [...s.shots].sort((a, b) => a.y - b.y);
  const height = cov.bottom;
  const stitchPage = await (await s.browser.newContext({ viewport: { width: 200, height: 200 } })).newPage();
  let slices;
  try {
    slices = await stitchShots(stitchPage, shots, {
      width: s.device.width, height, scale: s.scale, maxHeight: Math.floor(SAFE_PIXELS / s.scale), background: '#ffffff',
    });
  } finally {
    await closeManual(key);
  }
  const notes = [`크롬 창에서 ${shots.length}장 찍어 위치대로 이어 붙였습니다`];
  if (cov.gaps.length) notes.push(`빈틈 ${cov.gaps.map(([a, b]) => `${a.toLocaleString('en-US')}~${b.toLocaleString('en-US')}px`).join(', ')} 은 안 찍혀 비어 있습니다`);
  if (cov.tail) notes.push(`맨 아래 ${cov.tail[0].toLocaleString('en-US')}px 아래는 안 찍었습니다`);
  return { slices, notes, height };
}

export async function closeManual(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  await s.browser.close().catch(() => {});
}

export async function closeAllManual() {
  for (const k of [...sessions.keys()]) await closeManual(k);
}
