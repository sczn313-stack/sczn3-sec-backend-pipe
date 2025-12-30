// server.js — SCZN3 SEC Backend (Bull-locked logic)
// - Always returns JSON
// - POST /api/sec (multipart form-data field: "image")
// - Bull = target center (width/2, height/2)
// - One and only one Y flip at POIB creation
// - Correction = bull - POIB  (what to dial)
// - Dial directions derived ONLY from correction sign

import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";

const BUILD_TAG = "BULL_LOCKED_V1";
const SERVICE_NAME = "sczn3-sec-backend-pipe";

const app = express();
app.use(cors({ origin: true, credentials: false }));

// Always JSON (avoid HTML error pages)
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

const upload = multer({ storage: multer.memoryStorage() });

// -----------------------------
// Helpers
// -----------------------------
function n(x, def = NaN) {
  const v = Number(x);
  return Number.isFinite(v) ? v : def;
}
function round2(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}
function fmt2(x) {
  return round2(x).toFixed(2);
}

// TRUE MOA: 1 MOA = 1.047" @ 100y
function inchesPerMoaAtYards(yards) {
  const y = n(yards, NaN);
  if (!Number.isFinite(y) || y <= 0) return NaN;
  return 1.047 * (y / 100);
}

// Parse target size
// Accepts: "11", "8.5x11", "8.5×11", "23"
function parseTargetSpec(raw) {
  const s = String(raw ?? "").trim().toLowerCase().replaceAll("×", "x");
  if (!s) return { ok: false, reason: "EMPTY" };

  // If user sends just "11" (meaning 8.5x11)
  if (s === "11" || s === "8.5x11" || s === "8.5 x 11" || s === "8.5*11") {
    return { ok: true, kind: "LETTER", widthIn: 8.5, heightIn: 11.0, longIn: 11.0, shortIn: 8.5 };
  }

  // Square 23x23
  if (s === "23" || s === "23x23" || s === "23 x 23") {
    return { ok: true, kind: "SQUARE_23", widthIn: 23.0, heightIn: 23.0, longIn: 23.0, shortIn: 23.0 };
  }

  // Generic WxH
  const m = s.match(/^(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)$/);
  if (m) {
    const a = n(m[1], NaN);
    const b = n(m[3], NaN);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
      return { ok: false, reason: "BAD_DIMS" };
    }
    const longIn = Math.max(a, b);
    const shortIn = Math.min(a, b);
    // Keep orientation as provided: width=a, height=b
    return { ok: true, kind: "CUSTOM", widthIn: a, heightIn: b, longIn, shortIn };
  }

  return { ok: false, reason: "UNSUPPORTED_SPEC", detail: s };
}

// Convert pixel (cx,cy) to inches in target space (origin top-left, y down)
function pxToIn(cx, cy, imgW, imgH, widthIn, heightIn) {
  return {
    xIn: (cx / imgW) * widthIn,
    yIn: (cy / imgH) * heightIn,
  };
}

// Dial direction from correction sign (LOCKED)
// correctionX > 0 => RIGHT, < 0 => LEFT
// correctionY > 0 => UP,    < 0 => DOWN
function dialFromCorrection(clicksX, clicksY) {
  const wx = n(clicksX, 0);
  const wy = n(clicksY, 0);

  const wDir = wx > 0 ? "RIGHT" : wx < 0 ? "LEFT" : "CENTER";
  const eDir = wy > 0 ? "UP" : wy < 0 ? "DOWN" : "LEVEL";

  return {
    windage: `${wDir} ${fmt2(Math.abs(wx))} clicks`,
    elevation: `${eDir} ${fmt2(Math.abs(wy))} clicks`,
  };
}

