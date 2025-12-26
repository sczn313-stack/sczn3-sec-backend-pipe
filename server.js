// server.js — SCZN3 SEC Backend (PIPE)
// Always JSON
// POST /api/sec accepts multipart: "image" + optional fields:
//   poibX, poibY (inches), distanceYards, clickValueMoa

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = process.env.BUILD_TAG || "PIPE_v3_2025-12-26";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Force JSON responses
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

function toNum(v, fallback) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Convention:
 *  poibX > 0 = group right of center
 *  poibY > 0 = group high (up) of center
 *
 * Shooter dial correction is opposite direction:
 *  Right -> LEFT
 *  Left  -> RIGHT
 *  High  -> DOWN
 *  Low   -> UP
 */
function computeSec(poibX, poibY, distanceYards, clickValueMoa) {
  const inchesPerMOA = 1.047 * (distanceYards / 100);
  const inchesPerClick = inchesPerMOA * clickValueMoa;

  const windageClicksSigned = inchesPerClick ? round2(poibX / inchesPerClick) : 0;
  const elevationClicksSigned = inchesPerClick ? round2(poibY / inchesPerClick) : 0;

  const windageDialDir =
    poibX > 0 ? "LEFT" : poibX < 0 ? "RIGHT" : "NONE";
  const elevationDialDir =
    poibY > 0 ? "DOWN" : poibY < 0 ? "UP" : "NONE";

  return {
    distanceYards,
    clickValueMoa,
    poibInches: { x: round2(poibX), y: round2(poibY) },

    // Dev-friendly signed clicks (same sign as poib)
    clicksSigned: {
      windage: windageClicksSigned,
      elevation: elevationClicksSigned,
    },

    // Shooter-friendly dial instruction
    dial: {
      windage: {
        direction: windageDialDir,
        clicks: round2(Math.abs(windageClicksSigned)),
      },
      elevation: {
        direction: elevationDialDir,
        clicks: round2(Math.abs(elevationClicksSigned)),
      },
    },

    computeStatus: "DIAL_DIRECTIONS_READY",
  };
}

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

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const file = req.file || null;
    if (!file || !file.buffer) {
      return res.status(400).send(
        JSON.stringify({
          ok: false,
          build: BUILD_TAG,
          error: 'No file uploaded. Use multipart field name exactly "image".',
        })
      );
    }

    const poibX = toNum(req.body?.poibX, 0);
    const poibY = toNum(req.body?.poibY, 0);
    const distanceYards = toNum(req.body?.distanceYards, 100);
    const clickValueMoa = toNum(req.body?.clickValueMoa, 0.25);

    const meta = await sharp(file.buffer).metadata();
    const sec = computeSec(poibX, poibY, distanceYards, clickValueMoa);

    return res.status(200).send(
      JSON.stringify({
        ok: true,
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
        sec,
      })
    );
  } catch (err) {
    return res.status(500).send(
      JSON.stringify({
        ok: false,
        build: BUILD_TAG,
        error: String(err?.message || err),
      })
    );
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SCZN3 SEC backend listening on ${PORT} (${BUILD_TAG})`);
});
