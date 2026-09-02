/**
 * diff.mjs — 두 번 찍은 결과가 같은지 판정한다.
 *
 * 이게 채점의 전부다. 티어 정의가 곧 채점 기준이기 때문이다:
 *   T0~T2 는 두 번 찍어 같아야 정상이고, T4 는 원리적으로 같을 수 없다.
 * 사람이 눈으로 검수할 필요가 없다.
 *
 * 통과하는 경우는 바이트 비교만으로 끝난다(디코딩 0회). 다를 때만 실제로
 * 픽셀을 펼쳐서 "얼마나" 다른지 잰다 — 스피너 하나와 페이지 전체가 밀린 것은
 * 대응이 완전히 다르므로 구분해야 한다.
 */

/** PNG 헤더에서 크기만 읽는다. 디코딩하지 않는다. */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export const VERDICT = {
  SAME: '동일',
  SAME_PIXELS: '픽셀동일',
  DIFF: '다름',
  SHAPE: '구조다름',
};

/** 픽셀 비교에 쓸 최대 넓이. 넘으면 축소해서 비교한다(메모리 상한). */
const MAX_COMPARE_PIXELS = 4_000_000;

/**
 * 세로 높이가 이 정도까지 다른 건 "구조가 달라졌다"고 보지 않는다.
 *
 * 실측에서 코오롱몰이 15,519px 대 15,515px — 4픽셀 차이로 100% 실패 처리됐다.
 * 폰트가 한 글자 다르게 줄바꿈되거나 지연 이미지 하나가 1px 다르게 잡히면
 * 문서 높이가 그만큼 흔들린다. 그걸 페이지가 통째로 달라진 것과 같은 칸에
 * 넣으면 안 된다. 겹치는 영역을 실제로 비교하고, 높이 차이는 따로 적는다.
 */
const heightTolerance = (h) => Math.min(Math.round(h * 0.01), 300);

/** 브라우저 안에서 두 PNG 를 펼쳐 다른 픽셀 비율을 센다. */
async function inPageDiff(job) {
  const load = async (b64) => {
    const res = await fetch('data:image/png;base64,' + b64);
    const blob = await res.blob();
    const opts = job.rw
      ? { resizeWidth: job.rw, resizeHeight: job.rh, resizeQuality: 'pixelated' }
      : null;
    // 높이가 다르면 겹치는 위쪽만 잘라서 비교한다.
    if (job.cropH) {
      return opts ? createImageBitmap(blob, 0, 0, job.cropW, job.cropH, opts)
                  : createImageBitmap(blob, 0, 0, job.cropW, job.cropH);
    }
    return opts ? createImageBitmap(blob, opts) : createImageBitmap(blob);
  };
  const [ia, ib] = await Promise.all([load(job.a), load(job.b)]);
  if (ia.width !== ib.width || ia.height !== ib.height) {
    return { shape: true, aw: ia.width, ah: ia.height, bw: ib.width, bh: ib.height };
  }
  const w = ia.width, h = ia.height;
  const cv = new OffscreenCanvas(w, h);
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(ia, 0, 0);
  const da = cx.getImageData(0, 0, w, h).data;
  cx.clearRect(0, 0, w, h);
  cx.drawImage(ib, 0, 0);
  const db = cx.getImageData(0, 0, w, h).data;
  ia.close(); ib.close();

  // 몇 개가 다른지만 세지 말고 어디가 다른지도 잡는다. 0.01% 짜리 차이는
  // 좌표를 모르면 9,000px 짜리 그림 두 장을 눈으로 훑어야 한다.
  let differing = 0, firstY = -1;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  let bands = 0, prevRow = -2;
  for (let y = 0; y < h; y++) {
    let rowHit = false;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (da[i] === db[i] && da[i + 1] === db[i + 1] && da[i + 2] === db[i + 2] && da[i + 3] === db[i + 3]) continue;
      differing++;
      rowHit = true;
      if (firstY < 0) firstY = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (rowHit) {
      if (y !== prevRow + 1) bands++;   // 떨어져 있는 덩어리 수 — 한 덩어리면 원인도 하나다
      prevRow = y;
    }
  }
  return { shape: false, total: w * h, differing, firstY, w, h, minX, minY, maxX, maxY, bands };
}

