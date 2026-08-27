# 웹사이트 스냅샷 자동화 — 경쟁 분석 및 기술 타당성 검토

작성일: 2026-08-27
관련 문서: 「웹사이트 스냅샷」 AX 기획안
웹 버전(도표·그림 포함): https://claude.ai/code/artifact/f66c78f6-88c9-40d8-b4e7-e1387ad33b30

---

## 결론 요약

| 질문 | 답 |
| --- | --- |
| 애니메이션을 정확히 캡처하려 한 사례가 있나 | **아주 많다.** 다만 전부 사람이 셀렉터·대기시간을 직접 지정하는 방식이고, 자동으로 판단하는 제품은 없다. |
| 무료와 유료를 가르는 가장 큰 차이 | **캡처 품질이 아니라 출력 형태(PDF·편집·일괄)와 처리량(수량·속도·안정성).** "제대로 찍히느냐"로 과금하는 곳은 없다. |
| 기술적으로 가능한가 | **기능 1·3은 확실히 가능(이미 표준 기능). 기능 2가 진짜 승부처이자 유일하게 비어 있는 자리.** |

---

## 1. 시중 도구 지형도

웹사이트 캡처는 하나의 시장이 아니라 목적이 다른 네 계층이다. 기획안이 경쟁 상대로
삼아야 하는 곳은 팀이 지금 쓰는 크롬 확장(계층 2)이 아니라 계층 3·4다.

### 계층 1 — 브라우저 내장
Chrome DevTools `Capture full size screenshot`, Edge 웹 캡처, Firefox 스크린샷.
무료·무설치. 지연 로딩과 스크롤 트리거를 전혀 처리하지 않는다. 크롬은 한 장에 담을 수
있는 세로 길이가 **16,384px**로 하드코딩되어 있어 요즘 랜딩 페이지는 잘려 나온다.

### 계층 2 — 크롬 확장 (팀의 현재 도구)
GoFullPage(약 1,100만 사용자), FireShot, Awesome Screenshot, Nimbus, CaptureX.
스크롤하며 여러 장을 찍어 이어 붙이는(stitching) 방식이라 무한 스크롤·sticky
헤더·iframe 구간에서 이미지가 비거나 중복된다.

애니메이션 대응 수단은 사실상 하나뿐 — FireShot의 **"캡처 전 대기 시간(Wait time
before capturing)"** 옵션. 즉 이 계층은 *기다리기*는 있지만 *판단하기*는 없다.
몇 초를 기다릴지는 매번 사람이 감으로 넣어야 한다.

### 계층 3 — 스크린샷 API (실제 벤치마크 대상)
ScreenshotOne, Urlbox, ApiFlash, ScreenshotAPI.net, ScreenshotCore, CustomJS, Microlink.
**기획안이 풀려는 문제를 이미 옵션 이름으로 갖고 있다.**

| 옵션 | 하는 일 | 기획안 대응 |
| --- | --- | --- |
| `full_page_scroll` / `lazy_load` | 찍기 전 페이지 끝까지 자동 스크롤해 지연 로딩·스크롤 애니메이션을 미리 발동 | 기능 1의 핵심 동작 = 이미 기본 옵션 |
| `full_page_scroll_delay` (기본 400) / `full_page_scroll_by` | 스크롤 속도·간격 조절 | 문서에 *"어떤 사이트는 400보다 큰 값이 있어야 지연 로딩 이미지가 뜬다"*고 명시 → **업계 1등도 이 값을 자동으로 못 정한다** |
| `reduced_motion` | `prefers-reduced-motion`을 켜 사이트가 스스로 애니메이션을 줄이게 함 | 기능 1 보조 |
| `freeze_fixed` (Urlbox) | 분할 촬영 시 sticky 헤더/푸터가 중간에 반복되는 문제 전용 | 기능 2의 "고정 메뉴바 숨김" = 이미 상용 기능 |
| `wait_for` / `wait_until` / `wait_for_selector` / `delay` | 특정 요소가 나타날 때까지 대기 | 기능 1 |
| `click` / `hover` / `scripts` / `hide_selectors` | 캡처 전 클릭·호버·커스텀 JS 실행 | **"마우스 올려야 나오는 요소" 캡처도 이미 상용화됨** (단 셀렉터는 사람이 지정) |
| `full_page_max_height` / `full_page_slices` (기본 4,000px) | 긴 페이지를 세로 슬라이스로 반환. 문서에 용도를 *"AI 분석 워크플로우용"*이라 명시 | 기능 2의 섹션 분할과 같은 발상 |

