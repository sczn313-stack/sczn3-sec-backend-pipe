// server.js  (REPLACE THE WHOLE FILE)
// SCZN3 SEC backend — POIB -> Bull, Y axis is DOWN (top=0, bottom=+)
// Elevation: dy>0 (POIB below bull) => UP. dy<0 => DOWN.

const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

const SERVICE_NAME = process.env.SERVICE_NAME || "sczn3-sec-backend-pipe";
const BUILD =
  process.env.BUILD ||
  "POIB_TO_BULL_TRUE_MOA_TAP_HOLES_V2__YDOWN__ELEV_UP_WHEN_POIB_BELOW";

const round2 = (n) => Math.round(n * 100) / 100;

function safeNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Quadrant is based on dx,dy where:
// dx = poib.x - bull.x  ( + = POIB right of bull )
// dy = poib.y - bull.y  ( + = POIB below bull because Y increases downward )
function getQuadrant(dx, dy) {
  if (dx === 0 && dy === 0) return "C";
  const xSide = dx <= 0 ? "L" : "R";
  const ySide = dy <= 0 ? "U" : "L";
  // ySide 'U' means above bull (dy<=0), 'L' means below bull (dy>0)
  return ySide + xSide; // "UL","UR","LL","LR"
}

function labelWindageFromSigned(w) {
  if (w === 0) return "HOLD";
  return w > 0 ? "RIGHT" : "LEFT";
}

function labelElevationFromSigned(e) {
  if (e === 0) return "HOLD";
  return e > 0 ? "UP" : "DOWN";
}

function normalizeTargetSizeSpec(specRaw) {
  const spec = String(specRaw || "").trim();
  // Keep it simple: accept "8.5x11", "8.5×11", "8.5 x 11"
  const cleaned = spec.replace("×", "x").replace(/\s+/g, "");
  return cleaned || "8.5x11";
}

function sizeToInches(spec) {
  // Only a couple needed for now — add more later if you want
  // Returns widthIn, heightIn, longIn, shortIn
  switch (spec) {
    case "8.5x11":
    case "8.5x11.0":
      return { widthIn: 8.5, heightIn: 11, longIn: 11, shortIn: 8.5 };
    case "11x8.5":
      return { widthIn: 11, heightIn: 8.5, longIn: 11, shortIn: 8.5 };
    default:
      // If unknown, don't guess — fall back to 8.5x11 so math stays stable.
      return { widthIn: 8.5, heightIn: 11, longIn: 11, shortIn: 8.5 };
  }
}

function computePOIBFromHoles(holes) {
  // holes: [{x,y},...], inches
  let sx = 0;
  let sy = 0;
  for (const h of holes) {
    sx += h.x;
    sy += h.y;
  }
  return { x: sx / holes.length, y: sy / holes.length };
}

function uniqQuadrants(holes, bull) {
  const set = new Set();
  for (const h of holes) {
    const dx = h.x - bull.x;
    const dy = h.y - bull.y;
    set.add(getQuadrant(dx, dy));
  }
  return Array.from(set);
}

function validateHolesArray(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const x = Number(item.x);
    const y = Number(item.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x, y });
  }
  return out.length ? out : null;
}

// --- Routes ---

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    status: "alive",
    build: BUILD,
    yAxisUsed: "down",
    hint: "Use GET /health or POST /api/sec",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    status: "alive",
    build: BUILD,
    yAxisUsed: "down",
  });
});

// Optional: GET to show hint (prevents confusion like "Cannot GET /api/sec")
app.get("/api/sec", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    build: BUILD,
    yAxisUsed: "down",
    hint: "POST JSON with holes[] or poib{}, plus bullX/bullY, distanceYards, clickValueMoa, deadbandInches, targetSize",
  });
});

