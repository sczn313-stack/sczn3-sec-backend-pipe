import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const app = express();
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

function round2(n) {
  return Math.round(n * 100) / 100;
}

function inchesPerClick(distanceYards, clickValueMoa) {
  // True MOA: 1.047" @ 100y
  return (distanceYards / 100) * (clickValueMoa * 1.047);
}

async function normalizeImageBuffer(inputBuffer) {
  return await sharp(inputBuffer)
    .rotate()              // applies EXIF rotation/flip
    .toColourspace("rgb")
    .jpeg({ quality: 95 }) // keep pixels consistent
    .toBuffer();
}

/**
 * IMPORTANT:
 * Replace this function with YOUR real POIB-from-image pipeline.
 * It must return POIB OFFSETS in inches relative to the bull:
 *  - poibInches.x : horizontal offset (inches)
 *  - poibInches.y : vertical offset (inches)
 *
 * Your current pipeline appears to return X with the wrong sign.
 */
async function computePoibFromImageBuffer(_imgBuffer, _sec) {
  // TODO: plug in your real compute
  // return { x: <number>, y: <number> };

  throw new Error("computePoibFromImageBuffer() is not wired to your pipeline yet.");
}

function clicksFromPoib(poibInches, distanceYards, clickValueMoa) {
  const ipc = inchesPerClick(distanceYards, clickValueMoa);

  // --- FIX ONCE AND FOR ALL (WINDAGE) ---
  // Your pipeline's X is inverted. Flip it here exactly one time.
  const fixedPoib = {
    x: -poibInches.x, // <-- THIS is the windage fix
    y: poibInches.y,  // keep elevation sign as-is (your elevation is already correct)
  };

  // correction = bull - POIB
  // If POIB is LEFT => fixedPoib.x is NEG => -NEG => POS => RIGHT clicks
  // If POIB is RIGHT => fixedPoib.x is POS => -POS => NEG => LEFT clicks
  const windage = round2((-fixedPoib.x) / ipc);
  const elevation = round2((-fixedPoib.y) / ipc);

  return { fixedPoib, clicksSigned: { windage, elevation }, ipc };
}

function dialLabels(clicksSigned) {
  const w = clicksSigned.windage;
  const e = clicksSigned.elevation;

  const wDir = w === 0 ? "CENTER" : w > 0 ? "RIGHT" : "LEFT";
  const eDir = e === 0 ? "CENTER" : e > 0 ? "UP" : "DOWN";

  return {
    windage: `${wDir} ${Math.abs(w).toFixed(2)} clicks`,
    elevation: `${eDir} ${Math.abs(e).toFixed(2)} clicks`,
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "sczn3-sec-backend-pipe",
    build: "REAL_ALWAYS_IMAGE_POIB_v1",
    note: 'Use POST /api/sec (multipart: field "image" + optional fields). POIB is computed from image.',
    ts: Date.now(),
  });
});

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: 'Missing multipart field: "image"' });
    }

    const distanceYards = Number(req.body.distanceYards ?? 100);
    const clickValueMoa = Number(req.body.clickValueMoa ?? 0.25);
    const targetSizeInches = Number(req.body.targetSizeInches ?? 11);

    const sec = { distanceYards, clickValueMoa, targetSizeInches };

    const imgBuffer = await normalizeImageBuffer(req.file.buffer);

    // 1) compute POIB (offsets in inches relative to bull) from image
    const poibInches = await computePoibFromImageBuffer(imgBuffer, sec);

    // 2) FIX windage + compute signed clicks
    const { fixedPoib, clicksSigned } = clicksFromPoib(poibInches, distanceYards, clickValueMoa);

    // 3) Human-readable labels
    const dial = dialLabels(clicksSigned);

    return res.json({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: "REAL_ALWAYS_IMAGE_POIB_v1",
      received: {
        field: "image",
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        bytes: req.file.size,
      },
      sec,
      computeStatus: "COMPUTED_FROM_IMAGE",
      poibInches: fixedPoib,      // return the FIXED sign version so everything stays consistent
      clicksSigned,
      dial,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log(`SCZN3 backend listening on :${port}`));
