#!/usr/bin/env python3
"""리서치 문서들을 탭 하나로 합친다.

그냥 이어 붙이면 안 된다 — 문서마다 .tier / .page / .stat 같은 클래스를
서로 다른 의미로 쓰기 때문이다. 각 문서의 CSS를 그 문서의 패널 아래로
스코프해서 격리한다. 토큰(:root)과 전역 리셋만 공유한다.
"""
import re, sys

# 저장소 루트에서 실행한다. 스크래치패드 사본이 아니라 docs/research 의 원본을 읽는다.
SRC = 'docs/research/'
OUT = SRC + 'capture-research-tabs.html'

DOCS = [
    ('p1', SRC + 'capture-tool-landscape.html',  '01', '경쟁 분석',  '시중 도구는 어디까지 왔나'),
    ('p2', SRC + 'capture-tier-taxonomy.html',   '02', '분류 체계',  '캡처 난이도 T0–T4'),
    ('p3', SRC + 'capture-scan-results.html',    '03', '실측 결과',  'GDWEB 50건 계측'),
    ('p4', SRC + 'capture-tier-integrated.html', '04', '통합 판정',  '티어 × 30개 사이트'),
]

# 전역으로 남길 셀렉터 — 스코프하면 오히려 깨진다.
GLOBAL_SELECTORS = {'*', 'body', 'html', ':root'}


def split_rules(css):
    """중괄호 깊이를 세며 최상위 규칙 단위로 자른다. @media 중첩을 견딘다."""
    out, depth, buf = [], 0, ''
    for ch in css:
        buf += ch
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                out.append(buf.strip())
                buf = ''
    if buf.strip():
        out.append(buf.strip())
    return out


def scope_selector(sel, scope):
    sel = sel.strip()
    if not sel or sel.startswith('@'):
        return sel
    parts = []
    for one in sel.split(','):
        one = one.strip()
        if not one:
            continue
        head = one.split()[0].split(':')[0].split('[')[0]
        if one in GLOBAL_SELECTORS or head in GLOBAL_SELECTORS:
            # body / :root 계열은 패널 자체에 걸어 준다(패널이 그 문서의 루트다).
            rest = one[len(one.split()[0]):].strip()
            parts.append(f'#{scope} {rest}'.strip() if rest else f'#{scope}')
        else:
            parts.append(f'#{scope} {one}')
    return ', '.join(parts)


def scope_css(css, scope):
    """토큰 정의는 전역으로 빼고, 나머지 규칙은 #scope 아래로 내린다."""
    tokens, scoped = [], []
    for rule in split_rules(css):
        if rule.startswith('@media'):
            head, _, inner = rule.partition('{')
            inner = inner.rstrip()[:-1]  # 마지막 } 제거
            # 토큰만 재정의하는 미디어 블록은 그대로 전역 유지
            if ':root' in inner and '--' in inner and not re.search(r'\.[a-z]', inner):
                tokens.append(rule)
            else:
                inner_scoped = '\n'.join(
                    scope_rule(r, scope) for r in split_rules(inner)
                )
                scoped.append(f'{head}{{\n{inner_scoped}\n}}')
            continue
        if rule.startswith('@'):
            scoped.append(rule)
            continue
        sel, _, body = rule.partition('{')
        if sel.strip() == ':root':
            tokens.append(rule)
            continue
        scoped.append(scope_rule(rule, scope))
    return '\n'.join(tokens), '\n'.join(scoped)


def scope_rule(rule, scope):
    sel, brace, body = rule.partition('{')
    if not brace:
        return rule
    if sel.strip().startswith('@'):
        return rule
    return f'{scope_selector(sel, scope)}{{{body}'


def extract(path):
    s = open(path, encoding='utf-8').read()
    css = re.search(r'<style>(.*?)</style>', s, re.S).group(1)
    body = s[s.index('<div class="page">'):]
    body = body[:body.rindex('</div>') + 6]
    title = re.search(r'<title>(.*?)</title>', s).group(1)
    return css, body, title


LAYOUT_TOKENS = {'--measure', '--wide'}   # 문서마다 본문 폭이 다르므로 전역화하면 안 된다


def parse_decls(block_body):
    return dict(re.findall(r'(--[a-z0-9-]+)\s*:\s*([^;}]+?)\s*(?:;|$)', block_body))


