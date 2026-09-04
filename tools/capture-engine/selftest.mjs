#!/usr/bin/env node
/**
 * selftest.mjs — 캡처 파이프라인과 채점기가 실제로 작동하는지 고정한다.
 *
 * fixtures/ 의 각 페이지는 실측이 지목한 문제 하나씩을 재현한다.
 * "단계를 켜기 전에는 실패하고, 켜면 통과한다"를 검사한다 — 단계가
 * 진짜로 일을 하는지 확인하지 않으면 성적표를 믿을 수 없다.
 *
 *   npm test
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSite, VIEWPORT, SAFE_PIXELS, DEVICES, contextOptionsFor } from './capture.mjs';
import { compareCaptures, renderDiffStrip, VERDICT } from './diff.mjs';
import { createBrowserHost, isBrowserDeath } from './browser.mjs';
import { extractSitemap } from './sitemap.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8825;
// 두 번째 포트는 "다른 오리진" 을 만들기 위한 것이다. 포트가 다르면 오리진이 다르다.
const CROSS_PORT = 8826;
const BASE = `http://127.0.0.1:${PORT}/`;
const CROSS = `http://localhost:${CROSS_PORT}`;

const same = (v) => v === VERDICT.SAME || v === VERDICT.SAME_PIXELS;

/**
 * 각 항목은 파이프라인을 한 번(또는 두 번) 돌리고 결과를 확인한다.
 * check 는 문제가 있으면 설명 문자열을, 없으면 null 을 돌려준다.
 */
