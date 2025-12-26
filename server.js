// server.js — SCZN3 SEC Backend (REAL IMAGE POIB + SIGN-CORRECT)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart:
//   field "image" (required)
//   optional fields:
//     distanceYards (yards)
//     clickValueMoa (MOA per click)
//     targetSizeInches (physical target width/height; default 23)
//     poibX, poibY (inches) OPTIONAL manual override
//
// Conventions:
//   POIB inches: Right + / Left - | Up + / Down -
//   OUTPUT clicks are CORRECTION clicks (what to dial) = NEGATIVE of POIB offset.
//     If POIB is RIGHT (+), correction is LEFT (-).
//     If POIB is UP (+), correction is DOWN (-).

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "REAL_v4_2025-12-26_CLEAN_DEPLOY_FIX";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Always JSON (avoid default HTML error pages)
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

// Multer memory storage
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 1 MOA ≈ 1.047" at 100 yards
function inchesPerClick(distanceYards, clickValueMoa) {
  return 1.047 * (distanceYards / 100) * clickValueMoa;
}

function dialText(axisName, clicksSigned) {
  const abs = Math.abs(clicksSigned);
  const rounded = round2(abs);

  if (axisName === "windage") {
    return clicksSigned >= 0 ? `RIGHT ${rounded} clicks` : `LEFT ${rounded} clicks`;
  }
  return clicksSigned >= 0 ? `UP ${rounded} clicks` : `DOWN ${rounded} clicks`;
}

