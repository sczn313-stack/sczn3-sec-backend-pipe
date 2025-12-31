'use strict';

/**
 * SCZN3 SEC Backend (single-file)
 * Build marker: BULL_LOCKED_V6
 *
 * - POST /api/sec (multipart form-data)
 *   fields: image (file), distanceYards, clickValueMoa, targetSizeSpec (or targetSizeInches), widthIn, heightIn
 *
 * - Returns signed clicks using canonical rule:
 *   correction = bull - POIB
 *   ΔX>0 RIGHT, ΔX<0 LEFT
 *   ΔY>0 UP,    ΔY<0 DOWN
 *
 * Note:
 * - Uses sharp if available. If sharp is not installed, server stays alive but returns ENGINE_MISSING.
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');

let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  sharp = null;
}

const BUILD = 'BULL_LOCKED_V6';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function toNum(v, fallback = NaN) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return fallback;
    const n = Number(t);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseSizeSpec(spec) {
  if (!spec || typeof spec !== 'string') return null;
  const s = spec.trim().toLowerCase().replace(/\s+/g, '');
  const m = s.match(/^(\d+(\.\d+)?)[x×](\d+(\.\d+)?)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  const long = Math.max(a, b);
  const short = Math.min(a, b);
  return { spec: `${a}x${b}`, widthIn: a, heightIn: b, long, short };
}

function inchesPerMoa(distanceYards) {
  // True MOA: 1.047" @ 100y
  return 1.047 * (distanceYards / 100);
}

function dirLabelX(dx) {
  if (dx > 0) return 'RIGHT';
  if (dx < 0) return 'LEFT';
  return 'NONE';
}

function dirLabelY(dy) {
  if (dy > 0) return 'UP';
  if (dy < 0) return 'DOWN';
  return 'NONE';
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Detect bullet holes by finding small dark connected components.
 * Returns holes in pixel coords (x,y) on the resized image.
 */
async function detectHoles(buffer) {
  if (!sharp) {
    return {
      ok: false,
      code: 'ENGINE_MISSING',
      message: 'sharp is not installed on the backend. Run: npm i sharp',
      holes: [],
      normalized: null
    };
  }

  // Resize to manageable size
  const TARGET_W = 900;
  const img = sharp(buffer).rotate();

  const meta = await img.metadata();
  const inW = meta.width || 0;
  const inH = meta.height || 0;

  if (!inW || !inH) {
    return {
      ok: false,
      code: 'BAD_IMAGE',
      message: 'Could not read image dimensions.',
      holes: [],
      normalized: null
    };
  }

  const scale = TARGET_W / inW;
  const outW = TARGET_W;
  const outH = Math.max(1, Math.round(inH * scale));

  // Greyscale raw buffer
  const { data, info } = await img
    .resize(outW, outH, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const H = info.height;

  // Threshold: only very dark pixels
  // If your grid lines are too dark, lower TH (more strict).
  const TH = 55;

  // Build a mask of dark pixels
  const dark = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const v = data[i]; // 0..255
    dark[i] = v < TH ? 1 : 0;
  }

  // Connected components on dark pixels
  const visited = new Uint8Array(W * H);

  const holes = [];

  // Component size filter (tune if needed)
  const MIN_AREA = 18;
  const MAX_AREA = 1800;

  function idx(x, y) {
    return y * W + x;
  }

  const stackX = new Int32Array(W * H > 200000 ? 200000 : W * H);
  const stackY = new Int32Array(W * H > 200000 ? 200000 : W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = idx(x, y);
      if (!dark[p] || visited[p]) continue;

      // Flood fill (bounded stack)
      let top = 0;
      stackX[top] = x;
      stackY[top] = y;
      top++;

      visited[p] = 1;

      let area = 0;
      let sumX = 0;
      let sumY = 0;

      while (top > 0) {
        top--;
        const cx = stackX[top];
        const cy = stackY[top];
        const cp = idx(cx, cy);

        area++;
        sumX += cx;
        sumY += cy;

        // 8-neighborhood
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = cx + ox;
            const ny = cy + oy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const np = idx(nx, ny);
            if (!dark[np] || visited[np]) continue;
            visited[np] = 1;

            if (top < stackX.length) {
              stackX[top] = nx;
              stackY[top] = ny;
              top++;
            }
          }
        }

        // Early reject: gigantic blobs (crosshair lines / bull ring)
        if (area > MAX_AREA) {
          // Mark remainder as visited via ongoing fill, but don't keep it as a hole
          // Continue draining stack but do not store this component.
        }
      }

      if (area >= MIN_AREA && area <= MAX_AREA) {
        const hx = sumX / area;
        const hy = sumY / area;
        holes.push({ x: hx, y: hy, area });
      }
    }
  }

  // Sort by area (bigger small blobs first)
  holes.sort((a, b) => b.area - a.area);

  // Keep up to 12 candidate holes
  const keep = holes.slice(0, 12).map(h => ({ x: h.x, y: h.y, area: h.area }));

  return {
    ok: true,
    holes: keep,
    normalized: { width: W, height: H }
  };
}

