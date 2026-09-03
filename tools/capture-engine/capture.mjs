/**
 * capture.mjs — 웹사이트 한 곳을 풀페이지로 찍는다.
 *
 * 단계마다 켜고 끌 수 있게 만들었다. 무엇을 켰을 때 성적이 얼마나 오르는지
 * 재기 위해서다. 아무것도 안 켠 상태(baseline)가 "지금 설계"이고,
 * 거기서 한 단계씩 켜면서 결정성 통과율이 얼마나 움직이는지 본다.
 *
 * 단계는 실측이 정했다 (78건 스캔 결과):
 *   sticky  — 고정·플로팅 요소 100%.  가림과 반복의 원인
 *   motion  — 스무스 스크롤 27%.      window.scrollTo 가 조용히 실패한다
 *   anim    — 라이브러리 4개가 절반.   루프를 멈춰야 두 번 찍어 같아진다
 *   slice   — 초장문.                 한 장으로 찍으면 오래 걸리거나 실패한다
 */

export const VIEWPORT = { width: 1440, height: 900 };
export const STEPS = ['sticky', 'motion', 'anim', 'slice'];

const SETTLE_MS = 2500;
const SCROLL_STEP_RATIO = 0.8;
const MAX_SCROLL_STEPS = 60;
const SHOT_TIMEOUT = 120000;

/**
 * 한 번에 찍을 실픽셀 높이의 상한.
 * 실측(2026-08-31, 이 저장소 컨테이너): 실픽셀 102,578px 은 32초 걸려 성공,
 * 205,124px 은 "Unable to capture screenshot" 으로 실패했다.
 * 16,384px 텍스처 한계에서 잘린다는 통념은 사실이 아니다 — 크롬이 내부에서
 * 이어붙인다. 진짜 제약은 시간과 메모리다. 그래서 넉넉히 낮게 잡는다.
 */
export const SAFE_PIXELS = 30000;

/* ────────────────────────── 페이지 안에서 도는 코드 ────────────────────────── */
/* page.evaluate 로 직렬화되어 넘어간다. 바깥 변수를 참조하면 안 된다. */

/**
 * 스무스 스크롤 라이브러리를 찾고, 시키면 걷어낸다.
 *
 * 찾기는 항상 한다. 걷어내지 않은 채로 찍으면 "끝까지 스크롤"이 조용히
 * 실패할 수 있는데, 그 실패는 두 번 찍어도 똑같이 실패하므로 결정성 검사로는
 * 절대 안 잡힌다. 그래서 "여기 스크롤 가로채는 놈이 있었다"는 사실 자체를
 * 결과에 남겨야 한다.
 */
