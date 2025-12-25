// server.js — SCZN3 SEC Backend (PIPE_v1_2025-12-24)
// Always JSON (never HTML error pages)
// POST /api/sec accepts multipart: "image" (preferred) OR "file" (legacy)

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "PIPE_v1_2025-12-24";

const CONFIG = {
  DISTANCE_YARDS: 100,
  MOA_PER_CLICK: 0.25,
  TARGET_WIDTH_IN: 23,
  MIN_SHOTS: 3,
  MAX_SHOTS: 7,
  MAX_ABS_CLICKS: 80,

  // image tuning
  MAX_W: 1400,
  INK_PAD_PCT: 0.03,
  OTSU_MIN: 35,
  OTSU_MAX: 150,

  // blob filtering
  MIN_AREA_PCT: 0.00003,
  MAX_AREA_PCT: 0.006,
  MAX_ASPECT: 3.0,
  MIN_FILL: 0.20,
};

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

// ---------- helpers ----------
function safeError(err) {
  return {
    name: err?.name || "Error",
    message: err?.message || String(err),
    stack: (err?.stack || "").split("\n").slice(0, 10).join("\n"),
  };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function to2(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Number(x.toFixed(2)) : 0;
}

function inchesPerMOA(distanceYds) {
  return 1.047 * (distanceYds / 100);
}

// Otsu threshold on grayscale bytes (0..255)
function otsuThreshold(grayBytes) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < grayBytes.length; i++) hist[grayBytes[i]]++;

  const total = grayBytes.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let varMax = -1;
  let threshold = 90;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;

    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > varMax) {
      varMax = between;
      threshold = t;
    }
  }
  return threshold;
}

// Broad target region: bounding box of not-white pixels
function findBBoxNotWhite(gray, w, h, notWhiteThresh = 235) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < notWhiteThresh) {
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// Connected components on a binary mask within a region
function connectedComponents(mask, w, h, region) {
  const visited = new Uint8Array(w * h);
  const comps = [];
  const { minX, minY, maxX, maxY } = region;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i0 = y * w + x;
      if (!mask[i0] || visited[i0]) continue;

      const stack = [i0];
      visited[i0] = 1;

      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let bx0 = w, by0 = h, bx1 = -1, by1 = -1;

      while (stack.length) {
        const i = stack.pop();
        area++;

        const ix = i % w;
        const iy = (i / w) | 0;

        sumX += ix;
        sumY += iy;

        if (ix < bx0) bx0 = ix;
        if (iy < by0) by0 = iy;
        if (ix > bx1) bx1 = ix;
        if (iy > by1) by1 = iy;

        const left = i - 1;
        const right = i + 1;
        const up = i - w;
        const down = i + w;

        if (ix > minX && mask[left] && !visited[left]) { visited[left] = 1; stack.push(left); }
        if (ix < maxX && mask[right] && !visited[right]) { visited[right] = 1; stack.push(right); }
        if (iy > minY && mask[up] && !visited[up]) { visited[up] = 1; stack.push(up); }
        if (iy < maxY && mask[down] && !visited[down]) { visited[down] = 1; stack.push(down); }
      }

      const bw = bx1 - bx0 + 1;
      const bh = by1 - by0 + 1;
      const fill = area / (bw * bh);
      const aspect = Math.max(bw / bh, bh / bw);

      comps.push({ area, cx: sumX / area, cy: sumY / area, bx0, by0, bx1, by1, bw, bh, fill, aspect });
    }
  }
  return comps;
}