/**
 * Choose tightest cluster (3–7) and reject outliers.
 */
function pickCluster(holes) {
  if (!holes || holes.length === 0) return [];

  // Start from median point
  const xs = holes.map(h => h.x).slice().sort((a, b) => a - b);
  const ys = holes.map(h => h.y).slice().sort((a, b) => a - b);
  const mid = (arr) => arr[Math.floor(arr.length / 2)];
  const mx = mid(xs);
  const my = mid(ys);

  const withD = holes.map(h => {
    const dx = h.x - mx;
    const dy = h.y - my;
    return { ...h, d: Math.hypot(dx, dy) };
  });

  withD.sort((a, b) => a.d - b.d);

  // Take 3–7 closest
  const n = clamp(withD.length, 3, 7);
  return withD.slice(0, n);
}

/**
 * Compute POIB (average center of selected holes) in pixel coords
 */
function computePOIBPx(cluster) {
  const n = cluster.length;
  if (!n) return null;
  let sx = 0, sy = 0;
  for (const h of cluster) {
    sx += h.x;
    sy += h.y;
  }
  return { x: sx / n, y: sy / n };
}

/**
 * Convert pixel coord to inches based on full image mapping
 * Assumption: image content is reasonably aligned to target edges.
 */
function pxToIn(px, py, W, H, widthIn, heightIn) {
  const xIn = (px / W) * widthIn;
  const yIn = (py / H) * heightIn;
  return { xIn, yIn };
}

app.get('/', (req, res) => {
  return res.json({
    ok: true,
    service: 'sczn3-sec-backend-pipe',
    status: 'alive',
    build: BUILD
  });
});

// Nice message if someone hits GET /api/sec
app.get('/api/sec', (req, res) => {
  return res.status(405).json({
    ok: false,
    service: 'sczn3-sec-backend-pipe',
    build: BUILD,
    error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST /api/sec with multipart form-data.' }
  });
});