이 계층도 아직 어렵다는 증거: ScreenshotOne은 **2026년 5월**에야 "일부 사이트가 실제
콘텐츠보다 작은 scroll height를 보고해 이어 붙인 이미지가 상한을 넘는" 스티칭 버그를
고쳤다. 이 문제만 수년째 파온 팀도 여전히 다듬는 중이라는 뜻이다.

### 계층 4 — 비주얼 회귀 테스트 (검수 자동화의 선례)
Playwright, Applitools Eyes, Percy, BrowserStack.

- **Playwright `screenshot({ animations: 'disabled' })`** — 이번 조사에서 가장 중요한
  발견. CSS 애니메이션·트랜지션·Web Animations를 모두 멈추되 처리가 두 갈래다.
  *길이가 정해진 애니메이션은 완료 시점으로 빨리감기*(그래서 `transitionend`까지 정상
  발생), *무한 반복 애니메이션은 초기 상태로 되돌렸다가 캡처 후 재생*. 게다가 **이게
  기본값**이다. 기획안이 병목으로 지목한 "애니메이션의 처음과 끝을 인지하지 못함"은
  브라우저 자동화 레벨에서 이미 상당 부분 해결되어 있다.
- **Applitools `waitBeforeCapture`** — CSS 셀렉터가 나타나거나 사라질 때까지, 또는
  커스텀 async 함수(예: `.spinner`가 숨겨질 때까지 루프)가 끝날 때까지 대기.
- **Applitools Eyes / Percy** — 픽셀 대조가 아니라 UI 구조를 이해하는 AI 비교로 오탐을
  줄인다. 스피너·스켈레톤·GIF를 *"로딩 잔재(loading artifact)"*라는 별도 개념으로 다룬다.

### 접근법 네 가지와 성숙도

| 접근법 | 대표 구현 | 한계 | 성숙도 |
| --- | --- | --- | --- |
| ① 기다린다 | `delay` / `wait_until` / `wait_for_selector` | 몇 초를 기다릴지 사람이 정해야 함 | 성숙 |
| ② 미리 스크롤해 발동시킨다 | `full_page_scroll` / `lazy_load` | 속도·간격이 사이트마다 다름 | 성숙 |
| ③ 애니메이션을 강제 종료시킨다 | `animations:'disabled'` / `reduced_motion` | JS 캔버스·스크롤 연동 효과는 못 멈춤. **크롬 확장에는 이 수단이 아예 없음** | 성숙 |
| ④ 찍은 뒤 검사해 다시 찍는다 | Applitools Eyes / Percy | **기준 이미지(baseline)가 있어야만 동작.** 처음 보는 URL 한 장을 판정하는 제품은 사실상 없음 | **비어 있음** |

### 기획안에 대한 함의
- 차별점으로 적은 "호버·클릭 상태 캡처"는 **이미 상용 API에 있다.** 그대로 두면 실사용
  검증에서 바로 반박당한다.
- 실제로 비어 있는 자리는 둘: **(1) 셀렉터·대기시간의 자동 튜닝**(업계 1등도 문서에
  "값을 직접 찾아보라"고 적어 둔다), **(2) 기준 이미지 없는 단독 품질 판정.**

---

## 2. 무료 vs 유료

### 크롬 확장 계층

| 도구 | 무료판 | 유료판 | 가격 |
| --- | --- | --- | --- |
| GoFullPage | 전체 페이지 캡처, PNG/JPG, 워터마크·강제 가입 없음 | **PDF 내보내기**, 주석 도구 | 유료 티어 |
| FireShot | Lite — PNG 저장만 | **JPEG·PDF 내보내기, 여러 탭 일괄 캡처**, 내장 편집기, 공유 | $60 평생 / $7.95 월 |

