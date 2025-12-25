// server.js — SCZN3 SEC Backend (PIPE)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart: "image" (preferred) OR "file"

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "PIPE_v1_2025-12-25";

const app = express();
app.use(cors({ origin: true }));

// Always return JSON
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

app.get("/health", (req, res) => {
  res.status(200).send(JSON.stringify({ ok: true, build: BUILD_TAG }));
});

app.get("/", (req, res) => {
  res.status(200).send(JSON.stringify({ ok: true, build: BUILD_TAG, route: "/" }));
});

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const file = req.file || null;

    if (!file || !file.buffer) {
      return res.status(400).send(
        JSON.stringify({
          ok: false,
          error: 'No file uploaded. Use multipart field "image".',
          build: BUILD_TAG,
        })
      );
    }

    const meta = await sharp(file.buffer).metadata();

    return res.status(200).send(
      JSON.stringify({
        ok: true,
        build: BUILD_TAG,
        received: {
          field: file.fieldname,
          originalname: file.originalname || null,
          mimetype: file.mimetype || null,
          bytes: file.size || file.buffer.length,
        },
        image: {
          width: meta.width || null,
          height: meta.height || null,
          format: meta.format || null,
        },
        note: "Backend is live. Next: plug in SCZN3 SEC compute + return real payload.",
      })
    );
  } catch (err) {
    return res.status(500).send(
      JSON.stringify({
        ok: false,
        error: "Server error",
        details: String(err?.message || err),
        build: BUILD_TAG,
      })
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SCZN3 PIPE listening on ${PORT} (${BUILD_TAG})`));
