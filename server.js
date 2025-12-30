// bullLogic.js
// Canonical SCZN3 rule:
// correction = bull - POIB
// ΔX > 0 => RIGHT, ΔX < 0 => LEFT
// ΔY > 0 => UP,    ΔY < 0 => DOWN
// True MOA: 1 MOA = 1.047" at 100y
// Two-decimal outputs always.

function toNum(v, fallback = NaN) {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function inchesToMoa(inches, distanceYards) {
  const y = toNum(distanceYards);
  if (!Number.isFinite(y) || y <= 0) return NaN;
  // 1 MOA at distanceYards = 1.047 * (distanceYards/100) inches
  const inchesPerMoa = 1.047 * (y / 100);
  return inches / inchesPerMoa;
}

function moaToClicks(moa, clickValueMoa) {
  const cv = toNum(clickValueMoa);
  if (!Number.isFinite(cv) || cv <= 0) return NaN;
  return moa / cv;
}

function dialLine(axisLabel, signedClicks, posDir, negDir) {
  const c = toNum(signedClicks);
  if (!Number.isFinite(c)) return `${axisLabel}: n/a`;
  const dir = c > 0 ? posDir : c < 0 ? negDir : "HOLD";
  const mag = round2(Math.abs(c)).toFixed(2);
  return `${axisLabel}: ${dir} ${mag} clicks`;
}

/**
 * Inputs are INCHES in a right-handed target coordinate system:
 * - X increases to the RIGHT
 * - Y increases UP
 * If your image pipeline uses Y-down pixels, convert to inches with Y-up BEFORE calling.
 */
function computeBullCorrection({
  bullXIn,
  bullYIn,
  poibXIn,
  poibYIn,
  distanceYards,
  clickValueMoa,
}) {
  const bx = toNum(bullXIn);
  const by = toNum(bullYIn);
  const px = toNum(poibXIn);
  const py = toNum(poibYIn);

  if (![bx, by, px, py].every(Number.isFinite)) {
    return {
      ok: false,
      error: { code: "MISSING_COORDS", message: "bullXIn/bullYIn/poibXIn/poibYIn required (numbers)." },
    };
  }

  // Canonical correction vector (move POIB to bull)
  const dxIn = bx - px; // +RIGHT, -LEFT
  const dyIn = by - py; // +UP,    -DOWN

  const dxMoa = inchesToMoa(dxIn, distanceYards);
  const dyMoa = inchesToMoa(dyIn, distanceYards);

  const windClicks = moaToClicks(dxMoa, clickValueMoa);
  const elevClicks = moaToClicks(dyMoa, clickValueMoa);

  const windSigned = round2(windClicks);
  const elevSigned = round2(elevClicks);

  return {
    ok: true,
    bullInches: { x: round2(bx), y: round2(by) },
    poibInches: { x: round2(px), y: round2(py) },
    deltaInches: { x: round2(dxIn), y: round2(dyIn) },
    clicksSigned: {
      windage: Number.isFinite(windSigned) ? Number(windSigned.toFixed(2)) : NaN,
      elevation: Number.isFinite(elevSigned) ? Number(elevSigned.toFixed(2)) : NaN,
    },
    dial: {
      windage: dialLine("Windage", windSigned, "RIGHT", "LEFT"),
      elevation: dialLine("Elevation", elevSigned, "UP", "DOWN"),
    },
    // Quadrant sanity helper (based on POIB relative to bull)
    sanity: {
      poibRelativeToBull: {
        x: px < bx ? "LEFT" : px > bx ? "RIGHT" : "CENTER",
        y: py < by ? "DOWN" : py > by ? "UP" : "CENTER",
      },
      expectedDialIfOnlyQuadrant: {
        // If POIB is upper-left of bull => RIGHT + DOWN, etc.
        note: "This assumes your Y axis is UP-positive in inches.",
      },
    },
  };
}

module.exports = { computeBullCorrection };