**캡처 성능은 무료판과 유료판이 같다.** FireShot Pro를 산다고 애니메이션이 더 잘 찍히지
않는다. 유료선은 전부 결과물의 형태와 처리량에 그어져 있다.

### 스크린샷 API 계층

| 서비스 | 무료 티어 | 유료 시작가 | 1,000장당 |
| --- | --- | --- | --- |
| ScreenshotOne | 100장 / 월 | $17–19 / 2,000장 | 약 $8.50 |
| Urlbox | **없음** (7일 트라이얼) | $19 / 2,000장 | $6.60 → $3 (엔터프라이즈 $498+) |
| ApiFlash | 100장 / 월 | $16 / 1,000장 | 약 $16 → $4.90 |
| Microlink | 50 요청 / 일 | — | — |

무료 티어 공통 제약: 월 100–1,000장 상한, 낮은 rate limit, 우선 렌더링 없음, 출력 포맷
제한(PNG·JPEG), 경우에 따라 워터마크.

### 가장 큰 차이 — 한 문장

> **무료와 유료를 가르는 건 언제나 ① 결과물의 형태(PDF·편집·일괄)와 ② 처리량(수량·속도·안정성)이지, 캡처 정확도가 아니다.**

두 가지 의미가 있다.
- **좋은 쪽** — 정확도로 과금하는 경쟁자가 없으니 그 축은 비어 있다.
- **위험한 쪽** — 비어 있는 이유가 "아무도 그걸로는 돈을 안 내기 때문"일 수도 있다.

그리고 기능 3(IMG/PDF 선택 출력)은 남들이 이미 유료로 파는 바로 그 지점이므로, 무료로
제공하면 그 자체로 강한 진입 무기가 된다.

**원가 주의** — 캡처 1장의 원가는 브라우저 하나를 띄우는 비용이라 0이 될 수 없다(그래서
무제한 무료가 없다). 여기에 기능 2의 AI 검수를 얹으면 장당 비용이 상용 API보다 비싸질
수 있다. 기획안의 "값싼 규칙 검사로 먼저 거르고 애매한 것만 비전 모델에" 2단계 설계는
그래서 필수 구조다.

---

## 3. 기술 타당성

### 초등학생 눈높이 설명

1. **웹사이트는 아주 긴 두루마리 그림이에요.** 그런데 컴퓨터 화면은 그 위에 올려놓은
   작은 창문이라, 한 번에 조금밖에 못 봐요.
2. **사진기는 창문에 보이는 만큼만 찍을 수 있어요.** 그래서 창문을 조금씩 내리면서 여러
   장 찍고, 나중에 풀로 이어 붙여요.
3. **문제 하나 — 어떤 그림은 창문이 와야 그때부터 그려지기 시작해요.** 안 기다리고 찍으면
   회색 네모만 나와요.
4. **문제 둘 — 어떤 그림은 움직여요.** 움직이는 중에 찍으면 반쯤 나온 모습으로 찍혀요.
5. **문제 셋 — 맨 위 메뉴바는 창문에 딱 붙어서 따라와요.** 이어 붙이면 메뉴바가 세 번,
   네 번 나와요.
6. **문제 넷 — 사진기가 한 장에 담을 수 있는 길이가 정해져 있어요.** 노트북 화면 스무
   개쯤 되는 길이(16,384픽셀)를 넘으면 그냥 잘려요.

해결책도 단순하다. **천천히 스크롤을 내려서 그림이 다 그려지게 만들고 → 움직이는 그림은
"다 끝난 모습"으로 점프시키고 → 따라오는 메뉴바는 잠깐 숨기고 → 조각으로 나눠서 찍는다.**
이 네 가지는 브라우저를 대신 조종해 주는 프로그램(Playwright)에 이미 스위치로 들어
있고, "움직이는 그림 점프"는 켜는 게 기본값이다.

어려운 건 그 다음이다. **"이 사진, 제대로 찍혔나?"를 컴퓨터가 스스로 판단하는 일.**
사람은 한눈에 아는데, 컴퓨터 입장에서는 *원래 디자인이 하얀 여백인 것*과 *이미지가 안
나온 것*이 똑같이 하얗게 보이기 때문이다.