function inPageHandleMotion(destroyThem) {
  const found = [];
  const notes = [];
  const seen = new Set();
  for (const key of Object.getOwnPropertyNames(window)) {
    // 숫자 키는 iframe 이다(window[0], window[1]...). 광고·유튜브·지도가 여기 들어온다.
    // 크로스 오리진이면 속성을 읽는 것만으로 SecurityError 가 나므로 아예 건드리지 않는다.
    if (/^\d+$/.test(key)) continue;
    try {
      const v = window[key];
      if (!v || typeof v !== 'object' || seen.has(v)) continue;
      seen.add(v);
      // 아래 typeof 검사도 던질 수 있다. 크로스 오리진 Window 프록시는
      // 이름 있는 속성을 읽는 순간 막힌다. 그래서 통째로 try 안에 둔다.
      const isScroller = typeof v.destroy === 'function' &&
        typeof v.scrollTo === 'function' &&
        (typeof v.raf === 'function' || typeof v.update === 'function');
      if (!isScroller) continue;
      found.push(key);
      if (!destroyThem) continue;
      v.destroy();
      notes.push(key + '.destroy()');
    } catch { /* 못 읽는 객체거나 이미 죽은 인스턴스. 둘 다 넘어간다 */ }
  }
  if (document.querySelector('[data-scroll-container]')) found.push('data-scroll-container');
  if (document.documentElement.classList.contains('lenis') ||
      document.documentElement.classList.contains('has-scroll-smooth')) found.push('lenis/locomotive 클래스');
  if (!destroyThem) return { found, notes };

  const html = document.documentElement;
  html.classList.remove('lenis', 'lenis-smooth', 'lenis-scrolling', 'lenis-stopped', 'has-scroll-smooth');
  for (const el of document.querySelectorAll('[data-scroll-container]')) el.style.transform = '';
  for (const el of [html, document.body]) {
    if (el && getComputedStyle(el).scrollBehavior === 'smooth') el.style.scrollBehavior = 'auto';
  }

  // 스크롤 잠금을 푼다.
  //
  // 모달·팝업이 열려 있으면 사이트가 body 스크롤을 잠근다. 그 상태로 찍으면
  // 첫 화면만 나온다. 삼성생명이 그랬다 — div.modal.dim 이 떠 있어서 문서가
  // 3,404px 인데 한 칸도 못 내려갔다. 고정 요소를 숨기는 건 찍기 직전이라
  // 이미 늦다. 스크롤하기 전에 여기서 풀어야 한다.
  const body = document.body;
  if (getComputedStyle(html).overflow === 'hidden') { html.style.overflow = 'visible'; notes.push('html 스크롤 잠금 해제'); }
  if (body) {
    const bs = getComputedStyle(body);
    if (bs.overflow === 'hidden' || bs.overflowY === 'hidden') {
      body.style.setProperty('overflow', 'visible', 'important');
      notes.push('body 스크롤 잠금 해제');
    }
    // position:fixed + top:-Npx 로 잠그는 방식도 흔하다. 원래 위치로 되돌린다.
    if (bs.position === 'fixed') {
      body.style.setProperty('position', 'static', 'important');
      body.style.removeProperty('top');
      notes.push('body 고정 해제');
    }
  }
  return { found, notes };
}

/** 돌고 있는 것을 멈춘다. 등장 애니메이션은 끝 상태로 보내고, 루프는 처음으로 되감는다. */
function inPageFreezeAnimations() {
  const notes = [];

  let swipers = 0;
  for (const el of document.querySelectorAll('.swiper, .swiper-container, swiper-container')) {
    const sw = el.swiper;
    if (sw && sw.autoplay && sw.autoplay.running) {
      try { sw.autoplay.stop(); swipers++; } catch { /* 버전이 다르면 넘어간다 */ }
    }
  }
  if (swipers) notes.push('Swiper 자동재생 ' + swipers + '개 정지');

  // GSAP 은 무한 반복 트윈만 건드린다. 등장용 트윈까지 되감으면 화면이 비어버린다.
  if (window.gsap && window.gsap.globalTimeline) {
    let loops = 0;
    try {
      for (const t of window.gsap.globalTimeline.getChildren(true, true, true)) {
        if (typeof t.repeat === 'function' && t.repeat() === -1) { t.progress(0).pause(); loops++; }
      }
    } catch { /* GSAP 버전에 따라 API 가 다르다 */ }
    if (loops) notes.push('GSAP 무한 트윈 ' + loops + '개 정지');
  }

  let videos = 0;
  for (const el of document.querySelectorAll('video')) {
    if (el.paused) continue;
    try { el.pause(); el.currentTime = 0; videos++; } catch { /* 크로스오리진이면 못 건드린다 */ }
  }
  if (videos) notes.push('비디오 ' + videos + '개 정지');

  let finished = 0, looped = 0;
  for (const a of document.getAnimations()) {
    try {
      const timing = a.effect && a.effect.getComputedTiming();
      if (timing && timing.iterations === Infinity) { a.currentTime = 0; a.pause(); looped++; }
      else { a.finish(); finished++; }
    } catch { /* 이미 끝났거나 되감을 수 없는 것 */ }
  }
  if (finished) notes.push('유한 애니메이션 ' + finished + '개 완료');
  if (looped) notes.push('무한 애니메이션 ' + looped + '개 되감아 정지');

  return notes;
}

/**
 * 고정·플로팅 요소를 정리한다.
 * 맨 위에 가로로 걸친 것 하나는 헤더로 보고 남긴다 — 스냅샷에 헤더는 있어야 한다.
 * 나머지(챗 위젯, 맨 위로 버튼, 쿠키 배너, 하단 고정바)는 콘텐츠를 가리므로 숨긴다.
 */