/**
 * 다른 부분만 잘라 위아래로 붙인 그림을 만든다.
 * 1차 / 2차 / 차이 마스크 세 줄. 이거 한 장만 열면 무엇이 달라졌는지 보인다.
 */
async function inPageStrip(job) {
  const load = (b64) => fetch('data:image/png;base64,' + b64)
    .then((r) => r.blob())
    .then((bl) => createImageBitmap(bl, job.x, job.y, job.w, job.h));
  const [ia, ib] = await Promise.all([load(job.a), load(job.b)]);

  const LABEL = 20, GAP = 6;
  const cv = new OffscreenCanvas(job.w, LABEL + (job.h + LABEL + GAP) * 2 + job.h);
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = job.bg;
  cx.fillRect(0, 0, cv.width, cv.height);

  const band = (img, label, top) => {
    cx.fillStyle = job.fg;
    cx.font = '600 13px ui-monospace, Menlo, monospace';
    cx.fillText(label, 6, top + 14);
    if (img) cx.drawImage(img, 0, top + LABEL);
    return top + LABEL + job.h + GAP;
  };

  let top = band(ia, '1차', 0);
  top = band(ib, '2차', top);

  // 차이 마스크 — 다른 픽셀만 강조색으로 찍는다
  const tmp = new OffscreenCanvas(job.w, job.h);
  const tx = tmp.getContext('2d', { willReadFrequently: true });
  tx.drawImage(ia, 0, 0);
  const A = tx.getImageData(0, 0, job.w, job.h).data;
  tx.clearRect(0, 0, job.w, job.h);
  tx.drawImage(ib, 0, 0);
  const B = tx.getImageData(0, 0, job.w, job.h).data;
  const out = tx.createImageData(job.w, job.h);
  const O = out.data;
  for (let i = 0; i < A.length; i += 4) {
    const same = A[i] === B[i] && A[i + 1] === B[i + 1] && A[i + 2] === B[i + 2] && A[i + 3] === B[i + 3];
    O[i] = same ? 236 : 196;
    O[i + 1] = same ? 233 : 30;
    O[i + 2] = same ? 240 : 130;
    O[i + 3] = 255;
  }
  tx.putImageData(out, 0, 0);
  cx.fillStyle = job.fg;
  cx.font = '600 13px ui-monospace, Menlo, monospace';
  cx.fillText('차이', 6, top + 14);
  cx.drawImage(tmp, 0, top + LABEL);

  ia.close(); ib.close();
  const blob = await cv.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** 잘라낼 세로 높이의 상한. 이보다 넓게 퍼져 있으면 어차피 눈으로 봐야 한다. */
const STRIP_MAX_H = 360;

/**
 * 차이 구간을 잘라 붙인 PNG 를 만든다. 구간 정보가 없으면 null.
 * @returns {Promise<Buffer|null>}
 */
export async function renderDiffStrip(page, a, b, region) {
  if (!region || !region.h) return null;
  const size = pngSize(a);
  if (!size) return null;
  const margin = 24;
  const y = Math.max(0, region.y - margin);
  const h = Math.min(STRIP_MAX_H, size.height - y, region.h + margin * 2);
  if (h <= 0) return null;
  const b64 = await page.evaluate(inPageStrip, {
    a: a.toString('base64'), b: b.toString('base64'),
    x: 0, y, w: size.width, h,
    bg: '#141219', fg: '#EEEBF3',
  });
  return Buffer.from(b64, 'base64');
}

/**
 * PNG 두 장을 비교한다.
 * @param {import('playwright').Page} page 비교 전용 빈 페이지
 */
export async function comparePngs(page, a, b) {
  if (a.length === b.length && a.equals(b)) {
    return { verdict: VERDICT.SAME, ratio: 0 };
  }
  const sa = pngSize(a), sb = pngSize(b);
  if (!sa || !sb) return { verdict: VERDICT.SHAPE, ratio: 1, note: 'PNG 헤더를 읽을 수 없음' };
  if (sa.width !== sb.width) {
    return { verdict: VERDICT.SHAPE, ratio: 1, note: `가로 폭이 다름 ${sa.width} vs ${sb.width}` };
  }

  const dh = Math.abs(sa.height - sb.height);
  const maxH = Math.max(sa.height, sb.height);
  if (dh > heightTolerance(maxH)) {
    return {
      verdict: VERDICT.SHAPE, ratio: 1,
      note: `세로 높이가 ${dh.toLocaleString('en-US')}px 다름 (${sa.height} vs ${sb.height})`,
    };
  }

  // 높이가 조금 다르면 겹치는 위쪽만 비교한다.
  const cropH = dh ? Math.min(sa.height, sb.height) : 0;
  const cmpH = cropH || sa.height;

  // 너무 크면 축소해서 비교한다. 비율은 근사가 되지만 "다르다"는 사실은 남는다.
  let rw = 0, rh = 0;
  const px = sa.width * cmpH;
  if (px > MAX_COMPARE_PIXELS) {
    const k = Math.sqrt(MAX_COMPARE_PIXELS / px);
    rw = Math.max(1, Math.round(sa.width * k));
    rh = Math.max(1, Math.round(cmpH * k));
  }

  const r = await page.evaluate(inPageDiff, {
    a: a.toString('base64'), b: b.toString('base64'),
    rw, rh, cropW: sa.width, cropH,
  });
  const heightNote = dh ? `높이 ${dh}px 차이(겹치는 부분만 비교)` : '';
  if (r.shape) {
    return { verdict: VERDICT.SHAPE, ratio: 1, note: `디코딩 크기가 다름 ${r.aw}x${r.ah} vs ${r.bw}x${r.bh}` };
  }
  const parts = [];
  if (heightNote) parts.push(heightNote);
  if (r.differing === 0) {
    parts.push(rw ? '축소 비교라 미세한 차이는 놓칠 수 있음' : (dh ? '겹치는 부분은 완전히 같음' : 'PNG 인코딩만 다름'));
    return { verdict: VERDICT.SAME_PIXELS, ratio: 0, note: parts.join(' · ') };
  }
  const ratio = r.differing / r.total;

  // 축소해서 비교했으면 좌표를 원래 크기로 되돌린다.
  const ky = rh ? cmpH / rh : 1;
  const kx = rw ? sa.width / rw : 1;
  const region = {
    x: Math.floor(r.minX * kx),
    y: Math.floor(r.minY * ky),
    w: Math.ceil((r.maxX - r.minX + 1) * kx),
    h: Math.ceil((r.maxY - r.minY + 1) * ky),
    bands: r.bands,
  };

  parts.unshift(`차이 y ${region.y.toLocaleString('en-US')}~${(region.y + region.h).toLocaleString('en-US')}px` +
    ` · 가로 ${region.x}~${region.x + region.w}px` +
    ` · ${region.bands === 1 ? '한 덩어리' : region.bands + '덩어리'}`);
  if (rw) parts.push('축소 비교');
  return { verdict: VERDICT.DIFF, ratio, note: parts.join(' · '), region };
}

/** 캡처 결과(슬라이스 배열) 두 벌을 통째로 비교한다. 가장 나쁜 판정을 대표로 삼는다. */
export async function compareCaptures(page, sa, sb) {
  if (sa.length !== sb.length) {
    return {
      verdict: VERDICT.SHAPE, ratio: 1,
      note: `분할 수가 다름 ${sa.length}장 vs ${sb.length}장 — 문서 높이가 실행마다 바뀐다`,
    };
  }
  const rank = { [VERDICT.SAME]: 0, [VERDICT.SAME_PIXELS]: 1, [VERDICT.DIFF]: 2, [VERDICT.SHAPE]: 3 };
  let worst = { verdict: VERDICT.SAME, ratio: 0 };
  let totalDiff = 0;
  for (let i = 0; i < sa.length; i++) {
    const r = await comparePngs(page, sa[i], sb[i]);
    totalDiff += r.ratio;
    if (rank[r.verdict] > rank[worst.verdict] || (r.verdict === worst.verdict && r.ratio > worst.ratio)) {
      worst = { ...r, slice: sa.length > 1 ? i + 1 : undefined, sliceIndex: i };
    }
  }
  return { ...worst, ratio: worst.verdict === VERDICT.SHAPE ? 1 : totalDiff / sa.length };
}
