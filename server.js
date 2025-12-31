'use strict';

/**
 * SCZN3 SEC Backend (POIB Anchor)
 * Build: POIB_ANCHOR_V2
 *
 * Inputs supported:
 *  - POST /api/sec (multipart or JSON)
 *    Required: holes (array) OR holesJson (stringified array)
 *    Optional: image (file) [ignored if holes provided]
 *    Optional: distanceYards (number, default 100)
 *    Optional: clickValueMoa (number, default 0.25)
 *    Optional: targetSizeSpec (string like "8.5x11")
 *    Optional: targetSizeInches (number)  (legacy)
 *    Optional: widthIn, heightIn (numbers)
 *    Optional: bullXIn, bullYIn (numbers) (defaults to center of target)
 *    Optional: deadbandIn (number, default 0)
 *    Optional: minShots (number, default 3)
 *
 * Output:
 *  - clicksSigned.windage (positive = RIGHT, negative = LEFT)
 *  - clicksSigned.elevation (positive = UP, negative = DOWN)
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');

const BUILD = 'POIB_ANCHOR_V2';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function toNumber(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseSizeSpec(spec) {
  // Accept: "8.5x11", "8.5×11", "8.5 x 11", "11x8.5"
  if (!spec || typeof spec !== 'string') return null;

  const s = spec
    .toLowerCase()
    .replace('×', 'x')
    .replace(/\s+/g, '')
    .trim();

  const m = s.match(/^(\d+(\.\d+)?)(x)(\d+(\.\d+)?)$/);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[4]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;

  // IMPORTANT: preserve the user's order.
  // "8.5x11" => width=8.5, height=11
  // "11x8.5" => width=11, height=8.5
  return {
    spec: `${a}x${b}`,
    widthIn: a,
    heightIn: b,
    longIn: Math.max(a, b),
    shortIn: Math.min(a, b),
  };
}

function normalizeHoles(input) {
  // input may be: array, JSON string, or undefined
  let holes = input;

  if (typeof holes === 'string') {
    try {
      holes = JSON.parse(holes);
    } catch {
      // if the user pasted invalid JSON, treat as empty
      holes = [];
    }
  }

  if (!Array.isArray(holes)) holes = [];

  const clean = [];
  for (const h of holes) {
    if (!h || typeof h !== 'object') continue;
    const x = Number(h.x);
    const y = Number(h.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    clean.push({ x, y });
  }
  return clean;
}

function computePOIB(holes) {
  let sx = 0;
  let sy = 0;
  for (const h of holes) {
    sx += h.x;
    sy += h.y;
  }
  return { x: sx / holes.length, y: sy / holes.length };
}

function quadrantOfPoint(point, bull) {
  const left = point.x < bull.x;
  const above = point.y < bull.y; // smaller y = higher on page
  if (left && above) return 'UL';
  if (!left && above) return 'UR';
  if (left && !above) return 'LL';
  return 'LR';
}

function dirLR(v) {
  return v >= 0 ? 'RIGHT' : 'LEFT';
}
function dirUD(v) {
  return v >= 0 ? 'UP' : 'DOWN';
}

function moaAtDistanceInches(distanceYards) {
  // True MOA: 1.047 inches at 100 yards
  return 1.047 * (distanceYards / 100);
}

app.get('/', (req, res) => {
  return res.json({
    ok: true,
    service: 'sczn3-sec-backend-pipe',
    build: BUILD,
    status: 'alive',
  });
});

app.post('/api/sec', upload.single('image'), (req, res) => {
  try {
    const body = req.body || {};

    const distanceYards = toNumber(body.distanceYards, 100);
    const clickValueMoa = toNumber(body.clickValueMoa, 0.25);
    const minShots = Math.max(1, Math.floor(toNumber(body.minShots, 3)));
    const deadbandIn = Math.max(0, toNumber(body.deadbandIn, 0));

    // Target size (multiple ways)
    const sizeFromSpec = parseSizeSpec(body.targetSizeSpec || body.targetSize || body.targetSizeLabel);
    const widthFromFields = toNumber(body.widthIn, NaN);
    const heightFromFields = toNumber(body.heightIn, NaN);

    let widthIn = Number.isFinite(widthFromFields) ? widthFromFields : (sizeFromSpec ? sizeFromSpec.widthIn : NaN);
    let heightIn = Number.isFinite(heightFromFields) ? heightFromFields : (sizeFromSpec ? sizeFromSpec.heightIn : NaN);

    // Legacy: if they only send targetSizeInches=11 for 8.5x11, accept it as height and infer width=8.5
    const legacyTargetSizeInches = toNumber(body.targetSizeInches, NaN);
    if ((!Number.isFinite(widthIn) || !Number.isFinite(heightIn)) && Number.isFinite(legacyTargetSizeInches)) {
      // If they only sent one number, assume it is the LONG side.
      // For 8.5x11, long=11 short=8.5
      const longIn = legacyTargetSizeInches;
      const shortIn = round2(longIn === 11 ? 8.5 : (longIn === 17 ? 11 : 0)); // only safe guesses; otherwise leave 0
      if (shortIn > 0) {
        widthIn = shortIn;
        heightIn = longIn;
      }
    }

    // If still unknown, default to 8.5x11
    if (!Number.isFinite(widthIn) || !Number.isFinite(heightIn) || widthIn <= 0 || heightIn <= 0) {
      widthIn = 8.5;
      heightIn = 11;
    }

    const targetSizeSpecEcho = sizeFromSpec ? sizeFromSpec.spec : `${widthIn}x${heightIn}`;

    // Bull point (defaults to center, but allow override)
    const bullXIn = toNumber(body.bullXIn, widthIn / 2);
    const bullYIn = toNumber(body.bullYIn, heightIn / 2);
    const bull = { x: bullXIn, y: bullYIn };

    // Holes input
    const holes = normalizeHoles(body.holes || body.holesJson);
    if (holes.length < minShots) {
      return res.status(400).json({
        ok: false,
        service: 'sczn3-sec-backend-pipe',
        build: BUILD,
        error: {
          code: 'NOT_ENOUGH_SHOTS',
          message: `Need at least ${minShots} holes to compute POIB.`,
        },
        received: {
          holesCount: holes.length,
          minShots,
          targetSizeSpec: targetSizeSpecEcho,
        },
      });
    }

    // POIB anchor
    const poib = computePOIB(holes);

    // Deadband (inches)
    const dxIn = bull.x - poib.x;     // + means POIB is left -> move RIGHT
    const dyIn = bull.y - poib.y;     // + means POIB is above -> move DOWN (page coords)
    const dxDb = Math.abs(dxIn) < deadbandIn ? 0 : dxIn;
    const dyDb = Math.abs(dyIn) < deadbandIn ? 0 : dyIn;

    // Convert inches -> clicks (true MOA)
    const inchesPerClick = moaAtDistanceInches(distanceYards) * clickValueMoa;
    if (!Number.isFinite(inchesPerClick) || inchesPerClick <= 0) {
      return res.status(400).json({
        ok: false,
        service: 'sczn3-sec-backend-pipe',
        build: BUILD,
        error: {
          code: 'BAD_CLICK_VALUE',
          message: 'clickValueMoa and distanceYards must produce a valid inches-per-click value.',
        },
      });
    }

    // LOCKED SIGN RULE:
    // windage signed: + = RIGHT
    // elevation signed: + = UP
    const wClicks = round2(dxDb / inchesPerClick);

    // For elevation: POIB below bull means poib.y > bull.y, and we want UP (positive)
    // Therefore: elevationSigned = (poib.y - bull.y) / inchesPerClick
    const eClicks = round2((poib.y - bull.y) / inchesPerClick);

    const clicksSigned = { windage: wClicks, elevation: eClicks };

    const scopeClicks = {
      windage: `${dirLR(wClicks)} ${Math.abs(wClicks).toFixed(2)} clicks`,
      elevation: `${dirUD(eClicks)} ${Math.abs(eClicks).toFixed(2)} clicks`,
    };

    return res.json({
      ok: true,
      service: 'sczn3-sec-backend-pipe',
      build: BUILD,
      clicksSigned,
      scopeClicks,
      debug: {
        poib: { x: round2(poib.x), y: round2(poib.y) },
        poibQuad: quadrantOfPoint(poib, bull),
        bull: { x: round2(bull.x), y: round2(bull.y) },
        usedCount: holes.length,
        ignoredCount: 0,
        deadbandIn: round2(deadbandIn),
        minShots,
        targetSizeSpec: targetSizeSpecEcho,
        widthIn: round2(widthIn),
        heightIn: round2(heightIn),
        distanceYards: round2(distanceYards),
        clickValueMoa: round2(clickValueMoa),
        inchesPerClick: round2(inchesPerClick),
      },
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      service: 'sczn3-sec-backend-pipe',
      build: BUILD,
      error: {
        code: 'SERVER_ERROR',
        message: String(err && err.message ? err.message : err),
      },
    });
  }
});

// Helpful message if someone GETs the POST route
app.get('/api/sec', (req, res) => {
  return res.status(405).json({
    ok: false,
    service: 'sczn3-sec-backend-pipe',
    build: BUILD,
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: 'Use POST /api/sec (multipart or JSON).',
    },
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`SCZN3 backend alive on port ${PORT} build=${BUILD}`);
});
