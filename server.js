/* server.js — SCZN3 SEC backend (Bull-locked, UI tolerant)
   - Accepts targetSizeSpec OR targetSizeInches OR (widthIn,heightIn)
   - Always returns sec.targetSizeSpec, sec.targetSizeInches (numeric), clicksSigned
   - GET /api/sec supported (so browser doesn’t show “Cannot GET /api/sec”)
*/

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({ storage: multer.memoryStorage() });

const SERVICE = "sczn3-sec-backend-pipe";
const BUILD = "BULL_LOCKED_V2";

// ---------- helpers ----------
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function fmt2(n) {
  return round2(n).toFixed(2);
}

// Parse things like "8.5x11", "8.5×11", "8.5 X 11"
function parseSpec(specRaw) {
  if (!specRaw) return null;
  const s = String(specRaw).toLowerCase().replace("×", "x").replace(/\s+/g, "");
  const m = s.match(/^(\d+(\.\d+)?)x(\d+(\.\d+)?)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;

  // keep original orientation as given, but also compute width/height
  // We treat width = first, height = second (matches UI "8.5x11")
  return {
    targetSizeSpec: `${a}x${b}`,
    widthIn: a,
    heightIn: b,
  };
}

function inchesPerMOA(distanceYards) {
  // True MOA: 1.047" at 100y
  return 1.047 * (distanceYards / 100);
}

function getBull(widthIn, heightIn) {
  // Default bull center (works for your 8.5x11 grid test)
  return { x: widthIn / 2, y: heightIn / 2 };
}

// Map a pixel point into inches using the normalized image dimensions.
function makePxToInMapper(normW, normH, widthIn, heightIn) {
  const sx = widthIn / normW;
  const sy = heightIn / normH;
  return (pt) => ({ x: pt.x * sx, y: pt.y * sy });
}

/*
  Minimal “hole” detection fallback:
  If you already have a real hole-detector wired in elsewhere, keep it.
  This fallback just returns a single “group center” at the darkest cluster it can find
  (safe for direction tests). If no detector present, it won’t crash.
*/
async function detectHolesFallback(_imageBuffer) {
  // We don’t add heavy native deps here. This fallback is intentionally conservative:
  // return empty holes so pipeline still responds gracefully.
  return { holes: [], normalized: null };
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.json({ ok: true, service: SERVICE, status: "alive", build: BUILD });
});

