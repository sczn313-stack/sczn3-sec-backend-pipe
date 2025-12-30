'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');

const app = express();
app.use(cors());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const BUILD = 'BULL_LOCKED_V3';

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'sczn3-sec-backend-pipe', status: 'alive', build: BUILD });
});

function toNum(x, fallback) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseTargetSpec(spec) {
  // Accept "8.5x11", "8.5×11", "8.5X11"
  if (!spec || typeof spec !== 'string') return null;
  const s = spec.replace('×', 'x').replace('X', 'x').trim();
  const parts = s.split('x').map(p => p.trim());
  if (parts.length !== 2) return null;

  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;

  // width = smaller? NO: we keep the order as given (spec is usually width x height)
  return { widthIn: a, heightIn: b };
}

function inchesPerClick(distanceYards, clickValueMoa) {
  // True MOA: 1 MOA = 1.047" at 100y
  const inchesPerMoaAtDistance = 1.047 * (distanceYards / 100);
  return inchesPerMoaAtDistance * clickValueMoa;
}

function directionFromCorrection(corrX, corrY) {
  // corrX: + => RIGHT, - => LEFT
  // corrY: + => UP,    - => DOWN
  const windage = corrX >= 0 ? 'RIGHT' : 'LEFT';
  const elevation = corrY >= 0 ? 'UP' : 'DOWN';
  return { windage, elevation };
}

function normalizeToLongSide(buffer, longSidePx) {
  // Preserve aspect ratio. Long side becomes longSidePx.
  return sharp(buffer)
    .rotate() // respect EXIF rotation
    .metadata()
    .then(meta => {
      const w = meta.width || 0;
      const h = meta.height || 0;
      if (!w || !h) throw new Error('BAD_IMAGE');

      const longIsWidth = w >= h;
      const newW = longIsWidth ? longSidePx : Math.round((w / h) * longSidePx);
      const newH = longIsWidth ? Math.round((h / w) * longSidePx) : longSidePx;

      return sharp(buffer)
        .rotate()
        .resize(newW, newH, { fit: 'fill' }) // already computed aspect
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then(({ data, info }) => ({
          data,
          width: info.width,
          height: info.height
        }));
    });
}

function findHoles(binary, w, h) {
  // binary is Uint8Array of 0/1 where 1 = dark pixel (candidate)
  // Connected components to find blobs; filter out grid lines by aspect ratio.
  const visited = new Uint8Array(w * h);
  const holes = [];

  const idx = (x, y) => y * w + x;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (visited[i]) continue;
      visited[i] = 1;
      if (binary[i] !== 1) continue;

      // BFS
      let qx = [x];
      let qy = [y];
      let qh = 0;

      let count = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = x, maxX = x, minY = y, maxY = y;

      while (qh < qx.length) {
        const cx = qx[qh];
        const cy = qy[qh];
        qh++;

        const ci = idx(cx, cy);
        if (binary[ci] !== 1) continue;

        count++;
        sumX += cx;
        sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 4-neighborhood
        const n = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1]
        ];

        for (const [nx, ny] of n) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = idx(nx, ny);
          if (visited[ni]) continue;
          visited[ni] = 1;
          if (binary[ni] === 1) {
            qx.push(nx);
            qy.push(ny);
          }
        }
      }

      // Filter: too small/too big blobs are not bullet holes
      if (count < 20) continue;
      if (count > 6000) continue;

      const bw = (maxX - minX + 1);
      const bh = (maxY - minY + 1);
      const aspect = bw > bh ? (bw / bh) : (bh / bw);

      // Grid lines become long skinny blobs; reject those
      if (aspect > 2.2) continue;

      const cx = sumX / count;
      const cy = sumY / count;

      holes.push({
        cx,
        cy,
        area: count,
        bboxW: bw,
        bboxH: bh
      });
    }
  }

  // Prefer larger blobs (usually actual holes vs tiny specks)
  holes.sort((a, b) => b.area - a.area);

  // Keep the top 40 candidates to stay stable
  return holes.slice(0, 40);
}

function makeBinaryFromRawGray(raw, w, h) {
  // raw is grayscale bytes 0..255
  // Threshold: mark dark pixels as 1
  // We use a conservative threshold; if your paper is darker, raise it slightly.
  const out = new Uint8Array(w * h);

  // Compute a quick mean to adapt a little
  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw[i];
  const mean = sum / raw.length;

  // Dynamic threshold: base around mean-35, clamp into sensible range
  let thr = Math.round(mean - 35);
  if (thr < 60) thr = 60;
  if (thr > 140) thr = 140;

  for (let i = 0; i < raw.length; i++) {
    out[i] = (raw[i] <= thr) ? 1 : 0;
  }
  return { binary: out, threshold: thr, mean: Math.round(mean) };
}

