'use strict';

/*
  SCZN3 SEC backend (gateway + engine auto-loader)
  Build marker: BULL_LOCKED_V5

  Fixes:
  - Stops ENGINE_NOT_FOUND by auto-locating the SEC engine module in common repo paths
  - Accepts targetSizeSpec OR targetSizeInches OR widthIn/heightIn
  - If UI only sends targetSizeInches=11, defaults to 8.5x11 (common paper) so UI+backend agree
*/

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const BUILD = 'BULL_LOCKED_V5';
const SERVICE = 'sczn3-sec-backend-pipe';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------- helpers ----------

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function toNum(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const t = v.trim();
  if (!t) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function normalizeSizeSpec(specRaw) {
  if (!specRaw) return '';
  return String(specRaw)
    .trim()
    .toLowerCase()
    .replace('×', 'x')
    .replace(/\s+/g, '');
}

function parseSizeSpec(specRaw) {
  const spec = normalizeSizeSpec(specRaw);
  if (!spec) return null;

  // allow "8.5x11" or "11x8.5"
  const m = spec.match(/^(\d+(\.\d+)?)x(\d+(\.\d+)?)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const long = Math.max(a, b);
    const short = Math.min(a, b);
    return { spec: `${short}x${long}`, widthIn: short, heightIn: long, long, short, source: 'spec' };
  }

  // allow a single number like "11" (UI sometimes sends this)
  const n = Number(spec);
  if (Number.isFinite(n)) {
    // default common paper inference
    if (Math.abs(n - 11) < 0.0001) {
      return { spec: '8.5x11', widthIn: 8.5, heightIn: 11, long: 11, short: 8.5, source: 'inferred_11_is_letter' };
    }
    // square fallback
    return { spec: `${n}x${n}`, widthIn: n, heightIn: n, long: n, short: n, source: 'single_number_square' };
  }

  return null;
}

function resolveEngine() {
  // Try common locations without assuming exact repo structure
  const candidates = [
    './secEngine.js',
    './secEngine',
    './engine/secEngine.js',
    './engine/secEngine',
    './src/secEngine.js',
    './src/secEngine',
    './src/engine/secEngine.js',
    './src/engine/secEngine',
    './backend/src/secEngine.js',
    './backend/src/secEngine',
    './backend/src/engine/secEngine.js',
    './backend/src/engine/secEngine',
  ];

  for (const rel of candidates) {
    const abs = path.resolve(__dirname, rel);
    const jsAbs = abs.endsWith('.js') ? abs : `${abs}.js`;

    if (fs.existsSync(abs) || fs.existsSync(jsAbs)) {
      try {
        // require prefers exact file; try both
        let mod = null;
        try { mod = require(abs); } catch (_) { mod = require(jsAbs); }

        // support multiple export styles
        if (typeof mod === 'function') return { fn: mod, from: rel };
        if (mod && typeof mod.computeSEC === 'function') return { fn: mod.computeSEC, from: rel };
        if (mod && typeof mod.compute === 'function') return { fn: mod.compute, from: rel };
        if (mod && typeof mod.default === 'function') return { fn: mod.default, from: rel };
      } catch (e) {
        // keep searching
      }
    }
  }

  return null;
}

const engineResolved = resolveEngine();

// ---------- routes ----------

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: SERVICE,
    status: 'alive',
    build: BUILD,
    engine: engineResolved ? { found: true, from: engineResolved.from } : { found: false },
  });
});

// convenient sanity check (so /api/sec doesn't show "Cannot GET")
app.get('/api/sec', (req, res) => {
  res.json({
    ok: true,
    service: SERVICE,
    status: 'alive',
    build: BUILD,
    note: 'POST multipart to this endpoint with field "image" plus distanceYards, clickValueMoa, and a target size field.',
    expects: {
      imageField: 'image',
      sizeFieldsAccepted: ['targetSizeSpec', 'targetSizeInches', 'widthIn', 'heightIn'],
    },
    engine: engineResolved ? { found: true, from: engineResolved.from } : { found: false },
  });
});

