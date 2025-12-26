// server.js — SCZN3 SEC Backend (REAL IMAGE POIB + SIGN-CORRECT)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart: field "image" + optional fields:
//   distanceYards (yards)   clickValueMoa (MOA per click)   targetSizeInches (default 23)
//   poibX, poibY (inches) OPTIONAL manual override (Right+/Left-, Up+/Down-)
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

const BUILD_TAG = "REAL_v3_2025-12-26_IMAGE_POIB_FIX";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Always return JSON
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

// ---------- Helpers ----------
function toNumberOrDefault(v, def) {
  if (v === undefined || v === null) return def;
  const s = String(v).trim();
  if (s === "") return def;
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}

// 1 MOA ≈ 1.047" at 100 yards
function inchesPerClick(distanceYards, clickValueMoa) {
  return 1.047 * (distanceYards / 100) * clickValueMoa;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function dialText(axisName, clicksSigned) {
  const abs = Math.abs(clicksSigned);
  const rounded = round2(abs);

  if (axisName === "windage") {
    if (rounded === 0) return "CENTER (0.00 clicks)";
    return clicksSigned >= 0 ? `RIGHT ${rounded} clicks` : `LEFT ${rounded} clicks`;
  }
  // elevation
  if (rounded === 0) return "LEVEL (0.00 clicks)";
  return clicksSigned >= 0 ? `UP ${rounded} clicks` : `DOWN ${rounded} clicks`;
}

// Convert image buffer -> normalized grayscale raw pixels
async function normalizeToGrayRaw(buffer, targetW = 1100) {
  const img = sharp(buffer);
  const meta = await img.metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;

  // Normalize size (keep aspect)
  const resized = sharp(buffer).resize({ width: targetW, withoutEnlargement: false });

  // grayscale raw
  const { data, info } = await resized
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    orig: { width: w, height: h, format: meta.format || null },
    norm: { width: info.width, height: info.height },
    gray: data, // Uint8
  };
}

function idx(x, y, w) {
  return y * w + x;
}

function isDark(v, thr) {
  return v < thr;
}

// Find outer border rectangle by scanning from edges for full-height/width black lines
function detectOuterBorder(gray, w, h, thr = 140) {
  const minColDarkCount = Math.floor(h * 0.60); // border column should be dark for most rows
  const minRowDarkCount = Math.floor(w * 0.60); // border row should be dark for most cols

  // left border
  let xL = 0;
  for (let x = 0; x < w; x++) {
    let darkCount = 0;
    for (let y = 0; y < h; y++) {
      if (isDark(gray[idx(x, y, w)], thr)) darkCount++;
    }
    if (darkCount >= minColDarkCount) {
      xL = x;
      break;
    }
  }

  // right border
  let xR = w - 1;
  for (let x = w - 1; x >= 0; x--) {
    let darkCount = 0;
    for (let y = 0; y < h; y++) {
      if (isDark(gray[idx(x, y, w)], thr)) darkCount++;
    }
    if (darkCount >= minColDarkCount) {
      xR = x;
      break;
    }
  }

  // top border
  let yT = 0;
  for (let y = 0; y < h; y++) {
    let darkCount = 0;
    for (let x = 0; x < w; x++) {
      if (isDark(gray[idx(x, y, w)], thr)) darkCount++;
    }
    if (darkCount >= minRowDarkCount) {
      yT = y;
      break;
    }
  }

  // bottom border
  let yB = h - 1;
  for (let y = h - 1; y >= 0; y--) {
    let darkCount = 0;
    for (let x = 0; x < w; x++) {
      if (isDark(gray[idx(x, y, w)], thr)) darkCount++;
    }
    if (darkCount >= minRowDarkCount) {
      yB = y;
      break;
    }
  }

  // Safety clamp (avoid nonsense rectangles)
  const pad = 2;
  xL = Math.max(0, Math.min(w - 1, xL - pad));
  xR = Math.max(0, Math.min(w - 1, xR + pad));
  yT = Math.max(0, Math.min(h - 1, yT - pad));
  yB = Math.max(0, Math.min(h - 1, yB + pad));

  const rectW = Math.max(1, xR - xL + 1);
  const rectH = Math.max(1, yB - yT + 1);

  return { xL, xR, yT, yB, w: rectW, h: rectH };
}

