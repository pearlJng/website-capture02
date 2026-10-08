#!/bin/bash
# 웹사이트 스냅샷 실행 파일 — 더블클릭하면 최신 코드를 받고 앱을 켠 뒤 브라우저를 연다.
# 예전 코드로 켜져 있는 앱이 있으면 끄고 새로 켠다 (캡처 중이면 건드리지 않는다).
DIR="$HOME/website-capture02"
APP="$DIR/tools/capture-engine"
BRANCH="claude/website-snapshot-automation-wdjs4i"
PORT=8890
URL="http://127.0.0.1:$PORT/"
cd "$APP" 2>/dev/null || { echo "설치가 안 되어 있습니다. install.sh 를 먼저 실행해 주세요."; read -r -p "닫으려면 Enter"; exit 1; }

echo "최신 코드 확인 중…"
( git fetch -q origin "$BRANCH" && git checkout -q "$BRANCH" && git pull -q origin "$BRANCH" ) 2>/dev/null \
  || echo "(인터넷이 안 되거나 받지 못해 지금 있는 코드로 켭니다)"
HEAD=$(git rev-parse HEAD 2>/dev/null)

listeners() { lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null; }
up() { curl -s -o /dev/null --max-time 2 "$URL"; }

if up; then
  INFO=$(curl -s --max-time 2 "${URL}api/version")
  RUN=$(printf '%s' "$INFO" | sed -n 's/.*"head":"\([0-9a-f]*\)".*/\1/p')
  if [ -n "$RUN" ] && [ "$RUN" = "$HEAD" ]; then
    open "$URL"; echo "이미 최신 코드로 켜져 있어 브라우저만 열었습니다."; sleep 2; exit 0
  fi
  if printf '%s' "$INFO" | grep -q '"busy":true'; then
    open "$URL"
    echo "켜져 있는 앱이 지금 캡처 중이라 그대로 둡니다. 캡처가 끝나면 다시 더블클릭해 주세요 — 그때 새 코드로 바꿉니다."
    read -r -p "닫으려면 Enter"; exit 0
  fi
  echo "예전 코드로 켜져 있는 앱을 끄고 새로 켭니다…"
  for PID in $(listeners); do ps -p "$PID" -o command= | grep -q 'app.mjs' && kill "$PID" 2>/dev/null; done
  for _ in 1 2 3 4 5 6 7 8 9 10; do up || break; sleep 0.5; done
  if up; then
    for PID in $(listeners); do ps -p "$PID" -o command= | grep -q 'app.mjs' && kill -9 "$PID" 2>/dev/null; done
    sleep 1
  fi
  if up; then
    echo "$PORT 번 자리를 다른 프로그램이 쓰고 있어 켜지 못했습니다. 컴퓨터를 다시 켠 뒤 더블클릭해 주세요."
    read -r -p "닫으려면 Enter"; exit 1
  fi
fi

npm install --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || echo "(라이브러리 확인을 건너뜁니다)"
echo "앱을 켭니다. 이 창은 닫지 말고 두세요 — 끄려면 Ctrl+C"
node app.mjs
