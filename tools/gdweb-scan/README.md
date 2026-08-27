# gdweb-scan — 웹사이트 캡처 난이도 스캐너

웹사이트를 실제로 열어 **"우리 캡처 도구로 찍을 수 있는가"** 를 측정하고 T0~T4로 분류합니다.
사람이 눈으로 보고 판단하지 않고, 브라우저 안에서 관측 가능한 신호만 셉니다.

## 왜 만들었나

"이 사이트는 애니메이션이 많다"는 감각적 분류로는 캡처 범위를 정할 수 없습니다.
캡처를 실패시키는 원인은 **애니메이션의 화려함이 아니라 종류**이기 때문입니다.
스크롤하면 나타나는 애니메이션(T1)은 끝 상태가 있어서 쉽고, 스크롤 위치가 곧 재생
시점인 애니메이션(T3)은 풀페이지 캡처라는 개념 자체를 깨뜨립니다. 둘은 보기엔 비슷하지만
캡처 난이도는 정반대입니다.

## 실행

처음이라면 이 순서대로 하면 됩니다. 터미널(맥: 터미널 / 윈도우: PowerShell)에서 실행합니다.

```bash
# 0) Node.js가 있는지 확인. 없으면 nodejs.org 에서 LTS 설치
node -v

# 1) 코드 받기 (처음 한 번만)
git clone https://github.com/pearlJng/website-capture02.git
cd website-capture02
git checkout claude/website-snapshot-automation-wdjs4i

# 2) 준비 (처음 한 번만)
cd tools/gdweb-scan
npm install
npx playwright install chromium

# 3) 실행 — GDWEB 선정작 50건
npm run scan -- --urls urls.gdweb-2026.txt --concurrency 4
```

**`--urls` 뒤에는 URL이 아니라 "URL이 적힌 파일 이름"이 들어갑니다.**
`urls.gdweb-2026.txt` 에 이미 50건이 들어 있으므로 URL을 직접 입력할 필요는 없습니다.
다른 사이트를 넣고 싶으면 그 파일을 텍스트 편집기로 열어 한 줄에 하나씩 적으면 됩니다.

먼저 목록만 확인하고 싶다면(네트워크 접속 없이 파싱만):

```bash
npm run scan -- --urls urls.gdweb-2026.txt --dry-run
```

GDWEB 목록 페이지에서 사이트를 자동으로 뽑아 스캔할 수도 있습니다.

```bash
npm run scan -- --list "https://www.gdweb.co.kr/sub/list.asp?...&Page=1" \
                --pages 1-3 --limit 60 --concurrency 4
```

### 옵션

| 옵션 | 값 | 설명 |
| --- | --- | --- |
| `--urls` | 파일 경로 | URL 목록 파일 (한 줄에 `URL[탭 또는 공백]이름`) |
| `--list` | GDWEB 목록 URL | 목록에서 사이트를 자동 추출 |
| `--pages` | `1` / `1-3` | `--list` 사용 시 훑을 목록 쪽수 |
| `--limit` | 숫자 (기본 60) | 최대 측정 건수 |
| `--concurrency` | 숫자 (기본 4) | 동시 실행 수. 올리면 빨라지지만 메모리를 더 씁니다 |
| `--dry-run` | (값 없음) | 측정하지 않고 목록 파싱만 확인 |

`urls.txt` 형식 — URL 뒤에 이름을 붙일 수 있습니다.

```
https://example.com    예시 사이트
https://another.co.kr  다른 사이트
```

산출물

| 파일 | 내용 |
| --- | --- |
| `results.csv` | 스프레드시트에 바로 붙이는 표 (엑셀 한글 깨짐 방지용 BOM 포함) |
| `report.html` | 브라우저로 여는 분류 결과 |
| `results.json` | 사이트별 원 신호 + 티어 + 판정 근거(`evidence`) |

50건 기준 동시 4개로 대략 4~6분 걸립니다.

브라우저 경로가 다른 환경이면 `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium` 으로 지정합니다.

## 분류 체계

### 티어 — 캡처 엔진이 무엇을 해야 하는가

| 티어 | 이름 | 정의 | v1 커버 |
| --- | --- | --- | --- |
| **T0** | 정적 | 스크롤만 하면 전부 보인다 | ✅ |
| **T1** | 등장형 | 스크롤하면 나타난다. **끝 상태가 명확히 있다** | ✅ |
| **T2** | 순환형 | 계속 움직인다. **끝이 없다** | ⚠️ 판정 기준 별도 필요 |
| **T3** | 스크롤 연동형 | 스크롤 위치가 곧 타임라인. **풀페이지 개념이 성립하지 않는다** | ❌ 별도 모드 |
| **T4** | 실시간 렌더형 | 매 프레임 다시 그린다. **결정론적 캡처 불가** | ❌ |

