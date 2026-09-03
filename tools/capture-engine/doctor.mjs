#!/usr/bin/env node
/**
 * doctor.mjs — 이 컴퓨터의 크로미움이 캡처를 견디는지 본다.
 *
 * 자체 테스트에서 브라우저가 통째로 죽었을 때, 원인이 특정 픽스처인지
 * 이 환경 전체인지 가르기 위한 도구다. 30초쯤 걸린다.
 *
 *   node doctor.mjs
 */
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { pickBrowser } from './browser.mjs';

const require = createRequire(import.meta.url);

const CASES = [
  ['빈 페이지', '<h1>hi</h1>'],
  ['긴 그라디언트 (1만px)', '<div style="height:10000px;background:linear-gradient(#f00,#00f)"></div>'],
  ['CSS 무한 애니메이션', `<style>@keyframes b{0%{background:#000}100%{background:#fff}}
     .x{height:600px;animation:b 300ms steps(2,jump-none) infinite}</style><div class=x></div>`],
  ['회전 변환', `<style>@keyframes s{to{transform:rotate(360deg)}}
     .y{width:200px;height:200px;background:linear-gradient(90deg,#f00 0 50%,#00f 50%);animation:s 1.1s linear infinite}</style><div class=y></div>`],
  ['conic-gradient', `<div style="width:300px;height:300px;background:conic-gradient(#f00,#00f,#f00)"></div>`],
  ['blur 필터', `<div style="width:300px;height:300px;background:#0f0;filter:blur(8px)"></div>`],
  ['캔버스 2D', `<canvas id=c width=800 height=400></canvas><script>
     const x=document.getElementById('c').getContext('2d');
     for(let i=0;i<200;i++){x.fillStyle='hsl('+Math.random()*360+',80%,50%)';x.fillRect(Math.random()*800,Math.random()*400,30,30)}
     <\/script>`],
  ['WebGL', `<canvas id=g width=400 height=300></canvas><script>
     const gl=document.getElementById('g').getContext('webgl');
     if(gl){gl.clearColor(0,.5,1,1);gl.clear(gl.COLOR_BUFFER_BIT)}
     <\/script>`],
  ['2배율 긴 페이지', '<div style="height:20000px;background:repeating-linear-gradient(#fff 0 500px,#eef 500px 1000px)"></div>', 2],
];

const line = (s) => console.log(s);

/** 한글은 터미널에서 두 칸을 먹는다. 그걸 세어서 채워야 표가 안 어긋난다. */
const width = (s) => [...s].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

async function main() {
  line('');
  line(`  Node          ${process.version}`);
  line(`  플랫폼        ${process.platform} ${process.arch}`);
  try {
    line(`  Playwright    ${require('playwright/package.json').version}`);
  } catch { line('  Playwright    (버전을 못 읽음)'); }
  const pick = await pickBrowser();
  line(`  쓸 브라우저   ${pick.name}`);
  try {
    line(`  번들 크로미움 ${chromium.executablePath()}`);
  } catch (e) { line(`  번들 크로미움 경로 없음 — ${e.message.split('\n')[0]}`); }
  line('');

  // 동영상 코덱 — 번들 크로미움에는 H.264·AAC 가 없다. 특허 때문이다.
  {
    const b = await chromium.launch({ args: ['--disable-dev-shm-usage'],
      ...(pick.channel ? { channel: pick.channel } : {}) });
    const p2 = await b.newPage();
    const c = await p2.evaluate(() => {
      const v = document.createElement('video');
      return {
        h264: !!v.canPlayType('video/mp4; codecs="avc1.42E01E"'),
        aac: !!document.createElement('audio').canPlayType('audio/mp4; codecs="mp4a.40.2"'),
        vp9: !!v.canPlayType('video/webm; codecs="vp9"'),
      };
    });
    await b.close();
    line(`  ${c.h264 ? '✓' : '✗'} ${pad('H.264 (MP4 비디오)', 24)}${c.h264 ? '재생 가능' : '없음 — 동영상이 플레이어 오류로 찍힙니다'}`);
    line(`  ${c.aac ? '✓' : '✗'} ${pad('AAC (오디오)', 24)}${c.aac ? '재생 가능' : '없음'}`);
    line(`  ${c.vp9 ? '✓' : '✗'} ${pad('VP9 (WebM 비디오)', 24)}${c.vp9 ? '재생 가능' : '없음'}`);
    if (!c.h264) {
      line('');
      line('    H.264 는 특허가 걸려 있어 브랜드 크롬에만 들어갑니다.');
      line('    크롬을 설치하면 자동으로 크롬을 써서 동영상이 정상으로 나옵니다.');
    }
    line('');
  }

  let deaths = 0;
  for (const [name, html, scale] of CASES) {
    let browser = null;
    const t0 = Date.now();
    try {
      browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: scale || 1,
      });
      await page.setContent(html);
      await page.waitForTimeout(700);
      const shot = await page.screenshot({ fullPage: true, timeout: 90000 });
      const h = shot.readUInt32BE(20);
      line(`  ✓ ${pad(name, 24)}${String(h).padStart(8)}px  ${((Date.now() - t0) / 1000).toFixed(1)}초`);
    } catch (e) {
      deaths++;
      line(`  ✗ ${pad(name, 24)}${e.message.split('\n')[0]}`);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  line('');
  if (deaths === 0) line('  전부 통과했습니다. 브라우저 자체는 멀쩡합니다.');
  else line(`  ${deaths}건 실패. 위에서 ✗ 표시된 것이 이 환경에서 크로미움을 넘어뜨리는 요소입니다.`);
  line('');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
