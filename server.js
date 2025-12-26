// server.js — SCZN3 SEC Backend (REAL COMPUTE + SIGN FIX)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart: field "image" + optional fields:
//   distanceYards (yards), clickValueMoa (MOA/click), targetSizeInches (default 23)
//   poibX, poibY (inches) OPTIONAL manual override:
//     - If poibX/poibY are provided, backend uses them instead of computing from image.
//
// IMPORTANT FIX:
// We output CORRECTION clicks (what to dial) = NEGATIVE of POIB offset.
// If POIB is RIGHT (+), correction is LEFT (-). If POIB is UP (+), correction is DOWN (-).

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "REAL_v2_2025-12-26_SIGNFIX";

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
  const s = String(v).trim();
  if (!s) return def;
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}

function hasNumber(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim();
  if (!s) return false;
  const n = Number(s);
  return Number.isFinite(n);
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
  if (axisName === "windage") {
    if (rounded === 0) return "CENTER (0.00 clicks)";
    return clicksSigned >= 0 ? `RIGHT ${rounded} clicks` : `LEFT ${rounded} clicks`;
  }
  // elevation
  if (rounded === 0) return "LEVEL (0.00 clicks)";
  return clicksSigned >= 0 ? `UP ${rounded} clicks` : `DOWN ${rounded} clicks`;
}