// Downsample for blob detection speed
function downsampleGray(gray, w, h, ds = 2) {
  const nw = Math.floor(w / ds);
  const nh = Math.floor(h / ds);
  const out = new Uint8Array(nw * nh);

  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      out[y * nw + x] = gray[idx(x * ds, y * ds, w)];
    }
  }
  return { gray: out, w: nw, h: nh, ds };
}

// Connected components on a binary mask (4-neighbor)
function findBlobs(mask, w, h) {
  const visited = new Uint8Array(w * h);
  const blobs = [];

  const qx = new Int32Array(w * h);
  const qy = new Int32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i] || visited[i]) continue;

      // BFS
      let head = 0;
      let tail = 0;
      visited[i] = 1;
      qx[tail] = x;
      qy[tail] = y;
      tail++;

      let count = 0;
      let sumX = 0;
      let sumY = 0;

      let minX = x, maxX = x, minY = y, maxY = y;

      while (head < tail) {
        const cx = qx[head];
        const cy = qy[head];
        head++;

        count++;
        sumX += cx;
        sumY += cy;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // neighbors
        const n1 = (cy - 1) * w + cx;
        const n2 = (cy + 1) * w + cx;
        const n3 = cy * w + (cx - 1);
        const n4 = cy * w + (cx + 1);

        if (cy > 0 && mask[n1] && !visited[n1]) { visited[n1] = 1; qx[tail] = cx; qy[tail] = cy - 1; tail++; }
        if (cy < h - 1 && mask[n2] && !visited[n2]) { visited[n2] = 1; qx[tail] = cx; qy[tail] = cy + 1; tail++; }
        if (cx > 0 && mask[n3] && !visited[n3]) { visited[n3] = 1; qx[tail] = cx - 1; qy[tail] = cy; tail++; }
        if (cx < w - 1 && mask[n4] && !visited[n4]) { visited[n4] = 1; qx[tail] = cx + 1; qy[tail] = cy; tail++; }
      }

      blobs.push({
        count,
        cx: sumX / count,
        cy: sumY / count,
        bbox: { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 },
      });
    }
  }

  return blobs;
}

