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
      launching = chromium
        .launch({ args: BASE_ARGS, ...launchOpts })
        .then((b) => { browser = b; launching = null; return b; })
        .catch((e) => { launching = null; throw e; });
    }
    return launching;
  }

  return {
    get,
    get restarts() { return restarts; },
    alive: () => Boolean(browser && browser.isConnected()),
    async close() {
      const b = browser;
      browser = null;
      if (b) await b.close().catch(() => {});
    },
  };
}
