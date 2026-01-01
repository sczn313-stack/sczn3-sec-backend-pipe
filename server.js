/**
 * SCZN3 Backend (Pipe) — server.js
 * Convention LOCKED:
 *  - X increases to the RIGHT
 *  - Y increases DOWN the page (top=0)
 *  - clicksSigned:
 *      windage  + = RIGHT,  - = LEFT
 *      elevation+ = UP,     - = DOWN
 *
 * So:
 *  dx = poib.x - bull.x   ( + means POIB right of bull )
 *  dy = poib.y - bull.y   ( + means POIB below bull )
 *
 * Needed correction (move POIB to bull):
 *  windageSigned   = -dx / inchesPerClick   (right if POIB is left)
 *  elevationSigned =  dy / inchesPerClick   (up if POIB is low)
 */

const express = require("express");
const cors = require("cors");

const app = express();

const SERVICE_NAME = "sczn3-sec-backend-pipe";
const BUILD = process.env.BUILD_TAG || "POIB_TO_BULL_YDOWN_LOCKED_V4";
const Y_AXIS_USED = "down"; // locked

app.use(cors({ origin: true }));
app.use(express.json({ limit: "5mb" }));

// ---------- helpers ----------
function isNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function clampMin(n, min) {
  return n < min ? min : n;
}

function computePOIBFromHoles(holes) {
  const xs = holes.map((h) => h.x);
  const ys = holes.map((h) => h.y);
  const x = xs.reduce((a, b) => a + b, 0) / xs.length;
  const y = ys.reduce((a, b) => a + b, 0) / ys.length;
  return { x, y };
}

function getQuadrant(dx, dy) {
  // dy<0 = above bull; dy>0 = below bull (because Y increases DOWN)
  if (dx < 0 && dy < 0) return "UL";
  if (dx > 0 && dy < 0) return "UR";
  if (dx < 0 && dy > 0) return "LL";
  if (dx > 0 && dy > 0) return "LR";
  // axis-aligned cases:
  if (dx === 0 && dy < 0) return "U";
  if (dx === 0 && dy > 0) return "D";
  if (dx < 0 && dy === 0) return "L";
  if (dx > 0 && dy === 0) return "R";
  return "CENTER";
}

function labelFromSignedWindage(w) {
  if (w > 0) return "RIGHT";
  if (w < 0) return "LEFT";
  return "HOLD";
}

function labelFromSignedElevation(e) {
  if (e > 0) return "UP";
  if (e < 0) return "DOWN";
  return "HOLD";
}

// ---------- routes ----------
app.get("/", (_req, res) => {
  // so you never see "Cannot GET /" again
  res.json({
    ok: true,
    service: SERVICE_NAME,
    build: BUILD,
    yAxisUsed: Y_AXIS_USED,
    hint: "Use GET /health or POST /api/sec",
    status: "alive",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    build: BUILD,
    yAxisUsed: Y_AXIS_USED,
    status: "alive",
  });
});

// Helpful guard (people keep opening /api/sec in a browser)
app.get("/api/sec", (_req, res) => {
  res.status(405).json({
    ok: false,
    error: "METHOD_NOT_ALLOWED",
    message: "Use POST /api/sec (JSON body).",
  });
});

/**
 * POST /api/sec
 * Accepts either:
 *  A) holes: [{x,y}, ...]  (inches)
 *  OR
 *  B) poib: {x,y}          (inches)
 *
 * Required:
 *  bull: {x,y} (inches)
 *  distanceYards (number)
 *  clickValueMoa (number) e.g. 0.25
 *
 * Optional:
 *  deadbandInches (number) default 0
 *  targetSizeSpec (string) (e.g., "8.5x11")
 *  targetSizeInches: {widthIn,heightIn,longIn,shortIn}
 */
