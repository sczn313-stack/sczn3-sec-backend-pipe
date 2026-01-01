import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const BUILD = "POIB_TO_BULL_TRUE_MOA_TAP_HOLES_V1";
const Y_AXIS_USED = "down"; // top=0, increasing downward

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function abs2(n) {
  return round2(Math.abs(n));
}

function getTargetSize(spec) {
  if (spec === "8.5x11") return { widthIn: 8.5, heightIn: 11.0, longIn: 11.0, shortIn: 8.5 };
  return null;
}

function inchesPerMOA(distanceYards) {
  // True MOA: 1 MOA = 1.047" at 100 yards
  return 1.047 * (distanceYards / 100);
}

function poibFromHoles(holes) {
  const n = holes.length;
  const sum = holes.reduce(
    (acc, h) => {
      acc.x += h.x;
      acc.y += h.y;
      return acc;
    },
    { x: 0, y: 0 }
  );
  return { x: sum.x / n, y: sum.y / n };
}

function quadrantFromBull(poib, bull) {
  const left = poib.x < bull.x;
  const above = poib.y < bull.y; // yAxisUsed=down
  if (left && above) return "UL";
  if (!left && above) return "UR";
  if (left && !above) return "LL";
  return "LR";
}

function holeQuadrant(h, bull) {
  const left = h.x < bull.x;
  const above = h.y < bull.y;
  if (left && above) return "UL";
  if (!left && above) return "UR";
  if (left && !above) return "LL";
  return "LR";
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "sczn3-sec-backend-pipe", status: "alive", build: BUILD });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "sczn3-sec-backend-pipe",
    status: "alive",
    build: BUILD,
    yAxisUsed: Y_AXIS_USED,
  });
});

app.post("/api/sec", (req, res) => {
  try {
    const body = req.body || {};

    const targetSizeSpec = String(body.targetSizeSpec || "8.5x11");
    const targetSizeInches = getTargetSize(targetSizeSpec);
    if (!targetSizeInches) {
      return res.status(400).json({ ok: false, error: `Unsupported targetSizeSpec: ${targetSizeSpec}` });
    }

    const distanceYards = toNum(body.distanceYards, 100);
    const clickValueMoa = toNum(body.clickValueMoa, 0.25);
    const deadbandIn = toNum(body.deadbandIn, 0.1);

    if (!distanceYards || distanceYards <= 0) {
      return res.status(400).json({ ok: false, error: "distanceYards must be > 0" });
    }
    if (!clickValueMoa || clickValueMoa <= 0) {
      return res.status(400).json({ ok: false, error: "clickValueMoa must be > 0" });
    }

    const bull = {
      x: toNum(body?.bull?.x, 4.25),
      y: toNum(body?.bull?.y, 5.5),
    };

    const holesInches = Array.isArray(body.holesInches) ? body.holesInches : [];
    const holes = holesInches
      .map((h) => ({ x: toNum(h?.x, null), y: toNum(h?.y, null) }))
      .filter((h) => h.x !== null && h.y !== null);

    if (holes.length < 3) {
      return res.status(400).json({
        ok: false,
        error: "Need at least 3 holes. Use the frontend: upload image and tap to add holes.",
      });
    }

    const poib = poibFromHoles(holes);

    // correction = bull - POIB
    const dxIn = bull.x - poib.x;
    const dyIn = bull.y - poib.y;

    // deadband
    const dxInDB = Math.abs(dxIn) <= deadbandIn ? 0 : dxIn;
    const dyInDB = Math.abs(dyIn) <= deadbandIn ? 0 : dyIn;

    const ipm = inchesPerMOA(distanceYards);

    const windageClicksRaw = (dxInDB / ipm) / clickValueMoa;
    const elevationClicksRaw = (dyInDB / ipm) / clickValueMoa;

    const windageDir = dxInDB > 0 ? "RIGHT" : dxInDB < 0 ? "LEFT" : "HOLD";
    const elevationDir = dyInDB > 0 ? "UP" : dyInDB < 0 ? "DOWN" : "HOLD";

    const windageClicks = abs2(windageClicksRaw);
    const elevationClicks = abs2(elevationClicksRaw);

    const poibQuad = quadrantFromBull(poib, bull);

    const uniqueHoleQuadrants = Array.from(new Set(holes.map((h) => holeQuadrant(h, bull))));

    return res.json({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD,
      clicksSigned: {
        windage: windageClicks,
        elevation: elevationClicks,
      },
      scopeClicks: {
        windage: `${windageDir} ${windageClicks.toFixed(2)} clicks`,
        elevation: `${elevationDir} ${elevationClicks.toFixed(2)} clicks`,
      },
      debug: {
        yAxisUsed: Y_AXIS_USED,
        targetSizeSpec,
        targetSizeInches,
        distanceYards,
        clickValueMoa,
        inchesPerMOA: round2(ipm),
        deadbandIn,
        bull,
        poib: { x: round2(poib.x), y: round2(poib.y) },
        poibQuad,
        uniqueHoleQuadrants,
        holesUsedCount: holes.length,
        dxIn: round2(dxIn),
        dyIn: round2(dyIn),
        note: 'Correction is bull - POIB. Y axis is "down". dy>0 => UP, dy<0 => DOWN.',
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SCZN3 SEC backend running on ${PORT} (${BUILD})`);
});
