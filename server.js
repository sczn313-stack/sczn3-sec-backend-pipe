// server.js — SCZN3 SEC Backend (REAL COMPUTE)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart: field "image" + optional fields:
//   distanceYards (yards)   clickValueMoa (MOA per click)
//   targetSizeInches (physical size of the printed square target, default 23)
//   poibX, poibY (inches)  [optional override: if provided, backend will NOT image-compute POIB]

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "REAL_v1_2025-12-26";

const app = express();

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Always return JSON (avoid default HTML errors)
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
    return clicksSigned >= 0 ? `RIGHT ${rounded} clicks` : `LEFT ${rounded} clicks`;
  }
  return clicksSigned >= 0 ? `UP ${rounded} clicks` : `DOWN ${rounded} clicks`;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Build a binary "dark pixel" mask from grayscale pixels.
 * Threshold is dynamic based on mean (works across lighting differences).
 */
function buildDarkMask(gray, w, h) {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;

  // dynamic threshold: darker than (mean - offset)
  const thr = clamp(Math.round(mean - 35), 35, 140);

  const mask = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) {
    mask[i] = gray[i] < thr ? 1 : 0;
  }
  return { mask, thr, mean: round2(mean) };
}

/**
 * Column + row projection sums for a binary mask (0/1).
 */
function projections(mask, w, h) {
  const col = new Uint32Array(w);
  const row = new Uint32Array(h);

  for (let y = 0; y < h; y++) {
    let rsum = 0;
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const v = mask[base + x];
      rsum += v;
      col[x] += v;
    }
    row[y] = rsum;
  }
  return { col, row };
}

function argMaxInRange(arr, start, end) {
  let bestI = start;
  let bestV = -1;
  for (let i = start; i <= end; i++) {
    const v = arr[i];
    if (v > bestV) {
      bestV = v;
      bestI = i;
    }
  }
  return { index: bestI, value: bestV };
}

/**
 * Detect target border + center crosshair using projection peaks.
 * Returns: edges + center lines.
 */
function detectFrameAndCenter(mask, w, h) {
  const { col, row } = projections(mask, w, h);

  // Find left/right border lines by scanning in the outer quarters
  const qx = Math.floor(w * 0.25);
  const qy = Math.floor(h * 0.25);

  const left = argMaxInRange(col, 0, qx);
  const right = argMaxInRange(col, w - qx - 1, w - 1);
  const top = argMaxInRange(row, 0, qy);
  const bottom = argMaxInRange(row, h - qy - 1, h - 1);

  // Now center lines: strongest peaks near middle half (avoid edges)
  const cxStart = Math.floor(w * 0.35);
  const cxEnd = Math.floor(w * 0.65);
  const cyStart = Math.floor(h * 0.35);
  const cyEnd = Math.floor(h * 0.65);

  const vCenter = argMaxInRange(col, cxStart, cxEnd);
  const hCenter = argMaxInRange(row, cyStart, cyEnd);

  // sanity: ensure edges make sense
  const xL = Math.min(left.index, right.index);
  const xR = Math.max(left.index, right.index);
  const yT = Math.min(top.index, bottom.index);
  const yB = Math.max(top.index, bottom.index);

  return {
    edges: { xL, xR, yT, yB },
    center: { xC: vCenter.index, yC: hCenter.index },
    peaks: {
      leftColSum: left.value,
      rightColSum: right.value,
      topRowSum: top.value,
      bottomRowSum: bottom.value,
      vCenterColSum: vCenter.value,
      hCenterRowSum: hCenter.value,
    },
  };
}

/**
 * Remove a band around lines (border + center crosshair) so bullet-hole blobs remain.
 */
function buildHoleCandidateMask(darkMask, w, h, frame, pixelsPerInch) {
  const out = new Uint8Array(w * h);

  const { xL, xR, yT, yB } = frame.edges;
  const { xC, yC } = frame.center;

  // band widths in pixels
  const borderBand = Math.max(4, Math.round(pixelsPerInch * 0.25)); // ~1/4"
  const crossBand = Math.max(4, Math.round(pixelsPerInch * 0.25));  // ~1/4"

  for (let y = 0; y < h; y++) {
    const base = y * w;

    const inTopBand = y >= yT - borderBand && y <= yT + borderBand;
    const inBottomBand = y >= yB - borderBand && y <= yB + borderBand;
    const inCrossH = y >= yC - crossBand && y <= yC + crossBand;

    for (let x = 0; x < w; x++) {
      const idx = base + x;
      if (!darkMask[idx]) continue;

      const inLeftBand = x >= xL - borderBand && x <= xL + borderBand;
      const inRightBand = x >= xR - borderBand && x <= xR + borderBand;
      const inCrossV = x >= xC - crossBand && x <= xC + crossBand;

      // Keep only dark pixels NOT in any excluded band
      if (inTopBand || inBottomBand || inLeftBand || inRightBand || inCrossH || inCrossV) {
        continue;
      }

      out[idx] = 1;
    }
  }

  return out;
}

