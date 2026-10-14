/**
 * 피드백 — 앱 오른쪽 아래 버튼으로 보낸 의견을 노션 매뉴얼의 "피드백·QA" 표에 한 줄씩 쌓는다.
 *
 * 노션에 쓰려면 통합(Integration) 키가 필요하다. 키는 비밀번호와 같아서 공개 저장소에 넣지 않는다 —
 * 앱 화면에서 한 번 붙여 넣으면 이 컴퓨터의 설정 파일(~/.website-snapshot/feedback.json)에만 남는다.
 * 표 주소와 알림 받을 사람은 비밀이 아니라 여기 적어 둔다(키 없이는 아무것도 못 한다).
 *
 * 키가 없거나 노션에 닿지 못하면 버리지 않고 이 컴퓨터에 모아 두었다가(outbox.json) 다음에 보낸다.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// 노션 매뉴얼 > 피드백·QA (알파브라더스 워크스페이스)
const DATABASE_ID = 'e148d00199fe41acb223b1927b4a7b01';
const DATA_SOURCE_ID = '23ae4817-7f1d-4115-8836-1f7fa470ddab';
// 새 피드백마다 이 사람을 언급(@)한다 — 노션 알림(폰 푸시 포함)이 바로 간다
const NOTIFY_USER_IDS = ['1b5d872b-594c-8178-908e-0002fa71fd1b'];

const API = process.env.FEEDBACK_API_BASE || 'https://api.notion.com';
const DIR = process.env.FEEDBACK_DIR || join(homedir(), '.website-snapshot');
const CONF = join(DIR, 'feedback.json');
const OUTBOX = join(DIR, 'outbox.json');
const KINDS = ['오류', '개선', '질문', '기타'];

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { mkdirSync(DIR, { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 }); };

const token = () => (process.env.NOTION_FEEDBACK_TOKEN || readJson(CONF, {}).token || '').trim();
export const feedbackStatus = () => ({ configured: !!token(), waiting: readJson(OUTBOX, []).length });

async function notion(method, path, body, version = '2022-06-28') {
  const r = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'notion-version': version, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

/** 노션이 돌려준 오류를 사람 말로 */
function explain(status, body) {
  if (status === 401) return '연결 키가 맞지 않아요. 매뉴얼의 피드백·QA 섹션에 있는 키를 다시 붙여 넣어 주세요.';
  if (status === 404) return '키는 맞는데 피드백 표에 접근 권한이 없어요. 노션의 피드백·QA 표에서 ⋯ → 연결 → 이 통합을 추가해 주세요.';
  if (status === 429) return '노션이 잠깐 바빠요. 저장해 두었다가 다시 보낼게요.';
  return `노션이 받지 못했어요 (${status}${body && body.message ? ` · ${body.message}` : ''})`;
}

/** 키를 저장하기 전에 정말 표에 쓸 수 있는지 확인한다 */
export async function setupFeedback(newToken) {
  const t = String(newToken || '').trim();
  if (!/^(ntn_|secret_)[A-Za-z0-9]{20,}$/.test(t)) return { ok: false, error: '노션 통합 키 모양이 아니에요 (ntn_ 로 시작하는 긴 글자)' };
  const prev = readJson(CONF, {});
  writeJson(CONF, { ...prev, token: t });
  let r;
  try { r = await notion('GET', `/v1/databases/${DATABASE_ID}`); } catch (e) { return { ok: true, warn: `키는 저장했어요. 지금 노션에 닿지 않아 확인은 못 했어요 (${e.message})` }; }
  if (r.status !== 200) {
    if (r.status === 401) writeJson(CONF, prev);     // 틀린 키는 남기지 않는다
    return { ok: false, error: explain(r.status, r.body) };
  }
  const sent = await flushOutbox();
  return { ok: true, sent };
}

const text = (s) => String(s || '').slice(0, 2000);
const rt = (s) => (s ? [{ type: 'text', text: { content: text(s) } }] : []);
const chunks = (s, n = 1900) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; };

