/**
 * probe.mjs — 웹사이트 한 곳을 열어 "캡처 난이도"를 실측한다.
 *
 * 추측하지 않는다. 페이지 안에서 실제로 관측 가능한 신호만 센다:
 *   - IntersectionObserver 생성 횟수 (스크롤 등장 애니메이션의 표준 구현)
 *   - requestAnimationFrame 호출 빈도 (실시간 렌더링 여부)
 *   - canvas.getContext('webgl') 호출 (3D/셰이더)
 *   - document.getAnimations() 중 iterations === Infinity 개수 (무한 루프)
 *   - 지연 로딩 이미지, position:fixed/sticky 요소, 가로 스크롤 컨테이너
 *   - 스크롤 전/후 등장 요소의 해소 여부, 깨진 이미지
 *
 * 계측 코드는 페이지 스크립트보다 먼저 심어야 하므로 addInitScript를 쓴다.
 */

const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 2500;
const RAF_SAMPLE_MS = 1000;
const SCROLL_STEP_RATIO = 0.8;
const MAX_SCROLL_STEPS = 40;
const CHROME_MAX_TEXTURE = 16384;

/** 페이지 스크립트보다 먼저 실행되어 계측 후크를 심는다. */
const INIT_SCRIPT = `(() => {
  const p = { io: 0, raf: 0, webgl: 0, canvas2d: 0, mutations: 0 };
  Object.defineProperty(window, '__probe', { value: p, writable: false, configurable: false });

  const IO = window.IntersectionObserver;
  if (IO) {
    window.IntersectionObserver = function (...args) { p.io++; return new IO(...args); };
    window.IntersectionObserver.prototype = IO.prototype;
  }

  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) { p.raf++; return raf.call(window, cb); };

  const getCtx = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (typeof type === 'string') {
      if (/webgl|webgpu/i.test(type)) p.webgl++;
      else if (type === '2d') p.canvas2d++;
    }
    return getCtx.call(this, type, ...rest);
  };
})();`;

