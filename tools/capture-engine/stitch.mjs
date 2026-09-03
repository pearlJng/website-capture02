/**
 * stitch.mjs — 화면 단위로 찍은 조각들을 한 장으로 이어 붙인다.
 *
 * 왜 이어 붙이는가. 풀페이지 한 방 캡처는 문서 전체를 한 번에 그리는데,
 * 그때 화면 밖 콘텐츠는 "화면 밖" 상태다. 등장 애니메이션 대부분이
 * 들어올 때 클래스를 붙이고 **나갈 때 떼기** 때문에, 맨 위로 돌아와 찍으면
 * 아래쪽이 전부 다시 투명해진 채로 찍힌다. 실측에서 6칸 중 5칸이 그랬다.
 *
 * GoFullPage 같은 확장이 멀쩡한 이유가 이것이다 — 각 칸이 화면에 있는 동안
 * 그 화면을 찍는다. 여기서도 같은 방식을 쓴다.
 *
 * 붙이는 일은 브라우저의 캔버스로 한다. 한 장씩 넣어 그리므로 큰 그림도
 * 한꺼번에 주고받지 않는다.
 */

/** 캔버스를 만든다. 이 페이지는 붙이기 전용이며 대상 사이트와 무관하다. */
async function begin(page, width, height, bg) {
  await page.evaluate(({ w, h, c }) => {
    const cv = new OffscreenCanvas(w, h);
    const cx = cv.getContext('2d');
    cx.fillStyle = c;
    cx.fillRect(0, 0, w, h);
    window.__stitch = { cv, cx };
  }, { w: width, h: height, c: bg || '#ffffff' });
}

/** 조각 하나를 제자리에 그린다. 겹치는 부분은 나중 것이 덮는다. crop 만큼 위를 잘라내고 그린다. */
async function add(page, buf, y, crop = 0) {
  await page.evaluate(async ({ b64, top, crop }) => {
    const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
    const bmp = await createImageBitmap(blob);
    if (crop > 0 && crop < bmp.height) {
      window.__stitch.cx.drawImage(bmp, 0, crop, bmp.width, bmp.height - crop, 0, top + crop, bmp.width, bmp.height - crop);
    } else {
      window.__stitch.cx.drawImage(bmp, 0, top);
    }
    bmp.close();
  }, { b64: buf.toString('base64'), top: y, crop });
}

/**
 * 여러 조각의 위쪽 띠에 같은 것이 찍혀 있는지 잰다 — 따라붙는 헤더.
 *
 * 견주는 법. 조각들 중 위쪽 바탕이 가장 잠잠한 것을 기준으로 삼고(히어로 사진 위에
 * 얹힌 첫 조각은 온 픽셀이 '내용'이라 기준이 못 된다 — 테라클에서 그래서 못 잡았다),
 * 기준 조각에서 그 줄 바탕과 다른 픽셀(내용)이 **다른 모든 조각에서도 같은 값**이면
 * 헤더 픽셀이다. 스크롤 위치가 셋이나 다른데 같은 자리에 같은 픽셀이 있는 건
 * 우연이 아니다. offset 은 이미 잘라낸 만큼(검수용).
 * 돌려주는 값은 띠 높이(실픽셀), 없으면 0.
 */
export async function repeatedTopBand(page, bufs, maxPx, offset = 0) {
  if (!Array.isArray(bufs) || bufs.length < 2) return 0;
  return page.evaluate(async ({ list, maxPx, offset }) => {
    const load = async (b64) => createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const bmps = await Promise.all(list.map(load));
    const w = Math.min(...bmps.map((b) => b.width));
    const h = Math.min(...bmps.map((b) => b.height), offset + maxPx) - offset;
    if (h <= 0) return 0;
    const cv = new OffscreenCanvas(w, h), cx = cv.getContext('2d', { willReadFrequently: true });
    const data = bmps.map((b) => { cx.clearRect(0, 0, w, h); cx.drawImage(b, 0, -offset); return cx.getImageData(0, 0, w, h).data; });
    for (const b of bmps) b.close();
    const step = 2;
    const nonbg = (D, y, x) => {
      const i0 = (y * w + 2) * 4, i = (y * w + x) * 4;
      return Math.abs(D[i] - D[i0]) > 24 || Math.abs(D[i + 1] - D[i0 + 1]) > 24 || Math.abs(D[i + 2] - D[i0 + 2]) > 24;
    };
    // 기준: 위쪽 띠에 내용 픽셀이 가장 적은 조각 (바탕이 잠잠한 것)
    let ref = 0, refContent = Infinity;
    data.forEach((D, k) => {
      let c = 0;
      for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 6) if (nonbg(D, y, x)) c++;
      if (c < refContent) { refContent = c; ref = k; }
    });
    const R = data[ref];
    const others = data.filter((_, k) => k !== ref);
    let band = 0, lastContent = -1, blank = 0;
    for (let y = 0; y < h; y++) {
      let content = 0, matched = 0, n = 0;
      for (let x = 0; x < w; x += step) {
        n++;
        if (!nonbg(R, y, x)) continue;
        content++;
        const i = (y * w + x) * 4;
        let eq = true;
        for (const O of others) {
          if (Math.abs(R[i] - O[i]) > 12 || Math.abs(R[i + 1] - O[i + 1]) > 12 || Math.abs(R[i + 2] - O[i + 2]) > 12) { eq = false; break; }
        }
        if (eq) matched++;
      }
      if (content >= n * 0.02) {
        if (matched < content * 0.85) break;   // 기준 조각의 내용이 다른 조각엔 없다 — 띠 끝
        lastContent = y; blank = 0;
      } else if (++blank > 60 && lastContent >= 0) break;   // 헤더가 끝나고 한참 비었다
      band = y + 1;
    }
    return lastContent >= 0 ? Math.min(band, lastContent + 1) : 0;
  }, { list: bufs.map((b) => b.toString('base64')), maxPx, offset });
}

/** 다 그린 캔버스를 PNG 로 받아 온다. */
async function end(page) {
  const b64 = await page.evaluate(async () => {
    const blob = await window.__stitch.cv.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CH = 8192;   // 한 번에 다 넘기면 인자 길이 제한에 걸린다
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    window.__stitch = null;
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

/**
 * 화면 조각들을 세로로 이어 붙인다.
 *
 * @param page   붙이기 전용 빈 페이지
 * @param shots  [{ y, buf }] — y 는 문서 좌표(CSS px), buf 는 화면 크기 PNG
 * @param opts   { width, height, scale, maxHeight, background }
 *               height 는 문서 높이(CSS px). maxHeight 를 넘으면 여러 장으로 나눈다.
 * @returns {Promise<Buffer[]>}
 */
export async function stitchShots(page, shots, opts) {
  const scale = opts.scale || 1;
  const pxW = Math.round(opts.width * scale);
  const pxH = Math.round(opts.height * scale);
  const maxPx = Math.max(1, Math.round((opts.maxHeight || Infinity) * scale));
  const parts = Math.max(1, Math.ceil(pxH / maxPx));
  const partPx = Math.ceil(pxH / parts);

  const out = [];
  for (let p = 0; p < parts; p++) {
    const from = p * partPx;
    const to = Math.min(pxH, from + partPx);
    await begin(page, pxW, to - from, opts.background);
    for (const s of shots) {
      const top = Math.round(s.y * scale);
      const bottom = top + Math.round(s.height * scale);
      if (bottom <= from || top >= to) continue;   // 이 조각과 겹치지 않는다
      await add(page, s.buf, top - from, Math.round((s.crop || 0) * scale));
    }
    out.push(await end(page));
  }
  return out;
}