// -----------------------------
// Simple hole detection (for your clean grid test targets)
// - Finds connected dark blobs
// - Filters out corners + QR region + too-large blobs
// -----------------------------
function detectHolesFromGrayscale(raw, w, h) {
  // Threshold for "dark"
  const DARK_T = 85; // lower = stricter; adjust if needed
  const visited = new Uint8Array(w * h);

  function idx(x, y) {
    return y * w + x;
  }
  function isDark(i) {
    return raw[i] < DARK_T;
  }

  const holes = [];

  // Exclusion zones (skip obvious non-holes)
  const edgePad = Math.floor(Math.min(w, h) * 0.05); // 5% border
  const qrX0 = Math.floor(w * 0.72);
  const qrY0 = Math.floor(h * 0.72);

  const MIN_AREA = 25;      // tiny noise
  const MAX_AREA = 2500;    // excludes fiducials and big blocks

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y);
      if (visited[i]) continue;
      visited[i] = 1;

      // skip excluded zones
      if (x < edgePad || x > w - edgePad || y < edgePad || y > h - edgePad) continue;
      if (x >= qrX0 && y >= qrY0) continue;

      if (!isDark(i)) continue;

      // Flood fill component
      let qx = [x];
      let qy = [y];
      let qi = 0;

      let area = 0;
      let sumX = 0;
      let sumY = 0;

      let minX = x, maxX = x, minY = y, maxY = y;

      while (qi < qx.length) {
        const cx = qx[qi];
        const cy = qy[qi];
        qi++;

        const ci = idx(cx, cy);

        // Count pixel
        area++;
        sumX += cx;
        sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 4-neighbors
        const nbrs = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];

        for (const [nx, ny] of nbrs) {
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = idx(nx, ny);
          if (visited[ni]) continue;
          visited[ni] = 1;
          if (!isDark(ni)) continue;
          qx.push(nx);
          qy.push(ny);
        }

        // Early stop if huge
        if (area > MAX_AREA) break;
      }

      if (area < MIN_AREA || area > MAX_AREA) continue;

      const bboxW = maxX - minX + 1;
      const bboxH = maxY - minY + 1;

      // Reject long skinny things (grid lines)
      const aspect = Math.max(bboxW, bboxH) / Math.max(1, Math.min(bboxW, bboxH));
      if (aspect > 6) continue;

      const cx = sumX / area;
      const cy = sumY / area;

      holes.push({ cx, cy, area, bboxW, bboxH });
    }
  }

  return holes;
}