// Outlier rejection: keep kMax closest to mean (tightest cluster)
function pickTightest(points, kMax) {
  if (points.length <= kMax) return points;
  const mx = points.reduce((a, p) => a + p.cx, 0) / points.length;
  const my = points.reduce((a, p) => a + p.cy, 0) / points.length;

  return points
    .map((p) => ({ p, d2: (p.cx - mx) ** 2 + (p.cy - my) ** 2 }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, kMax)
    .map((x) => x.p);
}

// ---------- routes ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, build: BUILD_TAG, routes: ["GET /", "GET /api/health", "POST /api/sec"] });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    build: BUILD_TAG,
    routes: ["GET /", "GET /api/health", "POST /api/sec"],
    config: {
      DISTANCE_YARDS: CONFIG.DISTANCE_YARDS,
      MOA_PER_CLICK: CONFIG.MOA_PER_CLICK,
      TARGET_WIDTH_IN: CONFIG.TARGET_WIDTH_IN,
      MIN_SHOTS: CONFIG.MIN_SHOTS,
      MAX_SHOTS: CONFIG.MAX_SHOTS,
      MAX_ABS_CLICKS: CONFIG.MAX_ABS_CLICKS,
    },
  });
});

app.post(
  "/api/sec",
  upload.fields([{ name: "image", maxCount: 1 }, { name: "file", maxCount: 1 }]),
  async (req, res) => {
    const started = Date.now();

    try {
      const f = req.files?.image?.[0] || req.files?.file?.[0] || null;

      if (!f?.buffer) {
        return res.status(400).json({
          ok: false,
          error: "NO_FILE",
          message: 'No file uploaded. Expected field "image" (or legacy "file").',
          build: BUILD_TAG,
        });
      }

      if (!f.mimetype?.startsWith("image/")) {
        return res.status(400).json({
          ok: false,
          error: "NOT_IMAGE",
          message: `Upload must be an image. Got mimetype: ${f.mimetype}`,
          build: BUILD_TAG,
        });
      }

      // normalize + resize + grayscale raw
      const img = sharp(f.buffer).rotate();
      const meta = await img.metadata();

      const { data, info } = await img
        .resize({ width: CONFIG.MAX_W, withoutEnlargement: true })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const w = info.width;
      const h = info.height;

      const inkBox = findBBoxNotWhite(data, w, h, 235);
      if (!inkBox || inkBox.width < 200 || inkBox.height < 200) {
        return res.status(422).json({
          ok: false,
          error: "NO_TARGET",
          message: "Could not find target region. Make sure the full target is in frame with decent lighting.",
          build: BUILD_TAG,
        });
      }

      // pad bbox + force square crop
      const padX = Math.round(inkBox.width * CONFIG.INK_PAD_PCT);
      const padY = Math.round(inkBox.height * CONFIG.INK_PAD_PCT);

      let minX = clamp(inkBox.minX - padX, 0, w - 1);
      let minY = clamp(inkBox.minY - padY, 0, h - 1);
      let maxX = clamp(inkBox.maxX + padX, 0, w - 1);
      let maxY = clamp(inkBox.maxY + padY, 0, h - 1);

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const side = Math.min(bw, bh);

      const cx = minX + bw / 2;
      const cy = minY + bh / 2;

      minX = clamp(Math.round(cx - side / 2), 0, w - side);
      minY = clamp(Math.round(cy - side / 2), 0, h - side);
      maxX = minX + side - 1;
      maxY = minY + side - 1;

      const region = { minX, minY, maxX, maxY, width: side, height: side };
      const targetCx = minX + side / 2;
      const targetCy = minY + side / 2;

      // Otsu threshold in region
      const regionGray = new Uint8Array(region.width * region.height);
      let k = 0;
      for (let y = minY; y <= maxY; y++) {
        const row = y * w;
        for (let x = minX; x <= maxX; x++) regionGray[k++] = data[row + x];
      }

      let t = otsuThreshold(regionGray);
      t = clamp(t, CONFIG.OTSU_MIN, CONFIG.OTSU_MAX);

      // dark-pixel mask
      const mask = new Uint8Array(w * h);
      for (let y = minY; y <= maxY; y++) {
        const row = y * w;
        for (let x = minX; x <= maxX; x++) {
          const i = row + x;
          mask[i] = data[i] < t ? 1 : 0;
        }
      }

      const comps = connectedComponents(mask, w, h, region);

      const targetArea = region.width * region.height;
      const minArea = Math.round(targetArea * CONFIG.MIN_AREA_PCT);
      const maxArea = Math.round(targetArea * CONFIG.MAX_AREA_PCT);
      const margin = Math.max(8, Math.round(region.width * 0.01));

      const candidates = comps.filter((c) => {
        if (c.area < minArea || c.area > maxArea) return false;
        if (c.aspect > CONFIG.MAX_ASPECT) return false;
        if (c.fill < CONFIG.MIN_FILL) return false;
        if (c.bx0 <= minX + margin) return false;
        if (c.by0 <= minY + margin) return false;
        if (c.bx1 >= maxX - margin) return false;
        if (c.by1 >= maxY - margin) return false;
        return true;
      });

      if (candidates.length < CONFIG.MIN_SHOTS) {
        return res.status(422).json({
          ok: false,
          error: "NO_HOLES",
          message: `Not enough shots detected (${candidates.length}). Need at least ${CONFIG.MIN_SHOTS}.`,
          debug: { threshold: t, candidates: candidates.length },
          build: BUILD_TAG,
        });
      }

      const cluster = pickTightest(candidates, Math.min(CONFIG.MAX_SHOTS, candidates.length));

      const poiX = cluster.reduce((a, p) => a + p.cx, 0) / cluster.length;
      const poiY = cluster.reduce((a, p) => a + p.cy, 0) / cluster.length;

      // offsets from target center (+right, +down)
      const dxPx = poiX - targetCx;
      const dyPx = poiY - targetCy;

      // px -> inches
      const inchPerPx = CONFIG.TARGET_WIDTH_IN / region.width;
      const dxIn = dxPx * inchPerPx; // +right
      const dyIn = dyPx * inchPerPx; // +down

      // inches -> MOA
      const inPerMoa = inchesPerMOA(CONFIG.DISTANCE_YARDS);
      const windMoa = dxIn / inPerMoa; // +right impacts
      const elevMoa = dyIn / inPerMoa; // +down impacts

      // DIAL_TO_CENTER: impacts right => dial left (negative wind clicks), impacts low => dial up (positive elev clicks)
      let windClicks = -(windMoa / CONFIG.MOA_PER_CLICK);
      let elevClicks = +(elevMoa / CONFIG.MOA_PER_CLICK);

      windClicks = clamp(windClicks, -CONFIG.MAX_ABS_CLICKS, CONFIG.MAX_ABS_CLICKS);
      elevClicks = clamp(elevClicks, -CONFIG.MAX_ABS_CLICKS, CONFIG.MAX_ABS_CLICKS);

      return res.json({
        ok: true,
        build: BUILD_TAG,
        units: "CLICKS",
        convention: "DIAL_TO_CENTER",
        sec: {
          windage_clicks: to2(windClicks),
          elevation_clicks: to2(elevClicks),
        },
        meta: {
          ms: Date.now() - started,
          shots_used: cluster.length,
          input: {
            originalname: f.originalname,
            mimetype: f.mimetype,
            size: f.size,
            w: meta?.width ?? null,
            h: meta?.height ?? null,
          },
        },
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: "SEC_500",
        message: "SEC processing failed in backend.",
        build: BUILD_TAG,
        detail: safeError(err),
      });
    }
  }
);

// 404 JSON
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND",
    message: `Not found: ${req.method} ${req.path}`,
    build: BUILD_TAG,
  });
});

// Final JSON error handler (prevents HTML error pages)
app.use((err, _req, res, _next) => {
  res.status(500).json({
    ok: false,
    error: "UNHANDLED_500",
    message: "Unhandled server error.",
    build: BUILD_TAG,
    detail: safeError(err),
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`SCZN3 SEC backend listening on ${PORT} (${BUILD_TAG})`));
