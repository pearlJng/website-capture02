#!/bin/bash
# 웹사이트 스냅샷 실행 파일 — 더블클릭하면 최신 코드를 받고 앱을 켠 뒤 브라우저를 연다.
DIR="$HOME/website-capture02"
APP="$DIR/tools/capture-engine"
BRANCH="claude/website-snapshot-automation-wdjs4i"
PORT=8890
cd "$APP" 2>/dev/null || { echo "설치가 안 되어 있습니다. install.sh 를 먼저 실행해 주세요."; read -r -p "닫으려면 Enter"; exit 1; }
# 이미 켜져 있으면 브라우저만 연다
if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
  open "http://127.0.0.1:$PORT/"; echo "이미 켜져 있어 브라우저만 열었습니다."; sleep 2; exit 0
fi
echo "최신 코드 확인 중…"
( git fetch -q origin "$BRANCH" 2>/dev/null && git checkout -q "$BRANCH" 2>/dev/null && git pull -q origin "$BRANCH" 2>/dev/null \
  && npm install --no-audit --no-fund --loglevel=error 2>/dev/null ) || echo "(인터넷이 안 되거나 받지 못해 지금 있는 코드로 켭니다)"
echo "앱을 켭니다. 이 창은 닫지 말고 두세요 — 끄려면 Ctrl+C"
node app.mjs
