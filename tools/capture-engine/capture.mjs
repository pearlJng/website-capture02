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

import { stitchShots, repeatedTopBand } from './stitch.mjs';

export const VIEWPORT = { width: 1440, height: 900 };

/**
 * 뽑을 수 있는 화면 크기.
 *
 * 1440 은 데스크탑 레이아웃이 확실히 나오면서 좌우 여백이 과하지 않은 폭이고,
 * 1920 은 큰 모니터에서 보는 모습, 375 는 아이폰 기준 모바일이다.
 *
 * 모바일은 폭만 줄인다고 되지 않는다. `isMobile` 을 켜야 브라우저가
 * <meta viewport> 를 존중하고, `hasTouch` 가 있어야 터치로만 열리는 메뉴가
 * 제대로 동작한다. UA 도 같이 바꿔야 서버가 모바일 페이지를 준다.
 * 배율 1배로 375px 짜리 그림을 주면 쓸 데가 없으므로 기본 2배로 둔다.
 */
export const DEVICES = {
  1440: { width: 1440, height: 900, label: '데스크탑 1440', mobile: false, scale: 1 },
  1920: { width: 1920, height: 1080, label: '데스크탑 1920', mobile: false, scale: 1 },
  375: { width: 375, height: 812, label: '모바일 375', mobile: true, scale: 2 },
};
export const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
export const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';

/** 크기 하나에 맞는 브라우저 컨텍스트 설정. shoot 과 score 가 같은 걸 써야 한다. */
export function contextOptionsFor(device, scale) {
  return {
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: scale,
    userAgent: device.mobile ? MOBILE_UA : DESKTOP_UA,
    isMobile: device.mobile, hasTouch: device.mobile,
    locale: 'ko-KR', timezoneId: 'Asia/Seoul',
  };
}
export const MODES = ['stitch', 'fullpage'];
export const STEPS = ['sticky', 'motion', 'anim', 'slice'];

const SETTLE_MS = 800;
/** 한 번에 내려가는 양. 화면의 절반씩 — 지연 로딩이 따라올 시간을 준다. */
const SCROLL_STEP_RATIO = 0.5;
const MAX_SCROLL_STEPS = 120;
const SCROLL_CFG = {
  ratio: SCROLL_STEP_RATIO,
  maxSteps: MAX_SCROLL_STEPS,
  stepMs: 300,            // 한 칸에서 기본으로 머무는 시간. 관찰자가 발동하고 요청이 나가기엔 충분하다
  stepImageWaits: 8,      // 그 자리(화면 근처) 이미지가 다 뜰 때까지 최대 1.8초 더
  settleMs: 600,
  finalImageWaits: 15,    // 마지막에는 최대 3.3초까지 기다린다
};
const SHOT_TIMEOUT = 120000;
/**
 * 한 칸으로 옮긴 뒤 찍기 전에 기다리는 시간.
 * 등장 전환이 끝나기를 기다리는 게 아니다 — 그건 스크린샷의 animations:'disabled'
 * 가 끝으로 돌려 준다. 관찰자가 발동해 클래스가 붙고, 그 칸 이미지가 그려질
 * 시간만 주면 된다. 700ms 에서 줄였다.
 */