// ---------- Image POIB (simple + robust for the 23x23 grid) ----------
// Returns: { poibInches:{x,y}, holesInches:[{x,y,area}], detectInfo:{...} }
async function computePoibFromImage(fileBuffer, targetSizeInches) {
  // Normalize to consistent size (helps repeatability)
  const NORM_W = 1100;

  const norm = sharp(fileBuffer).rotate().resize({ width: NORM_W, withoutEnlargement: true });
  const meta = await norm.metadata();

  const w = meta.width || NORM_W;
  const h = meta.height || NORM_W;

  // Raw grayscale buffer
  const gray = await norm
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const data = gray.data; // Uint8
  const width = gray.info.width;
  const height = gray.info.height;

  // Threshold for "dark"
  const TH = 140;

  // --- Find border edges (in pixel units internally, then convert to inches immediately) ---
  // We look for the first/last columns/rows with "enough" dark pixels.
  // This works well when the target is mostly the image (your upload test images are).
  function darkCountInCol(x) {
    let c = 0;
    for (let y = 0; y < height; y++) {
      const v = data[y * width + x];
      if (v < TH) c++;
    }
    return c;
  }
  function darkCountInRow(y) {
    let c = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const v = data[rowStart + x];
      if (v < TH) c++;
    }
    return c;
  }

  // Heuristics (tuned for your grid/crosshair images)
  const COL_MIN = Math.floor(height * 0.02); // 2% dark pixels in a column
  const ROW_MIN = Math.floor(width * 0.02);  // 2% dark pixels in a row

  let xL = 0;
  while (xL < width - 1 && darkCountInCol(xL) < COL_MIN) xL++;

  let xR = width - 1;
  while (xR > 0 && darkCountInCol(xR) < COL_MIN) xR--;

  let yT = 0;
  while (yT < height - 1 && darkCountInRow(yT) < ROW_MIN) yT++;

  let yB = height - 1;
  while (yB > 0 && darkCountInRow(yB) < ROW_MIN) yB--;

  // Avoid divide-by-zero / nonsense
  const borderW = Math.max(1, xR - xL);
  const borderH = Math.max(1, yB - yT);

  // Convert pixels->inches scale immediately
  // (We only use the scale to convert to inches; the output is inches.)
  const pixelsPerInchX = borderW / targetSizeInches;
  const pixelsPerInchY = borderH / targetSizeInches;
  const pixelsPerInch = (pixelsPerInchX + pixelsPerInchY) / 2;

  // --- Find crosshair center (darkest thick vertical/horizontal bars near middle) ---
  // Scan a middle band to find the column/row with maximum dark pixels.
  const midBandX0 = Math.floor(xL + borderW * 0.35);
  const midBandX1 = Math.floor(xL + borderW * 0.65);
  const midBandY0 = Math.floor(yT + borderH * 0.35);
  const midBandY1 = Math.floor(yT + borderH * 0.65);

  let bestCX = Math.floor((xL + xR) / 2);
  let bestCXScore = -1;
  for (let x = midBandX0; x <= midBandX1; x++) {
    const s = darkCountInCol(x);
    if (s > bestCXScore) {
      bestCXScore = s;
      bestCX = x;
    }
  }

  let bestCY = Math.floor((yT + yB) / 2);
  let bestCYScore = -1;
  for (let y = midBandY0; y <= midBandY1; y++) {
    const s = darkCountInRow(y);
    if (s > bestCYScore) {
      bestCYScore = s;
      bestCY = y;
    }
  }

  // Mask out the thick bars so they don't get detected as "holes"
  const BAR_HALF = Math.max(6, Math.floor(borderW * 0.01)); // ~1% of width, min 6px

  // --- Connected components blob find for holes ---
  // We detect dark blobs (holes) and filter by area.
  const visited = new Uint8Array(width * height);

  function inMask(x, y) {
    // inside border rectangle
    if (x < xL || x > xR || y < yT || y > yB) return false;
    // exclude center bars
    if (Math.abs(x - bestCX) <= BAR_HALF) return false;
    if (Math.abs(y - bestCY) <= BAR_HALF) return false;
    // dark pixel
    const v = data[y * width + x];
    return v < TH;
  }

  const holes = [];
  const MIN_AREA = 25;    // filters speck noise
  const MAX_AREA = 20000; // filters huge regions

  // BFS queue (re-used arrays for speed)
  const qx = new Int32Array(width * 2);
  const qy = new Int32Array(width * 2);

  for (let y = yT; y <= yB; y++) {
    for (let x = xL; x <= xR; x++) {
      const idx = y * width + x;
      if (visited[idx]) continue;
      visited[idx] = 1;

      if (!inMask(x, y)) continue;

      // BFS
      let head = 0;
      let tail = 0;
      qx[tail] = x;
      qy[tail] = y;
      tail++;

      let area = 0;
      let sumX = 0;
      let sumY = 0;

      while (head < tail) {
        const cx = qx[head];
        const cy = qy[head];
        head++;

        area++;
        sumX += cx;
        sumY += cy;

        // 4-neighborhood
        const n1 = cx - 1, n2 = cx + 1, n3 = cy - 1, n4 = cy + 1;

        if (n1 >= xL) {
          const i = cy * width + n1;
          if (!visited[i]) {
            visited[i] = 1;
            if (inMask(n1, cy)) {
              qx[tail] = n1;
              qy[tail] = cy;
              tail++;
            }
          }
        }
        if (n2 <= xR) {
          const i = cy * width + n2;
          if (!visited[i]) {
            visited[i] = 1;
            if (inMask(n2, cy)) {
              qx[tail] = n2;
              qy[tail] = cy;
              tail++;
            }
          }
        }
        if (n3 >= yT) {
          const i = n3 * width + cx;
          if (!visited[i]) {
            visited[i] = 1;
            if (inMask(cx, n3)) {
              qx[tail] = cx;
              qy[tail] = n3;
              tail++;
            }
          }
        }
        if (n4 <= yB) {
          const i = n4 * width + cx;
          if (!visited[i]) {
            visited[i] = 1;
            if (inMask(cx, n4)) {
              qx[tail] = cx;
              qy[tail] = n4;
              tail++;
            }
          }
        }
      }

      if (area < MIN_AREA || area > MAX_AREA) continue;

      const cenX = sumX / area;
      const cenY = sumY / area;

      // Convert to inches relative to target center (Right+/Left-, Up+/Down-)
      const xIn = (cenX - bestCX) / pixelsPerInch;
      const yIn = (bestCY - cenY) / pixelsPerInch;

      holes.push({
        x: round2(xIn),
        y: round2(yIn),
        area,
      });
    }
  }

  // Keep the biggest blobs (holes) and compute POIB as average of their centers
  holes.sort((a, b) => b.area - a.area);
  const top = holes.slice(0, 12); // allow up to 12 shots

  let poibX = 0;
  let poibY = 0;
  if (top.length > 0) {
    for (const p of top) {
      poibX += p.x;
      poibY += p.y;
    }
    poibX /= top.length;
    poibY /= top.length;
  }

  return {
    poibInches: { x: round2(poibX), y: round2(poibY) },
    holesInches: top.map((p) => ({ x: p.x, y: p.y, area: p.area })),
    detectInfo: {
      normalized: { width: width, height: height },
      targetSizeInches,
      centerInches: { x: 0, y: 0 },
      holeCountUsed: top.length,
      quality: top.length > 0 ? "OK" : "NO_HOLES_DETECTED",
    },
  };
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
      note: 'Use POST /api/sec (multipart: field "image" + optional fields).',
    })
  );
});

