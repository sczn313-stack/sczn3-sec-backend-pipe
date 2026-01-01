// server.js  (REPLACE THE WHOLE FILE)
// SCZN3 SEC Backend (PIPE) — POIB → BULL, Y axis = DOWN (screen coords), clicks output as RIGHT/LEFT + UP/DOWN
//
// Endpoints:
//   GET  /            -> alive JSON
//   GET  /health      -> alive JSON
//   POST /api/sec     -> compute from holes[] or poib{}, returns scopeClicks
//
// Payload (POST /api/sec):
// {
//   "targetSize": "8.5x11",
//   "distanceYards": 100,
//   "clickValueMoa": 0.25,
//   "deadbandInches": 0.10,
//   "bullX": 4.25,
//   "bullY": 5.50,
//   "holes": [{"x":3.9,"y":4.8},{"x":3.95,"y":4.78}]
//   // OR: "poib": {"x":3.94,"y":4.80}
// }

const express = require("express");
const cors = require("cors");

const SERVICE_NAME = "sczn3-sec-backend-pipe";
const BUILD = "POIB_TO_BULL_TRUE_MOA_TAP_HOLES_V2__YDOWN__ELEV_UP_WHEN_POIB_BELOW";

const app = express();

// ---- CORS + JSON parsing ----
app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.options("*", cors());
app.use(express.json({ limit: "2mb" }));