/**
 * Connected components on binary mask (0/1) with basic filtering.
 * Returns blob centroids.
 */
function findBlobs(mask, w, h, pixelsPerInch) {
  const visited = new Uint8Array(w * h);
  const blobs = [];

  // bullet hole area filter (depends on scale)
  const minArea = Math.max(25, Math.round(0.02 * pixelsPerInch * pixelsPerInch)); // ~0.02 in^2
  const maxArea = Math.max(300, Math.round(0.60 * pixelsPerInch * pixelsPerInch)); // ~0.60 in^2

  const stack = [];

  for (let y = 1; y < h - 1; y++) {
    const base = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = base + x;
      if (!mask[idx] || visited[idx]) continue;

      // flood fill
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = x, maxX = x, minY = y, maxY = y;

      visited[idx] = 1;
      stack.push(idx);

      while (stack.length) {
        const cur = stack.pop();
        area++;

        const cy = Math.floor(cur / w);
        const cx = cur - cy * w;

        sumX += cx;
        sumY += cy;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 8-neighborhood
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          const nbase = ny * w;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const nidx = nbase + nx;
            if (!visited[nidx] && mask[nidx]) {
              visited[nidx] = 1;
              stack.push(nidx);
            }
          }
        }
      }

      if (area < minArea || area > maxArea) continue;

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const aspect = bw > bh ? bw / bh : bh / bw;

      // basic sanity: holes should not be super long skinny blobs
      if (aspect > 3.0) continue;

      blobs.push({
        area,
        bbox: { minX, minY, maxX, maxY, w: bw, h: bh },
        centroidPx: { x: sumX / area, y: sumY / area },
      });
    }
  }

  return { blobs, filters: { minArea, maxArea } };
}

/**
 * Choose a tight cluster of 3–7 blobs (SCZN3 default logic).
 * Heuristic: for each blob, take k nearest and minimize max radius.
 */
function chooseTightCluster(blobs) {
  const n = blobs.length;
  if (n === 0) return { selected: [], reason: "no_blobs" };
  if (n <= 3) return { selected: blobs.map((_, i) => i), reason: "n<=3" };

  const pts = blobs.map((b) => b.centroidPx);

  function dist(i, j) {
    const dx = pts[i].x - pts[j].x;
    const dy = pts[i].y - pts[j].y;
    return Math.hypot(dx, dy);
  }

  let best = null;

  const maxK = Math.min(7, n);
  for (let k = 3; k <= maxK; k++) {
    for (let i = 0; i < n; i++) {
      // get neighbors by distance
      const ds = [];
      for (let j = 0; j < n; j++) {
        ds.push({ j, d: dist(i, j) });
      }
      ds.sort((a, b) => a.d - b.d);

      const sel = ds.slice(0, k).map((o) => o.j);

      // compute cluster radius (max distance to centroid)
      let sx = 0, sy = 0;
      for (const idx of sel) {
        sx += pts[idx].x;
        sy += pts[idx].y;
      }
      const cx = sx / sel.length;
      const cy = sy / sel.length;

      let rMax = 0;
      for (const idx of sel) {
        const r = Math.hypot(pts[idx].x - cx, pts[idx].y - cy);
        if (r > rMax) rMax = r;
      }

      const candidate = { k, i, sel, rMax };

      if (!best || candidate.rMax < best.rMax) best = candidate;
    }
  }

  return { selected: best.sel, reason: `tightest_k=${best.k}`, rMaxPx: best.rMax };
}

/**
 * Compute POIB from blobs relative to center lines.
 * Returns POIB inches where:
 *   x: Right + / Left -
 *   y: Up + / Down -   (NOTE: image y grows downward, so we invert)
 */