function pageFor(fb) {
  const kind = KINDS.includes(fb.kind) ? fb.kind : '기타';
  const title = (fb.title || String(fb.body || '').split('\n')[0] || '(제목 없음)').slice(0, 120);
  const ctx = fb.ctx || {};
  const children = [];
  children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [
    ...NOTIFY_USER_IDS.flatMap((id) => [{ type: 'mention', mention: { type: 'user', user: { id } } }, { type: 'text', text: { content: ' ' } }]),
    { type: 'text', text: { content: `${fb.name || '팀원'} 님이 ${kind} 피드백을 보냈어요.` } },
  ] } });
  for (const part of chunks(String(fb.body || ''))) children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(part) } });
  const info = [
    ctx.site && `사이트: ${ctx.site}`, ctx.step && `단계: ${ctx.step}`, ctx.width && `화면 폭: ${ctx.width}`,
    ctx.lang && `사이트 언어: ${ctx.lang}`, fb.version && `앱 버전: ${fb.version}`, ctx.os && `컴퓨터: ${ctx.os}`,
    fb.at && `보낸 때: ${fb.at}`,
  ].filter(Boolean);
  if (info.length) {
    children.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rt('보낸 화면 정보') } });
    for (const line of info) children.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(line) } });
  }
  if (ctx.log && ctx.log.length) {
    children.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: rt('작업 기록 (마지막 줄들)') } });
    children.push({ object: 'block', type: 'code', code: { language: 'plain text', rich_text: rt(ctx.log.slice(-15).join('\n')) } });
  }
  const props = {
    '제목': { title: rt(title) },
    '종류': { select: { name: kind } },
    '상태': { status: { name: '접수' } },
    '보낸 사람': { rich_text: rt(fb.name || '') },
    '내용': { rich_text: rt(fb.body || '') },
    '단계': { rich_text: rt(ctx.step || '') },
    '앱 버전': { rich_text: rt(fb.version || '') },
  };
  if (ctx.site && /^https?:\/\//.test(ctx.site)) props['사이트 주소'] = { url: ctx.site.slice(0, 2000) };
  return { properties: props, children };
}

async function sendOne(fb) {
  const page = pageFor(fb);
  let r = await notion('POST', '/v1/pages', { parent: { database_id: DATABASE_ID }, ...page });
  // 새 노션 API(데이터 소스)만 받는 표라면 그 방식으로 다시
  if (r.status === 400 && /data.?source/i.test(JSON.stringify(r.body))) {
    r = await notion('POST', '/v1/pages', { parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID }, ...page }, '2025-09-03');
  }
  if (r.status === 200) return { ok: true, url: r.body.url };
  return { ok: false, status: r.status, error: explain(r.status, r.body) };
}

const keep = (fb) => { const box = readJson(OUTBOX, []); box.push(fb); writeJson(OUTBOX, box); return box.length; };

/** 피드백 하나를 보낸다. 못 보내면 모아 둔다 — 버리지 않는다. */
export async function sendFeedback(fb) {
  const item = { ...fb, at: fb.at || new Date().toLocaleString('ko-KR') };
  if (!String(item.body || '').trim()) return { ok: false, error: '내용을 적어 주세요' };
  if (!token()) { const n = keep(item); return { ok: true, queued: true, waiting: n, needKey: true }; }
  try {
    const r = await sendOne(item);
    if (r.ok) { const sent = await flushOutbox(); return { ok: true, url: r.url, sent }; }
    if (r.status === 400) return { ok: false, error: r.error };          // 내용 문제 — 모아 둬도 또 실패한다
    const n = keep(item);
    return { ok: true, queued: true, waiting: n, warn: r.error, needKey: r.status === 401 };
  } catch (e) {
    const n = keep(item);
    return { ok: true, queued: true, waiting: n, warn: `노션에 닿지 못했어요 (${e.message}) — 저장해 두었다가 다음에 보낼게요` };
  }
}

/** 모아 둔 것을 보낸다 (키를 넣었을 때, 다음 피드백을 보낼 때, 앱을 켤 때) */
export async function flushOutbox() {
  if (!token()) return 0;
  const box = readJson(OUTBOX, []);
  if (!box.length) return 0;
  const left = []; let sent = 0;
  for (const fb of box) {
    try { const r = await sendOne(fb); if (r.ok) sent++; else if (r.status !== 400) left.push(fb); } catch { left.push(fb); }
  }
  if (left.length) writeJson(OUTBOX, left); else writeJson(OUTBOX, []);
  return sent;
}

export const FEEDBACK_DB_URL = `https://www.notion.so/${DATABASE_ID}`;
