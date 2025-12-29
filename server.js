// server.js  (ESM)
// SCZN3 SEC backend: POST /api/sec (multipart field: "image")
// Returns POIB + signed clicks + dial labels (RIGHT/LEFT, UP/DOWN)

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const app = express();
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

const BUILD_TAG = "SEC_BACKEND_FIX_WINDAGE_v1";
const SERVICE_NAME = "sczn3-sec-backend-pipe";

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function normalizeImageBuffer(inputBuffer) {
  // apply EXIF rotation, remove weird iOS orientation behavior
  // and ensure consistent pixel layout
  return await sharp(inputBuffer)
    .rotate()
    .toColourspace("rgb")
    .jpeg({ quality: 95 })
    .toBuffer();
}

function computeCenterFromCrosshair(gray, w, h) {
  // Find the darkest (most ink) vertical and horizontal lines.
  // Works well on your generated targets because the crosshair is thick black.
  const colSum = new Float64Array(w);
  const rowSum = new Float64Array(h);

  // gray is Uint8Array, 0=black, 255=white
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const v = gray[rowOff + x];
      const ink = 255 - v; // more ink = larger
      colSum[x] += ink;
      rowSum[y] += ink;
    }
  }

  let bestX = 0;
  let bestCol = -Infinity;
  for (let x = 0; x < w; x++) {
    if (colSum[x] > bestCol) {
      bestCol = colSum[x];
      bestX = x;
    }
  }

  let bestY = 0;
  let bestRow = -Infinity;
  for (let y = 0; y < h; y++) {
    if (rowSum[y] > bestRow) {
      bestRow = rowSum[y];
      bestY = y;
    }
  }

  return { x: bestX, y: bestY };
}

function connectedComponents(mask, w, h) {
  // mask: Uint8Array 0/1
  const visited = new Uint8Array(w * h);
  const comps = [];

  const idx = (x, y) => y * w + x;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (!mask[i] || visited[i]) continue;

      // BFS
      let qx = [x];
      let qy = [y];
      visited[i] = 1;

      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = x, maxX = x, minY = y, maxY = y;

      for (let qi = 0; qi < qx.length; qi++) {
        const cx = qx[qi];
        const cy = qy[qi];
        area++;
        sumX += cx;
        sumY += cy;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 8-neighborhood
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const ni = idx(nx, ny);
            if (!mask[ni] || visited[ni]) continue;
            visited[ni] = 1;
            qx.push(nx);
            qy.push(ny);
          }
        }
      }

      const bboxW = maxX - minX + 1;
      const bboxH = maxY - minY + 1;
      const cx = sumX / area;
      const cy = sumY / area;

      comps.push({
        area,
        cx,
        cy,
        minX, maxX, minY, maxY,
        bboxW,
        bboxH
      });
    }
  }

  return comps;
}

function detectBulletHoles(gray, w, h, centerPx) {
  // Build a binary mask for "dark" pixels, then blob-detect.
  // Exclude the crosshair area so it doesn't dominate.
  const mask = new Uint8Array(w * h);

  // tune threshold if needed
  const TH = 85; // lower = stricter black
  const crosshairBand = Math.max(6, Math.floor(Math.min(w, h) * 0.004)); // ~0.4%

  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const i = rowOff + x;

      // ignore the thick crosshair bands
      const inVert = Math.abs(x - centerPx.x) <= crosshairBand;
      const inHorz = Math.abs(y - centerPx.y) <= crosshairBand;
      if (inVert || inHorz) continue;

      const v = gray[i];
      if (v < TH) mask[i] = 1;
    }
  }

  let comps = connectedComponents(mask, w, h);

  // Filter components: remove grid specks, remove huge blobs
  comps = comps.filter((c) => {
    if (c.area < 60) return false;                 // too small
    if (c.area > (w * h) * 0.02) return false;     // too large
    // remove long line-like blobs (grid lines)
    const ar = c.bboxW / Math.max(1, c.bboxH);
    if (ar > 10 || ar < 0.10) return false;
    return true;
  });

  // Sort by area desc and keep top N
  comps.sort((a, b) => b.area - a.area);

  // Bullet holes usually become the darkest/solid blobs; take top 12, then later average best 3
  return comps.slice(0, 12);
}

function pick3Holes(holes) {
  // Simple: take top 3 by area
  return holes.slice(0, 3);
}