/** 브라우저 안에서 실행되는 측정 함수. 직렬화되어 넘어가므로 외부 참조 금지. */
function collect(phase) {
  const p = window.__probe || { io: 0, raf: 0, webgl: 0, canvas2d: 0 };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const all = Array.from(document.querySelectorAll('*')).slice(0, 6000);

  let fixed = 0;
  let sticky = 0;
  let stickyPinned = 0; // 뷰포트 2배 이상 높은 컨테이너 안의 sticky = 스크롤 연동 핀
  let hiddenReveal = 0; // 아직 안 나타난 등장 대기 요소
  let horizontalScroll = 0;
  let biggestCanvasRatio = 0;

  for (const el of all) {
    let cs;
    try { cs = getComputedStyle(el); } catch { continue; }
    const pos = cs.position;

    if (pos === 'fixed') fixed++;
    if (pos === 'sticky') {
      sticky++;
      const parent = el.parentElement;
      if (parent && parent.getBoundingClientRect().height > vh * 2) stickyPinned++;
    }

    // 등장 대기: 투명하거나 이동/축소된 채 문서 흐름에 존재하는 요소
    const opacity = parseFloat(cs.opacity);
    const shifted = cs.transform && cs.transform !== 'none' && cs.transform !== 'matrix(1, 0, 0, 1, 0, 0)';
    if ((opacity === 0 || shifted) && cs.display !== 'none' && cs.visibility !== 'hidden') {
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 20) hiddenReveal++;
    }

    // 가로 스크롤 섹션. overflow:hidden 은 사용자가 스크롤할 수 없으므로 제외한다.
    // (body 의 overflow-x:hidden 은 가로 스크롤바를 없애려는 관용구일 뿐이다.)
    if (
      el !== document.body &&
      el !== document.documentElement &&
      /auto|scroll/.test(cs.overflowX) &&
      el.scrollWidth > el.clientWidth + vw * 0.5
    ) {
      horizontalScroll++;
    }

    if (el.tagName === 'CANVAS') {
      const r = el.getBoundingClientRect();
      const ratio = (r.width * r.height) / (vw * vh);
      if (ratio > biggestCanvasRatio) biggestCanvasRatio = ratio;
    }
  }

  // 진행 중인 애니메이션 — 유한/무한을 나눈다. 무한은 "완료 시점"이 없다.
  let animTotal = 0;
  let animInfinite = 0;
  try {
    for (const a of document.getAnimations()) {
      animTotal++;
      const it = a.effect && a.effect.getTiming ? a.effect.getTiming().iterations : undefined;
      if (it === Infinity) animInfinite++;
    }
  } catch { /* 미지원 브라우저 */ }

  // 스타일시트 정적 분석 — 동일 출처만 읽을 수 있다(cross-origin은 throw).
  let hoverRules = 0;
  let infiniteKeyframeRules = 0;
  let readableSheets = 0;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    readableSheets++;
    for (const rule of Array.from(rules)) {
      const sel = rule.selectorText;
      const text = rule.cssText || '';
      if (sel && sel.includes(':hover') && /display|opacity|visibility|transform|max-height/.test(text)) hoverRules++;
      if (/animation-iteration-count:\s*infinite|animation:[^;]*\binfinite\b/.test(text)) infiniteKeyframeRules++;
    }
  }

  const lazyImages = document.querySelectorAll(
    'img[loading="lazy"], img[data-src], img[data-lazy-src], [data-bg], [data-background], .lazy, .lazyload'
  ).length;

  const videos = Array.from(document.querySelectorAll('video'));
  const loopVideos = videos.filter((v) => v.loop || v.autoplay).length;

  const brokenImages = Array.from(document.querySelectorAll('img')).filter(
    (img) => img.currentSrc && img.complete && img.naturalWidth === 0
  ).length;

  const scriptSrc = Array.from(document.querySelectorAll('script[src]')).map((s) => s.src).join(' ');
  const globals = {
    gsap: !!(window.gsap || window.TweenMax),
    scrollTrigger: !!(window.ScrollTrigger || (window.gsap && window.gsap.plugins && window.gsap.plugins.scrollTrigger)),
    locomotive: !!window.LocomotiveScroll,
    lenis: !!(window.Lenis || window.lenis),
    aos: !!window.AOS,
    swiper: !!window.Swiper,
    three: !!window.THREE,
    spline: /spline/i.test(scriptSrc),
    barba: !!window.barba,
    framerMotion: /framer-motion|motion\\.dev/i.test(scriptSrc),
    scrollMagic: !!window.ScrollMagic,
    scrollReveal: !!window.ScrollReveal,
    matterjs: !!window.Matter,
    pixi: !!window.PIXI,
  };
  const libs = Object.entries(globals).filter(([, v]) => v).map(([k]) => k);
  if (/gsap|TweenMax/i.test(scriptSrc) && !libs.includes('gsap')) libs.push('gsap');
  if (/ScrollTrigger/i.test(scriptSrc) && !libs.includes('scrollTrigger')) libs.push('scrollTrigger');
  if (/locomotive/i.test(scriptSrc) && !libs.includes('locomotive')) libs.push('locomotive');
  if (/lenis/i.test(scriptSrc) && !libs.includes('lenis')) libs.push('lenis');
  if (/aos\.js|aos\.min/i.test(scriptSrc) && !libs.includes('aos')) libs.push('aos');
  if (/three(\.min)?\.js|three\.module/i.test(scriptSrc) && !libs.includes('three')) libs.push('three');

  // 스크롤 탈취: 세로 축이 잠긴 채 내부 컨테이너가 대신 스크롤되는 구조.
  // overflow-x:hidden 만으로는 판정하지 않는다 — 거의 모든 사이트가 쓰는 관용구다.
  const bodyOverflowY = getComputedStyle(document.body).overflowY;
  const htmlOverflowY = getComputedStyle(document.documentElement).overflowY;
  const verticalLocked = /hidden|clip/.test(bodyOverflowY) || /hidden|clip/.test(htmlOverflowY);
  const documentScrolls = document.documentElement.scrollHeight > vh * 1.2;
  const innerScroller = all.some((el) => {
    if (el === document.body || el === document.documentElement) return false;
    let cs;
    try { cs = getComputedStyle(el); } catch { return false; }
    return /auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight * 1.5 && el.clientHeight > vh * 0.6;
  });
  const scrollHijack = verticalLocked && !documentScrolls && innerScroller;

  return {
    phase,
    raf: p.raf,
    io: p.io,
    webgl: p.webgl,
    canvas2d: p.canvas2d,
    docHeight: Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight
    ),
    viewportHeight: vh,
    viewportWidth: vw,
    fixed,
    sticky,
    stickyPinned,
    hiddenReveal,
    horizontalScroll,
    biggestCanvasRatio: Math.round(biggestCanvasRatio * 100) / 100,
    animTotal,
    animInfinite,
    hoverRules,
    infiniteKeyframeRules,
    readableSheets,
    totalSheets: document.styleSheets.length,
    lazyImages,
    videos: videos.length,
    loopVideos,
    brokenImages,
    imgCount: document.querySelectorAll('img').length,
    scrollHijack,
    libs,
    title: document.title,
    bodyText: (document.body.innerText || '').slice(0, 400),
  };
}

