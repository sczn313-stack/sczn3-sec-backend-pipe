import React, { useMemo, useState } from "react";

/**
 * SCZN3 SEC — Upload Test (Congruence Gate + Minimal Scope Clicks)
 *
 * Key rules:
 * - UI computes dial text ONLY from clicksSigned (never trust backend dial strings)
 * - UI enforces congruence: "what we sent" must match "what backend says it used"
 * - Always show two decimals
 */

const DEFAULT_ENDPOINT = "https://sczn3-sec-backend-pipe.onrender.com/api/sec";

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0.00";
  return (Math.round(x * 100) / 100).toFixed(2);
}

function abs2(n) {
  return round2(Math.abs(Number(n)));
}

/**
 * Accepts:
 * - "11"
 * - "23"
 * - "8.5x11" / "8.5×11" / "8.5 x 11"
 * Returns:
 * - ok, spec, long, short, sendInches (long side)  (ALL as Numbers)
 */
function parseTargetSpec(raw) {
  const s0 = String(raw ?? "").trim().toLowerCase();
  const s = s0.replaceAll("×", "x").replaceAll(" ", "");

  if (!s) return { ok: false, reason: "EMPTY" };

  // Numeric-only (11 / 23)
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "BAD_NUMBER" };
    return {
      ok: true,
      spec: `${n}`,
      long: n,
      short: n,
      sendInches: n,
    };
  }

  // WxH like 8.5x11
  const m = s.match(/^(\d+(\.\d+)?)[x](\d+(\.\d+)?)$/);
  if (!m) return { ok: false, reason: "BAD_FORMAT (use 11, 23, or 8.5x11)" };

  const a = Number(m[1]);
  const b = Number(m[3]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    return { ok: false, reason: "BAD_DIMENSIONS" };
  }

  const long = Math.max(a, b);
  const short = Math.min(a, b);

  return {
    ok: true,
    spec: `${a}x${b}`,
    long,
    short,
    sendInches: long, // we send long side as the canonical inches value
  };
}

/**
 * Compute UI dial text from signed correction clicks.
 * Convention used by your current output:
 * - negative windage => LEFT
 * - positive windage => RIGHT
 * - negative elevation => DOWN
 * - positive elevation => UP
 */
function uiDialFromClicksSigned(clicksSigned) {
  const w = Number(clicksSigned?.windage);
  const e = Number(clicksSigned?.elevation);

  const windageDir = !Number.isFinite(w) || w === 0 ? "CENTER" : w < 0 ? "LEFT" : "RIGHT";
  const elevationDir = !Number.isFinite(e) || e === 0 ? "LEVEL" : e < 0 ? "DOWN" : "UP";

  const windageAbs = !Number.isFinite(w) ? "0.00" : abs2(w);
  const elevationAbs = !Number.isFinite(e) ? "0.00" : abs2(e);

  return {
    windageDir,
    elevationDir,
    windageAbs,
    elevationAbs,
    windageText: `${windageDir} ${windageAbs} clicks`,
    elevationText: `${elevationDir} ${elevationAbs} clicks`,
  };
}

/**
 * Attempt to parse backend "dial" strings like:
 * "LEFT 17.51 clicks"
 * "DOWN 26.79 clicks"
 */
function parseBackendDialDir(dialStr) {
  const s = String(dialStr ?? "").trim().toUpperCase();
  if (!s) return null;
  if (s.includes("LEFT")) return "LEFT";
  if (s.includes("RIGHT")) return "RIGHT";
  if (s.includes("UP")) return "UP";
  if (s.includes("DOWN")) return "DOWN";
  if (s.includes("CENTER")) return "CENTER";
  if (s.includes("LEVEL")) return "LEVEL";
  return null;
}