app.post("/api/sec", (req, res) => {
  try {
    const body = req.body || {};

    const targetSizeSpec = normalizeTargetSizeSpec(body.targetSize || body.targetSizeSpec);
    const targetSizeInches = sizeToInches(targetSizeSpec);

    const distanceYards = safeNum(body.distanceYards, 100);
    const clickValueMoa = safeNum(body.clickValueMoa, 0.25);
    const deadbandInches = safeNum(body.deadbandInches, 0.1);

    const bullX = safeNum(body.bullX, 4.25);
    const bullY = safeNum(body.bullY, 5.5);

    const bull = { x: bullX, y: bullY };

    // Input: either holes[] or poib{}
    const holes = validateHolesArray(body.holes);
    let poib = null;

    if (holes && holes.length) {
      poib = computePOIBFromHoles(holes);
    } else if (body.poib && typeof body.poib === "object") {
      const px = Number(body.poib.x);
      const py = Number(body.poib.y);
      if (Number.isFinite(px) && Number.isFinite(py)) poib = { x: px, y: py };
    }

    if (!poib) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_INPUT",
        message: "Provide holes[] or poib{}.",
        build: BUILD,
        yAxisUsed: "down",
      });
    }

    // Inches per MOA at distance (1.047" @ 100y)
    const inchesPerMOA = (distanceYards / 100) * 1.047;
    const inchesPerClick = inchesPerMOA * clickValueMoa;

    // dx,dy in inches using Y-down coordinate system
    const dxIn = poib.x - bull.x; // + = POIB right of bull
    const dyIn = poib.y - bull.y; // + = POIB below bull (because Y grows downward)

    // Apply deadband: if within deadband, treat as 0 adjustment on that axis
    const dxAdj = Math.abs(dxIn) < deadbandInches ? 0 : dxIn;
    const dyAdj = Math.abs(dyIn) < deadbandInches ? 0 : dyIn;

    // Signed clicks convention (LOCKED):
    // windageSigned > 0 => RIGHT, < 0 => LEFT
    // elevationSigned > 0 => UP,    < 0 => DOWN
    //
    // With Y-down: if dyAdj > 0 (POIB below bull), correction is UP => positive
    // so elevationSigned = dyAdj / inchesPerClick
    const windageSigned = inchesPerClick === 0 ? 0 : dxAdj / inchesPerClick;
    const elevationSigned = inchesPerClick === 0 ? 0 : dyAdj / inchesPerClick;

    const windageLabel = labelWindageFromSigned(windageSigned);
    const elevationLabel = labelElevationFromSigned(elevationSigned);

    const windageClicksAbs = Math.abs(windageSigned);
    const elevationClicksAbs = Math.abs(elevationSigned);

    const poibQuad = getQuadrant(dxIn, dyIn);
    const uniqueHoleQuadrants = holes ? uniqQuadrants(holes, bull) : [];

    const out = {
      ok: true,
      service: SERVICE_NAME,
      build: BUILD,

      // keep shape: positive means RIGHT/UP, negative means LEFT/DOWN
      clicksSigned: {
        windage: round2(windageSigned),
        elevation: round2(elevationSigned),
      },

      // readable scope output (ALWAYS matches signed clicks)
      scopeClicks: {
        windage: `${windageLabel} ${round2(windageClicksAbs)} clicks`,
        elevation: `${elevationLabel} ${round2(elevationClicksAbs)} clicks`,
      },

      debug: {
        yAxisUsed: "down",
        targetSizeSpec,
        targetSizeInches,
        distanceYards,
        clickValueMoa,
        inchesPerMOA: round2(inchesPerMOA),
        inchesPerClick: round2(inchesPerClick),
        bull,
        poib,
        holesUsedCount: holes ? holes.length : 0,
        dxIn: round2(dxIn),
        dyIn: round2(dyIn),
        poibQuad,
        uniqueHoleQuadrants,
        note:
          "Convention locked: X right+, Y down+. dy>0 means POIB below bull => elevation UP. Quadrants: UL(dx-,dy-), UR(dx+,dy-), LL(dx-,dy+), LR(dx+,dy+).",
      },
    };

    return res.json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      message: err && err.message ? err.message : "Unknown error",
      build: BUILD,
      yAxisUsed: "down",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] listening on ${PORT} :: ${BUILD}`);
});
