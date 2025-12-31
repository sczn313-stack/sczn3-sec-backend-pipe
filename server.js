"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// -------------------- Helpers --------------------
function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseTargetSizeSpec(specRaw) {
  // Accepts: "8.5x11", "8.5×11", "8.5 X 11"
  const s = String(specRaw || "")
    .trim()
    .toLowerCase()
    .replace("×", "x")
    .replace(/\s+/g, "");

  const m = s.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (!m) return null;

  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;

  return { spec: `${w}x${h}`, widthIn: w, heightIn: h };
}

// True MOA: 1 MOA = 1.047" @ 100y
function inchesPerClick(distanceYards, clickValueMoa) {
  const d = Number(distanceYards);
  const c = Number(clickValueMoa);
  if (!Number.isFinite(d) || d <= 0) return NaN;
  if (!Number.isFinite(c) || c <= 0) return NaN;
  const inchesPerMoa = 1.047 * (d / 100);
  return inchesPerMoa * c; // inches per click
}

function computePOIBFromHolesInches({ holesIn, bullX, bullY, deadbandIn, minShots }) {
  const bx = Number(bullX);
  const by = Number(bullY);

  if (!Number.isFinite(bx) || !Number.isFinite(by)) {
    return { ok: false, code: "NO_BULL", message: "Missing/invalid bullX or bullY." };
  }

  let used = 0;
  let ignored = 0;
  let sx = 0;
  let sy = 0;

  for (const h of holesIn || []) {
    const x = Number(h?.x);
    const y = Number(h?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    const dx = x - bx;
    const dy = y - by;

    // Deadband tolerance: ignore near either axis line
    if (Math.abs(dx) <= deadbandIn || Math.abs(dy) <= deadbandIn) {
      ignored += 1;
      continue;
    }

    sx += x;
    sy += y;
    used += 1;
  }

  if (used < minShots) {
    return {
      ok: false,
      code: "NOT_ENOUGH_USABLE_SHOTS",
      message: `Need at least ${minShots} usable holes after deadband filter.`,
      usedCount: used,
      ignoredCount: ignored,
    };
  }

  return {
    ok: true,
    poib: { x: sx / used, y: sy / used },
    usedCount: used,
    ignoredCount: ignored,
  };
}

// Coordinate assumption used here:
// x increases RIGHT
// y increases DOWN
//
// Direction rule (move POIB to bull):
// - POIB left  => RIGHT
// - POIB right => LEFT
// - POIB above => DOWN
// - POIB below => UP
//
// Signed convention returned:
//  windage  >0 RIGHT, <0 LEFT
//  elevation >0 UP,   <0 DOWN
function computeClicksSignedFromPOIB({ poibX, poibY, bullX, bullY, distanceYards, clickValueMoa }) {
  const ipc = inchesPerClick(distanceYards, clickValueMoa);
  if (!Number.isFinite(ipc) || ipc <= 0) return null;

  // bull - POIB: + => RIGHT, - => LEFT
  const windSigned = (bullX - poibX) / ipc;

  // y-down: POIB below bull => poibY > bullY => UP => positive
  const elevSigned = (poibY - bullY) / ipc;

  return {
    windage: round2(windSigned),
    elevation: round2(elevSigned),
  };
}

function labelsFromSigned(w, e) {
  return {
    windageDir: w >= 0 ? "RIGHT" : "LEFT",
    windageAbs: round2(Math.abs(w)),
    elevationDir: e >= 0 ? "UP" : "DOWN",
    elevationAbs: round2(Math.abs(e)),
  };
}

function quadrantOfPOIB(poibX, poibY, bullX, bullY) {
  const dx = poibX - bullX; // +RIGHT
  const dy = poibY - bullY; // +DOWN
  if (dx < 0 && dy < 0) return "UL";
  if (dx > 0 && dy < 0) return "UR";
  if (dx < 0 && dy > 0) return "LL";
  return "LR";
}

// -------------------- Routes --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "sczn3-sec-backend-pipe",
    build: "POIB_ANCHOR_V1",
    status: "alive",
  });
});

app.post("/api/sec", upload.single("image"), async (req, res) => {
  try {
    const distanceYards = Number(req.body.distanceYards ?? 100);
    const clickValueMoa = Number(req.body.clickValueMoa ?? 0.25);

    const targetSizeSpec = String(req.body.targetSizeSpec ?? "8.5x11");
    const size = parseTargetSizeSpec(targetSizeSpec);

    const bullX = Number(req.body.bullX);
    const bullY = Number(req.body.bullY);

    const deadbandIn = Number(req.body.deadbandIn ?? 0.10);
    const minShots = Number(req.body.minShots ?? 3);

    // Input holes (in inches)
    let holesIn = [];
    if (req.body.holesJson) {
      try {
        const parsed = JSON.parse(req.body.holesJson);
        if (Array.isArray(parsed)) holesIn = parsed;
      } catch (_) {}
    }

    if (!holesIn.length) {
      return res.status(400).json({
        ok: false,
        build: "POIB_ANCHOR_V1",
        error: {
          code: "NO_HOLES_INPUT",
          message:
            "No holesJson provided. This build expects holesJson (in inches) unless you wire a detector.",
        },
        required: {
          holesJson: '[{"x":4.10,"y":6.80},{"x":4.20,"y":6.75},{"x":4.05,"y":6.90}]',
          bullX: "inches",
          bullY: "inches",
        },
      });
    }

    const poibRes = computePOIBFromHolesInches({
      holesIn,
      bullX,
      bullY,
      deadbandIn: Number.isFinite(deadbandIn) ? deadbandIn : 0.10,
      minShots: Number.isFinite(minShots) ? minShots : 3,
    });

    if (!poibRes.ok) {
      return res.json({
        ok: false,
        build: "POIB_ANCHOR_V1",
        error: { code: poibRes.code, message: poibRes.message },
        debug: {
          usedCount: poibRes.usedCount ?? 0,
          ignoredCount: poibRes.ignoredCount ?? 0,
          deadbandIn,
          minShots,
        },
      });
    }

    const poibX = poibRes.poib.x;
    const poibY = poibRes.poib.y;

    const clicksSigned = computeClicksSignedFromPOIB({
      poibX,
      poibY,
      bullX,
      bullY,
      distanceYards,
      clickValueMoa,
    });

    if (!clicksSigned) {
      return res.json({
        ok: false,
        build: "POIB_ANCHOR_V1",
        error: { code: "BAD_SCALE", message: "Bad distanceYards or clickValueMoa." },
      });
    }

    const labels = labelsFromSigned(clicksSigned.windage, clicksSigned.elevation);

    return res.json({
      ok: true,
      build: "POIB_ANCHOR_V1",
      clicksSigned,
      scopeClicks: {
        windage: `${labels.windageDir} ${labels.windageAbs.toFixed(2)} clicks`,
        elevation: `${labels.elevationDir} ${labels.elevationAbs.toFixed(2)} clicks`,
      },
      debug: {
        poib: { x: round2(poibX), y: round2(poibY) },
        poibQuad: quadrantOfPOIB(poibX, poibY, bullX, bullY),
        usedCount: poibRes.usedCount,
        ignoredCount: poibRes.ignoredCount,
        deadbandIn,
        minShots,
        targetSizeSpec: size?.spec ?? targetSizeSpec,
      },
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      build: "POIB_ANCHOR_V1",
      error: { code: "SERVER_ERROR", message: err?.message || "Unknown error" },
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