### 기능별 가능 여부

| 기획안 기능 | 가능? | 근거 | 난이도 |
| --- | --- | --- | --- |
| 기능 1 — 완전 렌더링 대기 후 캡처 | **확실히 가능** | 자동 스크롤·네트워크 대기·애니메이션 강제 종료가 모두 표준 기능. Playwright는 애니메이션 정지가 기본값 | ★★☆☆☆ |
| └ sticky 메뉴바 숨김 | **확실히 가능** | Urlbox `freeze_fixed`처럼 전용 옵션이 이미 상용화 | ★★☆☆☆ |
| └ 호버·클릭 요소 캡처 | **조건부** | 셀렉터를 지정하면 쉬움. 처음 보는 사이트에서 스스로 찾아내는 건 별개의 어려운 문제 → v1은 nav·드롭다운 등 알려진 패턴만 | ★★★★☆ |
| 기능 2 — AI 누락 판정 & 자동 재캡처 | **가능하나 이게 승부처** | 비전 모델에 "여기 비었나?"를 묻는 것 자체는 가능. 어려운 건 (a) 의도된 여백 vs 로딩 실패 구분 (b) 재캡처해도 같으면 무한 루프 (c) 장당 비용·지연. 재시도 상한(2회) + 신뢰도 임계값 + 사람 확인 플래그 필수 | ★★★★☆ |
| 기능 3 — 정렬 & IMG/PDF 출력 | **확실히 가능** | 가장 쉬움. 단 16,384px 상한 때문에 긴 페이지는 반드시 슬라이스(4,000px 단위 권장) 처리 | ★☆☆☆☆ |
| 확장 — 피그마 레이어 반출 | **별개 파이프라인** | 캡처(픽셀)와 레이어 반출(DOM 해석)은 완전히 다른 기술. html.to.design 등 선행 제품 존재(무료 30일 10회). 로드맵 후반으로 분리 권장 | ★★★★★ |

### 리스크

| 리스크 | 내용 | 대응 |
| --- | --- | --- |
| 봇 차단 | Cloudflare 등이 자동 브라우저를 막아 캡처 실패 | 상용 API가 "stealth mode"를 파는 이유. 자체 구축 시 비용에 반영 |
| 높이 상한 | 크롬이 한 장에 16,384px까지만 렌더링 | 슬라이스 → 병합 구조를 전제. 사이트가 잘못된 scroll height를 보고하는 경우까지 방어 |
| AI 오탐 | 정상 여백을 "누락"으로 판정해 무한 재캡처 | 신뢰도 임계값 + 재시도 상한 + 성공/실패 예시 세트로 기준 보정 |
| 권리 문제 | 타사 사이트를 편집 가능한 형태로 반출하는 것은 회색지대 | 사내 참고·자사 사이트로 용도 한정. 로그인 뒤 페이지는 별도 정책 |

---

## 4. 기획안에 반영할 것

1. **전체 기획 요약 — 차별점 문장**: "마우스를 올려야 나오는 요소를 다루지 않는다"는
   서술은 사실과 다르다. 차별점을 **"셀렉터·대기시간을 사람이 지정하지 않아도 되는 자동
   튜닝"** + **"기준 이미지 없는 단독 품질 판정"** 으로 다시 쓸 것.
2. **기능 1 — 완료 판정 기준**: "10–15초 타임아웃"은 안전장치로 유지하되, 완료 판정을
   시간이 아니라 조건의 조합으로 — ① 네트워크 유휴 ② 페이지 끝까지 스크롤 완료
   ③ 애니메이션 강제 종료 완료.
3. **기능 2 — 입력 정의**: 입력에 "섹션 슬라이스(4,000px 단위)"를 명시. 재캡처 좌표
   반환도 슬라이스 인덱스 + `offset_y` 형태가 자연스럽다.
4. **기능 3 — 가격 포지션**: IMG/PDF 선택 출력은 남들이 유료로 파는 기능이다. 사내
   도구라면 이 사실이 곧 "왜 사서 쓰지 않고 만드는가"의 답이고, 외부 판매라면 여기가 과금선.

