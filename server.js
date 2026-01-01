/* server.js - SCZN3 SEC backend (single-file, copy/paste)
   Supports:
   - GET  /            -> status JSON
   - GET  /health      -> status JSON
   - GET  /api/sec     -> METHOD_NOT_ALLOWED + example
   - POST /api/sec     -> compute clicks using inches-only
     Accepts JSON or multipart/form-data with:
       - payload: JSON string
       - image: optional file (ignored for now)
*/

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const SERVICE_NAME = "sczn3-sec-backend-pipe";
const BUILD = "POIB_TO_BULL_TRUE_MOA_TAP_HOLES_V2__YDOWN__ELEV_UP_WHEN_POIB_BELOW";
const Y_AXIS_USED = "down";

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function asNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseTargetSize(sizeStr) {
  const s = String(sizeStr || "").toLowerCase().trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)$/);
  if (!m) return { widthIn: 8.5, heightIn: 11 };
  return { widthIn: Number(m[1]), heightIn: Number(m[2]) };
}

function computePoibFromHoles(holes) {
  const pts = Array.isArray(holes) ? holes : [];
  const clean = pts
    .map((p) => ({
      x: Number(p && p.x),
      y: Number(p && p.y),
    }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  if (clean.length === 0) return null;

  const sx = clean.reduce((a, p) => a + p.x, 0);
  const sy = clean.reduce((a, p) => a + p.y, 0);

  return {
    x: sx / clean.length,
    y: sy / clean.length,
    n: clean.length,
  };
}

function labelWindageFromDx(dxIn) {
  // dx = poib.x - bullX
  // if POIB is LEFT of bull (dx < 0), dial RIGHT
  // if POIB is RIGHT of bull (dx > 0), dial LEFT
  if (dxIn < 0) return "RIGHT";
  if (dxIn > 0) return "LEFT";
  return "NONE";
}

function labelElevationFromDy(dyIn) {
  // Y axis is DOWN
  // dy = poib.y - bullY
  // if POIB is BELOW bull (dy > 0), dial UP
  // if POIB is ABOVE bull (dy < 0), dial DOWN
  if (dyIn > 0) return "UP";
  if (dyIn < 0) return "DOWN";
  return "NONE";
}

function makeStatus(extra) {
  return Object.assign(
    {
      ok: true,
      service: SERVICE_NAME,
      status: "alive",
      build: BUILD,
      yAxisUsed: Y_AXIS_USED,
      hint: "Use GET /health or POST /api/sec",
    },
    extra || {}
  );
}

app.get("/", (req, res) => res.json(makeStatus({ path: "/" })));
app.get("/health", (req, res) => res.json(makeStatus({ path: "/health" })));

app.get("/api/sec", (req, res) => {
  return res.status(405).json({
    ok: false,
    error: "METHOD_NOT_ALLOWED",
    message: "Use POST /api/sec",
    build: BUILD,
    yAxisUsed: Y_AXIS_USED,
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

app.post("/api/sec", upload.single("image"), (req, res) => {
  try {
    let body = req.body || {};

    // Accept multipart with `payload` JSON string
    if (typeof body.payload === "string") {
      try {
        body = JSON.parse(body.payload);
      } catch {
        return res.status(400).json({
          ok: false,
          error: "BAD_PAYLOAD",
          message: "payload must be valid JSON",
          build: BUILD,
          yAxisUsed: Y_AXIS_USED,
        });
      }
    }

    const targetSize = body.targetSize || "8.5x11";
    const size = parseTargetSize(targetSize);

    const distanceYards = asNum(body.distanceYards, null);
    const clickValueMoa = asNum(body.clickValueMoa, null);
    const deadbandInches = asNum(body.deadbandInches, 0);

    const bullX = asNum(body.bullX, null);
    const bullY = asNum(body.bullY, null);

    let poib = body.poib && typeof body.poib === "object" ? body.poib : null;
    const holes = Array.isArray(body.holes) ? body.holes : null;

    if (!poib && holes) {
      const poibFromHoles = computePoibFromHoles(holes);
      if (poibFromHoles) poib = { x: poibFromHoles.x, y: poibFromHoles.y };
    }

    if (
      distanceYards == null ||
      clickValueMoa == null ||
      bullX == null ||
      bullY == null ||
      !poib ||
      !Number.isFinite(Number(poib.x)) ||
      !Number.isFinite(Number(poib.y))
    ) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_INPUT",
        message:
          "Provide poib{x,y} or holes[], plus bullX, bullY, distanceYards, clickValueMoa. deadbandInches optional.",
        build: BUILD,
        yAxisUsed: Y_AXIS_USED,
      });
    }

    const poibX = Number(poib.x);
    const poibY = Number(poib.y);

    const dxIn = poibX - bullX; // + means POIB right of bull
    const dyIn = poibY - bullY; // + means POIB below bull (Y down)

    // deadband
    const dxAdj = Math.abs(dxIn) < deadbandInches ? 0 : dxIn;
    const dyAdj = Math.abs(dyIn) < deadbandInches ? 0 : dyIn;

    // inches per MOA at distance (1.047" at 100y)
    const inchesPerMOA = (distanceYards / 100) * 1.047;
    const inchesPerClick = inchesPerMOA * clickValueMoa;

    const windageDir = labelWindageFromDx(dxAdj);
    const elevationDir = labelElevationFromDy(dyAdj);

    const windageClicksAbs = inchesPerClick === 0 ? 0 : Math.abs(dxAdj) / inchesPerClick;
    const elevationClicksAbs = inchesPerClick === 0 ? 0 : Math.abs(dyAdj) / inchesPerClick;

    // Signed convention: positive means RIGHT/UP; negative means LEFT/DOWN
    const windageSigned =
      windageDir === "RIGHT" ? windageClicksAbs : windageDir === "LEFT" ? -windageClicksAbs : 0;

    const elevationSigned =
      elevationDir === "UP" ? elevationClicksAbs : elevationDir === "DOWN" ? -elevationClicksAbs : 0;

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
        windage:
          windageDir === "NONE"
            ? "NONE 0.00 clicks"
            : `${windageDir} ${round2(windageClicksAbs)} clicks`,
        elevation:
          elevationDir === "NONE"
            ? "NONE 0.00 clicks"
            : `${elevationDir} ${round2(elevationClicksAbs)} clicks`,
      },

      debug: {
        targetSize,
        targetSizeInches: size,
        distanceYards,
        clickValueMoa,
        deadbandInches,
        inchesPerMOA: round2(inchesPerMOA),
        inchesPerClick: round2(inchesPerClick),
        bull: { x: bullX, y: bullY },
        poib: { x: round2(poibX), y: round2(poibY) },
        dxIn: round2(dxIn),
        dyIn: round2(dyIn),
        dxAdj: round2(dxAdj),
        dyAdj: round2(dyAdj),
        hasImage: !!req.file,
        holesCount: Array.isArray(holes) ? holes.length : 0,
      },
    };

    return res.json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      message: err && err.message ? err.message : "Unknown server error",
      build: BUILD,
      yAxisUsed: Y_AXIS_USED,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] listening on ${PORT} :: ${BUILD}`);
});