const SHOT_SETTLE_MS = 250;
const SHOT_SETTLE_FIRST_MS = 600;
/** 칸을 찍기 전에 그 칸(과 다음 칸) 이미지가 다 뜨기를 기다리는 최대 횟수 × 간격 */
const SHOT_IMAGE_WAITS = { rounds: 10, ms: 150 };

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
async function inPageFreezeAnimations() {
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

  // 비디오는 멈추는 것만으로 부족하다. currentTime 을 옮기면 그 지점 프레임을
  // 다시 디코딩할 때까지 화면이 비어 있어서, 그대로 찍으면 까맣게 나온다.
  // 테라클 히어로 영상이 그랬다. seeked 를 기다린 뒤에 넘어간다.
  let videos = 0;
  const seeks = [];
  for (const el of document.querySelectorAll('video')) {
    try {
      if (!el.paused) { el.pause(); videos++; }
      if (el.currentTime !== 0 && el.seekable && el.seekable.length) {
        const done = new Promise((r) => {
          const on = () => { el.removeEventListener('seeked', on); r(); };
          el.addEventListener('seeked', on);
          setTimeout(on, 1500);   // 못 기다릴 상황이면 그냥 넘어간다
        });
        el.currentTime = 0;
        seeks.push(done);
      }
    } catch { /* 크로스오리진이면 못 건드린다 */ }
  }
  if (seeks.length) await Promise.all(seeks);
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
  if (keep) keep.setAttribute('data-cap-header', '');   // 두 번째 화면부터는 이것도 숨긴다
  // 고정이 아니어도 맨 위에 가로로 길게 앉은 것은 헤더다. JS 가 스크롤 위치만큼
  // 내려 붙이는 헤더(position: absolute 그대로)는 fixed 검사로는 절대 안 잡힌다.
  // 표만 붙여 둔다 — 첫 화면에는 그대로 두고, 두 번째 화면부터 숨긴다.
  if (!keep) {
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.top > 8 || r.top < -8 || r.width < viewportWidth * 0.6 || r.height < 30 || r.height > 250) continue;
      if (!/^(header|nav)$/i.test(el.tagName) && !/header|gnb|nav/i.test((el.className || '') + ' ' + (el.id || ''))) continue;
      el.setAttribute('data-cap-header', '');
      break;
    }
  }
  for (const item of roots) {
    if (item.el === keep) continue;
    item.el.setAttribute('data-cap-hidden', '');
    item.el.style.setProperty('visibility', 'hidden', 'important');
    const cls = (item.el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    hidden.push(item.el.tagName.toLowerCase() + (cls ? '.' + cls : ''));
  }
  return { hidden, kept: keep ? 1 : 0 };
}

/** 고정·스티키 요소를 전부 숨긴다. 조각마다 따라 붙는 것을 막는다. */
function inPageHideAllFixed() {
  // 숨김 규칙을 문서에 심는다. 인라인 style 은 사이트 JS 가 갈아엎을 수 있지만 속성+규칙은 남는다.
  if (!document.getElementById('cap-hide-rule')) {
    const st = document.createElement('style');
    st.id = 'cap-hide-rule';
    st.textContent = '[data-cap-hidden]{visibility:hidden!important}';
    (document.head || document.documentElement).appendChild(st);
  }
  let n = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el.hasAttribute('data-cap-hidden')) {
      // 이미 숨긴 것도 다시 다진다 — 인라인 style 을 사이트가 지웠을 수 있다
      el.style.setProperty('visibility', 'hidden', 'important');
      continue;
    }
    const cs = getComputedStyle(el);
    // 첫 화면에 남겨 둔 헤더는 CSS 가 뭐라 하든 여기서 숨긴다. 스크롤에 따라
    // 고정으로 바뀌었다 풀렸다 하는 헤더가 화면마다 다시 찍혀 GNB 가 반복됐다.
    if (!el.hasAttribute('data-cap-header') && cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    el.setAttribute('data-cap-hidden', '');
    el.style.setProperty('visibility', 'hidden', 'important');
    n++;
  }
  return n;
}

/**
 * 팝업·모달·딤을 걷어낸다. 수정 요청에 "팝업"이 있을 때 쓴다.
 * 화면의 4할 이상을 덮는 고정 요소, 그리고 이름에 popup·modal·layer·dim 이
 * 들어간 떠 있는 요소를 지운다. 숨기는 게 아니라 지운다 — 스크롤 잠금까지 같이 푼다.
 */
function inPageClosePopups() {
  const vw = window.innerWidth, vh = window.innerHeight;
  let n = 0;
  for (const el of [...document.querySelectorAll('body *')]) {
    if (!el.isConnected) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const floating = cs.position === 'fixed' || cs.position === 'absolute';
    if (!floating) continue;
    const r = el.getBoundingClientRect();
    const covers = r.width * r.height >= vw * vh * 0.4;
    const named = /popup|modal|layer|dim|overlay|dimmed/i.test((el.className || '') + ' ' + (el.id || ''));
    if (covers || (named && r.width >= 200 && r.height >= 120)) { el.remove(); n++; }
  }
  for (const el of [document.documentElement, document.body]) {
    el.style.setProperty('overflow', 'auto', 'important');
    if (getComputedStyle(el).position === 'fixed') el.style.setProperty('position', 'static', 'important');
  }
  return n;
}

/**
 * 결정적인 판별: 스크롤 위치가 달라졌는데도 화면의 같은 자리에 있는 요소는
 * 따라붙는 것이다 — position 이 fixed 든 absolute 든, JS 로 매번 새로 만들든 상관없다.
 * 화면 위쪽 띠(헤더)와 아래쪽 띠(플로팅 바)에 점을 찍어 거기 있는 요소들의 자리를
 * 재고, 직전 조각과 비교한다. GNB 가 조각마다 반복된 마지막 원인이 이것이었다.
 */
