/**
 * SCZN3 SEC Backend (bull-logic locked)
 *
 * Endpoint:
 *   POST /api/sec   multipart/form-data field: image
 *
 * Inputs (form fields):
 *   distanceYards (number)   default 100
 *   clickValueMoa (number)   default 0.25
 *   targetSizeInches (number) LONG SIDE INCHES (e.g., 11 for 8.5x11, 23 for 23x23) default 11
 *
 * Output conventions (LOCKED):
 *   - POIB inches: x Right +, Left -, y Up +, Down -
 *   - "Dial" directions are determined ONLY by bull logic:
 *       if POIB.x > 0 => dial LEFT
 *       if POIB.x < 0 => dial RIGHT
 *       if POIB.y > 0 => dial DOWN
 *       if POIB.y < 0 => dial UP
 *   - Click magnitudes derived from True MOA:
 *       1 MOA = 1.047" @ 100y
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");

const app = express();

app.use(cors({ origin: true, credentials: false }));

// Always JSON (avoid HTML error pages)
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function fmt2(n) {
  return round2(n).toFixed(2);
}

function inchesPerMoaAtYards(yards) {
  // True MOA
  return 1.047 * (yards / 100);
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

/**
 * Connected components on a binary mask (Uint8Array 0/1).
 * Returns components with bbox + area + centroid.
 */
function findComponents(mask, w, h) {
  const visited = new Uint8Array(mask.length);
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

      let minX = x,
        maxX = x,
        minY = y,
        maxY = y;
      let area = 0;
      let sumX = 0,
        sumY = 0;

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
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = idx(nx, ny);
            if (!mask[ni] || visited[ni]) continue;
            visited[ni] = 1;
            qx.push(nx);
            qy.push(ny);
          }
        }
      }

      const cx = sumX / area;
      const cy = sumY / area;
      comps.push({
        area,
        bbox: { x0: minX, y0: minY, x1: maxX, y1: maxY, w: maxX - minX + 1, h: maxY - minY + 1 },
        c: { x: cx, y: cy },
      });
    }
  }

  return comps;
}

/**
 * Pick 4 fiducials (black corner squares) and compute centerPx as their centroid average.
 * Works on the SCZN3 test targets with corner black squares.
 */
function estimateCenterFromFiducials(comps, w, h) {
  // Candidates: reasonably large, square-ish, near corners
  const candidates = comps
    .map((c) => {
      const bw = c.bbox.w;
      const bh = c.bbox.h;
      const ar = bw / bh;
      const squarish = ar > 0.6 && ar < 1.4;
      return { ...c, bw, bh, ar, squarish };
    })
    .filter((c) => c.squarish && c.area > 200); // tune if needed

  if (candidates.length < 4) return null;

  const corners = [
    { name: "tl", x: 0, y: 0 },
    { name: "tr", x: w - 1, y: 0 },
    { name: "bl", x: 0, y: h - 1 },
    { name: "br", x: w - 1, y: h - 1 },
  ];

  const picked = {};

  for (const corner of corners) {
    let best = null;
    let bestD = Infinity;

    for (const c of candidates) {
      const dx = c.c.x - corner.x;
      const dy = c.c.y - corner.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) {
        bestD = d2;
        best = c;
      }
    }

    if (!best) return null;
    picked[corner.name] = best;
  }

  const xs = [picked.tl.c.x, picked.tr.c.x, picked.bl.c.x, picked.br.c.x];
  const ys = [picked.tl.c.y, picked.tr.c.y, picked.bl.c.y, picked.br.c.y];

  const centerPx = {
    x: xs.reduce((a, b) => a + b, 0) / xs.length,
    y: ys.reduce((a, b) => a + b, 0) / ys.length,
  };

  return { centerPx, fiducials: picked };
}

/**
 * Basic outlier rejection:
 * If we have >=4 holes, pick the tightest 70% cluster and average it.
 */
function tightClusterAverage(points) {
  if (points.length <= 3) {
    const sx = points.reduce((a, p) => a + p.x, 0);
    const sy = points.reduce((a, p) => a + p.y, 0);
    return { x: sx / points.length, y: sy / points.length, used: points.length };
  }

  const n = points.length;
  const k = Math.max(3, Math.ceil(n * 0.7));

  // precompute distances
  const d = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      const dist = Math.hypot(dx, dy);
      d[i][j] = dist;
      d[j][i] = dist;
    }
  }

  let bestSet = null;
  let bestScore = Infinity;

  // Try each point as an anchor: choose k-1 nearest neighbors
  for (let i = 0; i < n; i++) {
    const neighbors = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      neighbors.push({ j, dist: d[i][j] });
    }
    neighbors.sort((a, b) => a.dist - b.dist);

    const idxs = [i, ...neighbors.slice(0, k - 1).map((x) => x.j)];

    // score = sum pairwise distances
    let score = 0;
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        score += d[idxs[a]][idxs[b]];
      }
    }

    if (score < bestScore) {
      bestScore = score;
      bestSet = idxs;
    }
  }

  const usedPoints = bestSet.map((i) => points[i]);
  const sx = usedPoints.reduce((a, p) => a + p.x, 0);
  const sy = usedPoints.reduce((a, p) => a + p.y, 0);
  return { x: sx / usedPoints.length, y: sy / usedPoints.length, used: usedPoints.length };
}

