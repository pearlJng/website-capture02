#!/bin/bash
# 웹사이트 스냅샷 — 맥에 한 번에 설치한다.
#
#   터미널에 아래 한 줄을 붙여 넣는다 (GitHub 저장소에 접근 권한이 있어야 한다):
#   bash <(curl -fsSL https://raw.githubusercontent.com/pearlJng/website-capture02/claude/website-snapshot-automation-wdjs4i/tools/capture-engine/install.sh)
#
# 하는 일: git·Node·크롬을 확인하고(없으면 설치 안내), 코드를 받고, 라이브러리를 깔고,
# 바탕화면에 "웹사이트 스냅샷.app" 을 만든다. 그 뒤로는 그 앱을 더블클릭하면 된다 (터미널 없이).
set -e
BRANCH="claude/website-snapshot-automation-wdjs4i"
REPO="${SNAPSHOT_REPO:-https://github.com/pearlJng/website-capture02.git}"
DIR="${SNAPSHOT_DIR:-$HOME/website-capture02}"
APP="$DIR/tools/capture-engine"

say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
fail() { printf "\n\033[31m%s\033[0m\n" "$1"; exit 1; }

say "① 필요한 것 확인"
if ! command -v git >/dev/null 2>&1; then
  echo "git 이 없습니다. 맥이 '명령어 라인 도구' 설치 창을 띄우면 '설치'를 누르고, 끝난 뒤 이 설치를 다시 실행해 주세요."
  xcode-select --install 2>/dev/null || true
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Node 가 없어 Homebrew 로 설치합니다…"; brew install node
  else
    echo "Node 가 없습니다. 브라우저에서 nodejs.org 를 열어 드립니다 — LTS 를 받아 설치한 뒤 이 설치를 다시 실행해 주세요."
    open "https://nodejs.org/" 2>/dev/null || true
    exit 1
  fi
fi
NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
[ "$NODE_MAJOR" -ge 18 ] || fail "Node 가 너무 오래됐습니다 ($(node -v)). nodejs.org 에서 LTS 를 받아 설치해 주세요."
echo "git $(git --version | awk '{print $3}') · node $(node -v) ✓"

say "② 코드 받기"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q origin "$BRANCH"
else
  git clone -q "$REPO" "$DIR"
  git -C "$DIR" checkout -q "$BRANCH"
fi
echo "$DIR ✓"

say "③ 라이브러리 설치"
cd "$APP"
npm install --no-audit --no-fund --loglevel=error
if [ -n "$SNAPSHOT_SKIP_CHROME" ] || [ -d "/Applications/Google Chrome.app" ]; then
  echo "크롬 있음 ✓"
else
  echo "크롬이 없어 설치합니다 (관리자 비밀번호를 물어볼 수 있습니다)…"
  npx playwright install chrome || echo "크롬 자동 설치가 안 되면 google.com/chrome 에서 받아 설치해 주세요. 없어도 동작은 하지만 동영상이 오류 화면으로 찍힙니다."
fi

say "④ 바탕화면에 앱 만들기"
mkdir -p "$HOME/Desktop"
node "$APP/macapp.mjs" || true
xattr -dr com.apple.quarantine "$HOME/Desktop/웹사이트 스냅샷.app" 2>/dev/null || true

say "설치 끝. 바탕화면의 '웹사이트 스냅샷' 앱을 더블클릭하면 브라우저에 열립니다 (터미널은 안 뜹니다)."
echo "(켤 때마다 최신 코드를 자동으로 받습니다. 끌 때는 앱 화면 오른쪽 위의 '앱 끄기')"
