/**
 * manual.mjs — 사람이 직접 찍는 모드.
 *
 * 앱이 크롬 창을 띄우고(사용자가 보고 만질 수 있는 창), 그 창 안에 떠 있는 버튼으로
 * 사용자가 화면을 하나씩 찍는다. 스크롤 위치를 앱이 아니까 겹침을 추측할 필요 없이 정확히 잇는다.
 * 움직이는 것이 많아 자동 캡처가 안 맞는 페이지용.
 *
 * 헤더는 맨 위에 한 번만: 첫 장은 자동 캡처와 같은 정리(헤더 1개 유지, 플로팅 숨김)를 하고,
 * 둘째 장부터는 고정·스티키·"스크롤해도 같은 자리에 남는 것"을 숨긴 채 찍는다. 그래도 남으면
 * 완성할 때 그림을 보고 둘째 장부터 위쪽 띠를 잘라낸다.
 */
import { chromium } from 'playwright';
import { stitchShots, repeatedTopBand } from './stitch.mjs';
import { SAFE_PIXELS, contextOptionsFor, inPageTameFixed, inPageHideAllFixed, inPageHidePinned } from './capture.mjs';

const sessions = new Map();
let seq = 0;

function inPageWhere() {
  const se = document.scrollingElement || document.documentElement;
  return {
    y: Math.round(se.scrollTop || window.scrollY || 0),
    innerHeight: window.innerHeight,
    height: Math.max(se.scrollHeight, document.body ? document.body.scrollHeight : 0),
    ui: Boolean(document.getElementById('cap-fab')),
    url: location.href,
  };
}

function inPageScrollBy(arg) {
  const se = document.scrollingElement || document.documentElement;
  const max = Math.max(0, se.scrollHeight - se.clientHeight);
  const cur = se.scrollTop || window.scrollY || 0;
  // "한 화면 아래로"는 창 높이보다 120px 덜 내려간다 — 조각끼리 살짝 겹쳐야 이음새에 빈 줄이 안 생긴다
  const target = arg.y != null ? arg.y : arg.page ? cur + Math.max(200, window.innerHeight - 120) * arg.page : cur + (arg.delta || 0);
  window.scrollTo(0, Math.max(0, Math.min(max, target)));
}

/** 찍는 순간 우리 버튼을 숨긴다 / 되돌린다 */
function inPageUiVisible(on) {
  const el = document.getElementById('cap-fab');
  if (el) el.style.visibility = on ? '' : 'hidden';
}