/**
 * Detect dark blobs (holes) in a "light grid" target.
 * This is tuned for your SCZN3 test images (scribbles/hole marks).
 */
function detectHolesFromImage(gray, w, h, excludeBoxes = []) {
  // Build a binary mask of "dark" pixels.
  // Threshold is conservative; grid lines are light so they should not trigger heavily.
  const mask = new Uint8Array(w * h);

  // Quick global threshold by sampling brightness
  // (0 = black, 255 = white)
  let sum = 0;
  const step = Math.max(1, Math.floor((w * h) / 50000));
  for (let i = 0; i < gray.length; i += step) sum += gray[i];
  const mean = sum / Math.ceil(gray.length / step);

  // threshold = mean - 45 (clamped)
  const thr = clamp(Math.round(mean - 45), 40, 200);

  const inExcluded = (x, y) => {
    for (const b of excludeBoxes) {
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return true;
    }
    return false;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (inExcluded(x, y)) continue;
      if (gray[i] < thr) mask[i] = 1;
    }
  }

  const comps = findComponents(mask, w, h);

  // Filter components for hole-like blobs
  // (not tiny noise, not giant regions)
  const holes = comps
    .map((c) => {
      const bw = c.bbox.w;
      const bh = c.bbox.h;
      const aspect = bw / bh;
      return { ...c, bw, bh, aspect };
    })
    .filter((c) => c.area >= 120 && c.area <= 12000)
    .filter((c) => c.bw >= 6 && c.bh >= 6)
    .filter((c) => c.aspect > 0.25 && c.aspect < 4.0)
    // avoid edge garbage
    .filter((c) => c.c.x > 10 && c.c.x < w - 10 && c.c.y > 10 && c.c.y < h - 10);

  return { holes, thresholdUsed: thr };
}

/**
 * Bull-logic (direction) — explicit comparisons, no ambiguity.
 */
function bullDialFromPoib(poibX, poibY) {
  const eps = 1e-6;

  // Windage: POIB right => dial LEFT, POIB left => dial RIGHT
  let windDir = "CENTER";
  if (poibX > eps) windDir = "LEFT";
  else if (poibX < -eps) windDir = "RIGHT";

  // Elevation: POIB up => dial DOWN, POIB down => dial UP
  let elevDir = "CENTER";
  if (poibY > eps) elevDir = "DOWN";
  else if (poibY < -eps) elevDir = "UP";

  return { windDir, elevDir };
}

