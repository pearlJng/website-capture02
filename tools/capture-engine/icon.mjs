/**
 * 실행 파일(웹사이트 스냅샷.command)에 카메라 아이콘을 입힌다 — 맥에서만.
 *
 * 파일 아이콘은 git 으로 옮겨지지 않는다(맥의 파일 속성에 붙는다). 그래서 그림은 icon/icon.png 로
 * 두고, 앱이 켜질 때 바탕화면의 실행 파일에 한 번 입힌다. install.sh 는 실행 파일을 만든 직후 입힌다.
 *
 *   node icon.mjs           바탕화면·저장소의 실행 파일에 아이콘을 입힌다 (이미 입혔어도 다시)
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PNG = join(HERE, 'icon', 'icon.png');
const VERSION = 'camera-5';    // 그림을 바꾸면 올린다 — 이미 입힌 사람에게도 새 그림이 다시 입혀진다
const MARK = join(homedir(), 'Library', 'Application Support', 'website-snapshot', 'icon.txt');

export const launcherPaths = () => [
  join(homedir(), 'Desktop', '웹사이트 스냅샷.command'),
  join(HERE, '웹사이트 스냅샷.command'),
].filter((p) => existsSync(p));

// NSWorkspace setIcon:forFile:options: — 맥에 기본으로 있는 osascript(JavaScript)로 부른다. 경로는 인자로 넘긴다.
const JXA = `function run(argv) {
  ObjC.import('AppKit');
  const img = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  if (!img || img.isNil()) return 'no-image';
  let ok = 0;
  for (const p of argv.slice(1)) if ($.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, p, 0)) ok++;
  return String(ok);
}`;

export function setIcons(paths) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin' || !paths.length || !existsSync(PNG)) return resolve(0);
    execFile('osascript', ['-l', 'JavaScript', '-e', JXA, PNG, ...paths], { timeout: 15000 }, (err, out) => {
      resolve(err ? 0 : Number(String(out).trim()) || 0);
    });
  });
}

/**
 * 바탕화면의 실행 파일은 설치할 때 복사해 둔 것이라, 저장소의 실행 파일이 나아져도 그대로다.
 * 앱이 켜질 때 내용이 다르면 새 내용으로 덮는다 — 같은 파일에 덮어써서 아이콘은 그대로 남는다.
 */
export function syncLauncher() {
  try {
    const src = join(HERE, '웹사이트 스냅샷.command');
    const dst = join(homedir(), 'Desktop', '웹사이트 스냅샷.command');
    if (!existsSync(src) || !existsSync(dst)) return false;
    const next = readFileSync(src);
    if (readFileSync(dst).equals(next)) return false;
    writeFileSync(dst, next);
    chmodSync(dst, 0o755);
    return true;
  } catch { return false; }
}

/** 앱이 켜질 때 부른다. 이 그림을 이미 입혔으면 건너뛴다. 실패해도 앱은 그대로 켜진다. */
export async function applyLauncherIconOnce() {
  try {
    if (process.platform !== 'darwin') return;
    const paths = launcherPaths();
    const want = `${VERSION}\n${paths.join('\n')}`;
    if (existsSync(MARK) && readFileSync(MARK, 'utf8') === want) return;
    const n = await setIcons(paths);
    if (n) { mkdirSync(dirname(MARK), { recursive: true }); writeFileSync(MARK, want); }
  } catch { /* 아이콘은 꾸밈이다 — 안 돼도 넘어간다 */ }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const paths = launcherPaths();
  const n = await setIcons(paths);
  console.log(process.platform !== 'darwin' ? '맥이 아니라 아이콘은 건너뜁니다' : n ? `카메라 아이콘 입힘 ✓ (${n}개)` : '아이콘을 입히지 못했습니다 (앱 사용에는 지장 없음)');
}
