// -------------------------------
// SCZN3 POIB + CLICK MATH (LOCKED)
// -------------------------------
// Conventions we enforce:
// - POIB inches: Right +, Left -, Up +, Down -
// - Image pixel Y grows DOWN, but SCZN3 POIB Y must grow UP  -> we flip Y
// - clicksSigned are CORRECTION clicks (what to dial):
//    correction = bull - POIB  => clicksSigned = -POIB / inchesPerClick
// - Dial text is derived ONLY from clicksSigned signs (never from raw image Y)

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function fmt2(n) {
  return round2(n).toFixed(2);
}

function inchesPerMoaAtYards(yards) {
  const y = Number(yards);
  if (!Number.isFinite(y) || y <= 0) return NaN;
  // True MOA: 1.047" @ 100y
  return 1.047 * (y / 100);
}

function inchesPerClick(yards, clickValueMoa) {
  const ipm = inchesPerMoaAtYards(yards);
  const cv = Number(clickValueMoa);
  if (!Number.isFinite(ipm) || !Number.isFinite(cv) || cv <= 0) return NaN;
  return ipm * cv;
}

function dialFromSignedClicks(axis, signedClicks) {
  const v = Number(signedClicks);
  const abs = Math.abs(v);
  if (axis === "windage") {
    // negative = LEFT, positive = RIGHT
    return (v < 0 ? "LEFT " : "RIGHT ") + fmt2(abs) + " clicks";
  }
  // elevation: negative = DOWN, positive = UP
  return (v < 0 ? "DOWN " : "UP ") + fmt2(abs) + " clicks";
}

// You must have these available from your detection/registration step:
// centerPx   = { x, y }  // bull center (pixels)
// groupCenterPx = { x, y } // shot group center (pixels)
// pixelsPerInch = number
// distanceYards, clickValueMoa = numbers

const ppi = Number(pixelsPerInch);
if (!Number.isFinite(ppi) || ppi <= 0) {
  return res.status(400).json({
    ok: false,
    error: "BAD_PIXELS_PER_INCH",
    detail: { pixelsPerInch }
  });
}

// Raw pixel deltas (group relative to bull)
const dxPx = Number(groupCenterPx.x) - Number(centerPx.x);
const dyPx = Number(groupCenterPx.y) - Number(centerPx.y);

// POIB inches (SCZN3): flip Y so UP is positive
const poibInches = {
  x: dxPx / ppi,
  y: (-dyPx) / ppi
};

const ipc = inchesPerClick(distanceYards, clickValueMoa);
if (!Number.isFinite(ipc) || ipc <= 0) {
  return res.status(400).json({
    ok: false,
    error: "BAD_INCHES_PER_CLICK",
    detail: { distanceYards, clickValueMoa, inchesPerClick: ipc }
  });
}

// CORRECTION clicks (what to dial) = -POIB / inchesPerClick
const clicksSigned = {
  windage: (-poibInches.x) / ipc,
  elevation: (-poibInches.y) / ipc
};

// Dial strings derived ONLY from clicksSigned signs
const dial = {
  windage: dialFromSignedClicks("windage", clicksSigned.windage),
  elevation: dialFromSignedClicks("elevation", clicksSigned.elevation)
};

// Rounded outputs for UI cleanliness
const clicksRounded = {
  windage: round2(clicksSigned.windage),
  elevation: round2(clicksSigned.elevation)
};

// (Use these in your JSON response)
