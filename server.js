// server.js — SCZN3 SEC Backend (BULL-LOCKED DIRECTIONS)
// Always returns JSON
// POST /api/sec  (multipart form-data field: "image")

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "BULL_LOCKED_V2";
const SERVICE_NAME = "sczn3-sec-backend-pipe";

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// CORS (browser safe)
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

// Always JSON (avoid HTML error pages)
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

function jsonFail(res, status, payload) {
  res.status(status).send(JSON.stringify(payload, null, 2));
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
  const y = Number(yards);
  if (!Number.isFinite(y) || y <= 0) return NaN;
  return 1.047 * (y / 100);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function safeNum(v, fallback) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

// Accepts: "8.5x11", "8.5 x 11", "11" (means 8.5x11), "23" (means 23x23)
function parseTargetSpec(specRaw) {
  const s = String(specRaw ?? "").trim().toLowerCase();

  if (!s) {
    return { ok: false, reason: "targetSizeSpec required (ex: 8.5x11 or 11 or 23)" };
  }

  const cleaned = s.replace(/\s+/g, "");
  if (cleaned.includes("x")) {
    const parts = cleaned.split("x").map((p) => Number(p));
    if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
      return { ok: false, reason: `Invalid targetSizeSpec: ${specRaw}` };
    }
    const w = parts[0];
    const h = parts[1];
    if (w <= 0 || h <= 0) return { ok: false, reason: `Invalid targetSizeSpec: ${specRaw}` };
    return { ok: true, widthIn: w, heightIn: h, normalizedSpec: `${w}x${h}` };
  }

  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, reason: `Invalid targetSizeSpec: ${specRaw}` };
  }

  // Your UI uses "11" as shorthand for 8.5x11
  if (n === 11) {
    return { ok: true, widthIn: 8.5, heightIn: 11, normalizedSpec: "8.5x11" };
  }

  // Square shorthand (ex: "23" => 23x23)
  return { ok: true, widthIn: n, heightIn: n, normalizedSpec: `${n}x${n}` };
}

// Very simple bullet-hole finder (works on clean grid photos)
// - resizes for speed
// - grayscale
// - thresholds for dark blobs
// - connected components => centroids
async function detectHoles(buffer) {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) {
    return { ok: false, reason: "Could not read image metadata." };
  }

  const maxDim = 1400;
  const scale = Math.min(1, maxDim / Math.max(meta.width, meta.height));
  const outW = Math.max(1, Math.round(meta.width * scale));
  const outH = Math.max(1, Math.round(meta.height * scale));

  const { data, info } = await sharp(buffer)
    .rotate() // respect EXIF
    .resize(outW, outH, { fit: "inside" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;

  // threshold (tuned for typical phone photos)
  const thr = 70;

  // binary mask: 1 = dark
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    mask[i] = data[i] < thr ? 1 : 0;
  }

  // connected components
  const visited = new Uint8Array(w * h);
  const holes = [];

  const idx = (x, y) => y * w + x;

  const minArea = 25;
  const maxArea = 5000;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = idx(x, y);
      if (!mask[k] || visited[k]) continue;

      // BFS stack
      let stack = [[x, y]];
      visited[k] = 1;

      let area = 0;
      let sumX = 0;
      let sumY = 0;

      let minX = x,
        maxX = x,
        minY = y,
        maxY = y;

      while (stack.length) {
        const [cx, cy] = stack.pop();
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
            if (nx <= 0 || nx >= w - 1 || ny <= 0 || ny >= h - 1) continue;
            const nk = idx(nx, ny);
            if (!mask[nk] || visited[nk]) continue;
            visited[nk] = 1;
            stack.push([nx, ny]);
          }
        }

        // cap runaway blobs
        if (area > maxArea * 3) {
          stack = [];
          break;
        }
      }

      if (area < minArea || area > maxArea) continue;

      const bboxW = maxX - minX + 1;
      const bboxH = maxY - minY + 1;

      // reject long grid-line fragments
      const aspect = bboxW > bboxH ? bboxW / bboxH : bboxH / bboxW;
      if (aspect > 5) continue;

      holes.push({
        cx: sumX / area,
        cy: sumY / area,
        area,
        bboxW,
        bboxH,
      });
    }
  }

  // keep the biggest blobs only (prevents grid noise dominating)
  holes.sort((a, b) => b.area - a.area);
  const trimmed = holes.slice(0, 30);

  return {
    ok: true,
    normalized: { width: w, height: h },
    holesDetected: trimmed.length,
    holes: trimmed,
  };
}

