// server.js (ESM)
// SCZN3 SEC backend: POST /api/sec (multipart field: "image")
// Returns POIB (inches) + signed clicks + dial labels with CORRECT directions.
//
// Direction rules (hard-locked):
// - POIB left of bull  -> dial RIGHT
// - POIB right of bull -> dial LEFT
// - POIB above bull    -> dial DOWN
// - POIB below bull    -> dial UP

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const app = express();
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

const BUILD_TAG = "SEC_BACKEND_WINDAGE_LOCK_v1";
const SERVICE_NAME = "sczn3-sec-backend-pipe";

function round2(n) {
  return Math.round(n * 100) / 100;
}

// TRUE MOA: 1.047" at 100 yards
function inchesPerClick(distanceYards, clickValueMoa) {
  return (distanceYards / 100) * 1.047 * clickValueMoa;
}

/**
 * dxIn: +right, -left
 * dyIn: +down,  -up  (IMAGE COORDINATES)
 *
 * Returns:
 * - clicksSigned.windage: +RIGHT, -LEFT
 * - clicksSigned.elevation: +UP, -DOWN
 */
function computeDialFromOffsets(dxIn, dyIn, distanceYards, clickValueMoa) {
  const ipc = inchesPerClick(distanceYards, clickValueMoa);

  const windageClicks = round2(Math.abs(dxIn) / ipc);
  const elevationClicks = round2(Math.abs(dyIn) / ipc);

  const windageDir = dxIn < 0 ? "RIGHT" : dxIn > 0 ? "LEFT" : "CENTER";
  const elevationDir = dyIn < 0 ? "DOWN" : dyIn > 0 ? "UP" : "CENTER";

  const windageSigned =
    windageDir === "RIGHT" ? +windageClicks : windageDir === "LEFT" ? -windageClicks : 0;

  const elevationSigned =
    elevationDir === "UP" ? +elevationClicks : elevationDir === "DOWN" ? -elevationClicks : 0;

  return {
    clicksSigned: { windage: windageSigned, elevation: elevationSigned },
    dial: {
      windage: windageDir === "CENTER" ? "CENTER 0.00 clicks" : `${windageDir} ${windageClicks.toFixed(2)} clicks`,
      elevation:
        elevationDir === "CENTER" ? "CENTER 0.00 clicks" : `${elevationDir} ${elevationClicks.toFixed(2)} clicks`,
    },
  };
}

async function normalizeImageBuffer(inputBuffer) {
  return sharp(inputBuffer).rotate().toColourspace("rgb").jpeg({ quality: 95 }).toBuffer();
}

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Crop to the "page/target" area by finding non-white pixels.
 * Works well for screenshots and clean scans.
 */
async function cropToContent(imgBuffer) {
  const { data, info } = await sharp(imgBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels;

  let minX = w - 1,
    minY = h - 1,
    maxX = 0,
    maxY = 0;
  let found = false;

  for (let y = 0; y < h; y++) {
    const row = y * w * ch;
    for (let x = 0; x < w; x++) {
      const i = row + x * ch;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 10) continue;

      const lum = luminance(r, g, b);
      if (lum < 245) {
        found = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!found) {
    return { buffer: imgBuffer, offsetX: 0, offsetY: 0 };
  }

  const pad = 10;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  const cropped = await sharp(imgBuffer)
    .extract({ left: minX, top: minY, width: cropW, height: cropH })
    .toBuffer();

  return { buffer: cropped, offsetX: minX, offsetY: minY };
}

/**
 * Connected components on a binary mask.
 * Returns list of components with centroid + bbox + area.
 */
function connectedComponents(mask, w, h) {
  const visited = new Uint8Array(w * h);
  const comps = [];

  const stack = [];

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const idx = row + x;
      if (!mask[idx] || visited[idx]) continue;

      visited[idx] = 1;

      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y;

      stack.length = 0;
      stack.push(idx);

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

        const n1 = cur - 1;
        const n2 = cur + 1;
        const n3 = cur - w;
        const n4 = cur + w;

        if (cx > 0 && mask[n1] && !visited[n1]) {
          visited[n1] = 1;
          stack.push(n1);
        }
        if (cx < w - 1 && mask[n2] && !visited[n2]) {
          visited[n2] = 1;
          stack.push(n2);
        }
        if (cy > 0 && mask[n3] && !visited[n3]) {
          visited[n3] = 1;
          stack.push(n3);
        }
        if (cy < h - 1 && mask[n4] && !visited[n4]) {
          visited[n4] = 1;
          stack.push(n4);
        }
      }

      const cx = sumX / area;
      const cy = sumY / area;

      comps.push({
        area,
        cx,
        cy,
        minX,
        maxX,
        minY,
        maxY,
        bw: maxX - minX + 1,
        bh: maxY - minY + 1,
      });
    }
  }

  return comps;
}

/**
 * Detect bullet holes as small dark blobs (works best for clean targets / screenshots).
 */
