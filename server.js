// server.js (REPLACE WHOLE FILE)
const express = require("express");
const cors = require("cors");

const SERVICE_NAME = "sczn3-sec-backend-pipe";
const BUILD = "POIB_TO_BULL_TRUE_MOA_TAP_HOLES_V2__YDOWN__ELEV_UP_WHEN_POIB_BELOW";
const Y_AXIS_USED = "down"; // IMPORTANT: y increases downward (screen/paper top->down)

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

function round2(n) {
  return Math.round(n * 100) / 100;
}
function isNum(n) {
  return Number.isFinite(n);
}

function labelFromSignedWindage(wSigned) {
  const abs = Math.abs(wSigned);
  if (abs === 0) return "0.00";
  return `${wSigned > 0 ? "RIGHT" : "LEFT"} ${round2(abs).toFixed(2)} clicks`;
}

function labelFromSignedElevation(eSigned) {
  const abs = Math.abs(eSigned);
  if (abs === 0) return "0.00";
  return `${eSigned > 0 ? "UP" : "DOWN"} ${round2(abs).toFixed(2)} clicks`;
}

function computePOIBFromHoles(holes) {
  if (!Array.isArray(holes) || holes.length === 0) return null;

  let sx = 0;
  let sy = 0;
  let c = 0;

  for (const h of holes) {
    const x = Number(h?.x);
    const y = Number(h?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x;
    sy += y;
    c += 1;
  }

  if (c === 0) return null;
  return { x: sx / c, y: sy / c };
}

// Root: makes it obvious backend is alive (prevents “Cannot GET /” confusion)
app.get("/", (req, res) => {
  return res.json({
    ok: true,
    service: SERVICE_NAME,
    status: "alive",
    build: BUILD,
    yAxisUsed: Y_AXIS_USED,
    hint: "Use GET /health or POST /api/sec",
  });
});

app.get("/health", (req, res) => {
  return res.json({
    ok: true,
    service: SERVICE_NAME,
    status: "alive",
    build: BUILD,
    yAxisUsed: Y_AXIS_USED,
    hint: "Use GET /health or POST /api/sec",
  });
});

// Helpful: if someone tries GET /api/sec in browser
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
      holes: [{ x: 3.9, y: 4.8 }],
    },
  });
});

app.post("/api/sec", (req, res) => {
  try {
    const body = req.body || {};

    const targetSize = String(body.targetSize || "8.5x11");
    const distanceYards = Number(body.distanceYards);
    const clickValueMoa = Number(body.clickValueMoa);
    const deadbandInches = Number(body.deadbandInches ?? 0);

    const bullX = Number(body.bullX);
    const bullY = Number(body.bullY);

    if (!isNum(distanceYards) || distanceYards <= 0) {
      return res.status(400).json({
        ok: false,
        error: "BAD_INPUT",
        message: "distanceYards must be a positive number.",
        build: BUILD,
        yAxisUsed: Y_AXIS_USED,
      });
    }
    if (!isNum(clickValueMoa) || clickValueMoa <= 0) {
      return res.status(400).json({
        ok: false,
        error: "BAD_INPUT",
        message: "clickValueMoa must be a positive number (example 0.25).",
        build: BUILD,
        yAxisUsed: Y_AXIS_USED,
      });
    }
    if (!isNum(deadbandInches) || deadbandInches < 0) {
      return res.status(400).json({
        ok: false,
        error: "BAD_INPUT",
        message: "deadbandInches must be 0 or greater.",
        build: BUILD,
        yAxisUsed: Y_AXIS_USED,
      });
    }
    if (!isNum(bullX) || !isNum(bullY)) {
      return res.status(400).json({
        ok: false,
        error: "BAD_INPUT",
        message: "bullX and bullY must be numeric.",
        build: BUILD,
        yAxisUsed: Y_AXIS_USED,
      });
    }

    // POIB can come from holes[] or direct poib{}
    let poib = null;

    if (Array.isArray(body.holes)) {
      poib = computePOIBFromHoles(body.holes);
      if (!poib) {
        return res.status(400).json({
          ok: false,
          error: "MISSING_INPUT",
          message: "holes[] provided but no valid {x,y} entries found.",
          build: BUILD,
          yAxisUsed: Y_AXIS_USED,
        });
      }
    } else if (body.poib && typeof body.poib === "object") {
      const px = Number(body.poib.x);
      const py = Number(body.poib.y);
      if (!isNum(px) || !isNum(py)) {
        return res.status(400).json({
          ok: false,
          error: "BAD_INPUT",
          message: "poib must include numeric x and y.",
          build: BUILD,
          yAxisUsed: Y_AXIS_USED,
        });
      }
      poib = { x: px, y: py };
    } else {
      return res.status(400).json({
        ok: false,
        error: "MISSING_INPUT",
        message: "Provide holes[] or poib{}.",
        build: BUILD,
        yAxisUsed: Y_AXIS_USED,
      });
    }

    // TRUE MOA: 1.047" @ 100 yards
    const inchesPerMOA = (distanceYards / 100) * 1.047;
    const inchesPerClick = inchesPerMOA * clickValueMoa;

    // dx,dy measured in inches from bull to POIB
    // +dx = POIB RIGHT of bull
    // +dy = POIB BELOW bull (because Y axis is DOWN)
    const dxIn = poib.x - bullX;
    const dyIn = poib.y - bullY;

    // Deadband (inches): if within deadband treat as 0
    const dxAdj = Math.abs(dxIn) < deadbandInches ? 0 : dxIn;
    const dyAdj = Math.abs(dyIn) < deadbandInches ? 0 : dyIn;

    // Signed clicks convention:
    // +windage = RIGHT clicks
    // +elevation = UP clicks
    //
    // To move POIB to bull:
    // If POIB is RIGHT (+dx) -> need LEFT -> negative windage
    // If POIB is BELOW (+dy) -> need UP -> positive elevation
    const windageSigned = dxAdj === 0 ? 0 : -(dxAdj / inchesPerClick);
    const elevationSigned = dyAdj === 0 ? 0 : (dyAdj / inchesPerClick);

    const out = {
      ok: true,
      service: SERVICE_NAME,
      status: "alive",
      build: BUILD,
      yAxisUsed: Y_AXIS_USED,

      clicksSigned: {
        windage: round2(windageSigned),
        elevation: round2(elevationSigned),
      },

      scopeClicks: {
        windage: labelFromSignedWindage(windageSigned),
        elevation: labelFromSignedElevation(elevationSigned),
      },

      debug: {
        targetSize,
        distanceYards,
        clickValueMoa,
        deadbandInches,
        inchesPerMOA: round2(inchesPerMOA),
        inchesPerClick: round2(inchesPerClick),
        bull: { x: bullX, y: bullY },
        poib: { x: round2(poib.x), y: round2(poib.y) },
        dxIn: round2(dxIn),
        dyIn: round2(dyIn),
      },
    };

    return res.json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      message: err && err.message ? err.message : "Unknown server error.",
      build: BUILD,
      yAxisUsed: Y_AXIS_USED,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] listening on ${PORT} :: ${BUILD}`);
});
