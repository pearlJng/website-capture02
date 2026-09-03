#!/usr/bin/env node
/**
 * sitemap.mjs — 사이트의 정보구조(메뉴 트리)를 뽑는다.
 *
 * 주소 하나를 넣으면 "홈 / About us / Technology / …" 처럼 사이트가 스스로
 * 내세운 메뉴 구조가 나온다. 페이지를 전부 기어다니며 링크 그래프를 그리는
 * 게 아니다 — 그건 사이트가 방문자에게 보여 주는 구조와 다르다. 헤더·내비의
 * 목록(ul/li) 중첩을 그대로 읽어 트리로 만든다. 그게 기획자가 "정보구조"라
 * 부르는 것이다.
 *
 *   node sitemap.mjs --urls https://example.com --out ./결과
 *   node sitemap.mjs --urls https://example.com --depth 0      메뉴만, 하위 페이지 안 들어감
 *
 * 결과: 정보구조.txt (트리) · 정보구조.json · 정보구조.csv
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVICES, contextOptionsFor } from './capture.mjs';
import { createBrowserHost, pickBrowser } from './browser.mjs';
import { writeTable } from './csv.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_SUBPAGES = 25;     // 하위 페이지를 이보다 많이 들어가지 않는다
const PAGE_TIMEOUT = 30000;

/* ──────────────────────────── 페이지 안에서 도는 코드 ──────────────────────────── */

/**
 * 헤더·내비의 목록 구조를 트리로 읽는다. 브라우저 안에서 돈다.
 *
 * 숨겨진 드롭다운도 읽는다 — 보이는 것만 읽으면 하위 메뉴가 전부 빠진다.
 * 모바일 메뉴가 DOM 에 따로 있어 같은 링크가 두 번 나오는데, 주소+이름으로 걸러낸다.
 */