function computePOIBFromImage(gray, w, h, targetSizeInches, grayThr = 140) {
  // 1) detect outer border
  const border = detectOuterBorder(gray, w, h, grayThr);

  // 2) compute center inside border (pixel coords in normalized image)
  const centerPx = {
    x: (border.xL + border.xR) / 2,
    y: (border.yT + border.yB) / 2,
  };

  // pixels per inch using border width (target is square)
  const borderWidthPx = border.w;
  const pixelsPerInch = borderWidthPx / targetSizeInches;

  // 3) downsample for blob detection
  const cropPad = 6;
  const x0 = Math.min(w - 1, Math.max(0, border.xL + cropPad));
  const x1 = Math.min(w - 1, Math.max(0, border.xR - cropPad));
  const y0 = Math.min(h - 1, Math.max(0, border.yT + cropPad));
  const y1 = Math.min(h - 1, Math.max(0, border.yB - cropPad));

  const cw = Math.max(1, x1 - x0 + 1);
  const ch = Math.max(1, y1 - y0 + 1);

  // extract cropped gray
  const cropped = new Uint8Array(cw * ch);
  for (let yy = 0; yy < ch; yy++) {
    for (let xx = 0; xx < cw; xx++) {
      cropped[yy * cw + xx] = gray[idx(x0 + xx, y0 + yy, w)];
    }
  }

  const ds = 2;
  const dsObj = downsampleGray(cropped, cw, ch, ds);
  const g = dsObj.gray;
  const dw = dsObj.w;
  const dh = dsObj.h;

  // 4) build a mask of candidate hole pixels
  // Mask out the thick center cross region (don’t let it become a “hole blob”)
  const centerInCrop = {
    x: (centerPx.x - x0) / ds,
    y: (centerPx.y - y0) / ds,
  };

  const crossMaskHalf = Math.max(8, Math.floor(Math.min(dw, dh) * 0.02)); // ~2% of size, min 8px
  const edgeIgnore = 6;

  // Adaptive threshold tweak: if photo is very bright, keep a tighter threshold
  // (Still allow user-provided grayThr to drive border detection)
  let holeThr = 115;
  // quick estimate mean
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  const mean = sum / g.length;
  if (mean < 220) holeThr = 125; // darker photo -> loosen
  if (mean > 245) holeThr = 110; // very bright -> tighten

  const mask = new Uint8Array(dw * dh);
  for (let yy = 0; yy < dh; yy++) {
    for (let xx = 0; xx < dw; xx++) {
      const i = yy * dw + xx;
      const v = g[i];

      // ignore near edges (avoid picking border remnants)
      if (xx < edgeIgnore || yy < edgeIgnore || xx > dw - 1 - edgeIgnore || yy > dh - 1 - edgeIgnore) continue;

      // ignore center cross vertical/horizontal strip
      if (Math.abs(xx - centerInCrop.x) <= crossMaskHalf) continue;
      if (Math.abs(yy - centerInCrop.y) <= crossMaskHalf) continue;

      // candidate hole pixels
      if (v < holeThr) mask[i] = 1;
    }
  }

  // 5) blobs
  const blobs = findBlobs(mask, dw, dh);

  // 6) filter blobs to “hole-like”
  // Bullet holes should be moderate size blobs (not tiny noise, not huge artifacts)
  const minPix = 18;
  const maxPix = Math.floor(dw * dh * 0.01); // 1% of crop
  const candidates = blobs
    .filter((b) => b.count >= minPix && b.count <= maxPix)
    .filter((b) => b.bbox.w <= 90 && b.bbox.h <= 90); // avoid giant blobs

  // If nothing found, return 0 but include diagnostics
  if (candidates.length === 0) {
    return {
      poibInches: { x: 0, y: 0 },
      centerPx,
      border,
      pixelsPerInch,
      holeCount: 0,
      meanGray: round2(mean),
      holeThreshold: holeThr,
      note: "No hole blobs found (threshold/masking may need tuning for this photo).",
    };
  }

  // 7) group centroid = average of blob centroids (simple, stable)
  let sx = 0;
  let sy = 0;
  for (const b of candidates) {
    sx += b.cx;
    sy += b.cy;
  }
  const gc = { x: sx / candidates.length, y: sy / candidates.length };

  // Convert group centroid back to full normalized coordinates
  const groupPx = {
    x: x0 + gc.x * ds,
    y: y0 + gc.y * ds,
  };

  // 8) POIB inches (Right+/Left-, Up+/Down-)
  const dxPx = groupPx.x - centerPx.x;       // right positive
  const dyPx = centerPx.y - groupPx.y;       // up positive (invert y)
  const poibX = dxPx / pixelsPerInch;
  const poibY = dyPx / pixelsPerInch;

  return {
    poibInches: { x: round2(poibX), y: round2(poibY) },
    centerPx,
    groupPx,
    border,
    pixelsPerInch: round2(pixelsPerInch),
    holeCount: candidates.length,
    meanGray: round2(mean),
    holeThreshold: holeThr,
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

// IMPORTANT: multipart field name must be exactly "image"
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

    // Manual POIB override (if provided)
    const manualPoibX = req.body?.poibX;
    const manualPoibY = req.body?.poibY;
    const hasManual =
      manualPoibX !== undefined &&
      manualPoibY !== undefined &&
      String(manualPoibX).trim() !== "" &&
      String(manualPoibY).trim() !== "";

    // Normalize image and compute grayMean
    const norm = await normalizeToGrayRaw(file.buffer, 1100);

    // Image POIB (only if manual not provided)
    let poibInches = { x: 0, y: 0 };
    let computeStatus = "COMPUTED_FROM_IMAGE";
    let detect = null;

    if (hasManual) {
      poibInches = {
        x: toNumberOrDefault(manualPoibX, 0),
        y: toNumberOrDefault(manualPoibY, 0),
      };
      computeStatus = "MANUAL_POIB_OVERRIDE";
    } else {
      detect = computePOIBFromImage(
        norm.gray,
        norm.norm.width,
        norm.norm.height,
        targetSizeInches,
        140
      );
      poibInches = detect.poibInches;
    }

    // CORRECTION clicks = NEGATIVE of POIB offset
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
        },.

        image: {
          width: norm.orig.width,
          height: norm.orig.height,
          format: norm.orig.format,
          normalizedWidth: norm.norm.width,
          normalizedHeight: norm.norm.height,
        },

        detect, // null if manual override

        sec: {
          distanceYards,
          clickValueMoa,
          targetSizeInches,
          center: { col: "L", row: 12 },

          // POIB used (Right+/Left-, Up+/Down-)
          poibInches,

          // Signed CORRECTION clicks (what to dial)
          clicksSigned,

          dial,

          computeStatus,
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
