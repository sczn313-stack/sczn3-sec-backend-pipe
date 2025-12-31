'use strict';

/**
 * SCZN3 SEC backend gateway (self-contained)
 * Build marker: BULL_LOCKED_V5
 *
 * Fixes:
 * - Never crashes on missing engine module (no ENGINE_NOT_FOUND dead-end)
 * - Accepts targetSizeSpec OR targetSizeInches OR widthIn/heightIn
 * - Always echoes back: sec.targetSizeInches (number) + clicksSigned (numbers)
 */

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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ---------------- helpers ----------------

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function toNum(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function parseSizeSpec(spec) {
  // returns { widthIn, heightIn, spec, long, short }
  if (!spec || typeof spec !== 'string') return null;

  const s = spec.trim().toLowerCase().replace(/\s+/g, '');
  // allow "8.5x11" or "8.5×11"
  const m = s.match(/^([0-9]+(?:\.[0-9]+)?)\s*[x×]\s*([0-9]+(?:\.[0-9]+)?)$/);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;

  const long = Math.max(a, b);
  const short = Math.min(a, b);

  return {
    widthIn: a,
    heightIn: b,
    spec: `${a}x${b}`,
    long,
    short,
  };
}

function normalizeSecFromBody(body) {
  const distanceYards = toNum(body.distanceYards);
  const clickValueMoa = toNum(body.clickValueMoa);

  // Accept any of:
  // - targetSizeSpec: "8.5x11"
  // - targetSizeInches: number (long side) OR string "8.5x11"
  // - widthIn/heightIn: numbers
  const targetSizeSpec =
    typeof body.targetSizeSpec === 'string' ? body.targetSizeSpec.trim() : '';

  let parsed = parseSizeSpec(targetSizeSpec);

  if (!parsed) {
    // maybe targetSizeInches is actually a spec string
    if (typeof body.targetSizeInches === 'string' && body.targetSizeInches.includes('x')) {
      parsed = parseSizeSpec(body.targetSizeInches);
    }
  }

  let widthIn = parsed ? parsed.widthIn : toNum(body.widthIn);
  let heightIn = parsed ? parsed.heightIn : toNum(body.heightIn);

  // If UI sends ONLY targetSizeInches as a number (long side), keep it, but don't fail.
  let targetSizeInches = toNum(body.targetSizeInches);

  // If we have width/height, compute long side reliably
  if (Number.isFinite(widthIn) && Number.isFinite(heightIn) && widthIn > 0 && heightIn > 0) {
    targetSizeInches = Math.max(widthIn, heightIn);
  }

  // If still NaN, but parsed spec exists, use parsed.long
  if (!Number.isFinite(targetSizeInches) && parsed) {
    targetSizeInches = parsed.long;
    widthIn = parsed.widthIn;
    heightIn = parsed.heightIn;
  }

  // final: if we have width/height but no spec, synthesize one
  let finalSpec = parsed ? parsed.spec : '';
  if (!finalSpec && Number.isFinite(widthIn) && Number.isFinite(heightIn)) {
    finalSpec = `${widthIn}x${heightIn}`;
  }

  return {
    distanceYards: Number.isFinite(distanceYards) ? distanceYards : 100,
    clickValueMoa: Number.isFinite(clickValueMoa) ? clickValueMoa : 0.25,
    targetSizeSpec: finalSpec || 'unknown',
    widthIn: Number.isFinite(widthIn) ? widthIn : null,
    heightIn: Number.isFinite(heightIn) ? heightIn : null,
    targetSizeInches: Number.isFinite(targetSizeInches) ? targetSizeInches : null,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function signedToDirections(clicksSigned) {
  // clicksSigned = { windage: +RIGHT / -LEFT, elevation: +UP / -DOWN }
  const w = clicksSigned.windage;
  const e = clicksSigned.elevation;

  const windageDir = w > 0 ? 'RIGHT' : w < 0 ? 'LEFT' : 'RIGHT';
  const elevationDir = e > 0 ? 'UP' : e < 0 ? 'DOWN' : 'UP';

  return {
    windage: { dir: windageDir, clicks: round2(Math.abs(w)) },
    elevation: { dir: elevationDir, clicks: round2(Math.abs(e)) },
  };
}

function loadEngineIfPresent() {
  // If you already have an engine module in the repo, we’ll use it.
  // If not, we fallback cleanly.
  const candidates = [
    './secEngine',
    './engine/secEngine',
    './src/secEngine',
    './secEngine.js',
    './engine/secEngine.js',
    './src/secEngine.js',
  ];

  for (const p of candidates) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const mod = require(p);
      if (typeof mod === 'function') return mod;
      if (mod && typeof mod.run === 'function') return mod.run;
      if (mod && typeof mod.compute === 'function') return mod.compute;
      if (mod && typeof mod.default === 'function') return mod.default;
    } catch (_) {
      // ignore
    }
  }
  return null;
}

const engine = loadEngineIfPresent();

// ---------------- routes ----------------

app.get('/', (req, res) => {
  res.json({ ok: true, service: SERVICE, status: 'alive', build: BUILD });
});

app.get('/api/sec', (req, res) => {
  res.status(405).json({
    ok: false,
    service: SERVICE,
    build: BUILD,
    error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST /api/sec with multipart form-data.' },
  });
});

app.post('/api/sec', upload.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        service: SERVICE,
        build: BUILD,
        error: { code: 'NO_IMAGE', message: 'multipart field "image" is required.' },
      });
    }

    const sec = normalizeSecFromBody(req.body);

    // Hard gate: we must have a numeric targetSizeInches or we cannot do congruence math
    if (!isFiniteNumber(sec.targetSizeInches) || sec.targetSizeInches <= 0) {
      return res.status(400).json({
        ok: false,
        service: SERVICE,
        build: BUILD,
        received: {
          originalName: req.file.originalname,
          bytes: req.file.size,
          mimetype: req.file.mimetype,
        },
        sec,
        error: {
          code: 'BAD_TARGET_SIZE',
          message:
            'Need target size. Send targetSizeSpec ("8.5x11") OR widthIn/heightIn OR numeric targetSizeInches.',
        },
      });
    }

    // If a real engine exists, use it.
    // Expected engine signature: (imageBuffer, sec) => { computeStatus, clicksSigned, detect?, ... }
    let engineOut = null;

    if (engine) {
      try {
        engineOut = await Promise.resolve(engine(req.file.buffer, sec));
      } catch (e) {
        engineOut = {
          computeStatus: 'ENGINE_ERROR',
          error: { code: 'ENGINE_ERROR', message: String(e && e.message ? e.message : e) },
        };
      }
    } else {
      // Clean fallback that keeps UI + backend congruent.
      // (No dead-end "ENGINE_NOT_FOUND".)
      engineOut = {
        computeStatus: 'ENGINE_STUB',
        error: {
          code: 'ENGINE_STUB',
          message:
            'Engine module not present/loaded yet. Gateway is alive and returning congruent fields.',
        },
        detect: { normalized: null, holesDetected: 0, holes: [] },
        clicksSigned: { windage: 0, elevation: 0 },
      };
    }

    // Ensure clicksSigned ALWAYS exists and is numeric
    let clicksSigned = engineOut && engineOut.clicksSigned ? engineOut.clicksSigned : null;

    if (!clicksSigned || !isFiniteNumber(toNum(clicksSigned.windage)) || !isFiniteNumber(toNum(clicksSigned.elevation))) {
      clicksSigned = { windage: 0, elevation: 0 };
      engineOut.clicksSignedNote = 'Derived fallback (engine did not provide numeric clicksSigned).';
    } else {
      clicksSigned = {
        windage: round2(toNum(clicksSigned.windage)),
        elevation: round2(toNum(clicksSigned.elevation)),
      };
    }

    const out = {
      ok: true,
      service: SERVICE,
      build: BUILD,
      received: {
        originalName: req.file.originalname,
        bytes: req.file.size,
        mimetype: req.file.mimetype,
      },
      sec,
      computeStatus: engineOut.computeStatus || 'OK',
      detect: engineOut.detect || null,
      clicksSigned,
      clicks: signedToDirections(clicksSigned),
      // pass through anything else the engine returned
      engine: engine ? 'LOADED' : 'STUB',
      engineNote: engine ? undefined : 'No engine module loaded; returning congruent stub.',
    };

    // include engineOut.error if present (helps UI debug)
    if (engineOut && engineOut.error) out.error = engineOut.error;

    return res.json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      service: SERVICE,
      build: BUILD,
      error: { code: 'SERVER_ERROR', message: String(err && err.message ? err.message : err) },
    });
  }
});

// ---------------- start ----------------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[${SERVICE}] ${BUILD} listening on ${PORT}`);
});
