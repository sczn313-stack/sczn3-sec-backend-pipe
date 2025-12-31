// backend/server.js
// SCZN3 SEC backend (POIB -> Bull) — Y-DOWN LOCKED (image/canvas convention)
// ✅ correction = bull - POIB
// ✅ dx>0 RIGHT, dx<0 LEFT
// ✅ dy>0 DOWN,  dy<0 UP   (because Y increases DOWN)
// ✅ poibQuad uses the SAME convention (UL/UR/LL/LR relative to bull, with Y-down)
//
// Endpoints:
//   GET  /                -> alive/build
//   GET  /health          -> alive/build
//   POST /api/sec         -> compute

const express = require("express");
const cors = require("cors");

const app = express();

// --- Config ---
const SERVICE = "sczn3-sec-backend-pipe";
const BUILD = "POIB_TO_BULL_YDOWN_LOCKED_V3";
const Y_AXIS_USED = "down"; // HARD LOCK

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// --- Helpers ---
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function asNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function trueInchesPerMOA(distanceYards) {
  // True MOA: 1 MOA = 1.047" at 100 yards
  return 1.047 * (distanceYards / 100);
}

function computePoib(holes) {
  let sx = 0,
    sy = 0,
    n = 0;
  for (const h of holes) {
    const x = Number(h?.x);
    const y = Number(h?.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      sx += x;
      sy += y;
      n++;
    }
  }
  if (!n) return null;
  return { x: sx / n, y: sy / n };
}

function quadOfPoibRelativeToBull(poib, bull) {
  // With Y-DOWN: smaller Y is "UP", larger Y is "DOWN"
  const left = poib.x < bull.x;
  const up = poib.y < bull.y;

  if (left && up) return "UL";
  if (!left && up) return "UR";
  if (left && !up) return "LL";
  return "LR";
}

function labelFromDx(dx) {
  if (dx > 0) return "RIGHT";
  if (dx < 0) return "LEFT";
  return "CENTER";
}

function labelFromDy(dy) {
  // Y-DOWN: positive dy means bull is lower -> move POIB DOWN
  if (dy > 0) return "DOWN";
  if (dy < 0) return "UP";
  return "CENTER";
}

// --- Alive ---
app.get("/", (_req, res) => {
  res.json({ ok: true, service: SERVICE, build: BUILD, yAxisUsed: Y_AXIS_USED, status: "alive" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: SERVICE, build: BUILD, yAxisUsed: Y_AXIS_USED, status: "alive" });
});

// --- Compute ---
app.post("/api/sec", (req, res) => {
  try {
    const body = req.body || {};

    // Inputs (defaults are safe for your test page)
    const targetSizeSpec = String(body.targetSizeSpec || "8.5x11");

    const distanceYards = asNum(body.distanceYards, 100);
    const clickValueMoa = asNum(body.clickValueMoa, 0.25);
    const deadbandInches = asNum(body.deadbandInches, 0.1);

    const bull = {
      x: asNum(body?.bull?.x, 4.25),
      y: asNum(body?.bull?.y, 5.5),
    };

    const holes = Array.isArray(body.holes) ? body.holes : [];

    if (!holes.length) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "NO_HOLES", message: "Provide holes[] in inches." },
        debug: { yAxisUsed: Y_AXIS_USED, targetSizeSpec, distanceYards, clickValueMoa, deadbandInches, bull, holesUsedCount: 0 },
      });
    }

    const poib = computePoib(holes);
    if (!poib) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "BAD_HOLES", message: "holes[] must contain numeric x/y." },
        debug: { yAxisUsed: Y_AXIS_USED, holesUsedCount: 0 },
      });
    }

    // Core rule (locked):
    // correction = bull - poib
    let dxIn = bull.x - poib.x;
    let dyIn = bull.y - poib.y;

    // Deadband (snap small corrections to 0)
    if (Math.abs(dxIn) < deadbandInches) dxIn = 0;
    if (Math.abs(dyIn) < deadbandInches) dyIn = 0;

    // True MOA conversion
    const inchesPerMOA = trueInchesPerMOA(distanceYards);

    const windageMoa = inchesPerMOA === 0 ? 0 : dxIn / inchesPerMOA;
    const elevationMoa = inchesPerMOA === 0 ? 0 : dyIn / inchesPerMOA;

    const windageClicks = clickValueMoa === 0 ? 0 : windageMoa / clickValueMoa;
    const elevationClicks = clickValueMoa === 0 ? 0 : elevationMoa / clickValueMoa;

    // Labels (direction from SIGN, magnitude is abs)
    const wDir = labelFromDx(dxIn);
    const eDir = labelFromDy(dyIn);

    const wAbs = round2(Math.abs(windageClicks));
    const eAbs = round2(Math.abs(elevationClicks));

    // Signed clicks (keep sign for debugging / audits)
    const clicksSigned = {
      windage: round2(windageClicks),
      elevation: round2(elevationClicks),
    };

    const scopeClicks = {
      windage: `${wDir} ${wAbs.toFixed(2)} clicks`,
      elevation: `${eDir} ${eAbs.toFixed(2)} clicks`,
    };

    const poibQuad = quadOfPoibRelativeToBull(poib, bull);

    return res.json({
      ok: true,
      service: SERVICE,
      build: BUILD,
      clicksSigned,
      scopeClicks,
      debug: {
        yAxisUsed: Y_AXIS_USED,
        targetSizeSpec,
        distanceYards,
        clickValueMoa,
        deadbandInches,
        inchesPerMOA: round2(inchesPerMOA),
        bull: { x: round2(bull.x), y: round2(bull.y) },
        poib: { x: round2(poib.x), y: round2(poib.y) },
        poibQuad,
        holesUsedCount: holes.length,
        dxIn: round2(dxIn),
        dyIn: round2(dyIn),
        note: "Y-DOWN locked: dy>0 => DOWN, dy<0 => UP. correction=bull-POIB.",
        frontendBuild: body.frontendBuild || null,
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      build: BUILD,
      error: { code: "SERVER_ERROR", message: String(err?.message || err) },
    });
  }
});

// --- Start ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[${SERVICE}] ${BUILD} listening on ${PORT} (yAxisUsed=${Y_AXIS_USED})`);
});