// ============================================================
// BULL-LOCKED DIRECTION + CLICK MATH (DETERMINISTIC)
// NO quadrant guessing. Always "move group to bull":
// - if group is LEFT of bull => dial RIGHT
// - if group is RIGHT of bull => dial LEFT
// - if group is ABOVE bull => dial DOWN
// - if group is BELOW bull => dial UP
// ============================================================
function computeBullLocked({ holes, normalized, widthIn, heightIn, distanceYards, clickValueMoa }) {
  const wPx = normalized.width;
  const hPx = normalized.height;

  // px -> inches (origin: top-left). y increases DOWN.
  const mapPxToIn = (p) => ({
    xIn: (p.x / wPx) * widthIn,
    yIn: (p.y / hPx) * heightIn,
  });

  // bull is always center unless you change it
  const bull = { x: widthIn / 2, y: heightIn / 2 };

  // group center in pixels
  let sx = 0;
  let sy = 0;
  for (const h of holes) {
    sx += h.cx;
    sy += h.cy;
  }
  const groupCenterPx = { x: sx / holes.length, y: sy / holes.length };
  const groupCenterIn = mapPxToIn(groupCenterPx);

  // correction inches (bull - group) in the SAME inches coordinate (y down)
  const dxIn = bull.x - groupCenterIn.xIn; // + => need RIGHT
  const dyIn = bull.y - groupCenterIn.yIn; // + => group is ABOVE bull => need DOWN

  // POIB inches using your convention:
  // Right + / Left - ; Up + / Down -
  const poibX = groupCenterIn.xIn - bull.x; // right positive
  const poibY = bull.y - groupCenterIn.yIn; // above positive (Up +)

  const ipm = inchesPerMoaAtYards(distanceYards);
  const inchesPerClick = ipm * clickValueMoa;

  const windageClicksSigned = inchesPerClick ? round2(dxIn / inchesPerClick) : 0; // + RIGHT
  const elevationClicksSigned = inchesPerClick ? round2((-dyIn) / inchesPerClick) : 0; // + UP, - DOWN

  const windDir =
    windageClicksSigned > 0 ? "RIGHT" : windageClicksSigned < 0 ? "LEFT" : "CENTER";
  const elevDir =
    elevationClicksSigned > 0 ? "UP" : elevationClicksSigned < 0 ? "DOWN" : "CENTER";

  return {
    bull: { xIn: round2(bull.x), yIn: round2(bull.y) },
    groupCenter: { xIn: round2(groupCenterIn.xIn), yIn: round2(groupCenterIn.yIn) },
    poibInches: { x: round2(poibX), y: round2(poibY) },
    clicksSigned: { w: windageClicksSigned, e: elevationClicksSigned },
    dial: {
      windage: { dir: windDir, clicks: fmt2(Math.abs(windageClicksSigned)) },
      elevation: { dir: elevDir, clicks: fmt2(Math.abs(elevationClicksSigned)) },
    },
  };
}

// Health
app.get("/", (req, res) => {
  res.status(200).send(
    JSON.stringify(
      { ok: true, service: SERVICE_NAME, status: "alive", build: BUILD_TAG },
      null,
      2
    )
  );
});