const CASES = [
  {
    name: '정적 페이지는 아무것도 안 켜도 두 번이 같다',
    file: 'static.html', mode: 'fullpage', steps: [], twice: true,
    check: (r, cmp) => (same(cmp.verdict) ? null : `두 번이 달랐다 (${cmp.verdict} ${(cmp.ratio * 100).toFixed(2)}%)`),
  },
  {
    name: '무한 애니메이션은 baseline 에서 두 번이 다르다',
    file: 'loop.html', mode: 'fullpage', steps: [], twice: true,
    check: (r, cmp) => (same(cmp.verdict) ? '달라야 하는데 같게 나왔다 — 채점기가 못 잡고 있다' : null),
  },
  {
    name: 'anim 단계를 켜면 무한 애니메이션도 두 번이 같아진다',
    file: 'loop.html', mode: 'fullpage', steps: ['anim'], twice: true,
    check: (r, cmp) => (same(cmp.verdict) ? null : `여전히 다르다 (${cmp.verdict} ${(cmp.ratio * 100).toFixed(2)}%)`),
  },
  {
    name: 'sticky 단계는 플로팅 3개를 숨기고 헤더 1개는 남긴다',
    file: 'floating.html', mode: 'fullpage', steps: ['sticky'],
    check: (r) => {
      const note = (r.notes || []).find((n) => n.startsWith('고정 요소'));
      if (!note) return '고정 요소를 하나도 못 찾았다';
      const n = Number((note.match(/고정 요소 (\d+)개/) || [])[1]);
      if (n !== 3) return `숨긴 개수가 ${n}개 (기대 3개) — ${note}`;
      if (!note.includes('헤더 1개 유지')) return `헤더를 남기지 않았다 — ${note}`;
      return null;
    },
  },
  {
    name: 'sticky 를 안 켜면 아무것도 숨기지 않는다',
    file: 'floating.html', mode: 'fullpage', steps: [],
    check: (r) => ((r.notes || []).some((n) => n.startsWith('고정 요소')) ? '안 켰는데 숨겼다' : null),
  },
  {
    name: '스무스 스크롤을 안 풀면 끝까지 못 가서 문서가 짧게 남는다',
    file: 'smooth.html', mode: 'fullpage', steps: [],
    check: (r) => (r.docHeight > 3000 ? `문서가 ${r.docHeight}px — 스크롤이 성공해버렸다. 픽스처가 무력하다` : null),
  },
  {
    name: 'motion 단계를 켜면 끝까지 스크롤해 숨은 콘텐츠가 붙는다',
    file: 'smooth.html', mode: 'fullpage', steps: ['motion'],
    check: (r) => (r.docHeight > 3000 ? null : `문서가 ${r.docHeight}px 그대로 — 모션 해제가 안 먹었다`),
  },
  {
    name: 'slice 단계는 긴 문서를 여러 장으로 나눈다',
    file: 'tall.html', mode: 'fullpage', steps: ['slice'],
    check: (r) => {
      const want = Math.ceil(r.docHeight / SAFE_PIXELS);
      if (want < 2) return `픽스처가 짧아졌다 (${r.docHeight}px) — 분할을 시험할 수 없다`;
      return r.sliceCount === want ? null : `${r.sliceCount}장 (기대 ${want}장)`;
    },
  },
  {
    name: 'slice 를 안 켜면 한 장으로 찍는다',
    file: 'tall.html', mode: 'fullpage', steps: [],
    check: (r) => (r.sliceCount === 1 ? null : `${r.sliceCount}장으로 나눴다`),
  },
  {
    name: '모달이 스크롤을 잠갔어도 motion 단계가 풀고 끝까지 간다',
    file: 'scrolllock.html', mode: 'fullpage', steps: ['motion'],
    check: (r) => (r.docHeight > 4000 ? null : `문서가 ${r.docHeight}px — 잠금을 못 풀었다`),
  },
  {
    name: 'motion 을 안 켜면 잠긴 채로 남는다',
    file: 'scrolllock.html', mode: 'fullpage', steps: [],
    check: (r) => (r.docHeight > 4000 ? `문서가 ${r.docHeight}px — 잠금이 안 걸렸다. 픽스처가 무력하다` : null),
  },
  {
    // 실전에서 코오롱몰이 4픽셀 차이로 100% 실패 처리됐다.
    // 겹치는 영역이 같으면 통과여야 하고, 높이 차이는 따로 적혀야 한다.
    name: '문서 높이가 몇 px 흔들려도 겹치는 부분이 같으면 통과한다',
    file: 'heightjitter.html', mode: 'fullpage', steps: [], twice: true,
    check: (r, cmp, shots) => {
      const [a, b] = shots.map((x) => x.docHeight);
      if (a === b) return `두 번의 높이가 같아 시험이 안 됐다 (${a}px) — 픽스처를 고쳐야 한다`;
      if (!same(cmp.verdict)) return `실패로 나왔다 (${cmp.verdict} ${(cmp.ratio * 100).toFixed(2)}% — ${cmp.note || ''})`;
      if (!/높이 \d+px 차이/.test(cmp.note || '')) return `높이 차이(${Math.abs(a - b)}px)를 기록하지 않았다 — ${cmp.note || '(메모 없음)'}`;
      return null;
    },
  },
  {
    // 이 프로젝트에서 가장 크게 틀렸던 지점.
    //
    // 등장 애니메이션 대부분은 들어올 때 클래스를 붙이고 **나갈 때 뗀다.**
    // 맨 아래까지 훑고 맨 위로 돌아와 한 장으로 찍으면 아래쪽이 전부 다시
    // 투명해진 채로 찍힌다. GoFullPage 같은 확장이 멀쩡한 이유는 각 칸이
    // 화면에 있는 동안 그 화면을 찍기 때문이다.
    name: '나가면 다시 숨는 페이지도 화면 단위로 찍으면 온전하다',
    file: 'revealtoggle.html', steps: ['sticky', 'motion', 'anim'], mode: 'stitch',
    check: (r) => {
      if (r.mode !== 'stitch') return `모드가 ${r.mode} 다`;
      if (!r.shotCount || r.shotCount < 4) return `화면 ${r.shotCount}칸만 찍었다 (문서 ${r.docHeight}px)`;
      return null;
    },
  },
  {
    // 같은 페이지를 예전 방식(한 방 캡처)으로 찍으면 아래쪽이 비어야 한다.
    // 이게 실패하면 위 시험이 아무것도 증명하지 못한다.
    name: '같은 페이지를 한 방에 찍으면 아래쪽이 투명하게 남는다',
    file: 'revealtoggle.html', steps: ['sticky', 'motion', 'anim'], mode: 'fullpage',
    check: (r) => (r.ready && r.ready.invisible >= 3 ? null
      : `투명한 요소를 ${r.ready && r.ready.invisible}개만 셌다 — 픽스처가 무력하다`),
  },
  {
    // 두 번 찍어 같은지만 보면 "두 번 다 똑같이 비어 있는" 페이지가 통과한다.
    // 아임웹에서 실제로 그 일이 났다. 픽셀이 아니라 DOM 을 봐야 잡힌다.
    name: '두 번 다 같더라도 내용이 안 뜬 상태를 잡아낸다',
    file: 'notready.html', mode: 'fullpage', steps: [], twice: true,
    check: (r, cmp) => {
      if (!same(cmp.verdict)) return '두 번이 달랐다 — 이 픽스처는 항상 같아야 한다';
      if (!r.ready) return '완성도를 재지 않았다';
      if (r.ready.invisible < 3) return `투명한 요소를 ${r.ready.invisible}개만 셌다 (3개여야 한다)`;
      if (!(r.notes || []).some((n) => n.includes('투명한 요소'))) return '메모에 남기지 않았다';
      return null;
    },
  },
  {
    // 늦게 오는 이미지를 끝까지 기다리는지. 다만 이 픽스처는 스크롤 속도까지
    // 가르지는 못한다 — 뒤에 붙인 networkidle 대기만으로도 통과하기 때문이다.
    // 스크롤을 느리게 한 것이 실제 사이트에서 효과가 있는지는 라이브에서만 안다.
    name: '늦게 오는 지연 로딩 이미지를 다 받은 뒤에 찍는다',
    file: 'lazyimg.html', mode: 'fullpage', steps: [],
    check: (r) => {
      if (!r.ready) return '완성도를 재지 않았다';
      const { images, loading, broken } = r.ready;
      if (images < 6) return `이미지를 ${images}개만 찾았다 (6개여야 한다)`;
      if (loading || broken) return `아직 안 뜬 이미지 ${loading}개 · 깨진 것 ${broken}개`;
      return null;
    },
  },
  {
    // 법무법인 유강이 가로 폭 1,642 대 1,654 로 실패했다.
    // 뷰포트 폭으로 잘라내면 폭이 고정되고, 방문자가 보는 것과도 일치한다.
    name: '가로로 삐져나온 양이 달라져도 뷰포트 폭으로 잘라 같게 만든다',
    file: 'widthjitter.html', mode: 'fullpage', steps: [], twice: true,
    check: (r, cmp) => (same(cmp.verdict) ? null
      : `실패로 나왔다 (${cmp.verdict} — ${cmp.note || ''})`),
  },
  {
    // 차이가 어디에 있는지 엔진이 짚어야 한다. 안 그러면 0.01% 짜리 차이를
    // 9,000px 그림 두 장을 눈으로 훑어 찾아야 한다.
    name: '차이 구간의 좌표를 짚고, 잘라낸 그림을 만든다',
    file: 'spot.html', mode: 'fullpage', steps: [], twice: true, strip: true,
    check: (r, cmp) => {
      if (!cmp.region) return `구간을 못 잡았다 (${cmp.verdict} — ${cmp.note || ''})`;
      const { x, y, w, h, bands } = cmp.region;
      if (bands !== 1) return `${bands}덩어리로 셌다 — 한 덩어리여야 한다`;
      if (x < 180 || x > 220) return `가로 시작이 ${x}px (기대 200 근처)`;
      if (w < 100 || w > 145) return `가로 폭이 ${w}px (기대 120 근처)`;
      if (h < 28 || h > 55) return `세로 높이가 ${h}px (기대 40 근처)`;
      if (y < 1200 || y > 1500) return `세로 시작이 ${y}px (기대 1,290 근처)`;
      return null;
    },
  },
  {
    // 실전에서 49건 중 14건을 무너뜨린 버그. window[0] 은 iframe 이고,
    // 크로스 오리진이면 속성을 읽는 것만으로 SecurityError 가 난다.
    name: '크로스 오리진 iframe 이 있어도 캡처가 죽지 않는다',
    file: 'crossorigin.html', mode: 'fullpage', steps: ['motion', 'sticky', 'anim'],
    check: (r) => (r.docHeight > 1000 ? null : `문서가 ${r.docHeight}px — 캡처가 제대로 안 됐다`),
  },
  {
    // 동화목립산업이 "결과물이 안 나온" 이유.
    // 문서는 5,400px 인데 스크롤이 0 에 붙박여 있으면, 방어가 없는 루프는
    // 같은 첫 화면을 120번 찍어 전부 겹쳐 붙인다 — 맨 위 한 칸만 있는
    // 빈 그림이 나온다. 조용히 나쁜 그림을 내놓느니 여기까지 갔다고 말해야 한다.
    name: '스크롤이 안 먹는 페이지는 헛돌지 않고 멈춘 자리를 기록한다',
    file: 'scrollrevert.html', steps: ['sticky', 'motion', 'anim'], mode: 'stitch',
    check: (r) => {
      if (r.docHeight < 4000) return `문서가 ${r.docHeight}px — 픽스처가 짧아 시험이 안 된다`;
      if (!r.stalled) return `${r.shotCount}칸을 찍고 멈춘 걸 기록하지 않았다 — 헛돌고 있다`;
      if (r.shotCount > 2) return `멈춘 걸 알면서 ${r.shotCount}칸이나 찍었다`;
      if (r.stalled.at > 200) return `${r.stalled.at}px 에서 멈췄다고 한다 — 0 근처여야 한다`;
      if (!(r.notes || []).some((n) => n.includes('멈췄습니다'))) return '메모에 남기지 않았다';
      return null;
    },
  },
  {
    // 같은 페이지에서 되돌리기만 꺼보면 끝까지 내려가야 한다.
    // 이게 실패하면 위 시험은 캡처기가 고장 난 걸 본 것일 수도 있다.
    name: '되돌리기를 끄면 같은 페이지가 끝까지 내려간다 (대조군)',
    file: 'scrollrevert.html?free=1', steps: ['sticky', 'motion', 'anim'], mode: 'stitch',
    check: (r) => {
      if (r.stalled) return `멈췄다고 한다 (${r.stalled.at}px) — 막은 게 없는데 못 내려갔다`;
      if (r.shotCount < 5) return `화면 ${r.shotCount}칸만 찍었다 (문서 ${r.docHeight}px)`;
      return null;
    },
  },
  {
    // 375 는 폭만 줄이는 게 아니다. 사이트는 UA·폭·터치·해상도 중 한두 개로
    // 모바일을 판정하는데, 넷이 다 모바일이어야 어떤 사이트든 모바일 페이지를 준다.
    name: '375 로 찍으면 사이트가 방문자를 모바일로 본다',
    file: 'mobile.html', mode: 'stitch', steps: [], device: 375,
    check: (r) => (r.title === '모바일 레이아웃' ? null : `사이트 판정: "${r.title}"`),
  },
  {
    name: '1440 으로 찍으면 사이트가 방문자를 PC 로 본다',
    file: 'mobile.html', mode: 'stitch', steps: [], device: 1440,
    check: (r) => (r.title === 'PC 레이아웃' ? null : `사이트 판정: "${r.title}"`),
  },
  {
    // 테라클 캡처에서 GNB 가 화면마다 반복됐다. 처음엔 흐름 안에 있다가 스크롤하면
    // 고정으로 바뀌는 헤더는, 첫 화면에 남겨 둔 것이 다음 화면마다 다시 찍힌다.
    // 첫 화면에 남긴 헤더는 CSS 가 뭐라 하든 두 번째 화면부터 숨겨야 한다.
    name: '스크롤하면 고정되는 헤더는 첫 화면에만 한 번 나온다',
    file: 'stickyheader.html', mode: 'stitch', steps: ['sticky', 'motion', 'anim'], color: true,
    check: (r, cmp, shots, extra) => {
      if (!extra || !extra.rows) return '색을 못 셌다';
      const { top, below } = extra.rows;
      if (top < 40) return `첫 화면에 헤더가 ${top}줄뿐이다 (80줄 근처여야 한다)`;
      if (below > 0) return `헤더 색이 두 번째 화면 아래에 ${below}줄이나 있다 — GNB 가 반복됐다`;
      return null;
    },
  },
  {
    // 그래도 GNB 가 반복됐다. 스크롤할 때마다 헤더를 통째로 새로 만들어 스크롤 위치에
    // 얹는 사이트는 표도 인라인 style 도 매번 사라진다. CSS 를 믿지 말고 "스크롤이
    // 달라졌는데 같은 자리에 있는 것"을 잡아야 한다.
    name: '스크롤마다 새로 만드는 헤더도 첫 화면에만 한 번 나온다',
    file: 'headerclone.html', mode: 'stitch', steps: ['sticky', 'motion', 'anim'], color: true,
    check: (r, cmp, shots, extra) => {
      if (!extra || !extra.rows) return '색을 못 셌다';
      const { top, below } = extra.rows;
      if (top < 40) return `첫 화면에 헤더가 ${top}줄뿐이다`;
      if (below > 0) return `헤더 색이 두 번째 화면 아래에 ${below}줄이나 있다 — GNB 가 반복됐다`;
      return null;
    },
  },
  {
    // 마지막 안전망. 매 프레임 헤더를 새로 만드는 페이지는 숨긴 직후 다음 프레임에
    // 새것이 생겨 DOM 으로는 어떤 방법으로도 못 잡는다. 둘째 조각 위쪽에 첫 조각과
    // 같은 띠가 찍혀 있으면, 그만큼 겹치게 다시 찍고 조각마다 위를 잘라낸다.
    name: 'DOM 으로 못 잡는 헤더도 그림을 보고 잘라내 첫 화면에만 한 번 나온다',
    file: 'headerrepaint.html', mode: 'stitch', steps: ['sticky', 'motion', 'anim'], color: true,
    check: (r, cmp, shots, extra) => {
      if (!extra || !extra.rows) return '색을 못 셌다';
      const { top, below } = extra.rows;
      if (top < 40) return `첫 화면에 헤더가 ${top}줄뿐이다`;
      if (below > 0) return `헤더 색이 두 번째 화면 아래에 ${below}줄이나 있다 — GNB 가 반복됐다`;
      if (!(r.notes || []).some((n) => n.includes('잘라냈습니다'))) return '그림 안전망이 동작한 기록이 없다';
      return null;
    },
  },
  {
    // 테라클 1440 결과에서 로고·언어 버튼은 사라졌는데 메뉴 글자만 조각마다 도장처럼
    // 찍혔다. 포장을 visibility:hidden 으로 숨겨도, 자식이 스스로 visibility:visible 로
    // 정해 두면 그 자식은 보인다. 규칙이 자손까지 !important 로 덮어야 한다.
    name: '자식이 스스로 visible 로 정한 메뉴도 부모와 함께 숨는다',
    file: 'headervisible.html', mode: 'stitch', steps: ['sticky', 'motion', 'anim'], color: true,
    check: (r, cmp, shots, extra) => {
      if (!extra || !extra.rows) return '색을 못 셌다';
      const { top, below } = extra.rows;
      if (top < 30) return `첫 화면에 헤더가 ${top}줄뿐이다`;
      if (below > 0) return `메뉴 색이 두 번째 화면 아래에 ${below}줄이나 있다 — 자식이 visible 이라 안 숨었다`;
      return null;
    },
  },
  {
    // 테라클 히어로 이음새에서 영상이 어긋났다. 캡처기가 비디오를 멈춰도 사이트가
    // 스크롤마다 play() 를 다시 불러, 조각마다 다른 프레임이 찍혔다.
    // 비디오 아래 자홍색 진행 막대: 첫 프레임이면 길이가 0 이라 자홍색이 거의 없어야 한다.
    name: '사이트가 다시 재생시켜도 비디오는 첫 프레임에 멈춰 있다',
    file: 'videoplay.html', mode: 'stitch', steps: ['sticky', 'motion', 'anim'], color: true,
    check: (r, cmp, shots, extra) => {
      if (!extra || !extra.rows) return '색을 못 셌다';
      const { top, below } = extra.rows;
      // 막대는 비디오 맨 아래 10px(360px 중) — 첫 프레임이면 길이 0. 조금이라도 돌았으면 줄이 생긴다.
      if (top + below > 0) return `자홍색 진행 막대가 ${top + below}줄 보인다 — 비디오가 첫 프레임에 멈춰 있지 않다`;
      if (!(r.notes || []).some((n) => /비디오/.test(n))) return '비디오를 멈춘 기록이 없다';
      return null;
    },
  },
  {
    // 임베드(iframe) 안의 비디오. 바깥 문서만 멈추면 안의 영상은 계속 돌아 조각마다
    // 다른 프레임이 찍힌다. 모든 프레임에서 붙잡아야 한다.
    name: 'iframe 임베드 안의 비디오도 첫 프레임에 멈춰 있다',
    file: 'videoframe.html', mode: 'stitch', steps: ['sticky', 'motion', 'anim'], color: true,
    check: (r, cmp, shots, extra) => {
      if (!extra || !extra.rows) return '색을 못 셌다';
      const { top, below } = extra.rows;
      if (top + below > 0) return `자홍색 띠가 ${top + below}줄 보인다 — 임베드 안 비디오가 돌았다`;
      if (!(r.notes || []).some((n) => /임베드/.test(n))) return '임베드 안 비디오를 멈춘 기록이 없다';
      return null;
    },
  },
  {
    // 테라클 Contact 페이지가 "여는 중"에서 10분 넘게 멈췄다. 응답이 영영 안 오는
    // iframe(지도·광고) 안에서 비디오를 붙잡으려다 evaluate 가 안 돌아온 것이다.
    // 프레임마다 2초 넘으면 건너뛰어야 한다.
    name: '영영 안 뜨는 iframe 이 있어도 캡처가 멈추지 않는다',
    file: 'hangframe.html', mode: 'stitch', steps: ['sticky', 'motion', 'anim'],
    check: (r) => {
      if (!r.ok) return `실패: ${r.error}`;
      if (r.ms > 60000) return `${Math.round(r.ms / 1000)}초나 걸렸다 — iframe 을 기다리다 멈췄다`;
      if (r.shotCount < 3) return `화면 ${r.shotCount}칸만 찍었다`;
      if (!(r.notes || []).some((n) => n.includes('응답 없는 iframe'))) return '응답 없는 iframe 을 비운 기록이 없다';
      return null;
    },
  },
  {
    // 정보구조는 헤더 목록의 중첩을 그대로 읽는다. 숨긴 드롭다운도 읽고,
    // 모바일 메뉴에 반복된 링크는 한 번만 세고, 외부·앵커·파일은 표시한다.
    name: '정보구조: 메뉴 트리를 읽고 중복·외부·앵커를 가른다',
    file: 'nav.html', sitemap: true,
    check: (r) => {
      if (!r.ok) return `실패: ${r.error}`;
      if (r.method !== 'hover') return `마우스를 올려 찾는 방식이 아니라 ${r.method} 로 읽었다`;
      const top = r.menu.map((x) => x.label);
      const want = ['홈', 'About us', 'Technology', 'Products', 'Blog', 'Contact'];
      if (top.join('|') !== want.join('|')) return `최상위가 ${top.join(' / ')} (기대 ${want.join(' / ')})`;
      if (!r.menu[0].home) return '홈을 홈으로 표시하지 않았다';
      const phantom = [];
      const scan = (items) => { for (const x of items) { if (x.label.startsWith('제품 보기')) phantom.push(x); scan(x.children); } };
      scan(r.menu);
      if (phantom.length) return `서서히 나타난 본문 링크가 하위 메뉴로 ${phantom.length}번 들어갔다`;
      const about = r.menu[1];
      if (about.children.map((x) => x.label).join('|') !== '연혁|팀') return `About us 하위가 ${about.children.map((x) => x.label).join(' / ')}`;
      if (about.children[0].kind !== '앵커') return `연혁이 ${about.children[0].kind} (기대 앵커)`;
      const tech = r.menu[2];
      if (tech.children.map((x) => x.label).join('|') !== '핵심 기술|특허 자료') return `Technology 하위가 ${tech.children.map((x) => x.label).join(' / ')} — li 밖에 그려진 드롭다운을 못 봤다`;
      if (!tech.children.some((x) => x.label === '특허 자료' && x.kind === '파일')) return '특허 자료를 파일로 가르지 못했다';
      if (r.menu[4].kind !== '외부') return `Blog 가 ${r.menu[4].kind} (기대 외부)`;
      if (r.menu[5].kind !== '없음') return `Contact 가 ${r.menu[5].kind} (기대 없음)`;
      if (r.menuCount !== 10) return `메뉴를 ${r.menuCount}개로 셌다 (기대 10 — 모바일 메뉴 중복이 섞였나)`;
      if (r.loose.some((x) => x.label === '로그인')) return '로그인이 헤더의 다른 링크에 남아 있다 — 유틸리티로 가야 한다';
      if (r.loose.some((x) => x.href.includes('/news/'))) return '본문 뉴스 링크가 헤더 링크로 딸려 왔다 (포장 클래스에 nav 가 있어서)';
      const util = r.utility.map((x) => x.label).sort();
      if (util.join('|') !== '로그인|마이페이지') return `유틸리티 메뉴가 ${util.join(' / ')} (기대 로그인 / 마이페이지 — 언어 선택은 정보구조에 안 적는다)`;
      if (!(r.languages || []).includes('KOR / EN')) return `뺀 언어 선택을 기록하지 않았다 (${(r.languages || []).join(', ')})`;
      if (r.footer.length !== 3) return `푸터 링크 ${r.footer.length}개 (기대 3)`;
      // 메인페이지 구성
      const sec = (r.main && r.main.sections) || [];
      const types = sec.map((x) => x.type);
      if (sec.length !== 5) return `메인 구간을 ${sec.length}개로 셌다 (기대 5 — section 없는 배너를 틈에서 찾아야 한다): ${types.join(' / ')}`;
      if (!types[0].startsWith('히어로 (동영상)')) return `1구간이 ${types[0]} (기대 히어로 (동영상))`;
      if (types[1] !== '이미지 + 텍스트') return `2구간이 ${types[1]} (기대 이미지 + 텍스트)`;
      if (types[2] !== 'CTA 배너') return `3구간이 ${types[2]} (기대 CTA 배너)`;
      if (types[3] !== '카드 3열') return `4구간이 ${types[3]} (기대 카드 3열)`;
      if (types[4] !== '문의 · 폼') return `5구간이 ${types[4]} (기대 문의 · 폼)`;
      if (!sec[1].gnb || !sec[3].gnb) return 'About us / Technology 구간을 GNB 항목과 연결하지 못했다';
      return null;
    },
  },
  {
    // K'sox 에서 2차 메뉴를 하나도 못 잡았다. 로고가 위, 메뉴가 두 번째 줄(y≈230)
    // 이라 220px 안에서 찾는 GNB 줄에 안 걸렸고, 드롭다운이 0.6초에 걸쳐
    // 서서히 나타나 350ms 뒤에 보면 비어 있었다. 3차는 화면엔 안 보이고 DOM 에만 있다.
    name: '로고 아래 두 번째 줄 메뉴, 서서히 열리는 드롭다운, DOM 에만 있는 3차를 다 잡는다',
    file: 'shopnav.html', sitemap: true,
    check: (r) => {
      if (!r.ok) return `실패: ${r.error}`;
      if (r.method !== 'hover') return `${r.method} 로 읽었다 — 두 번째 줄 메뉴를 GNB 줄로 못 찾았다`;
      const top = r.menu.map((x) => x.label);
      if (top.join('|') !== 'ABOUT|LOOKBOOK|QUOTATION|SHOP') return `최상위가 ${top.join(' / ')} — 로고·검색·LOGIN·CART 줄을 GNB 로 잡았나`;
      const util = r.utility.map((x) => x.label).sort().join('|');
      if (util !== 'CART|LOGIN') return `유틸리티가 ${util || '(없음)'} (기대 CART / LOGIN)`;
      const shop = r.menu[3];
      const kids = shop.children.map((x) => x.label);
      if (kids.join('|') !== 'NEW ARRIVAL|WOMEN|MEN|KID|GIFT|COMMUNITY') return `SHOP 하위가 ${kids.join(' / ') || '(없음)'} — 서서히 열리는 드롭다운을 못 봤다`;
      const women = shop.children[1];
      if (women.children.map((x) => x.label).join('|') !== 'SOCKS|STOCKINGS') return `WOMEN 하위가 ${women.children.map((x) => x.label).join(' / ') || '(없음)'} — DOM 에만 있는 3차를 못 채웠다`;
      return null;
    },
  },
  {
    name: '매번 다르게 그리는 페이지는 모든 단계를 켜도 다르다 (T4 대조군)',
    file: 'random.html', mode: 'fullpage', steps: ['sticky', 'motion', 'anim', 'slice'], twice: true,
    check: (r, cmp) => (same(cmp.verdict) ? '같게 나왔다 — 채점기가 T4 를 통과시키고 있다' : null),
  },
];

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webm': 'video/webm', '.svg': 'image/svg+xml' };