// ---- helpers ----
function num(v) {
  if (v === null || v === undefined) return NaN;
  const n = typeof v === "string" ? Number(v.trim()) : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function meanPoint(holes) {
  let sx = 0, sy = 0, c = 0;
  for (const h of holes) {
    const x = num(h?.x);
    const y = num(h?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x; sy += y; c++;
  }
  if (c === 0) return null;
  return { x: sx / c, y: sy / c };
}

// Y axis used: "down" (increasing y = moving DOWN on the screen/paper image)
function quadrantFromDeltas(dx, dy) {
  // dx: + means POIB RIGHT of bull
  // dy: + means POIB BELOW bull (because Y is down)
  if (dx < 0 && dy < 0) return "UL";
  if (dx > 0 && dy < 0) return "UR";
  if (dx < 0 && dy > 0) return "LL";
  if (dx > 0 && dy > 0) return "LR";
  if (dx === 0 && dy === 0) return "CENTER";
  if (dx === 0) return dy < 0 ? "UP" : "DOWN";
  if (dy === 0) return dx < 0 ? "LEFT" : "RIGHT";
  return "UNKNOWN";
}

function labelFromSignedWindage(w) {
  if (!Number.isFinite(w) || w === 0) return "0.00 clicks";
  return w > 0 ? `RIGHT ${round2(Math.abs(w))} clicks` : `LEFT ${round2(Math.abs(w))} clicks`;
}

function labelFromSignedElevation(e) {
  if (!Number.isFinite(e) || e === 0) return "0.00 clicks";
  return e > 0 ? `UP ${round2(Math.abs(e))} clicks` : `DOWN ${round2(Math.abs(e))} clicks`;
}

// ---- alive endpoints ----
function aliveJson() {
  return {
    ok: true,
    service: SERVICE_NAME,
    status: "alive",
    build: BUILD,
    yAxisUsed: "down",
    hint: "Use GET /health or POST /api/sec"
  };
}

app.get("/", (req, res) => res.json(aliveJson()));
app.get("/health", (req, res) => res.json(aliveJson()));

// ---- guard GET on compute route ----
app.get("/api/sec", (req, res) => {
  return res.status(405).json({
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
      holes: [{ x: 3.9, y: 4.8 }]
    }
  });
});

// ---- compute ----
app.post("/api/sec", (req, res) => {
  try {
    const b = req.body || {};

    const targetSize = (b.targetSize || "8.5x11").toString();
    const distanceYards = num(b.distanceYards);
    const clickValueMoa = num(b.clickValueMoa);
    const deadbandInches = num(b.deadbandInches);

    const bullX = num(b.bullX);
    const bullY = num(b.bullY);

    const holes = Array.isArray(b.holes) ? b.holes : null;
    const poibIn = b.poib && typeof b.poib === "object" ? { x: num(b.poib.x), y: num(b.poib.y) } : null;

    if (!Number.isFinite(distanceYards) || distanceYards <= 0) {
      return res.status(400).json({ ok: false, error: "BAD_INPUT", message: "distanceYards must be a positive number.", build: BUILD, yAxisUsed: "down" });
    }
    if (!Number.isFinite(clickValueMoa) || clickValueMoa <= 0) {
      return res.status(400).json({ ok: false, error: "BAD_INPUT", message: "clickValueMoa must be a positive number (e.g., 0.25).", build: BUILD, yAxisUsed: "down" });
    }
    if (!Number.isFinite(deadbandInches) || deadbandInches < 0) {
      return res.status(400).json({ ok: false, error: "BAD_INPUT", message: "deadbandInches must be >= 0.", build: BUILD, yAxisUsed: "down" });
    }
    if (!Number.isFinite(bullX) || !Number.isFinite(bullY)) {
      return res.status(400).json({ ok: false, error: "BAD_INPUT", message: "Provide bullX and bullY (numbers).", build: BUILD, yAxisUsed: "down" });
    }

    // Determine POIB
    let poib = null;
    if (poibIn && Number.isFinite(poibIn.x) && Number.isFinite(poibIn.y)) {
      poib = poibIn;
    } else if (holes) {
      poib = meanPoint(holes);
    }

    if (!poib) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_INPUT",
        message: "Provide holes[] or poib{}.",
        build: BUILD,
        yAxisUsed: "down"
      });
    }

    // True MOA at distance: 1.047" at 100y
    const inchesPerMOA = (distanceYards / 100) * 1.047;
    const inchesPerClick = inchesPerMOA * clickValueMoa;

    // Deltas in inches (Y axis DOWN):
    // dx: + means POIB is RIGHT of bull
    // dy: + means POIB is BELOW bull
    const dxIn = poib.x - bullX;
    const dyIn = poib.y - bullY;

    // deadband
    const dxAdj = Math.abs(dxIn) < deadbandInches ? 0 : dxIn;
    const dyAdj = Math.abs(dyIn) < deadbandInches ? 0 : dyIn;

    // Signed clicks where:
    //   windageSigned > 0 => RIGHT
    //   elevationSigned > 0 => UP
    //
    // If POIB is RIGHT (dxAdj > 0), to move POIB to bull you dial LEFT => negative.
    // If POIB is BELOW (dyAdj > 0), to move POIB to bull you dial UP   => positive.
    const windageSigned = dxAdj === 0 ? 0 : -(dxAdj / inchesPerClick);
    const elevationSigned = dyAdj === 0 ? 0 : (dyAdj / inchesPerClick);

    const out = {
      ok: true,
      service: SERVICE_NAME,
      build: BUILD,

      // keep your axis convention explicit
      yAxisUsed: "down",

      // numeric outputs (2 decimals)
      clicksSigned: {
        windage: round2(windageSigned),
        elevation: round2(elevationSigned)
      },

      // human-readable
      scopeClicks: {
        windage: labelFromSignedWindage(windageSigned),
        elevation: labelFromSignedElevation(elevationSigned)
      },

      // helpful debug (you can remove later)
      debug: {
        targetSize,
        distanceYards,
        clickValueMoa,
        deadbandInches,
        inchesPerMOA: round2(inchesPerMOA),
        inchesPerClick: round2(inchesPerClick),
        bull: { x: bullX, y: bullY },
        poib: { x: round2(poib.x), y: round2(poib.y) },
        deltasInches: { dx: round2(dxIn), dy: round2(dyIn) },
        poibQuad: quadrantFromDeltas(dxIn, dyIn)
      }
    };

    return res.json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      message: err && err.message ? err.message : "Unknown server error",
      build: BUILD,
      yAxisUsed: "down"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] listening on ${PORT} :: build=${BUILD}`);
});
