// server.js — SCZN3 SEC Backend (PIPE)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart: "image" + optional fields:
// poibXIn, poibYIn, distanceYards, clickValueMoa

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "PIPE_v1_2025-12-25b";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Always return JSON
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  next();
});

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
      ts: Date.now(),
    })
  );
});

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// MOA inches @ yards = 1.047 * (yards/100)
// moa = inches / moaInchesAtYards
// clicks = moa / clickValueMoa
function offsetClicksFromPoib({ poibXIn, poibYIn, distanceYards, clickValueMoa }) {
  const yards = num(distanceYards, 100);
  const click = num(clickValueMoa, 0.25);

  const x = num(poibXIn, 0);
  const y = num(poibYIn, 0);

  const moaInchesAtYards = 1.047 * (yards / 100);

  if (!Number.isFinite(moaInchesAtYards) || moaInchesAtYards <= 0 || click <= 0) {
    return { windage: 0, elevation: 0 };
  }

  const moaX = x / moaInchesAtYards;
  const moaY = y / moaInchesAtYards;

  return {
    windage: round2(moaX / click),
    elevation: round2(moaY / click),
  };
}

function correctionFromOffset(offset) {
  // correction is opposite of where the group landed
  const w = round2(-num(offset.windage, 0));
  const e = round2(-num(offset.elevation, 0));

  const windageDir = w === 0 ? "None" : w > 0 ? "Right" : "Left";
  const elevationDir = e === 0 ? "None" : e > 0 ? "Up" : "Down";

  return {
    windage: { dir: windageDir, clicks: Math.abs(w) },
    elevation: { dir: elevationDir, clicks: Math.abs(e) },
    raw: { windage: w, elevation: e }, // signed correction (if you want it)
  };
}

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const file = req.file || null;

    if (!file || !file.buffer) {
      return res.status(400).send(
        JSON.stringify({
          ok: false,
          error: 'No file uploaded. Use multipart field name "image".',
          build: BUILD_TAG,
        })
      );
    }

    const poibXIn = num(req.body?.poibXIn, 0);
    const poibYIn = num(req.body?.poibYIn, 0);
    const distanceYards = num(req.body?.distanceYards, 100);
    const clickValueMoa = num(req.body?.clickValueMoa, 0.25);

    const meta = await sharp(file.buffer).metadata();

    const offsetClicks = offsetClicksFromPoib({
      poibXIn,
      poibYIn,
      distanceYards,
      clickValueMoa,
    });

    const correction = correctionFromOffset(offsetClicks);

    return res.status(200).send(
      JSON.stringify({
        ok: true,
        build: BUILD_TAG,
        received: {
          field: "image",
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
          poibInches: { x: poibXIn, y: poibYIn },

          // keep what you already have
          offsetClicks,

          // add the shooter-ready output
          correction,

          computeStatus: "STUB_READY_FOR_REAL_SCZN3_COMPUTE",
        },
      })
    );
  } catch (e) {
    return res.status(500).send(
      JSON.stringify({
        ok: false,
        error: String(e?.message || e),
        build: BUILD_TAG,
      })
    );
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SCZN3 SEC backend listening on ${PORT} | ${BUILD_TAG}`);
});
