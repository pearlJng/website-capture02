#!/usr/bin/env node
/**
 * score.mjs — 캡처 엔진의 성적표를 만든다.
 *
 * 같은 사이트를 두 번 찍어서 결과가 같은지 본다. 그게 전부다.
 * 티어 정의가 곧 정답지이므로 사람이 검수할 필요가 없다:
 *   T0~T2  두 번 찍어 같아야 한다  → 같으면 통과
 *   T3     v1 범위 밖               → 참고만
 *   T4     같을 수가 없다           → 다르면 정상
 *
 * 사용:
 *   node score.mjs --from ../gdweb-scan/results.gdweb-2026-v2.csv --steps none
 *   node score.mjs --from ../gdweb-scan/results.tier30.csv --steps all --scale 2
 *   node score.mjs --urls https://example.com --steps sticky,motion --keep-shots ./shots
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSite, STEPS, VIEWPORT } from './capture.mjs';
import { compareCaptures, VERDICT } from './diff.mjs';
import { readTable, writeTable } from './csv.mjs';
import { createBrowserHost, isBrowserDeath } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FLAGS = new Set(['help', 'dry-run']);
const NUMERIC = new Set(['limit', 'concurrency', 'scale']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (FLAGS.has(key)) { out[key] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${key} 에 값이 필요합니다`);
    out[key] = NUMERIC.has(key) ? Number(v) : v;
  }
  return out;
}

function resolveSteps(spec) {
  if (!spec || spec === 'none') return [];
  if (spec === 'all') return [...STEPS];
  const want = spec.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = want.filter((s) => !STEPS.includes(s));
  if (bad.length) throw new Error(`모르는 단계: ${bad.join(', ')} (가능: ${STEPS.join(', ')}, none, all)`);
  return want;
}

/** 스캔 CSV 든 URL 목록이든 {name, url, tier} 배열로 만든다. */
function loadTargets(args) {
  if (args.urls) {
    return args.urls.split(',').map((u) => u.trim()).filter(Boolean).map((u) => ({ name: u, url: u, tier: '' }));
  }
  const path = resolve(HERE, args.from || args.file);
  const text = readFileSync(path, 'utf8');
  if (!args.from) {
    return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((u) => ({ name: u, url: u, tier: '' }));
  }
  return readTable(text)
    .map((r) => ({
      name: r['이름'] || r['URL'],
      url: r['최종 URL'] || r['URL'],
      tier: r['티어'] || '',
      tags: r['태그'] || '',
      scanHeight: Number(r['문서높이']) || 0,
    }))
    .filter((r) => r.url && r.tier); // 스캔에서 실패한 건 제외
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/**
 * 완주했는지 본다.
 *
 * 결정성만 보면 "조용히 절반을 놓친 캡처"가 통과해 버린다 — 두 번 다 똑같이
 * 실패하면 픽셀은 같기 때문이다. 실제로 스무스 스크롤 사이트에서 그 일이 난다.
 * 그래서 높이를 따로 확인한다.
 */
function completeness(shot, scanHeight) {
  // 바닥에 못 닿았다. 가장 확실한 신호 — 무언가가 스크롤을 가로챘다.
  if (shot.reachedBottom === false) return '미완주';
  // 스캐너가 잰 것보다 뚜렷하게 짧으면 뭔가를 놓친 것이다.
  if (scanHeight && shot.docHeight < scanHeight * 0.9) return '짧음';
  // 스크롤을 가로채는 라이브러리를 발견했는데 걷어내지 않고 찍었다면,
  // 끝까지 갔다고 주장할 수 없다.
  if (shot.motionLibs && shot.motionLibs.length && !shot.motionHandled) return '미확인';
  return '정상';
}

/** 통과하려면 두 번이 같고(결정성) 끝까지 갔어야(완주) 한다. */
function judge(tier, verdict, complete) {
  const same = verdict === VERDICT.SAME || verdict === VERDICT.SAME_PIXELS;
  const ok = same && complete === '정상';
  if (tier === 'T0' || tier === 'T1' || tier === 'T2') return ok ? '통과' : '실패';
  if (tier === 'T4') return same ? '이상' : '예상대로';
  if (tier === 'T3') return ok ? '통과(범위 밖)' : '실패(범위 밖)';
  return ok ? '통과' : '실패';
}

function summarize(rows) {
  const s = {
    total: rows.length,
    captured: rows.filter((r) => !r.error).length,
    failed: rows.filter((r) => r.error).length,
    byTier: {},
    v1Pass: 0, v1Total: 0, v1Same: 0, v1Complete: 0,
    t4Deterministic: 0, t4Total: 0,
  };
  for (const r of rows) {
    const t = r.tier || '(미분류)';
    const b = (s.byTier[t] ||= { total: 0, same: 0, diff: 0, error: 0, incomplete: 0, pass: 0 });
    b.total++;
    if (r.error) { b.error++; continue; }
    const same = r.verdict === VERDICT.SAME || r.verdict === VERDICT.SAME_PIXELS;
    const done = r.complete === '정상';
    if (same) b.same++; else b.diff++;
    if (!done) b.incomplete++;
    // 통과는 따로 센다. '다름'이면서 '미완주'인 사이트가 있어서
    // (같음 - 미완주) 로 빼면 같은 사이트를 두 번 깎는다.
    if (same && done) b.pass++;
    if (['T0', 'T1', 'T2'].includes(t)) {
      s.v1Total++;
      if (same) s.v1Same++;
      if (done) s.v1Complete++;
      if (same && done) s.v1Pass++;
    }
    if (t === 'T4') { s.t4Total++; if (same) s.t4Deterministic++; }
  }
  return s;
}

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

function renderReport(rows, s, meta) {
  const L = [];
  L.push('');
  L.push('  결정성 채점 결과');
  L.push('  ' + '─'.repeat(74));
  L.push(`  단계        ${meta.steps.length ? meta.steps.join(' + ') : 'none (baseline — 지금 설계)'}`);
  L.push(`  배율        ${meta.scale}배  ·  뷰포트 ${VIEWPORT.width}×${VIEWPORT.height}`);
  L.push(`  대상        ${s.total}건  (캡처 성공 ${s.captured} · 실패 ${s.failed})`);
  L.push(`  방법        같은 URL 을 새 브라우저 컨텍스트로 두 번 찍어 픽셀 비교`);
  L.push('');

  L.push(`  ┌ v1 목표 구간 (T0~T2)`);
  L.push(`  │  결정성        ${String(s.v1Same).padStart(3)} / ${s.v1Total}   ${String(pct(s.v1Same, s.v1Total)).padStart(3)}%   두 번 찍어 같았다`);
  L.push(`  │  완주          ${String(s.v1Complete).padStart(3)} / ${s.v1Total}   ${String(pct(s.v1Complete, s.v1Total)).padStart(3)}%   끝까지 펼쳐서 찍었다`);
  L.push(`  │  둘 다 통과    ${String(s.v1Pass).padStart(3)} / ${s.v1Total}   ${String(pct(s.v1Pass, s.v1Total)).padStart(3)}%   ← 이게 성적입니다`);
  if (s.t4Total) {
    L.push(`  └ T4 대조군      ${String(s.t4Total - s.t4Deterministic).padStart(3)} / ${s.t4Total}   ${String(pct(s.t4Total - s.t4Deterministic, s.t4Total)).padStart(3)}% 이 예상대로 달랐음`);
  } else L.push('  └');
  L.push('');

  L.push('  티어별');
  L.push('  ' + '─'.repeat(74));
  L.push('  티어   대상   같음   다름   미완주   실패   통과율   (미완주 = 짧거나 스크롤 미확인)');
  for (const t of ['T0', 'T1', 'T2', 'T3', 'T4', '(미분류)']) {
    const b = s.byTier[t];
    if (!b) continue;
    const rate = ['T0', 'T1', 'T2'].includes(t) ? `${pct(b.pass, b.total - b.error)}%` : '—';
    L.push(`  ${t.padEnd(6)}${String(b.total).padStart(4)}${String(b.same).padStart(7)}${String(b.diff).padStart(7)}${String(b.incomplete).padStart(9)}${String(b.error).padStart(7)}${rate.padStart(9)}`);
  }
  L.push('');

  const bad = rows.filter((r) => !r.error && ['T0', 'T1', 'T2'].includes(r.tier) &&
    judge(r.tier, r.verdict, r.complete) !== '통과');
  if (bad.length) {
    L.push(`  통과하지 못한 T0~T2 ${bad.length}건 — 여기가 다음에 고칠 곳입니다`);
    L.push('  ' + '─'.repeat(74));
    for (const r of bad.sort((a, b) => b.ratio - a.ratio).slice(0, 25)) {
      const why = r.complete === '짧음' ? `짧음 ${r.docHeight}/${r.scanHeight}px`
        : r.complete === '미완주' ? '바닥 못 닿음'
        : r.complete === '미확인' ? '스크롤 미확인'
        : (r.verdict === VERDICT.SHAPE ? '구조' : (r.ratio * 100).toFixed(2) + '%');
      L.push(`  ${r.tier}  ${why.padStart(16)}  ${r.name.slice(0, 24).padEnd(26)}${(r.note || '').slice(0, 30)}`);
    }
    if (bad.length > 25) L.push(`  … 그 외 ${bad.length - 25}건`);
    L.push('');
  }

  const errs = rows.filter((r) => r.error);
  if (errs.length) {
    L.push(`  캡처 자체가 실패한 ${errs.length}건`);
    L.push('  ' + '─'.repeat(74));
    for (const r of errs.slice(0, 15)) L.push(`  ${r.name.slice(0, 26).padEnd(28)}${r.error.slice(0, 44)}`);
    L.push('');
  }

  const odd = rows.filter((r) => r.tier === 'T4' && !r.error &&
    (r.verdict === VERDICT.SAME || r.verdict === VERDICT.SAME_PIXELS));
  if (odd.length) {
    L.push(`  T4 인데 두 번 다 같게 나온 ${odd.length}건 — 티어 판정이 틀렸거나 캡처가 뭔가를 놓치고 있습니다`);
    for (const r of odd.slice(0, 10)) L.push(`    ${r.name}`);
    L.push('');
  }
  return L.join('\n');
}

const CSV_COLS = ['이름', 'URL', '티어', '판정', '결정성', '차이비율', '완주', '문서높이', '스캔높이', '분할수', '비고', '캡처메모', '오류'];

function toCsvRows(rows) {
  return rows.map((r) => ({
    '이름': r.name, 'URL': r.url, '티어': r.tier,
    '판정': r.error ? '캡처실패' : judge(r.tier, r.verdict, r.complete),
    '결정성': r.verdict || '', '차이비율': r.error ? '' : (r.ratio * 100).toFixed(4) + '%',
    '완주': r.complete || '', '문서높이': r.docHeight ?? '', '스캔높이': r.scanHeight || '',
    '분할수': r.sliceCount ?? '',
    '비고': r.note || '', '캡처메모': (r.notes || []).join(' / '), '오류': r.error || '',
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.from && !args.file && !args.urls)) {
    console.log(`
사용법
  node score.mjs --from <스캔결과.csv> [옵션]
  node score.mjs --file <urls.txt> [옵션]
  node score.mjs --urls <url1,url2> [옵션]

옵션
  --steps <spec>      none(기본) | all | ${STEPS.join(',')} 중 골라서 쉼표로
  --scale <n>         배율 (기본 1)
  --limit <n>         앞에서 n건만
  --concurrency <n>   동시 실행 (기본 2 — 한 건당 두 번 찍으므로 무겁습니다)
  --keep-shots <dir>  PNG 를 남겨 눈으로 확인
  --out <prefix>      보고서·CSV 저장 경로 앞부분
  --dry-run           대상만 확인하고 끝
`);
    return;
  }

  const steps = resolveSteps(args.steps);
  const scale = args.scale || 1;
  let targets = loadTargets(args);
  if (args.limit) targets = targets.slice(0, args.limit);
  if (!targets.length) { console.error('대상이 없습니다.'); process.exitCode = 1; return; }

  if (args['dry-run']) {
    console.log(`대상 ${targets.length}건 · 단계 [${steps.join(', ') || 'none'}] · ${scale}배`);
    for (const t of targets.slice(0, 10)) console.log(`  ${(t.tier || '  ').padEnd(4)} ${t.name}  ${t.url}`);
    if (targets.length > 10) console.log(`  … 그 외 ${targets.length - 10}건`);
    return;
  }

  const shotDir = args['keep-shots'] ? resolve(HERE, args['keep-shots']) : null;
  if (shotDir) mkdirSync(shotDir, { recursive: true });

  const host = createBrowserHost();

  // 예외가 나도 브라우저는 반드시 닫는다. 안 닫으면 이벤트 루프가 살아 있어
  // 프로세스가 끝나지 않고, 터미널이 멈춘 것처럼 보인다.
  let closed = false;
  const shutdown = async () => { if (!closed) { closed = true; await host.close().catch(() => {}); } };
  process.on('SIGINT', () => { shutdown().finally(() => process.exit(130)); });

  const ctxOpts = { viewport: VIEWPORT, deviceScaleFactor: scale, userAgent: UA, locale: 'ko-KR', timezoneId: 'Asia/Seoul' };

  // 브라우저가 죽으면 이 페이지도 같이 죽는다. 필요할 때마다 살아 있는지 보고 다시 만든다.
  let diffPage = null;
  async function getDiffPage() {
    if (diffPage && !diffPage.isClosed()) return diffPage;
    const b = await host.get();
    const ctx = await b.newContext({ viewport: { width: 200, height: 200 } });
    diffPage = await ctx.newPage();
    return diffPage;
  }

  console.error(`캡처 시작 — ${targets.length}건 × 2회, 단계 [${steps.join(', ') || 'none'}], ${scale}배`);
  let done = 0;

  /** 한 사이트를 두 번 찍고 채점한다. 브라우저가 죽었으면 그 사실을 알려준다. */
  async function runOnce(t, base) {
    const shots = [];
    for (let pass = 0; pass < 2; pass++) {
      // 매번 새 컨텍스트 — 캐시가 데워진 상태로 두 번째를 찍으면 시험이 헐거워진다.
      const browser = await host.get();
      const ctx = await browser.newContext(ctxOpts);
      const r = await captureSite(ctx, t.url, { steps, scale });
      await ctx.close().catch(() => {});
      if (!r.ok) return { ...base, error: r.error, died: isBrowserDeath(r.error) };
      shots.push(r);
    }
    const cmp = await compareCaptures(await getDiffPage(), shots[0].slices, shots[1].slices);
    return { shots, cmp };
  }

  let rows;
  try {
  rows = await mapLimit(targets, args.concurrency || 2, async (t) => {
    const base = { name: t.name, url: t.url, tier: t.tier, ratio: 0 };

    let out;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        out = await runOnce(t, base);
      } catch (e) {
        const msg = e.message.split('\n')[0];
        out = { ...base, error: msg, died: isBrowserDeath(msg) };
      }
      if (!out.died) break;
      // 브라우저가 죽었다. 다음 host.get() 이 새로 띄운다. 한 번만 다시 해 본다.
      if (attempt === 0) console.error(`     브라우저가 죽었습니다 — 다시 띄우고 재시도: ${t.name}`);
    }

    if (out.error) {
      console.error(`  [${++done}/${targets.length}] ✗ ${t.name} — ${out.error}`);
      return { ...base, error: out.error };
    }
    const { shots, cmp } = out;
    const complete = completeness(shots[0], t.scanHeight);

    if (shotDir) {
      const safe = t.name.replace(/[^\w가-힣.-]+/g, '_').slice(0, 40);
      shots[0].slices.forEach((buf, i) => writeFileSync(join(shotDir, `${safe}_${i + 1}.png`), buf));
      if (cmp.verdict === VERDICT.DIFF || cmp.verdict === VERDICT.SHAPE) {
        shots[1].slices.forEach((buf, i) => writeFileSync(join(shotDir, `${safe}_${i + 1}_b.png`), buf));
      }
    }

    const mark = judge(t.tier, cmp.verdict, complete) === '통과' || t.tier === 'T4' ? '=' : '≠';
    const extra = complete === '정상' ? '' : ' · ' + complete;
    console.error(`  [${++done}/${targets.length}] ${mark} ${t.tier || '  '} ${t.name} — ${cmp.verdict}${cmp.ratio ? ' ' + (cmp.ratio * 100).toFixed(2) + '%' : ''}${extra}`);

    return {
      ...base, verdict: cmp.verdict, ratio: cmp.ratio, note: cmp.note, complete,
      sliceCount: shots[0].sliceCount, docHeight: shots[0].docHeight,
      scanHeight: t.scanHeight, notes: shots[0].notes,
    };
  });

  } finally {
    await shutdown();
  }
  if (host.restarts) console.error(`\n브라우저가 ${host.restarts}번 죽어서 다시 띄웠습니다.`);

  const s = summarize(rows);
  const meta = { steps, scale };
  const report = renderReport(rows, s, meta);
  console.log(report);

  const prefix = args.out || `score-${steps.length ? steps.join('-') : 'baseline'}-${scale}x`;
  const out = resolve(HERE, prefix);
  writeFileSync(out + '.txt', report + '\n');
  writeFileSync(out + '.csv', writeTable(CSV_COLS, toCsvRows(rows)));
  console.error(`\n저장: ${prefix}.txt · ${prefix}.csv`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

export { judge, completeness, summarize, resolveSteps, parseArgs };