function inPageReadNav() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const seen = new Set();

  const labelOf = (a) => clean(a.innerText || a.textContent)
    || clean(a.getAttribute('aria-label') || a.getAttribute('title'))
    || clean([...a.querySelectorAll('img[alt]')].map((i) => i.alt).join(' '));

  const kindOf = (u) => {
    if (!u) return '없음';
    if (/^(mailto|tel|sms):/.test(u.protocol)) return '연락';
    if (u.origin !== location.origin) return '외부';
    if (/\.(pdf|zip|docx?|xlsx?|pptx?|hwp)$/i.test(u.pathname)) return '파일';
    if (u.hash) return '앵커';           // 어느 페이지든 그 안의 한 자리를 가리키는 링크
    return '페이지';
  };

  const linkOf = (a) => {
    const raw = a.getAttribute('href');
    if (raw == null) return null;
    if (/^javascript:/i.test(raw) || raw === '#' || raw === '') {
      // 눌러야 열리는 항목 — 주소는 없지만 메뉴에는 있는 것이다
      return { label: labelOf(a), href: '', kind: '없음' };
    }
    let u = null;
    try { u = new URL(raw, location.href); } catch { return null; }
    return { label: labelOf(a), href: u.href, kind: kindOf(u) };
  };

  const key = (l) => `${l.href}|${l.label}`;

  /** li 안에서 이 li 의 것인 링크와 하위 목록을 찾는다 (더 깊은 li 의 것은 빼고). */
  const ownLink = (li) => [...li.querySelectorAll('a')].find((a) => a.closest('li') === li) || null;
  const ownList = (li) => [...li.querySelectorAll('ul, ol')].find((u) => u.parentElement.closest('li') === li) || null;

  function walkList(list, depth) {
    const items = [];
    for (const li of list.children) {
      if (li.tagName !== 'LI') continue;
      const a = ownLink(li);
      const sub = ownList(li);
      let link = a ? linkOf(a) : null;
      if (!link) {
        // 링크 없는 항목(제목만 있는 그룹). 텍스트가 있으면 그룹으로 남긴다.
        const text = clean([...li.childNodes].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !n.matches('ul, ol'))).map((n) => n.textContent).join(' '));
        if (!text && !sub) continue;
        link = { label: text || '(제목 없음)', href: '', kind: '없음' };
      }
      if (!link.label) continue;
      const k = key(link);
      const dup = seen.has(k);
      seen.add(k);
      const children = sub ? walkList(sub, depth + 1) : [];
      if (dup && !children.length) continue;      // 모바일 메뉴 등에서 반복된 것
      items.push({ ...link, depth, children });
    }
    return items;
  }

  /** 컨테이너 안에서 다른 목록 안에 들어 있지 않은 최상위 목록들 */
  const topLists = (root) => [...root.querySelectorAll('ul, ol')]
    .filter((u) => !u.parentElement.closest('ul, ol') || !root.contains(u.parentElement.closest('ul, ol')));

  const pick = (sel) => [...document.querySelectorAll(sel)];
  // 헤더 후보를 문서 순서대로. header 가 nav 를 품고 있으면 header 에서 다 읽히고 nav 는 비게 된다.
  const headerRoots = pick('header, nav, [role="navigation"], [class*="gnb"], [id*="gnb"], [class*="header"], [id*="header"], [class*="menu"], [id*="menu"], [class*="nav"], [id*="nav"]')
    .filter((el) => !el.closest('footer, [class*="footer"], [id*="footer"]'));
  const footerRoots = pick('footer, [class*="footer"], [id*="footer"]');

  const menu = [];
  for (const root of headerRoots) {
    for (const list of topLists(root)) {
      // 다른 후보 안에서 이미 읽은 목록이면 건너뛴다
      if (list.__read) continue;
      list.__read = true;
      for (const u of list.querySelectorAll('ul, ol')) u.__read = true;
      menu.push(...walkList(list, 0));
    }
  }
  // 목록 밖에 있는 헤더 링크(로고·로그인·언어 등)
  const loose = [];
  for (const root of headerRoots) {
    for (const a of root.querySelectorAll('a')) {
      if (a.closest('ul, ol')) continue;
      const l = linkOf(a);
      if (!l || !l.label) continue;
      const k = key(l);
      if (seen.has(k)) continue;
      seen.add(k);
      loose.push(l);
    }
  }
  const footer = [];
  for (const root of footerRoots) {
    for (const a of root.querySelectorAll('a')) {
      const l = linkOf(a);
      if (!l || !l.label) continue;
      const k = key(l);
      if (seen.has(k)) continue;
      seen.add(k);
      footer.push(l);
    }
  }

  return {
    title: clean(document.title),
    url: location.href,
    h1: clean((document.querySelector('h1') || {}).textContent),
    description: clean((document.querySelector('meta[name="description"]') || {}).content),
    menu, loose, footer,
  };
}

/* ──────────────────────────────── 조립 ──────────────────────────────── */

const normUrl = (href) => {
  try { const u = new URL(href); u.hash = ''; u.search = ''; return u.href.replace(/\/$/, ''); } catch { return href; }
};

/**
 * 첫 페이지의 메뉴를 읽고, 최상위 메뉴 페이지에 들어가 그 페이지에만 있는
 * 하위 메뉴를 붙인다. 아임웹 템플릿 일부는 하위 메뉴를 해당 페이지에서만 보여 준다.
 */