티어는 **가장 높은 신호를 따릅니다.** 등장 애니메이션과 WebGL 배경이 함께 있으면 T4입니다.
캡처 파이프라인이 감당해야 하는 난이도는 가장 어려운 요소가 결정하기 때문입니다.

### 태그 — 티어와 직교하는 부가 조건

| 태그 | 의미 | 캡처에 미치는 영향 |
| --- | --- | --- |
| **G** | Gated — 봇 차단·인증 화면 | 캡처 자체가 불가. **재캡처하면 안 된다** |
| **S** | Sticky — 고정 헤더·플로팅 버튼 | 이어 붙일 때 중복 등장 |
| **L** | Long — 문서 높이가 한계에 근접 | 16,384px 초과 시 잘림 |
| **H** | Hidden — 호버·클릭해야 보이는 콘텐츠 | 그냥 찍으면 누락 |

## 무엇을 측정하는가

| 신호 | 측정 방법 | 판정에 쓰이는 곳 |
| --- | --- | --- |
| IntersectionObserver 생성 횟수 | 생성자를 페이지 스크립트보다 먼저 후킹 | T1 |
| 지연 로딩 이미지 | `img[loading=lazy]`, `[data-src]` 등 | T1 |
| 등장 대기 요소 | `opacity:0` 또는 `transform`이 걸린 채 문서에 있는 요소 | T1 |
| 무한 반복 애니메이션 | `document.getAnimations()` 중 `iterations === Infinity` | T2 |
| `infinite` 키프레임 규칙 | 동일 출처 스타일시트 정적 분석 | T2 |
| 자동재생·루프 비디오 | `video[autoplay]`, `video[loop]` | T2 |
| 핀 고정 섹션 | 뷰포트 2배 이상 높은 부모 안의 `position:sticky` | T3 |
| 가로 스크롤 섹션 | `overflow-x:auto\|scroll` + `scrollWidth` 초과 | T3 |
| 스크롤 탈취 | 세로축 잠김 + 문서 비스크롤 + 내부 스크롤러 존재 | T3 |
| WebGL 컨텍스트 | `canvas.getContext('webgl')` 후킹 | T4 |
| 유휴 rAF 빈도 | `requestAnimationFrame` 후킹 후 1초간 호출 수 | T4 |
| 라이브러리 | `window.*` 전역 + `<script src>` 패턴 | T1~T4 |

### 오분류를 피하려고 일부러 배제한 것

- **`overflow-x: hidden`을 스크롤 컨테이너로 세지 않습니다.** 가로 스크롤바를 없애려고
  거의 모든 사이트가 `body`에 쓰는 관용구라, 그대로 세면 평범한 사이트가 대량으로
  T3(스크롤 연동형)로 오분류됩니다. 자체 테스트에서 실제로 잡힌 버그입니다.
- **스크롤 탈취**는 세로축이 잠겨 있고, 문서 자체가 스크롤되지 않으며, 내부에 실제
  스크롤 컨테이너가 있을 때만 인정합니다. 세 조건을 모두 요구합니다.

## 판정 근거를 남기는 이유

모든 결과에 `reasons`(사람이 읽는 근거)와 `evidence`(원 신호)가 함께 저장됩니다.
분류가 이상해 보이면 신호를 직접 확인해 규칙을 고칠 수 있어야 합니다.
"AI가 그렇다더라"로 끝나는 결과는 만들지 않습니다.

## 테스트

```bash
npm run test:fixtures
```

`fixtures/` 의 페이지 6개는 각각 하나의 티어를 대표하도록 만들어졌습니다.
분류 규칙을 고칠 때 이 테스트가 회귀를 잡습니다.

```
ok    t0-static.html           T0             특별한 동적 신호 없음
ok    t1-reveal.html           T1             지연 로딩 이미지 2개 / 등장 대기 요소 4개 / IntersectionObserver 3회 생성
ok    t2-loop.html             T2             무한 반복 애니메이션 2개 / infinite 키프레임 규칙 2건 / 자동재생·루프 비디오 1개
ok    t3-scrolllinked.html     T3             핀 고정 섹션 1개 / 가로 스크롤 섹션 1개
ok    t4-webgl.html            T4             WebGL 컨텍스트 1개 / 유휴 상태에서도 rAF 59회/초 + 대형 canvas
ok    gated.html               차단(challenge)  특별한 동적 신호 없음
```

## 한계

- **동일 출처 스타일시트만 읽을 수 있습니다.** CDN에 올린 CSS는 `cssRules` 접근이
  차단되어 `infinite` 키프레임과 `:hover` 규칙을 놓칩니다. `readableSheets` 필드로
  얼마나 읽었는지 확인할 수 있습니다.
- **호버 전용 콘텐츠(H 태그)는 근사치입니다.** 실제로 호버해 보지 않고 CSS 규칙 수로
  추정합니다.
- 뷰포트는 1440×900 데스크톱 고정입니다. 모바일 분류가 필요하면 `VIEWPORT`를 바꿔
  두 번 돌려야 합니다.