// 요청할 때마다 다른 높이를 넣어 준다. 난수는 두 번이 같게 나올 수 있어 못 쓴다.
let jitter = 0;

function makeServer() {
  return createServer(async (req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    if (name.includes('..')) { res.writeHead(400).end(); return; }
    // 일부러 늦게 주는 그림. 스크롤이 기다려 주는지 시험한다.
    if (name === '느린무한.html') { return; }   // 일부러 응답하지 않는다 — 영영 안 뜨는 iframe
    if (name === '느린그림.svg') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
          '<rect width="400" height="300" fill="#3a7"/></svg>');
      }, 900);
      return;
    }
    try {
      let body = await readFile(join(HERE, 'fixtures', name));
      if (extname(name) === '.html') {
        body = body.toString('utf8')
          .replaceAll('__CROSS_ORIGIN__', CROSS)
          .replaceAll('__JITTER__', String(10 + (jitter++ % 40) * 2));
      }
      res.writeHead(200, { 'content-type': MIME[extname(name)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
}

/** 같은 픽스처를 두 포트에 띄운다. 포트가 다르면 오리진이 달라진다. */
async function serveFixtures() {
  const listen = (port, host) => new Promise((r) => {
    const s = makeServer();
    s.unref();  // close 를 놓쳐도 이 서버 때문에 프로세스가 안 끝나는 일은 없게
    s.listen(port, host, () => r(s));
  });
  const [main, cross] = await Promise.all([listen(PORT, '127.0.0.1'), listen(CROSS_PORT, 'localhost')]);
  // 응답을 일부러 안 준 연결(느린무한.html)이 남아 있으면 close 가 영영 안 끝난다. 끊고 닫는다.
  return { close: (cb) => { cross.closeAllConnections(); main.closeAllConnections(); cross.close(); main.close(cb); } };
}

async function main() {
  const server = await serveFixtures();
  const host = createBrowserHost();

  // 서버와 브라우저는 무슨 일이 있어도 정리한다.
  // 안 그러면 예외가 났을 때 이벤트 루프가 계속 살아 있어 프로세스가 안 끝나고,
  // 터미널이 멈춘 것처럼 보인다. 실제로 그렇게 한 번 물렸다.
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await host.close().catch(() => {});
    await new Promise((r) => server.close(r));
  };
  process.on('SIGINT', () => { cleanup().finally(() => process.exit(130)); });

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

  /** 결과 그림에서 특정 색이 든 가로줄을 센다. 위쪽 띠와 그 아래를 따로 센다. */
  async function countColorRows(png, rgb, splitY) {
    const p = await getDiffPage();
    return p.evaluate(async ({ b64, rgb, splitY }) => {
      const bin = atob(b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const cv = new OffscreenCanvas(bmp.width, bmp.height); const cx = cv.getContext('2d');
      cx.drawImage(bmp, 0, 0);
      const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
      let top = 0, below = 0;
      for (let y = 0; y < bmp.height; y++) {
        let hit = 0;
        for (let x = 0; x < bmp.width; x += 4) {
          const i = (y * bmp.width + x) * 4;
          if (Math.abs(d[i] - rgb[0]) < 12 && Math.abs(d[i + 1] - rgb[1]) < 12 && Math.abs(d[i + 2] - rgb[2]) < 12) hit++;
        }
        if (hit > bmp.width / 8) { if (y < splitY) top++; else below++; }
      }
      return { top, below, height: bmp.height };
    }, { b64: png.toString('base64'), rgb, splitY });
  }

  /** 한 항목을 한 번 돌린다. 브라우저가 죽었으면 그 사실을 알려준다. */
  async function attempt(c) {
    if (c.sitemap) {
      const browser = await host.get();
      const ctx = await browser.newContext({ viewport: VIEWPORT, locale: 'ko-KR' });
      const r = await extractSitemap(ctx, BASE + c.file, { depth: 0 });
      await ctx.close().catch(() => {});
      return { shots: [r], cmp: null };
    }
    const shots = [];
    for (let i = 0; i < (c.twice ? 2 : 1); i++) {
      const browser = await host.get();
      const ctx = await browser.newContext(c.device
        ? contextOptionsFor(DEVICES[c.device], DEVICES[c.device].scale)
        : { viewport: VIEWPORT, locale: 'ko-KR' });
      const r = await captureSite(ctx, BASE + c.file, {
        steps: c.steps, mode: c.mode, stitchPage: await getStitchPage(),
        scale: c.device ? DEVICES[c.device].scale : 1,   // 컨텍스트 배율과 맞아야 이어붙이기가 맞는다
      });
      await ctx.close().catch(() => {});
      if (!r.ok) return { err: r.error, died: isBrowserDeath(r.error) };
      shots.push(r);
    }
    const cmp = c.twice ? await compareCaptures(await getDiffPage(), shots[0].slices, shots[1].slices) : null;
    const extra = c.color ? { rows: await countColorRows(shots[0].slices[0], [255, 0, 170], 200) } : null;
    return { shots, cmp, extra };
  }

  let failed = 0;
  try {
  for (const c of CASES) {
    let out;
    for (let i = 0; i < 2; i++) {
      try {
        out = await attempt(c);
      } catch (e) {
        const msg = e.message.split('\n')[0];
        out = { err: msg, died: isBrowserDeath(msg) };
      }
      if (!out.died) break;
      if (i === 0) console.log(`  … 브라우저가 죽어 다시 띄웁니다 (${c.file})`);
    }
    if (out.err) {
      console.log(`  ✗ ${c.name}\n      캡처 실패: ${out.err}`);
      failed++;
      continue;
    }
    if (c.strip && out.cmp && out.cmp.region) {
      const strip = await renderDiffStrip(await getDiffPage(),
        out.shots[0].slices[0], out.shots[1].slices[0], out.cmp.region).catch((e) => e);
      if (!strip || strip instanceof Error) {
        console.log(`  ✗ ${c.name}\n      잘라낸 그림을 못 만들었다: ${strip && strip.message}`);
        failed++;
        continue;
      }
      if (strip.length < 500) {
        console.log(`  ✗ ${c.name}\n      그림이 너무 작다 (${strip.length}바이트)`);
        failed++;
        continue;
      }
    }
    const problem = c.check(out.shots[0], out.cmp, out.shots, out.extra);
    if (problem) { console.log(`  ✗ ${c.name}\n      ${problem}`); failed++; }
    else console.log(`  ✓ ${c.name}`);
  }

  } finally {
    await cleanup();
  }
  if (host.restarts) console.log(`\n브라우저가 ${host.restarts}번 죽어서 다시 띄웠습니다. 환경 문제일 수 있습니다.`);
  console.log(`\n${CASES.length - failed}/${CASES.length} 통과`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
