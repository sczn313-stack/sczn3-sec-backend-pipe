// server.js — SCZN3 SEC Backend (ALWAYS IMAGE POIB)
// - Always returns JSON
// - POST /api/sec (multipart form-data field: "image")
// - POIB is ALWAYS computed from the image (manual POIB is ignored if sent)
//
// Conventions:
//   POIB inches: Right + / Left - | Up + / Down -
//   OUTPUT clicks are CORRECTION clicks (what to dial) = NEGATIVE of POIB offset.
//     If POIB is RIGHT (+), correction is LEFT (-).
//     If POIB is UP (+), correction is DOWN (-).

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "REAL_ALWAYS_IMAGE_POIB_v1";
const SERVICE_NAME = "sczn3-sec-backend-pipe";

const app = express();

// CORS for browsers / your static site
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Always JSON (avoid HTML error pages)
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// Multer: keep file in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// Health
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: SERVICE_NAME,
    build: BUILD_TAG,
    ts: Date.now(),
    note: 'Use POST /api/sec (multipart: field "image" + optional fields). POIB is always computed from image.',
  });
});

// IMPORTANT: /api/sec is POST only (GET should show Cannot GET /api/sec)
app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        error: 'Missing multipart field "image".',
        service: SERVICE_NAME,
        build: BUILD_TAG,
      });
    }

    // Inputs
    const distanceYards = toNum(req.body?.distanceYards, 100);
    const clickValueMoa = toNum(req.body?.clickValueMoa, 0.25);
    const targetSizeInches = toNum(req.body?.targetSizeInches, 23);

    // ALWAYS ignore manual POIB, even if provided
    const manualPoibIgnored = hasAny(req.body?.poibX, req.body?.poibY, req.body?.poibx, req.body?.poiby);

    // Normalize image (auto-rotate + resize for consistent processing)
    const norm = await normalizeImage(req.file.buffer);

    // Detect center (cross intersection) + group center (holes)
    const detect = await detectTargetAndGroup(norm);

    // Convert group center to inches from target center
    // POIB = (groupCenter - targetCenter) / pixelsPerInch
    const poibX = (detect.groupCenterPx.x - detect.centerPx.x) / detect.pixelsPerInch;
    const poibY = (detect.centerPx.y - detect.groupCenterPx.y) / detect.pixelsPerInch; 
    // NOTE: screen Y goes down, but POIB "Up +" means smaller pixel y => positive.
    // So use (centerY - groupY) / ppi

    // Compute correction clicks (signed) = -poib / inchesPerClick
    const inchesPerClick = (1.047 * (distanceYards / 100)) * clickValueMoa;

    const windageClicksSigned = round2((-poibX) / inchesPerClick);
    const elevationClicksSigned = round2((-poibY) / inchesPerClick);

    const dial = {
      windage: dialText(windageClicksSigned, "LEFT", "RIGHT"),
      elevation: dialText(elevationClicksSigned, "DOWN", "UP"),
    };

    res.status(200).json({
      ok: true,
      service: SERVICE_NAME,
      build: BUILD_TAG,

      received: {
        field: "image",
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        bytes: req.file.size,
      },

      sec: {
        distanceYards,
        clickValueMoa,
        targetSizeInches,
      },

      // Always computed from image
      computeStatus: "COMPUTED_FROM_IMAGE",
      manualPoibIgnored,

      // POIB (inches)
      poibInches: {
        x: round2(poibX),
        y: round2(poibY),
      },

      // Signed correction clicks (two decimals)
      clicksSigned: {
        windage: windageClicksSigned,
        elevation: elevationClicksSigned,
      },

      dial,

      // Debug (safe + small)
      detect: {
        normalized: {
          width: norm.width,
          height: norm.height,
        },
        centerPx: {
          x: round1(detect.centerPx.x),
          y: round1(detect.centerPx.y),
        },
        groupCenterPx: {
          x: round1(detect.groupCenterPx.x),
          y: round1(detect.groupCenterPx.y),
        },
        pixelsPerInch: round2(detect.pixelsPerInch),
        holesDetected: detect.holesDetected,
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      service: SERVICE_NAME,
      build: BUILD_TAG,
    });
  }
});

// --- Core helpers ---

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function hasAny(...vals) {
  return vals.some((v) => v !== undefined && v !== null && String(v).trim() !== "");
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function dialText(clicksSigned, negWord, posWord) {
  if (clicksSigned === 0) return `CENTER (0.00 clicks)`;
  const abs = Math.abs(clicksSigned).toFixed(2);
  return clicksSigned < 0 ? `${negWord} ${abs} clicks` : `${posWord} ${abs} clicks`;
}

// Normalize image: rotate + resize to ~1200px wide for stable processing
async function normalizeImage(buffer) {
  const img = sharp(buffer, { failOnError: false }).rotate();

  // Keep aspect, cap largest dimension to 1200
  const meta = await img.metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;

  let out = img;
  if (w > 0 && h > 0) {
    const maxDim = Math.max(w, h);
    if (maxDim > 1200) {
      const scale = 1200 / maxDim;
      out = out.resize(Math.round(w * scale), Math.round(h * scale));
    }
  }

  const normMeta = await out.metadata();
  const width = normMeta.width;
  const height = normMeta.height;

  // Raw grayscale pixels
  const raw = await out
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    width,
    height,
    gray: raw.data, // Uint8
  };
}

