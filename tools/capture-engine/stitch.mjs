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
 * 두 조각의 위쪽 띠가 같은지 잰다 — 따라붙는 헤더가 두 조각에 다 찍혔는지.
 * 위에서부터 줄마다 견주어, 첫 조각에 내용이 있는 줄이 둘째 조각과 같으면 띠에 넣는다.
 * 바탕이 같은 색이라 같은 줄(내용 없는 줄)은 판단에서 뺀다. 돌려주는 값은 띠 높이(px, 실픽셀).
 */
export async function repeatedTopBand(page, bufA, bufB, maxPx) {
  return page.evaluate(async ({ a, b, maxPx }) => {
    const load = async (b64) => createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const [ba, bb] = await Promise.all([load(a), load(b)]);
    const w = Math.min(ba.width, bb.width), h = Math.min(ba.height, bb.height, maxPx);
    const cv = new OffscreenCanvas(w, h), cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(ba, 0, 0); const A = cx.getImageData(0, 0, w, h).data;
    cx.clearRect(0, 0, w, h);
    cx.drawImage(bb, 0, 0); const B = cx.getImageData(0, 0, w, h).data;
    ba.close(); bb.close();
    // 줄마다 "내용 픽셀"(그 줄 왼쪽 가장자리 색과 다른 픽셀)만 견준다. 헤더 뒤의 바탕은
    // 조각마다 다르다(히어로 사진 위 vs 어두운 구간 위) — 바탕까지 같길 바라면 아무것도 못 잡는다.
    const step = 2;
    let band = 0, lastContent = -1, blank = 0;
    for (let y = 0; y < h; y++) {
      const i0 = (y * w + 2) * 4;
      const r0 = A[i0], g0 = A[i0 + 1], b0 = A[i0 + 2];
      let content = 0, matched = 0, n = 0;
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        n++;
        const isContent = Math.abs(A[i] - r0) > 24 || Math.abs(A[i + 1] - g0) > 24 || Math.abs(A[i + 2] - b0) > 24;
        if (!isContent) continue;
        content++;
        if (Math.abs(A[i] - B[i]) <= 12 && Math.abs(A[i + 1] - B[i + 1]) <= 12 && Math.abs(A[i + 2] - B[i + 2]) <= 12) matched++;
      }
      if (content >= n * 0.02) {
        if (matched < content * 0.9) break;   // 첫 조각의 내용이 둘째 조각엔 없다 — 띠 끝
        lastContent = y; blank = 0;
      } else if (++blank > 60 && lastContent >= 0) break;   // 헤더가 끝나고 한참 비었다
      band = y + 1;
    }
    return lastContent >= 0 ? Math.min(band, lastContent + 1) : 0;
  }, { a: bufA.toString('base64'), b: bufB.toString('base64'), maxPx });
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