function inPageHidePinned(prev) {
  if (!document.getElementById('cap-hide-rule')) {
    const st = document.createElement('style');
    st.id = 'cap-hide-rule';
    st.textContent = '[data-cap-hidden]{visibility:hidden!important}';
    (document.head || document.documentElement).appendChild(st);
  }
  const W = window.innerWidth, H = window.innerHeight;
  const pts = [];
  for (const y of [4, 24, 48, 80, 120, 160, 200, H - 8, H - 40, H - 80]) {
    for (const x of [0.04, 0.12, 0.2, 0.28, 0.36, 0.44, 0.5, 0.56, 0.64, 0.72, 0.8, 0.88, 0.96]) pts.push([Math.round(W * x), y]);
  }
  // 점에 맞은 요소와 그 조상들을 전부 본다. 헤더 포장이 pointer-events:none 이면
  // 점에는 안 맞지만(테라클이 그렇다) 안의 링크는 맞고, 링크의 조상으로 포장이 잡힌다.
  // 포장째 숨겨야 점에 안 맞은 옆 메뉴까지 같이 사라진다.
  const seen = new Map();
  for (const [x, y] of pts) {
    for (const hit of document.elementsFromPoint(x, y)) {
      for (let el = hit; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        if (!seen.has(el)) seen.set(el, el.getBoundingClientRect());
      }
    }
  }
  // 요소 정체가 아니라 "생김새+자리"로 견준다. 스크롤마다 헤더를 새로 만드는
  // 사이트는 요소가 매번 다른 것이라 정체로는 못 잇는다. 태그·자리·크기·글자 앞부분.
  const sig = (el, r) => `${el.tagName}|${Math.round(r.top)}|${Math.round(r.left)}|${Math.round(r.width)}|${Math.round(r.height)}|` +
    ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60));
  const cur = {};
  for (const [el, r] of seen) cur[sig(el, r)] = true;
  let hidden = 0;
  // 흐름 안의 요소는 스크롤한 만큼 움직이므로 몇십 px 만 달라도 가를 수 있다.
  // 마지막 조각은 바닥에 걸려 조금만 내려가는데, 거기서 헤더가 한 번 더 찍혔었다.
  if (prev && Math.abs(window.scrollY - prev.scrollY) >= 24) {
    const pinnedEls = [];
    for (const [el, r] of seen) {
      if (!prev.ids[sig(el, r)]) continue;             // 직전 조각에 같은 생김새가 같은 자리에 없었다
      if (r.height > H * 0.6) continue;                 // 화면 대부분을 덮는 건 배경·포장이다
      if (r.height < 8 || r.width < 8) continue;
      pinnedEls.push(el);
    }
    // 가장 바깥 것만 숨긴다 (안쪽은 따라 숨는다). 이미 숨긴 조상이 있으면 넘어간다.
    for (const el of pinnedEls) {
      if (el.hasAttribute('data-cap-hidden')) continue;
      if (pinnedEls.some((o) => o !== el && o.contains(el))) continue;
      if (el.closest('[data-cap-hidden]')) continue;
      el.setAttribute('data-cap-hidden', '');
      el.style.setProperty('visibility', 'hidden', 'important');
      hidden++;
    }
  }
  return { ids: cur, scrollY: window.scrollY, hidden };
}

function inPageRestoreFixed() {
  for (const el of document.querySelectorAll('[data-cap-hidden]')) {
    el.style.removeProperty('visibility');
    el.removeAttribute('data-cap-hidden');
  }
  const st = document.getElementById('cap-hide-rule');
  if (st) st.remove();
}

/**
 * 맨 위에서 맨 아래까지 훑고, 다시 맨 위로 올라온 뒤에 찍는다.
 *
 * 예전에는 한 칸에 420ms 만 머물렀다. 지연 로딩 이미지가 **뜨기 시작만 하고
 * 다 뜨기 전에** 지나가 버려서, 두 번 찍어도 똑같이 빈 채로 나왔다.
 * 두 장이 같으니 채점기는 "확인됨"으로 셌고, 사람 눈에는 불완전했다.
 *
 * 그래서 세 가지를 바꿨다.
 *   - 더 촘촘하게(화면의 절반씩) 내려간다
 *   - 각 칸에서 **그 자리 이미지가 다 뜰 때까지** 기다린다
 *   - 바닥을 찍은 뒤 **한 칸씩 되올라온다.** 올라올 때 발동하는 것도 있다
 */