/** 봇 차단·챌린지 화면인지 판정한다. 이건 "로딩 실패"와 반드시 구분해야 한다. */
function detectGate(before, status) {
  const t = `${before.title} ${before.bodyText}`.toLowerCase();
  const patterns = [
    'just a moment',
    'checking your browser',
    'attention required',
    'verify you are human',
    'enable javascript and cookies',
    'access denied',
    'ddos protection',
    '접근이 차단',
    '비정상적인 접근',
  ];
  if (patterns.some((p) => t.includes(p))) return 'challenge';
  if (status && status >= 400) return `http_${status}`;
  if (before.docHeight < 400 && before.imgCount === 0) return 'empty';
  return null;
}

/**
 * 신호 → 티어. 규칙은 전부 명시적이고, 근거를 함께 반환한다.
 * 판정을 블랙박스로 두지 않는 것이 이 스캐너의 설계 원칙이다.
 */
export function classify(before, after, rafPerSec, gate) {
  const reasons = [];
  let tier = 0;

  const libs = new Set([...(before.libs || []), ...(after?.libs || [])]);

  // ── T1 등장형 ────────────────────────────────────────────────
  const revealSignals = [];
  if (before.lazyImages > 0) revealSignals.push(`지연 로딩 이미지 ${before.lazyImages}개`);
  if (before.hiddenReveal >= 3) revealSignals.push(`등장 대기 요소 ${before.hiddenReveal}개`);
  if (before.io >= 2) revealSignals.push(`IntersectionObserver ${before.io}회 생성`);
  if (libs.has('aos') || libs.has('scrollReveal')) revealSignals.push('등장 애니메이션 라이브러리');
  if (libs.has('scrollTrigger')) revealSignals.push('ScrollTrigger(등장용으로 추정)');
  if (revealSignals.length > 0) { tier = Math.max(tier, 1); reasons.push(...revealSignals); }

  // ── T2 순환형 ────────────────────────────────────────────────
  // 실제로 "돌고 있는" 것만 인정한다. 스타일시트에 규칙이 적혀 있다는 사실만으로는
  // 그 규칙이 보이는 요소에 적용됐는지 알 수 없다.
  const loopSignals = [];
  if (before.animInfinite > 0) loopSignals.push(`실행 중인 무한 반복 애니메이션 ${before.animInfinite}개`);
  if (before.loopVideos > 0) loopSignals.push(`자동재생·루프 비디오 ${before.loopVideos}개`);
  if (loopSignals.length > 0) { tier = Math.max(tier, 2); reasons.push(...loopSignals); }
  // 아래는 보조 근거로만 남긴다. 단독으로 티어를 올리지 않는다.
  if (before.infiniteKeyframeRules > 0) {
    reasons.push(`(참고) infinite 키프레임 규칙 ${before.infiniteKeyframeRules}건 — 실행 여부는 미확인`);
  }
  if (libs.has('swiper')) reasons.push('(참고) 슬라이더 라이브러리(Swiper) — 자동재생 여부는 미확인');

  // ── T3 스크롤 연동형 ─────────────────────────────────────────
  // DOM에서 실제로 관측된 구조만 인정한다. ScrollTrigger·Lenis가 "있다"는 사실은
  // 핀 고정을 뜻하지 않는다 — 실측 결과 대부분 단순 등장 애니메이션에 쓰였다.
  const linkedSignals = [];
  if (before.stickyPinned > 0) linkedSignals.push(`핀 고정 섹션 ${before.stickyPinned}개`);
  if (before.horizontalScroll > 0) linkedSignals.push(`가로 스크롤 섹션 ${before.horizontalScroll}개`);
  if (before.scrollHijack) linkedSignals.push('body 스크롤 잠금(스크롤 탈취)');
  if (linkedSignals.length > 0) { tier = Math.max(tier, 3); reasons.push(...linkedSignals); }

  // ── T4 실시간 렌더형 ─────────────────────────────────────────
  // WebGL 컨텍스트가 결정적 신호다. rAF 빈도만으로는 판정하지 않는다 —
  // 스무스 스크롤 라이브러리들이 각자 루프를 돌리면 초당 100회를 쉽게 넘긴다.
  const liveSignals = [];
  if (before.webgl > 0) liveSignals.push(`WebGL 컨텍스트 ${before.webgl}개`);
  if (libs.has('three') || libs.has('spline') || libs.has('pixi') || libs.has('matterjs')) {
    liveSignals.push('3D·물리 렌더링 라이브러리');
  }
  if (rafPerSec > 45 && before.biggestCanvasRatio > 0.25 && before.canvas2d > 0) {
    liveSignals.push(`캔버스에 매 프레임 그리는 중 (rAF ${rafPerSec}회/초, 화면의 ${Math.round(before.biggestCanvasRatio * 100)}%)`);
  }
  if (liveSignals.length > 0) { tier = Math.max(tier, 4); reasons.push(...liveSignals); }

  // ── 직교 태그 ────────────────────────────────────────────────
  const tags = [];
  if (gate) tags.push('G');
  if (before.fixed + before.sticky > 0) tags.push('S');
  const worstHeight = Math.max(before.docHeight, after?.docHeight || 0);
  if (worstHeight > CHROME_MAX_TEXTURE * 0.6) tags.push('L');
  if (before.hoverRules >= 5) tags.push('H');
  // M — 스크롤을 라이브러리가 가로챈다. 티어와 무관하지만 프로그램적 스크롤이
  // 평소처럼 동작하지 않으므로 캡처 시 별도 처리가 필요하다.
  if (libs.has('lenis') || libs.has('locomotive')) tags.push('M');
  // U — 스크롤을 끝까지 내렸는데도 문서가 화면 높이 그대로다. 렌더링이 덜 됐을
  // 가능성이 높으므로 이 측정치는 사람이 확인해야 한다.
  const vh = before.viewportHeight || 900;
  if (worstHeight <= vh * 1.2 && before.hiddenReveal > 10) tags.push('U');

  return {
    tier: gate ? null : tier,
    tags,
    reasons: reasons.length ? reasons : ['특별한 동적 신호 없음'],
    // 감사를 위해 판정 근거가 되는 원 신호를 그대로 남긴다.
    evidence: {
      libs: [...libs],
      rafPerSec,
      docHeight: worstHeight,
      heightGrewOnScroll: after ? after.docHeight - before.docHeight : 0,
      revealResolved: after ? before.hiddenReveal - after.hiddenReveal : null,
      brokenImagesAfterScroll: after?.brokenImages ?? null,
      fixedOrSticky: before.fixed + before.sticky,
      hoverRules: before.hoverRules,
      readableSheets: `${before.readableSheets}/${before.totalSheets}`,
    },
  };
}

