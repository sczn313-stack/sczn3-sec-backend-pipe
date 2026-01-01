/* server.js — SCZN3 SEC backend (PIPE)
   - GET  /            -> alive JSON (so you don’t see “Cannot GET /”)
   - GET  /health      -> alive JSON
   - POST /api/sec     -> compute clicks (POIB -> Bull), y-axis is DOWN (screen coords)
*/

const express = require("express");
const cors = require("cors");

const SERVICE_NAME = process.env.SERVICE_NAME || "sczn3-sec-backend-pipe";
const BUILD = process.env.BUILD || "POIB_TO_BULL_TRUE_MOA_TAP_HOLES_V2__YDOWN__ELEV_UP_WHEN_POIB_BELOW";
const Y_AXIS_USED = "down"; // IMPORTANT: y increases downward (screen coords)

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function asNum(v, fallback) {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : fallback;
}

function calcPOIBFromHoles(holes) {
  if (!Array.isArray(holes) || holes.length === 0) return null;

  let sx = 0;
  let sy = 0;
  let count = 0;

  for (const h of holes) {
    if (h && isNum(h.x) && isNum(h.y)) {
      sx += h.x;
      sy += h.y;
      count += 1;
    }
  }

  if (count === 0) return null;
  return { x: sx / count, y: sy / count };
}

function quadrant(dx, dy) {
  if (dx === 0 || dy === 0) return "AXIS";
  // y-down coords:
  // dy < 0 => POIB above bull
  // dy > 0 => POIB below bull
  if (dx < 0 && dy < 0) return "UL";
  if (dx > 0 && dy < 0) return "UR";
  if (dx < 0 && dy > 0) return "LL";
  return "LR";
}

function labelFromSignedWindage(w) {
  if (w === 0) return "CENTER 0.00 clicks";
  return w > 0 ? `RIGHT ${round2(Math.abs(w))} clicks` : `LEFT ${round2(Math.abs(w))} clicks`;
}

function labelFromSignedElevation(e) {
  if (e === 0) return "CENTER 0.00 clicks";
  return e > 0 ? `UP ${round2(Math.abs(e))} clicks` : `DOWN ${round2(Math.abs(e))} clicks`;
}

function compute(payload) {
  const distanceYards = asNum(payload.distanceYards, 100);
  const clickValueMoa = asNum(payload.clickValueMoa, 0.25);
  const deadbandInches = Math.max(0, asNum(payload.deadbandInches, 0));

  const bullX = asNum(payload.bullX, null);
  const bullY = asNum(payload.bullY, null);
  if (!Number.isFinite(bullX) || !Number.isFinite(bullY)) {
    return {
      ok: false,
      error: "MISSING_BULL",
      message: "Provide bullX and bullY (in inches).",
    };
  }

  const poib =
    payload.poib && isNum(payload.poib.x) && isNum(payload.poib.y)
      ? { x: payload.poib.x, y: payload.poib.y }
      : calcPOIBFromHoles(payload.holes);

  if (!poib) {
    return {
      ok: false,
      error: "MISSING_INPUT",
      message: "Provide holes[] or poib{}.",
      hint:
        "POST JSON with holes[] OR poib{}, plus bullX/bullY, distanceYards, clickValueMoa, deadbandInches, targetSize.",
    };
  }

  // True MOA @ distance: 1.047" @ 100y
  const inchesPerMOA = (distanceYards / 100) * 1.047;
  const inchesPerClick = inchesPerMOA * clickValueMoa;

  // dx, dy are POIB relative to bull (in inches)
  // y-down: dy > 0 means POIB below bull
  const dxIn = poib.x - bullX; // + = POIB right
  const dyIn = poib.y - bullY; // + = POIB below (because y-down)

  // Deadband
  const dxAdj = Math.abs(dxIn) < deadbandInches ? 0 : dxIn;
  const dyAdj = Math.abs(dyIn) < deadbandInches ? 0 : dyIn;

  // SIGNED clicks (LOCKED convention):
  // windageSigned: + => RIGHT, - => LEFT
  // elevationSigned: + => UP, - => DOWN
  //
  // If POIB is RIGHT (dxAdj > 0), you must dial LEFT => negative
  // If POIB is LEFT (dxAdj < 0), you must dial RIGHT => positive
  const windageSigned = dxAdj === 0 ? 0 : -dxAdj / inchesPerClick;

  // If POIB is BELOW (dyAdj > 0, y-down), you must dial UP => positive
  // If POIB is ABOVE (dyAdj < 0), you must dial DOWN => negative
  const elevationSigned = dyAdj === 0 ? 0 : dyAdj / inchesPerClick;

  const windageLabel = labelFromSignedWindage(windageSigned);
  const elevationLabel = labelFromSignedElevation(elevationSigned);

  return {
    ok: true,
    service: SERVICE_NAME,
    build: BUILD,
    yAxisUsed: Y_AXIS_USED,

    clicksSigned: {
      windage: round2(windageSigned),
      elevation: round2(elevationSigned),
    },

    scopeClicks: {
      windage: windageLabel,
      elevation: elevationLabel,
    },

    debug: {
      targetSizeSpec: payload.targetSize || payload.targetSizeSpec || "unknown",
      distanceYards,
      clickValueMoa,
      deadbandInches,
      inchesPerMOA: round2(inchesPerMOA),
      inchesPerClick: round2(inchesPerClick),
      bull: { x: bullX, y: bullY },
      poib: { x: round2(poib.x), y: round2(poib.y) },
      dxIn: round2(dxIn),
      dyIn: round2(dyIn),
      poibQuad: quadrant(dxIn, dyIn),
    },
  };
}

// Root + health so you stop seeing “Cannot GET /”
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    status: "alive",
    build: BUILD,
    yAxisUsed: Y_AXIS_USED,
    hint: "Use GET /health or POST /api/sec",
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    status: "alive",
    build: BUILD,
    yAxisUsed: Y_AXIS_USED,
    hint: "POST /api/sec",
  });
});

// Optional: helpful message if someone browses /api/sec
app.get("/api/sec", (req, res) => {
  res.status(405).json({
    ok: false,
    error: "METHOD_NOT_ALLOWED",
    message: "Use POST /api/sec",
    example: {
      targetSize: "8.5x11",
      distanceYards: 100,
      clickValueMoa: 0.25,
      deadbandInches: 0.1,
      bullX: 4.25,
      bullY: 5.5,
      holes: [{ x: 3.9, y: 4.8 }],
    },
  });
});

app.post("/api/sec", (req, res) => {
  try {
    const out = compute(req.body || {});
    if (!out.ok) return res.status(400).json({ ...out, service: SERVICE_NAME, build: BUILD, yAxisUsed: Y_AXIS_USED });
    return res.json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      service: SERVICE_NAME,
      build: BUILD,
      yAxisUsed: Y_AXIS_USED,
      error: "SERVER_ERROR",
      message: err && err.message ? err.message : "Unknown error",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] listening on ${PORT} :: build=${BUILD} :: yAxisUsed=${Y_AXIS_USED}`);
});
