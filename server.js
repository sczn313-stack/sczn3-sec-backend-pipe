/**
 * SCZN3 SEC Backend — server.js
 * Convention (LOCKED):
 *  - Units: inches
 *  - X: RIGHT is positive
 *  - Y: DOWN is positive (canvas / image-space)
 *  - Correction: bull - POIB (move POIB to bull)
 *  - Windage sign: + = RIGHT, - = LEFT
 *  - Elevation sign: + = DOWN,  - = UP   (because Y increases DOWN)
 *  - poibQuad is computed using the same Y-DOWN convention
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const BUILD = "POIB_TO_BULL_YDOWN_CLEAN_V1";

// ---------- helpers ----------
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseJSONMaybe(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// Accepts "8.5x11", "8.5×11", "8.5 X 11", "8.5,11", etc.
function parseSizeSpec(spec) {
  if (!spec || typeof spec !== "string") return null;
  const s = spec
    .trim()
    .toLowerCase()
    .replace("×", "x")
    .replace(/\s+/g, "")
    .replace(/,/g, "x");

  const m = s.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (!m) return null;

  const a = asNumber(m[1]);
  const b = asNumber(m[2]);
  if (a == null || b == null) return null;

  return {
    spec: `${a}x${b}`,
    widthIn: a,
    heightIn: b,
    longIn: Math.max(a, b),
    shortIn: Math.min(a, b),
  };
}

function normalizeBull(bull, defaults) {
  const bx = asNumber(bull?.x);
  const by = asNumber(bull?.y);
  return {
    x: bx != null ? bx : defaults.x,
    y: by != null ? by : defaults.y,
  };
}

function quadrantOfPoint_YDOWN(pt, bull, deadbandIn = 0) {
  // dx, dy are point relative to bull in Y-DOWN space
  const dx = pt.x - bull.x; // + right, - left
  const dy = pt.y - bull.y; // + below, - above (because y increases down)

  if (Math.abs(dx) <= deadbandIn && Math.abs(dy) <= deadbandIn) return "ON";
  if (Math.abs(dx) <= deadbandIn) return dy < 0 ? "U" : "L"; // on vertical line
  if (Math.abs(dy) <= deadbandIn) return dx < 0 ? "L" : "R"; // on horizontal line

  const left = dx < 0;
  const above = dy < 0; // smaller y is higher (above) in canvas space

  if (left && above) return "UL";
  if (!left && above) return "UR";
  if (left && !above) return "LL";
  return "LR";
}

function meanPoint(points) {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / n, y: sy / n };
}

// True MOA: 1 MOA = 1.047" @ 100y
function inchesPerMOA(distanceYards) {
  return 1.047 * (distanceYards / 100);
}

function labelFromSigned(v, posLabel, negLabel) {
  if (v > 0) return posLabel;
  if (v < 0) return negLabel;
  return "NONE";
}

// ---------- middleware ----------
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- routes ----------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "sczn3-sec-backend-pipe",
    build: BUILD,
    status: "alive",
  });
});

// Nice-to-have so "Cannot GET /api/sec" stops confusing things
app.get("/api/sec", (req, res) => {
  res.json({
    ok: true,
    service: "sczn3-sec-backend-pipe",
    build: BUILD,
    status: "alive",
    hint: "POST holes[] (in inches) to /api/sec. Y axis is DOWN (canvas).",
  });
});

/**
 * POST /api/sec
 * Accepts either JSON body or multipart/form-data.
 *
 * Supported inputs (any combination):
 *  - holes: array of {x,y} in inches (JSON body)
 *  - holesJson: stringified JSON of holes[] (form field)
 *  - bull: {x,y} in inches (JSON body)
 *  - bullX, bullY (form fields)
 *  - targetSizeSpec: "8.5x11" (recommended)
 *  - widthIn, heightIn (optional)
 *  - distanceYards (default 100)
 *  - clickValueMoa (default 0.25)
 *
 * NOTE: If an image is included, we accept it but do not detect holes here.
 *       Provide holes[] for compute.
 */
