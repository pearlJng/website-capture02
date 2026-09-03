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

  const cap = (t) => (t.length > 50 ? t.slice(0, 47) + '…' : t);
  const labelOf = (a) => cap(clean(a.innerText || a.textContent)
    || clean(a.getAttribute('aria-label') || a.getAttribute('title'))
    || clean([...a.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ')));

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
  const vh = window.innerHeight;
  const HEADERISH = 'header, nav, [role="navigation"], [class*="gnb"], [id*="gnb"], [class*="header"], [id*="header"], [class*="menu"], [id*="menu"], [class*="nav"], [id*="nav"]';
  const FOOTERISH = 'footer, [class*="footer"], [id*="footer"]';
  // 이름만 보고 고르면 안 된다. 아임웹은 페이지 전체를 감싸는 요소의 클래스에도
  // nav·menu 가 들어가서, 본문의 뉴스 카드까지 "헤더 링크"로 딸려 왔다.
  // 헤더·내비는 한 화면을 넘지 않는다 — 페이지 높이짜리는 헤더가 아니다.
  const small = (el, k) => el !== document.body && el !== document.documentElement
    && el.getBoundingClientRect().height <= vh * k;
  const headerRoots = pick(HEADERISH).filter((el) => small(el, 1.2) && !el.closest(FOOTERISH));
  const footerRoots = pick(FOOTERISH).filter((el) => small(el, 2));

  // 헤더 안의 목록을 전부 읽고, GNB 와 유틸리티(알림·마이페이지·언어)를 가른다.
  // 사이트 안 페이지로 가는 항목이 3개 이상인 목록이 GNB 다. 하나도 없으면
  // 가장 긴 목록을 GNB 로 본다.
  const lists = [];
  for (const root of headerRoots) {
    for (const list of topLists(root)) {
      if (list.__read) continue;
      list.__read = true;
      for (const u of list.querySelectorAll('ul, ol')) u.__read = true;
      const items = walkList(list, 0);
      if (items.length) lists.push(items);
    }
  }
  const countPages = (items) => items.reduce((n, x) => n + (x.kind === '페이지' ? 1 : 0) + countPages(x.children), 0);
  let gnbLists = lists.filter((items) => countPages(items) >= 3);
  if (!gnbLists.length && lists.length) gnbLists = [lists.reduce((a, b) => (b.length > a.length ? b : a))];
  const menu = gnbLists.flat();
  const utility = lists.filter((l) => !gnbLists.includes(l)).flat()
    .filter((x) => x.kind !== '없음');

  // 목록 밖에 있는 헤더 링크(로고·로그인·언어 등). 주소 없는 버튼은 뺀다.
  const loose = [];
  for (const root of headerRoots) {
    for (const a of root.querySelectorAll('a')) {
      if (a.closest('ul, ol')) continue;
      const l = linkOf(a);
      if (!l || !l.label || l.kind === '없음') continue;
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
    menu, utility, loose, footer,
    // 판정이 틀렸을 때 들여다볼 수 있게 헤더 원문을 남긴다
    headerHtml: headerRoots.slice(0, 4).map((el) => el.outerHTML).join('\n\n').slice(0, 300000),
  };
}

/* ── 마우스를 올려 찾는 방식에 쓰는 페이지 안 도우미들 ── */

/** 모든 링크·버튼에 번호표를 붙인다. 밖에서 hover 할 때 이 번호로 집는다. */
function inPageTagItems() {
  let n = 0;
  for (const el of document.querySelectorAll('a, button, [role="menuitem"], li > span, li > div')) {
    if (!el.hasAttribute('data-ia')) el.setAttribute('data-ia', String(n++));
  }
  return n;
}

/**
 * 화면에 실제로 보이는 항목들. 위치·크기·글자를 같이 준다.
 * 드롭다운은 헤더 밖(body 끝)에 그려지기도 하므로 헤더 안만 보지 않고 화면 전체를 본다.
 */
function inPageVisibleItems() {
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const el of document.querySelectorAll('[data-ia]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
    // 조상 중 하나라도 투명·숨김이면 안 보이는 것이다
    let hidden = false;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const c = getComputedStyle(n);
      if (c.visibility === 'hidden' || c.display === 'none' || Number(c.opacity) < 0.05) { hidden = true; break; }
    }
    if (hidden) continue;
    // 그 자리를 실제로 이 요소가 차지하는지 (다른 것에 덮여 있으면 안 보이는 것)
    const cx = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const cy = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) continue;
    const label = clean(el.innerText || el.textContent) || clean(el.getAttribute('aria-label') || el.getAttribute('title'))
      || clean([...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' '));
    if (!label) continue;
    let href = '';
    const a = el.tagName === 'A' ? el : el.querySelector('a');
    const raw = a && a.getAttribute('href');
    if (raw && !/^javascript:/i.test(raw) && raw !== '#') { try { href = new URL(raw, location.href).href; } catch { /* 무시 */ } }
    out.push({ id: el.getAttribute('data-ia'), label: label.length > 50 ? label.slice(0, 47) + '…' : label, href,
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  }
  return out;
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
  // 헤더·푸터 판정도 이름만 보면 안 된다 (위 inPageReadNav 의 이유와 같다).
  // 한 화면 반을 넘는 요소는 이름에 header 가 들어 있어도 본문 포장이다.
  const CHROMEISH = 'header, footer, nav, [class*="header"], [class*="footer"], [id*="header"], [id*="footer"]';
  const isChrome = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.matches(CHROMEISH) && n.getBoundingClientRect().height <= vh * 1.5) return true;
    }
    return getComputedStyle(el).position === 'fixed';
  };

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

  // 구간 사이에 큰 빈 틈이 있으면 거기 뭔가 있는 것이다 — section 으로 안 싸인 덩어리.
  // 테라클 메인에서 히어로 다음 1,300px 이 통째로 빠졌다. 틈을 절반 이상 채우는
  // 가장 큰 요소를 찾아 끼운다.
  const all = [...document.body.querySelectorAll('div, section, article, main > *')];
  const filled = [];
  for (let i = 0; i < blocks.length; i++) {
    filled.push(blocks[i]);
    if (i === blocks.length - 1) break;
    const a = rect(blocks[i]), b = rect(blocks[i + 1]);
    const gapTop = a.top + a.h, gapBottom = b.top, gap = gapBottom - gapTop;
    if (gap < 250) continue;
    let best = null, bestH = 0;
    for (const el of all) {
      if (isChrome(el) || blocks.includes(el)) continue;
      const r = rect(el);
      if (r.top < gapTop - 20 || r.top + r.h > gapBottom + 20 || r.h < gap * 0.5) continue;
      if (r.h > bestH) { best = el; bestH = r.h; }
    }
    if (best) filled.push(best);
  }
  blocks = filled;

  const menuLabels = new Set([...document.querySelectorAll('header a, nav a')].map((a) => clean(a.textContent).toLowerCase()).filter(Boolean));

  const describe = (el, i) => {
    const { top, h } = rect(el);
    const heading = el.querySelector('h1, h2, h3, h4, [class*="title"], [class*="heading"]');
    // textContent 는 <br> 을 지워 "테라클에서는재활용이" 처럼 붙는다. innerText 는 줄바꿈을 준다.
    const headText = clean(heading && (heading.innerText || heading.textContent)).slice(0, 60);
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

/* ──────────────────── 마우스를 올려 GNB 를 찾는다 ──────────────────── */

const kindOfHref = (href, origin) => {
  if (!href) return '없음';
  let u; try { u = new URL(href); } catch { return '없음'; }
  if (/^(mailto|tel|sms):/.test(u.protocol)) return '연락';
  if (u.origin !== origin) return '외부';
  if (/\.(pdf|zip|docx?|xlsx?|pptx?|hwp)$/i.test(u.pathname)) return '파일';
  if (u.hash) return '앵커';
  return '페이지';
};

/**
 * 사람이 하는 대로 한다 — 맨 위 한 줄에 나란히 선 항목마다 마우스를 올려 보고,
 * 그때 새로 나타나는 링크를 그 항목의 하위 메뉴로 적는다.
 *
 * DOM 구조(ul/li 중첩)를 믿는 방식은 사이트마다 다르게 짜서 자주 틀린다.
 * 테라클(아임웹)은 드롭다운이 li 안에 있지 않아 Product·Contact 의 하위가
 * 1차로 흩어져 나왔다. 화면에 무엇이 나타나는지는 구조와 무관하다.
 */
async function discoverByHover(page, origin, progress) {
  await page.evaluate(inPageTagItems);
  const away = async () => {
    await page.mouse.move(2, Math.max(2, (page.viewportSize() || { height: 900 }).height - 2));
  };
  await away();
  // 등장 애니메이션이 덜 끝난 채로 기준을 잡으면, 나중에 서서히 나타난 본문
  // 링크("더 알아보기")가 하위 메뉴로 잡힌다 — 유닉트에서 실제로 그랬다.
  // 애니메이션을 끝까지 돌리고 잠시 기다린 뒤에 기준을 잡는다.
  await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.finish(); } catch { /* 무한 반복 */ } } });
  await page.waitForTimeout(800);
  const base = await page.evaluate(inPageVisibleItems);
  const vw = (page.viewportSize() || { width: 1440 }).width;

  // 맨 위 220px 안에서 같은 높이에 나란히 선 항목이 가장 많은 줄이 GNB 다.
  const top = base.filter((it) => it.y < 220 && it.h <= 120 && it.label.length <= 30);
  const rows = new Map();
  for (const it of top) {
    const key = Math.round((it.y + it.h / 2) / 8);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(it);
  }
  let row = null;
  for (const items of rows.values()) {
    const distinct = items.filter((it, i) => items.findIndex((o) => o.label === it.label) === i);
    if (distinct.length >= 3 && (!row || distinct.length > row.length)) row = distinct;
  }
  if (!row) return null;
  row.sort((a, b) => a.x - b.x);
  // 한 줄에 로고나 유틸리티가 섞이면 폭이 튄다. 가운데 무리(서로 400px 안)만 남긴다.
  const seenId = new Set(base.map((b) => b.id));

  const hoverPath = async (path) => {
    for (const it of path) {
      await page.hover(`[data-ia="${it.id}"]`, { timeout: 2500, force: true }).catch(() => {});
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(350);
  };

  const children = async (path, depth, known) => {
    const it = path[path.length - 1];
    await hoverPath(path);
    let now = await page.evaluate(inPageVisibleItems);
    let fresh = now.filter((n) => !known.has(n.id) && n.y >= it.y - 4 && n.id !== it.id);
    // 마우스로 안 열리고 눌러야 열리는 것(주소 없는 항목)은 한 번 눌러 본다
    if (!fresh.length && !it.href && depth === 1) {
      await page.click(`[data-ia="${it.id}"]`, { timeout: 2500, force: true }).catch(() => {});
      await page.waitForTimeout(400);
      now = await page.evaluate(inPageVisibleItems);
      fresh = now.filter((n) => !known.has(n.id) && n.id !== it.id);
    }
    // 결정적인 검사: 진짜 하위 메뉴는 마우스를 치우면 사라진다. 그대로 남아
    // 있는 건 그 사이에 나타난 본문 링크다.
    if (fresh.length) {
      if (path.length > 1) await hoverPath(path.slice(0, -1)); else await away();
      await page.waitForTimeout(500);
      const after = new Set((await page.evaluate(inPageVisibleItems)).map((n) => n.id));
      fresh = fresh.filter((f) => !after.has(f.id));
      await hoverPath(path);    // 다시 열어 둔다 — 하위의 하위를 보려면 열려 있어야 한다
    }
    fresh.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const out = [];
    const nextKnown = new Set([...known, ...fresh.map((f) => f.id)]);
    for (const f of fresh) {
      if (f.label === it.label && f.href === it.href) continue;    // 자기 자신의 복사본
      const node = { label: f.label, href: f.href, kind: kindOfHref(f.href, origin), depth, children: [], id: f.id };
      if (depth < 3) node.children = await children([...path, f], depth + 1, nextKnown);
      out.push(node);
    }
    return out;
  };

  const menu = [];
  for (const it of row) {
    progress(`메뉴에 마우스 올려 확인 — ${it.label}`);
    const node = { label: it.label, href: it.href, kind: kindOfHref(it.href, origin), depth: 0, children: [], id: it.id };
    node.children = await children([it], 1, seenId);
    // 마우스를 치우고 열린 것이 닫히게 한다
    await page.mouse.move(2, Math.max(2, (page.viewportSize() || { height: 900 }).height - 2));
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
    menu.push(node);
  }
  const strip = (items) => { for (const x of items) { delete x.id; strip(x.children); } };
  strip(menu);
  // 주소 없는 항목도 남긴다 — 눌러야 팝업이 열리는 "Contact" 같은 메뉴가 있다.
  // 알림·마이페이지 같은 버튼은 보통 다른 줄(유틸리티 바)에 있어 여기 안 섞인다.
  // 언어 선택은 같은 줄에 앉아 있어도 GNB 가 아니다 — 유틸리티로 넘긴다.
  const LANG = /^(en|eng|english|kr|ko|kor|korean|한국어|한글|jp|ja|jpn|japanese|日本語|cn|zh|chinese|中文|简体中文|繁體中文|中文\s*\((简体|繁體|繁体)\)|de|deutsch|german|fr|français|french|es|español|spanish|vi|tiếng việt|th|ไทย|language|languages|lang|언어|global)$/i;
  // "KOR / EN", "KR | JP" 처럼 언어를 나란히 적은 것도 언어 선택이다
  const langLabel = (t) => { const parts = t.split(/[\/|·,]/).map((x) => x.trim()).filter(Boolean); return parts.length > 0 && parts.every((x) => LANG.test(x)); };
  const isLang = (x) => langLabel(x.label) || (x.children.length >= 2 && x.children.every((c) => langLabel(c.label)));
  const utility = [];
  const gnb = [];
  for (const m of menu) {
    if (isLang(m)) {
      const flat = m.children.length ? m.children : [m];
      for (const c of flat) utility.push({ ...c, depth: 0, children: [], group: '언어' });
    } else gnb.push(m);
  }
  return { menu: gnb, utility };
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

    // 1순위: 마우스를 올려 찾은 것. 2순위: DOM 구조로 읽은 것.
    let method = 'dom';
    const found = await discoverByHover(page, origin, progress).catch(() => null);
    const hovered = found && found.menu;
    if (hovered && hovered.length >= 3) {
      // DOM 으로 읽은 것 중 hover 로 못 본 항목(드롭다운이 hover 로 안 열리는 경우)은 유틸리티로 넘긴다
      const inHover = new Set();
      const collect = (items) => { for (const x of items) { inHover.add(`${x.href}|${x.label}`); collect(x.children); } };
      collect(hovered);
      const flat = [];
      const flatten = (items) => { for (const x of items) { flat.push(x); flatten(x.children); } };
      flatten(home.menu);
      const leftovers = flat.filter((x) => x.kind !== '없음' && !inHover.has(`${x.href}|${x.label}`))
        .map((x) => ({ ...x, depth: 0, children: [] }));
      // 유틸리티는 주소가 같으면 하나다 (EN 과 English 가 같은 곳으로 간다)
      home.utility = [...found.utility, ...(home.utility || []), ...leftovers]
        .filter((x, i, arr) => arr.findIndex((o) => (x.href ? o.href === x.href : o.label === x.label)) === i);
      home.menu = hovered;
      method = 'hover';
    }

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
      menu: home.menu, utility: home.utility || [], loose: home.loose, footer: home.footer, main, pages,
      headerHtml: home.headerHtml,
      menuCount: count(home.menu), inspected, method, ms: Date.now() - started,
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
    const out = u.origin === origin ? ((u.pathname + u.search + u.hash) || '/') : u.href;
    return out.length > 70 ? out.slice(0, 67) + '…' : out;
  } catch { return href; }
};

