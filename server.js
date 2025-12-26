// server.js — SCZN3 SEC Backend (CLEAN v5)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart: field "image" + optional fields:
//   poibX, poibY (inches)   distanceYards (yards)   clickValueMoa (MOA per click)
//   targetSizeInches (default 23)

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "REAL_v5_2025-12-26_CENTER_FIX";

const app = express();

// CORS: allow requests from your Static Site + browser testing
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Always return JSON (avoid Express default HTML errors)
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// Multer memory storage (raw bytes in RAM)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

// ---------- Helpers ----------
function toNumberOrDefault(v, def) {
  if (v === undefined || v === null) return def;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : def;
}

// 1 MOA ≈ 1.047" at 100 yards
function inchesPerClick(distanceYards, clickValueMoa) {
  return 1.047 * (distanceYards / 100) * clickValueMoa;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function dialText(axisName, clicksSigned) {
  const abs = Math.abs(clicksSigned);
  const rounded = round2(abs);

  // windage
  if (axisName === "windage") {
    if (rounded === 0) return `CENTER 0.00 clicks`;
    return clicksSigned >= 0
      ? `RIGHT ${rounded} clicks`
      : `LEFT ${rounded} clicks`;
  }

  // elevation
  if (rounded === 0) return `LEVEL 0.00 clicks`;
  return clicksSigned >= 0 ? `UP ${rounded} clicks` : `DOWN ${rounded} clicks`;
}

/**
 * Very simple border finder:
 * - Works on a grayscale image buffer (0..255, 0=black)
 * - Finds first/last row/col whose mean is "dark enough"
 * - Adds sanity fallback to avoid the "half-height" bug:
 *   If the resulting box is not roughly square, we fall back to full image bounds.
 */
function findBorderBox(gray, w, h) {
  const rowMean = (y) => {
    let sum = 0;
    const rowStart = y * w;
    for (let x = 0; x < w; x++) sum += gray[rowStart + x];
    return sum / w;
  };

  const colMean = (x) => {
    let sum = 0;
    for (let y = 0; y < h; y++) sum += gray[y * w + x];
    return sum / h;
  };

  // Thresholds: tuned for your bright background + dark border/axes.
  // If your photos vary, you can adjust these later.
  const ROW_DARK = 235;
  const COL_DARK = 235;

  let yT = 0;
  while (yT < h && rowMean(yT) > ROW_DARK) yT++;

  let yB = h - 1;
  while (yB > 0 && rowMean(yB) > ROW_DARK) yB--;

  let xL = 0;
  while (xL < w && colMean(xL) > COL_DARK) xL++;

  let xR = w - 1;
  while (xR > 0 && colMean(xR) > COL_DARK) xR--;

  // Clamp
  yT = Math.max(0, Math.min(h - 1, yT));
  yB = Math.max(0, Math.min(h - 1, yB));
  xL = Math.max(0, Math.min(w - 1, xL));
  xR = Math.max(0, Math.min(w - 1, xR));

  const boxW = xR - xL;
  const boxH = yB - yT;

  // Sanity: if it’s not roughly square, do NOT trust it (prevents half-height bug)
  const ratio = boxH === 0 ? 999 : boxW / boxH;
  const roughlySquare = ratio > 0.85 && ratio < 1.15 && boxW > w * 0.4 && boxH > h * 0.4;

  if (!roughlySquare) {
    return {
      xL: 0,
      xR: w - 1,
      yT: 0,
      yB: h - 1,
      usedFallback: true,
    };
  }

  return { xL, xR, yT, yB, usedFallback: false };
}

/**
 * Simple “group center” detector:
 * - Threshold dark pixels
 * - Ignore a margin around edges + ignore a band around center axes (to avoid counting the thick cross)
 * - Returns centroid (x,y) in pixels, or null if nothing found
 *
 * This is intentionally simple to get your 23x23 + 4-hole case stable first.
 */
function findGroupCenter(gray, w, h, edges, centerPx) {
  const DARK = 140; // dark pixel threshold (tune later if needed)

  const margin = Math.max(6, Math.round(Math.min(w, h) * 0.01));     // ignore near frame
  const axisBand = Math.max(10, Math.round(Math.min(w, h) * 0.02));  // ignore thick cross area

  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (let y = edges.yT + margin; y <= edges.yB - margin; y++) {
    const rowStart = y * w;
    for (let x = edges.xL + margin; x <= edges.xR - margin; x++) {
      // ignore central cross bands
      if (Math.abs(x - centerPx.x) < axisBand) continue;
      if (Math.abs(y - centerPx.y) < axisBand) continue;

      const v = gray[rowStart + x];
      if (v < DARK) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count < 30) return null; // too few dark pixels; treat as "not found"
  return { x: sumX / count, y: sumY / count, count };
}

// ---------- Routes ----------
app.get("/health", (req, res) => {
  res.status(200).send(
    JSON.stringify({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD_TAG,
      ts: Date.now(),
    })
  );
});

app.get("/", (req, res) => {
  res.status(200).send(
    JSON.stringify({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD_TAG,
      ts: Date.now(),
      note: 'Use POST /api/sec (multipart: field "image" + optional fields).',
    })
  );
});

// IMPORTANT: field name must be exactly "image"
app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const file = req.file || null;

    const debugBody = req.body || {};
    const debugKeys = Object.keys(debugBody || {});

    if (!file || !file.buffer) {
      return res.status(400).send(
        JSON.stringify({
          ok: false,
          error: 'No file uploaded. Use multipart field name "image".',
          build: BUILD_TAG,
          debugBody,
          debugKeys,
        })
      );
    }

    // Read optional numeric fields (form-data comes in as strings)
    const distanceYards = toNumberOrDefault(req.body?.distanceYards, 100);
    const clickValueMoa = toNumberOrDefault(req.body?.clickValueMoa, 0.25);
    const targetSizeInches = toNumberOrDefault(req.body?.targetSizeInches, 23);

    // Accept both poibX/poibY and poibx/poiby
    const poibX_in = toNumberOrDefault(
      req.body?.poibX ?? req.body?.poibx,
      NaN
    );
    const poibY_in = toNumberOrDefault(
      req.body?.poibY ?? req.body?.poiby,
      NaN
    );

    const manualOverride = Number.isFinite(poibX_in) && Number.isFinite(poibY_in);

    // Basic image metadata (original)
    const origMeta = await sharp(file.buffer).metadata();

    // Normalize for stable math
    const normWidth = 1100;
    const norm = sharp(file.buffer).rotate();
    const normMeta = await norm.metadata();

    // Resize to 1100px wide (maintains aspect)
    const resized = sharp(file.buffer).rotate().resize({ width: normWidth });
    const resizedMeta = await resized.metadata();

    // Grayscale raw
    const grayImg = resized.clone().grayscale();
    const { data, info } = await grayImg.raw().toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;

    // Find border box + compute center INSIDE that box (fixes wrong-center bug)
    const edges = findBorderBox(data, w, h);
    const centerPx = {
      x: (edges.xL + edges.xR) / 2,
      y: (edges.yT + edges.yB) / 2,
    };

    const borderW = edges.xR - edges.xL;
    const borderH = edges.yB - edges.yT;

    // Use the larger of W/H for pixels-per-inch (square target; guards minor crop skew)
    const pxPerInch = (Math.max(borderW, borderH) || w) / targetSizeInches;

    // Compute POIB inches
    let poibInches = { x: 0, y: 0 };
    let computeStatus = "UNKNOWN";

    if (manualOverride) {
      // Convention (input):
      // POIB inches: Right + / Left - | Up + / Down -
      poibInches = { x: poibX_in, y: poibY_in };
      computeStatus = "MANUAL_POIB_OVERRIDE";
    } else {
      // Auto: derive group center from image
      const groupCenter = findGroupCenter(data, w, h, edges, centerPx);

      if (!groupCenter || !Number.isFinite(pxPerInch) || pxPerInch <= 0) {
        poibInches = { x: 0, y: 0 };
        computeStatus = "COMPUTED_FROM_IMAGE_NOT_FOUND";
      } else {
        // Convert pixels -> inches
        // x: right positive
        const dxPx = groupCenter.x - centerPx.x;
        // y: up positive (image y grows downward)
        const dyPx = centerPx.y - groupCenter.y;

        poibInches = {
          x: round2(dxPx / pxPerInch),
          y: round2(dyPx / pxPerInch),
        };
        computeStatus = "COMPUTED_FROM_IMAGE";
      }
    }

    // CORRECTION clicks (what to dial) = NEGATIVE of POIB offset
    const ipc = inchesPerClick(distanceYards, clickValueMoa);
    const windageClicks = ipc === 0 ? 0 : (-poibInches.x / ipc);
    const elevationClicks = ipc === 0 ? 0 : (-poibInches.y / ipc);

    const clicksSigned = {
      windage: round2(windageClicks),
      elevation: round2(elevationClicks),
    };

    const dial = {
      windage: dialText("windage", clicksSigned.windage),
      elevation: dialText("elevation", clicksSigned.elevation),
    };

    return res.status(200).send(
      JSON.stringify({
        ok: true,
        service: "sczn3-sec-backend-pipe",
        build: BUILD_TAG,

        received: {
          field: file.fieldname,
          originalname: file.originalname,
          mimetype: file.mimetype,
          bytes: file.size,
        },

        image: {
          width: origMeta.width || null,
          height: origMeta.height || null,
          format: origMeta.format || null,
          normalizedWidth: w,
          normalizedHeight: h,
        },

        detect: {
          targetSizeInches,
          pixelsPerInch: round2(pxPerInch),
          edges,
          borderPx: { w: borderW, h: borderH },
          centerPx: { x: round2(centerPx.x), y: round2(centerPx.y) },
        },

        sec: {
          distanceYards,
          clickValueMoa,
          center: { col: "L", row: 12 },

          // POIB inches (Right+/Left-, Up+/Down-)
          poibInches,

          // Signed CORRECTION clicks (what to dial)
          clicksSigned,

          // Readable instruction
          dial,

          computeStatus,
        },

        debugBody,
        debugKeys,
        ts: Date.now(),
      })
    );
  } catch (err) {
    return res.status(500).send(
      JSON.stringify({
        ok: false,
        error: String(err?.message || err),
        build: BUILD_TAG,
        ts: Date.now(),
      })
    );
  }
});

// Render sets PORT
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SCZN3 SEC backend listening on ${PORT} (${BUILD_TAG})`);
});