app.post('/api/sec', upload.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        service: 'sczn3-sec-backend-pipe',
        build: BUILD,
        error: { code: 'NO_IMAGE', message: 'image file required' }
      });
    }

    const distanceYards = toNum(req.body.distanceYards, 100);
    const clickValueMoa = toNum(req.body.clickValueMoa, 0.25);

    // UI sends targetSizeSpec like "8.5x11"
    const targetSizeSpec = String(req.body.targetSizeSpec || req.body.targetSize || '').trim();
    const spec = parseTargetSpec(targetSizeSpec);

    if (!spec) {
      return res.status(400).json({
        ok: false,
        service: 'sczn3-sec-backend-pipe',
        build: BUILD,
        error: { code: 'BAD_TARGET_SPEC', message: 'targetSizeSpec required (ex: 8.5x11)' }
      });
    }

    const widthIn = spec.widthIn;
    const heightIn = spec.heightIn;

    // Important: UI wants targetSizeInches to be the LONG side for congruence
    const targetSizeInches = Math.max(widthIn, heightIn);

    // Normalize image with correct aspect ratio (no more 1000x1000 square)
    const longSidePx = 1200;
    const norm = await normalizeToLongSide(req.file.buffer, longSidePx);

    // Create binary mask for holes
    const binInfo = makeBinaryFromRawGray(norm.data, norm.width, norm.height);
    const holes = findHoles(binInfo.binary, norm.width, norm.height);

    // Bull position in inches: dead center of the paper
    const bull = { x: widthIn / 2, y: heightIn / 2 };

    // Always return clicksSigned, even if holes fail (UI gate requirement)
    const baseResponse = {
      ok: true,
      service: 'sczn3-sec-backend-pipe',
      build: BUILD,
      received: {
        originalName: req.file.originalname,
        bytes: req.file.size,
        mimetype: req.file.mimetype
      },
      sec: {
        distanceYards,
        clickValueMoa,
        targetSizeSpec,
        widthIn,
        heightIn,
        targetSizeInches
      },
      detect: {
        normalized: { width: norm.width, height: norm.height },
        threshold: binInfo.threshold,
        meanGray: binInfo.mean,
        holesDetected: holes.length,
        holes: holes
      }
    };

    if (!holes.length) {
      return res.json({
        ...baseResponse,
        computeStatus: 'FAILED_HOLES',
        error: { code: 'HOLES_NOT_FOUND', message: 'No bullet holes detected. Use a closer, sharper photo with higher contrast.' },
        clicksSigned: { windage: 0.00, elevation: 0.00 },
        dial: { windage: 'RIGHT 0.00', elevation: 'UP 0.00' }
      });
    }

    // Group center = average of hole centroids (in normalized pixel space)
    let sx = 0;
    let sy = 0;
    for (const h of holes) {
      sx += h.cx;
      sy += h.cy;
    }
    const groupCenterPx = { x: sx / holes.length, y: sy / holes.length };

    // Map px -> inches (preserve aspect ratio mapping)
    const xIn = (groupCenterPx.x / norm.width) * widthIn;
    const yIn = (groupCenterPx.y / norm.height) * heightIn;

    // POIB inches: +x right, +y up (image y goes down, so flip)
    const poibX = xIn - bull.x;
    const poibY = -(yIn - bull.y);

    // Correction = move cluster to bull = bull - POIB = -POIB
    const corrX = -poibX;
    const corrY = -poibY;

    const ipc = inchesPerClick(distanceYards, clickValueMoa);
    const windageClicksSigned = corrX / ipc;
    const elevationClicksSigned = corrY / ipc;

    const dirs = directionFromCorrection(corrX, corrY);

    const wAbs = Math.abs(windageClicksSigned);
    const eAbs = Math.abs(elevationClicksSigned);

    return res.json({
      ...baseResponse,
      computeStatus: 'COMPUTED_FROM_IMAGE',
      bullInches: { x: round2(bull.x), y: round2(bull.y) },
      groupCenterInches: { x: round2(xIn), y: round2(yIn) },
      poibInches: { x: round2(poibX), y: round2(poibY) },
      correctionInches: { x: round2(corrX), y: round2(corrY) },
      inchesPerClick: round2(ipc),
      clicksSigned: {
        windage: round2(windageClicksSigned),
        elevation: round2(elevationClicksSigned)
      },
      dial: {
        windage: `${dirs.windage} ${round2(wAbs).toFixed(2)} clicks`,
        elevation: `${dirs.elevation} ${round2(eAbs).toFixed(2)} clicks`
      }
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      service: 'sczn3-sec-backend-pipe',
      build: BUILD,
      error: { code: 'SERVER_ERROR', message: String(err && err.message ? err.message : err) }
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // no extra logging needed for Render; keep it quiet
});
