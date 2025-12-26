// server.js — SCZN3 SEC Backend (PIPE)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart: field "image" + optional fields:
//   poibX, poibY (inches)   distanceYards (yards)   clickValueMoa (MOA per click)
//
// IMPORTANT FIX:
// We output *CORRECTION* clicks (what to dial) = NEGATIVE of POIB offset.
// If POIB is RIGHT (+), correction is LEFT (-). If POIB is UP (+), correction is DOWN (-).

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "PIPE_v4_SIGNFIX_2025-12-26";

const app = express();

// CORS: allow requests from your Static Site + browser testing
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Always return JSON (avoid Render/Express default HTML errors)
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// Multer memory storage (we want the raw bytes in RAM)
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

// click sign convention (CORRECTION):
// windage: +RIGHT / -LEFT
// elevation: +UP / -DOWN
function dialText(axisName, clicksSigned) {
  const abs = Math.abs(clicksSigned);
  const rounded = Math.round(abs * 100) / 100; // 2 decimals

  if (axisName === "windage") {
    if (rounded === 0) return "CENTER (0.00 clicks)";
    return clicksSigned >= 0 ? `RIGHT ${rounded} clicks` : `LEFT ${rounded} clicks`;
  }

  // elevation
  if (rounded === 0) return "LEVEL (0.00 clicks)";
  return clicksSigned >= 0 ? `UP ${rounded} clicks` : `DOWN ${rounded} clicks`;
}

// ---------- Routes ----------
app.get("/health", (req, res) => {
  return res.status(200).send(
    JSON.stringify({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD_TAG,
      ts: Date.now(),
    })
  );
});

app.get("/", (req, res) => {
  return res.status(200).send(
    JSON.stringify({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD_TAG,
      ts: Date.now(),
      note: 'Use POST /api/sec (multipart: field "image" + optional poib fields).',
    })
  );
});

// IMPORTANT: field name must be exactly "image"
app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const file = req.file || null;

    // ---- DEBUG ----
    const debugBody = req.body || {};
    const debugKeys = Object.keys(debugBody || {});
    // --------------

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

    // Read optional numeric fields from multipart body
    // (These come in as strings when sent via form-data)
    const distanceYards = toNumberOrDefault(req.body?.distanceYards, 100);
    const clickValueMoa = toNumberOrDefault(req.body?.clickValueMoa, 0.25);

    // POIB (inches): Right + / Left -, Up + / Down -
    // NOTE: In this PIPE file, POIB is still "manual" input.
    // Your REAL image-compute backend will produce poibX/poibY itself.
    const poibX = toNumberOrDefault(req.body?.poibX, 0);
    const poibY = toNumberOrDefault(req.body?.poibY, 0);

    // Basic image metadata
    const meta = await sharp(file.buffer).metadata();

    // Inches per click
    const ipc = inchesPerClick(distanceYards, clickValueMoa);

    // ✅ SIGN FIX: correction clicks are NEGATIVE of POIB
    // Example: POIB Right (+) means group hit right → dial LEFT (negative)
    // Example: POIB Up (+) means group hit high → dial DOWN (negative)
    const windageClicksSignedRaw = ipc === 0 ? 0 : (-poibX / ipc);
    const elevationClicksSignedRaw = ipc === 0 ? 0 : (-poibY / ipc);

    const clicksSigned = {
      windage: Math.round(windageClicksSignedRaw * 100) / 100,
      elevation: Math.round(elevationClicksSignedRaw * 100) / 100,
    };

    // Human direction text (based on CORRECTION clicks)
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
        },

        sec: {
          distanceYards,
          clickValueMoa,
          center: { col: "L", row: 12 },

          // Echo what backend actually used
          poibInches: { x: poibX, y: poibY },

          // CORRECTION clicks: Right+/Left-, Up+/Down-
          clicksSigned,

          // Readable instruction
          dial,

          computeStatus: "PIPE_SIGNFIX_READY",
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