function computePoibAndClicks({ centerPx, holesPx, w, h, distanceYards, clickValueMoa, targetSizeInches }) {
  // Pixels-per-inch: use the LONG side as the "targetSizeInches" (11 for 8.5x11)
  const longPx = Math.max(w, h);
  const ppi = longPx / targetSizeInches;

  // POIB center in pixels = mean of selected hole centroids
  const n = holesPx.length;
  const meanX = holesPx.reduce((s, p) => s + p.cx, 0) / n;
  const meanY = holesPx.reduce((s, p) => s + p.cy, 0) / n;

  // POIB inches convention:
  // Right + / Left -
  // Up + / Down -
  const poibInches = {
    x: (meanX - centerPx.x) / ppi,
    y: (centerPx.y - meanY) / ppi
  };

  // True MOA inches per click at distance:
  // 1 MOA = 1.047" at 100y
  const inchesPerClick = 1.047 * (distanceYards / 100) * clickValueMoa;

  // Correction clicks = bull - POIB  => negative of POIB offset
  let windageSigned = -(poibInches.x / inchesPerClick);
  let elevationSigned = -(poibInches.y / inchesPerClick);

  // Lock directions to pixel geometry (your UGEO rule) in case anything upstream flips a sign:
  // If holes are LEFT of center (meanX < centerX) then correction MUST be RIGHT (positive).
  // If holes are RIGHT of center then correction MUST be LEFT (negative).
  if (meanX < centerPx.x && windageSigned < 0) windageSigned *= -1;
  if (meanX > centerPx.x && windageSigned > 0) windageSigned *= -1;

  // If holes are BELOW center (meanY > centerY) then correction MUST be UP (positive).
  // If holes are ABOVE center then correction MUST be DOWN (negative).
  if (meanY > centerPx.y && elevationSigned < 0) elevationSigned *= -1;
  if (meanY < centerPx.y && elevationSigned > 0) elevationSigned *= -1;

  const clicksSigned = {
    windage: round2(windageSigned),
    elevation: round2(elevationSigned)
  };

  const dial = {
    windage: clicksSigned.windage >= 0 ? `RIGHT ${Math.abs(clicksSigned.windage).toFixed(2)} clicks` : `LEFT ${Math.abs(clicksSigned.windage).toFixed(2)} clicks`,
    elevation: clicksSigned.elevation >= 0 ? `UP ${Math.abs(clicksSigned.elevation).toFixed(2)} clicks` : `DOWN ${Math.abs(clicksSigned.elevation).toFixed(2)} clicks`
  };

  return {
    ppi: round2(ppi),
    centerPx,
    holesUsed: holesPx.map(h => ({ x: round2(h.cx), y: round2(h.cy), area: h.area })),
    poibInches: { x: round2(poibInches.x), y: round2(poibInches.y) },
    clicksSigned,
    dial
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    build: BUILD_TAG,
    note: "Use POST /api/sec (multipart: field 'image' + optional distanceYards, clickValueMoa, targetSizeInches)."
  });
});

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: "Missing multipart field: image" });
    }

    const distanceYards = Number(req.body.distanceYards ?? 100);
    const clickValueMoa = Number(req.body.clickValueMoa ?? 0.25);
    const targetSizeInches = Number(req.body.targetSizeInches ?? 11);

    const imgBuffer = await normalizeImageBuffer(req.file.buffer);

    const { data, info } = await sharp(imgBuffer)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;
    const gray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    const centerPx = computeCenterFromCrosshair(gray, w, h);

    const holes = detectBulletHoles(gray, w, h, centerPx);
    const holes3 = pick3Holes(holes);

    if (holes3.length < 1) {
      return res.status(422).json({
        ok: false,
        error: "No bullet holes detected (after filtering).",
        debug: { holesCandidates: holes.length, centerPx }
      });
    }

    const result = computePoibAndClicks({
      centerPx,
      holesPx: holes3,
      w,
      h,
      distanceYards,
      clickValueMoa,
      targetSizeInches
    });

    return res.json({
      ok: true,
      service: SERVICE_NAME,
      build: BUILD_TAG,
      received: {
        field: "image",
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        bytes: req.file.size
      },
      sec: { distanceYards, clickValueMoa, targetSizeInches },
      computeStatus: "COMPUTED_FROM_IMAGE",
      poibInches: result.poibInches,
      clicksSigned: result.clicksSigned,
      dial: result.dial,
      detect: {
        image: { width: w, height: h, ppi: result.ppi },
        centerPx: result.centerPx,
        holesUsed: result.holesUsed
      }
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log(`${SERVICE_NAME} listening on :${port} build=${BUILD_TAG}`);
});
