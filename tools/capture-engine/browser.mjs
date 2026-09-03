/**
 * browser.mjs — 크로미움이 죽어도 실행이 끝나지 않게 한다.
 *
 * 헤드리스 브라우저는 가끔 통째로 죽는다. 렌더러가 크래시하거나, 메모리가
 * 모자라거나, 특정 페이지가 컴포지터를 넘어뜨린다. 한 번 죽으면 그 브라우저로
 * 만든 컨텍스트·페이지가 전부 무효가 되므로, 49건짜리 실행 도중에 나면
 * 남은 전부가 실패로 기록된다.
 *
 * 그래서 브라우저를 직접 들고 다니지 않고 이 호스트를 통해 꺼내 쓴다.
 * 죽어 있으면 알아서 새로 띄운다.
 */
import { chromium } from 'playwright';

const BASE_ARGS = ['--disable-dev-shm-usage'];

/**
 * 브라우저를 고르는 순서.
 *
 * Playwright 가 들고 다니는 크로미움은 **오픈소스 빌드**라 H.264(MP4)와 AAC
 * 코덱이 없다. 이 코덱들은 특허가 걸려 있어 구글이 라이선스를 사서 브랜드
 * 크롬에만 넣기 때문이다. 유튜브 임베드나 MP4 비디오가 있는 페이지를 그
 * 크로미움으로 열면 플레이어가 "재생할 수 없음" 오류 화면을 띄우고,
 * 캡처에는 그 오류 화면이 그대로 박힌다.
 *
 * GoFullPage 같은 확장이 멀쩡한 이유가 이것이다 — 사용자가 쓰는 진짜 크롬
 * 안에서 돌기 때문이다. 그래서 여기서도 설치된 크롬을 먼저 찾는다.
 */
const CHANNELS = ['chrome', 'msedge'];

/** 이 컴퓨터에서 쓸 수 있는 브라우저를 한 번만 찾아 기억한다. */
let picked = null;
export async function pickBrowser(prefer) {
  if (picked && !prefer) return picked;
  const order = prefer && prefer !== 'auto' ? [prefer] : CHANNELS;
  for (const channel of order) {
    if (channel === 'chromium') break;
    try {
      const b = await chromium.launch({ channel, args: BASE_ARGS });
      await b.close();
      picked = { channel, name: channel === 'chrome' ? '크롬' : '엣지', codecs: true };
      return picked;
    } catch { /* 안 깔려 있으면 다음 후보로 */ }
  }
  picked = { channel: null, name: '크로미움(번들)', codecs: false };
  return picked;
}

/** 브라우저가 죽어서 난 오류인지 가려낸다. 이건 재시도할 가치가 있다. */
const DEATH = /(Target|Browser|browser|page|context)[^\n]*(has been closed|closed|crashed)|Protocol error[^\n]*Target closed|Target crashed|browserType\.launch/i;
export const isBrowserDeath = (msg) => typeof msg === 'string' && DEATH.test(msg);

export function createBrowserHost(launchOpts = {}) {
  let browser = null;
  let launching = null;
  let restarts = 0;

  async function get() {
    if (browser && browser.isConnected()) return browser;
    if (browser) { restarts++; browser = null; }
    if (!launching) {
      launching = pickBrowser(launchOpts.prefer)
        .then((pick) => {
          const opts = { args: BASE_ARGS, ...launchOpts };
          delete opts.prefer;
          if (pick.channel) opts.channel = pick.channel;
          return chromium.launch(opts);
        })
        .then((b) => { browser = b; launching = null; return b; })
        .catch((e) => { launching = null; throw e; });
    }
    return launching;
  }

  return {
    get,
    /** 실제로 뭘 띄웠는지. 코덱이 없는 브라우저면 사용자에게 알려야 한다. */
    get browserInfo() { return picked; },
    get restarts() { return restarts; },
    alive: () => Boolean(browser && browser.isConnected()),
    async close() {
      const b = browser;
      browser = null;
      if (b) await b.close().catch(() => {});
    },
  };
}