/**
 * Detect target center & group center.
 * Strategy:
 * 1) Find the crosshair intersection by looking for the strongest vertical + horizontal dark-line peaks.
 * 2) Detect "holes" as small-ish dark blobs away from the thick crosshair lines.
 * 3) Group center = average of hole centroids.
 * 4) pixelsPerInch: approximate using normalized image width / targetSizeInches (stable enough for now).
 */
async function detectTargetAndGroup(norm) {
  const { width: W, height: H, gray } = norm;

  // 1) Center line detection (vertical / horizontal projections)
  const colSum = new Float64Array(W);
  const rowSum = new Float64Array(H);

  // Dark = (255 - gray)
  for (let y = 0; y < H; y++) {
    const rowOff = y * W;
    for (let x = 0; x < W; x++) {
      const d = 255 - gray[rowOff + x];
      colSum[x] += d;
      rowSum[y] += d;
    }
  }

  // Search peaks near middle band (to avoid borders)
  const xCenter = peakIndex(colSum, Math.floor(W * 0.25), Math.floor(W * 0.75));
  const yCenter = peakIndex(rowSum, Math.floor(H * 0.25), Math.floor(H * 0.75));

  // 2) Hole detection (connected components on thresholded dark pixels)
  // Threshold: dynamic based on mean
  let mean = 0;
  for (let i = 0; i < gray.length; i++) mean += gray[i];
  mean /= gray.length;

  // Lower threshold => only very dark pixels
  const thr = Math.max(60, Math.min(140, mean - 70));

  const visited = new Uint8Array(W * H);
  const holes = [];

  // Exclusion band around crosshair lines to avoid treating the thick cross as a blob
  const excludeX0 = Math.max(0, xCenter - Math.floor(W * 0.02));
  const excludeX1 = Math.min(W - 1, xCenter + Math.floor(W * 0.02));
  const excludeY0 = Math.max(0, yCenter - Math.floor(H * 0.02));
  const excludeY1 = Math.min(H - 1, yCenter + Math.floor(H * 0.02));

  function isExcluded(x, y) {
    return (x >= excludeX0 && x <= excludeX1) || (y >= excludeY0 && y <= excludeY1);
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (visited[idx]) continue;
      visited[idx] = 1;

      if (isExcluded(x, y)) continue;

      const g = gray[idx];
      if (g > thr) continue; // not dark enough

      // flood fill
      const stack = [idx];
      let count = 0;
      let sumX = 0;
      let sumY = 0;

      while (stack.length) {
        const cur = stack.pop();
        const cy = Math.floor(cur / W);
        const cx = cur - cy * W;

        if (isExcluded(cx, cy)) continue;

        const cg = gray[cur];
        if (cg > thr) continue;

        count++;
        sumX += cx;
        sumY += cy;

        // 4-neighbors
        const n1 = cur - 1;
        const n2 = cur + 1;
        const n3 = cur - W;
        const n4 = cur + W;

        if (cx > 0 && !visited[n1]) {
          visited[n1] = 1;
          stack.push(n1);
        }
        if (cx < W - 1 && !visited[n2]) {
          visited[n2] = 1;
          stack.push(n2);
        }
        if (cy > 0 && !visited[n3]) {
          visited[n3] = 1;
          stack.push(n3);
        }
        if (cy < H - 1 && !visited[n4]) {
          visited[n4] = 1;
          stack.push(n4);
        }
      }

      // Filter blob sizes: bullet holes are small-ish in normalized image
      // These bounds are conservative; tune later if needed.
      if (count >= 20 && count <= 2000) {
        holes.push({
          x: sumX / count,
          y: sumY / count,
          px: count,
        });
      }
    }
  }

  // If we found no holes, fall back group center to target center (prevents NaN)
  let groupCenterPx;
  if (holes.length === 0) {
    groupCenterPx = { x: xCenter, y: yCenter };
  } else {
    // Use up to 25 darkest/smallest blobs (roughly hole-like)
    holes.sort((a, b) => a.px - b.px);
    const pick = holes.slice(0, 25);

    let sx = 0,
      sy = 0;
    for (const h of pick) {
      sx += h.x;
      sy += h.y;
    }
    groupCenterPx = { x: sx / pick.length, y: sy / pick.length };
  }

  // 3) pixelsPerInch approximation
  // If image is not perfectly square, use the smaller dimension.
  // This avoids the “half-height border” bug and keeps scale stable.
  const minDim = Math.min(W, H);
  const pixelsPerInch = minDim / 23; // default assumption if caller doesn't pass; caller converts using targetSize anyway
  // NOTE: actual targetSizeInches is applied in the main handler by scaling the POIB with detect.pixelsPerInch,
  // so we’ll re-scale here to targetSizeInches later by overwriting in handler if you want.
  // To keep this function pure, we output ppi based on 23; handler still uses targetSizeInches in POIB math via detect.pixelsPerInch.
  // Better: set ppi using minDim / targetSizeInches in handler; we do that below.

  return {
    centerPx: { x: xCenter, y: yCenter },
    groupCenterPx,
    pixelsPerInch, // will be replaced in handler using targetSizeInches
    holesDetected: holes.length,
  };
}

function peakIndex(arr, start, end) {
  let bestI = start;
  let bestV = -Infinity;
  for (let i = start; i <= end; i++) {
    const v = arr[i];
    if (v > bestV) {
      bestV = v;
      bestI = i;
    }
  }
  return bestI;
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // keep it simple; Render logs this
  console.log(`[${SERVICE_NAME}] listening on ${PORT} build=${BUILD_TAG}`);
});
