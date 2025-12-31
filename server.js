// server.js — POIB Anchor Clean (no “flip and guess”)
// Coordinate standard inside this server:
//   X increases to the RIGHT
//   Y increases UP
//
// If incoming hole coordinates use TOP-LEFT origin (Y increases DOWN),
// send yAxis="down" and we will convert: yUp = heightIn - yDown.

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));

const BUILD = "POIB_ANCHOR_CLEAN_V1";

// ---------- helpers ----------
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function parseNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Accepts: "8.5x11", "8.5 x 11", "11x8.5"
function parseTargetSizeSpec(spec) {
  if (!spec || typeof spec !== "string") return null;
  const cleaned = spec.toLowerCase().replace(/\s+/g, "");
  const m = cleaned.match(/^(\d+(\.\d+)?)[x×](\d+(\.\d+)?)$/);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  // For portrait paper targets, width is the smaller, height is the larger.
  const widthIn = Math.min(a, b);
  const heightIn = Math.max(a, b);

  return {
    spec: `${widthIn}x${heightIn}`,
    widthIn,
    heightIn,
    short: widthIn,
    long: heightIn,
  };
}

function normalizeHolesToYUp(holes, heightIn, yAxis) {
  // yAxis:
  //   "up"   => already Y-up (bottom origin)
  //   "down" => Y-down (top origin) -> convert
  const axis = (yAxis || "up").toLowerCase();
  return holes.map((h) => {
    const x = Number(h.x);
    const y = Number(h.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const yUp = axis === "down" ? (heightIn - y) : y;
    return { x, y: yUp };
  }).filter(Boolean);
}

function centroid(pts) {
  const n = pts.length;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  return { x: sx / n, y: sy / n };
}

// If >7 points, keep the 7 closest to centroid (simple, stable, no drama)
function trimToMaxShots(holes, maxShots = 7) {
  if (holes.length <= maxShots) return holes;
  const c = centroid(holes);
  const scored = holes.map((p) => ({
    p,
    d2: (p.x - c.x) ** 2 + (p.y - c.y) ** 2,
  }));
  scored.sort((a, b) => a.d2 - b.d2);
  return scored.slice(0, maxShots).map((s) => s.p);
}

function quadrantOfPoint(pt, bull) {
  // With Y-up:
  // UL: left & above, UR: right & above, LL: left & below, LR: right & below
  const left = pt.x < bull.x;
  const above = pt.y > bull.y;
  if (left && above) return "UL";
  if (!left && above) return "UR";
  if (left && !above) return "LL";
  return "LR";
}

function uniqueQuadrants(holes, bull) {
  const set = new Set();
  for (const h of holes) set.add(quadrantOfPoint(h, bull));
  return Array.from(set);
}

function inchesToClicks(inches, distanceYards, clickValueMoa) {
  // True MOA: 1 MOA = 1.047" @ 100y
  const inchesPerMoa = 1.047 * (distanceYards / 100);
  const moa = inches / inchesPerMoa;
  return moa / clickValueMoa;
}

function labelFromSignedClicks(wSigned, eSigned) {
  const windage = wSigned >= 0 ? `RIGHT ${round2(Math.abs(wSigned))} clicks` : `LEFT ${round2(Math.abs(wSigned))} clicks`;
  const elevation = eSigned >= 0 ? `UP ${round2(Math.abs(eSigned))} clicks` : `DOWN ${round2(Math.abs(eSigned))} clicks`;
  return { windage, elevation };
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "sczn3-sec-backend-pipe", build: BUILD, status: "alive" });
});

