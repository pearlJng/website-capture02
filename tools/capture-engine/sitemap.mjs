#!/usr/bin/env node
/**
 * sitemap.mjs — 사이트의 정보구조(메뉴 트리)를 뽑는다.
 *
 * 주소 하나를 넣으면 두 가지가 나온다.
 *
 *   1. GNB 1차~n차 메뉴 트리 — "홈 / About us / Technology / …"
 *   2. 메인페이지 구성 — 위에서 아래로 어떤 구간이 무엇으로 짜여 있는지
 *      (히어로·카드 3열·갤러리·문의 폼·지도 …)
 *
 * 페이지를 전부 기어다니며 링크 그래프를 그리는 게 아니다 — 그건 사이트가
 * 방문자에게 보여 주는 구조와 다르다. 헤더·내비의 목록(ul/li) 중첩을 그대로
 * 읽어 트리로 만든다. 그게 기획자가 "정보구조"라 부르는 것이다.
 *
 *   node sitemap.mjs --urls https://example.com --out ./결과
 *   node sitemap.mjs --urls https://example.com --depth 1     최상위 메뉴 페이지에도 들어가 하위 메뉴를 더 찾는다
 *
 * 결과: 정보구조.txt (트리+메인 구성) · 정보구조.json · 정보구조.csv · 메인페이지.csv
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

/**
 * 메인페이지를 위에서 아래로 구간별로 읽는다. 브라우저 안에서 돈다.
 *
 * "구간"은 문서를 세로로 나누는 큼직한 덩어리다. body 에서 시작해 자식이 하나뿐인
 * 포장 요소를 벗겨 내려가다가, 문서를 여럿으로 나누는 자리에서 멈춘다.
 * 아임웹은 섹션마다 .doz_section / section 을 쓰므로 그게 있으면 우선 쓴다.
 */
function inPageReadSections() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const vh = window.innerHeight;
  const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + window.scrollY), h: Math.round(r.height) }; };
  const isChrome = (el) => !!el.closest('header, footer, nav, [class*="header"], [class*="footer"], [id*="header"], [id*="footer"]')
    || getComputedStyle(el).position === 'fixed';

  // 1) 사이트가 스스로 구간을 표시한 경우
  let blocks = [...document.querySelectorAll('.doz_section, main > section, body section')]
    .filter((el) => !isChrome(el) && !el.parentElement.closest('section') && rect(el).h >= 80);
  // 2) 아니면 포장을 벗겨 내려가며 문서를 여럿으로 나누는 자리를 찾는다
  if (blocks.length < 3) {
    let node = document.querySelector('main') || document.body;
    for (let guard = 0; guard < 12; guard++) {
      const kids = [...node.children].filter((el) => !isChrome(el) && !/^(SCRIPT|STYLE|LINK|NOSCRIPT|TEMPLATE)$/.test(el.tagName) && rect(el).h >= 80);
      if (kids.length >= 3) { blocks = kids; break; }
      if (kids.length === 0) break;
      // 자식이 하나둘이면 그중 가장 큰 것으로 내려간다
      node = kids.sort((a, b) => rect(b).h - rect(a).h)[0];
    }
  }
  blocks.sort((a, b) => rect(a).top - rect(b).top);

  const menuLabels = new Set([...document.querySelectorAll('header a, nav a')].map((a) => clean(a.textContent).toLowerCase()).filter(Boolean));

  const describe = (el, i) => {
    const { top, h } = rect(el);
    const heading = el.querySelector('h1, h2, h3, h4, [class*="title"], [class*="heading"]');
    const headText = clean(heading && heading.textContent).slice(0, 60);
    const text = clean(el.innerText).slice(0, 90);
    const imgs = [...el.querySelectorAll('img')].filter((im) => im.getBoundingClientRect().width >= 40);
    const bgImg = [el, ...el.querySelectorAll('*')].slice(0, 60).some((x) => /url\(/.test(getComputedStyle(x).backgroundImage));
    const video = el.querySelector('video, iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"]');
    const map = el.querySelector('iframe[src*="google.com/maps"], iframe[src*="maps.google"], [class*="map"], iframe[src*="kakao"], iframe[src*="naver"]');
    const form = el.querySelector('form, input:not([type=hidden]), textarea');
    const slider = el.querySelector('.swiper, .slick, [class*="slider"], [class*="carousel"], [class*="swiper"]');
    const buttons = [...el.querySelectorAll('a, button')].filter((b) => {
      const t = clean(b.textContent); const r = b.getBoundingClientRect();
      return t && t.length <= 24 && r.height >= 32 && r.width >= 80 && r.width <= 420;
    });
    // 카드 N열: 같은 줄에 나란히 선 비슷한 크기의 형제들
    let columns = 0;
    for (const parent of [el, ...el.querySelectorAll('*')].slice(0, 200)) {
      const kids = [...parent.children].filter((k) => k.getBoundingClientRect().height >= 120);
      if (kids.length < 3) continue;
      const tops = kids.map((k) => Math.round(k.getBoundingClientRect().top));
      const row = kids.filter((k, j) => Math.abs(tops[j] - tops[0]) < 8);
      if (row.length >= 3 && row.length <= 6) { columns = row.length; break; }
    }
    const logos = imgs.length >= 5 && imgs.every((im) => im.getBoundingClientRect().height <= 90);

    let type;
    if (i === 0 && (video || bgImg || imgs.length || slider) && h >= vh * 0.5) type = video ? '히어로 (동영상)' : slider ? '히어로 (슬라이더)' : '히어로';
    else if (form) type = '문의 · 폼';
    else if (map) type = '지도 · 위치';
    else if (logos) type = '로고 띠';
    else if (slider) type = '슬라이더';
    else if (columns) type = `카드 ${columns}열`;
    else if (imgs.length >= 6) type = '갤러리';
    else if (video) type = '동영상';
    else if (imgs.length && text.length > 40) type = '이미지 + 텍스트';
    else if (imgs.length) type = '이미지';
    else if (buttons.length && text.length < 120) type = 'CTA 배너';
    else type = '텍스트';

    const parts = [];
    if (video) parts.push('동영상');
    if (imgs.length) parts.push(`이미지 ${imgs.length}`);
    if (bgImg && !imgs.length) parts.push('배경 이미지');
    if (slider) parts.push('슬라이더');
    if (columns) parts.push(`${columns}열`);
    if (form) parts.push('폼');
    if (map) parts.push('지도');
    if (buttons.length) parts.push(`버튼 ${buttons.length}`);

    const id = el.id || (heading && heading.id) || '';
    const gnb = (headText && menuLabels.has(headText.toLowerCase())) || (id && [...document.querySelectorAll('header a[href*="#"], nav a[href*="#"]')].some((a) => a.hash === '#' + id));
    return { order: i + 1, top, height: h, type, heading: headText, text, parts, gnb: !!gnb, id };
  };

  return { docHeight: docH, viewport: vh, sections: blocks.map(describe) };
}