// IMPORTANT: field name must be exactly "image"
app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const file = req.file || null;
    const debugBody = req.body || {};
    const debugKeys = Object.keys(debugBody || {});

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

    // Inputs
    const distanceYards = toNumberOrDefault(req.body?.distanceYards, 100);
    const clickValueMoa = toNumberOrDefault(req.body?.clickValueMoa, 0.25);
    const targetSizeInches = toNumberOrDefault(req.body?.targetSizeInches, 23);

    // Manual POIB override (optional)
    const poibXManual = req.body?.poibX;
    const poibYManual = req.body?.poibY;
    const hasManual =
      poibXManual !== undefined &&
      poibXManual !== null &&
      String(poibXManual).trim() !== "" &&
      poibYManual !== undefined &&
      poibYManual !== null &&
      String(poibYManual).trim() !== "";

    let poibInches = { x: 0, y: 0 };
    let computeStatus = "COMPUTED_FROM_IMAGE";
    let holesInches = [];
    let detect = null;

    if (hasManual) {
      poibInches = {
        x: round2(toNumberOrDefault(poibXManual, 0)),
        y: round2(toNumberOrDefault(poibYManual, 0)),
      };
      computeStatus = "MANUAL_POIB_OVERRIDE";
    } else {
      const r = await computePoibFromImage(file.buffer, targetSizeInches);
      poibInches = r.poibInches;
      holesInches = r.holesInches;
      detect = r.detectInfo;
      computeStatus = "COMPUTED_FROM_IMAGE";
    }

    // CORRECTION clicks (sign-correct): dial = - POIB / inchesPerClick
    const ipc = inchesPerClick(distanceYards, clickValueMoa);

    const windageClicksSigned = ipc === 0 ? 0 : (-poibInches.x / ipc);
    const elevationClicksSigned = ipc === 0 ? 0 : (-poibInches.y / ipc);

    const clicksSigned = {
      windage: round2(windageClicksSigned),
      elevation: round2(elevationClicksSigned),
    };

    const dial = {
      windage: dialText("windage", clicksSigned.windage),
      elevation: dialText("elevation", clicksSigned.elevation),
    };

    // Image metadata (safe)
    const meta = await sharp(file.buffer).metadata();

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
          targetSizeInches,
          center: { col: "L", row: 12 },

          // POIB used (inches)
          poibInches,

          // Signed CORRECTION clicks: Right+/Left-, Up+/Down-
          clicksSigned,

          // Readable instruction
          dial,

          computeStatus,

          // For debugging the image path (all in inches; no pixel outputs)
          holesInches,
          detect,
        },

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
