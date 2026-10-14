/**
 * 바탕화면에 "웹사이트 스냅샷.app" 을 만든다 — 맥에서만. 더블클릭하면 터미널 없이 켜진다.
 *
 * 앱은 맥 기본 osacompile 로 만든다(스크립트 편집기로 만든 앱과 같은 것). 셸 스크립트를 실행
 * 파일로 직접 넣은 앱 묶음은 최근 macOS 가 "열 수 없습니다"로 막는다 — 실제로 막혔다.
 * osacompile 앱은 진짜 맥 실행 파일(서명된 applet)이라 그대로 열린다.
 *
 * 앱이 하는 일은 한 줄: 저장소의 mac/launcher.sh 를 실행한다. 그래서 launcher.sh 가 나아지면
 * git pull 만으로 따라온다 — 앱 묶음은 다시 만들 필요가 없다(그림을 바꿨을 때만).
 * 아이콘은 카메라 그림으로 바꾸고, 묶음을 고쳤으니 이 컴퓨터용 서명(ad-hoc)을 다시 한다.
 *
 *   node macapp.mjs        만들거나(필요하면 다시) 만든다
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_NAME = '웹사이트 스냅샷';
const VERSION = 'applet-1';   // 앱 묶음 만드는 법을 바꾸면 올린다 — 이미 만든 앱도 다시 만든다
export const appPath = (home = homedir()) => join(home, 'Desktop', `${APP_NAME}.app`);
const markFile = (home = homedir()) => join(home, 'Library', 'Application Support', 'website-snapshot', 'app.txt');

/** AppleScript 문자열 안에 넣을 수 있게 */
const asStr = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** 앱이 실행할 AppleScript. 실패해도 대화상자 대신 조용히 끝낸다(launcher.sh 가 스스로 알린다). */
export function appleScript(appDir = HERE) {
  const sh = join(appDir, 'mac', 'launcher.sh');
  return [
    'try',
    `\tdo shell script "/bin/bash " & quoted form of ${asStr(sh)} & " " & quoted form of ${asStr(appDir)} & " >/dev/null 2>&1"`,
    'end try',
  ];
}

/** icon/icon.png → icns (맥 기본 sips·iconutil). 못 만들면 null */
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

const run = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };

/** 지금 그대로 써도 되는 앱인가 — 예전 방식(셸 스크립트 실행 파일)이나 다른 그림이면 다시 만든다 */
function upToDate(app, home) {
  if (!existsSync(join(app, 'Contents', 'Info.plist'))) return false;
  if (existsSync(join(app, 'Contents', 'MacOS', 'snapshot'))) return false;   // 막히던 예전 앱
  const mark = markFile(home);
  return existsSync(mark) && readFileSync(mark, 'utf8') === want();
}
const want = () => {
  const png = join(HERE, 'icon', 'icon.png');
  return `${VERSION}\n${HERE}\n${existsSync(png) ? readFileSync(png).length : 0}`;
};

/**
 * 앱을 만들거나 다시 만든다. 맥이 아니면 아무것도 안 한다.
 * @returns {{path:string, rebuilt:boolean, icon:boolean, signed:boolean}|null}
 */
export function ensureMacApp(opts = {}) {
  if (process.platform !== 'darwin') return null;
  const home = opts.home || homedir();
  const app = appPath(home);
  try {
    if (!opts.force && upToDate(app, home)) return { path: app, rebuilt: false, icon: true, signed: true };
    mkdirSync(dirname(app), { recursive: true });
    rmSync(app, { recursive: true, force: true });
    const args = ['-o', app];
    for (const line of appleScript()) args.push('-e', line);
    execFileSync('osacompile', args, { stdio: 'ignore' });
    const res = join(app, 'Contents', 'Resources');
    const plist = join(app, 'Contents', 'Info.plist');
    // 카메라 아이콘으로 — applet.icns 를 바꾸고, 그림 묶음(Assets.car)이 있으면 그쪽이 앞서므로 뗀다
    let icon = false;
    const icns = makeIcns();
    if (icns) {
      for (const f of readdirSync(res)) if (f.endsWith('.icns')) writeFileSync(join(res, f), icns);
      if (!existsSync(join(res, 'applet.icns'))) writeFileSync(join(res, 'applet.icns'), icns);
      if (existsSync(join(res, 'Assets.car'))) { rmSync(join(res, 'Assets.car'), { force: true }); run('plutil', ['-remove', 'CFBundleIconName', plist]); }
      run('plutil', ['-replace', 'CFBundleIconFile', '-string', 'applet', plist]);
      icon = true;
    }
    run('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.website-snapshot.launcher', plist]);
    // 묶음을 고쳤으니 이 컴퓨터용 서명을 다시 한다(안 하면 "손상됨"으로 막힐 수 있다)
    const signed = run('codesign', ['--force', '--deep', '--sign', '-', app]);
    run('xattr', ['-dr', 'com.apple.quarantine', app]);
    run('touch', [app]);
    // 맥이 새 앱(아이콘)을 알아보게
    run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app]);
    mkdirSync(dirname(markFile(home)), { recursive: true });
    writeFileSync(markFile(home), want());
    return { path: app, rebuilt: true, icon, signed };
  } catch (e) {
    return { path: app, rebuilt: false, icon: false, signed: false, error: e.message.split('\n')[0] };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.platform !== 'darwin') { console.log('맥이 아니라 앱은 건너뜁니다'); process.exit(0); }
  const r = ensureMacApp({ force: process.argv.includes('--force') });
  if (!r || r.error) console.log(`앱을 만들지 못했습니다${r && r.error ? ': ' + r.error : ''}`);
  else console.log(`${r.path} ✓${r.rebuilt ? ' (새로 만듦)' : ' (이미 최신)'}${r.icon ? '' : ' · 아이콘 없이'}${r.signed ? '' : ' · 서명 못 함'}`);
}