app.post("/api/sec", upload.single("image"), (req, res) => {
  try {
    const body = req.body || {};

    // --- defaults (your locked test environment) ---
    const DEFAULTS = {
      targetSizeSpec: "8.5x11",
      bull: { x: 4.25, y: 5.5 },
      distanceYards: 100,
      clickValueMoa: 0.25,
      deadbandIn: 0.1,
      minShots: 1,
    };

    // --- size ---
    const specInput =
      (typeof body.targetSizeSpec === "string" && body.targetSizeSpec) ||
      (typeof body.targetSize === "string" && body.targetSize) ||
      (typeof body.targetSizeInches === "string" && body.targetSizeInches) ||
      DEFAULTS.targetSizeSpec;

    let size = parseSizeSpec(specInput);

    // If spec parsing fails, try widthIn/heightIn
    if (!size) {
      const w = asNumber(body.widthIn);
      const h = asNumber(body.heightIn);
      if (w != null && h != null) {
        size = {
          spec: `${w}x${h}`,
          widthIn: w,
          heightIn: h,
          longIn: Math.max(w, h),
          shortIn: Math.min(w, h),
        };
      } else {
        // last resort: fall back to defaults
        size = parseSizeSpec(DEFAULTS.targetSizeSpec);
      }
    }

    // --- bull ---
    const bullFromBody = body.bull || parseJSONMaybe(body.bullJson);
    const bullFromFields = {
      x: asNumber(body.bullX),
      y: asNumber(body.bullY),
    };
    const bull = normalizeBull(
      bullFromBody || bullFromFields,
      DEFAULTS.bull
    );

    // --- distance & click value ---
    const distanceYards =
      asNumber(body.distanceYards) ?? DEFAULTS.distanceYards;
    const clickValueMoa =
      asNumber(body.clickValueMoa) ?? DEFAULTS.clickValueMoa;

    // --- holes ---
    let holes = null;

    if (Array.isArray(body.holes)) {
      holes = body.holes;
    } else {
      const holesJson = parseJSONMaybe(body.holesJson) || parseJSONMaybe(body.holes);
      if (Array.isArray(holesJson)) holes = holesJson;
    }

    if (!Array.isArray(holes) || holes.length === 0) {
      return res.status(400).json({
        ok: false,
        service: "sczn3-sec-backend-pipe",
        build: BUILD,
        error: {
          code: "NO_HOLES",
          message: "Provide holes[] in inches (JSON) or holesJson (stringified JSON).",
        },
        debug: {
          yAxisUsed: "down",
          targetSizeSpec: size?.spec,
          receivedKeys: Object.keys(body || {}),
          note: "If you uploaded an image, this backend does not auto-detect holes. Send holes[] for compute.",
        },
      });
    }

    // sanitize holes
    const clean = [];
    for (const h of holes) {
      const x = asNumber(h?.x);
      const y = asNumber(h?.y);
      if (x == null || y == null) continue;
      clean.push({ x, y });
    }

    if (clean.length === 0) {
      return res.status(400).json({
        ok: false,
        service: "sczn3-sec-backend-pipe",
        build: BUILD,
        error: {
          code: "NO_VALID_HOLES",
          message: "holes[] must contain numeric x and y in inches.",
        },
        debug: { yAxisUsed: "down" },
      });
    }

    // --- POIB (mean) ---
    const poib = meanPoint(clean);

    // --- Quadrants (Y-DOWN) ---
    const deadbandIn = asNumber(body.deadbandIn) ?? DEFAULTS.deadbandIn;

    const poibQuad = quadrantOfPoint_YDOWN(poib, bull, deadbandIn);

    // Optional: hole quadrants list (for visibility; compute still proceeds)
    const uniqueHoleQuadrants = Array.from(
      new Set(clean.map((p) => quadrantOfPoint_YDOWN(p, bull, deadbandIn)))
    );

    // --- Correction (move POIB to bull) ---
    const dxIn = bull.x - poib.x; // + RIGHT, - LEFT
    const dyIn = bull.y - poib.y; // + DOWN,  - UP  (Y-DOWN space)

    // --- Convert to clicks (True MOA) ---
    const ipm = inchesPerMOA(distanceYards);
    const windageMoa = dxIn / ipm;
    const elevationMoa = dyIn / ipm;

    const windageClicks = windageMoa / clickValueMoa;
    const elevationClicks = elevationMoa / clickValueMoa;

    const w = round2(windageClicks);
    const e = round2(elevationClicks);

    const windageDir = labelFromSigned(w, "RIGHT", "LEFT");
    const elevationDir = labelFromSigned(e, "DOWN", "UP"); // Y-DOWN

    return res.json({
      ok: true,
      service: "sczn3-sec-backend-pipe",
      build: BUILD,

      // Signed numbers (canonical):
      //  windage: +RIGHT / -LEFT
      //  elevation: +DOWN  / -UP
      clicksSigned: {
        windage: w,
        elevation: e,
      },

      // Human strings
      scopeClicks: {
        windage: `${windageDir} ${Math.abs(w).toFixed(2)} clicks`,
        elevation: `${elevationDir} ${Math.abs(e).toFixed(2)} clicks`,
      },

      debug: {
        yAxisUsed: "down",

        targetSizeSpec: size?.spec,
        targetSizeInches: {
          widthIn: round2(size.widthIn),
          heightIn: round2(size.heightIn),
          longIn: round2(size.longIn),
          shortIn: round2(size.shortIn),
        },

        distanceYards: round2(distanceYards),
        clickValueMoa: round2(clickValueMoa),
        inchesPerMOA: round2(ipm),

        bull: { x: round2(bull.x), y: round2(bull.y) },

        poib: { x: round2(poib.x), y: round2(poib.y) },
        poibQuad,

        uniqueHoleQuadrants,
        holesUsedCount: clean.length,

        dxIn: round2(dxIn),
        dyIn: round2(dyIn),

        note:
          "Convention locked: X right+, Y down+. Elevation is DOWN when dyIn > 0, UP when dyIn < 0.",
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      service: "sczn3-sec-backend-pipe",
      build: BUILD,
      error: { code: "SERVER_ERROR", message: String(err?.message || err) },
    });
  }
});

// ---------- start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SCZN3 SEC backend listening on ${PORT} (${BUILD})`);
});
