/**
 * SCZN3 SEC Backend — POIB → Bull (Y-DOWN LOCKED)
 * - Inputs (in inches): holes[], bull{x,y}, distanceYards, clickValueMoa, targetSizeSpec/targetSizeInches
 * - Coordinate system: X right (+), Y down (+)  ✅
 * - Correction: dx = bull.x - poib.x (RIGHT if +)
 *              dy = bull.y - poib.y (DOWN if +)  ✅
 * - True MOA: 1 MOA = 1.047" @ 100 yards
 * - Two decimals always
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const SERVICE = "sczn3-sec-backend-pipe";
const BUILD = "POIB_TO_BULL_LOCKED_YDOWN_V2";

// ---------- helpers ----------
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function parseNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Accepts:
 *  - "8.5x11"
 *  - "8.5×11"
 *  - "8.5 x 11"
 * Returns { spec:"8.5x11", widthIn:8.5, heightIn:11 } or null
 */
function parseTargetSizeSpec(spec) {
  if (!spec || typeof spec !== "string") return null;
  const s = spec.toLowerCase().replace("×", "x").replace(/\s+/g, "");
  const m = s.match(/^(\d+(\.\d+)?)x(\d+(\.\d+)?)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;

  // Treat as width x height (common input). Keep as-is.
  return {
    spec: `${a}x${b}`,
    widthIn: a,
    heightIn: b,
  };
}

function normalizeInputs(reqBody) {
  // holes can arrive as:
  // - holes: [ {x,y}, ... ]  (JSON)
  // - holesJson: "[{...}]"  (string)
  // - holes: "[{...}]"      (string)
  let holes = reqBody.holes;

  if (typeof holes === "string") {
    try { holes = JSON.parse(holes); } catch {}
  }
  if (!Array.isArray(holes) && typeof reqBody.holesJson === "string") {
    try { holes = JSON.parse(reqBody.holesJson); } catch {}
  }
  if (!Array.isArray(holes)) holes = [];

  // bull can arrive as:
  // - bull: {x,y}
  // - bullX, bullY
  let bull = reqBody.bull;
  if (typeof bull === "string") {
    try { bull = JSON.parse(bull); } catch {}
  }
  if (!bull || typeof bull !== "object") {
    const bx = parseNumber(reqBody.bullX, null);
    const by = parseNumber(reqBody.bullY, null);
    if (bx != null && by != null) bull = { x: bx, y: by };
  }

  // Defaults (your locked test env from archive)
  const distanceYards = parseNumber(reqBody.distanceYards, 50);
  const clickValueMoa = parseNumber(reqBody.clickValueMoa, 0.25);

  // size can arrive as:
  // - targetSizeSpec: "8.5x11"
  // - targetSizeInches: {widthIn,heightIn}
  // - widthIn, heightIn
  let size = null;

  if (reqBody.targetSizeSpec) size = parseTargetSizeSpec(reqBody.targetSizeSpec);
  if (!size && reqBody.targetSize) size = parseTargetSizeSpec(reqBody.targetSize);

  let targetSizeInches = reqBody.targetSizeInches;
  if (typeof targetSizeInches === "string") {
    try { targetSizeInches = JSON.parse(targetSizeInches); } catch {}
  }

  if (!targetSizeInches || typeof targetSizeInches !== "object") {
    const w = parseNumber(reqBody.widthIn, null);
    const h = parseNumber(reqBody.heightIn, null);
    if (w != null && h != null) targetSizeInches = { widthIn: w, heightIn: h };
  }

  // If we only got spec, create targetSizeInches from it
  if (!targetSizeInches && size) targetSizeInches = { widthIn: size.widthIn, heightIn: size.heightIn };

  return { holes, bull, distanceYards, clickValueMoa, size, targetSizeInches };
}

function computePOIB(holes) {
  let sx = 0, sy = 0, n = 0;
  for (const p of holes) {
    const x = parseNumber(p?.x, null);
    const y = parseNumber(p?.y, null);
    if (x == null || y == null) continue;
    sx += x;
    sy += y;
    n += 1;
  }
  if (n === 0) return { ok: false, n: 0 };
  return { ok: true, n, x: sx / n, y: sy / n };
}

function quadrantOfPOIB(poib, bull) {
  // Using Y-DOWN space:
  // poib.y < bull.y => UPPER
  const lr = poib.x < bull.x ? "L" : "R";
  const ud = poib.y < bull.y ? "U" : "L"; // U=upper, L=lower (not left)
  return `${ud}${lr}`; // "UL","UR","LL","LR"
}

function holeQuadrant(p, bull) {
  const x = parseNumber(p?.x, null);
  const y = parseNumber(p?.y, null);
  if (x == null || y == null) return null;
  const lr = x < bull.x ? "L" : "R";
  const ud = y < bull.y ? "U" : "L";
  return `${ud}${lr}`;
}

function uniqueQuadrants(holes, bull) {
  const set = new Set();
  for (const p of holes) {
    const q = holeQuadrant(p, bull);
    if (q) set.add(q);
  }
  return Array.from(set);
}

function inchesPerMOA(distanceYards) {
  // True MOA: 1 MOA = 1.047" @ 100y
  return 1.047 * (distanceYards / 100);
}

function clicksFromInches(deltaIn, distanceYards, clickValueMoa) {
  const inPerClick = inchesPerMOA(distanceYards) * clickValueMoa;
  if (!Number.isFinite(inPerClick) || inPerClick <= 0) return 0;
  return Math.abs(deltaIn) / inPerClick;
}

function labelsFromSignedYDown(wSigned, eSigned) {
  // windage: +RIGHT, -LEFT
  // elevation: +DOWN, -UP   (because Y increases downward)
  const wDir = wSigned >= 0 ? "RIGHT" : "LEFT";
  const eDir = eSigned >= 0 ? "DOWN" : "UP";
  return { wDir, eDir };
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.json({ ok: true, service: SERVICE, build: BUILD, status: "alive" });
});

