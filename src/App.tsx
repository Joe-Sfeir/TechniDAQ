// src/App.tsx
import { useState, useEffect, useRef, useCallback } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import "./App.css";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MeterReading {
  voltage: number; current: number; active_power: number;
  total_energy: number; timestamp_ms: number;
  power_factor: number; frequency: number;
}
interface FaultEvent  { reason: string; timestamp_ms: number; }
interface StatusEvent { state: PollState; }
interface ChartPoint  { time: string; voltage: number; active_power: number; current: number; }

interface AuthState {
  valid:         boolean;
  username?:     string;
  project_name?: string;
  expiry_date?:  number; // Unix timestamp
}

type PollState    = "running" | "stopped" | "fault";
type Theme        = "dark" | "light";
type ExportStatus = "idle" | "saving" | "success" | "error";
type Timeframe    = "live" | "1h" | "24h" | "7d" | "all";

const MAX_HISTORY = 60;

const COM_PORT_OPTIONS = [
  "COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8",
  "COM9","COM10","COM11","COM12",
];

// ─── License Gateway ──────────────────────────────────────────────────────────

function LicenseGateway({ onActivated }: { onActivated: (auth: AuthState) => void }) {
  const [licenseKey,   setLicenseKey]   = useState("");
  const [username,     setUsername]     = useState("");
  const [projectName,  setProjectName]  = useState("");
  const [error,        setError]        = useState<string | null>(null);
  const [activating,   setActivating]   = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);

  const handleActivate = async () => {
    setError(null);
    if (!licenseKey.trim())   { setError("License key is required."); return; }
    if (!username.trim())     { setError("Username is required."); return; }
    if (!projectName.trim())  { setError("Project name is required."); return; }

    setActivating(true);
    try {
      await invoke<string>("activate_license", {
        key:         licenseKey.trim(),
        username:    username.trim(),
        projectName: projectName.trim(),
      });
      // Re-query auth state so we get the full record back
      const auth = await invoke<AuthState>("get_auth_state");
      onActivated(auth);
    } catch (err: unknown) {
      setError(String(err));
    } finally {
      setActivating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !activating) handleActivate();
  };

  // Shared input style factory
  const inputStyle = (field: string): React.CSSProperties => ({
    width: "100%",
    padding: "12px 16px",
    background: "rgba(255,255,255,0.04)",
    border: `1px solid ${focusedField === field ? "rgba(34,68,240,0.7)" : "rgba(255,255,255,0.1)"}`,
    borderRadius: "8px",
    color: "#e2e8f0",
    fontFamily: field === "key" ? "'Share Tech Mono', monospace" : "'Rajdhani', sans-serif",
    fontSize: field === "key" ? "0.72rem" : "0.95rem",
    fontWeight: field === "key" ? 400 : 600,
    letterSpacing: field === "key" ? "0.06em" : "0.04em",
    outline: "none",
    transition: "border-color 0.2s ease, box-shadow 0.2s ease",
    boxShadow: focusedField === field ? "0 0 0 3px rgba(34,68,240,0.15)" : "none",
  });

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontFamily: "'Share Tech Mono', monospace",
    fontSize: "0.58rem",
    letterSpacing: "0.25em",
    color: "#4a5c7a",
    textTransform: "uppercase",
    marginBottom: "8px",
  };

  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "#050608",
      backgroundImage: "radial-gradient(circle, rgba(26,31,42,0.8) 1px, transparent 1px)",
      backgroundSize: "28px 28px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 9999,
    }}>
      {/* Ambient glows */}
      <div style={{
        position: "absolute", top: -160, left: -160,
        width: 520, height: 520, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(34,68,240,0.12) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", bottom: -160, right: -160,
        width: 520, height: 520, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(0,229,160,0.07) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      {/* Card */}
      <div style={{
        width: "100%", maxWidth: 480,
        background: "linear-gradient(145deg, #0f1318 0%, #0a0c0f 100%)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: "16px",
        boxShadow: "0 24px 80px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)",
        overflow: "hidden",
        position: "relative",
        zIndex: 1,
      }}>
        {/* Top accent stripe */}
        <div style={{
          height: "2px",
          background: "linear-gradient(90deg, transparent, #2244F0, #00e5a0, transparent)",
          opacity: 0.8,
        }} />

        <div style={{ padding: "40px 40px 36px" }}>
          {/* Brand header */}
          <div style={{ textAlign: "center", marginBottom: "36px" }}>
            {/* Bolt icon */}
            <div style={{
              width: 52, height: 52, margin: "0 auto 16px",
              background: "rgba(34,68,240,0.12)",
              border: "1px solid rgba(34,68,240,0.3)",
              borderRadius: "12px",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="#2244F0">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
              </svg>
            </div>

            <div style={{
              fontFamily: "'Rajdhani', sans-serif",
              fontWeight: 700, fontSize: "1.6rem",
              letterSpacing: "0.08em",
              color: "#e2e8f0",
              lineHeight: 1,
              marginBottom: "6px",
            }}>TechniDAQ</div>

            <div style={{
              fontFamily: "'Share Tech Mono', monospace",
              fontSize: "0.6rem",
              letterSpacing: "0.22em",
              color: "#2a3550",
              textTransform: "uppercase",
            }}>by Technicat Group · License Activation</div>
          </div>

          {/* Fields */}
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>

            {/* License Key */}
            <div>
              <label style={labelStyle}>License Key</label>
              <textarea
                value={licenseKey}
                onChange={e => { setLicenseKey(e.target.value); setError(null); }}
                onFocus={() => setFocusedField("key")}
                onBlur={() => setFocusedField(null)}
                onKeyDown={handleKeyDown}
                placeholder="Paste your license key here…"
                rows={3}
                style={{
                  ...inputStyle("key"),
                  resize: "none",
                  lineHeight: 1.6,
                }}
              />
            </div>

            {/* Username + Project Name side by side */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
              <div>
                <label style={labelStyle}>Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={e => { setUsername(e.target.value); setError(null); }}
                  onFocus={() => setFocusedField("user")}
                  onBlur={() => setFocusedField(null)}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. john.smith"
                  style={inputStyle("user")}
                />
              </div>
              <div>
                <label style={labelStyle}>Project Name</label>
                <input
                  type="text"
                  value={projectName}
                  onChange={e => { setProjectName(e.target.value); setError(null); }}
                  onFocus={() => setFocusedField("proj")}
                  onBlur={() => setFocusedField(null)}
                  onKeyDown={handleKeyDown}
                  placeholder="e.g. Site Alpha"
                  style={inputStyle("proj")}
                />
              </div>
            </div>

            {/* Error message */}
            {error && (
              <div style={{
                display: "flex", alignItems: "flex-start", gap: "10px",
                padding: "12px 14px",
                background: "rgba(249,115,22,0.08)",
                border: "1px solid rgba(249,115,22,0.3)",
                borderRadius: "8px",
              }}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                  stroke="#f97316" strokeWidth={2.5} style={{ flexShrink: 0, marginTop: 1 }}>
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <span style={{
                  fontFamily: "'Share Tech Mono', monospace",
                  fontSize: "0.68rem",
                  color: "#fb923c",
                  letterSpacing: "0.04em",
                  lineHeight: 1.5,
                }}>{error}</span>
              </div>
            )}

            {/* Activate button */}
            <button
              onClick={handleActivate}
              disabled={activating}
              style={{
                width: "100%",
                padding: "13px",
                background: activating
                  ? "rgba(34,68,240,0.15)"
                  : "linear-gradient(135deg, #1635D4, #2244F0)",
                border: "1px solid rgba(34,68,240,0.5)",
                borderRadius: "8px",
                color: activating ? "#4a5c7a" : "#fff",
                fontFamily: "'Rajdhani', sans-serif",
                fontWeight: 700,
                fontSize: "0.875rem",
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                cursor: activating ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "10px",
                transition: "all 0.2s ease",
                boxShadow: activating ? "none" : "0 4px 20px rgba(34,68,240,0.35)",
              }}
            >
              {activating ? (
                <>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                    stroke="currentColor" strokeWidth={2.5}
                    style={{ animation: "spin 1s linear infinite" }}>
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                  Activating…
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                    stroke="currentColor" strokeWidth={2.5}>
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                  Activate License
                </>
              )}
            </button>
          </div>

          {/* Footer note */}
          <div style={{
            marginTop: "24px",
            textAlign: "center",
            fontFamily: "'Share Tech Mono', monospace",
            fontSize: "0.55rem",
            letterSpacing: "0.15em",
            color: "#2a3550",
            textTransform: "uppercase",
          }}>
            Offline · Cryptographic · AES-256-GCM
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Auth Loading Spinner ─────────────────────────────────────────────────────

function AuthLoadingScreen() {
  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "#050608",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      gap: "20px", zIndex: 9999,
    }}>
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none"
        stroke="#2244F0" strokeWidth={2}
        style={{ animation: "spin 1s linear infinite", opacity: 0.7 }}>
        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
      </svg>
      <span style={{
        fontFamily: "'Share Tech Mono', monospace",
        fontSize: "0.6rem",
        letterSpacing: "0.3em",
        color: "#2a3550",
        textTransform: "uppercase",
      }}>Verifying License…</span>
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

interface ToastState { message: string; type: "success"|"error"|"warn"; visible: boolean; }

function Toast({ message, type, visible }: ToastState) {
  return (
    <div className={`toast toast-${type} ${visible ? "toast-visible" : "toast-hidden"}`}>
      {type === "success" && <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5}><polyline points="20 6 9 17 4 12"/></svg>}
      {type === "warn"    && <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>}
      {type === "error"   && <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>}
      <span>{message}</span>
    </div>
  );
}

// ─── COM Port Selector ────────────────────────────────────────────────────────

function ComPortSelector({
  value, onChange, disabled,
}: {
  value: string; onChange: (v: string) => void; disabled: boolean;
}) {
  const [isCustom, setIsCustom] = useState(false);

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (e.target.value === "__custom__") {
      setIsCustom(true);
    } else {
      setIsCustom(false);
      onChange(e.target.value);
    }
  };

  return (
    <div className="com-port-selector" title={disabled ? "Stop polling to change COM port" : "Select RS485 COM port"}>
      <span className="com-port-label">PORT</span>
      {isCustom ? (
        <input
          type="text"
          className="com-port-input"
          value={value}
          placeholder="e.g. COM5"
          disabled={disabled}
          onChange={e => onChange(e.target.value.toUpperCase())}
          onBlur={() => { if (!value) setIsCustom(false); }}
          autoFocus
          maxLength={10}
        />
      ) : (
        <select
          className="com-port-select"
          value={COM_PORT_OPTIONS.includes(value) ? value : "__custom__"}
          onChange={handleSelect}
          disabled={disabled}
        >
          {COM_PORT_OPTIONS.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
          <option value="__custom__">Custom…</option>
        </select>
      )}
      <div className={`com-port-dot ${disabled ? "com-port-dot-active" : "com-port-dot-idle"}`} />
    </div>
  );
}

// ─── Timeframe Tabs ───────────────────────────────────────────────────────────

const TIMEFRAMES: { key: Timeframe; label: string }[] = [
  { key:"live", label:"Live"     },
  { key:"1h",   label:"1 Hour"   },
  { key:"24h",  label:"24 Hours" },
  { key:"7d",   label:"7 Days"   },
  { key:"all",  label:"All"      },
];

function TimeframeTabs({ active, onChange }: { active: Timeframe; onChange: (t: Timeframe) => void }) {
  return (
    <div className="timeframe-tabs">
      {TIMEFRAMES.map(({ key, label }) => (
        <button key={key}
          className={`timeframe-tab ${active === key ? "timeframe-tab-active" : ""}`}
          onClick={() => onChange(key)}>
          {label}
          {key !== "live" && <span className="timeframe-tab-soon">soon</span>}
        </button>
      ))}
    </div>
  );
}

// ─── Custom Chart Tooltip ─────────────────────────────────────────────────────

interface TooltipItem { name: string; value: number; color: string; dataKey: string; }

function CustomTooltip({ active, payload, label, theme }: {
  active?: boolean; payload?: TooltipItem[]; label?: string; theme: Theme;
}) {
  if (!active || !payload?.length) return null;
  const isDark = theme === "dark";
  const unitMap: Record<string,string> = { voltage:"V", active_power:"kW", current:"A" };
  return (
    <div style={{
      background:   isDark ? "rgba(8,12,24,0.97)"  : "rgba(255,255,255,0.97)",
      border:       `1px solid ${isDark ? "rgba(45,95,245,0.3)" : "rgba(21,53,212,0.15)"}`,
      borderRadius: "8px", padding: "10px 14px",
      boxShadow:    isDark ? "0 8px 32px rgba(0,0,0,0.6)" : "0 4px 20px rgba(21,53,212,0.12)",
      fontFamily:   "'Share Tech Mono', monospace", minWidth: "160px",
    }}>
      <div style={{ fontSize:"0.6rem", letterSpacing:"0.2em", marginBottom:"8px",
        color: isDark ? "#4a5c7a" : "#8fa3c8", textTransform:"uppercase" }}>{label}</div>
      {payload.map(item => (
        <div key={item.dataKey} style={{ display:"flex", justifyContent:"space-between",
          alignItems:"center", gap:"16px", marginBottom:"4px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:"6px" }}>
            <div style={{ width:"8px", height:"8px", borderRadius:"50%",
              backgroundColor:item.color, boxShadow:`0 0 6px ${item.color}80` }} />
            <span style={{ fontSize:"0.65rem", color: isDark ? "#8fa3c8":"#4a64a8", letterSpacing:"0.1em" }}>
              {item.name.toUpperCase()}
            </span>
          </div>
          <span style={{ fontSize:"0.8rem", color:item.color, fontWeight:"bold" }}>
            {item.value.toFixed(item.dataKey === "active_power" ? 3 : 1)}{" "}
            <span style={{ fontSize:"0.6rem", opacity:0.7 }}>{unitMap[item.dataKey]}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Chart Card ───────────────────────────────────────────────────────────────

function ChartCard({ history, theme, timeframe, onTimeframeChange, pollState }: {
  history: ChartPoint[]; theme: Theme;
  timeframe: Timeframe; onTimeframeChange: (t: Timeframe) => void;
  pollState: PollState;
}) {
  const isDark     = theme === "dark";
  const voltColor  = isDark ? "#2d5ff5" : "#1535d4";
  const powerColor = isDark ? "#00d4ff" : "#0369a1";
  const gridColor  = isDark ? "rgba(255,255,255,0.04)" : "rgba(21,53,212,0.06)";
  const axisColor  = isDark ? "#2a3550" : "#c7d4ee";
  const tickColor  = isDark ? "#4a5c7a" : "#8fa3c8";

  const vMin = history.length ? Math.min(...history.map(p=>p.voltage)) - 2   : 220;
  const vMax = history.length ? Math.max(...history.map(p=>p.voltage)) + 2   : 240;
  const pMin = history.length ? Math.min(...history.map(p=>p.active_power)) - 0.5 : 0;
  const pMax = history.length ? Math.max(...history.map(p=>p.active_power)) + 0.5 : 10;
  const isStopped = pollState === "stopped";

  return (
    <div className="chart-card">
      <div className="chart-card-header">
        <div className="chart-card-title-row">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={voltColor} strokeWidth={2.5} style={{ flexShrink:0 }}>
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span className="chart-card-title">REAL-TIME WAVEFORM</span>
          <div className="chart-title-accent" style={{ background:`linear-gradient(90deg,${voltColor},${powerColor})` }} />
        </div>
        <div className="chart-card-meta">
          <span className="chart-window-label">WINDOW</span>
          <span className="chart-window-value">{history.length} / {MAX_HISTORY} s</span>
        </div>
      </div>

      <div className="chart-tabs-row">
        <TimeframeTabs active={timeframe} onChange={onTimeframeChange} />
        <div className="chart-legend-row">
          {[{color:voltColor,label:"Voltage",unit:"V"},{color:powerColor,label:"Active Power",unit:"kW"}]
            .map(({color,label,unit}) => (
            <div key={label} className="chart-legend-item">
              <div className="chart-legend-dot" style={{ background:color, boxShadow:`0 0 8px ${color}80` }} />
              <span className="chart-legend-label" style={{ color: isDark ? "#8fa3c8":"#4a64a8" }}>{label}</span>
              <span className="chart-legend-unit"  style={{ color:tickColor }}>({unit})</span>
            </div>
          ))}
          <span className={`chart-live-badge ${isStopped ? "chart-live-badge-stopped":""}`}
            style={{
              borderColor: isStopped ? "rgba(148,163,184,0.25)" : (isDark?"rgba(0,212,255,0.3)":"rgba(21,53,212,0.2)"),
              color: isStopped ? (isDark?"#4a5c7a":"#94a3b8") : (isDark?"#00d4ff":"#1535d4"),
            }}>
            <span className="chart-live-dot" style={{
              background: isStopped ? "#4a5c7a" : (isDark?"#00d4ff":"#1535d4"),
              animationPlayState: isStopped ? "paused":"running",
            }}/>
            {isStopped ? "PAUSED" : "LIVE"}
          </span>
        </div>
      </div>

      <div className="chart-area">
        {history.length === 0 ? (
          <div className="chart-empty">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke={tickColor} strokeWidth={1.5}>
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span style={{ color:tickColor, fontFamily:"'Share Tech Mono',monospace", fontSize:"0.7rem", letterSpacing:"0.2em" }}>
              {isStopped ? "POLLING STOPPED" : "AWAITING DATA..."}
            </span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={history} margin={{ top:8, right:16, left:0, bottom:0 }}>
              <CartesianGrid stroke={gridColor} strokeDasharray="4 4" vertical={false} />
              <XAxis dataKey="time"
                tick={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, fill:tickColor }}
                axisLine={{ stroke:axisColor }} tickLine={false}
                interval="preserveStartEnd" minTickGap={60} />
              <YAxis yAxisId="volt" orientation="left" domain={[vMin,vMax]}
                tick={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, fill:voltColor }}
                axisLine={false} tickLine={false} width={52}
                tickFormatter={v=>`${v.toFixed(0)}V`} />
              <YAxis yAxisId="power" orientation="right" domain={[pMin,pMax]}
                tick={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, fill:powerColor }}
                axisLine={false} tickLine={false} width={56}
                tickFormatter={v=>`${v.toFixed(1)}kW`} />
              <Tooltip content={<CustomTooltip theme={theme} />}
                cursor={{ stroke: isDark?"rgba(255,255,255,0.06)":"rgba(21,53,212,0.08)", strokeWidth:1, strokeDasharray:"4 4" }} />
              <Legend wrapperStyle={{ display:"none" }} />
              <Line yAxisId="volt" type="monotone" dataKey="voltage"
                name="Voltage" stroke={voltColor} strokeWidth={2} dot={false}
                activeDot={{ r:4, fill:voltColor, stroke:isDark?"#080c18":"#fff", strokeWidth:2 }}
                isAnimationActive={false} />
              <Line yAxisId="power" type="monotone" dataKey="active_power"
                name="Active Power" stroke={powerColor} strokeWidth={2} dot={false}
                activeDot={{ r:4, fill:powerColor, stroke:isDark?"#080c18":"#fff", strokeWidth:2 }}
                isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ─── Header Control Buttons ───────────────────────────────────────────────────

function PollToggleButton({ pollState, onToggle }: { pollState: PollState; onToggle: () => void }) {
  const isRunning = pollState === "running";
  const isFault   = pollState === "fault";
  return (
    <button className={`ctrl-btn poll-btn-${pollState}`} onClick={onToggle}
      title={isRunning ? "Stop polling" : "Start polling"}>
      {isRunning || isFault ? (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
      )}
      <span>{isRunning ? "Stop" : isFault ? "Reset" : "Start"}</span>
    </button>
  );
}

function ClearButton({ onClear }: { onClear: () => void }) {
  return (
    <button className="ctrl-btn clear-btn" onClick={onClear} title="Clear all stored readings">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6"/><path d="M14 11v6"/>
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
      </svg>
      <span>Clear</span>
    </button>
  );
}

function ExportButton({ onExport, status }: { onExport: () => void; status: ExportStatus }) {
  const label = { idle:"Export Excel", saving:"Saving…", success:"Exported!", error:"Failed" }[status];
  const icon = {
    idle:    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
    saving:  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} style={{ animation:"spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>,
    success: <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5}><polyline points="20 6 9 17 4 12"/></svg>,
    error:   <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  }[status];
  return (
    <button className={`ctrl-btn export-btn export-btn-${status}`}
      onClick={onExport} disabled={status === "saving"}>
      {icon}<span>{label}</span>
    </button>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className="ctrl-btn theme-toggle">
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="5"/>
          <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
          <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      )}
      <span>{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}

function Logo({ theme }: { theme: Theme }) {
  const src = theme === "light" ? "/src/assets/logo1.png" : "/src/assets/logo2.png";
  return (
    <div className="logo-container">
      <img key={src} src={src} alt="Technicat Group" className="logo-img"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
          const fb = e.currentTarget.nextElementSibling as HTMLElement | null;
          if (fb) fb.style.display = "flex";
        }}
      />
      <div className="logo-fallback" style={{ display:"none" }}>
        <svg viewBox="0 0 24 24" className="logo-bolt" fill="currentColor">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
      </div>
    </div>
  );
}

// ─── Metric Card ──────────────────────────────────────────────────────────────

interface MetricCardProps {
  label:string; value:string; unit:string; sublabel?:string; subvalue?:string;
  colorKey:"volt"|"ampere"|"watt"|"joule"; icon:React.ReactNode; updated:boolean;
}
function MetricCard({ label,value,unit,sublabel,subvalue,colorKey,icon,updated }:MetricCardProps) {
  return (
    <div className={`metric-card-${colorKey}`}>
      <div className="card-inner">
        <div className="card-header">
          <div className="card-label-row">
            <span className={`card-icon icon-${colorKey}`}>{icon}</span>
            <span className="card-label">{label}</span>
          </div>
          <div className={`card-accent-line accent-${colorKey}`} />
        </div>
        <div className="card-value-row">
          <span className={`metric-value card-value value-${colorKey} ${updated?"value-updated":""}`} key={String(updated)}>
            {value}
          </span>
          <span className="card-unit">{unit}</span>
        </div>
        {sublabel && subvalue && (
          <div className="card-footer">
            <span className="card-sublabel">{sublabel}</span>
            <span className={`card-subvalue subvalue-${colorKey}`}>{subvalue}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({ pollState, timestamp, frequency, theme, onThemeToggle,
  onTogglePoll, onClear, onExport, exportStatus, comPort, onComPortChange,
  username, projectName }: {
  pollState: PollState; timestamp: number; frequency: number;
  theme: Theme; onThemeToggle: () => void;
  onTogglePoll: () => void; onClear: () => void;
  onExport: () => void; exportStatus: ExportStatus;
  comPort: string; onComPortChange: (v: string) => void;
  username: string; projectName: string;
}) {
  const timeStr = timestamp
    ? new Date(timestamp).toLocaleTimeString("en-GB", { hour12:false })
    : "--:--:--";

  const statusConfig = {
    running: { label:"LIVE",    ledClass:"status-led-running", textClass:"status-text-online"  },
    stopped: { label:"STOPPED", ledClass:"status-led-stopped", textClass:"status-text-stopped" },
    fault:   { label:"FAULT",   ledClass:"status-led-fault",   textClass:"status-text-fault"   },
  }[pollState];

  const isPolling = pollState === "running" || pollState === "fault";

  return (
    <header className="app-header">
      {/* Brand */}
      <div className="header-brand">
        <Logo theme={theme} />
        <div className="brand-text">
          <div className="brand-name">TechniDAQ</div>
          <div className="brand-sub">by Technicat Group</div>
        </div>
      </div>

      {/* Center: device + COM port */}
      <div className="header-center">
        <div className="device-info-primary">SCHNEIDER PM2220 · RS485 · MODBUS RTU</div>
        <div className="header-com-row">
          <div className="device-info-secondary">SLAVE ID: 01 · BAUD: 19200 · PARITY: EVEN</div>
          <div className="header-com-divider" />
          <ComPortSelector value={comPort} onChange={onComPortChange} disabled={isPolling} />
        </div>
        {/* License identity badge */}
        {(projectName || username) && (
          <div style={{
            display: "flex", alignItems: "center", gap: "8px", marginTop: "3px",
          }}>
            {projectName && (
              <span style={{
                fontFamily: "'Share Tech Mono', monospace",
                fontSize: "0.55rem", letterSpacing: "0.16em",
                color: "#2244F0", textTransform: "uppercase",
              }}>
                ⬡ {projectName}
              </span>
            )}
            {projectName && username && (
              <span style={{ color: "#2a3550", fontSize: "0.55rem" }}>·</span>
            )}
            {username && (
              <span style={{
                fontFamily: "'Share Tech Mono', monospace",
                fontSize: "0.55rem", letterSpacing: "0.16em",
                color: "#4a5c7a", textTransform: "uppercase",
              }}>
                {username}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Right: telemetry + controls */}
      <div className="header-right">
        <div className="header-stat">
          <span className="header-stat-label">FREQUENCY</span>
          <span className="header-stat-value">
            {frequency > 0 ? frequency.toFixed(2) : "--.-"}{" "}
            <span className="header-stat-unit">Hz</span>
          </span>
        </div>
        <div className="header-divider" />
        <div className="header-stat">
          <span className="header-stat-label">LAST POLL</span>
          <span className="header-stat-value">{timeStr}</span>
        </div>
        <div className="header-divider" />

        {/* 3-state status */}
        <div className="header-status">
          <span className={`status-led ${statusConfig.ledClass}`} />
          <span className={`status-label ${statusConfig.textClass}`}>{statusConfig.label}</span>
        </div>
        <div className="header-divider" />

        {/* Controls */}
        <div className="header-controls">
          <PollToggleButton pollState={pollState} onToggle={onTogglePoll} />
          <ClearButton onClear={onClear} />
          <ExportButton onExport={onExport} status={exportStatus} />
          <ThemeToggle theme={theme} onToggle={onThemeToggle} />
        </div>
      </div>
    </header>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  // ── Auth state ─────────────────────────────────────────────────────────────
  const [authState,     setAuthState]     = useState<AuthState | null>(null);
  const [checkingAuth,  setCheckingAuth]  = useState(true);

  // ── Dashboard state ────────────────────────────────────────────────────────
  const [reading, setReading]           = useState<MeterReading | null>(null);
  const [history, setHistory]           = useState<ChartPoint[]>([]);
  const [pollState, setPollState]       = useState<PollState>("stopped");
  const [updateTick, setUpdateTick]     = useState(false);
  const [theme, setTheme]               = useState<Theme>("dark");
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [timeframe, setTimeframe]       = useState<Timeframe>("live");
  const [comPort, setComPort]           = useState("COM3");
  const [toast, setToast]               = useState<ToastState>({ message:"", type:"success", visible:false });

  const toastTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Apply theme ────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // ── Check license on mount ─────────────────────────────────────────────────
  useEffect(() => {
    invoke<AuthState>("get_auth_state")
      .then(auth => {
        setAuthState(auth);
        setCheckingAuth(false);
      })
      .catch(() => {
        setAuthState({ valid: false });
        setCheckingAuth(false);
      });
  }, []);

  const showToast = useCallback((message: string, type: ToastState["type"]) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type, visible:true });
    toastTimerRef.current = setTimeout(() => setToast(t => ({ ...t, visible:false })), 4000);
  }, []);

  // ── Bootstrap dashboard (only runs when licensed) ──────────────────────────
  useEffect(() => {
    if (!authState?.valid) return;
    invoke<PollState>("get_status").then(setPollState).catch(console.error);
  }, [authState?.valid]);

  // ── Backend event listeners (only active when licensed) ───────────────────
  useEffect(() => {
    if (!authState?.valid) return;

    const subs: Promise<UnlistenFn>[] = [];

    subs.push(listen<MeterReading>("meter-data", e => {
      const r    = e.payload;
      const time = new Date(r.timestamp_ms).toLocaleTimeString("en-GB", { hour12:false });
      setReading(r);
      setHistory(prev => {
        const next = [...prev, {
          time,
          voltage:      parseFloat(r.voltage.toFixed(1)),
          active_power: parseFloat(r.active_power.toFixed(3)),
          current:      parseFloat(r.current.toFixed(2)),
        }];
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      });
      setUpdateTick(t => !t);
    }));

    subs.push(listen<StatusEvent>("status-changed", e => {
      setPollState(e.payload.state);
    }));

    subs.push(listen<FaultEvent>("meter-fault", e => {
      showToast(`⚠ FAULT: ${e.payload.reason}`, "warn");
    }));

    return () => { subs.forEach(p => p.then(fn => fn())); };
  }, [authState?.valid, showToast]);

  // ── Toggle polling ─────────────────────────────────────────────────────────
  const handleTogglePoll = useCallback(async () => {
    try {
      const newState = await invoke<PollState>("toggle_polling", {
        comPort: comPort.trim(),
      });
      setPollState(newState);
      if (newState === "running") {
        showToast(`Polling started on ${comPort}`, "success");
      } else {
        showToast("Polling stopped", "warn");
      }
    } catch (err) {
      showToast(`Toggle failed: ${err}`, "error");
    }
  }, [comPort, showToast]);

  // ── Clear ──────────────────────────────────────────────────────────────────
  const handleClear = useCallback(async () => {
    try {
      const rows = await invoke<number>("clear_history");
      setHistory([]);
      setReading(null);
      showToast(`Cleared ${rows.toLocaleString()} records from database`, "warn");
    } catch (err) {
      showToast(`Clear failed: ${err}`, "error");
    }
  }, [showToast]);

  // ── Export ─────────────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    try {
      setExportStatus("saving");
      const filePath = await save({
        title:       "Export TechniDAQ Data",
        defaultPath: `technidaq_${new Date().toISOString().slice(0,10)}.xlsx`,
        filters:     [{ name: "Excel Workbook", extensions: ["xlsx"] }],
      });
      if (!filePath) { setExportStatus("idle"); return; }
      const rows = await invoke<number>("export_to_excel", { path: filePath });
      setExportStatus("success");
      showToast(`✓ Exported ${rows.toLocaleString()} records → ${filePath.split(/[\\/]/).pop()}`, "success");
      if (exportResetRef.current) clearTimeout(exportResetRef.current);
      exportResetRef.current = setTimeout(() => setExportStatus("idle"), 2500);
    } catch (err) {
      setExportStatus("error");
      showToast(`Export failed: ${err}`, "error");
      if (exportResetRef.current) clearTimeout(exportResetRef.current);
      exportResetRef.current = setTimeout(() => setExportStatus("idle"), 3000);
    }
  }, [showToast]);

  // ── Derived display values ─────────────────────────────────────────────────
  const fmt           = (n:number|undefined, d:number) => n !== undefined ? n.toFixed(d) : "---.-";
  const voltage       = fmt(reading?.voltage, 1);
  const current       = fmt(reading?.current, 2);
  const activePower   = fmt(reading?.active_power, 3);
  const totalEnergy   = reading?.total_energy !== undefined ? reading.total_energy.toFixed(3) : "----.---";
  const powerFactor   = reading?.power_factor !== undefined ? reading.power_factor.toFixed(3) : "-.-";
  const frequency     = reading?.frequency ?? 0;
  const timestamp     = reading?.timestamp_ms ?? 0;
  const apparentPower = reading ? ((reading.voltage * reading.current)/1000).toFixed(3) : "---.-";

  const cards: MetricCardProps[] = [
    {
      label:"Voltage", value:voltage, unit:"V", sublabel:"Nominal", subvalue:"230.0 V",
      colorKey:"volt", updated:updateTick,
      icon:<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>,
    },
    {
      label:"Current", value:current, unit:"A", sublabel:"Rated", subvalue:"15.0 A",
      colorKey:"ampere", updated:updateTick,
      icon:<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>,
    },
    {
      label:"Active Power", value:activePower, unit:"kW", sublabel:"Apparent", subvalue:`${apparentPower} kVA`,
      colorKey:"watt", updated:updateTick,
      icon:<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
    },
    {
      label:"Total Energy", value:totalEnergy, unit:"kWh", sublabel:"Power Factor", subvalue:`PF ${powerFactor}`,
      colorKey:"joule", updated:updateTick,
      icon:<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5}><ellipse cx="12" cy="12" rx="10" ry="10"/><path d="M12 6v6l4 2"/></svg>,
    },
  ];

  // ── Render: loading → gateway → dashboard ──────────────────────────────────
  if (checkingAuth) {
    return <AuthLoadingScreen />;
  }

  if (!authState?.valid) {
    return (
      <LicenseGateway
        onActivated={(auth) => setAuthState(auth)}
      />
    );
  }

  // ── Licensed: render full dashboard ───────────────────────────────────────
  return (
    <div className="app-root">
      <div className="ambient-glow glow-tl" />
      <div className="ambient-glow glow-br" />
      <Toast {...toast} />

      <Header
        pollState={pollState} timestamp={timestamp} frequency={frequency}
        theme={theme} onThemeToggle={() => setTheme(t => t==="dark"?"light":"dark")}
        onTogglePoll={handleTogglePoll} onClear={handleClear}
        onExport={handleExport} exportStatus={exportStatus}
        comPort={comPort} onComPortChange={setComPort}
        username={authState.username ?? ""}
        projectName={authState.project_name ?? ""}
      />

      <main className="app-main">
        <div className="section-label-row">
          <span className="section-label">Real-Time Measurements</span>
          <div className="section-divider" />
          <span className="section-meta">Δt = 1.000 s</span>
        </div>

        <div className="cards-grid">
          {cards.map(card => <MetricCard key={card.label} {...card} />)}
        </div>

        <ChartCard
          history={history} theme={theme}
          timeframe={timeframe} onTimeframeChange={setTimeframe}
          pollState={pollState}
        />

        <div className="status-bar">
          {[
            { label:"Device",   value:"PM2220 #01"  },
            { label:"COM Port", value: comPort || "—" },
            { label:"Baud",     value:"19 200"      },
            { label:"Engine",   value: pollState === "running" ? "RUNNING"
                                     : pollState === "fault"   ? "FAULT"
                                     :                           "STOPPED" },
          ].map(({ label, value }) => (
            <div key={label} className={`status-chip ${label==="Engine" ? `engine-chip-${pollState}` : ""}`}>
              <span className="chip-label">{label}</span>
              <span className="chip-value">{value}</span>
            </div>
          ))}
        </div>

        <div className="sim-notice">
          <div className="sim-line" />
          <span className="sim-text">
            RS485 MODBUS RTU · Schneider PM2220 · Slave ID 01 · FC03 Holding Registers
          </span>
          <div className="sim-line" />
        </div>
      </main>
    </div>
  );
}