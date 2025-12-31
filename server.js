// server.js (SCZN3 POIB Anchor - Clean)
// Directions are NEVER flipped by guessing.
// Canonical rule: correction = bull - POIB
// X: right positive
// Y: up positive (internally normalized)

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({ storage: multer.memoryStorage() });

const BUILD = process.env.BUILD_ID || "POIB_ANCHOR_CLEAN_V1";

// ---------- helpers ----------
function round2(n) {
  return Math.round(n * 100) / 100;
}

function mustNumber(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`BAD_${name.toUpperCase()}`);
  return n;
}

// Accepts: "8.5x11" OR widthIn/heightIn
function parseTargetSize({ targetSizeSpec, widthIn, heightIn }) {
  if (targetSizeSpec && typeof targetSizeSpec === "string") {
    const m = targetSizeSpec.trim().toLowerCase().match(/^(\d+(\.\d+)?)x(\d+(\.\d+)?)$/);
    if (!m) throw new Error("BAD_TARGET_SPEC");
    const w = Number(m[1]);
    const h = Number(m[3]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("BAD_TARGET_SPEC");
    return { widthIn: w, heightIn: h, spec: `${w}x${h}` };
  }

  const w = Number(widthIn);
  const h = Number(heightIn);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error("BAD_TARGET_SIZE");
  return { widthIn: w, heightIn: h, spec: `${w}x${h}` };
}

// Normalize a POIB y-value into "UP-positive" internal space.
// If incoming yAxis is "down", then y=0 is at TOP and increases downward.
// Convert to UP-positive by: yUp = heightIn - yDown
function normalizeY(y, heightIn, yAxis) {
  if (yAxis === "down") return heightIn - y;
  return y; // "up" or default
}

function meanPOIB(holes) {
  const n = holes.length;
  const sx = holes.reduce((a, p) => a + p.x, 0);
  const sy = holes.reduce((a, p) => a + p.y, 0);
  return { x: sx / n, y: sy / n };
}

// True MOA inches per 1 MOA at distance
function inchesPerMOA(distanceYards) {
  // 1 MOA = 1.047" at 100y
  return 1.047 * (distanceYards / 100);
}

function toClicks(inches, distanceYards, clickValueMoa) {
  const moa = inches / inchesPerMOA(distanceYards);
  const clicks = moa / clickValueMoa;
  return clicks;
}

function labelFromSignedDelta(axis, signedClicks) {
  // signedClicks: + means RIGHT (windage) or UP (elev), - means LEFT or DOWN
  const abs = Math.abs(signedClicks);
  const amt = round2(abs).toFixed(2);

  if (axis === "windage") {
    if (signedClicks > 0) return `RIGHT ${amt} clicks`;
    if (signedClicks < 0) return `LEFT ${amt} clicks`;
    return `RIGHT 0.00 clicks`;
  } else {
    if (signedClicks > 0) return `UP ${amt} clicks`;
    if (signedClicks < 0) return `DOWN ${amt} clicks`;
    return `UP 0.00 clicks`;
  }
}

// Quadrant of POIB relative to bull in INTERNAL (UP-positive) space
function quadrantOfPOIB(poib, bull) {
  const left = poib.x < bull.x;
  const right = poib.x > bull.x;
  const below = poib.y < bull.y;
  const above = poib.y > bull.y;

  if (left && above) return "UL";
  if (right && above) return "UR";
  if (left && below) return "LL";
  if (right && below) return "LR";
  // on-axis cases:
  if (left) return "L";
  if (right) return "R";
  if (above) return "U";
  if (below) return "D";
  return "CENTER";
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "sczn3-sec-backend-pipe", build: BUILD, status: "alive" });
});