app.post('/api/sec', upload.single('image'), async (req, res) => {
  try {
    const distanceYards = toNum(req.body.distanceYards);
    const clickValueMoa = toNum(req.body.clickValueMoa);

    // Accept any size inputs the UI might send
    const bodyTargetSizeSpec = req.body.targetSizeSpec;
    const bodyTargetSizeInches = req.body.targetSizeInches;

    const widthInRaw = toNum(req.body.widthIn);
    const heightInRaw = toNum(req.body.heightIn);

    let size = null;

    // 1) width/height provided
    if (Number.isFinite(widthInRaw) && Number.isFinite(heightInRaw)) {
      const long = Math.max(widthInRaw, heightInRaw);
      const short = Math.min(widthInRaw, heightInRaw);
      size = { spec: `${short}x${long}`, widthIn: short, heightIn: long, long, short, source: 'width_height' };
    }

    // 2) explicit spec provided
    if (!size && bodyTargetSizeSpec) {
      size = parseSizeSpec(bodyTargetSizeSpec);
    }

    // 3) targetSizeInches provided (might be "8.5x11" or "11")
    if (!size && bodyTargetSizeInches !== undefined) {
      size = parseSizeSpec(bodyTargetSizeInches);
    }

    // last-resort default (letter)
    if (!size) {
      size = { spec: '8.5x11', widthIn: 8.5, heightIn: 11, long: 11, short: 8.5, source: 'default_letter' };
    }

    // Build SEC echo object (UI needs these echoed back)
    const sec = {
      distanceYards: Number.isFinite(distanceYards) ? distanceYards : 100,
      clickValueMoa: Number.isFinite(clickValueMoa) ? clickValueMoa : 0.25,
      targetSizeSpec: size.spec,
      widthIn: size.widthIn,
      heightIn: size.heightIn,
      targetSizeInches: size.long,
      _sizeSource: size.source,
    };

    // If engine exists, run it. Otherwise return explicit ENGINE_MISSING.
    if (!engineResolved) {
      return res.json({
        ok: true,
        computeStatus: 'ENGINE_MISSING',
        error: {
          code: 'ENGINE_NOT_FOUND',
          message: 'No SEC engine module found in repo. Gateway is alive.',
        },
        detect: { normalized: null, holesDetected: 0, holes: [] },
        service: SERVICE,
        build: BUILD,
        received: {
          originalName: req.file ? req.file.originalname : null,
          bytes: req.file ? req.file.size : 0,
          mimetype: req.file ? req.file.mimetype : null,
        },
        sec,
        clicksSigned: { windage: 0, elevation: 0 },
        _clicksSignedNote: 'Derived fallback (engine missing).',
      });
    }

    const imageBuffer = req.file ? req.file.buffer : null;

    // Call the engine in a tolerant way: engine can return an object we merge
    const engineOut = await Promise.resolve(
      engineResolved.fn({
        imageBuffer,
        sec,
        meta: {
          originalName: req.file ? req.file.originalname : null,
          bytes: req.file ? req.file.size : 0,
          mimetype: req.file ? req.file.mimetype : null,
        },
      })
    );

    // Ensure the response always includes required fields for the UI
    const out = Object.assign(
      {
        ok: true,
        service: SERVICE,
        build: BUILD,
        sec,
      },
      engineOut || {}
    );

    // If engine didn't include clicksSigned, do not fake it
    if (!out.clicksSigned) {
      out.clicksSigned = null;
      out._clicksSignedNote = 'Engine did not return clicksSigned.';
    }

    return res.json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      service: SERVICE,
      build: BUILD,
      error: {
        code: 'SERVER_ERROR',
        message: String(err && err.message ? err.message : err),
      },
    });
  }
});

// ---------- start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[${SERVICE}] listening on ${PORT} build=${BUILD} engine=${engineResolved ? engineResolved.from : 'none'}`);
});
