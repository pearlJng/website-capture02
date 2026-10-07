/**
 * png.mjs — PNG 여러 장을 세로로 이어 한 장으로 만든다. 브라우저 없이, Node 만으로.
 *
 * 왜 필요한가. 아주 긴 페이지는 캔버스 한계 때문에 20,000px 씩 여러 장으로 찍힌다.
 * 보는 데는 여러 장이 낫지만(브라우저가 9만 px 짜리 그림을 버거워한다), 내보낼 때는
 * "한 페이지 = 한 파일"이어야 한다. 캔버스로는 못 붙이니(높이 32,767px 한계) 바이트로 붙인다.
 *
 * 다루는 것: 8비트 RGB/RGBA, 비인터레이스 — 스크린샷과 캔버스 출력은 전부 이것이다.
 */
import { inflateSync, deflateSync, crc32 } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('PNG 가 아닙니다');
  const out = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('latin1', p + 4, p + 8);
    out.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/** PNG 한 장을 풀어 { width, height, bpp, rows: Buffer(필터 없는 원본 행들) } 로 만든다. */
export function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('IHDR 없음');
  const width = ihdr.data.readUInt32BE(0), height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8], color = ihdr.data[9], interlace = ihdr.data[12];
  if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) {
    throw new Error(`지원하지 않는 PNG (깊이 ${depth}, 색 ${color}, 인터레이스 ${interlace})`);
  }
  const bpp = color === 6 ? 4 : 3;
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = inflateSync(idat);
  const stride = width * bpp;
  const rows = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = rows.subarray(y * stride, (y + 1) * stride);
    src.copy(cur);
    // PNG 필터 되돌리기. 왼쪽(a)·위(b)·왼쪽위(c) 픽셀을 더한다.
    if (f === 1) { for (let i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 255; }
    else if (f === 2) { for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 255; }
    else if (f === 3) { for (let i = 0; i < stride; i++) cur[i] = (cur[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 255; }
    else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    } else if (f !== 0) throw new Error(`알 수 없는 필터 ${f}`);
    prev = cur;
  }
  return { width, height, bpp, rows };
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** 필터 없는 행들을 PNG 로 싼다. 'Up' 필터(2)를 써서 사진도 웬만큼 줄어든다. */
export function encodePng({ width, height, bpp, rows }) {
  const stride = width * bpp;
  const filtered = Buffer.alloc((stride + 1) * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = rows.subarray(y * stride, (y + 1) * stride);
    const o = y * (stride + 1);
    filtered[o] = 2;
    for (let i = 0; i < stride; i++) filtered[o + 1 + i] = (cur[i] - prev[i]) & 255;
    prev = cur;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = bpp === 4 ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const z = deflateSync(filtered, { level: 3 });
  const parts = [SIG, chunk('IHDR', ihdr)];
  for (let i = 0; i < z.length; i += 1 << 20) parts.push(chunk('IDAT', z.subarray(i, i + (1 << 20))));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** PNG 여러 장을 위에서 아래로 이어 붙인다. 폭이 같아야 한다. 한 장이면 그대로 돌려준다. */
export function mergePngsVertically(bufs) {
  if (bufs.length === 1) return bufs[0];
  const imgs = bufs.map(decodePng);
  const width = imgs[0].width;
  if (imgs.some((i) => i.width !== width)) throw new Error('폭이 다른 그림은 이어 붙일 수 없습니다');
  const bpp = Math.max(...imgs.map((i) => i.bpp));
  const height = imgs.reduce((s, i) => s + i.height, 0);
  const rows = Buffer.alloc(width * bpp * height);
  let off = 0;
  for (const im of imgs) {
    if (im.bpp === bpp) { im.rows.copy(rows, off); off += im.rows.length; continue; }
    // RGB → RGBA 로 맞춘다
    for (let p = 0; p < im.width * im.height; p++) {
      rows[off++] = im.rows[p * 3]; rows[off++] = im.rows[p * 3 + 1]; rows[off++] = im.rows[p * 3 + 2]; rows[off++] = 255;
    }
  }
  return encodePng({ width, height, bpp, rows });
}

/* ───────────── 사람이 찍은 화면 조각 이어 붙이기 ───────────── */

/** 두 행의 평균 절대 차. 4px 마다 본다. */
function rowDiff(A, ao, B, bo, stride, bpp) {
  let sum = 0, n = 0;
  for (let x = 0; x < stride; x += bpp * 4) {
    sum += Math.abs(A[ao + x] - B[bo + x]) + Math.abs(A[ao + x + 1] - B[bo + x + 1]) + Math.abs(A[ao + x + 2] - B[bo + x + 2]);
    n += 3;
  }
  return sum / n;
}

/** 행이 얼마나 "내용"이 있는가 — 한 색으로 밋밋한 행은 어디에나 맞아 기준으로 못 쓴다. */
function rowVariance(A, ao, stride, bpp) {
  let sum = 0, n = 0;
  for (let x = bpp * 4; x < stride; x += bpp * 4) {
    sum += Math.abs(A[ao + x] - A[ao + x - bpp * 4]) + Math.abs(A[ao + x + 1] - A[ao + x + 1 - bpp * 4]);
    n += 2;
  }
  return sum / n;
}

/**
 * 사람이 스크롤해 가며 찍은 화면 조각들을 한 장으로 잇는다 (순서대로).
 *
 * 1) 모든 조각의 맨 위에 똑같이 찍힌 띠(고정 헤더)는 둘째 조각부터 잘라낸다.
 * 2) 앞 조각의 아래쪽 한 토막(64줄, 내용이 있는 곳)을 뒤 조각에서 찾아 겹친 만큼 잘라낸다.
 *    못 찾으면 겹치지 않은 것으로 보고 그대로 붙인다.
 * 폭이 다르면 못 잇는다 — 같은 창에서 찍어야 한다.
 */
export function stitchUserShots(bufs) {
  const imgs = bufs.map(decodePng);
  const width = imgs[0].width, bpp = imgs[0].bpp;
  if (imgs.some((i) => i.width !== width || i.bpp !== bpp)) {
    throw new Error(`폭이 다른 그림은 이어 붙일 수 없습니다 (${imgs.map((i) => i.width).join(', ')}px) — 같은 창 크기로 찍어 주세요`);
  }
  const stride = width * bpp;
  const notes = [];
  if (imgs.length === 1) return { png: encodePng(imgs[0]), notes: [] };

  // 1) 공통 띠: 모든 조각에서 같은 행이 위에서부터 몇 줄인가
  // 첫 조각은 히어로 위에 투명하게 얹힌 헤더라 둘째부터와 다를 수 있다 — 셋 이상이면 둘째부터 견준다
  let band = 0;
  const base = imgs.length >= 3 ? 1 : 0;
  const maxBand = Math.floor(Math.min(...imgs.map((i) => i.height)) * 0.4);
  for (; band < maxBand; band++) {
    let same = true;
    for (let k = base + 1; k < imgs.length && same; k++) {
      if (rowDiff(imgs[base].rows, band * stride, imgs[k].rows, band * stride, stride, bpp) > 2) same = false;
    }
    if (!same) break;
  }
  if (band < 16) band = 0;
  if (band) notes.push(`모든 조각 위에 같은 띠 ${band}px (고정 헤더) — 둘째 조각부터 잘라냄`);

  // 2) 겹침 찾기
  const pieces = [{ rows: imgs[0].rows, from: 0, to: imgs[0].height }];
  let prev = imgs[0], prevTo = imgs[0].height;
  const K = 64;
  for (let k = 1; k < imgs.length; k++) {
    const cur = imgs[k];
    // 앞 조각 아래쪽 200줄 안에서 가장 내용이 많은 64줄 토막
    let bestStart = -1, bestVar = -1;
    for (let s = Math.max(0, prevTo - 200); s + K <= prevTo; s += 8) {
      let v = 0;
      for (let y = 0; y < K; y += 4) v += rowVariance(prev.rows, (s + y) * stride, stride, bpp);
      if (v > bestVar) { bestVar = v; bestStart = s; }
    }
    let crop = band;
    if (bestStart >= 0 && bestVar > 4 * (K / 4)) {
      const limit = Math.min(cur.height - K, Math.floor(cur.height * 0.9));
      let found = -1, foundErr = Infinity;
      for (let o = 0; o <= limit; o++) {   // 띠 안쪽부터 본다 — 토막이 띠 바로 밑에 걸쳐 있을 수 있다
        // 첫 줄로 빠르게 거른 뒤 토막 전체를 본다
        if (rowDiff(prev.rows, bestStart * stride, cur.rows, o * stride, stride, bpp) > 6) continue;
        let err = 0;
        for (let y = 0; y < K; y += 2) err += rowDiff(prev.rows, (bestStart + y) * stride, cur.rows, (o + y) * stride, stride, bpp);
        err /= K / 2;
        if (err < foundErr) { foundErr = err; found = o; }
      }
      if (found >= 0 && foundErr <= 4) {
        crop = Math.max(band, found + (prevTo - bestStart));   // 앞 조각의 끝에 해당하는 뒤 조각의 줄
        notes.push(`${k}·${k + 1}번째 조각이 ${crop}px 겹침 — 잘라냄`);
      } else {
        notes.push(`${k}·${k + 1}번째 조각은 겹치는 곳을 못 찾음 — 그대로 이어 붙임`);
      }
    }
    crop = Math.min(crop, cur.height);
    pieces.push({ rows: cur.rows, from: crop, to: cur.height });
    prev = cur; prevTo = cur.height;
  }

  const height = pieces.reduce((s, p) => s + (p.to - p.from), 0);
  const rows = Buffer.alloc(stride * height);
  let off = 0;
  for (const p of pieces) { p.rows.copy(rows, off, p.from * stride, p.to * stride); off += (p.to - p.from) * stride; }
  return { png: encodePng({ width, height, bpp, rows }), notes, band };
}
