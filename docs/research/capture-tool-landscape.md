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

---

## 4. 리스크 네 가지, 자세히

네 리스크는 성격이 다르다. **R1·R2는 "발생 여부"가 아니라 "언제 만나느냐"** 의 문제이고 대응책이
정해져 있다. **R3은 이 서비스의 난이도 그 자체**이며, **R4는 v1 스코프를 어떻게 긋느냐로 대부분
사라진다.**

| # | 리스크 | 발생 가능성 | 영향 | 대응 성격 |
| --- | --- | --- | --- | --- |
| R1 | 봇 차단 | 사이트에 따라 높음 | 캡처 자체가 불가 | 스코프 한정 + 상태 분리 |
| R2 | 렌더링·높이 한계 | 긴 페이지에서 확정적 | 결과물 잘림 | 설계 전제 (슬라이스) |
| R3 | AI 오탐·비용 | 중간 | 무한 루프 / 원가 초과 | 구조 설계 (DOM 신호 + 2단계) |
| R4 | 권리·약관 | 사내 한정 시 낮음 | 법적 분쟁 | 스코프 명문화 |

### R1. 봇 차단 — 자동 브라우저라는 이유로 페이지를 아예 못 본다

**증상** — 캡처 결과가 실제 페이지가 아니라 "Checking your browser…" 확인 화면, 빈 페이지,
또는 403. 더 나쁜 건 그 다음이다: **기능 2의 AI 검수가 이걸 "로딩 실패"로 읽고 재캡처를
반복**하고, 반복 요청이 차단을 더 강하게 만든다.

**원인** — Cloudflare Bot Management는 한 가지 신호로 판정하지 않는다. `navigator.webdriver`
플래그, 플러그인 목록 결손, WebGL·Canvas 지문, 입력 패턴을 층으로 쌓아 본다. 기본 헤드리스
Chromium은 **페이지가 렌더링되기도 전에 챌린지를 받는다.** playwright-extra의 stealth 플러그인이
`navigator.webdriver`·플러그인 목록·WebGL 지문을 패치해 주지만, 2026년 기준 그것만으로는
통과하지 못한다.

**규모** — 실효성 있는 조합은 **레지덴셜 IP + 실제 기기 지문 + 사람 속도의 입력**이고, 이 조합이
Cloudflare Pro 기준 약 95% 통과라고 보고된다. 비용은 레지덴셜 프록시 약 **$4/GB**, Bright Data
Web Unlocker 기준 **1,000요청당 $2.49–$5.40**. 캡처 1장 원가가 $0.003–0.009인 걸 감안하면
**차단 우회는 캡처보다 비싸다.** 상용 스크린샷 API가 "stealth mode"를 별도 유료 기능으로 파는
이유가 이것이다.

**대응**
- **v1은 우회하지 않는다.** 자사·고객사 사이트와 공개 랜딩 페이지로 범위를 한정하면 이 리스크는
  거의 만나지 않는다.
- **차단을 "실패"와 분리해 감지한다.** 챌린지 페이지의 지문(타이틀 문구, `cf-chl` 계열 쿠키, 특정
  텍스트)을 규칙으로 잡아 **AI 검수에 넘기기 전에** 걸러내고, **절대 재캡처하지 않는다.**
- 넘어야 할 때는 자체 구현보다 stealth를 제공하는 API를 백엔드로 쓰는 편이 총비용이 낮다. 직접
  만들면 지문 패치를 계속 따라가야 한다.

**기획안 반영** — 기능 2의 판정 결과에 "정상 / 이상" 외에 **"차단됨"** 상태를 추가할 것. 이 상태가
없으면 재캡처 루프가 차단 사이트에서 무한히 돈다.

### R2. 렌더링·높이 한계 — 길면 잘리고, 선명하게 찍으면 더 짧은 데서 잘린다

**증상** — 이미지가 특정 높이에서 뚝 잘린다. 또는 이어 붙인 이미지가 지정한 최대 높이를 넘어
나온다. 고해상도(2배율)로 찍으면 **더 짧은 페이지에서도** 잘린다.

**원인** — 16,384px는 임의로 정한 숫자가 아니라 **컴포지터의 최대 텍스처 크기**다. GL 백엔드에서
읽어오는 값이라 크롬 옵션으로 늘릴 수 없다. `--disable-gpu`로 소프트웨어 렌더링을 강제하면 그
상수를 키울 수는 있지만 **WebGL과 GL이 필요한 CSS가 깨진다** — 애니메이션을 정확히 찍는 게 목적인
서비스에는 자해에 가깝다. 그리고 **2배율로 찍으면 실질 한계가 CSS 픽셀 기준 8,192px로
반토막**난다.

**추가 함정** — 일부 사이트는 **실제 콘텐츠보다 작은 scroll height를 보고한다.** ScreenshotOne이
2026년 5월에 고친 버그가 정확히 이 케이스였다. 사이트가 알려준 높이를 믿고 자르면 상한을 넘긴
이미지가 그대로 빠져나간다. **이어 붙인 이미지의 실제 높이로 다시 확인**해야 한다.

