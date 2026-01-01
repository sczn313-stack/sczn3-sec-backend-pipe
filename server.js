const express = require("express");
const cors = require("cors");

const BUILD = "POIB_TO_BULL_YDOWN_LOCKED_V3";
const Y_AXIS_USED = "down";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function inchesPerMOA(distanceYards) {
  // True MOA: 1.047" at 100 yards
  return 1.047 * (Number(distanceYards) / 100);
}

function poibOf(holes) {
  const n = holes.length;
  let sx = 0, sy = 0;
  for (const h of holes) {
    sx += h.x;
    sy += h.y;
  }
  return { x: sx / n, y: sy / n };
}

function poibQuadYDown(poib, bull) {
  const left = poib.x < bull.x;
  const upper = poib.y < bull.y; // Y-down: smaller y is "upper"
  if (left && upper) return "UL";
  if (!left && upper) return "UR";
  if (left && !upper) return "LL";
  return "LR";
}

function labelSigned(value, posLabel, negLabel) {
  if (value > 0) return posLabel;
  if (value < 0) return negLabel;
  return "HOLD";
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "sczn3-sec-backend-pipe",
    build: BUILD,
    yAxisUsed: Y_AXIS_USED,
    status: "alive",
  });
});

app.post("/api/sec", (req, res) => {
  const body = req.body || {};
  const holes = Array.isArray(body.holes) ? body.holes : null;

  if (!holes || holes.length === 0) {
    return res.status(400).json({
      ok: false,
      build: BUILD,
      error: { code: "NO_HOLES", message: "Provide holes[] in inches." },
    });
  }

  for (const h of holes) {
    if (
      !h ||
      typeof h.x !== "number" ||
      typeof h.y !== "number" ||
      !Number.isFinite(h.x) ||
      !Number.isFinite(h.y)
    ) {
      return res.status(400).json({
        ok: false,
        build: BUILD,
        error: { code: "BAD_HOLES", message: "Each hole must have numeric x,y." },
      });
    }
  }

  const bull = body.bull || {};
  const bullX = Number(bull.x);
  const bullY = Number(bull.y);

  if (!Number.isFinite(bullX) || !Number.isFinite(bullY)) {
    return res.status(400).json({
      ok: false,
      build: BUILD,
      error: { code: "BAD_BULL", message: "Provide bull.x and bull.y in inches." },
    });
  }

  const distanceYards = Number(body.distanceYards ?? 100);
  const clickValueMoa = Number(body.clickValueMoa ?? 0.25);
  const deadbandIn = Number(body.deadbandIn ?? 0);

  const poib = poibOf(holes);

  // correction = bull - POIB (inches)
  const dxIn = bullX - poib.x;
  const dyIn = bullY - poib.y; // Y-down locked: +dy => DOWN

  const ips = inchesPerMOA(distanceYards);
  const moaX = dxIn / ips;
  const moaY = dyIn / ips;

  let clicksW = moaX / clickValueMoa;
  let clicksE = moaY / clickValueMoa;

  // deadband in inches (zero out small corrections)
  const dxDb = Math.abs(dxIn) <= deadbandIn ? 0 : dxIn;
  const dyDb = Math.abs(dyIn) <= deadbandIn ? 0 : dyIn;

  const moaXdb = dxDb / ips;
  const moaYdb = dyDb / ips;

  clicksW = moaXdb / clickValueMoa;
  clicksE = moaYdb / clickValueMoa;

  const windageDir = labelSigned(dxDb, "RIGHT", "LEFT");
  const elevationDir = labelSigned(dyDb, "DOWN", "UP"); // Y-down locked

  const windageClicksAbs = round2(Math.abs(clicksW));
  const elevationClicksAbs = round2(Math.abs(clicksE));

  const poibQuad = poibQuadYDown(poib, { x: bullX, y: bullY });

  return res.json({
    ok: true,
    service: "sczn3-sec-backend-pipe",
    build: BUILD,
    clicksSigned: {
      windage: windageClicksAbs,
      elevation: elevationClicksAbs,
    },
    scopeClicks: {
      windage: `${windageDir} ${windageClicksAbs.toFixed(2)} clicks`,
      elevation: `${elevationDir} ${elevationClicksAbs.toFixed(2)} clicks`,
    },
    debug: {
      yAxisUsed: Y_AXIS_USED,
      distanceYards,
      clickValueMoa,
      deadbandIn,
      inchesPerMOA: round2(ips),
      bull: { x: bullX, y: bullY },
      poib: { x: round2(poib.x), y: round2(poib.y) },
      poibQuad,
      dxIn: round2(dxIn),
      dyIn: round2(dyIn),
      holesUsedCount: holes.length,
    },
  });
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`SEC backend listening on ${port} (${BUILD})`);
});