// ---------- Image / Compute (simple, robust baseline) ----------
//
// Assumptions for v1 REAL compute:
// - target is mostly square in frame
// - outer border exists and is the darkest frame
// - bullet holes are dark blobs on bright background
// - ignore thick center cross by masking a band around center lines
//
// Output: poibInches {x,y} where
//   x: Right + / Left -
//   y: Up + / Down -
//
async function computePoibFromImage(buffer, targetSizeInches = 23) {
  // Normalize: resize to max 1100px wide (keeps it fast and consistent)
  // (If your image is already smaller, it will remain as-is.)
  const normalized = sharp(buffer).rotate().resize({ width: 1100, withoutEnlargement: true });

  // Convert to grayscale raw pixels
  const { data, info } = await normalized
    .clone()
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;

  // Basic stats (for debug)
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const grayMean = sum / data.length;

  // Border detection thresholds
  const borderDarkThresh = 60; // border/cross is near black
  const edgeFrac = 0.01; // % of row/col that must be dark to be considered "border-like"

  function rowDarkCount(y) {
    let c = 0;
    const rowStart = y * w;
    for (let x = 0; x < w; x++) {
      if (data[rowStart + x] <= borderDarkThresh) c++;
    }
    return c;
  }

  function colDarkCount(x) {
    let c = 0;
    for (let y = 0; y < h; y++) {
      if (data[y * w + x] <= borderDarkThresh) c++;
    }
    return c;
  }

  // Find outer border by scanning from edges inward
  const rowMinDark = Math.max(1, Math.floor(w * edgeFrac));
  const colMinDark = Math.max(1, Math.floor(h * edgeFrac));

  let yT = 0;
  for (let y = 0; y < h; y++) {
    if (rowDarkCount(y) >= rowMinDark) {
      yT = y;
      break;
    }
  }

  let yB = h - 1;
  for (let y = h - 1; y >= 0; y--) {
    if (rowDarkCount(y) >= rowMinDark) {
      yB = y;
      break;
    }
  }

  let xL = 0;
  for (let x = 0; x < w; x++) {
    if (colDarkCount(x) >= colMinDark) {
      xL = x;
      break;
    }
  }

  let xR = w - 1;
  for (let x = w - 1; x >= 0; x--) {
    if (colDarkCount(x) >= colMinDark) {
      xR = x;
      break;
    }
  }

  // Sanity clamp
  const borderW = Math.max(1, xR - xL);
  const borderH = Math.max(1, yB - yT);

  // Center (pixel)
  const centerX = xL + borderW / 2;
  const centerY = yT + borderH / 2;

  // Pixels per inch using detected border width (target is square)
  const pixelsPerInch = borderW / Math.max(1, targetSizeInches);

  // Bullet-hole threshold (darker than background but lighter than border)
  // If mean is very bright, 110 works well. If mean is darker, raise slightly.
  const holeThresh = grayMean > 220 ? 120 : 135;

  // Mask out thick center cross lines to avoid picking them up as blobs
  const crossBandPx = Math.max(10, Math.floor(borderW * 0.02)); // about 2% of target width

  function inBorder(x, y) {
    return x >= xL && x <= xR && y >= yT && y <= yB;
  }

  function inCrossBand(x, y) {
    return Math.abs(x - centerX) <= crossBandPx || Math.abs(y - centerY) <= crossBandPx;
  }

  // Connected components on dark pixels inside border, excluding cross band
  const visited = new Uint8Array(w * h);

  const minArea = 25;   // reject tiny noise
  const maxArea = 3000; // reject huge blobs
  const margin = 10;    // avoid border edges

  const holes = [];

  function idx(x, y) {
    return y * w + x;
  }

  const qx = new Int32Array(w * h); // worst-case queue (oversized but fast)
  const qy = new Int32Array(w * h);

  for (let y = yT + margin; y <= yB - margin; y++) {
    for (let x = xL + margin; x <= xR - margin; x++) {
      const i = idx(x, y);
      if (visited[i]) continue;

      // Candidate hole pixel?
      if (!inBorder(x, y) || inCrossBand(x, y) || data[i] > holeThresh) {
        visited[i] = 1;
        continue;
      }

      // BFS flood fill
      let head = 0;
      let tail = 0;
      qx[tail] = x;
      qy[tail] = y;
      tail++;

      visited[i] = 1;

      let area = 0;
      let sumX = 0;
      let sumY = 0;

      let minX = x, maxX = x, minY = y, maxY = y;

      while (head < tail) {
        const cx = qx[head];
        const cy = qy[head];
        head++;

        area++;
        sumX += cx;
        sumY += cy;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 4-neighborhood
        const neigh = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];

        for (let k = 0; k < 4; k++) {
          const nx = neigh[k][0];
          const ny = neigh[k][1];
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;

          const ni = idx(nx, ny);
          if (visited[ni]) continue;
          visited[ni] = 1;

          if (!inBorder(nx, ny) || inCrossBand(nx, ny)) continue;
          if (data[ni] > holeThresh) continue;

          qx[tail] = nx;
          qy[tail] = ny;
          tail++;
        }
      }

      // Filter component by area and shape
      if (area < minArea || area > maxArea) continue;

      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;

      // Reject extremely long blobs (usually cross remnants)
      const aspect = boxW > boxH ? boxW / Math.max(1, boxH) : boxH / Math.max(1, boxW);
      if (aspect > 6) continue;

      const cx = sumX / area;
      const cy = sumY / area;

      holes.push({
        cx,
        cy,
        area,
        box: { minX, minY, maxX, maxY, boxW, boxH },
      });
    }
  }

  if (holes.length === 0) {
    return {
      ok: false,
      reason: "NO_HOLES_DETECTED",
      debug: { w, h, grayMean: round2(grayMean), holeThresh, border: { xL, xR, yT, yB }, pixelsPerInch: round2(pixelsPerInch) },
    };
  }

  // POIB = average centroid of detected holes
  let meanX = 0;
  let meanY = 0;
  for (const p of holes) {
    meanX += p.cx;
    meanY += p.cy;
  }
  meanX /= holes.length;
  meanY /= holes.length;

  // Convert pixel offset → inches
  // x: Right+ / Left-
  const poibX = (meanX - centerX) / pixelsPerInch;

  // y: Up+ / Down-  (pixel Y increases downward)
  const poibY = (centerY - meanY) / pixelsPerInch;

  return {
    ok: true,
    poibInches: { x: round2(poibX), y: round2(poibY) },
    debug: {
      w,
      h,
      normalizedWidth: w,
      normalizedHeight: h,
      grayMean: round2(grayMean),
      grayThreshold: holeThresh,
      borderPx: { w: borderW, h: borderH },
      edges: { xL, xR, yT, yB },
      centerPx: { x: round2(centerX), y: round2(centerY) },
      pixelsPerInch: round2(pixelsPerInch),
      holesDetected: holes.length,
      holes: holes.slice(0, 25), // cap debug
    },
  };
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
      note: 'Use POST /api/sec (multipart: field "image"). Optional: distanceYards, clickValueMoa, targetSizeInches, poibX, poibY.',
    })
  );
});

