/**
 * 바탕화면에 "웹사이트 스냅샷.app" 을 만든다 — 맥에서만. 더블클릭하면 터미널 없이 켜진다.
 *
 * 앱 묶음(.app)은 폴더다: Contents/Info.plist(이름·아이콘), Contents/MacOS/snapshot(실행 파일 =
 * mac/launcher.sh), Contents/Resources/AppIcon.icns(카메라 아이콘). 실행 파일 안의 설치 자리는
 * 이 저장소의 실제 자리로 채운다. 앱이 켜질 때마다 내용이 다르면 고쳐 쓴다(저장소가 나아지면 따라온다).
 *
 *   node macapp.mjs        만들거나 고쳐 쓴다
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_NAME = '웹사이트 스냅샷';
export const appPath = (home = homedir()) => join(home, 'Desktop', `${APP_NAME}.app`);

const plist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>com.website-snapshot.launcher</string>
  <key>CFBundleExecutable</key><string>snapshot</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;

/** 내용이 다를 때만 쓴다. 바뀌었으면 true */
function put(file, data, mode) {
  const next = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (existsSync(file) && readFileSync(file).equals(next)) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  if (mode) chmodSync(file, mode);
  return true;
}

/** icon/icon.png → AppIcon.icns (맥 기본 sips·iconutil). 못 만들면 null */
function makeIcns() {
  const png = join(HERE, 'icon', 'icon.png');
  if (!existsSync(png)) return null;
  const work = mkdtempSync(join(tmpdir(), 'snapshot-icon-'));
  try {
    const set = join(work, 'AppIcon.iconset');
    mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      execFileSync('sips', ['-z', String(s), String(s), png, '--out', join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
      execFileSync('sips', ['-z', String(s * 2), String(s * 2), png, '--out', join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
    }
    const out = join(work, 'AppIcon.icns');
    execFileSync('iconutil', ['-c', 'icns', set, '-o', out], { stdio: 'ignore' });
    return readFileSync(out);
  } catch { return null; } finally { rmSync(work, { recursive: true, force: true }); }
}

/**
 * 앱 묶음을 만들거나 고쳐 쓴다. 맥이 아니면 아무것도 안 한다(시험에서는 opts.force 로 만든다).
 * @returns {{path:string, changed:boolean, icon:boolean}|null}
 */
export function ensureMacApp(opts = {}) {
  if (process.platform !== 'darwin' && !opts.force) return null;
  try {
    const app = opts.path || appPath(opts.home);
    const contents = join(app, 'Contents');
    const script = readFileSync(join(HERE, 'mac', 'launcher.sh'), 'utf8').replace(/__APP_DIR__/g, HERE);
    let changed = false;
    changed = put(join(contents, 'Info.plist'), plist()) || changed;
    changed = put(join(contents, 'MacOS', 'snapshot'), script, 0o755) || changed;
    let icon = existsSync(join(contents, 'Resources', 'AppIcon.icns'));
    const iconPng = join(HERE, 'icon', 'icon.png');
    const stamp = join(contents, 'Resources', 'icon-source.txt');
    const want = existsSync(iconPng) ? String(readFileSync(iconPng).length) : '';
    if (!icon || (existsSync(stamp) ? readFileSync(stamp, 'utf8') : '') !== want) {
      const icns = makeIcns();
      if (icns) { put(join(contents, 'Resources', 'AppIcon.icns'), icns); put(stamp, want); icon = true; changed = true; }
    }
    // 맥이 바뀐 아이콘·이름을 다시 읽게 한다
    if (changed && process.platform === 'darwin') { try { execFileSync('touch', [app]); } catch { /* 무시 */ } }
    return { path: app, changed, icon };
  } catch { return null; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = ensureMacApp();
  console.log(!r ? (process.platform === 'darwin' ? '앱을 만들지 못했습니다' : '맥이 아니라 앱은 건너뜁니다') : `${r.path} ✓${r.icon ? '' : ' (아이콘 없이)'}`);
}
