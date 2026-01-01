/* server.js (CommonJS) */
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const sharp = require("sharp");

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const upload = multer({ storage: multer.memoryStorage() });

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function parseNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sizeFromSpec(spec) {
  const map = {
    "8.5x11": { widthIn: 8.5, heightIn: 11 },
    "11x17": { widthIn: 11, heightIn: 17 },
    "23x23": { widthIn: 23, heightIn: 23 },
  };
  return map[String(spec || "").trim()] || map["8.5x11"];
}

function poibFromHoles(holes) {
  const n = holes.length;
  const sx = holes.reduce((a, h) => a + h.x, 0);
  const sy = holes.reduce((a, h) => a + h.y, 0);
  return { x: sx / n, y: sy / n };
}

function quadFromPoib(poib, bull) {
  const left = poib.x < bull.x;
  const upper = poib.y < bull.y; // y-down space: smaller y is UP
  if (upper && left) return "UL";
  if (upper && !left) return "UR";
  if (!upper && left) return "LL";
  return "LR";
}

function inchesPerMOA(distanceYards) {
  // True MOA: 1.047" at 100y
  return 1.047 * (distanceYards / 100);
}

function computeClicks({ bull, poib, distanceYards, clickValueMoa }) {
  const dxIn = bull.x - poib.x;
  const dyIn = bull.y - poib.y; // y-down system

  const ipm = inchesPerMOA(distanceYards);

  const dxMoa = Math.abs(dxIn) / ipm;
  const dyMoa = Math.abs(dyIn) / ipm;

  const windClicks = dxMoa / clickValueMoa;
  const elevClicks = dyMoa / clickValueMoa;

  const windDir = dxIn > 0 ? "RIGHT" : dxIn < 0 ? "LEFT" : "NONE";
  // y-down: dyIn > 0 means bull is lower => move DOWN
  const elevDir = dyIn > 0 ? "DOWN" : dyIn < 0 ? "UP" : "NONE";

  // signed convention: + = RIGHT / UP ; - = LEFT / DOWN
  const windSigned = dxIn > 0 ? windClicks : dxIn < 0 ? -windClicks : 0;
  const elevSigned = dyIn < 0 ? elevClicks : dyIn > 0 ? -elevClicks : 0;

  return {
    dxIn: round2(dxIn),
    dyIn: round2(dyIn),
    scopeClicks: {
      windage: windDir === "NONE" ? "NONE 0.00 clicks" : `${windDir} ${round2(windClicks).toFixed(2)} clicks`,
      elevation: elevDir === "NONE" ? "NONE 0.00 clicks" : `${elevDir} ${round2(elevClicks).toFixed(2)} clicks`,
    },
    clicksSigned: {
      windage: round2(windSigned),
      elevation: round2(elevSigned),
    },
  };
}

/**
 * Very simple hole detection:
 * - convert to grayscale
 * - threshold for dark pixels
 * - connected-component grouping (8-neighbor)
 * - returns centroids in INCHES based on target size
 *
 * This is intentionally "simple + deterministic" for now.
 */