/** 지연 로딩이 자리를 잡게 한 번 빠르게 내려갔다 올라온다. 구간 높이를 재기 전에 한다. */
async function inPageQuickScroll() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const se = document.scrollingElement || document.documentElement;
  const step = window.innerHeight * 0.8;
  let last = -1;
  for (let i = 0; i < 80; i++) {
    se.scrollTop += step;
    await sleep(120);
    if (se.scrollTop === last) break;
    last = se.scrollTop;
  }
  se.scrollTop = 0;
  await sleep(300);
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
  const depth = opts.depth ?? 0;    // 기본은 GNB 와 메인페이지까지. 하위 페이지는 시키면 들어간다
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

    progress('메인페이지 구성 읽는 중');
    await page.evaluate(inPageQuickScroll);
    const main = await page.evaluate(inPageReadSections);

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

    const count = (items) => items.reduce((n, x) => n + 1 + count(x.children), 0);
    return {
      ok: true, url, finalUrl: page.url(), title: home.title, description: home.description,
      menu: home.menu, loose: home.loose, footer: home.footer, main, pages,
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
  if (r.main && r.main.sections.length) {
    L.push('');
    L.push(`  메인페이지 구성 — 문서 ${r.main.docHeight.toLocaleString('en-US')}px, ${r.main.sections.length}개 구간`);
    L.push('');
    for (const sct of r.main.sections) {
      const name = sct.heading || sct.text.slice(0, 40) || '(글 없음)';
      const pos = `${sct.top.toLocaleString('en-US')}~${(sct.top + sct.height).toLocaleString('en-US')}px`;
      L.push(`   ${String(sct.order).padStart(2)}. ${sct.type.padEnd(14)} ${pos.padEnd(18)} ${name}${sct.gnb ? '  ← GNB 항목' : ''}`);
      if (sct.parts.length) L.push(`       ${sct.parts.join(' · ')}`);
    }
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
  return rows;
}

export function sectionRows(r) {
  return ((r.main && r.main.sections) || []).map((s) => ({
    '순서': s.order, '유형': s.type, '제목': s.heading, '시작px': s.top, '높이px': s.height,
    '구성요소': s.parts.join(' · '), 'GNB항목': s.gnb ? 'Y' : '', '텍스트': s.text,
  }));
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
  --depth <n>      0(기본) 메인페이지에서 GNB 1차~n차 메뉴와 메인 구성을 읽는다
                   1       최상위 메뉴 페이지에도 들어가 거기서만 보이는 하위 메뉴를 붙인다
  --browser <이름>  auto(기본) | chrome | msedge | chromium

결과: 정보구조.txt (트리 + 메인 구성) · 정보구조.json · 정보구조.csv · 메인페이지.csv
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
        depth: args.depth ?? 0,
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
      writeFileSync(join(outDir, `${base.replace('정보구조', '메인페이지')}.csv`),
        writeTable(['순서', '유형', '제목', '시작px', '높이px', '구성요소', 'GNB항목', '텍스트'], sectionRows(r)));
      console.error(`저장: ${join(outDir, base + '.txt')}  (${(r.ms / 1000).toFixed(1)}초)`);
    }
  } finally {
    await host.close().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
