// server.js — SCZN3 SEC Backend (REAL COMPUTE + SIGN FIX)
// Always JSON (never HTML error pages)
//
// POST /api/sec accepts multipart field "image" + optional fields:
//   distanceYards (yards)
//   clickValueMoa (MOA per click)
//   targetSizeInches (physical target width/height, default 23)
//   poibX, poibY (inches) OPTIONAL manual override
//
// Conventions:
//   POIB inches:  Right + / Left -   |   Up + / Down -
//   OUTPUT clicks are CORRECTION clicks (what to dial) = NEGATIVE of POIB offset.
//     If POIB is RIGHT (+), correction is LEFT (-).
//     If POIB is UP (+), correction is DOWN (-).

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "REAL_v3_2025-12-26_IMAGE_POIB_FIX";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Force JSON content-type on everything
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// Multer memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

// ---------------- Helpers ----------------
function toNumberOrDefault(v, def) {
  if (v === undefined || v === null) return def;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : def;
}

function hasKey(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// 1 MOA ≈ 1.047" at 100 yards
function inchesPerClick(distanceYards, clickValueMoa) {
  return 1.047 * (distanceYards / 100) * clickValueMoa;
}

// For CORRECTION clicks:
// windage: + = RIGHT, - = LEFT
// elevation: + = UP, - = DOWN
function dialText(axisName, clicksSigned) {
  const abs = Math.abs(clicksSigned);
  const rounded = Math.round(abs * 100) / 100;
  if (axisName === "windage") {
    return clicksSigned >= 0 ? `RIGHT ${rounded} clicks` : `LEFT ${rounded} clicks`;
  }
  return clicksSigned >= 0 ? `UP ${rounded} clicks` : `DOWN ${rounded} clicks`;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// --------- Image processing + POIB compute ---------
//
// Strategy (fast + robust for your target):
// 1) Normalize to fixed width (default 1100px), rotate to correct EXIF.
// 2) Convert to grayscale RAW buffer.
// 3) Detect outer border edges by scanning for heavy dark columns/rows.
// 4) Compute pixels-per-inch using border width and targetSizeInches.
// 5) Detect bullet holes as dark connected components,
//    while masking out the thick center cross and the header band.
// 6) POIB inches = (groupCenter - targetCenter) / ppi
//    with Y inverted so Up is positive.
// 7) CORRECTION clicks = -POIB / inchesPerClick

async function loadNormalizedGrayRaw(buffer, normalizedWidth = 1100) {
  // rotate() respects EXIF orientation
  const img = sharp(buffer).rotate();

  const meta = await img.metadata();

  // Resize to fixed width to stabilize detection
  const resized = img.resize({ width: normalizedWidth });

  // Grayscale raw output
  const { data, info } = await resized
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Compute gray mean (simple)
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const grayMean = data.length ? sum / data.length : 0;

  return {
    origMeta: meta,
    gray: new Uint8Array(data),
    w: info.width,
    h: info.height,
    grayMean,
    normalizedWidth: info.width,
    normalizedHeight: info.height,
  };
}

// Find border edges by scanning for columns/rows with strong dark density
function findBorderEdges(gray, w, h, grayThreshold) {
  const isDark = (v) => v < grayThreshold;

  const colDarkFrac = (x) => {
    let dark = 0;
    for (let y = 0; y < h; y++) {
      if (isDark(gray[y * w + x])) dark++;
    }
    return dark / h;
  };

  const rowDarkFrac = (y) => {
    let dark = 0;
    const rowStart = y * w;
    for (let x = 0; x < w; x++) {
      if (isDark(gray[rowStart + x])) dark++;
    }
    return dark / w;
  };

  // Border lines are very dark and span almost full height/width,
  // so we look for a column/row where dark fraction exceeds this threshold.
  const BORDER_FRAC = 0.12;

  let xL = 0;
  for (let x = 0; x < w; x++) {
    if (colDarkFrac(x) > BORDER_FRAC) {
      xL = x;
      break;
    }
  }

  let xR = w - 1;
  for (let x = w - 1; x >= 0; x--) {
    if (colDarkFrac(x) > BORDER_FRAC) {
      xR = x;
      break;
    }
  }

  let yT = 0;
  for (let y = 0; y < h; y++) {
    if (rowDarkFrac(y) > BORDER_FRAC) {
      yT = y;
      break;
    }
  }

  let yB = h - 1;
  for (let y = h - 1; y >= 0; y--) {
    if (rowDarkFrac(y) > BORDER_FRAC) {
      yB = y;
      break;
    }
  }

  // Safety clamps
  xL = clamp(xL, 0, w - 2);
  xR = clamp(xR, xL + 1, w - 1);
  yT = clamp(yT, 0, h - 2);
  yB = clamp(yB, yT + 1, h - 1);

  return { xL, xR, yT, yB, borderW: xR - xL, borderH: yB - yT };
}

// Connected components to find bullet holes (dark blobs), with masks
function detectHoles(gray, w, h, opts) {
  const {
    grayThreshold,
    xL,
    xR,
    yT,
    yB,
    centerX,
    centerY,
    axisBandPx = 14,     // mask out thick cross
    headerBandPx = 90,   // mask out title/instruction area at top
    minArea = 25,
    maxArea = 5000,
  } = opts;

  const visited = new Uint8Array(w * h);

  const isInsideBorder = (x, y) => x >= xL && x <= xR && y >= yT && y <= yB;
  const isInAxisBand = (x, y) =>
    Math.abs(x - centerX) <= axisBandPx || Math.abs(y - centerY) <= axisBandPx;
  const isInHeaderBand = (x, y) => y < yT + headerBandPx;

  const isDark = (x, y) => gray[y * w + x] < grayThreshold;

  const holes = [];

  // scan only inside border box
  for (let y = yT; y <= yB; y++) {
    for (let x = xL; x <= xR; x++) {
      const idx = y * w + x;
      if (visited[idx]) continue;

      visited[idx] = 1;

      // Mask regions we never want to treat as holes
      if (!isInsideBorder(x, y) || isInAxisBand(x, y) || isInHeaderBand(x, y)) continue;

      if (!isDark(x, y)) continue;

      // Flood fill
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = x, maxX = x, minY = y, maxY = y;

      const stack = [idx];

      while (stack.length) {
        const cur = stack.pop();
        const cy = Math.floor(cur / w);
        const cx = cur - cy * w;

        area++;
        sumX += cx;
        sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 4-neighborhood
        const n1 = cur - 1;
        const n2 = cur + 1;
        const n3 = cur - w;
        const n4 = cur + w;

        // left
        if (cx > xL && !visited[n1]) {
          visited[n1] = 1;
          const nx = cx - 1, ny = cy;
          if (!isInAxisBand(nx, ny) && !isInHeaderBand(nx, ny) && isDark(nx, ny)) stack.push(n1);
        }
        // right
        if (cx < xR && !visited[n2]) {
          visited[n2] = 1;
          const nx = cx + 1, ny = cy;
          if (!isInAxisBand(nx, ny) && !isInHeaderBand(nx, ny) && isDark(nx, ny)) stack.push(n2);
        }
        // up
        if (cy > yT && !visited[n3]) {
          visited[n3] = 1;
          const nx = cx, ny = cy - 1;
          if (!isInAxisBand(nx, ny) && !isInHeaderBand(nx, ny) && isDark(nx, ny)) stack.push(n3);
        }
        // down
        if (cy < yB && !visited[n4]) {
          visited[n4] = 1;
          const nx = cx, ny = cy + 1;
          if (!isInAxisBand(nx, ny) && !isInHeaderBand(nx, ny) && isDark(nx, ny)) stack.push(n4);
        }
      }

      if (area < minArea || area > maxArea) continue;

      // Extra filter: very thin text-like blobs often have extreme aspect ratios
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const aspect = bw / bh;
      if (aspect < 0.2 || aspect > 5.0) continue;

      const cx = sumX / area;
      const cy = sumY / area;

      holes.push({
        area,
        bbox: { x1: minX, y1: minY, x2: maxX, y2: maxY, w: bw, h: bh },
        centerPx: { x: cx, y: cy },
      });
    }
  }

  return holes;
}

function meanPoint(points) {
  if (!points.length) return null;
  let sx = 0, sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

// ---------------- Routes ----------------
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
          ts: Date.now(),
        })
      );
    }

    // Inputs (defaults match your standard)
    const distanceYards = toNumberOrDefault(req.body?.distanceYards, 100);
    const clickValueMoa = toNumberOrDefault(req.body?.clickValueMoa, 0.25);
    const targetSizeInches = toNumberOrDefault(req.body?.targetSizeInches, 23);

    // Manual POIB override if either key exists in the multipart body
    const manualOverride = hasKey(req.body, "poibX") || hasKey(req.body, "poibY");
    const poibX_manual = toNumberOrDefault(req.body?.poibX, 0);
    const poibY_manual = toNumberOrDefault(req.body?.poibY, 0);

    // Image metadata (original)
    const origMeta = await sharp(file.buffer).metadata();

    // Normalize + grayscale raw
    const normalizedWidth = 1100;
    const grayObj = await loadNormalizedGrayRaw(file.buffer, normalizedWidth);

    // Dynamic-ish threshold (works well with your very white background)
    // If your photos are darker, this will still stay sane.
    const grayThreshold = clamp(140, 90, 200);

    // Border edges
    const edges = findBorderEdges(grayObj.gray, grayObj.w, grayObj.h, grayThreshold);

    const centerPx = {
      x: (edges.xL + edges.xR) / 2,
      y: (edges.yT + edges.yB) / 2,
    };

    // Pixels per inch (use width primarily, fall back to avg)
    const ppiW = edges.borderW / targetSizeInches;
    const ppiH = edges.borderH / targetSizeInches;
    const pixelsPerInch = (ppiW + ppiH) / 2;

    // Compute POIB from image if not manual override
    let poibX = poibX_manual;
    let poibY = poibY_manual;

    let holes = [];
    let groupCenterPx = null;

    if (!manualOverride) {
      holes = detectHoles(grayObj.gray, grayObj.w, grayObj.h, {
        grayThreshold,
        xL: edges.xL,
        xR: edges.xR,
        yT: edges.yT,
        yB: edges.yB,
        centerX: centerPx.x,
        centerY: centerPx.y,
        axisBandPx: 14,
        headerBandPx: 90,
        minArea: 25,
        maxArea: 5000,
      });

      // Use mean of detected hole centers (simple + stable for now)
      const holeCenters = holes.map((h) => h.centerPx);
      groupCenterPx = meanPoint(holeCenters);

      if (!groupCenterPx) {
        // If we can't find holes, return a clear JSON error
        return res.status(422).send(
          JSON.stringify({
            ok: false,
            error: "No bullet holes detected in image.",
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
              normalizedWidth: grayObj.normalizedWidth,
              normalizedHeight: grayObj.normalizedHeight,
              grayThreshold,
              grayMean: Math.round(grayObj.grayMean * 100) / 100,
            },
            detect: {
              targetSizeInches,
              borderPx: { w: edges.borderW, h: edges.borderH },
              pixelsPerInch: Math.round(pixelsPerInch * 100) / 100,
              edges: { xL: edges.xL, xR: edges.xR, yT: edges.yT, yB: edges.yB },
              centerPx,
              holesDetected: 0,
            },
            debugBody,
            debugKeys,
            ts: Date.now(),
          })
        );
      }

      // POIB inches (Right + / Left -, Up + / Down -)
      // NOTE: pixel Y increases downward, so Up is (centerY - groupY)
      poibX = (groupCenterPx.x - centerPx.x) / pixelsPerInch;
      poibY = (centerPx.y - groupCenterPx.y) / pixelsPerInch;
    }

    // ---- CORRECTION CLICKS (SIGN FIX) ----
    // what to dial = -POIB / inchesPerClick
    const ipc = inchesPerClick(distanceYards, clickValueMoa);

    const windageClicks = ipc === 0 ? 0 : (-poibX / ipc);
    const elevationClicks = ipc === 0 ? 0 : (-poibY / ipc);

    const clicksSigned = {
      windage: Math.round(windageClicks * 100) / 100,
      elevation: Math.round(elevationClicks * 100) / 100,
    };

    const dial = {
      windage: dialText("windage", clicksSigned.windage),
      elevation: dialText("elevation", clicksSigned.elevation),
    };

    const computeStatus = manualOverride ? "MANUAL_POIB_OVERRIDE" : "COMPUTED_FROM_IMAGE";

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

          normalizedWidth: grayObj.normalizedWidth,
          normalizedHeight: grayObj.normalizedHeight,
          grayThreshold,
          grayMean: Math.round(grayObj.grayMean * 100) / 100,
        },

        detect: {
          targetSizeInches,
          borderPx: { w: edges.borderW, h: edges.borderH },
          pixelsPerInch: Math.round(pixelsPerInch * 100) / 100,
          edges: { xL: edges.xL, xR: edges.xR, yT: edges.yT, yB: edges.yB },
          centerPx: { x: Math.round(centerPx.x * 10) / 10, y: Math.round(centerPx.y * 10) / 10 },
          groupCenterPx: groupCenterPx
            ? { x: Math.round(groupCenterPx.x * 10) / 10, y: Math.round(groupCenterPx.y * 10) / 10 }
            : null,
          holesDetected: holes.length,
          holes: holes.slice(0, 25), // keep response reasonable
        },

        sec: {
          distanceYards,
          clickValueMoa,
          targetSizeInches,
          center: { col: "L", row: 12 },

          // POIB used (inches): Right+/Left-, Up+/Down-
          poibInches: {
            x: Math.round(poibX * 100) / 100,
            y: Math.round(poibY * 100) / 100,
          },

          // CORRECTION clicks (what to dial)
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