async function inPageScrollThrough(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const se = () => document.scrollingElement || document.documentElement;
  const docH = () => Math.max(document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0);

  /**
   * 아직 받아오는 중인 이미지 수 — 화면 근처(위아래 한 화면)만 센다.
   * 지연 로딩 이미지는 화면에 올 때까지 complete 가 false 라서, 문서 전체를
   * 세면 아래쪽 수십 장 때문에 매 칸마다 최대치를 기다린다. 모바일은 한 줄
   * 레이아웃이라 문서가 길어 이게 몇 분씩 먹었다.
   */
  const near = (im) => {
    const r = im.getBoundingClientRect();
    return r.bottom > -window.innerHeight && r.top < window.innerHeight * 2;
  };
  const loading = () => [...document.images].filter((im) => !im.complete && near(im)).length;
  const waitImages = async (rounds) => {
    for (let k = 0; k < rounds && loading() > 0; k++) await sleep(220);
  };

  const move = (delta) => {
    const el = se();
    const before = el.scrollTop;
    el.scrollTop = Math.max(0, before + delta);
    // scrollTop 대입이 안 먹으면(가로채는 라이브러리) 원래 방법으로
    if (el.scrollTop === before) window.scrollBy(0, delta);
    return before;
  };

  // ── 내려가기 ──
  let last = -1;
  for (let i = 0; i < cfg.maxSteps; i++) {
    move(window.innerHeight * cfg.ratio);
    await sleep(cfg.stepMs);
    await waitImages(cfg.stepImageWaits);      // 이 자리에서 뜨기 시작한 것들을 기다린다
    const y = window.scrollY || se().scrollTop;
    if (y === last) break;
    last = y;
  }

  // 스무스 스크롤은 감속 중이라 위치가 늦게 도착한다. 정착을 기다린 뒤에 잰다.
  await sleep(cfg.settleMs);
  const height = docH();
  const bottomY = Math.max(window.scrollY, se().scrollTop);
  const scrollable = height > window.innerHeight + 4;
  const reachedBottom = !scrollable || bottomY + window.innerHeight >= height - 8;
  await waitImages(cfg.finalImageWaits);

  // ── 맨 위로 ── 한 번에 뛴다. 예전엔 칸칸이 되올라왔는데(올라올 때 발동하는
  // 것이 있을까 해서), 이어붙이기가 어차피 위에서부터 다시 내려가며 찍으므로
  // 여기서 천천히 올라올 이유가 없다. 긴 문서에서 10초 남짓을 먹던 자리다.
  window.scrollTo(0, 0);
  se().scrollTop = 0;
  await sleep(cfg.settleMs);
  await waitImages(cfg.finalImageWaits);

  return { deepest: last, scrollable, reachedBottom, height, bottomY: Math.round(bottomY) };
}

/** 지금 화면 위치와 문서 크기. 이어붙일 때 조각의 자리를 정하는 데 쓴다. */
function inPageWhere() {
  const se = document.scrollingElement || document.documentElement;
  return {
    y: Math.round(Math.max(window.scrollY, se.scrollTop)),
    height: Math.max(document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0),
    innerHeight: window.innerHeight,
  };
}

/**
 * 지정한 곳으로 옮기고, 실제로 간 자리를 돌려준다.
 *
 * 스무스 스크롤 라이브러리는 scrollTop 을 매 프레임 자기 값으로 되돌리기도
 * 한다. 그러면 아무리 넣어도 제자리다. 그래서 여러 방법을 차례로 시도하고,
 * 마지막에는 그 자리에 있는 요소를 화면으로 데려오는 방법까지 써 본다.
 */
/**
 * 화면 근처(위아래 한 화면) 이미지가 다 뜰 때까지 기다린다. 이어붙이기가
 * 훑기 없이 한 번에 내려가므로, 지연 로딩 이미지는 이 자리에서 받아 와야 한다.
 * 다음 칸까지 포함해 기다리는 건 경계에서 이미지가 늦게 떠 레이아웃이 밀리는
 * 일을 줄이기 위해서다.
 */
