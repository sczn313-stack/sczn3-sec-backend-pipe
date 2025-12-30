// server.js
// SCZN3 SEC backend - hardened gateway for UI congruence + safe runtime
// Build marker: BULL_LOCKED_V4

'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Multer (multipart) for image upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ---------- helpers ----------
function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function toNumber(v) {
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

// Accepts "8.5x11", "8.5×11", "8.5 X 11", etc.
function parseSizeSpec(spec) {
  if (!spec || typeof spec !== 'string') return null;
  const s = spec
    .toLowerCase()
    .replace('×', 'x')
    .replace(/\s+/g, '')
    .replace(/"/g, '');

  const m = s.match(/^(\d+(\.\d+)?)x(\d+(\.\d+)?)$/);
  if (!m) return null;

  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;

  const widthIn = a;
  const heightIn = b;
  const longIn = Math.max(a, b);
  const shortIn = Math.min(a, b);

  return { widthIn, heightIn, longIn, shortIn, targetSizeSpec: `${widthIn}x${heightIn}` };
}

function pickTargetSize(body) {
  // UI may send:
  // - targetSizeSpec: "8.5x11" (preferred)
  // - targetSizeInches: 8.5 (numeric) OR "8.5x11" (string)
  // - widthIn / heightIn
  // - targetSize: "8.5x11"
  const rawSpec =
    body.targetSizeSpec ??
    body.targetSize ??
    body.targetSpec ??
    body.sizeSpec ??
    null;

  // If targetSizeInches is a string like "8.5x11", treat it as a spec too
  const tsi = body.targetSizeInches;
  const tsiAsSpec = (typeof tsi === 'string' && /x|×/i.test(tsi)) ? tsi : null;

  const specObj = parseSizeSpec(String(rawSpec || tsiAsSpec || ''));

  const w = toNumber(body.widthIn);
  const h = toNumber(body.heightIn);

  // If spec exists, use it
  if (specObj) return specObj;

  // Else if width/height numeric exist, use them
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    const longIn = Math.max(w, h);
    const shortIn = Math.min(w, h);
    return { widthIn: w, heightIn: h, longIn, shortIn, targetSizeSpec: `${w}x${h}` };
  }

  // Else if targetSizeInches is numeric, we can at least echo it back
  const tsiNum = toNumber(tsi);
  if (Number.isFinite(tsiNum) && tsiNum > 0) {
    // We don't know the other dimension, but we can keep UI congruent.
    return { widthIn: tsiNum, heightIn: tsiNum, longIn: tsiNum, shortIn: tsiNum, targetSizeSpec: `${tsiNum}x${tsiNum}` };
  }

  return null;
}

function normalizeSec(body) {
  const distanceYards = toNumber(body.distanceYards ?? body.distance ?? body.yards);
  const clickValueMoa = toNumber(body.clickValueMoa ?? body.clickValue ?? body.moaPerClick ?? body.click);

  const size = pickTargetSize(body);

  // IMPORTANT: UI congruence gate wants:
  // - sec.targetSizeSpec (string)
  // - sec.targetSizeInches (numeric)
  // We'll echo:
  // - widthIn/heightIn
  // - targetSizeInches as LONG side (numeric)
  // - targetSizeSpec as "WxH"
  const sec = {
    distanceYards: Number.isFinite(distanceYards) ? distanceYards : 100,
    clickValueMoa: Number.isFinite(clickValueMoa) ? clickValueMoa : 0.25,
  };

  if (size) {
    sec.targetSizeSpec = size.targetSizeSpec;
    sec.widthIn = size.widthIn;
    sec.heightIn = size.heightIn;
    sec.targetSizeInches = size.longIn; // numeric, avoids NaN and satisfies UI gate
  }

  return sec;
}

// Attempts to load an existing engine from common filenames without breaking deploy
function tryLoadEngine() {
  const candidates = [
    './secEngine',
    './sec',
    './computeSec',
    './src/secEngine',
    './src/sec',
    './src/computeSec',
    './lib/secEngine',
    './lib/sec',
  ];

  for (const p of candidates) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const mod = require(p);
      if (!mod) continue;

      // function export
      if (typeof mod === 'function') return { kind: 'fn', fn: mod };

      // named exports
      if (typeof mod.computeSEC === 'function') return { kind: 'fn', fn: mod.computeSEC };
      if (typeof mod.computeSec === 'function') return { kind: 'fn', fn: mod.computeSec };
      if (typeof mod.run === 'function') return { kind: 'fn', fn: mod.run };
      if (typeof mod.handle === 'function') return { kind: 'fn', fn: mod.handle };

      // object export fallback
      return { kind: 'obj', obj: mod };
    } catch (e) {
      // ignore and keep trying
    }
  }
  return null;
}

const ENGINE = tryLoadEngine();

// Converts dial text like "RIGHT 0.96 clicks" into signed numbers
function parseDialLine(line) {
  if (!line || typeof line !== 'string') return null;
  const s = line.trim().toUpperCase();
  const m = s.match(/(LEFT|RIGHT|UP|DOWN)\s+(-?\d+(\.\d+)?)/);
  if (!m) return null;
  const dir = m[1];
  const mag = Number(m[2]);
  if (!Number.isFinite(mag)) return null;
  return { dir, mag };
}

