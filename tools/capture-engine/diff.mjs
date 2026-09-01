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

  let differing = 0, firstY = -1;
  for (let i = 0; i < da.length; i += 4) {
    if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) {
      differing++;
      if (firstY < 0) firstY = Math.floor(i / 4 / w);
    }
  }
  return { shape: false, total: w * h, differing, firstY, w, h };
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
  const atY = rh ? Math.round((r.firstY / rh) * cmpH) : r.firstY;
  parts.unshift(`첫 차이 y≈${atY.toLocaleString('en-US')}px`);
  if (rw) parts.push('축소 비교');
  return { verdict: VERDICT.DIFF, ratio, note: parts.join(' · ') };
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
      worst = { ...r, slice: sa.length > 1 ? i + 1 : undefined };
    }
  }
  return { ...worst, ratio: worst.verdict === VERDICT.SHAPE ? 1 : totalDiff / sa.length };
}