async function inPageWaitNearImages(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const near = (im) => {
    const r = im.getBoundingClientRect();
    return r.bottom > -window.innerHeight && r.top < window.innerHeight * 2;
  };
  const loading = () => [...document.images].filter((im) => !im.complete && near(im)).length;
  let k = 0;
  for (; k < cfg.rounds && loading() > 0; k++) await sleep(cfg.ms);
  return k;
}

function inPageScrollTo(y) {
  const se = document.scrollingElement || document.documentElement;
  const at = () => Math.round(Math.max(
    window.scrollY, se.scrollTop, document.body ? document.body.scrollTop : 0));
  // 갈 수 있는 끝을 넘겨 목표를 잡으면 "못 갔다"고 오해하고 아래 요소 찾기로
  // 넘어가, 멀쩡히 바닥에 닿아 있는데 엉뚱한 데로 튄다. 먼저 갈 수 있는
  // 범위로 자른다.
  const target = Math.min(y, Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0)));
  const off = () => Math.abs(at() - target);

  se.scrollTop = target;
  if (off() > 2) window.scrollTo(0, target);
  if (off() > 2 && document.body) document.body.scrollTop = target;

  if (off() > 2) {
    // 스크롤을 가로채는 페이지에서는 "이 요소를 보여 달라"가 먹기도 한다
    let best = null, bestDiff = Infinity;
    const base = at();
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.height < 20) continue;
      const d = Math.abs(r.top + base - target);
      if (d < bestDiff) { bestDiff = d; best = el; }
    }
    if (best) { try { best.scrollIntoView({ block: 'start' }); } catch { /* 구형 */ } }
  }
  return at();
}

/**
 * 찍기 직전에 "덜 된 것"을 센다.
 *
 * 결정성 검사는 두 번이 같은지만 본다. 두 번 다 똑같이 비어 있으면 통과한다 —
 * 실제로 그 일이 났다. 그래서 화면에 마땅히 있어야 할 것이 없는지를 따로 센다.
 * 이건 픽셀이 아니라 DOM 을 보는 검사라, 캡처를 직접 하는 쪽만 할 수 있다.
 */
function inPageReadiness() {
  const imgs = [...document.images];
  const loading = imgs.filter((im) => !im.complete).length;
  const broken = imgs.filter((im) => im.complete && im.naturalWidth === 0).length;

  // 자리는 차지하는데 투명한 요소 = 등장 애니메이션이 아직 안 끝났거나 되감긴 것
  let invisible = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (Number(cs.opacity) > 0.05) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 24) continue;
    if (el.querySelector('[data-cap-hidden]')) continue;
    invisible++;
  }

  // 자동재생 비디오가 첫 프레임도 못 그린 상태인지
  const videos = [...document.querySelectorAll('video')];
  const blankVideos = videos.filter((v) => v.readyState < 2).length;

  return { images: imgs.length, loading, broken, invisible, videos: videos.length, blankVideos };
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
const VIEWPORT_H = (page) => (page.viewportSize() || VIEWPORT).height;

