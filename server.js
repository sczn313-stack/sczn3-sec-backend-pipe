// server.js — SCZN3 SEC Backend (PIPE)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart:
//   - file field: "image"
//   - optional text fields: poibX, poibY, distanceYards, clickValueMoa

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "PIPE_v2_2025-12-25";

const app = express();

// Allow calls from your Static Site + local dev
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Force JSON responses (even for errors)
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// Multer in-memory upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

app.get("/health", (_req, res) => {
  res.status(200).send(
    JSON.stringify({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD_TAG,
      ts: Date.now(),
    })
  );
});

app.get("/", (_req, res) => {
  res.status(200).send(
    JSON.stringify({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD_TAG,
      note: "Use POST /api/sec (multipart: image + optional poib fields).",
    })
  );
});

function toNum(v, fallback) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Click math used by your current UI:
 * inchesPerMOA = 1.047 * (distanceYards / 100)
 * inchesPerClick = inchesPerMOA * clickValueMoa
 * clicks = poibInches / inchesPerClick
 *
 * (This matches your example: 1.00 @100yd, 0.25MOA => 3.82 clicks)
 */
function computeClicks({ poibX, poibY, distanceYards, clickValueMoa }) {
  const inchesPerMOA = 1.047 * (distanceYards / 100);
  const inchesPerClick = inchesPerMOA * clickValueMoa;

  if (!Number.isFinite(inchesPerClick) || inchesPerClick === 0) {
    return { windage: 0, elevation: 0 };
  }

  const windage = Number((poibX / inchesPerClick).toFixed(2));
  const elevation = Number((poibY / inchesPerClick).toFixed(2));
  return { windage, elevation };
}

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const file = req.file || null;

    // Read optional text fields
    const poibX = toNum(req.body?.poibX, 0);
    const poibY = toNum(req.body?.poibY, 0);
    const distanceYards = toNum(req.body?.distanceYards, 100);
    const clickValueMoa = toNum(req.body?.clickValueMoa, 0.25);

    if (!file || !file.buffer) {
      return res.status(400).send(
        JSON.stringify({
          ok: false,
          build: BUILD_TAG,
          error: 'No file uploaded. Use multipart field name exactly "image".',
        })
      );
    }

    // Image metadata (safe + fast)
    const meta = await sharp(file.buffer).metadata();

    const clicks = computeClicks({ poibX, poibY, distanceYards, clickValueMoa });

    return res.status(200).send(
      JSON.stringify({
        httpStatus: 200,
        ok: true,
        build: BUILD_TAG,
        received: {
          field: file.fieldname,
          originalname: file.originalname,
          mimetype: file.mimetype,
          bytes: file.size,
        },
        image: {
          width: meta.width ?? null,
          height: meta.height ?? null,
          format: meta.format ?? null,
        },
        sec: {
          distanceYards,
          clickValueMoa,
          center: { col: "L", row: 12 },
          poibInches: { x: poibX, y: poibY },
          clicks,
          computeStatus: "STUB_READY_FOR_REAL_SCZN3_COMPUTE",
        },
      })
    );
  } catch (err) {
    return res.status(500).send(
      JSON.stringify({
        ok: false,
        build: BUILD_TAG,
        error: "Server error",
        details: String(err?.message || err),
      })
    );
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`SCZN3 SEC backend pipe listening on :${PORT} (${BUILD_TAG})`);
});