// POST /api/sec
// Supports either:
// 1) multipart/form-data with fields:
//    - targetSizeSpec (e.g. "8.5x11")
//    - distanceYards, clickValueMoa
//    - holesJson (JSON string of [{x,y},...]) OR holes (same)
//    - yAxis: "up" or "down"  (down = top-origin y increases downward)
//    - multiQuadPolicy: "poib" (default) or "reject"
// 2) application/json with same fields
app.post("/api/sec", upload.single("image"), (req, res) => {
  try {
    const body = req.body || {};

    const targetSizeSpec = body.targetSizeSpec || body.targetSize || body.targetSizeInches;
    const size = parseTargetSizeSpec(String(targetSizeSpec || ""));
    if (!size) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "BAD_TARGET_SPEC", message: "Provide targetSizeSpec like 8.5x11 (or 11x8.5)." },
      });
    }

    const distanceYards = parseNumber(body.distanceYards, 100);
    const clickValueMoa = parseNumber(body.clickValueMoa, 0.25);

    // Bull defaults to center of target
    const bull = {
      x: parseNumber(body.bullX, size.widthIn / 2),
      y: parseNumber(body.bullY, size.heightIn / 2),
    };

    // holes can arrive as JSON string field
    let holesRaw = body.holesJson || body.holes;
    let holesArr = null;

    if (typeof holesRaw === "string") {
      try {
        holesArr = JSON.parse(holesRaw);
      } catch {
        return res.status(400).json({
          ok: false,
          build: BUILD,
          error: { code: "BAD_HOLES_JSON", message: "holesJson must be valid JSON array like [{\"x\":1,\"y\":2},...]" },
        });
      }
    } else if (Array.isArray(holesRaw)) {
      holesArr = holesRaw;
    }

    // If no holes were provided, we do NOT guess from image here.
    if (!Array.isArray(holesArr) || holesArr.length < 1) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "MISSING_HOLES", message: "Provide holesJson (in inches) for this backend test endpoint." },
      });
    }

    const yAxis = (body.yAxis || "up").toLowerCase(); // "up" or "down"
    let holes = normalizeHolesToYUp(holesArr, size.heightIn, yAxis);

    // Basic min shots rule (you can tighten later)
    const minShots = parseNumber(body.minShots, 3);
    if (holes.length < minShots) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "NOT_ENOUGH_SHOTS", message: `Need at least ${minShots} shots.` },
      });
    }

    // Optional: reject multi-quadrant holes (if user asks for that behavior)
    const multiQuadPolicy = (body.multiQuadPolicy || "poib").toLowerCase(); // "poib" | "reject"
    const quads = uniqueQuadrants(holes, bull);
    if (multiQuadPolicy === "reject" && quads.length > 1) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "MULTI_QUAD", message: `Holes span multiple quadrants (${quads.join(", ")}).` },
      });
    }

    // Trim to max 7 for stability
    const holesUsed = trimToMaxShots(holes, 7);

    // POIB = centroid of used holes
    const poib = centroid(holesUsed);

    // Determine POIB quadrant (anchor point)
    const poibQuad = quadrantOfPoint(poib, bull);

    // Canonical correction in Y-up space:
    // correction = bull - poib
    const dxIn = bull.x - poib.x; // + => RIGHT
    const dyIn = bull.y - poib.y; // + => UP

    // Convert to clicks (signed)
    const wClicksSigned = inchesToClicks(dxIn, distanceYards, clickValueMoa);
    const eClicksSigned = inchesToClicks(dyIn, distanceYards, clickValueMoa);

    const labels = labelFromSignedClicks(wClicksSigned, eClicksSigned);

    return res.json({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD,

      clicksSigned: {
        windage: round2(wClicksSigned),
        elevation: round2(eClicksSigned),
      },

      scopeClicks: {
        windage: labels.windage,
        elevation: labels.elevation,
      },

      debug: {
        targetSizeSpec: size.spec,
        targetSizeInches: { widthIn: size.widthIn, heightIn: size.heightIn },
        distanceYards,
        clickValueMoa,
        yAxisUsed: yAxis,
        bull: { x: round2(bull.x), y: round2(bull.y) },
        poib: { x: round2(poib.x), y: round2(poib.y) },
        poibQuad,
        holesUsedCount: holesUsed.length,
        uniqueHoleQuadrants: quads,
        dxIn: round2(dxIn),
        dyIn: round2(dyIn),
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      build: BUILD,
      error: { code: "SERVER_ERROR", message: String(err && err.message ? err.message : err) },
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[${BUILD}] listening on ${PORT}`);
});
