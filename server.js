// ============================================================
// BULL-LOCKED DIRECTION LOGIC (DETERMINISTIC)
// Goal: ALWAYS move the group center to the bull.
// We decide direction ONLY by where the group is vs the bull,
// in IMAGE SPACE (y grows DOWN).
//
// If group is LEFT  of bull -> dial RIGHT
// If group is RIGHT of bull -> dial LEFT
// If group is ABOVE bull -> dial DOWN
// If group is BELOW bull -> dial UP
// ============================================================

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function inchesPerMoaAtYards(yards) {
  const y = Number(yards);
  if (!Number.isFinite(y) || y <= 0) return NaN;
  return 1.047 * (y / 100);
}

// --- group center in pixels (average of hole centroids) ---
let sx = 0, sy = 0;
for (const h of holes) {
  sx += h.cx;
  sy += h.cy;
}
const groupCenterPx = { x: sx / holes.length, y: sy / holes.length };

// Convert to inches in IMAGE coords (origin top-left, y grows DOWN)
const groupCenterIn = mapPxToIn(groupCenterPx); // expects { xIn, yIn }

// Signed deltas in IMAGE-INCH space (y grows DOWN)
const dxImgIn = bull.x - groupCenterIn.xIn; // + => bull is to the RIGHT
const dyImgIn = bull.y - groupCenterIn.yIn; // + => bull is BELOW

// Directions (NO math tricks; pure "move to bull")
const dial = {
  windage: dxImgIn > 0 ? "RIGHT" : dxImgIn < 0 ? "LEFT" : "NONE",
  elevation: dyImgIn > 0 ? "DOWN" : dyImgIn < 0 ? "UP" : "NONE",
};

// Magnitudes in inches (always positive)
const absDxIn = Math.abs(dxImgIn);
const absDyIn = Math.abs(dyImgIn);

// Convert inches -> clicks (True MOA)
const ipm = inchesPerMoaAtYards(distanceYards);
const inchesPerClick = ipm * Number(clickValueMoa);

// Protect against bad inputs
const wClicksMag = (Number.isFinite(inchesPerClick) && inchesPerClick > 0)
  ? (absDxIn / inchesPerClick)
  : 0;

const eClicksMag = (Number.isFinite(inchesPerClick) && inchesPerClick > 0)
  ? (absDyIn / inchesPerClick)
  : 0;

// Signed clicks convention (RIGHT/UP positive, LEFT/DOWN negative)
const clicksSigned = {
  w:
    dial.windage === "RIGHT" ? round2(wClicksMag) :
    dial.windage === "LEFT"  ? -round2(wClicksMag) :
    0,
  e:
    dial.elevation === "UP"   ? round2(eClicksMag) :
    dial.elevation === "DOWN" ? -round2(eClicksMag) :
    0,
};

// POIB in SCZN3 terms (Right +, Up +)
const poibInches = {
  x: round2(groupCenterIn.xIn - bull.x),  // + => group right of bull
  y: round2(bull.y - groupCenterIn.yIn),  // + => group above bull
};