**대응**
- 슬라이스(4,000px 권장) → 병합을 **예외 처리가 아니라 기본 구조**로 둔다.
- 최대 높이 상한을 두어 무한 스크롤 페이지를 방어한다.
- 해상도 배율을 사용자 선택으로 두지 말고 **페이지 길이에 따라 자동 강등**(길면 1배율)한다.
  사용자가 "고화질"을 고른 탓에 결과가 잘리는 건 최악의 UX다.

**기획안 반영** — 기능 3의 동작 방식에 **"해상도 배율 × 페이지 길이 = 잘림"** 관계를 명시할 것.
한편 PDF 출력은 오히려 유리하다 — 슬라이스를 그대로 페이지로 나누면 되므로, **긴 페이지에서는
PDF가 IMG보다 자연스러운 기본값**이다.

### R3. AI 오탐 — 원래 하얀 것과 안 나온 것을 픽셀만으로는 구분할 수 없다

**증상** — 양방향으로 틀린다. **오탐**: 원래 여백인 섹션을 "누락"으로 판정해 재캡처하고, 같은
결과가 나오고, 다시 재캡처한다. **미탐**: 진짜 깨진 이미지를 정상으로 통과시킨다. 임계값을 낮추면
오탐이 늘고 높이면 미탐이 늘어서, **둘 중 하나만 고를 수 있다.**

**원인** — 모델 성능 문제가 아니다. **"의도된 여백"과 "로딩 실패"는 픽셀 상으로 같은 흰색**이라,
이미지만 보고는 원리적으로 판정할 수 없는 케이스가 반드시 남는다.

**핵심 대응** — **판정을 이미지에만 맡기지 말 것.** 캡처하는 쪽은 DOM을 함께 볼 수 있다: 그 영역에
`<img>`가 있는데 `naturalWidth === 0`인지, `background-image`가 걸려 있는데 로드에 실패했는지,
요소는 있는데 `opacity:0`이나 초기 `transform` 상태로 멈춰 있는지. 이 신호를 근거로 붙이면 **같은
흰색이라도 "여기엔 원래 무언가 있어야 한다"를 확정**할 수 있다.

**그리고 이것이 이 기획안의 진짜 기술적 해자다.** 완성된 이미지만 보고 판정하는 건 누구나 할 수
있지만, **DOM 신호와 픽셀을 합치는 건 캡처를 직접 수행하는 쪽만 할 수 있다.** 외부 API를 쓰는
경쟁자는 구조적으로 따라올 수 없다.

**비용·지연** — 수치로 확인된다. Claude 비전은 **28×28px 패치** 단위로 과금한다
(`⌈w/28⌉ × ⌈h/28⌉` 토큰).

| 방식 | 슬라이스당 토큰 | 슬라이스당 | 3슬라이스 페이지당 |
| --- | --- | --- | --- |
| 상위 모델 전량 검수 (Opus 5, 고해상도 티어 $5/1M) | 약 2,760 (824×2,576으로 축소) | 약 $0.014 | 약 **$0.04** |
| 경량 모델 1차 필터 (Haiku 4.5, 표준 티어 $1/1M) | 약 1,000 | 약 $0.001 | 약 **$0.003** |

상용 스크린샷 API가 장당 $0.0085인 걸 감안하면 — **전부 상위 모델로 검수하면 캡처 원가의 약 5배,
2단계로 나누면 비슷한 수준으로 유지된다.** 기획안이 이미 적어 둔 "값싼 검사로 먼저 거르고 애매한
것만 비전 모델" 설계는 취향이 아니라 **원가 구조상 필수**임이 숫자로 확인된다.

**안전장치** — 재시도 상한 2회, 3회째는 사람에게 넘긴다. 그리고 **넘어간 케이스를 모으는 것 자체가
자산**이다 — 성공/실패 예시 세트가 쌓여야 임계값을 근거 있게 조정할 수 있다.

**기획안 반영** — 기능 2의 출력을 "정상 / 이상" 이분법에서 **정상 · 재캡처 필요 · 차단됨 ·
확인 필요(사람)** 네 상태로 바꿀 것. 그리고 입력에 **DOM 신호**를 추가할 것 — 현재 기획안은 입력이
"이미지 + 실패 패턴 예시"뿐이라, 가장 강력한 근거를 스스로 버리고 있다.

### R4. 권리·약관 — 갈리는 지점은 "크롤링했는가"가 아니라 "무임승차했는가"

**판례 A — 잡코리아 vs 사람인**: 채용공고를 크롤링해 자사 사이트에 게재. 저작권법상 **데이터베이스
제작자 권리 침해**가 인정되어, 2심에서 손해배상 2억 5천만원과 간접강제금을 합해 **4억 5천만원**
지급 판결.