export async function captureSite(context, url, opts = {}) {
  const steps = new Set(opts.steps || []);
  const mode = opts.mode || 'stitch';
  const scale = opts.scale || 1;
  const timeout = opts.timeout || 45000;
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  // 수정 요청으로 켜는 것들. hideHeader: 첫 화면에서도 헤더를 숨긴다.
  // closePopups: 팝업·모달을 지운다. slow: 기다리는 시간을 배로 늘린다.
  const tweaks = opts.tweaks || {};
  const slow = tweaks.slow ? 2 : 1;
  const started = Date.now();
  const notes = [];
  // 어디서 시간이 갔는지. 안 재면 짐작으로 고치게 된다 — 그래서 한 번 틀렸다.
  const timing = {};
  let tick = started;
  const lap = (k) => { const now = Date.now(); timing[k] = (timing[k] || 0) + (now - tick); tick = now; };
  const page = await context.newPage();
  // 가로 폭은 상수가 아니라 실제 창에서 읽는다 — 1440·1920·375 를 같은 코드로 찍는다.
  const vw = (page.viewportSize() || VIEWPORT).width;

  try {
    progress('여는 중');
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
      return { ok: false, url, error: 'goto: ' + e.message.split('\n')[0], ms: Date.now() - started };
    }
    // networkidle 은 분석 스크립트가 계속 두드리는 사이트에서 제한 시간을 꽉 채운다.
    // 어차피 이미지는 칸마다 따로 기다리므로 여기서 오래 붙잡을 이유가 없다.
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS * slow);
    lap('열기');

    // 찾기는 항상, 걷어내기는 단계를 켰을 때만.
    const motion = await page.evaluate(inPageHandleMotion, steps.has('motion'));
    if (motion.notes.length) notes.push('모션 해제: ' + motion.notes.join(', '));
    else if (motion.found.length) {
      notes.push(steps.has('motion')
        // 흔적은 있는데 걷어낼 인스턴스가 window 에 없다. Lenis 를 모듈 안에 감춰 둔 경우다.
        ? '스무스 스크롤 흔적만 발견(인스턴스 없음): ' + motion.found.join(', ')
        : '스무스 스크롤 감지(미처리): ' + motion.found.join(', '));
    }

    // 한 방 캡처는 찍기 전에 문서를 한 번 훑어야 한다 — 지연 로딩을 다 불러와야
    // 한 장에 담기기 때문이다. 이어붙이기는 내려가면서 칸마다 찍으므로 그 자리에서
    // 불러오면 된다. 같은 문서를 두 번 내려가던 것을 한 번으로 줄였다.
    let scrolled = { reachedBottom: true, height: 0 };
    if (mode !== 'stitch') {
      progress('위에서 아래까지 훑는 중 — 지연 로딩 콘텐츠를 불러옵니다');
      scrolled = await page.evaluate(inPageScrollThrough, SCROLL_CFG);
      progress(`훑기 끝 — 문서 ${scrolled.height.toLocaleString('en-US')}px`);
      if (!scrolled.reachedBottom) notes.push('끝까지 스크롤하지 못했습니다 — 무언가가 스크롤을 가로챕니다');
      await page.waitForTimeout(500);
      lap('훑기');
    }

    if (steps.has('anim')) {
      const n = await page.evaluate(inPageFreezeAnimations);
      if (n.length) notes.push('정지: ' + n.join(', '));
      await page.waitForTimeout(150);
    }

    if (tweaks.closePopups) {
      const n = await page.evaluate(inPageClosePopups);
      notes.push(n ? `수정 요청: 팝업·모달 ${n}개 지움` : '수정 요청: 지울 팝업을 못 찾았습니다');
      await page.waitForTimeout(300);
    }

    if (steps.has('sticky')) {
      const r = await page.evaluate(inPageTameFixed, vw);
      if (r.hidden.length) {
        notes.push('고정 요소 ' + r.hidden.length + '개 숨김(' +
          r.hidden.slice(0, 4).join(', ') + (r.hidden.length > 4 ? '…' : '') + ')' +
          (r.kept ? ' · 헤더 1개 유지' : ''));
      }
      await page.waitForTimeout(200);
    }

    // 폰트가 덜 그려진 채로 찍으면 두 번 찍을 때 달라진다.
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    if (mode !== 'stitch') await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    lap('준비');

    const m = await page.evaluate(inPageMeasure);
    const docHeight = m.docHeight;
    const animations = steps.has('anim') ? 'disabled' : 'allow';

    // 가로는 항상 뷰포트 폭으로 고정한다. 옆으로 흐르는 요소가 있으면 찍는
    // 순간마다 문서 폭이 달라지는데, 방문자가 1440px 창에서 보는 건 1440px 까지다.
    const overflowX = m.docWidth - vw;
    if (overflowX > 2) notes.push(`가로로 ${overflowX}px 삐져나온 부분은 잘랐습니다 (뷰포트 폭 기준)`);

    let slices;
    let shotCount = 0;
    let stalled = null;

    if (mode === 'stitch') {
      // ── 화면 단위로 찍어 이어 붙인다 ──
      //
      // 한 방 캡처는 문서 전체를 한 번에 그리는데, 그때 화면 밖 콘텐츠는
      // "화면 밖" 상태다. 등장 애니메이션 대부분이 나갈 때 클래스를 떼므로
      // 아래쪽이 전부 투명해진 채로 찍힌다 — 픽스처에서 6칸 중 5칸이 그랬다.
      // 그래서 각 칸이 화면에 있는 동안 그 화면을 찍는다.
      const shots = [];
      let y = 0;
      let height = docHeight;
      let lastY = -1;      // 직전에 실제로 도달한 자리
      let hiddenLater = 0; // 두 번째 조각부터 숨긴 고정 요소 수
      let pinned = null;   // 직전 조각에서 화면 위·아래 띠에 있던 요소들의 자리
      // 마지막 안전망. DOM 으로 못 잡은 헤더가 둘째 조각 위쪽에도 찍혀 있으면,
      // 그 띠 높이만큼 겹치게 다시 내려가며 찍고 조각마다 위를 잘라낸다.
      // GoFullPage 가 "고정 헤더" 옵션으로 하는 일이 이것이다. 그림을 보고 판단하므로
      // 헤더가 어떻게 만들어졌든 상관없다.
      let reserve = 0;
      let restarts = 0;
      const bandCheckedAt = new Set();
      for (let i = 0; i < MAX_SCROLL_STEPS && y < height; i++) {
        progress(`찍는 중 ${i + 1}/${Math.ceil(height / VIEWPORT_H(page))}칸`);
        await page.evaluate(inPageScrollTo, y);
        await page.waitForTimeout((i === 0 ? SHOT_SETTLE_FIRST_MS : SHOT_SETTLE_MS) * slow);
        // 이 칸(과 다음 칸)의 지연 로딩 이미지가 뜰 때까지. 없으면 바로 지나간다.
        await page.evaluate(inPageWaitNearImages, { rounds: SHOT_IMAGE_WAITS.rounds * slow, ms: SHOT_IMAGE_WAITS.ms });

        // 두 번째 조각부터는 따라붙는 고정 요소를 전부 숨긴다. 첫 조각에는 남겨야
        // 헤더가 스냅샷에 한 번 들어간다 (수정 요청으로 첫 화면에서도 뺄 수 있다).
        // 매 조각마다 다시 본다 — 스크롤하다 고정으로 바뀌는 것이 있다.
        if (steps.has('sticky') && (i >= 1 || tweaks.hideHeader)) {
          const n = await page.evaluate(inPageHideAllFixed);
          if (n) hiddenLater += n;
        }
        // 스크롤이 달라도 같은 자리에 남는 요소를 잡는다. 첫 조각은 자리만 재 둔다.
        if (steps.has('sticky')) {
          pinned = await page.evaluate(inPageHidePinned, pinned);
          if (pinned.hidden) { hiddenLater += pinned.hidden; await page.waitForTimeout(80); }
        }

        const at = await page.evaluate(inPageWhere);

        // 제자리걸음이면 멈춘다.
        //
        // 이 방어가 없어서 동화목립이 빈 이미지로 나왔다. lenis 가 scrollTop 을
        // 되돌려 위치가 0 에 머물렀는데, 루프는 같은 첫 화면을 120번 찍고
        // 전부 y=0 에 겹쳐 붙였다. 맨 위 한 화면만 있고 나머지는 백지였다.
        // 조용히 나쁜 그림을 내놓느니 "여기까지밖에 못 갔다"고 말해야 한다.
        if (i > 0 && at.y <= lastY) {
          stalled = { at: at.y, of: height };
          notes.push(`스크롤이 ${at.y.toLocaleString('en-US')}px 에서 멈췄습니다 ` +
            `(문서 ${height.toLocaleString('en-US')}px) — 아래쪽은 찍지 못했습니다`);
          break;
        }
        lastY = at.y;

        const buf = await page.screenshot({ animations, timeout: SHOT_TIMEOUT });

        shots.push({ y: at.y, height: at.innerHeight, buf, crop: i === 0 ? 0 : reserve });

        // 조각이 넷 모이면(또는 바닥에 닿았는데 둘 이상이면) 위쪽 띠를 견준다.
        // 셋 이상의 조각이 같은 자리에 같은 픽셀을 갖는 건 우연이 아니다.
        const atBottom = at.y + at.innerHeight >= at.height - 2;
        if (opts.stitchPage && restarts < 2 && (shots.length === 4 || (atBottom && shots.length >= 2)) && !bandCheckedAt.has(shots.length)) {
          bandCheckedAt.add(shots.length);
          const sample = shots.length >= 4 ? shots.slice(1, 4) : shots.slice(0, 2);
          const px = await repeatedTopBand(opts.stitchPage, sample.map((s) => s.buf), Math.round(320 * scale), Math.round(reserve * scale)).catch(() => 0);
          const band = Math.ceil(px / scale);
          if (band >= 16) {
            reserve += band + 4;
            restarts++;
            notes.push(`따라붙는 헤더 ${band}px 가 그림에 남아 있어, 겹치게 찍고 조각마다 위 ${reserve}px 를 잘라냈습니다${restarts > 1 ? ' (검수에서 한 번 더 발견)' : ''}`);
            progress(`따라붙는 헤더 ${band}px 발견 — 겹치게 다시 찍습니다`);
            shots.length = 0; y = 0; lastY = -1; pinned = null; i = -1; bandCheckedAt.clear();
            await page.evaluate(inPageScrollTo, 0);
            continue;
          }
        }

        height = at.height;                              // 지연 로딩으로 늘어날 수 있다
        if (at.y + at.innerHeight >= height - 2) break;  // 바닥에 닿았다
        y = at.y + at.innerHeight - reserve;             // 실제 위치 기준으로 다음 칸 (헤더만큼 겹친다)
      }
      shotCount = shots.length;
      if (hiddenLater) notes.push(`${tweaks.hideHeader ? '첫' : '두 번째'} 조각부터 고정 요소 ${hiddenLater}개 숨김`);
      scrolled = { reachedBottom: !stalled, height };
      lap('찍기');
      progress(`${shotCount}칸 이어 붙이는 중`);

      let finalHeight = (await page.evaluate(inPageWhere)).height;
      if (shots.length) {
        // 찍은 마지막 조각의 아래끝을 넘겨 캔버스를 잡으면 그만큼이 빈 배경이 된다.
        // 문서가 스크롤로 닿을 수 있는 것보다 길다고 나오는 경우가 실제로 있다.
        const last = shots[shots.length - 1];
        finalHeight = Math.min(finalHeight, last.y + last.height);
      }
      if (!opts.stitchPage) throw new Error('이어붙일 페이지가 필요합니다 (stitchPage)');
      slices = await stitchShots(opts.stitchPage, shots, {
        width: vw, height: finalHeight, scale,
        maxHeight: Math.floor(SAFE_PIXELS / scale),
        background: opts.background,
      });
      notes.push(`화면 ${shotCount}칸을 찍어 이어 붙였습니다`);
      lap('붙이기');
    } else {
      // ── 예전 방식: 한 방에 풀페이지 ── 비교용으로 남겨 둔다
      const actualPx = docHeight * scale;
      const wantSlices = steps.has('slice') && actualPx > SAFE_PIXELS;
      const sliceCount = wantSlices ? Math.ceil(actualPx / SAFE_PIXELS) : 1;
      const sliceH = Math.ceil(docHeight / sliceCount);
      slices = [];
      for (let i = 0; i < sliceCount; i++) {
        const y = i * sliceH;
        const h = Math.min(sliceH, docHeight - y);
        if (h <= 0) break;
        slices.push(await page.screenshot({
          fullPage: true, animations, timeout: SHOT_TIMEOUT,
          clip: { x: 0, y, width: vw, height: h },
        }));
      }
      if (sliceCount > 1) notes.push(`${sliceCount}장으로 분할 (실픽셀 ${actualPx.toLocaleString('en-US')}px)`);
      lap('찍기');
    }

    const ready = await page.evaluate(inPageReadiness);

    if (ready.loading) notes.push(`아직 받아오는 중인 이미지 ${ready.loading}개`);
    if (ready.broken) notes.push(`깨진 이미지 ${ready.broken}개`);
    if (ready.blankVideos) notes.push(`첫 프레임도 못 그린 비디오 ${ready.blankVideos}개`);
    // 투명한 요소는 이어붙이기에서는 정상이다 — 화면 밖이라 숨은 것뿐이고
    // 그 칸은 화면에 있었을 때 이미 찍었다. 한 방 캡처에서만 문제가 된다.
    if (mode !== 'stitch' && ready.invisible) notes.push(`자리는 있는데 투명한 요소 ${ready.invisible}개`);

    if (steps.has('sticky')) await page.evaluate(inPageRestoreFixed);

    return {
      ok: true, url, title: m.title, docHeight, scale, slices,
      sliceCount: slices.length, notes, docWidth: m.docWidth, ready, mode, shotCount, stalled,
      motionLibs: motion.found,
      motionHandled: steps.has('motion'), reachedBottom: scrolled.reachedBottom,
      finalUrl: page.url() !== url ? page.url() : undefined,
      ms: Date.now() - started, timing,
    };
  } catch (e) {
    return { ok: false, url, error: e.message.split('\n')[0], notes, ms: Date.now() - started };
  } finally {
    await page.close().catch(() => {});
  }
}