function inPageTameFixed(viewportWidth) {
  const found = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    found.push({ el, top: r.top, width: r.width });
  }
  // 부모가 이미 목록에 있으면 자식은 뺀다. 같은 덩어리를 두 번 세지 않는다.
  const roots = found.filter((a) => !found.some((b) => b.el !== a.el && b.el.contains(a.el)));

  const headers = roots
    .filter((x) => x.top <= 8 && x.width >= viewportWidth * 0.6)
    .sort((a, b) => a.top - b.top);
  const keep = headers.length ? headers[0].el : null;

  const hidden = [];
  for (const item of roots) {
    if (item.el === keep) continue;
    item.el.setAttribute('data-cap-hidden', '');
    item.el.style.setProperty('visibility', 'hidden', 'important');
    const cls = (item.el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    hidden.push(item.el.tagName.toLowerCase() + (cls ? '.' + cls : ''));
  }
  return { hidden, kept: keep ? 1 : 0 };
}

function inPageRestoreFixed() {
  for (const el of document.querySelectorAll('[data-cap-hidden]')) {
    el.style.removeProperty('visibility');
    el.removeAttribute('data-cap-hidden');
  }
}

/** 끝까지 훑어 지연 로딩과 스크롤 트리거를 전부 발동시킨 뒤 맨 위로 돌아온다. */
async function inPageScrollThrough(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const se = () => document.scrollingElement || document.documentElement;
  const docH = () => Math.max(document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0);

  let last = -1;
  for (let i = 0; i < cfg.maxSteps; i++) {
    const step = window.innerHeight * cfg.ratio;
    // scrollTop 에 직접 넣는다. scrollBy 는 스무스 스크롤 라이브러리가 가로채는
    // 경우가 있는데, 이 대입은 대개 그대로 먹는다.
    const el = se();
    const before = el.scrollTop;
    el.scrollTop = before + step;
    if (el.scrollTop === before) window.scrollBy(0, step);  // 그래도 안 움직이면 원래 방법으로
    await sleep(420);
    const y = window.scrollY || se().scrollTop;
    if (y === last) break;
    last = y;
  }

  // 스무스 스크롤은 감속 중이라 위치가 늦게 도착한다. 정착을 기다린 뒤에 잰다.
  // 이걸 안 기다려서 멀쩡히 끝까지 간 사이트를 '미완주'로 잘못 찍은 적이 있다.
  await sleep(900);
  const height = docH();
  const y = Math.max(window.scrollY, se().scrollTop);
  const scrollable = height > window.innerHeight + 4;
  const reachedBottom = !scrollable || y + window.innerHeight >= height - 8;

  window.scrollTo(0, 0);
  se().scrollTop = 0;
  await sleep(600);
  return { deepest: last, scrollable, reachedBottom, height, bottomY: Math.round(y) };
}

function inPageMeasure() {
  const d = document.documentElement;
  const b = document.body;
  return {
    docHeight: Math.max(d.scrollHeight, b ? b.scrollHeight : 0),
    docWidth: Math.max(d.scrollWidth, b ? b.scrollWidth : 0),
    title: (document.title || '').slice(0, 120),
  };
}

/* ─────────────────────────────── 파이프라인 ─────────────────────────────── */

/**
 * 한 사이트를 찍는다.
 * @returns {{ok:boolean, slices?:Buffer[], docHeight?:number, notes?:string[], error?:string}}
 */
