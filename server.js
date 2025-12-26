// server.js — SCZN3 SEC Backend (PIPE)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart: field "image" + optional fields:
//   poibX, poibY (inches)   distanceYards (yards)   clickValueMoa (MOA per click)

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "PIPE_v3_2025-12-26";

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

function dialText(axisName, clicksSigned) {
  const abs = Math.abs(clicksSigned);
  const rounded = Math.round(abs * 100) / 100; // 2 decimals
  if (axisName === "windage") {
    return clicksSigned >= 0
      ? `RIGHT ${rounded} clicks`
      : `LEFT ${rounded} clicks`;
  }
  // elevation
  return clicksSigned >= 0 ? `UP ${rounded} clicks` : `DOWN ${rounded} clicks`;
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
      note: 'Use POST /api/sec (multipart: field "image" + optional poib fields).',
    })
  );
});

// IMPORTANT: field name must be exactly "image"
app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const file = req.file || null;

    // ---- DEBUG (THIS IS THE KEY PART YOU ASKED FOR) ----
    const debugBody = req.body || {};
    const debugKeys = Object.keys(debugBody || {});
    // ----------------------------------------------------

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
    const poibX = toNumberOrDefault(req.body?.poibX, 0);
    const poibY = toNumberOrDefault(req.body?.poibY, 0);

    // Basic image metadata
    const meta = await sharp(file.buffer).metadata();

    // Click computation (2-decimal)
    const ipc = inchesPerClick(distanceYards, clickValueMoa);
    const windageClicksSigned = ipc === 0 ? 0 : poibX / ipc;
    const elevationClicksSigned = ipc === 0 ? 0 : poibY / ipc;

    const clicksSigned = {
      windage: Math.round(windageClicksSigned * 100) / 100,
      elevation: Math.round(elevationClicksSigned * 100) / 100,
    };

    // Human direction text
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

          // Signed clicks: Right+/Left-, Up+/Down-
          clicksSigned,

          // Readable instruction
          dial,

          computeStatus: "STUB_READY_FOR_REAL_SCZN3_COMPUTE",
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
  // Keep JSON-only behavior (no console HTML)
  console.log(`SCZN3 SEC backend listening on ${PORT} (${BUILD_TAG})`);
});