// Nice message if someone hits it in browser
app.get("/api/sec", (req, res) => {
  res.status(405).send(JSON.stringify({ ok: false, error: "Use POST /api/sec" }, null, 2));
});

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return jsonFail(res, 400, {
        ok: false,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        error: { code: "NO_IMAGE", message: "Missing multipart field: image" },
      });
    }

    const distanceYards = safeNum(req.body?.distanceYards, 100);
    const clickValueMoa = safeNum(req.body?.clickValueMoa, 0.25);
    const targetSizeSpec = String(req.body?.targetSizeSpec ?? "").trim();

    const parsed = parseTargetSpec(targetSizeSpec);
    if (!parsed.ok) {
      return jsonFail(res, 400, {
        ok: false,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        error: { code: "BAD_TARGET_SPEC", message: parsed.reason },
      });
    }

    const widthIn = parsed.widthIn;
    const heightIn = parsed.heightIn;

    const detect = await detectHoles(req.file.buffer);
    if (!detect.ok) {
      return jsonFail(res, 422, {
        ok: false,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        received: {
          originalName: req.file.originalname,
          bytes: req.file.size,
          mimetype: req.file.mimetype,
        },
        sec: {
          distanceYards,
          clickValueMoa,
          targetSizeSpec: targetSizeSpec || null,
          widthIn,
          heightIn,
          targetSizeInches: Math.max(widthIn, heightIn), // numeric echo for UI congruence
        },
        computeStatus: "FAILED_DETECT",
        error: { code: "DETECT_FAILED", message: detect.reason },
      });
    }

    if (!detect.holes || detect.holes.length < 1) {
      return jsonFail(res, 422, {
        ok: false,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        received: {
          originalName: req.file.originalname,
          bytes: req.file.size,
          mimetype: req.file.mimetype,
        },
        sec: {
          distanceYards,
          clickValueMoa,
          targetSizeSpec: targetSizeSpec || null,
          widthIn,
          heightIn,
          targetSizeInches: Math.max(widthIn, heightIn), // numeric echo for UI congruence
        },
        computeStatus: "FAILED_HOLES",
        error: { code: "HOLES_NOT_FOUND", message: "No bullet holes detected." },
        detect,
      });
    }

    const bullLocked = computeBullLocked({
      holes: detect.holes,
      normalized: detect.normalized,
      widthIn,
      heightIn,
      distanceYards,
      clickValueMoa,
    });

    // minimal response fields your UI already expects
    return res.status(200).send(
      JSON.stringify(
        {
          ok: true,
          service: SERVICE_NAME,
          build: BUILD_TAG,
          received: {
            originalName: req.file.originalname,
            bytes: req.file.size,
            mimetype: req.file.mimetype,
          },
          sec: {
            distanceYards,
            clickValueMoa,
            targetSizeSpec: targetSizeSpec || null,
            widthIn,
            heightIn,
            targetSizeInches: Math.max(widthIn, heightIn), // <-- fixes BACKEND_MISSING_TARGET_SIZE
          },
          computeStatus: "COMPUTED_FROM_IMAGE",
          detect: {
            normalized: detect.normalized,
            holesDetected: detect.holesDetected,
            holes: detect.holes,
          },
          bullLocked,
          // keep backward-friendly keys
          poibInches: bullLocked.poibInches,
          clicksSigned: bullLocked.clicksSigned,
          dial: {
            windage: `${bullLocked.dial.windage.dir} ${bullLocked.dial.windage.clicks} clicks`,
            elevation: `${bullLocked.dial.elevation.dir} ${bullLocked.dial.elevation.clicks} clicks`,
          },
        },
        null,
        2
      )
    );
  } catch (err) {
    return jsonFail(res, 500, {
      ok: false,
      service: SERVICE_NAME,
      build: BUILD_TAG,
      error: { code: "SERVER_ERROR", message: String(err?.message || err) },
    });
  }
});

// hard JSON error handler
app.use((err, req, res, next) => {
  jsonFail(res, 500, {
    ok: false,
    service: SERVICE_NAME,
    build: BUILD_TAG,
    error: { code: "EXPRESS_ERROR", message: String(err?.message || err) },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[${SERVICE_NAME}] listening on ${PORT} build=${BUILD_TAG}`);
});
