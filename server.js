// server.js — SCZN3 SEC Backend (PIPE)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart field: "image"

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = process.env.BUILD_TAG || "PIPE_v1_2025-12-25";

const app = express();

// CORS: allow browser calls from your static site + local dev.
// (Render will set the host; origin:true reflects requesting origin.)
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Basic JSON parsing (doesn't affect multipart uploads)
app.use(express.json({ limit: "1mb" }));

// Multer in-memory upload (raw bytes in RAM)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

// --- helpers ---
function json(res, status, obj) {
  return res.status(status).json(obj);
}

function moaToClicks(offsetInches, distanceYards, clickValueMoa) {
  // 1 MOA ≈ 1.047" at 100 yards
  const inchesPerMoaAtDistance = 1.047 * (distanceYards / 100);
  const moa = offsetInches / inchesPerMoaAtDistance;
  const clicks = moa / clickValueMoa;
  return Number.isFinite(clicks) ? clicks : 0;
}

// --- routes ---
app.get("/health", (_req, res) => {
  return json(res, 200, { ok: true, service: "sczn3-sec-backend-pipe", build: BUILD_TAG, ts: Date.now() });
});

app.get("/", (_req, res) => {
  return json(res, 200, { ok: true, service: "sczn3-sec-backend-pipe", build: BUILD_TAG });
});

// Upload endpoint (multipart form-data, field name MUST be "image")
app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const file = req.file || null;

    if (!file || !file.buffer) {
      return json(res, 400, {
        ok: false,
        error: 'No file uploaded. Use multipart/form-data field name exactly "image".',
        build: BUILD_TAG,
      });
    }

    // Read image metadata
    const meta = await sharp(file.buffer).metadata();

    // Optional: allow quick testing by sending these extra multipart fields:
    // poibXIn (right +, left -), poibYIn (up +, down -)
    const distanceYards = Number(req.body?.distanceYards ?? 100);
    const clickValueMoa = Number(req.body?.clickValueMoa ?? 0.25);

    const poibXIn = Number(req.body?.poibXIn ?? 0); // + right
    const poibYIn = Number(req.body?.poibYIn ?? 0); // + up

    // Convert offsets → clicks (stub math; real compute can replace poib values later)
    const windageClicks = moaToClicks(poibXIn, distanceYards, clickValueMoa);
    const elevationClicks = moaToClicks(poibYIn, distanceYards, clickValueMoa);

    return json(res, 200, {
      ok: true,
      build: BUILD_TAG,

      received: {
        field: "image",
        originalname: file.originalname,
        mimetype: file.mimetype,
        bytes: file.size,
      },

      image: {
        width: meta.width ?? null,
        height: meta.height ?? null,
        format: meta.format ?? null,
      },

      // SEC payload (PIPE stub — ready for real SCZN3 compute to plug in)
      sec: {
        distanceYards,
        clickValueMoa,
        center: { col: "L", row: 12 }, // SCZN3 default
        poibInches: { x: poibXIn, y: poibYIn },
        clicks: {
          windage: Number(windageClicks.toFixed(2)),
          elevation: Number(elevationClicks.toFixed(2)),
        },
        computeStatus: "STUB_READY_FOR_REAL_SCZN3_COMPUTE",
      },
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: "Server error in /api/sec",
      detail: String(err?.message || err),
      build: BUILD_TAG,
    });
  }
});

// 404 (always JSON)
app.use((req, res) => {
  return json(res, 404, { ok: false, error: "Not found", path: req.path, build: BUILD_TAG });
});

// --- start ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[${BUILD_TAG}] listening on :${PORT}`);
});