**판례 B — 야놀자 vs 여기어때** (대법원 2022. 5. 12. 선고 2021도1533): 경쟁사 앱의 API 호출을
흉내내 숙박정보를 수집. **정보통신망법 위반·컴퓨터등장애업무방해·저작권법 위반 모두 무죄 확정.**
이유는 두 가지 — (a) 50개 항목 중 3–8개만 가져갔고, (b) 이미 상당히 알려진 정보라 수집에 상당한
비용이나 노력이 든다고 보기 어렵다.

**읽는 법** — 두 판결이 갈린 지점은 **"크롤링을 했느냐"가 아니라 "상대의 투자에 무임승차해
실질적으로 대체했느냐"**다. 화면을 이미지로 찍어 사내 참고자료로 쓰는 것과, 남의 DB를 복제해 경쟁
서비스에 얹는 것은 **법적으로 전혀 다른 자리**에 있다. 이 서비스의 기본 용도는 명백히 전자다.

**별도 축 두 가지**
- **robots.txt는 법적 구속력이 없는 권고**다. 다만 이용약관에 크롤링 금지가 명시돼 있으면
  "운영자 의사에 반한 접근"의 근거가 된다.
- **정보통신망법 제48조**(정당한 접근권한 없이 또는 허용된 권한을 넘어 침입 금지)는 **5년 이하
  징역 또는 5천만원 이하 벌금**이다. 야놀자 사건에서 무죄가 난 건 접근권한 제한이 객관적으로
  드러나지 않았기 때문 — 뒤집어 말하면 **로그인·인증을 자동으로 우회하는 순간 성격이 완전히
  달라진다.**

**대응**
- v1 스코프를 **공개 페이지 + 자사·고객사 사이트**로 명문화한다.
- 로그인 뒤 페이지는 **사용자가 자기 계정으로 직접 로그인한 세션**만 허용하고, 자동 우회는 기능으로
  만들지 않는다.
- 산출물 용도를 **사내 참고·제안서·아카이브**로 한정한다.
- **피그마 레이어 반출은 이 축의 리스크가 캡처보다 확실히 높다** — 원본 저작물의 표현을 편집 가능한
  형태로 그대로 옮기는 일이기 때문이다. 로드맵 후반으로 분리한 판단이 기술적으로만이 아니라
  법적으로도 옳다.

**기획안 반영** — 「범위 선정 이유」의 **비즈니스 확장성** 항목에 **"자사·고객사 자산 한정"** 단서를
달아둘 것. 지금 문장은 "산출물이 편집 가능한 재료가 된다"까지만 적혀 있어, 대상 사이트에 대한
전제가 비어 있다.

---

## 5. 기획안에 반영할 것

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
- [Claude 비전 — 이미지 토큰 계산(28×28 패치)과 해상도 티어별 비용](https://platform.claude.com/docs/en/build-with-claude/vision)
- [BrowserStack — Playwright로 Cloudflare를 통과하는 법](https://www.browserstack.com/guide/playwright-cloudflare)
- [Playwright Bot Detection: What Actually Works in 2026](https://alterlab.io/blog/playwright-bot-detection-what-actually-works-in-2026)
- [Playwright Cloudflare Bypass 2026 — 통과율과 프록시 단가](https://humanbrowser.cloud/blog/bypass-cloudflare-playwright-2026)
- [Scrapfly — Cloudflare 보호 사이트 스크린샷](https://scrapfly.io/blog/posts/how-to-screenshot-cloudflare-protected-websites)
- [Chromium issue 41347676 — 16,384px보다 큰 스크린샷 허용 요청](https://issues.chromium.org/issues/41347676)
- [Chromium headless-dev — 16,384px는 컴포지터 최대 텍스처 크기](https://groups.google.com/a/chromium.org/g/headless-dev/c/DqaAEXyzvR0)
- [법률신문 — 대법원 2022. 5. 12. 선고 2021도1533(야놀자 v. 여기어때) 검토](https://www.lawtimes.co.kr/news/articleView.html?idxno=182087)
- [CaseNote — 대법원 2021도1533 판결문](https://casenote.kr/%EB%8C%80%EB%B2%95%EC%9B%90/2021%EB%8F%841533)
- [한경 — 무단 크롤링으로 야놀자 정보 빼간 여기어때](https://magazine.hankyung.com/business/article/202108256209b)
- [한경 긱스 — 여기어때 사건으로 살펴본 크롤링의 적법성](https://www.hankyung.com/article/202404242738i)
- [정보통신망법 제48조 — 정보통신망 침해행위 등의 금지](https://casenote.kr/%EB%B2%95%EB%A0%B9/%EC%A0%95%EB%B3%B4%ED%86%B5%EC%8B%A0%EB%A7%9D_%EC%9D%B4%EC%9A%A9%EC%B4%89%EC%A7%84_%EB%B0%8F_%EC%A0%95%EB%B3%B4%EB%B3%B4%ED%98%B8_%EB%93%B1%EC%97%90_%EA%B4%80%ED%95%9C_%EB%B2%95%EB%A5%A0/%EC%A0%9C48%EC%A1%B0)
- [데이터 크롤링의 한국법상 허용기준](https://www.mondaq.com/copyright/1266554/)