// IMPORTANT: field name must be exactly "image"
app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const file = req.file || null;

    // DEBUG: show exactly what multipart fields arrived
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
          ts: Date.now(),
        })
      );
    }

    // Read numeric fields (strings in multipart)
    const distanceYards = toNumberOrDefault(req.body?.distanceYards, 100);
    const clickValueMoa = toNumberOrDefault(req.body?.clickValueMoa, 0.25);
    const targetSizeInches = toNumberOrDefault(req.body?.targetSizeInches, 23);

    // Manual override (if provided)
    const manualXProvided = hasNumber(req.body?.poibX);
    const manualYProvided = hasNumber(req.body?.poibY);
    const manualOverride = manualXProvided && manualYProvided;

    let poibX = manualOverride ? toNumberOrDefault(req.body?.poibX, 0) : 0;
    let poibY = manualOverride ? toNumberOrDefault(req.body?.poibY, 0) : 0;

    // Basic image metadata
    const meta = await sharp(file.buffer).metadata();

    let computeStatus = "STUB";
    let detect = null;

    if (!manualOverride) {
      // Compute POIB from the image
      const computed = await computePoibFromImage(file.buffer, targetSizeInches);

      if (!computed.ok) {
        return res.status(422).send(
          JSON.stringify({
            ok: false,
            error: computed.reason || "COMPUTE_FAILED",
            service: "sczn3-sec-backend-pipe",
            build: BUILD_TAG,
            received: {
              field: file.fieldname,
              originalname: file.originalname,
              mimetype: file.mimetype,
              bytes: file.size,
            },
            image: {
              width: meta.width || null,
              height: meta.height || null,
              format: meta.format || null,
            },
            detect: computed.debug || null,
            debugBody,
            debugKeys,
            ts: Date.now(),
          })
        );
      }

      poibX = computed.poibInches.x;
      poibY = computed.poibInches.y;
      detect = computed.debug;
      computeStatus = "COMPUTED_FROM_IMAGE";
    } else {
      computeStatus = "MANUAL_POIB_OVERRIDE";
    }

    // Click computation (CORRECTION = -POIB)
    const ipc = inchesPerClick(distanceYards, clickValueMoa);

    // IMPORTANT: correction clicks are NEGATIVE of POIB
    const windageClicksSigned = ipc === 0 ? 0 : (-poibX / ipc);
    const elevationClicksSigned = ipc === 0 ? 0 : (-poibY / ipc);

    const clicksSigned = {
      windage: round2(windageClicksSigned),
      elevation: round2(elevationClicksSigned),
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
          width: meta.width || null,
          height: meta.height || null,
          format: meta.format || null,
          normalizedWidth: detect?.normalizedWidth ?? null,
          normalizedHeight: detect?.normalizedHeight ?? null,
          grayThreshold: detect?.grayThreshold ?? null,
          grayMean: detect?.grayMean ?? null,
        },

        detect,

        sec: {
          distanceYards,
          clickValueMoa,
          targetSizeInches,
          center: { col: "L", row: 12 },

          // Echo POIB (where impacts landed)
          poibInches: { x: poibX, y: poibY },

          // Output CORRECTION clicks (what to dial)
          clicksSigned,

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
