# 웹사이트 스냅샷 — 서버에 올려 어디서든 주소로 쓰기 위한 그릇.
#
#   docker build -t snapshot .
#   docker run -p 8890:8890 -e APP_PASSWORD=원하는비밀번호 -v $PWD/결과:/app/결과 snapshot
#
# Playwright 공식 이미지에 브랜드 크롬을 얹는다. 번들 크로미움에는 H.264·AAC 코덱이
# 없어 동영상이 플레이어 오류로 찍히는데, 크롬을 깔면 그 문제가 없다.
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright install chrome

COPY . .

ENV NODE_ENV=production
ENV PORT=8890
EXPOSE 8890

# 컨테이너 밖에서 들어오게 0.0.0.0 에 붙는다. 비밀번호(APP_PASSWORD)를 꼭 건다.
CMD ["node", "app.mjs", "--host", "0.0.0.0", "--out", "/app/결과"]