app.get("/", (req, res) => {
  res.status(200).send(JSON.stringify({ ok: true, service: "sczn3-sec-backend-pipe", status: "alive" }));
});

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).send(
        JSON.stringify({
          ok: false,
          computeStatus: "FAILED_INPUT",
          error: { code: "NO_IMAGE", message: "Missing multipart field: image" },
        })
      );
    }

    const distanceYards = num(req.body.distanceYards, 100);
    const clickValueMoa = num(req.body.clickValueMoa, 0.25);

    // IMPORTANT: This must be LONG SIDE inches
    // 8.5x11 => 11, 23x23 => 23
    const targetSizeInches = num(req.body.targetSizeInches, 11);

    // Read + normalize image
    // (resize down for speed but keep geometry stable)
    const img0 = sharp(req.file.buffer, { failOnError: false }).rotate();
    const meta = await img0.metadata();

    const maxSide = 1600;
    let img = img0;
    if (meta.width && meta.height) {
      const longPx = Math.max(meta.width, meta.height);
      if (longPx > maxSide) {
        img = img0.resize({
          width: meta.width >= meta.height ? maxSide : null,
          height: meta.height > meta.width ? maxSide : null,
          fit: "inside",
        });
      }
    }

    const { data, info } = await img.clone().grayscale().raw().toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;

    // Compute pixels-per-inch from LONG SIDE
    const longSidePx = Math.max(w, h);
    const pixelsPerInch = longSidePx / targetSizeInches;

    // Step 1: find fiducials (corner black squares) to get bull center
    // Build a dark mask for fiducials
    const fidMask = new Uint8Array(w * h);
    // Use a darker threshold for fiducials
    let sum = 0;
    const step = Math.max(1, Math.floor((w * h) / 50000));
    for (let i = 0; i < data.length; i += step) sum += data[i];
    const mean = sum / Math.ceil(data.length / step);
    const fidThr = clamp(Math.round(mean - 70), 20, 160);

    for (let i = 0; i < data.length; i++) {
      if (data[i] < fidThr) fidMask[i] = 1;
    }

    const fidComps = findComponents(fidMask, w, h);
    const centerInfo = estimateCenterFromFiducials(fidComps, w, h);

    if (!centerInfo) {
      return res.status(200).send(
        JSON.stringify({
          ok: false,
          service: "sczn3-sec-backend-pipe",
          computeStatus: "FAILED_FIDUCIALS",
          error: {
            code: "FIDUCIALS_NOT_FOUND",
            message: "Could not locate 4 corner fiducials to compute bull center.",
          },
          detect: {
            normalized: { width: w, height: h },
            pixelsPerInch,
            fiducialThresholdUsed: fidThr,
            fiducialComponents: fidComps.length,
          },
          sec: { distanceYards, clickValueMoa, targetSizeInches },
        })
      );
    }

    const centerPx = centerInfo.centerPx;

    // Exclude fiducial boxes so they don't count as holes
    const excludeBoxes = Object.values(centerInfo.fiducials).map((c) => c.bbox);

    // Step 2: detect holes (dark blobs) excluding fiducials
    const holesResult = detectHolesFromImage(data, w, h, excludeBoxes);
    const holes = holesResult.holes;

    if (!holes.length) {
      return res.status(200).send(
        JSON.stringify({
          ok: false,
          service: "sczn3-sec-backend-pipe",
          computeStatus: "FAILED_HOLES",
          error: {
            code: "HOLES_NOT_FOUND",
            message: "No bullet holes detected. Use a clean light-grid SCZN3 test target image.",
          },
          detect: {
            normalized: { width: w, height: h },
            centerPx,
            pixelsPerInch,
            fiducialThresholdUsed: fidThr,
            holeThresholdUsed: holesResult.thresholdUsed,
            holesDetected: 0,
          },
          sec: { distanceYards, clickValueMoa, targetSizeInches },
        })
      );
    }

    // Group center = tight cluster average of hole centroids
    const points = holes.map((h0) => ({ x: h0.c.x, y: h0.c.y }));
    const groupCenterPx = tightClusterAverage(points);

    // POIB inches (cluster relative to bull center)
    // X: Right +, Left -
    // Y: Up +, Down -   (pixel Y grows DOWN, so flip once here)
    const dxPx = groupCenterPx.x - centerPx.x;
    const dyPx = groupCenterPx.y - centerPx.y;

    const poibX = dxPx / pixelsPerInch;
    const poibY = -(dyPx / pixelsPerInch); // flip once, LOCKED

    // Bull logic for directions (explicit comparisons)
    const { windDir, elevDir } = bullDialFromPoib(poibX, poibY);

    // Click math (True MOA)
    const inchesPerClick = inchesPerMoaAtYards(distanceYards) * clickValueMoa;

    // Correction inches = "move impact to bull"
    // Wind correction is opposite of POIB.x
    const corrX = -poibX;
    const corrY = -poibY;

    // Signed clicks (for debugging/auditing)
    const wSigned = corrX / inchesPerClick;
    const eSigned = corrY / inchesPerClick;

    const wMag = Math.abs(wSigned);
    const eMag = Math.abs(eSigned);

    const response = {
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: "BULL_LOGIC_LOCKED_V1",
      received: {
        field: "image",
        originalname: req.file.originalname || null,
        mimetype: req.file.mimetype || null,
        bytes: req.file.size || null,
      },
      sec: {
        distanceYards,
        clickValueMoa,
        targetSizeInches,
      },
      computeStatus: "COMPUTED_FROM_IMAGE",
      detect: {
        normalized: { width: w, height: h },
        centerPx: { x: round2(centerPx.x), y: round2(centerPx.y) },
        groupCenterPx: { x: round2(groupCenterPx.x), y: round2(groupCenterPx.y), used: groupCenterPx.used },
        pixelsPerInch: round2(pixelsPerInch),
        fiducialThresholdUsed: fidThr,
        holeThresholdUsed: holesResult.thresholdUsed,
        holesDetected: holes.length,
      },
      poibInches: {
        x: round2(poibX),
        y: round2(poibY),
      },
      // Debug: signed clicks
      clicksSigned: {
        windage: round2(wSigned),
        elevation: round2(eSigned),
      },
      // UI-friendly minimal output (direction from bull logic, magnitude from click math)
      dial: {
        windage: `${windDir} ${fmt2(wMag)} clicks`,
        elevation: `${elevDir} ${fmt2(eMag)} clicks`,
      },
      minimal: {
        windage: { direction: windDir, clicks: fmt2(wMag) },
        elevation: { direction: elevDir, clicks: fmt2(eMag) },
      },
    };

    return res.status(200).send(JSON.stringify(response));
  } catch (err) {
    return res.status(200).send(
      JSON.stringify({
        ok: false,
        service: "sczn3-sec-backend-pipe",
        computeStatus: "FAILED_EXCEPTION",
        error: { code: "EXCEPTION", message: String(err && err.message ? err.message : err) },
      })
    );
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`sczn3-sec-backend-pipe listening on ${PORT}`);
});