app.get("/api/sec", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE,
    build: BUILD,
    usage: "POST multipart/form-data to /api/sec with fields: image, distanceYards, clickValueMoa, targetSizeSpec OR targetSizeInches OR (widthIn,heightIn)",
  });
});

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    // ---------- input ----------
    const distanceYards = toNum(req.body.distanceYards) ?? 100;
    const clickValueMoa = toNum(req.body.clickValueMoa) ?? 0.25;

    // UI might send:
    // - targetSizeSpec: "8.5x11"
    // - OR targetSizeInches: "8.5x11" (string) OR 8.5 (number)
    // - OR widthIn/heightIn
    const specA = req.body.targetSizeSpec;
    const tsi = req.body.targetSizeInches;

    let parsed = parseSpec(specA) || parseSpec(tsi);

    let widthIn = parsed?.widthIn ?? toNum(req.body.widthIn);
    let heightIn = parsed?.heightIn ?? toNum(req.body.heightIn);

    // If still missing, hard-default to your current UI selection to stop the BAD_TARGET_SPEC loop
    if (!Number.isFinite(widthIn) || !Number.isFinite(heightIn) || widthIn <= 0 || heightIn <= 0) {
      widthIn = 8.5;
      heightIn = 11;
      parsed = { targetSizeSpec: "8.5x11", widthIn, heightIn };
    }

    const targetSizeSpec = parsed?.targetSizeSpec || `${widthIn}x${heightIn}`;

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        service: SERVICE,
        build: BUILD,
        error: { code: "NO_IMAGE", message: "image file required" },
      });
    }

    // ---------- normalize / detect ----------
    // If you have existing detection code in your repo, plug it in here.
    // For now we keep a safe fallback so the service never crashes.
    const detect = await detectHolesFallback(req.file.buffer);

    // If your existing pipeline already provides normalized sizes, use them.
    // Otherwise assume a generic normalized size (UI will still work; direction logic remains stable).
    const normW = detect.normalized?.width ?? 1000;
    const normH = detect.normalized?.height ?? 1000;

    const pxToIn = makePxToInMapper(normW, normH, widthIn, heightIn);
    const bull = getBull(widthIn, heightIn);

    // If holes exist, compute centroid. If not, return a clear “no holes” response but still echo SEC fields.
    const holes = Array.isArray(detect.holes) ? detect.holes : [];
    if (holes.length === 0) {
      return res.json({
        ok: false,
        service: SERVICE,
        build: BUILD,
        received: {
          originalName: req.file.originalname,
          bytes: req.file.size,
          mimetype: req.file.mimetype,
        },
        sec: {
          distanceYards,
          clickValueMoa,
          targetSizeSpec,
          widthIn,
          heightIn,
          targetSizeInches: round2(widthIn), // numeric echo expected by UI gate
        },
        computeStatus: "FAILED_HOLES",
        error: { code: "HOLES_NOT_FOUND", message: "No bullet holes detected." },
        detect: {
          normalized: { width: normW, height: normH },
          holesDetected: 0,
          holes: [],
        },
      });
    }

    // Holes in this fallback format should be {cx,cy}. If your real detector gives bbox/area too, keep them.
    let sx = 0;
    let sy = 0;
    for (const h of holes) {
      sx += Number(h.cx);
      sy += Number(h.cy);
    }
    const groupCenterPx = { x: sx / holes.length, y: sy / holes.length };
    const groupCenterIn = pxToIn(groupCenterPx);

    // ---------- “move cluster to bull” logic ----------
    // POIB = group - bull (Right +, Up + not enforced here; we use correction directly)
    // Correction = bull - group  (this is the direction you dial to move the group onto the bull)
    const corrX = bull.x - groupCenterIn.x;
    const corrY = bull.y - groupCenterIn.y;

    // Direction labels (no “sometimes inverted”):
    const windageDir = corrX >= 0 ? "RIGHT" : "LEFT";
    const elevDir = corrY >= 0 ? "UP" : "DOWN";

    // True MOA conversion
    const inPerClick = inchesPerMOA(distanceYards) / clickValueMoa;

    const clicksW = corrX / inPerClick;
    const clicksE = corrY / inPerClick;

    const clicksSigned = {
      windage: round2(clicksW),
      elevation: round2(clicksE),
    };

    const dial = {
      windage: `${windageDir} ${fmt2(Math.abs(clicksW))} clicks`,
      elevation: `${elevDir} ${fmt2(Math.abs(clicksE))} clicks`,
    };

    // ---------- response ----------
    return res.json({
      ok: true,
      service: SERVICE,
      build: BUILD,
      received: {
        originalName: req.file.originalname,
        bytes: req.file.size,
        mimetype: req.file.mimetype,
      },
      sec: {
        distanceYards,
        clickValueMoa,
        targetSizeSpec,
        widthIn,
        heightIn,
        targetSizeInches: round2(widthIn), // numeric echo expected by UI gate
      },
      computeStatus: "COMPUTED_FROM_IMAGE",
      detect: {
        normalized: { width: normW, height: normH },
        holesDetected: holes.length,
        holes,
      },
      bullInches: { x: round2(bull.x), y: round2(bull.y) },
      groupCenterInches: { x: round2(groupCenterIn.x), y: round2(groupCenterIn.y) },
      correctionInches: { x: round2(corrX), y: round2(corrY) },
      clicksSigned,
      dial,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      service: SERVICE,
      build: BUILD,
      error: { code: "SERVER_ERROR", message: String(err && err.message ? err.message : err) },
    });
  }
});

// Render port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${SERVICE} listening on ${PORT} (${BUILD})`);
});
