#!/usr/bin/env node
/**
 * selftest.mjs — 분류기가 실제로 작동하는지 고정한다.
 *
 * fixtures/ 의 각 페이지는 하나의 티어를 대표하도록 만들어졌다.
 * 분류 규칙을 고칠 때 이 테스트가 회귀를 잡아 준다.
 *
 *   npm run test:fixtures
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { probeSite, TIERS, VIEWPORT } from './probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8824;

const CASES = [
  { file: 't0-static.html', tier: 0, tags: [] },
  { file: 't1-reveal.html', tier: 1, tags: [] },
  // 실전 스캔에서 발견한 오분류를 고정한다: ScrollTrigger/Lenis/Swiper 가 있어도
  // 핀 고정이나 실행 중인 무한 애니메이션이 없으면 T1 이다.
  { file: 't1-scrolltrigger-nopin.html', tier: 1, tags: ['M'] },
  { file: 't2-loop.html', tier: 2, tags: [] },
  { file: 't3-scrolllinked.html', tier: 3, tags: ['S'] },
  { file: 't4-webgl.html', tier: 4, tags: [] },
  { file: 'gated.html', tier: null, gate: 'challenge', tags: ['G'] },
];

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

function serveFixtures() {
  const server = createServer(async (req, res) => {
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    if (name.includes('..')) { res.writeHead(400).end(); return; }
    try {
      const body = await readFile(join(HERE, 'fixtures', name));
      res.writeHead(200, { 'content-type': MIME[extname(name)] || 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const eqSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

async function main() {
  const server = await serveFixtures();
  const browser = await chromium.launch({
    args: ['--disable-dev-shm-usage'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
  });
  const context = await browser.newContext({ viewport: VIEWPORT, locale: 'ko-KR' });

  let failures = 0;
  for (const c of CASES) {
    const r = await probeSite(context, `http://127.0.0.1:${PORT}/${c.file}`);
    const errors = [];

    if (!r.ok) errors.push(`측정 실패: ${r.error}`);
    if (r.ok && (c.gate || null) !== (r.gate || null)) errors.push(`gate 기대 ${c.gate ?? '없음'} → 실제 ${r.gate ?? '없음'}`);
    if (r.ok && !c.gate && r.tier !== c.tier) {
      errors.push(`티어 기대 ${TIERS[c.tier].key} → 실제 ${r.tier === null ? '차단' : TIERS[r.tier].key}`);
    }
    if (r.ok && !eqSet(c.tags, r.tags || [])) errors.push(`태그 기대 [${c.tags}] → 실제 [${r.tags}]`);

    if (errors.length) {
      failures++;
      console.log(`FAIL  ${c.file}`);
      errors.forEach((e) => console.log(`        ${e}`));
      console.log(`        근거: ${(r.reasons || []).join(' / ')}`);
    } else {
      const label = c.gate ? `차단(${c.gate})` : TIERS[c.tier].key;
      console.log(`ok    ${c.file.padEnd(24)} ${label.padEnd(14)} ${(r.reasons || []).join(' / ')}`);
    }
  }

  await context.close();
  await browser.close();
  server.close();

  console.log(`\n${CASES.length - failures}/${CASES.length} 통과`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