function computePoibFromBlobs(blobs, selectedIdxs, centerPx, pixelsPerInch) {
  if (!selectedIdxs.length) {
    return { ok: false, reason: "no_selected_blobs" };
  }

  let sx = 0, sy = 0;
  for (const idx of selectedIdxs) {
    sx += blobs[idx].centroidPx.x;
    sy += blobs[idx].centroidPx.y;
  }
  const cx = sx / selectedIdxs.length;
  const cy = sy / selectedIdxs.length;

  const dxPx = cx - centerPx.xC;
  const dyPx = cy - centerPx.yC;

  const xIn = dxPx / pixelsPerInch;
  const yIn = -(dyPx / pixelsPerInch); // invert so UP is positive

  return {
    ok: true,
    centroidPx: { x: cx, y: cy },
    poibInches: { x: round2(xIn), y: round2(yIn) },
    dxPx: round2(dxPx),
    dyPx: round2(dyPx),
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
      note:
        'POST /api/sec (multipart: field "image") optional fields: distanceYards, clickValueMoa, targetSizeInches, poibX, poibY',
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

    // Inputs (defaults = SCZN3 standard)
    const distanceYards = toNumberOrDefault(req.body?.distanceYards, 100);
    const clickValueMoa = toNumberOrDefault(req.body?.clickValueMoa, 0.25);

    // Physical size (square target width in inches). Default 23.
    // If you’re testing on a smaller printed target, send targetSizeInches in the form.
    const targetSizeInches = toNumberOrDefault(req.body?.targetSizeInches, 23);

    // Manual POIB override (if provided, we use it instead of computing from image)
    const manualPoibX = req.body?.poibX;
    const manualPoibY = req.body?.poibY;
    const hasManualPoib =
      manualPoibX !== undefined &&
      manualPoibX !== null &&
      manualPoibY !== undefined &&
      manualPoibY !== null &&
      String(manualPoibX).trim() !== "" &&
      String(manualPoibY).trim() !== "";

    // --- Normalize image for compute (downscale + grayscale) ---
    const MAX_W = 1100; // keep compute fast on Render free tier
    const normalized = sharp(file.buffer).rotate().resize({ width: MAX_W, withoutEnlargement: true });

    const meta = await normalized.metadata();

    const { data: gray, info } = await normalized
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;

    // 1) dark mask (for border + center detection)
    const { mask: darkMask, thr, mean } = buildDarkMask(gray, w, h);

    // 2) detect border + center crosshair
    const frame = detectFrameAndCenter(darkMask, w, h);

    const borderPxW = Math.max(10, frame.edges.xR - frame.edges.xL);
    const borderPxH = Math.max(10, frame.edges.yB - frame.edges.yT);

    // pixels-per-inch estimate from detected border width (square target)
    const pixelsPerInch = borderPxW / targetSizeInches;

    // 3) bullet-hole candidate mask (remove border + crosshair bands)
    const holeMask = buildHoleCandidateMask(darkMask, w, h, frame, pixelsPerInch);

    // 4) blobs (bullet holes)
    const { blobs, filters } = findBlobs(holeMask, w, h, pixelsPerInch);

    // 5) choose cluster 3–7
    const cluster = chooseTightCluster(blobs);

    // 6) compute POIB (manual overrides image compute)
    let poibInches = { x: 0, y: 0 };
    let computeStatus = "COMPUTED_FROM_IMAGE";
    let computeDetails = {};

    if (hasManualPoib) {
      poibInches = {
        x: toNumberOrDefault(manualPoibX, 0),
        y: toNumberOrDefault(manualPoibY, 0),
      };
      computeStatus = "MANUAL_POIB_OVERRIDE";
      computeDetails = {
        note: "poibX/poibY were provided; backend used manual POIB instead of image compute.",
      };
    } else {
      const poib = computePoibFromBlobs(blobs, cluster.selected, frame.center, pixelsPerInch);
      if (!poib.ok) {
        computeStatus = "FAILED_TO_DETECT_HOLES";
        computeDetails = { reason: poib.reason };
        poibInches = { x: 0, y: 0 };
      } else {
        poibInches = poib.poibInches;
        computeDetails = poib;
      }
    }

    // 7) clicks
    const ipc = inchesPerClick(distanceYards, clickValueMoa);
    const windageRaw = ipc === 0 ? 0 : poibInches.x / ipc;
    const elevationRaw = ipc === 0 ? 0 : poibInches.y / ipc;

    const clicksSigned = {
      windage: round2(windageRaw),
      elevation: round2(elevationRaw),
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
        },

        image: {
          width: meta.width || null,
          height: meta.height || null,
          format: meta.format || null,
          normalizedWidth: w,
          normalizedHeight: h,
          grayThreshold: thr,
          grayMean: mean,
        },

        // Detection results
        detect: {
          targetSizeInches,
          borderPx: { w: borderPxW, h: borderPxH },
          pixelsPerInch: round2(pixelsPerInch),
          edges: frame.edges,
          centerPx: frame.center,
          peaks: frame.peaks,
          blobFilters: filters,
          blobsFound: blobs.length,
          cluster: {
            selectedCount: cluster.selected.length,
            selectedIdxs: cluster.selected,
            reason: cluster.reason,
            rMaxPx: cluster.rMaxPx ? round2(cluster.rMaxPx) : null,
          },
          blobs: blobs.map((b, i) => ({
            i,
            area: b.area,
            centroidPx: { x: round2(b.centroidPx.x), y: round2(b.centroidPx.y) },
            bbox: b.bbox,
          })),
        },

        // SEC output
        sec: {
          distanceYards,
          clickValueMoa,
          center: { col: "L", row: 12 },

          // Computed or manual POIB
          poibInches,

          // Signed clicks: Right+/Left-, Up+/Down-
          clicksSigned,

          // Readable instruction
          dial,

          computeStatus,
          computeDetails,
        },

        // DEBUG: shows exactly what multipart fields arrived
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