async function detectHolesFromImage(buffer, targetSizeSpec) {
  const { widthIn, heightIn } = sizeFromSpec(targetSizeSpec);

  const img = sharp(buffer).rotate(); // respect EXIF orientation
  const meta = await img.metadata();
  const w = meta.width;
  const h = meta.height;
  if (!w || !h) return [];

  // grayscale raw pixels
  const raw = await img
    .resize({ width: w, height: h, fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();

  const threshold = 60; // dark pixel threshold (0-255)
  const minArea = 35;   // tune if needed
  const maxArea = 5000; // tune if needed

  const visited = new Uint8Array(w * h);
  const holes = [];

  function idx(x, y) {
    return y * w + x;
  }

  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1],
  ];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (visited[i]) continue;

      const px = raw[i];
      const isDark = px < threshold;
      if (!isDark) {
        visited[i] = 1;
        continue;
      }

      // flood fill
      let area = 0;
      let sumX = 0;
      let sumY = 0;

      const stack = [[x, y]];
      visited[i] = 1;

      while (stack.length) {
        const [cx, cy] = stack.pop();
        const ci = idx(cx, cy);

        if (raw[ci] >= threshold) continue;

        area++;
        sumX += cx;
        sumY += cy;

        for (const [dx, dy] of neighbors) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = idx(nx, ny);
          if (visited[ni]) continue;
          visited[ni] = 1;
          // push regardless; we’ll threshold-check when popping
          stack.push([nx, ny]);
        }
      }

      if (area >= minArea && area <= maxArea) {
        const cx = sumX / area;
        const cy = sumY / area;

        // convert pixel -> inches
        const xIn = (cx / w) * widthIn;
        const yIn = (cy / h) * heightIn;

        holes.push({ x: round2(xIn), y: round2(yIn) });
      }
    }
  }

  // If too many blobs (noise), keep the biggest-ish by simple heuristic:
  // (since we didn’t store area per blob here, just return as-is for now)
  return holes;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "sczn3-sec-backend-pipe", status: "alive" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "sczn3-sec-backend-pipe", build: "POIB_TO_BULL_YDOWN_LOCKED_V4", yAxisUsed: "down", status: "alive" });
});

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    // inputs
    const targetSizeSpec = req.body?.targetSizeSpec || "8.5x11";
    const distanceYards = parseNum(req.body?.distanceYards, 100);
    const clickValueMoa = parseNum(req.body?.clickValueMoa, 0.25);
    const deadbandIn = parseNum(req.body?.deadbandIn, 0.1);
    const bull = {
      x: parseNum(req.body?.bullX, 4.25),
      y: parseNum(req.body?.bullY, 5.5),
    };

    // holes source priority: image -> holesJson/holes[]
    let holes = [];

    if (req.file?.buffer) {
      holes = await detectHolesFromImage(req.file.buffer, targetSizeSpec);
    } else if (Array.isArray(req.body?.holes)) {
      holes = req.body.holes;
    } else if (typeof req.body?.holesJson === "string") {
      try {
        const v = JSON.parse(req.body.holesJson);
        if (Array.isArray(v)) holes = v;
      } catch {}
    }

    // sanitize holes
    holes = (holes || [])
      .map((h) => ({ x: Number(h.x), y: Number(h.y) }))
      .filter((h) => Number.isFinite(h.x) && Number.isFinite(h.y));

    if (!holes.length) {
      return res.status(400).json({
        ok: false,
        build: "POIB_TO_BULL_YDOWN_LOCKED_V4",
        error: { code: "NO_HOLES", message: "No holes detected in image (or provided). Use a clearer photo or increase contrast." },
        debug: { yAxisUsed: "down", targetSizeSpec, distanceYards, clickValueMoa, deadbandIn, bull },
      });
    }

    const poib = poibFromHoles(holes);
    const poibQuad = quadFromPoib(poib, bull);

    const calc = computeClicks({ bull, poib, distanceYards, clickValueMoa });

    return res.json({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: "POIB_TO_BULL_YDOWN_LOCKED_V4",
      scopeClicks: calc.scopeClicks,
      clicksSigned: calc.clicksSigned,
      debug: {
        yAxisUsed: "down",
        targetSizeSpec,
        targetSizeInches: sizeFromSpec(targetSizeSpec),
        distanceYards,
        clickValueMoa,
        inchesPerMOA: round2(inchesPerMOA(distanceYards)),
        bull,
        poib: { x: round2(poib.x), y: round2(poib.y) },
        poibQuad,
        holesUsedCount: holes.length,
        dxIn: calc.dxIn,
        dyIn: calc.dyIn,
        note: "Convention locked: correction = bull - POIB. Y axis is DOWN (image/canvas). dy>0 => DOWN, dy<0 => UP.",
      },
      holes, // (keep for debug; remove later if you want)
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      build: "POIB_TO_BULL_YDOWN_LOCKED_V4",
      error: { code: "SERVER_ERROR", message: String(e?.message || e) },
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SEC backend running on ${PORT}`));
