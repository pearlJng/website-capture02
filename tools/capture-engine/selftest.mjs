#!/usr/bin/env node
/**
 * selftest.mjs — 캡처 파이프라인과 채점기가 실제로 작동하는지 고정한다.
 *
 * fixtures/ 의 각 페이지는 실측이 지목한 문제 하나씩을 재현한다.
 * "단계를 켜기 전에는 실패하고, 켜면 통과한다"를 검사한다 — 단계가
 * 진짜로 일을 하는지 확인하지 않으면 성적표를 믿을 수 없다.
 *
 *   npm test
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { captureSite, VIEWPORT, SAFE_PIXELS } from './capture.mjs';
import { compareCaptures, VERDICT } from './diff.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8825;
const BASE = `http://127.0.0.1:${PORT}/`;

const same = (v) => v === VERDICT.SAME || v === VERDICT.SAME_PIXELS;

/**
 * 각 항목은 파이프라인을 한 번(또는 두 번) 돌리고 결과를 확인한다.
 * check 는 문제가 있으면 설명 문자열을, 없으면 null 을 돌려준다.
 */
const CASES = [
  {
    name: '정적 페이지는 아무것도 안 켜도 두 번이 같다',
    file: 'static.html', steps: [], twice: true,
    check: (r, cmp) => (same(cmp.verdict) ? null : `두 번이 달랐다 (${cmp.verdict} ${(cmp.ratio * 100).toFixed(2)}%)`),
  },
  {
    name: '무한 애니메이션은 baseline 에서 두 번이 다르다',
    file: 'loop.html', steps: [], twice: true,
    check: (r, cmp) => (same(cmp.verdict) ? '달라야 하는데 같게 나왔다 — 채점기가 못 잡고 있다' : null),
  },
  {
    name: 'anim 단계를 켜면 무한 애니메이션도 두 번이 같아진다',
    file: 'loop.html', steps: ['anim'], twice: true,
    check: (r, cmp) => (same(cmp.verdict) ? null : `여전히 다르다 (${cmp.verdict} ${(cmp.ratio * 100).toFixed(2)}%)`),
  },
  {
    name: 'sticky 단계는 플로팅 3개를 숨기고 헤더 1개는 남긴다',
    file: 'floating.html', steps: ['sticky'],
    check: (r) => {
      const note = (r.notes || []).find((n) => n.startsWith('고정 요소'));
      if (!note) return '고정 요소를 하나도 못 찾았다';
      const n = Number((note.match(/고정 요소 (\d+)개/) || [])[1]);
      if (n !== 3) return `숨긴 개수가 ${n}개 (기대 3개) — ${note}`;
      if (!note.includes('헤더 1개 유지')) return `헤더를 남기지 않았다 — ${note}`;
      return null;
    },
  },
  {
    name: 'sticky 를 안 켜면 아무것도 숨기지 않는다',
    file: 'floating.html', steps: [],
    check: (r) => ((r.notes || []).some((n) => n.startsWith('고정 요소')) ? '안 켰는데 숨겼다' : null),
  },
  {
    name: '스무스 스크롤을 안 풀면 끝까지 못 가서 문서가 짧게 남는다',
    file: 'smooth.html', steps: [],
    check: (r) => (r.docHeight > 3000 ? `문서가 ${r.docHeight}px — 스크롤이 성공해버렸다. 픽스처가 무력하다` : null),
  },
  {
    name: 'motion 단계를 켜면 끝까지 스크롤해 숨은 콘텐츠가 붙는다',
    file: 'smooth.html', steps: ['motion'],
    check: (r) => (r.docHeight > 3000 ? null : `문서가 ${r.docHeight}px 그대로 — 모션 해제가 안 먹었다`),
  },
  {
    name: 'slice 단계는 긴 문서를 여러 장으로 나눈다',
    file: 'tall.html', steps: ['slice'],
    check: (r) => {
      const want = Math.ceil(r.docHeight / SAFE_PIXELS);
      if (want < 2) return `픽스처가 짧아졌다 (${r.docHeight}px) — 분할을 시험할 수 없다`;
      return r.sliceCount === want ? null : `${r.sliceCount}장 (기대 ${want}장)`;
    },
  },
  {
    name: 'slice 를 안 켜면 한 장으로 찍는다',
    file: 'tall.html', steps: [],
    check: (r) => (r.sliceCount === 1 ? null : `${r.sliceCount}장으로 나눴다`),
  },
  {
    name: '매번 다르게 그리는 페이지는 모든 단계를 켜도 다르다 (T4 대조군)',
    file: 'random.html', steps: ['sticky', 'motion', 'anim', 'slice'], twice: true,
    check: (r, cmp) => (same(cmp.verdict) ? '같게 나왔다 — 채점기가 T4 를 통과시키고 있다' : null),
  },
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
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function main() {
  const server = await serveFixtures();
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const diffCtx = await browser.newContext({ viewport: { width: 200, height: 200 } });
  const diffPage = await diffCtx.newPage();

  let failed = 0;
  for (const c of CASES) {
    const shots = [];
    let err = null;
    for (let i = 0; i < (c.twice ? 2 : 1); i++) {
      const ctx = await browser.newContext({ viewport: VIEWPORT, locale: 'ko-KR' });
      const r = await captureSite(ctx, BASE + c.file, { steps: c.steps });
      await ctx.close().catch(() => {});
      if (!r.ok) { err = r.error; break; }
      shots.push(r);
    }
    if (err) {
      console.log(`  ✗ ${c.name}\n      캡처 실패: ${err}`);
      failed++;
      continue;
    }
    const cmp = c.twice ? await compareCaptures(diffPage, shots[0].slices, shots[1].slices) : null;
    const problem = c.check(shots[0], cmp);
    if (problem) { console.log(`  ✗ ${c.name}\n      ${problem}`); failed++; }
    else console.log(`  ✓ ${c.name}`);
  }

  await browser.close();
  server.close();
  console.log(`\n${CASES.length - failed}/${CASES.length} 통과`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