export function renderTree(r) {
  const origin = (() => { try { return new URL(r.finalUrl || r.url).origin; } catch { return ''; } })();
  const L = [];
  L.push(`${r.title || '(제목 없음)'}  ${r.finalUrl || r.url}`);
  if (r.description) L.push(`  "${r.description}"`);
  L.push('');
  L.push(`  메뉴 ${r.menuCount}개${r.method === 'hover' ? ' · 항목마다 마우스를 올려 하위 메뉴를 확인했습니다' : ' · 메뉴 구조를 읽었습니다'}${r.inspected ? ` · 하위 페이지 ${r.inspected}곳 확인` : ''}`);
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

  if (r.utility && r.utility.length) {
    L.push('');
    L.push('  유틸리티 메뉴 (알림·마이페이지·언어 등)');
    for (const l of r.utility) L.push(`    · ${l.label}  ${short(l.href, origin)}${l.kind === '외부' ? '  (외부)' : ''}`);
  }
  if (r.loose.length) {
    L.push('');
    L.push('  헤더의 다른 링크');
    for (const l of r.loose) L.push(`    · ${l.label}  ${short(l.href, origin)}${l.kind === '외부' ? '  (외부)' : ''}`);
  }
  if (r.footer.length) {
    // 푸터는 GNB 를 한 번 더 늘어놓기 마련이다. 같은 곳으로 가는 건 접는다.
    const inMenu = new Set();
    const collect = (items) => { for (const x of items) { if (x.href) inMenu.add(normUrl(x.href)); collect(x.children); } };
    collect(r.menu);
    for (const u of (r.utility || [])) if (u.href) inMenu.add(normUrl(u.href));
    const rest = r.footer.filter((l) => !l.href || !inMenu.has(normUrl(l.href)));
    const dup = r.footer.length - rest.length;
    L.push('');
    L.push(`  푸터${dup ? `  (메뉴와 같은 링크 ${dup}개는 생략)` : ''}`);
    for (const l of rest) L.push(`    · ${l.label}  ${short(l.href, origin)}${l.kind === '외부' ? '  (외부)' : ''}`);
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
  for (const l of (r.utility || [])) rows.push({ '깊이': 0, '경로': l.label, '이름': l.label, 'URL': l.href, '종류': l.kind, '출처': '유틸리티' });
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
      const { headerHtml, ...rest } = r;
      writeFileSync(join(outDir, `${base}.json`), JSON.stringify(rest, null, 2));
      if (headerHtml) writeFileSync(join(outDir, `${base.replace('정보구조', '헤더원문')}.html`), headerHtml);
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
