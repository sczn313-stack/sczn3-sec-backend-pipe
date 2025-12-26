// server.js — SCZN3 SEC Backend (REAL: image POIB + sign-correct)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart: field "image" + optional fields:
//   poibX, poibY (inches)   distanceYards (yards)   clickValueMoa (MOA per click)   targetSizeInches (default 23)
//
// Conventions:
//   POIB inches: Right + / Left -   |   Up + / Down -
//   OUTPUT clicks are CORRECTION clicks (what to dial) = NEGATIVE of POIB offset.
//     If POIB is RIGHT (+), correction is LEFT (-).
//     If POIB is UP (+), correction is DOWN (-).

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "REAL_CLEAN_2025-12-26_SIGNCORRECT";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Always return JSON
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// Multer memory storage
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

// Dial text for CORRECTION clicks (signed)
function dialText(axisName, clicksSigned) {
  const abs = Math.abs(clicksSigned);
  const rounded = Math.round(abs * 100) / 100; // 2 decimals

  if (axisName === "windage") {
    if (rounded === 0) return "CENTER 0.00 clicks";
    return clicksSigned >= 0 ? `RIGHT ${rounded} clicks` : `LEFT ${rounded} clicks`;
  }

  // elevation
  if (rounded === 0) return "LEVEL 0.00 clicks";
  return clicksSigned >= 0 ? `UP ${rounded} clicks` : `DOWN ${rounded} clicks`;
}

/**
 * Basic image POIB estimator (stable + fast)
 * - Resizes image to maxWidth=1100 to normalize workload
 * - Finds crosshair center by locating darkest vertical/horizontal bands (thick black bars)
 * - Detects "hole pixels" as very dark pixels excluding a band around the crosshair
 * - Computes centroid of hole pixels
 * - Converts centroid offset to inches using targetSizeInches mapped to full image width/height
 *
 * Returns: { poibX, poibY, computeStatus, debug }
 */
async function computePoibFromImage(buffer, targetSizeInches) {
  const maxWidth = 1100;

  const img = sharp(buffer).rotate(); // honor EXIF orientation
  const meta = await img.metadata();

  const resized =
    meta.width && meta.width > maxWidth
      ? img.resize({ width: maxWidth })
      : img;

  const gray = resized.grayscale();
  const m2 = await gray.metadata();

  const w = m2.width || 0;
  const h = m2.height || 0;

  if (!w || !h) {
    return {
      poibX: 0,
      poibY: 0,
      computeStatus: "IMAGE_METADATA_MISSING",
      debug: { w, h },
    };
  }

  // Get raw grayscale pixels
  const { data } = await gray.raw().toBuffer({ resolveWithObject: true });

  // --- Find crosshair center via darkest column/row ---
  // We sum "darkness" = (255 - pixel) across each column/row.
  const colDark = new Float64Array(w);
  const rowDark = new Float64Array(h);

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x++) {
      const p = data[rowOffset + x]; // 0..255
      const d = 255 - p;
      colDark[x] += d;
      rowDark[y] += d;
    }
  }

  let xCenter = 0;
  let yCenter = 0;
  let xBest = -Infinity;
  let yBest = -Infinity;

  for (let x = 0; x < w; x++) {
    if (colDark[x] > xBest) {
      xBest = colDark[x];
      xCenter = x;
    }
  }
  for (let y = 0; y < h; y++) {
    if (rowDark[y] > yBest) {
      yBest = rowDark[y];
      yCenter = y;
    }
  }

  // --- Detect hole pixels ---
  // Threshold for "very dark" pixels (holes are near-black in your test shots)
  const holeThresh = 80; // smaller = darker
  const excludeBand = Math.max(18, Math.round(Math.min(w, h) * 0.02)); // exclude crosshair area

  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    const dy = Math.abs(y - yCenter);
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x - xCenter);

      // exclude the thick crosshair bars
      if (dx <= excludeBand || dy <= excludeBand) continue;

      const p = data[rowOffset + x];
      if (p <= holeThresh) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }

  if (count < 20) {
    return {
      poibX: 0,
      poibY: 0,
      computeStatus: "NO_HOLES_DETECTED",
      debug: { w, h, xCenter, yCenter, count },
    };
  }

  const cx = sumX / count;
  const cy = sumY / count;

  // Convert to inches (simple mapping of full image width/height to targetSizeInches)
  // POIB X: Right + / Left -
  const poibX = ((cx - xCenter) * targetSizeInches) / w;

  // POIB Y: Up + / Down -
  const poibY = ((yCenter - cy) * targetSizeInches) / h;

  return {
    poibX,
    poibY,
    computeStatus: "COMPUTED_FROM_IMAGE",
    debug: {
      w,
      h,
      xCenter,
      yCenter,
      holes: count,
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
      note: 'Use POST /api/sec (multipart: field "image" + optional poibX/poibY).',
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

    // Inputs
    const distanceYards = toNumberOrDefault(req.body?.distanceYards, 100);
    const clickValueMoa = toNumberOrDefault(req.body?.clickValueMoa, 0.25);
    const targetSizeInches = toNumberOrDefault(req.body?.targetSizeInches, 23);

    // Manual POIB override if both fields are present (even if "0")
    const hasPoibX = req.body?.poibX !== undefined && req.body?.poibX !== null && String(req.body?.poibX).trim() !== "";
    const hasPoibY = req.body?.poibY !== undefined && req.body?.poibY !== null && String(req.body?.poibY).trim() !== "";
    const manualOverride = hasPoibX || hasPoibY;

    let poibX = 0;
    let poibY = 0;
    let computeStatus = "DEFAULT_ZERO";
    let detect = null;

    if (manualOverride) {
      poibX = toNumberOrDefault(req.body?.poibX, 0);
      poibY = toNumberOrDefault(req.body?.poibY, 0);
      computeStatus = "MANUAL_POIB_OVERRIDE";
    } else {
      const r = await computePoibFromImage(file.buffer, targetSizeInches);
      poibX = r.poibX;
      poibY = r.poibY;
      computeStatus = r.computeStatus;
      detect = r.debug;
    }

    // Click computation (2-decimal)
    const ipc = inchesPerClick(distanceYards, clickValueMoa);

    // CORRECTION clicks = NEGATIVE of POIB offset
    const windageClicksSigned = ipc === 0 ? 0 : (-poibX / ipc);
    const elevationClicksSigned = ipc === 0 ? 0 : (-poibY / ipc);

    const clicksSigned = {
      windage: Math.round(windageClicksSigned * 100) / 100,
      elevation: Math.round(elevationClicksSigned * 100) / 100,
    };

    const dial = {
      windage: dialText("windage", clicksSigned.windage),
      elevation: dialText("elevation", clicksSigned.elevation),
    };

    // Basic image metadata (safe)
    const meta = await sharp(file.buffer).metadata();

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
        },

        // Minimal detect debug (null if manual)
        detect,

        sec: {
          distanceYards,
          clickValueMoa,
          targetSizeInches,

          // Echo POIB used (Right+/Left-, Up+/Down-)
          poibInches: {
            x: Math.round(poibX * 100) / 100,
            y: Math.round(poibY * 100) / 100,
          },

          // Signed CORRECTION clicks: Right+/Left-, Up+/Down-
          clicksSigned,

          // Readable instruction
          dial,

          computeStatus,
        },

        // DEBUG: shows exactly what multipart fields arrived
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