/** 창 안에 떠 있는 버튼. 페이지 스크립트보다 먼저 심어 두고, 사이트가 지워도 다시 만든다. */
function inPageFloatingUi() {
  if (window.top !== window) return;
  const T = {
    shot: '이 화면 찍기', next: '한 화면 아래로', undo: '마지막 취소', done: '완성', quit: '그만두기',
  };
  function make() {
    if (document.getElementById('cap-fab') || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = 'cap-fab';
    host.setAttribute('data-cap-ui', '');
    // 화면 위 가운데. 페이지를 창에 맞춰 줄여 보일 때도 버튼은 원래 크기로 보이게 거꾸로 키운다.
    host.style.cssText = 'all:initial;position:fixed;top:12px;left:50%;z-index:2147483647;transform-origin:50% 0;';
    const setScale = (k) => { host.style.transform = `translateX(-50%) scale(${k || 1})`; };
    setScale(window.__capUiScale || 1);
    window.__capSetScale = setScale;
    if (window.__capAction) window.__capAction('ui').then((r) => { if (r && r.scale) { window.__capUiScale = r.scale; setScale(r.scale); } }).catch(() => {});
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, "Apple SD Gothic Neo", "Pretendard", system-ui, sans-serif; }
  .wrap { background: rgba(20, 18, 26, .95); color: #fff; border-radius: 16px; box-shadow: 0 10px 36px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.08); padding: 8px 8px 8px 14px; backdrop-filter: blur(10px); min-width: 640px; }
  .line { display: flex; align-items: center; gap: 8px; }
  .title { font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 8px; white-space: nowrap; margin-right: 4px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #ff5a5f; box-shadow: 0 0 0 3px rgba(255,90,95,.25); }
  .count { font-size: 12px; color: #c9c4d4; white-space: nowrap; margin-right: 6px; }
  .count b { color: #fff; }
  .main { height: 40px; padding: 0 18px; border: 0; border-radius: 11px; background: #ff5a5f; color: #fff; font-size: 14.5px; font-weight: 700; display: flex; align-items: center; gap: 8px; cursor: pointer; white-space: nowrap; transition: transform .08s, background .15s; }
  .main:hover { background: #ff6f73; } .main:active { transform: scale(.98); }
  .main:disabled { background: #6b6675; cursor: default; }
  .main svg { width: 18px; height: 18px; }
  .line > button:not(.main) { height: 40px; padding: 0 12px; border: 0; border-radius: 11px; background: rgba(255,255,255,.09); color: #fff; font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .line > button:not(.main):hover { background: rgba(255,255,255,.16); }
  .line > button.done { background: #2ec27e; color: #04140b; }
  .line > button.done:hover { background: #45d290; }
  .line > button.done:disabled { background: rgba(46,194,126,.25); color: rgba(255,255,255,.4); cursor: default; }
  .line > button.quit { color: #e9b4b6; background: transparent; }
  .line > button.fold { width: 30px; padding: 0; background: transparent; color: #8d879a; }
  .sub { display: flex; align-items: center; gap: 10px; margin-top: 7px; padding-right: 6px; }
  .status { flex: 1; font-size: 12px; line-height: 1.45; color: #c9c4d4; min-height: 17px; }
  .status .warn { color: #ffcc66; } .status .ok { color: #7fe0b0; }
  .bar { width: 140px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.12); overflow: hidden; position: relative; flex: none; }
  .bar i { position: absolute; top: 0; height: 100%; background: #7fe0b0; }
  .bar i.gap { background: #ffcc66; }
  .hint { font-size: 11px; color: #8d879a; white-space: nowrap; }
  kbd { font: inherit; padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,.12); }
  .wrap.mini .sub, .wrap.mini .opt { display: none; }
  .wrap.mini { min-width: 0; }
  .flash { position: fixed; inset: 0; background: #fff; opacity: 0; pointer-events: none; transition: opacity .25s; }
</style>
<div class="wrap" role="group" aria-label="웹사이트 스냅샷 직접 찍기">
  <div class="line">
    <div class="title"><span class="dot"></span>직접 찍기</div><div class="count"><b class="n">0</b>장</div>
    <button class="main" id="shot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><span>${T.shot}</span></button>
    <button id="next" class="opt">↓ ${T.next}</button><button id="undo" class="opt">↶ ${T.undo}</button>
    <button id="done" class="done" disabled>✓ ${T.done}</button><button id="quit" class="quit opt">${T.quit}</button>
    <button id="fold" class="fold" title="작게 접기 / 펼치기">–</button>
  </div>
  <div class="sub"><div class="status" id="status">맨 위부터 차례로 찍어 주세요. 스크롤해서 원하는 화면을 만든 뒤 찍습니다.</div><div class="bar" id="bar"></div><div class="hint"><kbd>⇧</kbd>+<kbd>S</kbd> 찍기 · <kbd>⇧</kbd>+<kbd>N</kbd> 아래로</div></div>
</div><div class="flash" id="flash"></div>`;
    document.documentElement.appendChild(host);
    const $ = (id) => sh.getElementById(id);
    const fmt = (n) => Number(n).toLocaleString('en-US');
    let busy = false;
    const render = (st) => {
      if (!st || !st.ok) { if (st && st.error) $('status').innerHTML = `<span class="warn">${st.error}</span>`; return; }
      const n = st.shots.length;
      sh.querySelector('.n').textContent = n;
      $('done').disabled = n === 0;
      const parts = [];
      if (st.gaps && st.gaps.length) parts.push(`<span class="warn">빈틈 ${st.gaps.map(([a, b]) => `${fmt(a)}~${fmt(b)}px`).join(', ')} — 조금 올려서 한 장 더 찍어 주세요</span>`);
      if (n && st.tail) parts.push(`${fmt(st.tail[0])}px 아래가 남았어요`);
      if (n && !st.tail && !(st.gaps && st.gaps.length)) parts.push('<span class="ok">끝까지 찍었어요 — 완성을 눌러 주세요</span>');
      if (!n) parts.push('맨 위부터 차례로 찍어 주세요.');
      $('status').innerHTML = parts.join('<br>');
      // 덮은 범위 막대
      const H = Math.max(1, st.at ? st.at.height : 1);
      let bars = '';
      for (const [a, b] of (st.merged || [])) bars += `<i style="left:${(a / H * 100).toFixed(1)}%;width:${((b - a) / H * 100).toFixed(1)}%"></i>`;
      for (const [a, b] of (st.gaps || [])) bars += `<i class="gap" style="left:${(a / H * 100).toFixed(1)}%;width:${((b - a) / H * 100).toFixed(1)}%"></i>`;
      $('bar').innerHTML = bars;
    };
    const act = async (name) => {
      if (busy || !window.__capAction) return;
      busy = true; $('shot').disabled = true;
      try {
        if (name === 'shot') { const f = $('flash'); f.style.opacity = '.8'; setTimeout(() => { f.style.opacity = '0'; }, 120); }
        const st = await window.__capAction(name);
        render(st);
        if (name === 'done' && st && st.ok) { $('status').innerHTML = '<span class="ok">이어 붙였어요. 앱으로 돌아가세요 — 이 창은 곧 닫힙니다.</span>'; }
      } catch (e) { $('status').innerHTML = `<span class="warn">${(e && e.message) || e}</span>`; }
      finally { busy = false; $('shot').disabled = false; }
    };
    $('shot').onclick = () => act('shot');
    $('next').onclick = () => act('next');
    $('undo').onclick = () => act('undo');
    $('done').onclick = () => act('done');
    $('quit').onclick = () => { if (confirm('찍은 것을 버리고 그만둘까요?')) act('quit'); };
    $('fold').onclick = () => { const w = sh.querySelector('.wrap'); w.classList.toggle('mini'); $('fold').textContent = w.classList.contains('mini') ? '+' : '–'; };
    window.addEventListener('keydown', (e) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.code === 'KeyS') { e.preventDefault(); act('shot'); }
      if (e.code === 'KeyN') { e.preventDefault(); act('next'); }
    }, true);
    window.__capRender = render;
    if (window.__capAction) window.__capAction('state').then(render).catch(() => {});
  }
  if (document.documentElement) make();
  document.addEventListener('DOMContentLoaded', make);
  new MutationObserver(() => { if (!document.getElementById('cap-fab')) make(); }).observe(document.documentElement, { childList: true });
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

const get = (key) => {
  const s = sessions.get(key);
  if (!s) throw new Error('찍기 창이 없습니다 (이미 닫혔거나 끝났습니다)');
  if (s.closed) { sessions.delete(key); throw new Error('크롬 창이 닫혔습니다. 직접 찍기를 다시 눌러 주세요'); }
  return s;
};

/**
 * 페이지를 고른 폭(1920 등)으로 그리고 창에 맞춰 줄여 보인다.
 * 창의 실제 안쪽 크기를 재서(덮어쓰기를 잠깐 풀고) 줄일 비율을 정한다. 창 크기가 그대로면 아무것도 안 한다.
 * real 을 주면(화면 없는 시험) 그 크기를 창 크기로 쓴다.
 */
async function fitView(s, real = null) {
  let bounds = null;
  if (!real) {
    try { bounds = (await s.cdp.send('Browser.getWindowForTarget')).bounds; } catch { /* 화면 없는 브라우저 */ }
    const sig = bounds ? `${bounds.width}x${bounds.height}x${bounds.windowState}` : 'none';
    if (s.fitSig === sig) return;
    s.fitSig = sig;
    await s.cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    real = await s.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })).catch(() => null);
    if (!real || !real.w) return;
  }
  // 고른 화면 크기(예: 1920×1080) 그대로 그린다 — 화면 높이로 그리는 히어로(100vh)가 자동 캡처와 같아야 한다.
  // 창에는 가로·세로 비율을 지켜 들어가게 줄인다.
  const W = s.device.width, H = s.device.height;
  const fit = Math.min(1, real.w / W, real.h / H);
  s.fit = fit; s.viewH = H;
  await applyMetrics(s, fit);
  // 스크롤바가 그림에 찍히지 않게 (자동 캡처에도 없다)
  await s.cdp.send('Emulation.setScrollbarsHidden', { hidden: true }).catch(() => {});
  await s.page.evaluate((k) => { window.__capUiScale = k; if (window.__capSetScale) window.__capSetScale(k); }, 1 / fit).catch(() => {});
}
async function applyMetrics(s, scaleView) {
  await s.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: s.device.width, height: s.viewH, deviceScaleFactor: s.scale || 1, mobile: false,
    scale: scaleView, screenWidth: s.device.width, screenHeight: s.viewH,
  });
}

export async function startManual({ url, device, scale, channel, headless = false, onFinish }) {
  const key = 'm' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);
  // 데스크탑(1440·1920)은 노트북 화면보다 넓다. 그 폭의 창을 띄우면 맥이 화면에 맞춰 줄이면서
  // 페이지도 버튼도 아주 작아졌다. 창은 화면을 꽉 채워 열고, 페이지는 고른 폭 그대로 그리되
  // 창에 맞게 줄여 보인다(크롬 개발자 도구의 "화면에 맞추기"와 같은 방식). 찍을 때만 원래 크기로.
  // 모바일(375)은 화면보다 작으니 그 크기의 창 그대로.
  const fitMode = !device.mobile;
  const win = { width: device.width, height: device.height + 120 };
  const browser = await chromium.launch({
    headless, channel: channel || undefined,
    args: ['--disable-dev-shm-usage', fitMode && !headless ? '--start-maximized' : `--window-size=${win.width},${win.height}`],
  });
  const opts = contextOptionsFor(device, scale);
  if (fitMode) { opts.viewport = null; delete opts.deviceScaleFactor; delete opts.isMobile; delete opts.hasTouch; }
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const s = { key, url, device, scale, browser, ctx, page, shots: [], pinned: null, closed: false, onFinish, finishing: false, fitMode, fit: 1 };
  if (fitMode) {
    s.cdp = await ctx.newCDPSession(page);
    await fitView(s, headless ? { w: Math.round(device.width * 0.75), h: Math.round(device.height * 0.75) } : null);
    // 창 크기를 바꾸면 다시 맞춘다
    s.fitTimer = setInterval(() => { if (!s.closed && !s.shooting) fitView(s).catch(() => {}); }, 1500);
  }
  sessions.set(key, s);
  page.on('close', () => { s.closed = true; });
  browser.on('disconnected', () => { s.closed = true; });
  // 창 안의 버튼이 부르는 통로. 페이지가 바뀌어도 살아 있다.
  await page.exposeBinding('__capAction', async (_src, name) => {
    try {
      if (name === 'state') return await stateManual(key);
      if (name === 'ui') return { ok: true, scale: 1 / (s.fit || 1) };
      if (name === 'shot') return await shotManual(key);
      if (name === 'next') return await scrollManual(key, { page: 1 });
      if (name === 'undo') return await undoManual(key);
      if (name === 'quit') { setTimeout(() => closeManual(key).catch(() => {}), 50); return { ok: true, shots: [], gaps: [], merged: [] }; }
      if (name === 'done') {
        if (!s.onFinish) throw new Error('완성 처리가 연결되지 않았습니다');
        if (s.finishing) return { ok: false, error: '이어 붙이는 중입니다' };
        s.finishing = true;
        setTimeout(async () => { try { await s.onFinish(await finishManual(key)); } catch (e) { s.finishing = false; try { await s.page.evaluate((m) => window.__capRender && window.__capRender({ ok: false, error: m }), e.message); } catch { /* 창이 닫혔다 */ } } }, 300);
        return { ok: true, shots: s.shots.map((x) => ({ y: x.y, height: x.height })), gaps: [], merged: [] };
      }
      return { ok: false, error: '없는 동작' };
    } catch (e) { return { ok: false, error: e.message.split('\n')[0] }; }
  });
  await page.addInitScript(inPageFloatingUi);
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch { /* 늦어도 창은 떠 있다 */ }
  return { key, width: device.width, height: device.height };
}

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
  const vw = s.device.width;
  // 첫 장: 자동 캡처와 같은 첫 화면 정리(헤더 1개 유지, 플로팅 숨김, 스티키는 제자리에).
  // 둘째 장부터: 고정·스티키 전부 + 스크롤해도 같은 자리에 남는 것을 숨긴다. 숨긴 채로 둔다 —
  // 헤더는 첫 장에 이미 찍혔으니 창에서도 안 보이는 편이 "이미 찍혔다"를 말해 준다.
  if (!s.shots.length) {
    await s.page.evaluate(inPageTameFixed, vw).catch(() => {});
    s.pinned = await s.page.evaluate(inPageHidePinned, null).catch(() => null);
  } else {
    // 지금 자리에서 재고 → 조금(160px) 움직여 재고 → 제자리로 와서 다시 잰다. 세 번 다 같은
    // 자리에 있는 것이 따라붙는 것이다. 사용자가 어디로 스크롤했든 "처음 나타난" 헤더까지
    // 잡힌다 (직전 장과만 견주면 그 사이에 생긴 헤더는 못 잡는다 — lateheader).
    // 바닥이라 더 못 내려가면 위로 갔다 온다. 어느 쪽이든 끝은 원래 자리다.
    const where = await s.page.evaluate(inPageWhere);
    const P = 160;
    const canDown = where.y + where.innerHeight + P <= where.height;
    await s.page.evaluate(inPageHideAllFixed).catch(() => {});
    const a = await s.page.evaluate(inPageHidePinned, null).catch(() => null);
    await s.page.evaluate(inPageScrollBy, { delta: canDown ? P : -P });
    await s.page.waitForTimeout(160);
    const b = await s.page.evaluate(inPageHidePinned, a).catch(() => a);
    await s.page.evaluate(inPageScrollBy, { y: where.y });
    await s.page.waitForTimeout(160);
    await s.page.evaluate(inPageHideAllFixed).catch(() => {});
    s.pinned = await s.page.evaluate(inPageHidePinned, b).catch(() => b);
  }
  await s.page.waitForTimeout(120);
  const at = await s.page.evaluate(inPageWhere);
  await s.page.evaluate(inPageUiVisible, false);
  let buf;
  try {
    if (s.fitMode) {
      // 창에 맞춰 줄여 보이는 중이다. 원래 크기로 되돌려 찍으면 실제 창(노트북 화면)보다 커서
      // 창에 보이는 만큼만 찍혀 오른쪽이 잘렸다(맥). 크롬에게 지금 화면 자리(고른 폭 × 화면 높이)를
      // 화면 밖까지 원래 크기로 그려 달라고 직접 청한다 — 창 크기와 상관없다.
      s.shooting = true;
      const vp = await s.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY, w: window.innerWidth, h: window.innerHeight }));
      const { data } = await s.cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true, fromSurface: true,
        clip: { x: vp.x, y: vp.y, width: vp.w, height: vp.h, scale: 1 },
      });
      buf = Buffer.from(data, 'base64');
    } else {
      buf = await s.page.screenshot({ timeout: 30000 });
    }
  } finally {
    s.shooting = false;
    await s.page.evaluate(inPageUiVisible, true).catch(() => {});
  }
  s.shots.push({ y: at.y, height: at.innerHeight, buf });
  const cov = coverage(s.shots, at.height);
  return { ok: true, at, hidden: s.pinned ? s.pinned.hidden : 0, shots: s.shots.map((x) => ({ y: x.y, height: x.height })), ...cov };
}

/** 창 안의 버튼을 누른 것과 같다 (자체 시험용 — 창 없이 돌릴 때 버튼 통로를 검사한다). */
export async function pressManual(key, name) {
  const s = get(key);
  return s.page.evaluate((n) => window.__capAction(n), name);
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
  const shots = [...s.shots].sort((a, b) => a.y - b.y).map((x) => ({ ...x, crop: 0 }));
  const height = cov.bottom;
  const notes = [`크롬 창에서 ${shots.length}장 찍어 위치대로 이어 붙였습니다`];
  const stitchPage = await (await s.browser.newContext({ viewport: { width: 200, height: 200 } })).newPage();
  let slices;
  try {
    // 마지막 안전망: 둘째 장부터 위쪽에 똑같은 띠(헤더)가 남아 있으면 그림을 보고 잘라낸다
    if (shots.length >= 3) {
      const px = await repeatedTopBand(stitchPage, shots.slice(1).map((x) => x.buf), Math.round(320 * s.scale), 0).catch(() => 0);
      const band = Math.ceil(px / s.scale);
      // 헤더라 할 만큼 두껍고(40px+), 앞 장이 그 자리를 덮고 있을 때만 잘라낸다 — 아니면 흰 줄이 남는다
      if (band >= 40) {
        let cut = 0;
        for (let k = 1; k < shots.length; k++) {
          const prev = shots[k - 1];
          if (prev.y + prev.height >= shots[k].y + band) { shots[k].crop = band; cut++; }
        }
        if (cut) notes.push(`둘째 장부터 위에 남은 헤더 ${band}px 를 잘라냈습니다`);
      }
    }
    slices = await stitchShots(stitchPage, shots, {
      width: s.device.width, height, scale: s.scale, maxHeight: Math.floor(SAFE_PIXELS / s.scale), background: '#ffffff',
    });
  } finally {
    await closeManual(key);
  }
  if (cov.gaps.length) notes.push(`빈틈 ${cov.gaps.map(([a, b]) => `${a.toLocaleString('en-US')}~${b.toLocaleString('en-US')}px`).join(', ')} 은 안 찍혀 비어 있습니다`);
  if (cov.tail) notes.push(`맨 아래 ${cov.tail[0].toLocaleString('en-US')}px 아래는 안 찍었습니다`);
  return { slices, notes, height };
}

export async function closeManual(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  if (s.fitTimer) clearInterval(s.fitTimer);
  await s.browser.close().catch(() => {});
}

export async function closeAllManual() {
  for (const k of [...sessions.keys()]) await closeManual(k);
}

/** 시험용: 세션 들여다보기 */
export const __debugSession = (key) => sessions.get(key);