export default function App() {
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);

  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");

  const [targetSpec, setTargetSpec] = useState("8.5x11");
  const parsed = useMemo(() => parseTargetSpec(targetSpec), [targetSpec]);

  const [distanceYards, setDistanceYards] = useState("100");
  const [clickValueMoa, setClickValueMoa] = useState("0.25");

  const [status, setStatus] = useState("");
  const [resp, setResp] = useState(null);
  const [showRaw, setShowRaw] = useState(true);

  const [incongruenceLog, setIncongruenceLog] = useState([]);

  function resetOutputs() {
    setStatus("");
    setResp(null);
    setIncongruenceLog([]);
  }

  function onChooseFile(e) {
    const f = e.target.files?.[0] || null;
    setFile(f);
    resetOutputs();

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (f) {
      const u = URL.createObjectURL(f);
      setPreviewUrl(u);
    } else {
      setPreviewUrl("");
    }
  }

  async function send() {
    setIncongruenceLog([]);
    setResp(null);

    if (!file) {
      setStatus("Pick an image first.");
      return;
    }
    if (!parsed.ok) {
      setStatus(`Target size invalid: ${parsed.reason}`);
      return;
    }

    const dy = Number(distanceYards);
    const cv = Number(clickValueMoa);
    if (!Number.isFinite(dy) || dy <= 0) {
      setStatus("Distance must be a positive number.");
      return;
    }
    if (!Number.isFinite(cv) || cv <= 0) {
      setStatus("Click value must be a positive number.");
      return;
    }

    const fd = new FormData();
    fd.append("image", file);
    fd.append("distanceYards", String(dy));
    fd.append("clickValueMoa", String(cv));
    fd.append("targetSizeInches", String(parsed.sendInches)); // canonical (long side)

    setStatus("Uploading…");

    let json;
    try {
      const r = await fetch(endpoint, { method: "POST", body: fd });
      json = await r.json();
    } catch (err) {
      setStatus(`Network/parse error: ${String(err)}`);
      return;
    }

    setResp(json);
    setStatus(json?.ok ? "Done." : "Backend returned ok=false.");

    // ---------- Congruence Gate ----------
    const logs = [];

    const sentTarget = Number(parsed.sendInches);
    const backendTarget = Number(json?.sec?.targetSizeInches);

    if (Number.isFinite(backendTarget) && Number.isFinite(sentTarget)) {
      // allow tiny float wiggle
      if (Math.abs(backendTarget - sentTarget) > 0.01) {
        logs.push({
          code: "TARGET_SIZE_INCONGRUENT",
          sent: sentTarget,
          backend: backendTarget,
          fix: "UI must send the same canonical targetSizeInches the backend uses. Do not mix 8.5x11 with 23.",
        });
      }
    }

    // Dial direction congruence:
    // UI dial should be derived from clicksSigned. Backend dial strings are informational ONLY.
    const uiDial = uiDialFromClicksSigned(json?.clicksSigned);

    const backendWindDir = parseBackendDialDir(json?.dial?.windage);
    const backendElevDir = parseBackendDialDir(json?.dial?.elevation);

    // windage: compare only if backend provides it
    if (backendWindDir && backendWindDir !== uiDial.windageDir) {
      logs.push({
        code: "WINDAGE_DIRECTION_INCONGRUENT",
        uiDial: uiDial.windageDir,
        backendDial: json?.dial?.windage,
        clicksSigned: { windage: json?.clicksSigned?.windage },
        fix: "Do not trust backend dial strings. UI should render direction from clicksSigned only.",
      });
    }

    // elevation: compare only if backend provides it
    if (backendElevDir && backendElevDir !== uiDial.elevationDir) {
      logs.push({
        code: "ELEVATION_DIRECTION_INCONGRUENT",
        uiDial: uiDial.elevationDir,
        backendDial: json?.dial?.elevation,
        clicksSigned: { elevation: json?.clicksSigned?.elevation },
        fix: "Do not trust backend dial strings. UI should render direction from clicksSigned only. (Backend dial text likely has a y-axis flip issue.)",
      });
    }

    setIncongruenceLog(logs);
  }

  const uiDial = useMemo(() => uiDialFromClicksSigned(resp?.clicksSigned), [resp]);

  return (
    <div style={{ padding: 18, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
      <div style={{ fontSize: 44, fontWeight: 900, marginBottom: 10 }}>
        SCZN3 SEC — Upload Test
      </div>

      <div style={{ marginBottom: 10, opacity: 0.85 }}>
        Endpoint
        <input
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          style={{
            width: "100%",
            padding: 10,
            fontSize: 16,
            borderRadius: 10,
            border: "1px solid #bbb",
            marginTop: 6,
          }}
        />
        <div style={{ marginTop: 6, fontSize: 14 }}>
          POST multipart field: <b>image</b>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* LEFT */}
        <div
          style={{
            border: "2px solid #111",
            borderRadius: 14,
            padding: 14,
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 6 }}>Choose file</div>
            <input type="file" accept="image/*" onChange={onChooseFile} />
            {file ? <div style={{ marginTop: 6, opacity: 0.8 }}>{file.name}</div> : null}
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 6 }}>Target Size</div>
            <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 10 }}>
              <select
                value={targetSpec}
                onChange={(e) => setTargetSpec(e.target.value)}
                style={{
                  padding: 10,
                  fontSize: 16,
                  borderRadius: 10,
                  border: "1px solid #bbb",
                }}
              >
                <option value="8.5x11">8.5x11</option>
                <option value="11">11</option>
                <option value="23">23</option>
              </select>

              <input
                value={targetSpec}
                onChange={(e) => setTargetSpec(e.target.value)}
                placeholder="8.5x11 or 11 or 23"
                style={{
                  padding: 10,
                  fontSize: 16,
                  borderRadius: 10,
                  border: "1px solid #bbb",
                }}
              />
            </div>

            <div style={{ marginTop: 6, fontSize: 14, opacity: 0.8 }}>
              {parsed.ok ? (
                <>
                  Parsed: spec=<b>{parsed.spec}</b> long=<b>{round2(parsed.long)}</b> short=<b>{round2(parsed.short)}</b>{" "}
                  → sending targetSizeInches=<b>{round2(parsed.sendInches)}</b>
                </>
              ) : (
                <>
                  <b>Invalid:</b> {parsed.reason}
                </>
              )}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Distance (yards)</div>
              <input
                value={distanceYards}
                onChange={(e) => setDistanceYards(e.target.value)}
                style={{
                  width: "100%",
                  padding: 10,
                  fontSize: 16,
                  borderRadius: 10,
                  border: "1px solid #bbb",
                }}
              />
            </div>

            <div>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Click Value (MOA)</div>
              <input
                value={clickValueMoa}
                onChange={(e) => setClickValueMoa(e.target.value)}
                style={{
                  width: "100%",
                  padding: 10,
                  fontSize: 16,
                  borderRadius: 10,
                  border: "1px solid #bbb",
                }}
              />
            </div>
          </div>

          <button
            onClick={send}
            style={{
              width: "100%",
              padding: 16,
              fontSize: 20,
              fontWeight: 900,
              borderRadius: 14,
              border: "3px solid #2b66ff",
              background: "#eaf1ff",
              cursor: "pointer",
            }}
          >
            Send (with Congruence Gate)
          </button>

          <div style={{ marginTop: 10, fontSize: 16 }}>
            <b>Status:</b> {status || "—"}
          </div>

          {/* Minimal Scope Clicks */}
          {resp?.ok ? (
            <div
              style={{
                marginTop: 12,
                border: "3px solid #1a8d3a",
                borderRadius: 14,
                padding: 14,
                background: "#f4fff7",
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 8 }}>Scope Clicks (Minimal)</div>

              <div style={{ fontSize: 18, marginBottom: 6 }}>
                <b>Windage:</b> {uiDial.windageText}
              </div>
              <div style={{ fontSize: 18, marginBottom: 10 }}>
                <b>Elevation:</b> {uiDial.elevationText}
              </div>

              <div style={{ fontSize: 14, opacity: 0.85, lineHeight: 1.35 }}>
                clicksSigned: w={round2(resp?.clicksSigned?.windage)}, e={round2(resp?.clicksSigned?.elevation)}{" "}
                POIB inches: x={round2(resp?.poibInches?.x)}, y={round2(resp?.poibInches?.y)}
                <br />
                computeStatus: {String(resp?.computeStatus || "")} &nbsp; backend sec.targetSizeInches:{" "}
                {round2(resp?.sec?.targetSizeInches)}
              </div>
            </div>
          ) : null}

          {/* Incongruence Log */}
          {incongruenceLog.length > 0 ? (
            <div
              style={{
                marginTop: 12,
                border: "3px solid #cc1f1a",
                borderRadius: 14,
                padding: 14,
                background: "#fff5f5",
              }}
            >
              <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 6 }}>Incongruence Log</div>
              <div style={{ marginBottom: 10, opacity: 0.85 }}>
                This result was received, but one or more variables are not congruent. Do not trust the output until fixed.
              </div>

              {incongruenceLog.map((x, idx) => (
                <div
                  key={idx}
                  style={{
                    border: "1px solid #e3b1b1",
                    borderRadius: 12,
                    padding: 12,
                    background: "#fff",
                    marginBottom: 10,
                  }}
                >
                  <div style={{ fontWeight: 900, marginBottom: 8 }}>{x.code}</div>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {JSON.stringify(x, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          ) : null}

          {/* Raw JSON Toggle */}
          <div style={{ marginTop: 12 }}>
            <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
              <b>Show raw JSON</b>
            </label>
          </div>
        </div>

        {/* RIGHT */}
        <div>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Preview</div>

          <div
            style={{
              border: "2px solid #111",
              borderRadius: 14,
              overflow: "hidden",
              background: "#fff",
            }}
          >
            {previewUrl ? (
              <img src={previewUrl} alt="preview" style={{ width: "100%", height: "auto", display: "block" }} />
            ) : (
              <div style={{ padding: 24, opacity: 0.7 }}>Choose an image to preview.</div>
            )}
          </div>

          {showRaw && resp ? (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Response</div>
              <pre
                style={{
                  padding: 12,
                  background: "#111",
                  color: "#fff",
                  borderRadius: 12,
                  overflowX: "auto",
                  fontSize: 12,
                }}
              >
                {JSON.stringify(resp, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