app.post("/api/sec", upload.single("image"), (req, res) => {
  try {
    // Inputs
    const distanceYards = mustNumber(req.body.distanceYards ?? 100, "distanceYards");
    const clickValueMoa = mustNumber(req.body.clickValueMoa ?? 0.25, "clickValueMoa");

    const yAxis = (req.body.yAxis || "up").toLowerCase(); // "up" or "down"
    if (yAxis !== "up" && yAxis !== "down") throw new Error("BAD_Y_AXIS");

    // Target size
    const size = parseTargetSize({
      targetSizeSpec: req.body.targetSizeSpec || req.body.targetSizeInches || req.body.targetSize,
      widthIn: req.body.widthIn,
      heightIn: req.body.heightIn,
    });

    // Bull (default center unless provided)
    const bullX = req.body.bullX != null ? mustNumber(req.body.bullX, "bullX") : size.widthIn / 2;
    const bullY_raw = req.body.bullY != null ? mustNumber(req.body.bullY, "bullY") : size.heightIn / 2;

    // We assume bullY is provided in the SAME yAxis convention as holes.
    // Normalize bull into internal UP-positive space:
    const bull = {
      x: bullX,
      y: normalizeY(bullY_raw, size.heightIn, yAxis),
    };

    // Holes:
    // Prefer holesJson; if not provided but image exists, we reject here (no guessing).
    let holes = [];
    if (req.body.holesJson) {
      const parsed = JSON.parse(req.body.holesJson);
      if (!Array.isArray(parsed) || parsed.length < 1) throw new Error("BAD_HOLES_JSON");
      holes = parsed.map((p) => ({
        x: mustNumber(p.x, "holeX"),
        y: mustNumber(p.y, "holeY"),
      }));
    } else if (req.body.holes) {
      // allow already-parsed JSON array in "holes"
      const parsed = typeof req.body.holes === "string" ? JSON.parse(req.body.holes) : req.body.holes;
      if (!Array.isArray(parsed) || parsed.length < 1) throw new Error("BAD_HOLES");
      holes = parsed.map((p) => ({
        x: mustNumber(p.x, "holeX"),
        y: mustNumber(p.y, "holeY"),
      }));
    } else if (req.file) {
      // IMPORTANT: we do NOT "guess" axis or fabricate holes from an image here.
      // If you want image detection, wire it in explicitly and still normalize yAxis the same way.
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: {
          code: "IMAGE_DETECTION_NOT_WIRED",
          message: "Send holesJson (in inches) or wire image detection explicitly. No guessing.",
        },
        received: {
          hasImage: true,
          targetSizeSpec: size.spec,
          yAxis,
        },
      });
    } else {
      throw new Error("MISSING_INPUT");
    }

    // Normalize holes into internal UP-positive space:
    const holesNorm = holes.map((p) => ({
      x: p.x,
      y: normalizeY(p.y, size.heightIn, yAxis),
    }));

    // POIB
    const poib = meanPOIB(holesNorm);

    // Canonical correction in inches: bull - POIB
    const dxIn = bull.x - poib.x; // + => move RIGHT
    const dyIn = bull.y - poib.y; // + => move UP

    // Convert inches -> clicks (true MOA)
    let windClicks = toClicks(dxIn, distanceYards, clickValueMoa);
    let elevClicks = toClicks(dyIn, distanceYards, clickValueMoa);

    // Deadband (optional)
    const deadbandIn = req.body.deadbandIn != null ? mustNumber(req.body.deadbandIn, "deadbandIn") : 0.00;
    if (Math.abs(dxIn) <= deadbandIn) windClicks = 0;
    if (Math.abs(dyIn) <= deadbandIn) elevClicks = 0;

    // Two-decimal signed outputs
    const clicksSigned = {
      windage: round2(windClicks),
      elevation: round2(elevClicks),
    };

    const scopeClicks = {
      windage: labelFromSignedDelta("windage", clicksSigned.windage),
      elevation: labelFromSignedDelta("elevation", clicksSigned.elevation),
    };

    const poibQuad = quadrantOfPOIB(poib, bull);

    res.json({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD,
      clicksSigned,
      scopeClicks,
      debug: {
        yAxisUsed: yAxis,                 // "up" or "down" as provided
        targetSizeSpec: size.spec,
        targetSizeInches: { widthIn: round2(size.widthIn), heightIn: round2(size.heightIn) },
        distanceYards,
        clickValueMoa,
        bull: { x: round2(bull.x), y: round2(bull.y) },     // internal UP-positive
        poib: { x: round2(poib.x), y: round2(poib.y) },     // internal UP-positive
        poibQuad,
        dxIn: round2(dxIn),
        dyIn: round2(dyIn),
        holesUsedCount: holesNorm.length,
      },
    });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    res.status(400).json({
      ok: false,
      build: BUILD,
      error: { code: msg, message: msg },
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`SEC backend listening on ${PORT} (${BUILD})`));