// -----------------------------
// Routes
// -----------------------------
app.get("/", (req, res) => {
  res.status(200).send(JSON.stringify({ ok: true, service: SERVICE_NAME, status: "alive", build: BUILD_TAG }));
});

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const distanceYards = n(req.body?.distanceYards ?? req.body?.distance ?? 100, 100);
    const clickValueMoa = n(req.body?.clickValueMoa ?? req.body?.clickValue ?? 0.25, 0.25);

    // Frontend may send "targetSizeInches" as 11 (meaning 8.5x11) OR "8.5x11"
    const targetSpecRaw = req.body?.targetSizeSpec ?? req.body?.targetSizeInches ?? req.body?.targetSize ?? "11";
    const spec = parseTargetSpec(targetSpecRaw);

    if (!spec.ok) {
      return res.status(400).send(
        JSON.stringify({
          ok: false,
          service: SERVICE_NAME,
          build: BUILD_TAG,
          error: { code: "BAD_TARGET_SPEC", message: "Unsupported target size spec", detail: spec },
        })
      );
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).send(
        JSON.stringify({
          ok: false,
          service: SERVICE_NAME,
          build: BUILD_TAG,
          error: { code: "NO_IMAGE", message: "No file uploaded. Use multipart field name: image" },
        })
      );
    }

    // Normalize image size for stable detection
    const input = sharp(req.file.buffer).rotate();

    const meta = await input.metadata();
    const maxW = 1400;
    const maxH = 1800;

    const resized = input.resize({
      width: meta.width && meta.width > maxW ? maxW : undefined,
      height: meta.height && meta.height > maxH ? maxH : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });

    // Grayscale raw buffer
    const { data, info } = await resized
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const imgW = info.width;
    const imgH = info.height;

    const holes = detectHolesFromGrayscale(data, imgW, imgH);

    if (!holes.length) {
      return res.status(200).send(
        JSON.stringify({
          ok: true,
          service: SERVICE_NAME,
          build: BUILD_TAG,
          computeStatus: "FAILED_HOLES",
          error: { code: "HOLES_NOT_FOUND", message: "No bullet holes detected. Use a clean photo on the grid bull target." },
          detect: {
            normalized: { width: imgW, height: imgH },
            holesDetected: 0,
          },
          sec: { distanceYards, clickValueMoa, targetSizeSpec: targetSpecRaw, widthIn: spec.widthIn, heightIn: spec.heightIn },
        })
      );
    }

    // Group center = average of hole centroids (in pixels)
    let sx = 0, sy = 0;
    for (const h of holes) {
      sx += h.cx;
      sy += h.cy;
    }
    const groupCenterPx = { x: sx / holes.length, y: sy / holes.length };

    // Map group center to inches (origin top-left, y down)
    const groupIn = pxToIn(groupCenterPx.x, groupCenterPx.y, imgW, imgH, spec.widthIn, spec.heightIn);

    // Bull is exact center of the target (in inches)
    const bull = { x: spec.widthIn / 2, y: spec.heightIn / 2 };

    // POIB inches (SCZN3 convention):
    // X: Right + / Left -
    // Y: Up + / Down -
    //
    // Image Y grows DOWN, so we flip ONCE here:
    // poibY = bullY - groupY
    const poib = {
      x: groupIn.xIn - bull.x,
      y: bull.y - groupIn.yIn,
    };

    // Correction inches to move POIB to bull:
    // correction = bull - POIB  (equivalent to -POIB in this coordinate system)
    const corrIn = {
      x: -poib.x,
      y: -poib.y,
    };

    const inchesPerMoa = inchesPerMoaAtYards(distanceYards);
    const inchesPerClick = inchesPerMoa * clickValueMoa;

    if (!Number.isFinite(inchesPerClick) || inchesPerClick <= 0) {
      return res.status(400).send(
        JSON.stringify({
          ok: false,
          service: SERVICE_NAME,
          build: BUILD_TAG,
          error: { code: "BAD_SCOPE_PARAMS", message: "Bad distanceYards or clickValueMoa" },
        })
      );
    }

    // Signed correction clicks (what to dial)
    const clicksSigned = {
      windage: round2(corrIn.x / inchesPerClick),
      elevation: round2(corrIn.y / inchesPerClick),
    };

    const dial = dialFromCorrection(clicksSigned.windage, clicksSigned.elevation);

    return res.status(200).send(
      JSON.stringify({
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
          targetSizeSpec: targetSpecRaw,
          widthIn: spec.widthIn,
          heightIn: spec.heightIn,
        },
        computeStatus: "COMPUTED_FROM_IMAGE",
        detect: {
          normalized: { width: imgW, height: imgH },
          holesDetected: holes.length,
          holes: holes.slice(0, 20), // cap
          groupCenterPx,
          groupCenterIn: { x: round2(groupIn.xIn), y: round2(groupIn.yIn) },
          bullIn: { x: round2(bull.x), y: round2(bull.y) },
        },
        poibInches: { x: round2(poib.x), y: round2(poib.y) },
        correctionInches: { x: round2(corrIn.x), y: round2(corrIn.y) },
        clicksSigned,
        dial,
      })
    );
  } catch (e) {
    return res.status(500).send(
      JSON.stringify({
        ok: false,
        service: SERVICE_NAME,
        build: BUILD_TAG,
        error: { code: "SERVER_ERROR", message: String(e?.message || e) },
      })
    );
  }
});

// Render port
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[${SERVICE_NAME}] listening on :${PORT} build=${BUILD_TAG}`);
});
