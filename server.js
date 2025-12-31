// server.js (SCZN3 — POIB -> Bull, locked Y=down, inches-only)
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const BUILD = "POIB_TO_BULL_LOCKED_YDOWN_V1";

const round2 = (n) => Math.round(n * 100) / 100;

function trueMoaInchesAt(distanceYards) {
  // True MOA: 1.047" at 100y
  return 1.047 * (distanceYards / 100);
}

function directionFromDeltaX(dx) {
  if (dx > 0) return "RIGHT";
  if (dx < 0) return "LEFT";
  return "NONE";
}

function directionFromDeltaY_YDOWN(dy) {
  // Y increases DOWN (top-left origin in inches)
  if (dy > 0) return "DOWN";
  if (dy < 0) return "UP";
  return "NONE";
}

function quadrantFromPOIB(poib, bull) {
  // quadrant relative to bull, using Y=down
  const left = poib.x < bull.x;
  const up = poib.y < bull.y;
  if (left && up) return "UL";
  if (!left && up) return "UR";
  if (left && !up) return "LL";
  return "LR";
}

// health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "sczn3-sec-backend-pipe", build: BUILD, status: "alive" });
});

// POST /api/sec
// Body example (in inches):
// {
//   "holes": [{"x":3.90,"y":4.85},{"x":3.88,"y":4.78}],
//   "bull": {"x":4.25,"y":5.50},
//   "distanceYards": 100,
//   "clickValueMoa": 0.25
// }
app.post("/api/sec", (req, res) => {
  try {
    const holes = Array.isArray(req.body?.holes) ? req.body.holes : null;
    const bull = req.body?.bull || { x: 4.25, y: 5.5 };

    const distanceYards = Number(req.body?.distanceYards ?? 100);
    const clickValueMoa = Number(req.body?.clickValueMoa ?? 0.25);

    if (!holes || holes.length < 1) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "NO_HOLES", message: "Provide holes[] in inches." },
      });
    }

    // compute POIB
    let sumX = 0, sumY = 0, used = 0;
    for (const h of holes) {
      const x = Number(h?.x);
      const y = Number(h?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      sumX += x;
      sumY += y;
      used++;
    }
    if (used === 0) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "BAD_HOLES", message: "holes must contain numeric x/y." },
      });
    }

    const poibX = sumX / used;
    const poibY = sumY / used;

    // move POIB -> bull
    const dxIn = bull.x - poibX;
    const dyIn = bull.y - poibY;

    // inches -> MOA -> clicks (True MOA)
    const moaPerInch = 1 / trueMoaInchesAt(distanceYards);
    const windMoa = Math.abs(dxIn) * moaPerInch;
    const elevMoa = Math.abs(dyIn) * moaPerInch;

    const windClicks = windMoa / clickValueMoa;
    const elevClicks = elevMoa / clickValueMoa;

    const windDir = directionFromDeltaX(dxIn);
    const elevDir = directionFromDeltaY_YDOWN(dyIn);

    const clicksSigned = {
      windage: round2(dxIn === 0 ? 0 : (dxIn > 0 ? windClicks : -windClicks)),
      elevation: round2(dyIn === 0 ? 0 : (dyIn > 0 ? elevClicks : -elevClicks)),
    };

    res.json({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD,
      clicksSigned,
      scopeClicks: {
        windage: `${windDir} ${round2(Math.abs(windClicks)).toFixed(2)} clicks`,
        elevation: `${elevDir} ${round2(Math.abs(elevClicks)).toFixed(2)} clicks`,
      },
      debug: {
        coordSystem: "inches_from_top_left (x=right+, y=down+)",
        bull: { x: round2(bull.x), y: round2(bull.y) },
        poib: { x: round2(poibX), y: round2(poibY) },
        poibQuad: quadrantFromPOIB({ x: poibX, y: poibY }, bull),
        usedCount: used,
        dxIn: round2(dxIn),
        dyIn: round2(dyIn),
        distanceYards,
        clickValueMoa,
      },
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      build: BUILD,
      error: { code: "SERVER_ERROR", message: String(err?.message || err) },
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`SEC backend listening on ${PORT} (${BUILD})`));