app.post('/api/sec', upload.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        service: 'sczn3-sec-backend-pipe',
        build: BUILD,
        error: { code: 'NO_IMAGE', message: 'Missing multipart file field: image' }
      });
    }

    const distanceYards = toNum(req.body.distanceYards, 100);
    const clickValueMoa = toNum(req.body.clickValueMoa, 0.25);

    // Accept: targetSizeSpec OR targetSizeInches (which might be "8.5x11") OR widthIn/heightIn
    const targetSizeSpec =
      (typeof req.body.targetSizeSpec === 'string' && req.body.targetSizeSpec.trim()) ||
      (typeof req.body.targetSizeInches === 'string' && req.body.targetSizeInches.trim()) ||
      '';

    let widthIn = toNum(req.body.widthIn, NaN);
    let heightIn = toNum(req.body.heightIn, NaN);

    let parsedSpec = parseSizeSpec(targetSizeSpec);

    if (!isFiniteNumber(widthIn) || !isFiniteNumber(heightIn)) {
      if (parsedSpec) {
        widthIn = parsedSpec.widthIn;
        heightIn = parsedSpec.heightIn;
      }
    }

    if (!isFiniteNumber(widthIn) || !isFiniteNumber(heightIn)) {
      return res.status(400).json({
        ok: false,
        service: 'sczn3-sec-backend-pipe',
        build: BUILD,
        error: {
          code: 'BAD_TARGET_SPEC',
          message: 'Provide targetSizeSpec like 8.5x11 or numeric widthIn + heightIn.'
        },
        received: {
          targetSizeSpec,
          widthIn: req.body.widthIn,
          heightIn: req.body.heightIn,
          targetSizeInches: req.body.targetSizeInches
        }
      });
    }

    const det = await detectHoles(req.file.buffer);

    if (!det.ok) {
      return res.status(500).json({
        ok: false,
        service: 'sczn3-sec-backend-pipe',
        build: BUILD,
        computeStatus: 'ENGINE_MISSING',
        error: { code: det.code, message: det.message },
        sec: {
          distanceYards,
          clickValueMoa,
          targetSizeSpec: parsedSpec ? parsedSpec.spec : targetSizeSpec,
          widthIn,
          heightIn
        }
      });
    }

    const holes = det.holes || [];
    const normalized = det.normalized;

    if (!holes.length) {
      return res.status(422).json({
        ok: false,
        service: 'sczn3-sec-backend-pipe',
        build: BUILD,
        computeStatus: 'FAILED_HOLES',
        error: { code: 'HOLES_NOT_FOUND', message: 'No bullet holes detected.' },
        detect: { normalized, holesDetected: 0, holes: [] },
        sec: {
          distanceYards,
          clickValueMoa,
          targetSizeSpec: parsedSpec ? parsedSpec.spec : targetSizeSpec,
          widthIn,
          heightIn
        }
      });
    }

    const cluster = pickCluster(holes);
    const poibPx = computePOIBPx(cluster);

    if (!poibPx) {
      return res.status(422).json({
        ok: false,
        service: 'sczn3-sec-backend-pipe',
        build: BUILD,
        computeStatus: 'FAILED_POIB',
        error: { code: 'POIB_FAILED', message: 'Could not compute POIB.' },
        detect: { normalized, holesDetected: holes.length, holes },
        sec: {
          distanceYards,
          clickValueMoa,
          targetSizeSpec: parsedSpec ? parsedSpec.spec : targetSizeSpec,
          widthIn,
          heightIn
        }
      });
    }

    // Bull default: center of target (works for the current test harness)
    const bullXIn = widthIn / 2;
    const bullYIn = heightIn / 2;

    const poibIn = pxToIn(poibPx.x, poibPx.y, normalized.width, normalized.height, widthIn, heightIn);

    // Canonical correction rule
    const dxIn = bullXIn - poibIn.xIn;
    const dyIn = bullYIn - poibIn.yIn;

    const ipm = inchesPerMoa(distanceYards);
    const inchesPerClick = ipm * clickValueMoa;

    const wClicks = dxIn / inchesPerClick;
    const eClicks = dyIn / inchesPerClick;

    const out = {
      ok: true,
      service: 'sczn3-sec-backend-pipe',
      build: BUILD,
      computeStatus: 'OK',
      received: {
        originalName: req.file.originalname,
        bytes: req.file.size,
        mimetype: req.file.mimetype
      },
      sec: {
        distanceYards,
        clickValueMoa,
        targetSizeSpec: parsedSpec ? parsedSpec.spec : targetSizeSpec,
        widthIn,
        heightIn,
        targetSizeInches: heightIn // for your UI field that expects numeric echo
      },
      detect: {
        normalized,
        holesDetected: holes.length,
        holes,
        clusterUsed: cluster.map(h => ({ x: h.x, y: h.y, area: h.area }))
      },
      poib: {
        px: { x: round2(poibPx.x), y: round2(poibPx.y) },
        inches: { x: round2(poibIn.xIn), y: round2(poibIn.yIn) }
      },
      bull: {
        inches: { x: round2(bullXIn), y: round2(bullYIn) }
      },
      delta: {
        inches: { x: round2(dxIn), y: round2(dyIn) }
      },
      clicksSigned: {
        windage: round2(wClicks),
        elevation: round2(eClicks)
      },
      clicksAbs: {
        windage: round2(Math.abs(wClicks)),
        elevation: round2(Math.abs(eClicks))
      },
      direction: {
        windage: dirLabelX(dxIn),
        elevation: dirLabelY(dyIn)
      }
    };

    return res.json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      service: 'sczn3-sec-backend-pipe',
      build: BUILD,
      error: { code: 'SERVER_ERROR', message: String(err && err.message ? err.message : err) }
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SEC backend listening on ${PORT} (${BUILD})`);
});