export async function captureSite(context, url, opts = {}) {
  const steps = new Set(opts.steps || []);
  const scale = opts.scale || 1;
  const timeout = opts.timeout || 45000;
  const started = Date.now();
  const notes = [];
  const page = await context.newPage();

  try {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
      return { ok: false, url, error: 'goto: ' + e.message.split('\n')[0], ms: Date.now() - started };
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);

    // 찾기는 항상, 걷어내기는 단계를 켰을 때만.
    const motion = await page.evaluate(inPageHandleMotion, steps.has('motion'));
    if (motion.notes.length) notes.push('모션 해제: ' + motion.notes.join(', '));
    else if (motion.found.length) {
      notes.push(steps.has('motion')
        // 흔적은 있는데 걷어낼 인스턴스가 window 에 없다. Lenis 를 모듈 안에 감춰 둔 경우다.
        ? '스무스 스크롤 흔적만 발견(인스턴스 없음): ' + motion.found.join(', ')
        : '스무스 스크롤 감지(미처리): ' + motion.found.join(', '));
    }

    const scrolled = await page.evaluate(inPageScrollThrough, { ratio: SCROLL_STEP_RATIO, maxSteps: MAX_SCROLL_STEPS });
    if (!scrolled.reachedBottom) notes.push('끝까지 스크롤하지 못했습니다 — 무언가가 스크롤을 가로챕니다');
    await page.waitForTimeout(1200);

    if (steps.has('anim')) {
      const n = await page.evaluate(inPageFreezeAnimations);
      if (n.length) notes.push('정지: ' + n.join(', '));
      await page.waitForTimeout(300);
    }

    if (steps.has('sticky')) {
      const r = await page.evaluate(inPageTameFixed, VIEWPORT.width);
      if (r.hidden.length) {
        notes.push('고정 요소 ' + r.hidden.length + '개 숨김(' +
          r.hidden.slice(0, 4).join(', ') + (r.hidden.length > 4 ? '…' : '') + ')' +
          (r.kept ? ' · 헤더 1개 유지' : ''));
      }
      await page.waitForTimeout(200);
    }

    // 폰트가 덜 그려진 채로 찍으면 두 번 찍을 때 달라진다.
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});

    const m = await page.evaluate(inPageMeasure);
    const docHeight = m.docHeight;

    // 가로는 항상 뷰포트 폭으로 고정한다.
    //
    // 풀페이지 캡처의 기본 폭은 문서의 scrollWidth 인데, 가로로 삐져나온
    // 요소가 있으면 그 양만큼 폭이 늘어난다. 마퀴처럼 옆으로 흐르는 것이
    // 있으면 찍는 순간마다 폭이 달라진다 — 법무법인 유강이 1,642px 대
    // 1,654px 로 나온 이유다.
    //
    // 애초에 방문자가 1440px 창에서 보는 것은 1440px 까지다. 그 바깥은
    // 화면에 없다. 잘라내는 게 맞고, 덤으로 폭이 고정된다.
    const overflowX = m.docWidth - VIEWPORT.width;
    if (overflowX > 2) notes.push(`가로로 ${overflowX}px 삐져나온 부분은 잘랐습니다 (뷰포트 폭 기준)`);
    const animations = steps.has('anim') ? 'disabled' : 'allow';
    const actualPx = docHeight * scale;
    const wantSlices = steps.has('slice') && actualPx > SAFE_PIXELS;
    const sliceCount = wantSlices ? Math.ceil(actualPx / SAFE_PIXELS) : 1;
    const sliceH = Math.ceil(docHeight / sliceCount);

    const slices = [];
    for (let i = 0; i < sliceCount; i++) {
      const y = i * sliceH;
      const h = Math.min(sliceH, docHeight - y);
      if (h <= 0) break;
      slices.push(await page.screenshot({
        fullPage: true, animations, timeout: SHOT_TIMEOUT,
        clip: { x: 0, y, width: VIEWPORT.width, height: h },
      }));
    }
    if (sliceCount > 1) notes.push(sliceCount + '장으로 분할 (실픽셀 ' + actualPx.toLocaleString('en-US') + 'px)');

    if (steps.has('sticky')) await page.evaluate(inPageRestoreFixed);

    return {
      ok: true, url, title: m.title, docHeight, scale, slices,
      sliceCount: slices.length, notes, docWidth: m.docWidth, motionLibs: motion.found,
      motionHandled: steps.has('motion'), reachedBottom: scrolled.reachedBottom,
      finalUrl: page.url() !== url ? page.url() : undefined,
      ms: Date.now() - started,
    };
  } catch (e) {
    return { ok: false, url, error: e.message.split('\n')[0], notes, ms: Date.now() - started };
  } finally {
    await page.close().catch(() => {});
  }
}