export async function extractSitemap(context, url, opts = {}) {
  const depth = opts.depth ?? 1;
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const started = Date.now();
  const page = await context.newPage();
  try {
    progress('여는 중');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(500);
    const home = await page.evaluate(inPageReadNav);
    const origin = new URL(page.url()).origin;

    // 홈 링크 표시: 사이트 루트로 가는 항목
    const isHome = (l) => l.kind === '페이지' && normUrl(l.href) === normUrl(origin + '/');
    const mark = (items) => { for (const it of items) { if (isHome(it)) it.home = true; mark(it.children); } };
    mark(home.menu);

    const visited = new Set([normUrl(page.url())]);
    const pages = [{ url: page.url(), title: home.title, h1: home.h1 }];
    let inspected = 0;

    if (depth >= 1) {
      const targets = home.menu.filter((it) => it.kind === '페이지' && !it.home && !visited.has(normUrl(it.href)))
        .slice(0, MAX_SUBPAGES);
      for (const it of targets) {
        const key = normUrl(it.href);
        if (visited.has(key)) continue;
        visited.add(key);
        inspected++;
        progress(`하위 페이지 ${inspected}/${targets.length} — ${it.label}`);
        try {
          await page.goto(it.href, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
          await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(300);
          const sub = await page.evaluate(inPageReadNav);
          pages.push({ url: page.url(), title: sub.title, h1: sub.h1, menu: it.label });
          // 홈 메뉴에 없던 같은 오리진 페이지 링크를 이 항목의 하위로 붙인다
          const known = new Set();
          const collect = (items) => { for (const x of items) { known.add(normUrl(x.href)); collect(x.children); } };
          collect(home.menu);
          const flat = [];
          const flatten = (items) => { for (const x of items) { flat.push(x); flatten(x.children); } };
          flatten(sub.menu);
          for (const x of flat) {
            if (x.kind !== '페이지' || known.has(normUrl(x.href))) continue;
            if (!normUrl(x.href).startsWith(normUrl(key))) continue;   // 이 메뉴 아래 경로만
            known.add(normUrl(x.href));
            it.children.push({ ...x, depth: it.depth + 1, children: [], found: '하위 페이지에서 발견' });
          }
        } catch (e) {
          it.error = e.message.split('\n')[0];
        }
      }
    }

    // sitemap.xml 에는 있는데 메뉴에 없는 페이지 — 숨은 페이지(이벤트·약관 등)
    let hidden = [];
    try {
      const res = await page.request.get(origin + '/sitemap.xml', { timeout: 8000 });
      if (res.ok()) {
        const xml = await res.text();
        const inMenu = new Set();
        const collect = (items) => { for (const x of items) { inMenu.add(normUrl(x.href)); collect(x.children); } };
        collect(home.menu);
        for (const l of [...home.loose, ...home.footer]) inMenu.add(normUrl(l.href));
        hidden = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1])
          .filter((u) => u.startsWith(origin) && !inMenu.has(normUrl(u)))
          .slice(0, 100);
      }
    } catch { /* 없으면 없는 것 */ }

    const count = (items) => items.reduce((n, x) => n + 1 + count(x.children), 0);
    return {
      ok: true, url, finalUrl: page.url(), title: home.title, description: home.description,
      menu: home.menu, loose: home.loose, footer: home.footer, hidden, pages,
      menuCount: count(home.menu), inspected, ms: Date.now() - started,
    };
  } catch (e) {
    return { ok: false, url, error: e.message.split('\n')[0], ms: Date.now() - started };
  } finally {
    await page.close().catch(() => {});
  }
}

/* ──────────────────────────────── 출력 ──────────────────────────────── */

const short = (href, origin) => {
  if (!href) return '';
  try {
    const u = new URL(href);
    if (u.origin === origin) return (u.pathname + u.search + u.hash) || '/';
    return u.href;
  } catch { return href; }
};

export function renderTree(r) {
  const origin = (() => { try { return new URL(r.finalUrl || r.url).origin; } catch { return ''; } })();
  const L = [];
  L.push(`${r.title || '(제목 없음)'}  ${r.finalUrl || r.url}`);
  if (r.description) L.push(`  "${r.description}"`);
  L.push('');
  L.push(`  메뉴 ${r.menuCount}개${r.inspected ? ` · 하위 페이지 ${r.inspected}곳 확인` : ''}`);
  L.push('');

  const walk = (items, prefix) => {
    items.forEach((it, i) => {
      const last = i === items.length - 1;
      const tag = it.home ? '  ← 홈' : it.kind === '외부' ? '  (외부)' : it.kind === '앵커' ? '  (페이지 안 위치)'
        : it.kind === '파일' ? '  (파일)' : it.kind === '연락' ? '  (연락)' : it.kind === '없음' && !it.children.length ? '  (눌러야 열림)' : '';
      const found = it.found ? `  ※ ${it.found}` : '';
      const err = it.error ? `  ✗ ${it.error}` : '';
      L.push(`${prefix}${last ? '└ ' : '├ '}${it.label.padEnd(Math.max(2, 22 - it.depth * 2))} ${short(it.href, origin)}${tag}${found}${err}`);
      walk(it.children, prefix + (last ? '   ' : '│  '));
    });
  };
  walk(r.menu, '  ');

  if (r.loose.length) {
    L.push('');
    L.push('  헤더의 다른 링크');
    for (const l of r.loose) L.push(`    · ${l.label}  ${short(l.href, origin)}${l.kind === '외부' ? '  (외부)' : ''}`);
  }
  if (r.footer.length) {
    L.push('');
    L.push('  푸터');
    for (const l of r.footer) L.push(`    · ${l.label}  ${short(l.href, origin)}${l.kind === '외부' ? '  (외부)' : ''}`);
  }
  if (r.hidden.length) {
    L.push('');
    L.push(`  메뉴에는 없는 페이지 (sitemap.xml) ${r.hidden.length}개`);
    for (const u of r.hidden.slice(0, 30)) L.push(`    · ${short(u, origin)}`);
    if (r.hidden.length > 30) L.push(`    … ${r.hidden.length - 30}개 더`);
  }
  L.push('');
  return L.join('\n');
}