async function detectHolesPx(imgBuffer) {
  const { data, info } = await sharp(imgBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels;

  // Build a binary mask of "dark enough" pixels
  const mask = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    const row = y * w * ch;
    for (let x = 0; x < w; x++) {
      const i = row + x * ch;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 10) continue;

      const lum = luminance(r, g, b);
      if (lum < 80) {
        mask[y * w + x] = 1;
      }
    }
  }

  const comps = connectedComponents(mask, w, h);

  // Filter to "hole-like" blobs
  const filtered = comps.filter((c) => {
    if (c.area < 25) return false;
    if (c.area > 20000) return false;

    if (c.bw < 4 || c.bh < 4) return false;
    if (c.bw > 120 || c.bh > 120) return false;

    const aspect = c.bw / c.bh;
    if (aspect < 0.35 || aspect > 2.85) return false;

    const thinness = Math.min(c.bw, c.bh) / Math.max(c.bw, c.bh);
    if (thinness < 0.35) return false;

    // avoid border garbage
    if (c.minX <= 1 || c.minY <= 1 || c.maxX >= w - 2 || c.maxY >= h - 2) return false;

    return true;
  });

  // Take up to 12 best blobs by area (holes tend to be strong dark blobs)
  filtered.sort((a, b) => b.area - a.area);
  const top = filtered.slice(0, 12);

  return { holes: top, width: w, height: h };
}

/**
 * Bull location in inches for your 8.5x11 Grid v1.
 * If you want a different bull coordinate later, change these two numbers only.
 */
function bullInchesForSpec(shortSideIn, longSideIn) {
  // 8.5 x 11 grid v1 bull coordinate (x from left, y from top)
  if (Math.abs(shortSideIn - 8.5) < 0.01 && Math.abs(longSideIn - 11.0) < 0.01) {
    return { x: 4.25, y: 5.5 };
  }
  return { x: shortSideIn / 2, y: longSideIn / 2 };
}

/**
 * Main compute from image:
 * - normalize
 * - crop to content
 * - detect holes
 * - compute POIB as average hole centroid
 * - convert to inches using pixelsPerInch
 * - compute correct dial directions using dx/dy signs
 */
async function computeFromImage(imgBuffer, targetSizeInchesLong) {
  const normalized = await normalizeImageBuffer(imgBuffer);
  const cropped = await cropToContent(normalized);

  const { holes, width, height } = await detectHolesPx(cropped.buffer);

  if (!holes.length) {
    return {
      computeStatus: "NO_HOLES_DETECTED",
      debug: { width, height },
      poibInches: null,
      clicksSigned: { windage: 0, elevation: 0 },
      dial: { windage: "CENTER 0.00 clicks", elevation: "CENTER 0.00 clicks" },
    };
  }

  const longDimPx = Math.max(width, height);
  const shortDimPx = Math.min(width, height);

  const longSideIn = Number(targetSizeInchesLong || 11);
  const shortSideIn = round2((shortDimPx / longDimPx) * longSideIn);

  const pixelsPerInch = longDimPx / longSideIn;

  const bullIn = bullInchesForSpec(shortSideIn, longSideIn);

  // Determine bull center in pixels from top-left of cropped image.
  // If image is portrait, width ~ shortSideIn and height ~ longSideIn.
  // If landscape, swap mapping.
  const isLandscape = width >= height;

  const bullPx = isLandscape
    ? { x: bullIn.y * pixelsPerInch, y: bullIn.x * pixelsPerInch }
    : { x: bullIn.x * pixelsPerInch, y: bullIn.y * pixelsPerInch };

  // POIB px = average centroid of detected holes
  let sx = 0;
  let sy = 0;
  for (const h1 of holes) {
    sx += h1.cx;
    sy += h1.cy;
  }
  const poibPx = { x: sx / holes.length, y: sy / holes.length };

  // Offsets in inches, with IMAGE sign convention:
  const dxIn = (poibPx.x - bullPx.x) / pixelsPerInch; // +right
  const dyIn = (poibPx.y - bullPx.y) / pixelsPerInch; // +down

  return {
    computeStatus: "COMPUTED_FROM_IMAGE",
    debug: {
      width,
      height,
      pixelsPerInch: round2(pixelsPerInch),
      longSideIn,
      shortSideIn,
      holesDetected: holes.length,
      bullPx: { x: round2(bullPx.x), y: round2(bullPx.y) },
      poibPx: { x: round2(poibPx.x), y: round2(poibPx.y) },
    },
    poibInches: { x: round2(dxIn), y: round2(dyIn) },
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    build: BUILD_TAG,
    note: 'POST /api/sec multipart field "image" (plus distanceYards, clickValueMoa, targetSizeInches).',
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

    const base = await computeFromImage(req.file.buffer, targetSizeInches);

    // If no POIB, return centered correction.
    if (!base.poibInches) {
      return res.json({
        ok: true,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        received: {
          field: "image",
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          bytes: req.file.size,
        },
        sec: { distanceYards, clickValueMoa, targetSizeInches },
        computeStatus: base.computeStatus,
        poibInches: null,
        clicksSigned: { windage: 0, elevation: 0 },
        dial: { windage: "CENTER 0.00 clicks", elevation: "CENTER 0.00 clicks" },
        debug: base.debug,
      });
    }

    const dxIn = base.poibInches.x; // +right, -left
    const dyIn = base.poibInches.y; // +down, -up (IMAGE)

    const { clicksSigned, dial } = computeDialFromOffsets(dxIn, dyIn, distanceYards, clickValueMoa);

    return res.json({
      ok: true,
      service: SERVICE_NAME,
      build: BUILD_TAG,
      received: {
        field: "image",
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        bytes: req.file.size,
      },
      sec: { distanceYards, clickValueMoa, targetSizeInches },
      computeStatus: base.computeStatus,
      poibInches: base.poibInches,
      clicksSigned,
      dial,
      debug: base.debug,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log(`[${SERVICE_NAME}] listening on ${port} build=${BUILD_TAG}`);
});