---

## 출처

- [Playwright — Page.screenshot `animations` 옵션](https://playwright.dev/docs/api/class-page)
- [Playwright docs — screenshot params (finite/infinite 애니메이션 처리)](https://github.com/microsoft/playwright/blob/32095eac6a944a6d9eb38198f68a4cee9562b3b9/docs/src/api/params.md)
- [Playwright issue #19861 — lazy-load 페이지 풀페이지 캡처 문제](https://github.com/microsoft/playwright/issues/19861)
- [ScreenshotOne — Screenshot Options](https://screenshotone.com/docs/options/)
- [ScreenshotOne — 캡처 전 사이트 커스터마이즈](https://screenshotone.com/docs/guides/how-to-customize-any-website-before-screenshotting/)
- [ScreenshotOne changelog — 스티칭 최대 높이 버그 수정 (2026-05)](https://screenshotone.com/changelog/fixed-full-page-screenshot-stitching-max-height/)
- [Urlbox — Full page screenshots (skip_scroll, freeze_fixed)](https://urlbox.com/docs/screenshots/full-page-screenshots)
- [Urlbox — Render Options](https://urlbox.com/docs/options)
- [Urlbox — Pricing](https://urlbox.com/pricing)
- [ScreenshotAPI.net — lazy_load / block_ads / no_cookie_banners](https://www.screenshotapi.net/blog/urlbox-alternative-a-faster-and-more-affordable-screenshot-api-for-developers)
- [ScreenshotAPI — Lazy Loading & Delay](https://screenshotapi.net/docs/renderScreenshot/lazy-loading-and-delay)
- [5 Best Screenshot APIs for Developers in 2026](https://medium.com/codex/5-best-screenshot-apis-for-developers-in-2026-compared-4516d5f1eb81)
- [Best Screenshot API in 2026: An Honest Comparison](https://len.sh/blog/best-screenshot-api-2026/)
- [Screenshot API Pricing Compared (2026)](https://snap-render.com/blog/screenshot-api-pricing-compared)
- [Best Free Screenshot APIs in 2026 — 무료 티어 제약](https://screenshotapi.to/blog/best-free-screenshot-apis)
- [10 Best Screenshot Extensions for Chrome (Free & Paid)](https://tryhoverify.com/blog/10-best-screenshot-extensions-for-chrome-in-2025-free-paid/)
- [GoFullPage](https://gofullpage.com/)
- [FireShot — Wait time before capturing 옵션](https://resources.oreateai.com/resources/why-fireshot-is-still-the-only-chrome-extension-you-need-for-full-page-screenshots)
- [Best Full-Page Screenshot Extensions for Chrome (2026)](https://attentioninsight.com/best-full-page-screenshot-extensions-chrome/)
- [Applitools — Handling Animations and Loading Artifacts in Visual Testing](https://applitools.com/blog/handling-animations-and-loading-artifacts-in-visual-testing/)
- [Percy — AI Visual Testing Tools](https://percy.io/blog/ai-visual-testing-tools)
- [Puppeteer issue #359 — 크롬 16,384px 하드 리밋](https://github.com/puppeteer/puppeteer/issues/359)
- [Stack Overflow — Max height of 16,384px for headless Chrome screenshots](https://stackoverflow.com/questions/44599858/max-height-of-16-384px-for-headless-chrome-screenshots)
- [Stack Overflow — sticky navbar가 풀페이지 캡처 중간에 나타나는 문제](https://stackoverflow.com/questions/77896738/sticky-navbar-appears-in-middle-of-full-page-screenshot-using-puppeteer)
- [html.to.design — 웹사이트를 피그마 레이어로 반출](https://www.figma.com/community/plugin/1159123024924461424/html-to-design-by-divriots-import-websites-to-figma-designs-web-html-css)
- [CustomJS — 캡처 전 클릭·입력·로그인 자동화](https://www.customjs.space/blog/best-screenshot-api/)
- [AddScreenshots — hover 상태 캡처](https://www.addscreenshots.com/screenshot-hover-element)