/** 사이트 한 곳을 측정한다. context는 호출자가 재사용한다. */
export async function probeSite(context, url, { timeout = 45000 } = {}) {
  const page = await context.newPage();
  const started = Date.now();
  try {
    await page.addInitScript(INIT_SCRIPT);

    let status = null;
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      status = res ? res.status() : null;
    } catch (e) {
      return { url, ok: false, error: `goto: ${e.message.split('\n')[0]}`, ms: Date.now() - started };
    }

    // 네트워크가 잠잠해질 때까지 기다리되, 무한 폴링 사이트를 위해 상한을 둔다.
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);

    const before = await page.evaluate(collect, 'before');

    const gate = detectGate(before, status);
    if (gate) {
      return {
        url, ok: true, gate, finalUrl: page.url() !== url ? page.url() : undefined,
        ms: Date.now() - started,
        ...classify(before, null, 0, gate),
        title: before.title,
      };
    }

    // 유휴 상태의 rAF 빈도 — 실시간 렌더링(T4)과 정적 페이지를 가르는 결정적 신호
    const rafBefore = await page.evaluate(() => window.__probe.raf);
    await page.waitForTimeout(RAF_SAMPLE_MS);
    const rafAfter = await page.evaluate(() => window.__probe.raf);
    const rafPerSec = Math.round(((rafAfter - rafBefore) / RAF_SAMPLE_MS) * 1000);

    // 끝까지 천천히 스크롤 — 지연 로딩과 스크롤 트리거를 전부 발동시킨다.
    await page.evaluate(
      async ({ ratio, maxSteps }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let last = -1;
        for (let i = 0; i < maxSteps; i++) {
          window.scrollBy(0, window.innerHeight * ratio);
          await sleep(450);
          const y = window.scrollY;
          if (y === last) break;
          last = y;
        }
        window.scrollTo(0, 0);
        await sleep(600);
      },
      { ratio: SCROLL_STEP_RATIO, maxSteps: MAX_SCROLL_STEPS }
    );
    await page.waitForTimeout(1200);

    const after = await page.evaluate(collect, 'after');
    const result = classify(before, after, rafPerSec, null);

    return {
      url, ok: true, gate: null, title: before.title,
      finalUrl: page.url() !== url ? page.url() : undefined,
      ms: Date.now() - started, ...result,
    };
  } catch (e) {
    return { url, ok: false, error: e.message.split('\n')[0], ms: Date.now() - started };
  } finally {
    await page.close().catch(() => {});
  }
}

export const TIERS = {
  0: { key: 'T0', name: '정적', short: '그냥 찍으면 된다' },
  1: { key: 'T1', name: '등장형', short: '스크롤하면 나타난다 — 끝 상태가 있다' },
  2: { key: 'T2', name: '순환형', short: '계속 움직인다 — 끝이 없다' },
  3: { key: 'T3', name: '스크롤 연동형', short: '스크롤이 곧 타임라인 — 풀페이지 개념이 깨진다' },
  4: { key: 'T4', name: '실시간 렌더형', short: '매 프레임 다시 그린다 — 결정론적 캡처 불가' },
};

export const TAGS = {
  G: '차단·인증 필요 (Gated)',
  S: '고정 헤더·플로팅 요소 (Sticky)',
  L: '초장문 — 높이 한계 위험 (Long)',
  H: '호버·클릭으로만 보이는 콘텐츠 (Hidden)',
  M: '스무스 스크롤 라이브러리 — 프로그램적 스크롤 별도 처리 (Motion)',
  U: '문서가 펼쳐지지 않음 — 측정치 사람 확인 필요 (Uncertain)',
};

export { VIEWPORT, CHROME_MAX_TEXTURE };