// POST /api/sec
// Supports JSON body OR multipart/form-data
app.post("/api/sec", upload.single("image"), (req, res) => {
  try {
    const body = req.body || {};
    const { holes, bull, distanceYards, clickValueMoa, size, targetSizeInches } = normalizeInputs(body);

    // Require holes + bull
    if (!Array.isArray(holes) || holes.length === 0) {
      return res.status(400).json({
        ok: false,
        service: SERVICE,
        build: BUILD,
        error: { code: "NO_HOLES", message: "Provide holes[] in inches." },
      });
    }
    if (!bull || bull.x == null || bull.y == null) {
      return res.status(400).json({
        ok: false,
        service: SERVICE,
        build: BUILD,
        error: { code: "NO_BULL", message: "Provide bull{x,y} in inches (same coordinate system as holes)." },
      });
    }

    const poibRes = computePOIB(holes);
    if (!poibRes.ok) {
      return res.status(400).json({
        ok: false,
        service: SERVICE,
        build: BUILD,
        error: { code: "BAD_HOLES", message: "Holes must contain numeric x,y in inches." },
      });
    }

    // LOCKED RULE: correction = bull - POIB
    const dxIn = bull.x - poibRes.x; // + => RIGHT
    const dyIn = bull.y - poibRes.y; // + => DOWN (Y-DOWN space)

    // Clicks (two decimals)
    const wClicks = round2(clicksFromInches(dxIn, distanceYards, clickValueMoa));
    const eClicks = round2(clicksFromInches(dyIn, distanceYards, clickValueMoa));

    // Signed clicks (two decimals)
    const wSigned = dxIn >= 0 ? wClicks : -wClicks;
    const eSigned = dyIn >= 0 ? eClicks : -eClicks;

    const labels = labelsFromSignedYDown(wSigned, eSigned);

    // Build response
    return res.json({
      ok: true,
      service: SERVICE,
      build: BUILD,

      clicksSigned: {
        windage: round2(wSigned),
        elevation: round2(eSigned),
      },

      scopeClicks: {
        windage: `${labels.wDir} ${round2(Math.abs(wSigned))} clicks`,
        elevation: `${labels.eDir} ${round2(Math.abs(eSigned))} clicks`,
      },

      debug: {
        yAxisUsed: "down",
        targetSizeSpec: size?.spec || body.targetSizeSpec || body.targetSize || null,
        targetSizeInches: targetSizeInches || null,
        distanceYards: round2(distanceYards),
        clickValueMoa: round2(clickValueMoa),

        bull: { x: round2(bull.x), y: round2(bull.y) },
        poib: { x: round2(poibRes.x), y: round2(poibRes.y) },

        poibQuad: quadrantOfPOIB({ x: poibRes.x, y: poibRes.y }, bull),
        holesUsedCount: poibRes.n,
        uniqueHoleQuadrants: uniqueQuadrants(holes, bull),

        dxIn: round2(dxIn),
        dyIn: round2(dyIn),
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      service: SERVICE,
      build: BUILD,
      error: { code: "SERVER_ERROR", message: String(err?.message || err) },
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[${SERVICE}] ${BUILD} listening on ${PORT}`);
});