export function flattenRows(r) {
  const rows = [];
  const walk = (items, path) => {
    for (const it of items) {
      const p = [...path, it.label];
      rows.push({ '깊이': it.depth, '경로': p.join(' > '), '이름': it.label, 'URL': it.href, '종류': it.home ? '홈' : it.kind, '출처': it.found || '메뉴' });
      walk(it.children, p);
    }
  };
  walk(r.menu, []);
  for (const l of r.loose) rows.push({ '깊이': 0, '경로': l.label, '이름': l.label, 'URL': l.href, '종류': l.kind, '출처': '헤더' });
  for (const l of r.footer) rows.push({ '깊이': 0, '경로': l.label, '이름': l.label, 'URL': l.href, '종류': l.kind, '출처': '푸터' });
  for (const u of r.hidden) rows.push({ '깊이': '', '경로': '', '이름': '', 'URL': u, '종류': '페이지', '출처': 'sitemap.xml' });
  return rows;
}

/* ──────────────────────────────── CLI ──────────────────────────────── */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'help') { out.help = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${key} 에 값이 필요합니다`);
    out[key] = key === 'depth' ? Number(v) : v;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.urls) {
    console.log(`
사이트 정보구조(메뉴 트리) 뽑기

  node sitemap.mjs --urls <url> --out <폴더>

옵션
  --out <폴더>     저장 위치 (기본 ./결과)
  --depth <n>      1(기본) 최상위 메뉴 페이지에 들어가 거기서만 보이는 하위 메뉴를 붙인다
                   0       첫 페이지 메뉴만 읽는다 (빠름)
  --browser <이름>  auto(기본) | chrome | msedge | chromium

결과: 정보구조.txt (트리) · 정보구조.json · 정보구조.csv
`);
    return;
  }
  const urls = args.urls.split(',').map((s) => s.trim()).filter(Boolean);
  const outDir = resolve(HERE, args.out || './결과');
  mkdirSync(outDir, { recursive: true });

  const pick = await pickBrowser(args.browser);
  const host = createBrowserHost({ prefer: args.browser });
  try {
    for (const url of urls) {
      console.error(`정보구조 읽는 중 — ${url} · ${pick.name}`);
      const browser = await host.get();
      const ctx = await browser.newContext(contextOptionsFor(DEVICES[1440], 1));
      const r = await extractSitemap(ctx, url, {
        depth: args.depth ?? 1,
        onProgress: (m) => console.error(`      ${m}`),
      });
      await ctx.close().catch(() => {});
      if (!r.ok) { console.error(`  ✗ ${r.error}`); process.exitCode = 1; continue; }

      const tree = renderTree(r);
      console.log(tree);
      const base = urls.length > 1 ? `정보구조 - ${new URL(r.finalUrl || url).hostname}` : '정보구조';
      writeFileSync(join(outDir, `${base}.txt`), tree + '\n');
      writeFileSync(join(outDir, `${base}.json`), JSON.stringify(r, null, 2));
      writeFileSync(join(outDir, `${base}.csv`), writeTable(['깊이', '경로', '이름', 'URL', '종류', '출처'], flattenRows(r)));
      console.error(`저장: ${join(outDir, base + '.txt')}  (${(r.ms / 1000).toFixed(1)}초)`);
    }
  } finally {
    await host.close().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
