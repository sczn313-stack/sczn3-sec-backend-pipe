// server.js — SCZN3 POIB → BULL (Y-DOWN LOCKED)
// Rule (locked):
// dx = bull.x - poib.x  => dx>0 RIGHT, dx<0 LEFT
// dy = bull.y - poib.y  => dy>0 DOWN,  dy<0 UP   (because Y increases DOWN in canvas/image space)

const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const BUILD = "POIB_TO_BULL_YDOWN_LOCKED_V2";

// ---------- helpers ----------
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function inchesPerMOA(distanceYards) {
  // True MOA: 1 MOA = 1.047" @ 100 yards
  return 1.047 * (distanceYards / 100);
}

function dirLR(dx) {
  if (dx > 0) return "RIGHT";
  if (dx < 0) return "LEFT";
  return "NONE";
}

// Y-DOWN LOCKED
function dirUD_YDOWN(dy) {
  if (dy > 0) return "DOWN";
  if (dy < 0) return "UP";
  return "NONE";
}

function quadrantOfPoint_YDOWN(pt, bull) {
  const left = pt.x < bull.x;
  const up = pt.y < bull.y; // smaller y is "UP" on target when Y increases DOWN
  if (left && up) return "UL";
  if (!left && up) return "UR";
  if (left && !up) return "LL";
  return "LR";
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "sczn3-sec-backend-pipe", build: BUILD, status: "alive" });
});

/**
 * POST /api/sec
 * Body JSON (in inches):
 * {
 *   "holes": [ { "x": 3.88, "y": 4.85 }, ... ],
 *   "bull": { "x": 4.25, "y": 5.50 },
 *   "distanceYards": 100,
 *   "clickValueMoa": 0.25,
 *   "deadbandIn": 0.10,     // optional (default 0.10)
 *   "minShots": 3           // optional (default 3)
 * }
 */
app.post("/api/sec", (req, res) => {
  try {
    const holes = Array.isArray(req.body?.holes) ? req.body.holes : [];
    const bull = req.body?.bull;

    const distanceYards = Number(req.body?.distanceYards ?? 100);
    const clickValueMoa = Number(req.body?.clickValueMoa ?? 0.25);
    const deadbandIn = Number(req.body?.deadbandIn ?? 0.1);
    const minShots = Number(req.body?.minShots ?? 3);

    if (!bull || typeof bull.x !== "number" || typeof bull.y !== "number") {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "NO_BULL", message: "Provide bull {x,y} in inches." }
      });
    }

    if (!holes.length) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "NO_HOLES", message: "Provide holes[] in inches." }
      });
    }

    if (holes.length < minShots) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "NOT_ENOUGH_SHOTS", message: `Need at least ${minShots} holes.` }
      });
    }

    // validate holes
    const clean = holes
      .map(h => ({ x: Number(h.x), y: Number(h.y) }))
      .filter(h => Number.isFinite(h.x) && Number.isFinite(h.y));

    if (clean.length < minShots) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "BAD_HOLES", message: "holes[] must contain numeric x,y." }
      });
    }

    // POIB = mean of holes (simple, deterministic)
    const poibX = mean(clean.map(h => h.x));
    const poibY = mean(clean.map(h => h.y));

    // correction = bull - poib  (IN INCHES)
    const dxIn = bull.x - poibX;
    const dyIn = bull.y - poibY; // Y-DOWN LOCKED: dy>0 => DOWN

    // deadband: if inside deadband, treat as 0 correction
    const dxInDB = Math.abs(dxIn) < deadbandIn ? 0 : dxIn;
    const dyInDB = Math.abs(dyIn) < deadbandIn ? 0 : dyIn;

    // convert inches -> MOA -> clicks
    const ipm = inchesPerMOA(distanceYards);
    const windMoa = dxInDB / ipm;
    const elevMoa = dyInDB / ipm;

    const windClicks = windMoa / clickValueMoa;
    const elevClicks = elevMoa / clickValueMoa;

    const windClicksAbs = round2(Math.abs(windClicks));
    const elevClicksAbs = round2(Math.abs(elevClicks));

    const windDir = dirLR(dxInDB);
    const elevDir = dirUD_YDOWN(dyInDB);

    // Signed clicks (direction is in the label; sign is still returned for debugging/verification)
    const clicksSigned = {
      windage: round2(windClicks),
      elevation: round2(elevClicks)
    };

    const poib = { x: round2(poibX), y: round2(poibY) };
    const poibQuad = quadrantOfPoint_YDOWN(poib, bull);

    return res.json({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD,
      yAxisUsed: "down",
      clicksSigned,
      scopeClicks: {
        windage: `${windDir} ${windClicksAbs.toFixed(2)} clicks`,
        elevation: `${elevDir} ${elevClicksAbs.toFixed(2)} clicks`
      },
      debug: {
        bull: { x: bull.x, y: bull.y },
        poib,
        poibQuad,
        holesUsedCount: clean.length,
        deadbandIn,
        distanceYards,
        clickValueMoa,
        dxIn: round2(dxIn),
        dyIn: round2(dyIn),
        inchesPerMOA: round2(ipm)
      }
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      build: BUILD,
      error: { code: "SERVER_ERROR", message: String(err?.message || err) }
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`SCZN3 backend listening on ${PORT} (${BUILD})`));