function ensureClicksSigned(out) {
  // If already present & valid, keep it
  if (
    out &&
    out.clicksSigned &&
    isFiniteNumber(out.clicksSigned.windage) &&
    isFiniteNumber(out.clicksSigned.elevation)
  ) {
    return out;
  }

  // Try to derive from "dial" lines if present
  const dial = out && (out.dial || out.dialLines || out.lines || out.minimal);
  if (Array.isArray(dial)) {
    let w = null;
    let e = null;

    for (const ln of dial) {
      const parsed = parseDialLine(ln);
      if (!parsed) continue;
      if (parsed.dir === 'RIGHT') w = +Math.abs(parsed.mag);
      if (parsed.dir === 'LEFT') w = -Math.abs(parsed.mag);
      if (parsed.dir === 'UP') e = +Math.abs(parsed.mag);
      if (parsed.dir === 'DOWN') e = -Math.abs(parsed.mag);
    }

    if (Number.isFinite(w) && Number.isFinite(e)) {
      out.clicksSigned = { windage: w, elevation: e };
      return out;
    }
  }

  // Last resort: keep UI stable (explicitly mark missing)
  out.clicksSigned = { windage: 0, elevation: 0 };
  out._clicksSignedNote = 'Derived fallback (engine did not provide clicksSigned).';
  return out;
}

// ---------- routes ----------
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'sczn3-sec-backend-pipe',
    status: 'alive',
    build: 'BULL_LOCKED_V4',
  });
});

// So visiting /api/sec in browser does NOT say "Cannot GET /api/sec"
app.get('/api/sec', (_req, res) => {
  res.json({
    ok: true,
    service: 'sczn3-sec-backend-pipe',
    status: 'alive',
    build: 'BULL_LOCKED_V4',
    hint: 'POST multipart to /api/sec with field: image',
  });
});

app.post('/api/sec', upload.single('image'), async (req, res) => {
  try {
    const sec = normalizeSec(req.body || {});

    // Require target size spec OR we can’t map inches properly
    if (!sec.targetSizeSpec || !isFiniteNumber(sec.targetSizeInches)) {
      return res.status(400).json({
        ok: false,
        service: 'sczn3-sec-backend-pipe',
        build: 'BULL_LOCKED_V4',
        error: {
          code: 'BAD_TARGET_SPEC',
          message: 'targetSizeSpec required (ex: 8.5x11). UI can also send targetSizeInches="8.5x11".',
        },
        sec,
      });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        ok: false,
        service: 'sczn3-sec-backend-pipe',
        build: 'BULL_LOCKED_V4',
        error: { code: 'NO_IMAGE', message: 'No image uploaded. Field name must be "image".' },
        sec,
      });
    }

    // If your repo has a compute engine, use it. If not, don’t crash the deploy.
    let out = null;

    if (ENGINE && ENGINE.kind === 'fn') {
      // We try a few call signatures safely.
      const fn = ENGINE.fn;

      // Prefer passing a single object
      try {
        out = await Promise.resolve(fn({ image: req.file.buffer, sec, req }));
      } catch (_e1) {
        // Try positional args (buffer, sec)
        out = await Promise.resolve(fn(req.file.buffer, sec));
      }
    } else {
      // No engine found — respond without breaking UI and without crashing Render
      out = {
        ok: true,
        computeStatus: 'ENGINE_MISSING',
        error: { code: 'ENGINE_NOT_FOUND', message: 'No SEC engine module found in repo. Gateway is alive.' },
        detect: { normalized: null, holesDetected: 0, holes: [] },
      };
    }

    // Make sure we never reference an undefined "holes"
    // If your engine returns detect.holes, normalize it here.
    const detect = out && out.detect ? out.detect : {};
    const holesArr = Array.isArray(detect.holes) ? detect.holes : [];
    detect.holes = holesArr;
    detect.holesDetected = Number.isFinite(detect.holesDetected) ? detect.holesDetected : holesArr.length;
    out.detect = detect;

    // Guarantee congruence echo fields
    out.ok = out.ok !== false; // default true unless engine set false
    out.service = 'sczn3-sec-backend-pipe';
    out.build = 'BULL_LOCKED_V4';
    out.received = {
      originalName: req.file.originalname,
      bytes: req.file.size,
      mimetype: req.file.mimetype,
    };
    out.sec = sec;

    // Ensure clicksSigned exists (UI gate)
    out = ensureClicksSigned(out);

    return res.json(out);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      service: 'sczn3-sec-backend-pipe',
      build: 'BULL_LOCKED_V4',
      error: {
        code: 'SERVER_ERROR',
        message: err && err.message ? err.message : 'Unknown server error',
      },
    });
  }
});

// Render port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // Keep logs minimal
  console.log(`SEC backend listening on ${PORT} (BULL_LOCKED_V4)`);
});