app.post("/api/sec", (req, res) => {
  try {
    const body = req.body || {};

    const distanceYards = Number(body.distanceYards);
    const clickValueMoa = Number(body.clickValueMoa);
    const deadbandInches = body.deadbandInches == null ? 0 : Number(body.deadbandInches);

    const bull = body.bull || {};
    const bullX = Number(bull.x);
    const bullY = Number(bull.y);

    if (!isNum(distanceYards) || distanceYards <= 0) {
      return res.status(400).json({ ok: false, error: "BAD_DISTANCE_YARDS" });
    }
    if (!isNum(clickValueMoa) || clickValueMoa <= 0) {
      return res.status(400).json({ ok: false, error: "BAD_CLICK_VALUE_MOA" });
    }
    if (!isNum(bullX) || !isNum(bullY)) {
      return res.status(400).json({ ok: false, error: "BAD_BULL" });
    }
    if (!isNum(deadbandInches) || deadbandInches < 0) {
      return res.status(400).json({ ok: false, error: "BAD_DEADBAND" });
    }

    let holes = null;
    let poib = null;

    if (Array.isArray(body.holes) && body.holes.length > 0) {
      // validate holes
      const cleaned = [];
      for (const h of body.holes) {
        if (!h || typeof h !== "object") continue;
        const x = Number(h.x);
        const y = Number(h.y);
        if (isNum(x) && isNum(y)) cleaned.push({ x, y });
      }
      if (cleaned.length === 0) {
        return res.status(400).json({ ok: false, error: "BAD_HOLES" });
      }
      holes = cleaned;
      poib = computePOIBFromHoles(cleaned);
    } else if (body.poib && typeof body.poib === "object") {
      const x = Number(body.poib.x);
      const y = Number(body.poib.y);
      if (!isNum(x) || !isNum(y)) {
        return res.status(400).json({ ok: false, error: "BAD_POIB" });
      }
      poib = { x, y };
    } else {
      return res.status(400).json({
        ok: false,
        error: "MISSING_INPUT",
        message: "Provide holes[] or poib{}.",
      });
    }

    // inches per MOA at distance (1.047" @ 100y)
    const inchesPerMOA = (distanceYards / 100) * 1.047;
    const inchesPerClick = inchesPerMOA * clickValueMoa;

    const dxIn = poib.x - bullX; // + = POIB right
    const dyIn = poib.y - bullY; // + = POIB below (Y down)

    // Apply deadband (inches) — if within deadband, treat as 0
    const dxAdj = Math.abs(dxIn) < deadbandInches ? 0 : dxIn;
    const dyAdj = Math.abs(dyIn) < deadbandInches ? 0 : dyIn;

    // Signed clicks (LOCKED convention)
    const windageSigned = dxAdj === 0 ? 0 : (-dxAdj / inchesPerClick);
    const elevationSigned = dyAdj === 0 ? 0 : (dyAdj / inchesPerClick);

    const windageLabel = labelFromSignedWindage(windageSigned);
    const elevationLabel = labelFromSignedElevation(elevationSigned);

    const windageClicksAbs = Math.abs(windageSigned);
    const elevationClicksAbs = Math.abs(elevationSigned);

    const poibQuad = getQuadrant(dxIn === 0 ? 0 : dxIn, dyIn === 0 ? 0 : dyIn);

    const out = {
      ok: true,
      service: SERVICE_NAME,
      build: BUILD,

      clicksSigned: {
        // keep your historical shape: positive means RIGHT / UP
        windage: round2(windageClicksAbs * (windageSigned < 0 ? -1 : 1)),
        elevation: round2(elevationClicksAbs * (elevationSigned < 0 ? -1 : 1)),
      },

      scopeClicks: {
        windage: `${windageLabel} ${round2(windageClicksAbs)} clicks`,
        elevation: `${elevationLabel} ${round2(elevationClicksAbs)} clicks`,
      },

      debug: {
        yAxisUsed: Y_AXIS_USED,
        distanceYards,
        clickValueMoa,
        deadbandInches,
        inchesPerMOA: round2(inchesPerMOA),
        inchesPerClick: round2(inchesPerClick),
        bull: { x: bullX, y: bullY },
        poib: { x: round2(poib.x), y: round2(poib.y) },
        dxIn: round2(dxIn),
        dyIn: round2(dyIn),
        poibQuad,
        holesUsedCount: holes ? holes.length : 0,
        targetSizeSpec: body.targetSizeSpec || null,
        targetSizeInches: body.targetSizeInches || null,
        note:
          "LOCKED: X right, Y down. Windage: POIB left=>RIGHT (+). Elevation: POIB low=>UP (+).",
      },
    };

    return res.json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      message: err && err.message ? err.message : "Unknown error",
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] listening on ${PORT} | build=${BUILD} | yAxisUsed=${Y_AXIS_USED}`);
});