def collect_tokens(css):
    """한 문서의 :root 토큰을 light / dark / theme 세 갈래로 뽑는다."""
    light, dark, theme = {}, {}, {}
    for rule in split_rules(css):
        sel, _, body = rule.partition('{')
        sel = sel.strip()
        if sel.startswith('@media') and 'prefers-color-scheme: dark' in sel:
            for inner in split_rules(body.rstrip()[:-1]):
                isel, _, ibody = inner.partition('{')
                if ':root' in isel:
                    dark.update(parse_decls(ibody))
        elif sel == ':root':
            light.update(parse_decls(body))
        elif sel.startswith(':root[data-theme="dark"]'):
            theme.update(parse_decls(body))
    return light, dark, theme


def render_tokens(docs_tokens):
    """문서들의 토큰을 합쳐 전역 블록 하나씩으로 만든다. 먼저 나온 값이 이긴다."""
    light, dark, theme = {}, {}, {}
    per_panel = []
    for pid, (l, d, t) in docs_tokens:
        layout = {k: v for k, v in l.items() if k in LAYOUT_TOKENS}
        if layout:
            decls = ''.join(f'{k}:{v};' for k, v in layout.items())
            per_panel.append(f'#{pid}{{{decls}}}')
        for src, dst in ((l, light), (d, dark), (t, theme)):
            for k, v in src.items():
                if k not in LAYOUT_TOKENS:
                    dst.setdefault(k, v)

    def block(sel, decls, indent='  '):
        body = '\n'.join(f'{indent}{k}:{v};' for k, v in decls.items())
        return f'{sel}{{\n{body}\n}}'

    return '\n'.join([
        block(':root', light),
        '@media (prefers-color-scheme: dark){\n  :root:not([data-theme="light"]){\n'
        + '\n'.join(f'    {k}:{v};' for k, v in dark.items()) + '\n  }\n}',
        block(':root[data-theme="dark"]', theme),
        '/* 문서별 본문 폭 — 전역화하면 서로 덮어쓴다 */',
        '\n'.join(per_panel),
    ])


def main():
    docs_tokens, all_scoped, panels, tabs = [], [], [], []
    for pid, path, num, short, sub in DOCS:
        css, body, title = extract(path)
        docs_tokens.append((pid, collect_tokens(css)))
        _, scoped = scope_css(css, pid)
        all_scoped.append(f'/* ===== {short} ===== */\n{scoped}')
        panels.append(
            f'<div class="panel" id="{pid}" role="tabpanel" '
            f'aria-labelledby="tab-{pid}" tabindex="0" hidden>\n{body}\n</div>')
        tabs.append(
            f'<button class="tab" id="tab-{pid}" role="tab" aria-controls="{pid}" '
            f'aria-selected="false" tabindex="-1" data-panel="{pid}" data-hash="{num}">'
            f'<span class="tnum">{num}</span>'
            f'<span class="tname">{short}</span>'
            f'<span class="tsub">{sub}</span></button>')

    out = TEMPLATE.format(
        tokens=render_tokens(docs_tokens),
        scoped='\n'.join(all_scoped),
        tabs='\n      '.join(tabs),
        panels='\n'.join(panels),
    )
    open(OUT, 'w', encoding='utf-8').write(out)
    print('written', len(out), 'bytes')


