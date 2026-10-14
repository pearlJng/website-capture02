// 맥에서 앱 서버가 켜질 때 따로 띄워 돌리는 정리 — 바탕화면 실행 파일 맞추기, 아이콘 입히기, 앱 묶음 만들기.
// 몇 초~십수 초 걸리는 일(osacompile·sips·codesign)이라 서버 프로세스 밖에서 한다.
import { applyLauncherIconOnce, syncLauncher } from '../icon.mjs';
import { ensureMacApp } from '../macapp.mjs';

if (process.platform === 'darwin') {
  for (const [name, fn] of [['실행 파일 맞추기', syncLauncher], ['아이콘 입히기', applyLauncherIconOnce], ['앱 묶음', ensureMacApp]]) {
    try { await fn(); } catch (e) { console.log(`${name} 실패: ${e.message}`); }
  }
}
