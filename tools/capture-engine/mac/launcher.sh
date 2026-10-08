#!/bin/bash
# 웹사이트 스냅샷.app 의 실행 파일. 터미널 없이 돈다:
# 최신 코드를 받고 → 앱(node app.mjs)을 뒤에서 켜고 → 브라우저를 연다.
# 이미 최신 코드로 켜져 있으면 브라우저만 연다. 예전 코드로 켜져 있으면 끄고 새로 켠다(캡처 중이면 그대로 둔다).
# 설치 자리는 첫 인자로 받는다(앱이 넘겨 준다). 없으면 이 파일이 있는 저장소(…/capture-engine).
APP="${1:-__APP_DIR__}"
case "$APP" in __APP_""DIR__) APP="$(cd "$(dirname "$0")/.." && pwd)";; esac
BRANCH="claude/website-snapshot-automation-wdjs4i"
PORT=8890
URL="http://127.0.0.1:$PORT/"
LOGDIR="$HOME/Library/Logs"; mkdir -p "$LOGDIR" 2>/dev/null
LOG="$LOGDIR/웹사이트 스냅샷.log"
TITLE="웹사이트 스냅샷"

notify() { osascript -e "display notification \"$1\" with title \"$TITLE\"" >/dev/null 2>&1; }
alert() { osascript -e "display alert \"$TITLE\" message \"$1\"" >/dev/null 2>&1; }
up() { curl -s -o /dev/null --max-time 2 "$URL"; }
listeners() { lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null; }

# 앱으로 켜면 터미널의 PATH(홈브루·nvm 의 node)가 없다 — 로그인 셸에서 받아 오고, 흔한 자리도 더한다
for p in /opt/homebrew/bin /usr/local/bin "$HOME"/.nvm/versions/node/*/bin "$HOME/.volta/bin" "$HOME/.local/bin"; do
  [ -d "$p" ] && PATH="$p:$PATH"
done
LP=$(perl -e 'alarm 6; exec @ARGV' /bin/zsh -ilc 'printf "\n__PATH__%s" "$PATH"' 2>/dev/null | sed -n 's/^__PATH__//p' | tail -n1)
[ -n "$LP" ] && PATH="$LP:$PATH"
export PATH

{ echo; echo "── $(date '+%Y-%m-%d %H:%M:%S') 켜기"; } >>"$LOG"
cd "$APP" 2>/dev/null || { alert "설치 폴더($APP)를 찾지 못했습니다. 설치를 다시 해 주세요."; exit 1; }
command -v node >/dev/null 2>&1 || { alert "Node 를 찾지 못했습니다. nodejs.org 에서 LTS 를 설치한 뒤 다시 눌러 주세요."; open "https://nodejs.org/"; exit 1; }

( git fetch -q origin "$BRANCH" && git checkout -q "$BRANCH" && git pull -q origin "$BRANCH" ) >>"$LOG" 2>&1 \
  || echo "(최신 코드를 받지 못해 지금 있는 코드로 켭니다)" >>"$LOG"
HEAD=$(git rev-parse HEAD 2>/dev/null)

if up; then
  INFO=$(curl -s --max-time 2 "${URL}api/version")
  RUN=$(printf '%s' "$INFO" | sed -n 's/.*"head":"\([0-9a-f]*\)".*/\1/p')
  if [ -n "$RUN" ] && [ "$RUN" = "$HEAD" ]; then open "$URL"; exit 0; fi
  if printf '%s' "$INFO" | grep -q '"busy":true'; then
    open "$URL"; notify "지금 캡처 중이라 새 코드로 바꾸지 않았습니다. 끝난 뒤 다시 누르면 바뀝니다."; exit 0
  fi
  echo "예전 코드로 켜져 있는 앱을 끕니다" >>"$LOG"
  for PID in $(listeners); do ps -p "$PID" -o command= | grep -q 'app.mjs' && kill "$PID" 2>/dev/null; done
  for _ in 1 2 3 4 5 6 7 8 9 10; do up || break; sleep 0.5; done
  if up; then for PID in $(listeners); do ps -p "$PID" -o command= | grep -q 'app.mjs' && kill -9 "$PID" 2>/dev/null; done; sleep 1; fi
  if up; then alert "$PORT 번 자리를 다른 프로그램이 쓰고 있어 켜지 못했습니다. 컴퓨터를 다시 켠 뒤 눌러 주세요."; exit 1; fi
fi

notify "켜는 중입니다… 잠시 뒤 브라우저가 열립니다."
npm install --no-audit --no-fund --loglevel=error >>"$LOG" 2>&1 || echo "(라이브러리 확인을 건너뜁니다)" >>"$LOG"
# 뒤에서 켠다 — 이 실행 파일이 끝나도 앱은 계속 돈다. 브라우저는 앱이 켜지면서 스스로 연다.
nohup node app.mjs >>"$LOG" 2>&1 &
for _ in $(seq 1 60); do up && exit 0; sleep 0.5; done
alert "앱이 30초 안에 켜지지 않았습니다. 기록 파일을 보내 주세요: ~/Library/Logs/웹사이트 스냅샷.log"
open -R "$LOG" 2>/dev/null
exit 1