TEMPLATE = '''<title>웹사이트 스냅샷 리서치</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+KR:wght@300;400;500;600;700&display=swap">

<style>
{tokens}

*{{box-sizing:border-box;}}
body{{
  margin:0; background:var(--ground); color:var(--ink);
  font-family:var(--sans); font-size:16px; line-height:1.75;
  letter-spacing:-0.003em; -webkit-font-smoothing:antialiased; word-break:keep-all;
}}

/* ---------- 셸: 헤더 + 탭 바 ---------- */
.shell{{max-width:66rem;margin:0 auto;padding:0 1.5rem;}}
.brand{{padding:2.75rem 0 1.1rem;display:flex;flex-direction:column;gap:.45rem;}}
.brand .kicker{{font-family:var(--mono);font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0;}}
.brand h1{{margin:0;font-size:clamp(1.5rem,3.6vw,2rem);font-weight:700;letter-spacing:-0.035em;line-height:1.2;}}
.brand p{{margin:0;color:var(--ink-2);font-size:.95rem;max-width:44rem;}}

.tabbar{{
  position:sticky;top:0;z-index:20;background:var(--ground);
  border-bottom:1px solid var(--line-strong);
}}
.tabbar-inner{{max-width:66rem;margin:0 auto;padding:0 1.5rem;display:flex;gap:0;overflow-x:auto;scrollbar-width:none;}}
.tabbar-inner::-webkit-scrollbar{{display:none;}}
.tab{{
  appearance:none;background:none;border:none;border-bottom:2px solid transparent;
  font-family:inherit;color:var(--muted);cursor:pointer;text-align:left;
  padding:.85rem 1.15rem .8rem;display:grid;grid-template-columns:auto 1fr;
  gap:0 .5rem;align-items:baseline;flex:none;margin-bottom:-1px;
}}
.tab .tnum{{font-family:var(--mono);font-size:.68rem;font-weight:600;letter-spacing:.06em;grid-row:span 2;color:var(--muted);}}
.tab .tname{{font-size:.95rem;font-weight:600;letter-spacing:-0.02em;color:var(--ink-2);line-height:1.35;}}
.tab .tsub{{font-size:.74rem;color:var(--muted);line-height:1.35;white-space:nowrap;}}
.tab:hover .tname{{color:var(--ink);}}
.tab[aria-selected="true"]{{border-bottom-color:var(--accent);}}
.tab[aria-selected="true"] .tnum,
.tab[aria-selected="true"] .tname{{color:var(--accent);}}
.tab:focus-visible{{outline:2px solid var(--accent);outline-offset:-3px;border-radius:2px;}}

.panel[hidden]{{display:none;}}
.panel:focus{{outline:none;}}
.panel .masthead{{padding-top:2.75rem;}}
@media (prefers-reduced-motion:no-preference){{
  .panel{{animation:fade .22s ease-out;}}
  @keyframes fade{{from{{opacity:0;transform:translateY(4px)}}to{{opacity:1;transform:none}}}}
}}

.shellfoot{{
  max-width:66rem;margin:0 auto;padding:0 1.5rem 4rem;
  font-family:var(--mono);font-size:.7rem;letter-spacing:.05em;color:var(--muted);
}}

@media (max-width:40rem){{
  .tab .tsub{{display:none;}}
  .tab{{padding:.8rem .85rem;grid-template-columns:auto;}}
  .tab .tnum{{grid-row:auto;}}
}}

/* ---------- 문서별 스코프 스타일 ---------- */
{scoped}
</style>

<div class="shell">
  <header class="brand">
    <p class="kicker">웹사이트 스냅샷 자동화 · AX 리서치</p>
    <h1>리서치 아카이브</h1>
    <p>기획안을 뒷받침하려고 진행한 리서치입니다 &mdash; 시중 도구를 조사하고, 캡처 난이도 분류 체계를 세우고, 실제 사이트 50곳을 계측했습니다. 마지막 탭은 그 체계를 채택한 외부 문서를 검증해 반영한 것입니다. 진행한 순서대로 정리했습니다.</p>
  </header>
</div>

<nav class="tabbar">
  <div class="tabbar-inner" role="tablist" aria-label="리서치 문서">
      {tabs}
  </div>
</nav>

{panels}

<div class="shellfoot">웹사이트 스냅샷 자동화 · 2026-08-27</div>

<script>
(() => {{
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const panels = tabs.map(t => document.getElementById(t.dataset.panel));
  const KEY = 'snapshot-research-tab';
  // 해시는 패널 id 와 일부러 다르게 둔다. 같으면 브라우저가 그 요소까지
  // 스크롤해 버려서 머리말이 잘린 채 열린다.
  const byHash = h => tabs.find(t => t.dataset.hash === h);
  const byPanel = p => tabs.find(t => t.dataset.panel === p);

  function select(tab, {{focus = false, push = true}} = {{}}) {{
    if (!tab) return;
    tabs.forEach((t, i) => {{
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      panels[i].hidden = !on;
    }});
    if (focus) tab.focus();
    try {{ localStorage.setItem(KEY, tab.dataset.panel); }} catch (e) {{ /* 사생활 보호 모드 */ }}
    if (push && location.hash.slice(1) !== tab.dataset.hash) {{
      history.replaceState(null, '', '#' + tab.dataset.hash);
    }}
  }}

  tabs.forEach(t => t.addEventListener('click', () => {{
    select(t);
    window.scrollTo({{top: 0, behavior: 'auto'}});
  }}));

  document.querySelector('[role="tablist"]').addEventListener('keydown', e => {{
    const i = tabs.indexOf(tabs.find(t => t.getAttribute('aria-selected') === 'true'));
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n === null) return;
    e.preventDefault();
    select(tabs[n], {{focus: true}});
    window.scrollTo({{top: 0, behavior: 'auto'}});
  }});

  window.addEventListener('hashchange', () => {{
    const t = byHash(location.hash.slice(1));
    if (t) select(t, {{push: false}});
  }});

  let start = byHash(location.hash.slice(1));
  if (!start) {{
    try {{ start = byPanel(localStorage.getItem(KEY)); }} catch (e) {{ start = null; }}
  }}
  select(start || tabs[0], {{push: false}});
}})();
</script>
'''

if __name__ == '__main__':
    main()
