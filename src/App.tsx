// src/App.tsx  — TechniDAQ Phase 5 (High-Contrast Tabbed SCADA Dashboard)
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import logoUrl from "./assets/logo.png";
import { invokeApi, listenApi, isTauri, type UnlistenFn } from "./api";
// @tauri-apps/plugin-dialog is loaded dynamically so it never executes in a browser.
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import "./App.css";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RegisterEntry {
  name: string; address: number; length: number;
  data_type: string; multiplier: number;
  min_alarm?: number; max_alarm?: number;
}
interface MeterProfile {
  model: string; display_name: string; endianness: string;
  baud_rate: number; parity: string; registers: RegisterEntry[];
}
interface DeviceConfig {
  device_name: string; meter_model: string; slave_id: number;
  poll_rate_ms: number; selected_registers: RegisterEntry[];
  alarm_trigger_cycles: number;
  protocol:   "rtu" | "tcp";
  com_port:   string;
  baud_rate:  number;
  ip_address: string;
  tcp_port:   number;
}
interface MeterReading {
  device_name: string; device_id: string;
  timestamp_ms: number; data: Record<string, number>;
}
interface FaultEvent  { device_name: string; reason: string; timestamp_ms: number }
interface StatusEvent { state: PollState }
interface AuthState {
  valid: boolean; username?: string; project_name?: string;
  expiry_date?: number; allowed_meters: string[];
  mode?:              "offline" | "online";
  tier?:              1 | 2 | 3;
  protocols?:         "RTU" | "TCP" | "All";
  cloud_registered?:  boolean;
}
interface DiagEvent   { direction: string; hex: string; device_name: string; timestamp_ms: number; }
interface BuildInfo   { is_cloud_build: boolean; }

type PollState    = "running" | "stopped" | "fault";
type Theme        = "dark"   | "light";
type ExportStatus = "idle"   | "saving"  | "success" | "error";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_HISTORY = 60;
const COM_PORTS   = ["COM1","COM2","COM3","COM4","COM5","COM6","COM7",
                     "COM8","COM9","COM10","COM11","COM12"];
const DATA_TYPES  = ["Float32","UInt16","UInt32","INT16","INT32"];

const DEFAULT_DEVICE = (): DeviceConfig => ({
  device_name:"", meter_model:"", slave_id:1, poll_rate_ms:1000, selected_registers:[], alarm_trigger_cycles:5,
  protocol:"rtu", com_port:"COM3", baud_rate:9600, ip_address:"", tcp_port:502,
});

// ─── Design tokens ────────────────────────────────────────────────────────────

const CLR = {
  // page / chrome surfaces
  bgPage:   (d:boolean) => d ? "#0f1117" : "#f1f5f9",
  bgCard:   (d:boolean) => d ? "rgba(255,255,255,0.04)"  : "rgba(255,255,255,0.85)",
  bgHeader: (d:boolean) => d ? "rgba(15,17,23,0.92)"     : "rgba(15,23,42,0.96)",
  bgTabBar: (d:boolean) => d ? "rgba(15,17,23,0.85)"     : "rgba(255,255,255,0.75)",
  // borders — deliberately soft
  border:   (d:boolean) => d ? "rgba(255,255,255,0.08)"  : "rgba(15,23,42,0.10)",
  borderDim:(d:boolean) => d ? "rgba(255,255,255,0.04)"  : "rgba(15,23,42,0.06)",
  // text — high contrast where it counts
  text1:    (d:boolean) => d ? "#f1f5f9"  : "#0f172a",
  text2:    (d:boolean) => d ? "#94a3b8"  : "#475569",
  text3:    (d:boolean) => d ? "#3d4a5e"  : "#94a3b8",
  // brand accents
  blue:   "#3b82f6",
  green:  "#22c55e",
  amber:  "#f59e0b",
  red:    "#ef4444",
  purple: "#a855f7",
  teal:   "#14b8a6",
  orange: "#f97316",
  indigo: "#6366f1",
};

// Glass card style helper — the visual centrepiece
const glass = (isDark:boolean, accent?:string): React.CSSProperties => ({
  background:  isDark
    ? "rgba(255,255,255,0.035)"
    : "rgba(255,255,255,0.82)",
  border:      `1px solid ${isDark ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.09)"}`,
  borderRadius:"12px",
  backdropFilter:"blur(12px)",
  WebkitBackdropFilter:"blur(12px)",
  boxShadow: isDark
    ? `0 1px 3px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)${accent ? `, 0 0 0 1px ${accent}18` : ""}`
    : `0 2px 12px rgba(15,23,42,0.07), 0 1px 3px rgba(15,23,42,0.05), inset 0 1px 0 rgba(255,255,255,0.9)`,
});

// Dot-grid CSS injected once into <head>
const DOT_GRID_CSS = `
  .tdaq-page {
    background-color: var(--pg);
    background-image: radial-gradient(circle, var(--dot) 1px, transparent 1px);
    background-size: 22px 22px;
  }
  [data-theme="dark"]  { --pg: #0f1117; --dot: rgba(255,255,255,0.055); }
  [data-theme="light"] { --pg: #f1f5f9; --dot: rgba(15,23,42,0.07); }
  @keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:0.35} }
  @keyframes spin { to{transform:rotate(360deg)} }
  @keyframes alarm-red   { 0%,100%{box-shadow:0 0 0 1.5px #ef4444,0 0 0 3px #ef444422} 50%{box-shadow:0 0 0 2px #ef4444,0 0 16px 4px #ef444444} }
  @keyframes alarm-amber { 0%,100%{box-shadow:0 0 0 1.5px #f59e0b,0 0 0 3px #f59e0b22} 50%{box-shadow:0 0 0 2px #f59e0b,0 0 16px 4px #f59e0b44} }
  [data-theme="dark"] select { background:#1c2128 !important; color:#f1f5f9 !important; }
  [data-theme="dark"] select option { background:#1c2128; color:#f1f5f9; }
  [data-theme="light"] select { background:#ffffff; color:#0f172a; }
`;

const TAB_ACCENTS  = [CLR.blue,CLR.green,CLR.amber,CLR.purple,CLR.red,CLR.teal,CLR.orange,CLR.indigo];
const LINE_COLORS  = ["#3b82f6","#22c55e","#f59e0b","#a855f7","#ef4444","#14b8a6","#f97316","#6366f1"];

function regPalette(name:string, idx:number) {
  const n = name.toLowerCase();
  const P = [
    { border:CLR.blue,   value:CLR.blue },
    { border:CLR.amber,  value:CLR.amber },
    { border:CLR.purple, value:CLR.purple },
    { border:CLR.green,  value:CLR.green },
    { border:CLR.red,    value:CLR.red },
    { border:CLR.teal,   value:CLR.teal },
    { border:CLR.orange, value:CLR.orange },
    { border:CLR.indigo, value:CLR.indigo },
  ];
  if (n.includes("voltage"))                                    return P[0];
  if (n.includes("current"))                                    return P[1];
  if (n.includes("apparent"))                                   return P[7];
  if (n.includes("reactive"))                                   return P[4];
  if (n.includes("active power")||n.includes("power total"))   return P[2];
  if (n.includes("energy"))                                     return P[3];
  if (n.includes("frequen"))                                    return P[5];
  if (n.includes("factor"))                                     return P[6];
  return P[idx % P.length];
}

// ─── MetricCard ───────────────────────────────────────────────────────────────

function MetricCard({ name, value, idx, isDark, sparkData, minAlarm, maxAlarm }:{
  name:string; value:number|undefined; idx:number; isDark:boolean;
  sparkData?: number[]; minAlarm?: number; maxAlarm?: number;
}) {
  const p      = regPalette(name, idx);
  const hasVal = value !== undefined && !isNaN(value);
  const abs    = hasVal ? Math.abs(value!) : 0;
  const display = hasVal
    ? (abs>=10000 ? value!.toFixed(0) : abs>=100 ? value!.toFixed(1)
       : abs>=1   ? value!.toFixed(2) : value!.toFixed(4))
    : "——";

  const isOverMax  = maxAlarm !== undefined && hasVal && value! > maxAlarm;
  const isUnderMin = minAlarm !== undefined && hasVal && value! < minAlarm;
  const alarmColor = isOverMax ? CLR.red : isUnderMin ? CLR.amber : undefined;

  return (
    <div style={{
      ...glass(isDark),
      padding:      "0",
      display:      "flex", flexDirection:"column",
      minWidth:     0, overflow:"hidden",
      position:     "relative",
      transition:   "box-shadow 0.2s ease",
      animation: alarmColor ? `${isOverMax ? "alarm-red" : "alarm-amber"} 1.2s ease-in-out infinite` : undefined,
      border: alarmColor ? `1px solid ${alarmColor}` : undefined,
    }}>
      {/* Delicate top accent line */}
      <div style={{
        height:"2px", width:"100%", flexShrink:0,
        background:`linear-gradient(90deg, ${p.border}, ${p.border}88, transparent)`,
      }}/>

      <div style={{ padding:"14px 16px 14px", display:"flex", flexDirection:"column", gap:"8px" }}>
        {/* Label */}
        <div style={{
          fontSize:"0.6rem", fontFamily:"'Share Tech Mono',monospace",
          letterSpacing:"0.18em", textTransform:"uppercase",
          color:CLR.text3(isDark),
          whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
        }}>{name}</div>

        {/* Value — maximum legibility */}
        <div style={{
          fontSize:"1.75rem", fontWeight:700,
          fontFamily:"'Share Tech Mono',monospace",
          letterSpacing:"-0.03em", lineHeight:1,
          color: hasVal ? CLR.text1(isDark) : CLR.text3(isDark),
        }}>{display}</div>

        {/* Accent progress bar */}
        <div style={{ height:"2px", borderRadius:"1px",
          background:CLR.borderDim(isDark), overflow:"hidden" }}>
          {hasVal && (
            <div style={{
              height:"100%", borderRadius:"1px",
              width:`${Math.min(100,(Math.abs(value!)/500)*100)}%`,
              background:`linear-gradient(90deg,${p.border},${p.border}99)`,
              transition:"width 0.5s ease",
            }}/>
          )}
        </div>
      </div>

      {sparkData && sparkData.length > 1 && (
        <div style={{ padding:"0 16px 10px", marginTop:"-4px" }}>
          <ResponsiveContainer width="100%" height={36}>
            <LineChart data={sparkData.map((v,i)=>({i,v}))} margin={{top:2,right:2,bottom:2,left:2}}>
              <Line type="monotone" dataKey="v" stroke={alarmColor ?? p.border}
                strokeWidth={1.5} dot={false} isAnimationActive={false}/>
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Subtle glow blob in card corner */}
      <div style={{
        position:"absolute", bottom:0, right:0,
        width:"60px", height:"60px",
        background:`radial-gradient(circle at 100% 100%, ${p.border}22, transparent 70%)`,
        pointerEvents:"none",
      }}/>
    </div>
  );
}

// ─── DeviceTabBar ─────────────────────────────────────────────────────────────

function DeviceTabBar({ devices, activeTab, onSelect, pollState, isDark }:{
  devices:DeviceConfig[]; activeTab:string; onSelect:(n:string)=>void;
  pollState:PollState; isDark:boolean;
}) {
  if (devices.length === 0) return null;
  return (
    <div style={{
      display:"flex", alignItems:"center", gap:"4px",
      padding:"0 20px",
      height:"48px",
      background:CLR.bgTabBar(isDark),
      borderBottom:`1px solid ${CLR.border(isDark)}`,
      backdropFilter:"blur(16px)",
      WebkitBackdropFilter:"blur(16px)",
      overflowX:"auto", overflowY:"hidden", flexShrink:0,
    }}>
      {devices.map((dev,i) => {
        const isActive = activeTab === dev.device_name;
        const accent   = TAB_ACCENTS[i % TAB_ACCENTS.length];
        const isLive   = pollState === "running";
        const isFault  = pollState === "fault";
        return (
          <button key={dev.device_name} onClick={()=>onSelect(dev.device_name)} style={{
            padding:"0 16px",
            height:"32px",
            border: isActive
              ? `1px solid ${isDark ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.12)"}`
              : "1px solid transparent",
            borderRadius:"8px",
            background: isActive
              ? (isDark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.95)")
              : "transparent",
            cursor:"pointer",
            display:"flex", alignItems:"center", gap:"8px",
            whiteSpace:"nowrap", flexShrink:0,
            transition:"all 0.15s ease",
            boxShadow: isActive
              ? (isDark ? "0 1px 6px rgba(0,0,0,0.4)" : "0 1px 4px rgba(15,23,42,0.12)")
              : "none",
          }}>
            {/* Live indicator dot */}
            <span style={{
              width:"6px", height:"6px", borderRadius:"50%", flexShrink:0,
              background: isActive
                ? (isFault ? CLR.red : isLive ? accent : CLR.text3(isDark))
                : CLR.text3(isDark),
              boxShadow: isActive && isLive && !isFault ? `0 0 7px ${accent}` : "none",
              animation: isActive && isLive && !isFault ? "pulse-dot 2s ease-in-out infinite" : "none",
            }}/>
            {/* Name */}
            <span style={{
              fontFamily:"'Rajdhani',sans-serif",
              fontWeight: isActive ? 700 : 500,
              fontSize:"0.83rem", letterSpacing:"0.04em",
              color: isActive ? CLR.text1(isDark) : CLR.text2(isDark),
            }}>{dev.device_name||`Device ${i+1}`}</span>
            {/* Slave ID pill */}
            <span style={{
              fontFamily:"'Share Tech Mono',monospace", fontSize:"0.54rem",
              letterSpacing:"0.08em",
              color: isActive ? accent : CLR.text3(isDark),
              padding:"1px 6px", borderRadius:"20px",
              border:`1px solid ${isActive ? accent+"40" : CLR.border(isDark)}`,
              background: isActive ? accent+"10" : "transparent",
            }}>S{dev.slave_id}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── WaveformChart ────────────────────────────────────────────────────────────

type ChartPoint = Record<string, string|number>;
type ViewMode = "chart" | "grid";

function WaveformChart({ history, chartKeys, pollState, tabAccent, isDark }:{
  history:ChartPoint[]; chartKeys:string[]; pollState:PollState;
  tabAccent:string; isDark:boolean;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("chart");
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(()=>new Set(chartKeys));
  // Keep in sync when chartKeys changes
  useEffect(()=>setVisibleKeys(new Set(chartKeys)), [chartKeys.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const stopped   = pollState === "stopped";
  const gridColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)";
  const axisTick  = CLR.text3(isDark);

  // All data keys present in history (preserving first-seen order, excluding "time")
  const gridKeys = useMemo(()=>{
    const seen = new Set<string>();
    const order: string[] = [];
    history.forEach(pt => Object.keys(pt).forEach(k => {
      if (k !== "time" && !seen.has(k)) { seen.add(k); order.push(k); }
    }));
    return order;
  }, [history]);

  // Empty state shared between both views
  const emptyState = (
    <div style={{
      position:"absolute", inset:0, display:"flex",
      flexDirection:"column", alignItems:"center", justifyContent:"center", gap:"10px",
    }}>
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none"
        stroke={CLR.text3(isDark)} strokeWidth={1.5}>
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
      <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.65rem",
        letterSpacing:"0.2em", color:CLR.text3(isDark), textTransform:"uppercase" }}>
        {stopped ? "Polling stopped" : "Awaiting data…"}
      </span>
    </div>
  );

  return (
    <div style={{
      ...glass(isDark),
      overflow:"hidden", display:"flex", flexDirection:"column",
    }}>
      {/* Header */}
      <div style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"12px 16px", borderBottom:`1px solid ${CLR.border(isDark)}`,
        flexShrink:0,
      }}>
        {/* Left: icon + title + count */}
        <div style={{ display:"flex", alignItems:"center", gap:"10px" }}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
            stroke={tabAccent} strokeWidth={2.5}>
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span style={{ fontFamily:"'Rajdhani',sans-serif", fontWeight:700,
            fontSize:"0.78rem", letterSpacing:"0.14em", textTransform:"uppercase",
            color:CLR.text1(isDark) }}>Real-Time Waveform</span>
          <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.58rem",
            color:CLR.text3(isDark) }}>{history.length}/{MAX_HISTORY}pts</span>
        </div>

        {/* Right: view toggle + legend + live badge */}
        <div style={{ display:"flex", alignItems:"center", gap:"10px" }}>

          {/* ── View mode toggle ── */}
          <div style={{
            display:"flex", borderRadius:"6px", overflow:"hidden",
            border:`1px solid ${CLR.border(isDark)}`,
          }}>
            {(["chart","grid"] as ViewMode[]).map((mode)=>{
              const active = viewMode === mode;
              return (
                <button key={mode} onClick={()=>setViewMode(mode)} style={{
                  padding:"3px 10px", height:"26px",
                  background: active
                    ? (isDark ? "rgba(255,255,255,0.10)" : "rgba(15,23,42,0.08)")
                    : "transparent",
                  border:"none",
                  borderRight: mode==="chart" ? `1px solid ${CLR.border(isDark)}` : "none",
                  cursor:"pointer",
                  display:"flex", alignItems:"center", gap:"5px",
                  color: active ? CLR.text1(isDark) : CLR.text3(isDark),
                  transition:"background 0.15s",
                }}>
                  {mode === "chart"
                    ? <svg viewBox="0 0 24 24" width="11" height="11" fill="none"
                        stroke="currentColor" strokeWidth={2.2}>
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                      </svg>
                    : <svg viewBox="0 0 24 24" width="11" height="11" fill="none"
                        stroke="currentColor" strokeWidth={2.2}>
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <line x1="3" y1="9" x2="21" y2="9"/>
                        <line x1="3" y1="15" x2="21" y2="15"/>
                        <line x1="9" y1="3" x2="9" y2="21"/>
                      </svg>
                  }
                  <span style={{
                    fontFamily:"'Rajdhani',sans-serif", fontWeight: active ? 700 : 500,
                    fontSize:"0.68rem", letterSpacing:"0.06em",
                  }}>{mode === "chart" ? "Chart" : "Grid"}</span>
                </button>
              );
            })}
          </div>

          {/* Chart legend (chart mode only) */}
          {viewMode === "chart" && chartKeys.map((k,i)=>(
            <div key={k} style={{ display:"flex", alignItems:"center", gap:"5px" }}>
              <div style={{ width:"10px", height:"3px", borderRadius:"2px",
                background:LINE_COLORS[i%LINE_COLORS.length] }}/>
              <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.58rem",
                color:CLR.text2(isDark), maxWidth:"120px",
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{k}</span>
            </div>
          ))}

          {/* Live badge */}
          <span style={{
            padding:"2px 8px", borderRadius:"4px",
            fontFamily:"'Share Tech Mono',monospace", fontSize:"0.56rem", letterSpacing:"0.12em",
            background: stopped ? CLR.borderDim(isDark) : tabAccent+"20",
            color:      stopped ? CLR.text3(isDark)     : tabAccent,
            border:     `1px solid ${stopped ? CLR.borderDim(isDark) : tabAccent+"44"}`,
          }}>{stopped?"PAUSED":"LIVE"}</span>
        </div>
      </div>

      {/* Waveform line toggles */}
      {viewMode === "chart" && chartKeys.length > 0 && (
        <div style={{
          display:"flex", alignItems:"center", gap:"6px", flexWrap:"wrap",
          padding:"6px 16px", borderBottom:`1px solid ${CLR.border(isDark)}`,
          flexShrink:0,
        }}>
          <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
            letterSpacing:"0.18em", textTransform:"uppercase", color:CLR.text3(isDark), marginRight:"2px" }}>
            SHOW
          </span>
          {chartKeys.map((k,i)=>{
            const on = visibleKeys.has(k);
            const c  = LINE_COLORS[i % LINE_COLORS.length];
            return (
              <button key={k} onClick={()=>{
                setVisibleKeys(prev=>{
                  const s = new Set(prev);
                  s.has(k) ? s.delete(k) : s.add(k);
                  return s;
                });
              }} style={{
                padding:"2px 10px", height:"22px", borderRadius:"20px",
                background: on ? c+"22" : "transparent",
                border: `1px solid ${on ? c+"88" : CLR.border(isDark)}`,
                color: on ? c : CLR.text3(isDark),
                fontFamily:"'Share Tech Mono',monospace", fontSize:"0.56rem",
                letterSpacing:"0.06em", cursor:"pointer",
                display:"flex", alignItems:"center", gap:"5px",
                transition:"all 0.12s",
              }}>
                <div style={{ width:"8px", height:"8px", borderRadius:"50%",
                  background: on ? c : CLR.borderDim(isDark), flexShrink:0 }}/>
                {k}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Chart view ─────────────────────────────────────────────────────── */}
      {viewMode === "chart" && (
        <div style={{ flex:"1 1 0", minHeight:"280px", padding:"8px 4px 8px 0", position:"relative" }}>
          {history.length === 0 ? emptyState : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history} margin={{ top:8, right:20, left:0, bottom:0 }}>
                <CartesianGrid stroke={gridColor} strokeDasharray="3 3" vertical={false}/>
                <XAxis dataKey="time"
                  tick={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, fill:axisTick }}
                  axisLine={{ stroke:CLR.border(isDark) }} tickLine={false}
                  interval="preserveStartEnd" minTickGap={60}/>
                {chartKeys.slice(0,1).map(()=>(
                  <YAxis key="l" yAxisId="l" orientation="left"
                    tick={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, fill:LINE_COLORS[0] }}
                    axisLine={false} tickLine={false} width={56}
                    tickFormatter={(v:number)=>v.toFixed(1)}/>
                ))}
                {chartKeys.slice(1,2).map(()=>(
                  <YAxis key="r" yAxisId="r" orientation="right"
                    tick={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, fill:LINE_COLORS[1] }}
                    axisLine={false} tickLine={false} width={56}
                    tickFormatter={(v:number)=>v.toFixed(2)}/>
                ))}
                <Tooltip contentStyle={{
                  background:   isDark?"#1c2128":"#ffffff",
                  border:       `1px solid ${CLR.border(isDark)}`,
                  borderRadius: "6px", padding:"8px 12px",
                  fontFamily:   "'Share Tech Mono',monospace",
                  fontSize:     "0.66rem", color:CLR.text1(isDark),
                  boxShadow:    "0 4px 16px rgba(0,0,0,0.3)",
                }} cursor={{ stroke:CLR.borderDim(isDark), strokeWidth:1, strokeDasharray:"4 4" }}/>
                <Legend wrapperStyle={{ display:"none" }}/>
                {chartKeys.filter(k=>visibleKeys.has(k)).map((k,i)=>(
                  <Line key={k} yAxisId={i===0?"l":"r"} type="monotone" dataKey={k}
                    stroke={LINE_COLORS[i%LINE_COLORS.length]} strokeWidth={2}
                    dot={false} activeDot={{ r:4, fill:LINE_COLORS[i%LINE_COLORS.length] }}
                    isAnimationActive={false}/>
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* ── Data Grid view ─────────────────────────────────────────────────── */}
      {viewMode === "grid" && (
        <div style={{
          flex:"1 1 0", minHeight:"280px", position:"relative",
          overflowX:"auto", overflowY:"auto",
        }}>
          {history.length === 0 ? emptyState : (
            <table style={{
              width:"100%", borderCollapse:"collapse",
              fontFamily:"'Share Tech Mono',monospace",
              fontSize:"0.64rem", letterSpacing:"0.03em",
            }}>
              <thead>
                <tr style={{
                  position:"sticky", top:0, zIndex:2,
                  background: isDark ? "#0f1117" : "#f1f5f9",
                  borderBottom:`2px solid ${CLR.border(isDark)}`,
                }}>
                  <th style={{
                    padding:"8px 14px", textAlign:"left", whiteSpace:"nowrap",
                    fontWeight:700, letterSpacing:"0.14em", textTransform:"uppercase",
                    fontSize:"0.54rem", color:CLR.text3(isDark),
                    borderRight:`1px solid ${CLR.border(isDark)}`,
                    minWidth:"92px",
                  }}>Timestamp</th>
                  {gridKeys.map(k => {
                    const p = regPalette(k, 0);
                    return (
                      <th key={k} style={{
                        padding:"8px 10px", textAlign:"right", whiteSpace:"nowrap",
                        fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase",
                        fontSize:"0.52rem", color:p.border,
                        borderRight:`1px solid ${CLR.border(isDark)}`,
                        minWidth:"110px",
                      }}>{k}</th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map((pt, i) => {
                  const isAlt = i % 2 === 1;
                  const rowBg = isAlt
                    ? (isDark ? "rgba(255,255,255,0.025)" : "rgba(15,23,42,0.03)")
                    : "transparent";
                  return (
                    <tr key={i} style={{ background:rowBg }}>
                      <td style={{
                        padding:"5px 14px", whiteSpace:"nowrap",
                        color:CLR.text2(isDark),
                        borderRight:`1px solid ${CLR.borderDim(isDark)}`,
                        borderBottom:`1px solid ${CLR.borderDim(isDark)}`,
                      }}>{String(pt.time)}</td>
                      {gridKeys.map(k => {
                        const raw = pt[k];
                        const num = typeof raw === "number" ? raw : NaN;
                        const abs = Math.abs(num);
                        const display = isNaN(num) ? "—"
                          : abs >= 10000 ? num.toFixed(0)
                          : abs >= 100   ? num.toFixed(1)
                          : abs >= 1     ? num.toFixed(3)
                          :                num.toFixed(5);
                        const p = regPalette(k, 0);
                        return (
                          <td key={k} style={{
                            padding:"5px 10px", textAlign:"right", whiteSpace:"nowrap",
                            color: isNaN(num) ? CLR.text3(isDark) : p.value,
                            borderRight:`1px solid ${CLR.borderDim(isDark)}`,
                            borderBottom:`1px solid ${CLR.borderDim(isDark)}`,
                            fontVariantNumeric:"tabular-nums",
                          }}>{display}</td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ExportDropdown ───────────────────────────────────────────────────────────

function ExportDropdown({ activeDeviceName, exportStatus, onExport, isDark }:{
  activeDeviceName:string|undefined; exportStatus:ExportStatus;
  onExport:(target:string|null)=>void; isDark:boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const busy = exportStatus === "saving";

  useEffect(()=>{
    if(!open)return;
    const fn = (e:MouseEvent)=>{if(!ref.current?.contains(e.target as Node))setOpen(false);};
    document.addEventListener("mousedown",fn);
    return ()=>document.removeEventListener("mousedown",fn);
  },[open]);

  const label = {idle:"Export Excel",saving:"Saving…",success:"Exported ✓",error:"Failed ✗"}[exportStatus];
  const labelColor = exportStatus==="success"?CLR.green : exportStatus==="error"?CLR.red : CLR.text2(isDark);

  const btnBase: React.CSSProperties = {
    height:"34px", background:isDark?"rgba(255,255,255,0.05)":"#f6f8fa",
    border:`1px solid ${CLR.border(isDark)}`,
    fontFamily:"'Rajdhani',sans-serif", fontWeight:600,
    fontSize:"0.75rem", letterSpacing:"0.06em",
    cursor:busy?"not-allowed":"pointer", display:"flex", alignItems:"center",
  };

  return (
    <div ref={ref} style={{ position:"relative" }}>
      <div style={{ display:"flex" }}>
        <button onClick={()=>!busy&&onExport(activeDeviceName??null)} disabled={busy}
          style={{ ...btnBase, gap:"6px", padding:"0 12px",
            borderRight:"none", borderRadius:"6px 0 0 6px", color:labelColor }}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
            stroke="currentColor" strokeWidth={2}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          {label}
        </button>
        <button onClick={()=>!busy&&setOpen(o=>!o)} disabled={busy}
          style={{ ...btnBase, padding:"0 8px", borderRadius:"0 6px 6px 0", color:CLR.text2(isDark) }}>
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none"
            stroke="currentColor" strokeWidth={2.5}
            style={{ transform:open?"rotate(180deg)":"rotate(0)", transition:"transform 0.15s" }}>
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      </div>
      {open && (
        <div style={{
          position:"absolute", top:"calc(100% + 4px)", right:0, width:"220px",
          background:isDark?"#1c2128":"#ffffff",
          border:`1px solid ${CLR.border(isDark)}`,
          borderRadius:"8px", boxShadow:"0 8px 32px rgba(0,0,0,0.3)",
          zIndex:500, overflow:"hidden",
        }}>
          <div style={{ padding:"6px 12px", borderBottom:`1px solid ${CLR.border(isDark)}`,
            fontFamily:"'Share Tech Mono',monospace", fontSize:"0.52rem",
            letterSpacing:"0.18em", textTransform:"uppercase", color:CLR.text3(isDark) }}>
            Export Options
          </div>
          {[
            { label:"Active Meter Only", sub:activeDeviceName??"(none)", target:activeDeviceName??null,
              icon:CLR.blue, disabled:!activeDeviceName },
            { label:"All Meters", sub:"Full dataset, all devices", target:null,
              icon:CLR.green, disabled:false },
          ].map(opt=>(
            <button key={opt.label} disabled={opt.disabled}
              onClick={()=>{if(!opt.disabled){onExport(opt.target);setOpen(false);}}}
              style={{
                width:"100%", padding:"10px 14px",
                background:"transparent", border:"none",
                display:"flex", alignItems:"center", gap:"10px",
                cursor:opt.disabled?"not-allowed":"pointer", opacity:opt.disabled?0.4:1,
                textAlign:"left",
              }}
              onMouseEnter={e=>{if(!opt.disabled)(e.currentTarget as HTMLElement).style.background=isDark?"rgba(255,255,255,0.05)":"#f6f8fa";}}
              onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background="transparent";}}>
              <div style={{ width:"28px",height:"28px",borderRadius:"6px",
                background:opt.icon+"15",border:`1px solid ${opt.icon}30`,
                display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none"
                  stroke={opt.icon} strokeWidth={2}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </div>
              <div>
                <div style={{ fontFamily:"'Rajdhani',sans-serif", fontWeight:600,
                  fontSize:"0.78rem", color:CLR.text1(isDark) }}>{opt.label}</div>
                <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.56rem",
                  color:CLR.text3(isDark), letterSpacing:"0.04em",
                  maxWidth:"140px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {opt.sub}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

interface ToastState { message:string; type:"success"|"error"|"warn"; visible:boolean }

function Toast({ message, type, visible }:ToastState) {
  const C = {
    success:{bg:"#dcfce7",border:"#16a34a",text:"#15803d",icon:"#16a34a"},
    warn:   {bg:"#fef3c7",border:"#d97706",text:"#92400e",icon:"#d97706"},
    error:  {bg:"#fee2e2",border:"#dc2626",text:"#991b1b",icon:"#dc2626"},
  }[type];
  return (
    <div style={{
      position:"fixed",top:"16px",right:"16px",zIndex:10000,
      display:"flex",alignItems:"center",gap:"10px",
      padding:"10px 16px",
      background:C.bg,border:`1px solid ${C.border}`,
      borderRadius:"8px",boxShadow:"0 4px 16px rgba(0,0,0,0.15)",
      fontFamily:"'Rajdhani',sans-serif",fontWeight:600,
      fontSize:"0.82rem",color:C.text,
      transform:visible?"translateY(0)":"translateY(-120%)",
      opacity:visible?1:0,
      transition:"transform 0.25s ease,opacity 0.25s ease",
      maxWidth:"360px",
    }}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={C.icon} strokeWidth={2.5}>
        {type==="success"&&<polyline points="20 6 9 17 4 12"/>}
        {type==="warn"   &&<><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>}
        {type==="error"  &&<><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></>}
      </svg>
      <span>{message}</span>
    </div>
  );
}

// ─── ComPortSelector ─────────────────────────────────────────────────────────

function ComPortSelector({ value, onChange, disabled, isDark }:{
  value:string; onChange:(v:string)=>void; disabled:boolean; isDark:boolean;
}) {
  const [isCustom, setIsCustom] = useState(false);
  const base: React.CSSProperties = {
    height:"30px", background:isDark?"rgba(255,255,255,0.06)":"#f6f8fa",
    border:`1px solid ${CLR.border(isDark)}`,borderRadius:"5px",
    color:CLR.text1(isDark),outline:"none",
    fontFamily:"'Share Tech Mono',monospace",fontSize:"0.7rem",letterSpacing:"0.06em",
    padding:"0 8px",
  };
  return (
    <div style={{ display:"flex",alignItems:"center",gap:"6px" }}>
      <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.52rem",
        letterSpacing:"0.2em",color:CLR.text3(isDark),textTransform:"uppercase" }}>PORT</span>
      {isCustom
        ? <input type="text" value={value} disabled={disabled}
            onChange={e=>onChange(e.target.value.toUpperCase())}
            onBlur={()=>{if(!value)setIsCustom(false);}}
            autoFocus maxLength={10} style={{...base,width:"78px"}}/>
        : <select value={COM_PORTS.includes(value)?value:"__custom__"}
            onChange={e=>{if(e.target.value==="__custom__")setIsCustom(true);else onChange(e.target.value);}}
            disabled={disabled} style={{...base,width:"88px",cursor:"pointer"}}>
            {COM_PORTS.map(p=><option key={p} value={p}>{p}</option>)}
            <option value="__custom__">Custom…</option>
          </select>
      }
      <div style={{ width:"7px",height:"7px",borderRadius:"50%",
        background:disabled?CLR.green:CLR.text3(isDark),
        boxShadow:disabled?`0 0 5px ${CLR.green}`:"none" }}/>
    </div>
  );
}

// ─── AppHeader ────────────────────────────────────────────────────────────────

function AppHeader({
  pollState, lastPollMs, theme, onThemeToggle, onTogglePoll,
  onClear, onExport, exportStatus,
  username, projectName, onLogout, configuredDevices, activeDeviceName,
  isSimulation, onOpenTerminal, hasDiagnostics,
  licenseMode, licenseTier, isCloudBuild, cloudRegistered,
}:{
  pollState:PollState; lastPollMs:number; theme:Theme;
  onThemeToggle:()=>void; onTogglePoll:()=>void;
  onClear:()=>void; onExport:(t:string|null)=>void; exportStatus:ExportStatus;
  username:string; projectName:string; onLogout:()=>void;
  configuredDevices:DeviceConfig[]; activeDeviceName:string|undefined;
  isSimulation:boolean; onOpenTerminal: ()=>void; hasDiagnostics: boolean;
  licenseMode?: "offline" | "online"; licenseTier?: 1 | 2 | 3;
  isCloudBuild: boolean; cloudRegistered?: boolean;
}) {
  const isDark    = theme === "dark";
  const isRunning = pollState === "running";
  const isFault   = pollState === "fault";
  const timeStr   = lastPollMs > 0
    ? new Date(lastPollMs).toLocaleTimeString("en-GB",{hour12:false}) : "--:--:--";
  const statusColor = isFault ? CLR.red
    : isRunning && isSimulation ? CLR.amber
    : isRunning ? CLR.green
    : CLR.text3(isDark);
  const statusLabel = isFault ? "FAULT"
    : isRunning && isSimulation ? "SIMULATION"
    : isRunning ? "LIVE"
    : "STOPPED";

  // Inject dot-grid + keyframes once
  useEffect(()=>{
    if (document.getElementById("tdaq-global-css")) return;
    const el = document.createElement("style");
    el.id = "tdaq-global-css";
    el.textContent = DOT_GRID_CSS;
    document.head.appendChild(el);
  },[]);

  return (
    <header style={{
      display:"flex", alignItems:"center", gap:"16px",
      padding:"0 20px", height:"58px", flexShrink:0,
      background:CLR.bgHeader(isDark),
      borderBottom:`1px solid ${CLR.border(isDark)}`,
      backdropFilter:"blur(20px)",
      WebkitBackdropFilter:"blur(20px)",
      position:"relative", zIndex:10,
    }}>
      {/* Brand */}
      <div style={{ display:"flex",alignItems:"center",gap:"10px",flexShrink:0 }}>
        <img src={logoUrl} alt="Technicat Group" style={{ width:"36px",height:"36px",objectFit:"contain" }} />
        <div>
          <div style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"1rem",
            letterSpacing:"0.06em",color:"#e6edf3",lineHeight:1 }}>TechniDAQ</div>
          <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.5rem",
            letterSpacing:"0.14em",color:CLR.text3(isDark),lineHeight:1.5 }}>
            {username ? `${username} · ${projectName||"Technicat Group"}` : (projectName||"by Technicat Group")}
          </div>
        </div>
      </div>

      {/* Edition / license badge — hard-branched on build type */}
      {!isCloudBuild ? (
        // Air-gapped binary: static label baked at compile time, never dynamic
        <div style={{
          flexShrink:0, display:"flex", alignItems:"center",
          padding:"3px 9px", borderRadius:"4px",
          border:`1px solid ${CLR.amber}60`,
          background:`${CLR.amber}18`,
          fontFamily:"'Share Tech Mono',monospace", fontSize:"0.48rem",
          letterSpacing:"0.14em", textTransform:"uppercase",
          color:CLR.amber, whiteSpace:"nowrap",
        }}>
          AIR-GAPPED EDITION
        </div>
      ) : licenseMode ? (
        // Cloud binary: dynamic mode/tier badge from decrypted license payload
        <div style={{
          flexShrink:0, display:"flex", alignItems:"center",
          padding:"3px 9px", borderRadius:"4px",
          border:`1px solid ${licenseMode==="online" && (licenseTier??1)>=2 ? CLR.blue+"60" : CLR.amber+"60"}`,
          background:licenseMode==="online" && (licenseTier??1)>=2 ? CLR.blue+"18" : CLR.amber+"18",
          fontFamily:"'Share Tech Mono',monospace", fontSize:"0.48rem",
          letterSpacing:"0.14em", textTransform:"uppercase",
          color:licenseMode==="online" && (licenseTier??1)>=2 ? CLR.blue : CLR.amber,
          gap:"5px", whiteSpace:"nowrap",
        }}>
          <span>{licenseMode==="offline" ? "AIR-GAPPED" : "ONLINE"}</span>
          <span style={{ opacity:0.5 }}>·</span>
          <span>TIER {licenseTier??1}</span>
          {licenseMode === "online" && cloudRegistered && (
            <>
              <span style={{ opacity:0.5 }}>·</span>
              <span style={{ color: CLR.green }}>&#9679; SYNCED</span>
            </>
          )}
        </div>
      ) : null}

      {/* Device summary */}
      <div style={{ flex:1,minWidth:0 }}>
        <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.62rem",
          letterSpacing:"0.08em",color:CLR.text2(isDark),
          overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
          {configuredDevices.length>0
            ? configuredDevices.map(d=>`${d.device_name} [S${d.slave_id}·${d.poll_rate_ms/1000}s]`).join("  ·  ")
            : "No devices configured — click Configure Bus"}
        </div>
      </div>

      {/* Right controls */}
      <div style={{ display:"flex",alignItems:"center",gap:"10px",flexShrink:0 }}>
        {/* Last poll */}
        <div style={{ textAlign:"right" }}>
          <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.5rem",
            letterSpacing:"0.14em",color:CLR.text3(isDark),textTransform:"uppercase" }}>Last Poll</div>
          <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.7rem",
            color:CLR.text1(isDark) }}>{timeStr}</div>
        </div>

        <div style={{ width:"1px",height:"28px",background:CLR.border(isDark) }}/>

        {/* Status */}
        <div style={{ display:"flex",alignItems:"center",gap:"6px" }}>
          <div style={{ width:"8px",height:"8px",borderRadius:"50%",
            background:statusColor,
            boxShadow:isRunning?`0 0 8px ${statusColor}`:"none" }}/>
          <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.65rem",
            letterSpacing:"0.12em",fontWeight:600,color:statusColor }}>{statusLabel}</span>
        </div>

        <div style={{ width:"1px",height:"28px",background:CLR.border(isDark) }}/>
        {isSimulation && (
          <div style={{
            display:"flex", alignItems:"center", gap:"6px",
            padding:"0 10px", height:"28px",
            background:`${CLR.amber}15`,
            border:`1px solid ${CLR.amber}44`,
            borderRadius:"5px",
          }}>
            <span style={{ width:"6px",height:"6px",borderRadius:"50%",flexShrink:0,
              background:CLR.amber,
              boxShadow:`0 0 5px ${CLR.amber}`,
              animation:"pulse-dot 2s ease-in-out infinite",
            }}/>
            <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.56rem",
              letterSpacing:"0.14em",color:CLR.amber,textTransform:"uppercase" }}>
              No Hardware
            </span>
          </div>
        )}
        <div style={{ width:"1px",height:"28px",background:CLR.border(isDark) }}/>

        {/* Poll toggle */}
        <button onClick={onTogglePoll} style={{
          display:"flex",alignItems:"center",gap:"6px",
          padding:"0 14px",height:"34px",
          background: isRunning||isFault ? CLR.red+"18" : CLR.blue,
          border:`1px solid ${isRunning||isFault?CLR.red:CLR.blue}`,
          borderRadius:"6px",
          color:isRunning||isFault?CLR.red:"#fff",
          fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
          fontSize:"0.78rem",letterSpacing:"0.08em",
          cursor:"pointer",
          boxShadow:isRunning?"none":`0 2px 8px ${CLR.blue}44`,
        }}>
          {isRunning
            ?<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            :<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>}
          {isRunning?"Stop":isFault?"Reset":"Start"}
        </button>

        <button onClick={onClear} style={{
          display:"flex",alignItems:"center",gap:"6px",
          padding:"0 12px",height:"34px",
          background:isDark?"rgba(255,255,255,0.05)":"#f6f8fa",
          border:`1px solid ${CLR.border(isDark)}`,borderRadius:"6px",
          color:CLR.text2(isDark),fontFamily:"'Rajdhani',sans-serif",
          fontWeight:600,fontSize:"0.75rem",letterSpacing:"0.06em",cursor:"pointer",
        }}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2}>
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          </svg>
          Clear
        </button>

        <ExportDropdown activeDeviceName={activeDeviceName} exportStatus={exportStatus}
          onExport={onExport} isDark={isDark}/>

        {hasDiagnostics && (
          <>
            <div style={{ width:"1px",height:"28px",background:CLR.border(isDark) }}/>
            <button onClick={onOpenTerminal} style={{
              display:"flex",alignItems:"center",gap:"6px",
              padding:"0 12px",height:"34px",
              background:isDark?"rgba(0,255,136,0.08)":"rgba(0,255,136,0.06)",
              border:`1px solid rgba(0,255,136,0.3)`,borderRadius:"6px",
              color:"#00ff88",cursor:"pointer",
              fontFamily:"'Share Tech Mono',monospace",
              fontSize:"0.65rem",letterSpacing:"0.1em",
            }}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2}>
                <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
              </svg>
              TERMINAL
            </button>
          </>
        )}

        <button onClick={onThemeToggle} style={{
          padding:"0 10px",height:"34px",
          background:isDark?"rgba(255,255,255,0.05)":"#f6f8fa",
          border:`1px solid ${CLR.border(isDark)}`,borderRadius:"6px",
          color:CLR.text2(isDark),cursor:"pointer",
          display:"flex",alignItems:"center",
        }}>
          {theme==="dark"
            ?<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/></svg>
            :<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>}
        </button>

        <div style={{ width:"1px",height:"28px",background:CLR.border(isDark) }}/>

        {/* Logout */}
        <button onClick={onLogout} title="Revoke license &amp; log out" style={{
          display:"flex",alignItems:"center",gap:"5px",
          padding:"0 10px",height:"34px",
          background:"rgba(239,68,68,0.08)",
          border:`1px solid rgba(239,68,68,0.25)`,borderRadius:"6px",
          color:CLR.red,cursor:"pointer",
          fontFamily:"'Rajdhani',sans-serif",fontWeight:600,
          fontSize:"0.72rem",letterSpacing:"0.06em",
        }}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
            stroke="currentColor" strokeWidth={2}>
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          Log Out
        </button>
      </div>
    </header>
  );
}

// ─── BusBar ───────────────────────────────────────────────────────────────────

function BusBar({ configuredDevices, pollState, onOpenModal, isDark }:{
  configuredDevices:DeviceConfig[]; pollState:PollState;
  onOpenModal:()=>void; isDark:boolean;
}) {
  const isPolling = pollState==="running"||pollState==="fault";
  return (
    <div style={{
      display:"flex",alignItems:"center",gap:"10px",
      padding:"0 20px",height:"38px",flexShrink:0,
      background: isDark?"rgba(15,17,23,0.8)":"rgba(248,250,252,0.8)",
      borderBottom:`1px solid ${CLR.border(isDark)}`,
      backdropFilter:"blur(12px)", WebkitBackdropFilter:"blur(12px)",
    }}>
      <button onClick={onOpenModal} disabled={isPolling} style={{
        display:"flex",alignItems:"center",gap:"6px",
        padding:"0 12px",height:"26px",
        background:isPolling?"transparent":CLR.blue+"18",
        border:`1px solid ${isPolling?CLR.borderDim(isDark):CLR.blue+"50"}`,
        borderRadius:"5px",
        color:isPolling?CLR.text3(isDark):CLR.blue,
        fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
        fontSize:"0.7rem",letterSpacing:"0.1em",textTransform:"uppercase",
        cursor:isPolling?"not-allowed":"pointer",opacity:isPolling?0.45:1,
      }}>
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
        </svg>
        Configure Bus
      </button>
      {isPolling && (
        <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.54rem",
          letterSpacing:"0.12em",color:CLR.text3(isDark) }}>
          Stop polling to reconfigure
        </span>
      )}
      {configuredDevices.length>0 && !isPolling && (
        <>
          <span style={{ color:CLR.border(isDark),fontSize:"0.8rem" }}>|</span>
          {configuredDevices.map((d,i)=>(
            <div key={d.device_name} style={{ display:"flex",alignItems:"center",gap:"5px" }}>
              <div style={{ width:"5px",height:"5px",borderRadius:"50%",
                background:TAB_ACCENTS[i%TAB_ACCENTS.length] }}/>
              <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.58rem",
                color:CLR.text2(isDark),letterSpacing:"0.05em" }}>
                {d.device_name} · S{d.slave_id} · {d.poll_rate_ms/1000}s
              </span>
            </div>
          ))}
          <span style={{ marginLeft:"auto",fontFamily:"'Share Tech Mono',monospace",
            fontSize:"0.54rem",color:CLR.text3(isDark) }}>
            {configuredDevices.reduce((s,d)=>s+d.selected_registers.length,0)} registers total
          </span>
        </>
      )}
    </div>
  );
}

// ─── DevicePanel (accordion in modal) ────────────────────────────────────────

interface CustomRegDraft {
  name:string;address:string;length:string;data_type:string;multiplier:string;
}
const EMPTY_DRAFT:CustomRegDraft = {name:"",address:"",length:"2",data_type:"Float32",multiplier:"1.0"};

function DevicePanel({ device,index,profiles,isDark,onUpdate,onRemove,licensedProtocols,fieldErrors }:{
  device:DeviceConfig; index:number; profiles:MeterProfile[]; isDark:boolean;
  onUpdate:(d:DeviceConfig)=>void; onRemove:()=>void;
  licensedProtocols?: "RTU" | "TCP" | "All";
  fieldErrors?: Set<string>;
}) {
  const [expanded,  setExpanded]  = useState(index===0);
  useEffect(()=>{ if(fieldErrors && fieldErrors.size>0) setExpanded(true); },[fieldErrors]);
  const [search,    setSearch]    = useState("");
  const [checked,   setChecked]   = useState<Set<string>>(
    ()=>new Set(device.selected_registers.map(r=>r.name))
  );
  const [customRegs,setCustomRegs]= useState<RegisterEntry[]>(()=>{
    const profileNames = new Set(
      (profiles.find(p=>p.model===device.meter_model)?.registers??[]).map(r=>r.name)
    );
    return device.selected_registers.filter(r=>!profileNames.has(r.name));
  });
  const [draft,     setDraft]     = useState<CustomRegDraft>(EMPTY_DRAFT);
  const [draftErr,  setDraftErr]  = useState<string|null>(null);
  const [alarms,    setAlarms]    = useState<Record<string, {min?:string, max?:string}>>(()=>{
    const init: Record<string, {min?:string, max?:string}> = {};
    for (const r of device.selected_registers) {
      if (r.min_alarm !== undefined || r.max_alarm !== undefined) {
        init[r.name] = {
          min: r.min_alarm !== undefined ? String(r.min_alarm) : undefined,
          max: r.max_alarm !== undefined ? String(r.max_alarm) : undefined,
        };
      }
    }
    return init;
  });

  const profile     = profiles.find(p=>p.model===device.meter_model);
  const profileRegs = profile?.registers??[];

  const filtered = useMemo(()=>{
    const q=search.toLowerCase();
    return profileRegs.filter(r=>r.name.toLowerCase().includes(q)||String(r.address).includes(q));
  },[profileRegs,search]);
  const filteredCustom = customRegs.filter(r=>r.name.toLowerCase().includes(search.toLowerCase()));

  const allNames = [...filtered.map(r=>r.name),...filteredCustom.map(r=>r.name)];
  const allOn    = allNames.length>0 && allNames.every(n=>checked.has(n));

  useEffect(()=>{
    // Guard: if the profile hasn't loaded yet but the device already has saved
    // registers, skip the update — otherwise we'd wipe the saved selection.
    if(profileRegs.length===0 && device.selected_registers.length>0) return;
    const regs = [...profileRegs,...customRegs].filter(r=>checked.has(r.name)).map(r=>({
      ...r,
      min_alarm: alarms[r.name]?.min !== undefined && alarms[r.name]!.min !== "" ? parseFloat(alarms[r.name]!.min!) : undefined,
      max_alarm: alarms[r.name]?.max !== undefined && alarms[r.name]!.max !== "" ? parseFloat(alarms[r.name]!.max!) : undefined,
    }));
    onUpdate({...device,selected_registers:regs});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[checked,customRegs,alarms]);

  const toggleReg = (name:string) =>
    setChecked(prev=>{const s=new Set(prev);s.has(name)?s.delete(name):s.add(name);return s;});

  const handleModelChange = (model:string) => {
    const np=profiles.find(p=>p.model===model);
    setChecked(new Set((np?.registers??[]).map(r=>r.name)));
    setCustomRegs([]);
    onUpdate({...device,meter_model:model,selected_registers:np?.registers??[],
      baud_rate:np?.baud_rate??device.baud_rate});
  };

  const addCustom = () => {
    setDraftErr(null);
    if(!draft.name.trim()){setDraftErr("Name required");return;}
    const addr=parseInt(draft.address,10);
    if(isNaN(addr)||addr<0||addr>65535){setDraftErr("Address 0–65535");return;}
    const len=parseInt(draft.length,10);
    if(![1,2,4].includes(len)){setDraftErr("Length must be 1, 2, or 4");return;}
    const mult=parseFloat(draft.multiplier);
    if(isNaN(mult)){setDraftErr("Multiplier must be a number");return;}
    if(customRegs.some(r=>r.name===draft.name.trim())){setDraftErr("Name already used");return;}
    const nr:RegisterEntry={name:draft.name.trim(),address:addr,length:len,data_type:draft.data_type,multiplier:mult};
    setCustomRegs(p=>[...p,nr]);
    setChecked(p=>new Set([...p,nr.name]));
    setDraft(EMPTY_DRAFT);
  };

  const accent   = TAB_ACCENTS[index%TAB_ACCENTS.length];
  const border   = CLR.border(isDark);
  // Poll rate shown in seconds
  const pollSecs = device.poll_rate_ms/1000;

  const iS: React.CSSProperties = {
    height:"32px",background:isDark?"rgba(255,255,255,0.04)":"#fff",
    border:`1px solid ${border}`,borderRadius:"5px",
    color:CLR.text1(isDark),fontFamily:"'Share Tech Mono',monospace",
    fontSize:"0.7rem",letterSpacing:"0.04em",outline:"none",padding:"0 8px",width:"100%",
  };
  const fe = (field:string): React.CSSProperties =>
    fieldErrors?.has(field) ? {border:`1px solid ${CLR.red}`} : {};
  const lS: React.CSSProperties = {
    display:"block",marginBottom:"4px",
    fontFamily:"'Share Tech Mono',monospace",fontSize:"0.5rem",
    letterSpacing:"0.2em",textTransform:"uppercase",color:CLR.text3(isDark),
  };
  const selCount = [...profileRegs,...customRegs].filter(r=>checked.has(r.name)).length;

  return (
    <div style={{ ...glass(isDark), overflow:"hidden", marginBottom:"8px" }}>
      {/* Accordion header */}
      <div onClick={()=>setExpanded(e=>!e)} style={{
        display:"flex",alignItems:"center",gap:"10px",padding:"10px 14px",cursor:"pointer",
        background:isDark?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.02)",
        borderBottom:expanded?`1px solid ${border}`:"none",userSelect:"none",
      }}>
        <div style={{ width:"3px",height:"18px",borderRadius:"2px",background:accent,flexShrink:0 }}/>
        <span style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"0.85rem",
          color:CLR.text1(isDark),flex:1,minWidth:0 }}>
          {device.device_name.trim()||<span style={{opacity:0.4}}>Untitled {index+1}</span>}
        </span>
        {device.meter_model&&(
          <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.58rem",
            color:CLR.text2(isDark) }}>
            {profiles.find(p=>p.model===device.meter_model)?.display_name??device.meter_model}
          </span>
        )}
        {selCount>0&&(
          <span style={{ padding:"2px 8px",borderRadius:"12px",
            background:accent+"20",border:`1px solid ${accent}44`,
            color:accent,fontFamily:"'Share Tech Mono',monospace",
            fontSize:"0.54rem",letterSpacing:"0.08em" }}>
            {selCount} reg{selCount!==1?"s":""}
          </span>
        )}
        <button onClick={e=>{e.stopPropagation();onRemove();}} style={{
          background:"none",border:"none",color:CLR.red,cursor:"pointer",fontSize:"1rem",padding:"0 2px",opacity:0.65,
        }}>✕</button>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke={CLR.text3(isDark)} strokeWidth={2}
          style={{ transform:expanded?"rotate(180deg)":"rotate(0)",transition:"transform 0.2s" }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>

      {expanded&&(
        <div style={{ padding:"14px" }}>
          <div style={{ display:"grid",gridTemplateColumns:"2fr 2fr 1fr 1fr 1fr",
            gap:"10px",marginBottom:"14px" }}>
            <div>
              <label style={lS}>Device Name</label>
              <input type="text" value={device.device_name} placeholder='"Main Incomer"'
                style={{...iS,...fe('device_name')}} onChange={e=>onUpdate({...device,device_name:e.target.value})}/>
            </div>
            <div>
              <label style={lS}>Meter Model</label>
              <select value={device.meter_model} style={{...iS,cursor:"pointer",...fe('meter_model')}}
                onChange={e=>handleModelChange(e.target.value)}>
                <option value="" disabled>Select model…</option>
                {profiles.map(p=><option key={p.model} value={p.model}>{p.display_name}</option>)}
              </select>
            </div>
            <div>
              <label style={lS}>Slave ID</label>
              <input type="number" min={1} max={247} value={device.slave_id}
                style={{...iS,textAlign:"center",...fe('slave_id')}}
                onChange={e=>{const v=parseInt(e.target.value,10);if(v>=1&&v<=247)onUpdate({...device,slave_id:v});}}/>
            </div>
            <div>
              {/* ← Seconds input: ×1000 before storing */}
              <label style={lS}>Poll Rate (s)</label>
              <input type="number" min={0.2} step={0.5} value={pollSecs}
                style={{...iS,textAlign:"center"}}
                onChange={e=>{
                  const s=parseFloat(e.target.value);
                  if(s>=0.2)onUpdate({...device,poll_rate_ms:Math.round(s*1000)});
                }}/>
            </div>
            <div>
              <label style={lS}>Alarm Cycles</label>
              <input type="number" min={1} max={100} value={device.alarm_trigger_cycles}
                title="Consecutive breaching polls before alarm email fires"
                style={{...iS,textAlign:"center"}}
                onChange={e=>{
                  const v=parseInt(e.target.value,10);
                  if(v>=1&&v<=100)onUpdate({...device,alarm_trigger_cycles:v});
                }}/>
            </div>
          </div>

          {/* ── Connection settings ─────────────────────────────────────── */}
          <div style={{ display:"grid",gridTemplateColumns:"auto 1fr 1fr",gap:"10px",marginBottom:"14px",alignItems:"end" }}>
            <div>
              <label style={lS}>Protocol</label>
              <select value={device.protocol} style={{...iS,cursor:"pointer",width:"auto",paddingRight:"24px"}}
                onChange={e=>onUpdate({...device,protocol:e.target.value as "rtu"|"tcp"})}>
                {(!licensedProtocols || licensedProtocols === "All" || licensedProtocols === "RTU") && (
                  <option value="rtu">Modbus RTU</option>
                )}
                {(!licensedProtocols || licensedProtocols === "All" || licensedProtocols === "TCP") && (
                  <option value="tcp">Modbus TCP</option>
                )}
              </select>
              {licensedProtocols && licensedProtocols !== "All" && (
                <div style={{ marginTop:"3px", fontFamily:"'Share Tech Mono',monospace",
                  fontSize:"0.48rem", letterSpacing:"0.08em",
                  color: CLR.amber }}>
                  License: {licensedProtocols} only
                </div>
              )}
            </div>
            {device.protocol==="rtu" ? <>
              <div>
                <label style={lS}>COM Port</label>
                <div style={fieldErrors?.has('com_port') ? {outline:`1px solid ${CLR.red}`,borderRadius:"5px"} : {}}>
                  <ComPortSelector value={device.com_port} onChange={v=>onUpdate({...device,com_port:v})} disabled={false} isDark={isDark}/>
                </div>
              </div>
              <div>
                <label style={lS}>Baud Rate</label>
                <select value={device.baud_rate} style={{...iS,cursor:"pointer"}}
                  onChange={e=>onUpdate({...device,baud_rate:parseInt(e.target.value,10)})}>
                  {[1200,2400,4800,9600,19200,38400,57600,115200].map(b=><option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            </> : <>
              <div>
                <label style={lS}>IP Address</label>
                <input type="text" value={device.ip_address} placeholder="192.168.1.50"
                  style={{...iS,...fe('ip_address')}} onChange={e=>onUpdate({...device,ip_address:e.target.value})}/>
              </div>
              <div>
                <label style={lS}>TCP Port</label>
                <input type="number" min={1} max={65535} value={device.tcp_port}
                  style={{...iS,textAlign:"center"}}
                  onChange={e=>{const v=parseInt(e.target.value,10);if(v>0&&v<=65535)onUpdate({...device,tcp_port:v});}}/>
              </div>
            </>}
          </div>

          {device.meter_model&&(
            <>
              {/* Register search + select-all */}
              <div style={{ display:"flex",alignItems:"center",gap:"8px",marginBottom:"8px" }}>
                <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.52rem",
                  letterSpacing:"0.16em",textTransform:"uppercase",color:CLR.text3(isDark) }}>
                  Registers ({filtered.length+filteredCustom.length})
                </span>
                <input type="text" value={search} placeholder="Search…"
                  onChange={e=>setSearch(e.target.value)}
                  style={{...iS,flex:1,maxWidth:"150px",height:"26px",fontSize:"0.66rem"}}/>
                <button onClick={()=>{
                  if(allOn)setChecked(prev=>{const s=new Set(prev);allNames.forEach(n=>s.delete(n));return s;});
                  else setChecked(prev=>new Set([...prev,...allNames]));
                }} style={{
                  padding:"0 10px",height:"26px",
                  background:allOn?accent+"20":"transparent",
                  border:`1px solid ${allOn?accent+"50":border}`,
                  borderRadius:"5px",color:allOn?accent:CLR.text2(isDark),
                  fontFamily:"'Rajdhani',sans-serif",fontWeight:600,
                  fontSize:"0.68rem",letterSpacing:"0.06em",cursor:"pointer",whiteSpace:"nowrap",
                }}>{allOn?"Deselect All":"Select All"}</button>
              </div>

              {/* Register list */}
              <div style={{ border:`1px solid ${border}`,borderRadius:"6px",
                maxHeight:"170px",overflowY:"auto",marginBottom:"12px",
                background:isDark?"rgba(0,0,0,0.2)":"rgba(0,0,0,0.01)" }}>
                {device.meter_model==="Custom" && filtered.length===0 && filteredCustom.length===0 && (
                  <div style={{
                    display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                    padding:"20px 16px",gap:"6px",
                  }}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                      stroke={CLR.amber} strokeWidth={1.5}>
                      <circle cx="12" cy="12" r="10"/>
                      <line x1="12" y1="8" x2="12" y2="12"/>
                      <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.58rem",
                      letterSpacing:"0.1em",color:CLR.amber,textAlign:"center",lineHeight:1.5 }}>
                      Custom device — use "Add Custom Register"<br/>
                      below to define your Modbus registers.
                    </span>
                  </div>
                )}
                {[...filtered.map(r=>({r,c:false})),...filteredCustom.map(r=>({r,c:true}))].map(({r,c})=>(
                  <div key={r.name} onClick={()=>toggleReg(r.name)} style={{
                    display:"flex",alignItems:"center",gap:"8px",padding:"5px 10px",
                    borderBottom:`1px solid ${CLR.borderDim(isDark)}`,
                    cursor:"pointer",userSelect:"none",
                    background:checked.has(r.name)
                      ?(isDark?"rgba(29,107,255,0.06)":"rgba(29,107,255,0.03)")
                      :"transparent",
                  }}>
                    <div style={{
                      width:"13px",height:"13px",borderRadius:"3px",flexShrink:0,
                      background:checked.has(r.name)?accent:"transparent",
                      border:`1.5px solid ${checked.has(r.name)?accent:CLR.border(isDark)}`,
                      display:"flex",alignItems:"center",justifyContent:"center",
                    }}>
                      {checked.has(r.name)&&(
                        <svg viewBox="0 0 10 10" width="9" height="9">
                          <polyline points="1.5,5 4,7.5 8.5,2" stroke="#fff"
                            strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                        </svg>
                      )}
                    </div>
                    <span style={{ flex:1,fontFamily:"'Share Tech Mono',monospace",fontSize:"0.64rem",
                      letterSpacing:"0.03em",
                      color:checked.has(r.name)?CLR.text1(isDark):CLR.text2(isDark),
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                      {r.name}
                      {c&&<span style={{ marginLeft:"6px",padding:"1px 4px",borderRadius:"3px",
                        background:CLR.green+"20",color:CLR.green,fontSize:"0.46rem",
                        letterSpacing:"0.1em" }}>CUSTOM</span>}
                    </span>
                    <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.54rem",
                      color:CLR.text3(isDark),minWidth:"40px",textAlign:"right" }}>@{r.address}</span>
                    <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.52rem",
                      color:CLR.text3(isDark),minWidth:"52px",textAlign:"center" }}>{r.data_type}</span>
                    {checked.has(r.name) && (
                      <div onClick={e=>e.stopPropagation()} style={{ display:"flex", gap:"3px", alignItems:"center" }}>
                        <input type="number" placeholder="Min" value={alarms[r.name]?.min??""}
                          onChange={e=>setAlarms(a=>({...a,[r.name]:{...a[r.name],min:e.target.value}}))}
                          style={{ width:"52px", height:"20px", fontSize:"0.56rem",
                            background:isDark?"rgba(255,255,255,0.06)":"#f6f8fa",
                            border:`1px solid ${CLR.border(isDark)}`, borderRadius:"3px",
                            color:CLR.amber, textAlign:"center", outline:"none", padding:"0 4px",
                            fontFamily:"'Share Tech Mono',monospace" }}/>
                        <input type="number" placeholder="Max" value={alarms[r.name]?.max??""}
                          onChange={e=>setAlarms(a=>({...a,[r.name]:{...a[r.name],max:e.target.value}}))}
                          style={{ width:"52px", height:"20px", fontSize:"0.56rem",
                            background:isDark?"rgba(255,255,255,0.06)":"#f6f8fa",
                            border:`1px solid ${CLR.border(isDark)}`, borderRadius:"3px",
                            color:CLR.red, textAlign:"center", outline:"none", padding:"0 4px",
                            fontFamily:"'Share Tech Mono',monospace" }}/>
                      </div>
                    )}
                    {c&&(
                      <button onClick={e=>{e.stopPropagation();
                        setCustomRegs(p=>p.filter(x=>x.name!==r.name));
                        setChecked(p=>{const s=new Set(p);s.delete(r.name);return s;});
                      }} style={{ background:"none",border:"none",color:CLR.red,cursor:"pointer",
                        fontSize:"0.8rem",padding:"0 2px",lineHeight:1 }}>✕</button>
                    )}
                  </div>
                ))}
              </div>

              {/* Custom register builder */}
              <div style={{ border:`1px solid ${border}`,borderRadius:"6px",overflow:"hidden" }}>
                <div style={{ padding:"5px 12px",borderBottom:`1px solid ${border}`,
                  background:isDark?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.02)",
                  fontFamily:"'Share Tech Mono',monospace",fontSize:"0.5rem",
                  letterSpacing:"0.18em",textTransform:"uppercase",color:CLR.text3(isDark) }}>
                  Add Custom Register
                </div>
                <div style={{ padding:"10px" }}>
                  <div style={{ display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr auto",
                    gap:"8px",alignItems:"end" }}>
                    <div>
                      <label style={lS}>Name</label>
                      <input type="text" value={draft.name} placeholder="Tag name"
                        style={{...iS,height:"28px",fontSize:"0.66rem"}}
                        onChange={e=>{setDraft(d=>({...d,name:e.target.value}));setDraftErr(null);}}/>
                    </div>
                    <div>
                      <label style={lS}>Address</label>
                      <input type="number" min={0} max={65535} value={draft.address}
                        style={{...iS,height:"28px",fontSize:"0.66rem"}}
                        onChange={e=>setDraft(d=>({...d,address:e.target.value}))}/>
                    </div>
                    <div>
                      <label style={lS}>Length</label>
                      <select value={draft.length} style={{...iS,height:"28px",fontSize:"0.66rem",cursor:"pointer"}}
                        onChange={e=>setDraft(d=>({...d,length:e.target.value}))}>
                        <option value="1">1 (16b)</option>
                        <option value="2">2 (32b)</option>
                        <option value="4">4 (64b)</option>
                      </select>
                    </div>
                    <div>
                      <label style={lS}>Type</label>
                      <select value={draft.data_type} style={{...iS,height:"28px",fontSize:"0.66rem",cursor:"pointer"}}
                        onChange={e=>setDraft(d=>({...d,data_type:e.target.value}))}>
                        {DATA_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={lS}>×Mult</label>
                      <input type="text" value={draft.multiplier} placeholder="1.0"
                        style={{...iS,height:"28px",fontSize:"0.66rem"}}
                        onChange={e=>setDraft(d=>({...d,multiplier:e.target.value}))}/>
                    </div>
                    <button onClick={addCustom} style={{
                      height:"28px",padding:"0 12px",borderRadius:"5px",
                      background:CLR.blue+"20",border:`1px solid ${CLR.blue}50`,
                      color:CLR.blue,cursor:"pointer",
                      fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
                      fontSize:"0.7rem",letterSpacing:"0.08em",whiteSpace:"nowrap",
                    }}>+ Add</button>
                  </div>
                  {draftErr&&(
                    <div style={{ marginTop:"6px",fontFamily:"'Share Tech Mono',monospace",
                      fontSize:"0.58rem",color:CLR.amber,letterSpacing:"0.06em" }}>
                      ⚠ {draftErr}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── DeviceSetupModal ────────────────────────────────────────────────────────

function DeviceSetupModal({ profiles,initialDevices,onSave,onClose,theme,licensedProtocols,isCloudEnabled,isCloudBuild }:{
  profiles:MeterProfile[]; initialDevices:DeviceConfig[];
  onSave:(devices:DeviceConfig[])=>void; onClose:()=>void; theme:Theme;
  licensedProtocols?: "RTU" | "TCP" | "All";
  isCloudEnabled?: boolean;
  isCloudBuild: boolean;
}) {
  const isDark = theme==="dark";
  const [devices,setDevices] = useState<DeviceConfig[]>(()=>
    initialDevices.length>0
      ? initialDevices
      : [{...DEFAULT_DEVICE(),meter_model:profiles[0]?.model??""}]
  );
  const [notifEmail,   setNotifEmail]   = useState("");
  const [emailSaved,   setEmailSaved]   = useState(false);
  const [exportDir,    setExportDir]    = useState("");
  const [dirSaved,     setDirSaved]     = useState(false);
  const [fieldErrors,  setFieldErrors]  = useState<Record<number,Set<string>>>({});

  useEffect(()=>{
    invokeApi<string>("get_notification_email").then(setNotifEmail).catch(()=>{});
    invokeApi<string>("get_export_path").then(setExportDir).catch(()=>{});
  },[]);

  const updDevice = (i:number,d:DeviceConfig) => setDevices(p=>p.map((x,j)=>j===i?d:x));
  const remDevice = (i:number) => setDevices(p=>p.length>1?p.filter((_,j)=>j!==i):p);
  const addDevice = () => setDevices(p=>[...p,{...DEFAULT_DEVICE(),meter_model:profiles[0]?.model??""}]);

  const handleSave = () => {
    const errors: Record<number,Set<string>> = {};
    for(let i=0;i<devices.length;i++){
      const d=devices[i];
      const e=new Set<string>();
      if(!d.device_name.trim())                              e.add('device_name');
      if(!d.meter_model)                                     e.add('meter_model');
      if(d.slave_id<1||d.slave_id>247)                      e.add('slave_id');
      if(d.protocol==="rtu" && !d.com_port.trim())          e.add('com_port');
      if(d.protocol==="tcp" && !d.ip_address.trim())        e.add('ip_address');
      if(e.size>0) errors[i]=e;
    }
    if(Object.keys(errors).length>0){setFieldErrors(errors);return;}
    // Register selection is still guarded (backend will also reject, toast handles it)
    const ids=devices.map(d=>d.slave_id);
    const dup=ids.find((id,i)=>ids.indexOf(id)!==i);
    if(dup!==undefined){alert(`Duplicate Slave ID ${dup} — each device must have a unique address.`);return;}
    setFieldErrors({});
    onSave(devices);
  };

  const totalRegs = devices.reduce((s,d)=>s+d.selected_registers.length,0);
  const border    = CLR.border(isDark);
  const iS: React.CSSProperties = {
    height:"32px", background:isDark?"rgba(255,255,255,0.04)":"#fff",
    border:`1px solid ${border}`, borderRadius:"5px",
    color:CLR.text1(isDark), fontFamily:"'Share Tech Mono',monospace",
    fontSize:"0.7rem", letterSpacing:"0.04em", outline:"none", padding:"0 8px",
  };

  return (
    <div style={{
      position:"fixed",inset:0,zIndex:9998,
      background:"rgba(0,0,0,0.78)",backdropFilter:"blur(6px)",
      display:"flex",alignItems:"center",justifyContent:"center",padding:"20px",
    }} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{
        width:"100%",maxWidth:"880px",maxHeight:"92vh",
        ...glass(isDark),
        boxShadow:"0 40px 100px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)",
        display:"flex",flexDirection:"column",overflow:"hidden",
      }}>
        <div style={{ height:"3px",
          background:"linear-gradient(90deg,#1d6bff,#16a34a,#d97706,#7c3aed)" }}/>

        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"14px 20px 10px",borderBottom:`1px solid ${border}`,flexShrink:0 }}>
          <div>
            <div style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"1.05rem",
              letterSpacing:"0.08em",color:CLR.text1(isDark) }}>Bus Configuration</div>
            <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.52rem",
              letterSpacing:"0.14em",color:CLR.text3(isDark),marginTop:"2px" }}>
              {devices.length} device{devices.length!==1?"s":""} · {totalRegs} registers · poll rate in seconds
            </div>
          </div>
          <button onClick={onClose} style={{
            background:"none",border:`1px solid ${border}`,borderRadius:"5px",
            color:CLR.text2(isDark),cursor:"pointer",padding:"4px 10px",
            fontFamily:"'Share Tech Mono',monospace",fontSize:"0.58rem",letterSpacing:"0.08em",
          }}>ESC</button>
        </div>

        <div style={{ flex:1,overflowY:"auto",padding:"14px 20px" }}>
          {devices.map((dev,i)=>(
            <DevicePanel key={i} index={i} device={dev} profiles={profiles} isDark={isDark}
              onUpdate={d=>updDevice(i,d)} onRemove={()=>remDevice(i)}
              licensedProtocols={licensedProtocols} fieldErrors={fieldErrors[i]}/>
          ))}
          <button onClick={addDevice} style={{
            width:"100%",padding:"10px",
            background:"transparent",
            border:`1px dashed ${isDark?CLR.blue+"40":CLR.blue+"30"}`,
            borderRadius:"8px",color:CLR.text3(isDark),
            fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
            fontSize:"0.72rem",letterSpacing:"0.12em",textTransform:"uppercase",
            cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:"8px",
          }}
            onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.borderColor=CLR.blue+"80";
              (e.currentTarget as HTMLElement).style.color=CLR.blue;}}
            onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.borderColor=isDark?CLR.blue+"40":CLR.blue+"30";
              (e.currentTarget as HTMLElement).style.color=CLR.text3(isDark);}}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Another Meter
          </button>

          {/* Notifications */}
          <div style={{ marginTop:"12px", ...glass(isDark), overflow:"hidden" }}>
            <div style={{ padding:"8px 14px", borderBottom:`1px solid ${border}`,
              background:isDark?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.02)",
              fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
              letterSpacing:"0.18em", textTransform:"uppercase", color:CLR.text3(isDark) }}>
              Alarm Notifications (requires EmailAlerts license)
            </div>
            <div style={{ padding:"12px 14px", display:"flex", flexDirection:"column", gap:"10px" }}>
              {/* Destination email */}
              <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
                <input type="email" value={notifEmail} placeholder="destination@email.com"
                  onChange={e=>{setNotifEmail(e.target.value);setEmailSaved(false);}}
                  style={{ ...iS, flex:1 }}/>
                <button onClick={async ()=>{
                  try {
                    await invokeApi("save_notification_email", { email: notifEmail });
                    setEmailSaved(true);
                  } catch {}
                }} style={{
                  height:"32px", padding:"0 14px", borderRadius:"5px",
                  background: emailSaved ? CLR.green+"20" : CLR.blue+"20",
                  border:`1px solid ${emailSaved ? CLR.green+"50" : CLR.blue+"50"}`,
                  color: emailSaved ? CLR.green : CLR.blue,
                  cursor:"pointer", fontFamily:"'Rajdhani',sans-serif",
                  fontWeight:700, fontSize:"0.72rem", whiteSpace:"nowrap",
                }}>{emailSaved ? "Saved ✓" : "Save Email"}</button>
              </div>
            </div>
          </div>

          {/* Enterprise Data Directory */}
          <div style={{ marginTop:"12px", ...glass(isDark), overflow:"hidden" }}>
            <div style={{ padding:"8px 14px", borderBottom:`1px solid ${border}`,
              background:isDark?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.02)",
              fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
              letterSpacing:"0.18em", textTransform:"uppercase", color:CLR.text3(isDark) }}>
              Enterprise Data Directory (nightly exports + MID backups)
            </div>
            <div style={{ padding:"12px 14px", display:"flex", flexDirection:"column", gap:"8px" }}>
              <div style={{ fontSize:"0.68rem", color:CLR.text2(isDark) }}>
                Daily .xlsx files are written to <code style={{ fontFamily:"'Share Tech Mono',monospace" }}>[dir]/[device]/[YYYY]/[MM]/[YYYY-MM-DD].xlsx</code> at 23:58 local time.
                Encrypted DB backups + SHA-256 hash go to <code style={{ fontFamily:"'Share Tech Mono',monospace" }}>[dir]/_backups/</code>.
              </div>
              <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
                <div style={{ flex:1, ...iS, display:"flex", alignItems:"center",
                  gap:"6px", cursor:"default", overflow:"hidden" }}>
                  <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.65rem",
                    color: exportDir ? CLR.text1(isDark) : CLR.text3(isDark),
                    whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                    {exportDir || "No directory selected"}
                  </span>
                </div>
                <button onClick={async ()=>{
                  if (!isTauri) return; // folder picker not available in browser
                  const { open } = await import("@tauri-apps/plugin-dialog");
                  const selected = await open({ directory:true, multiple:false });
                  if (typeof selected === "string" && selected) {
                    setExportDir(selected); setDirSaved(false);
                  }
                }} style={{
                  height:"32px", padding:"0 14px", borderRadius:"5px",
                  background:CLR.blue+"20", border:`1px solid ${CLR.blue+"50"}`,
                  color:CLR.blue, cursor:"pointer", fontFamily:"'Rajdhani',sans-serif",
                  fontWeight:700, fontSize:"0.72rem", whiteSpace:"nowrap",
                }}>Browse</button>
                <button onClick={async ()=>{
                  if (!exportDir) return;
                  try {
                    await invokeApi("save_export_path", { path: exportDir });
                    setDirSaved(true);
                  } catch {}
                }} disabled={!exportDir} style={{
                  height:"32px", padding:"0 14px", borderRadius:"5px",
                  background: dirSaved ? CLR.green+"20" : CLR.blue+"20",
                  border:`1px solid ${dirSaved ? CLR.green+"50" : CLR.blue+"50"}`,
                  color: dirSaved ? CLR.green : CLR.blue,
                  cursor: exportDir ? "pointer" : "not-allowed",
                  fontFamily:"'Rajdhani',sans-serif",
                  fontWeight:700, fontSize:"0.72rem", whiteSpace:"nowrap",
                }}>{dirSaved ? "Saved ✓" : "Save Dir"}</button>
              </div>
            </div>
          </div>

          {/* Cloud Sync — absent from air-gapped binary, no DOM nodes, no greyed card */}
          {isCloudBuild && (
            <div style={{ marginTop:"12px", ...glass(isDark), overflow:"hidden",
              opacity: isCloudEnabled ? 1 : 0.45,
              pointerEvents: isCloudEnabled ? "auto" : "none",
            }}>
              <div style={{ padding:"8px 14px", borderBottom:`1px solid ${border}`,
                background:isDark?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.02)",
                display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
                  letterSpacing:"0.18em", textTransform:"uppercase", color:CLR.text3(isDark) }}>
                  Cloud Sync &amp; Telemetry
                </span>
                {!isCloudEnabled && (
                  <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.46rem",
                    letterSpacing:"0.1em", color:CLR.amber,
                    border:`1px solid ${CLR.amber}50`, borderRadius:"3px", padding:"1px 6px" }}>
                    Requires Online · Tier 2+
                  </span>
                )}
              </div>
              <div style={{ padding:"12px 14px", display:"flex", flexDirection:"column", gap:"6px" }}>
                <div style={{ fontSize:"0.68rem", color:CLR.text2(isDark) }}>
                  Push live readings and alarms to the TechniDAQ cloud dashboard.
                  Available for <strong>Online</strong> licenses at <strong>Tier 2</strong> or higher.
                </div>
                {isCloudEnabled && (
                  <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.6rem",
                    letterSpacing:"0.08em", color:CLR.green }}>
                    &#9679; CLOUD SYNC ACTIVE
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"10px 20px",borderTop:`1px solid ${border}`,flexShrink:0 }}>
          <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.54rem",
            letterSpacing:"0.1em",color:CLR.text3(isDark) }}>
            {totalRegs} register{totalRegs!==1?"s":""} across {devices.length} device{devices.length!==1?"s":""}
          </span>
          <div style={{ display:"flex",gap:"10px" }}>
            <button onClick={onClose} style={{
              padding:"0 16px",height:"34px",borderRadius:"6px",
              background:"transparent",border:`1px solid ${border}`,
              color:CLR.text2(isDark),cursor:"pointer",
              fontFamily:"'Rajdhani',sans-serif",fontWeight:600,fontSize:"0.78rem",
            }}>Cancel</button>
            <button onClick={handleSave} disabled={totalRegs===0} style={{
              padding:"0 20px",height:"34px",borderRadius:"6px",
              background:totalRegs===0?"rgba(29,107,255,0.1)":"#1d6bff",
              border:`1px solid ${totalRegs===0?CLR.blue+"30":"#1d6bff"}`,
              color:totalRegs===0?CLR.text3(isDark):"#fff",
              cursor:totalRegs===0?"not-allowed":"pointer",
              fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"0.8rem",
              letterSpacing:"0.08em",
              boxShadow:totalRegs>0?"0 4px 14px rgba(29,107,255,0.4)":"none",
            }}>Save Bus Configuration</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── License Gateway ──────────────────────────────────────────────────────────

function LicenseGateway({ onActivated }:{ onActivated:(auth:AuthState)=>void }) {
  const [key,      setKey]      = useState("");
  const [username, setUsername] = useState("");
  const [project,  setProject]  = useState("");
  const [error,    setError]    = useState<string|null>(null);
  const [busy,     setBusy]     = useState(false);
  const [focused,  setFocused]  = useState<string|null>(null);
  const [pendingPayload, setPendingPayload] = useState<{key:string;username:string;projectName:string}|null>(null);
  const [existingCount,  setExistingCount]  = useState(0);

  const doActivate = async (payload:{key:string;username:string;projectName:string}, clearHistory:boolean) => {
    setBusy(true);
    setPendingPayload(null);
    try {
      if(clearHistory) await invokeApi("clear_history");
      await invokeApi<string>("activate_license", payload);
      const auth = await invokeApi<AuthState>("get_auth_state");
      onActivated(auth);
    } catch(e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const activate = async () => {
    setError(null);
    if(!key.trim())     {setError("License key is required.");return;}
    if(!username.trim()){setError("Username is required.");return;}
    if(!project.trim()) {setError("Project name is required.");return;}
    setBusy(true);
    try {
      const payload = { key: key.trim(), username: username.trim(), projectName: project.trim() };
      const count = await invokeApi<number>("get_record_count");
      if(count > 0){
        setPendingPayload(payload);
        setExistingCount(count);
        setBusy(false);
        return;
      }
      await doActivate(payload, false);
    } catch(e) { setError(String(e)); setBusy(false); }
  };

  const iS = (f:string): React.CSSProperties => ({
    width:"100%",padding:"10px 12px",
    background:"rgba(255,255,255,0.06)",
    border:`1px solid ${focused===f?"rgba(29,107,255,0.7)":"rgba(255,255,255,0.12)"}`,
    borderRadius:"7px",color:"#e6edf3",outline:"none",
    fontFamily:f==="key"?"'Share Tech Mono',monospace":"'Rajdhani',sans-serif",
    fontSize:f==="key"?"0.72rem":"0.92rem",fontWeight:f==="key"?400:600,
    letterSpacing:f==="key"?"0.06em":"0.04em",
    boxShadow:focused===f?"0 0 0 3px rgba(29,107,255,0.18)":"none",
    transition:"all 0.2s ease",
  });

  return (
    <div style={{
      position:"fixed",inset:0,background:"#0f1117",
      backgroundImage:"radial-gradient(circle,rgba(30,36,48,0.9) 1px,transparent 1px)",
      backgroundSize:"24px 24px",
      display:"flex",alignItems:"center",justifyContent:"center",zIndex:9999,
    }}>
      <div style={{
        width:"100%",maxWidth:440,
        background:"#161b22",border:"1px solid #30363d",
        borderRadius:"12px",boxShadow:"0 24px 80px rgba(0,0,0,0.8)",overflow:"hidden",
      }}>
        <div style={{ height:"3px",
          background:"linear-gradient(90deg,#1d6bff,#16a34a,#d97706)" }}/>
        <div style={{ padding:"32px" }}>
          <div style={{ textAlign:"center",marginBottom:"28px" }}>
            <img src={logoUrl} alt="Technicat Group"
              style={{ width:200,height:"auto",display:"block",margin:"0 auto 12px" }}/>
            <div style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"1.4rem",
              letterSpacing:"0.06em",color:"#e6edf3" }}>TechniDAQ</div>
            <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.52rem",
              letterSpacing:"0.2em",color:"#484f58",marginTop:"3px" }}>
              LICENSE ACTIVATION
            </div>
          </div>
          <div style={{ display:"flex",flexDirection:"column",gap:"14px" }}>
            <div>
              <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.5rem",
                letterSpacing:"0.2em",color:"#484f58",textTransform:"uppercase",marginBottom:"6px" }}>
                License Key
              </div>
              <textarea rows={3} value={key} placeholder="Paste your license key…"
                style={{ ...iS("key"),resize:"none",lineHeight:1.6 }}
                onChange={e=>{setKey(e.target.value);setError(null);}}
                onFocus={()=>setFocused("key")} onBlur={()=>setFocused(null)}
                onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();activate();}}}/>
            </div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"10px" }}>
              {(["user","proj"] as const).map(f=>(
                <div key={f}>
                  <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.5rem",
                    letterSpacing:"0.2em",color:"#484f58",textTransform:"uppercase",marginBottom:"6px" }}>
                    {f==="user"?"Username":"Project"}
                  </div>
                  <input type="text"
                    placeholder={f==="user"?"john.smith":"Site Alpha"}
                    style={iS(f)}
                    value={f==="user"?username:project}
                    onChange={e=>{f==="user"?setUsername(e.target.value):setProject(e.target.value);setError(null);}}
                    onFocus={()=>setFocused(f)} onBlur={()=>setFocused(null)}
                    onKeyDown={e=>{if(e.key==="Enter")activate();}}/>
                </div>
              ))}
            </div>
            {error&&(
              <div style={{ padding:"10px 12px",
                background:"rgba(220,38,38,0.1)",border:"1px solid rgba(220,38,38,0.3)",
                borderRadius:"7px",fontFamily:"'Share Tech Mono',monospace",
                fontSize:"0.64rem",color:"#f87171",letterSpacing:"0.04em",lineHeight:1.5 }}>
                ⚠ {error}
              </div>
            )}
            {pendingPayload ? (
              <div style={{ padding:"12px",
                background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.35)",
                borderRadius:"7px",display:"flex",flexDirection:"column",gap:"10px" }}>
                <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.62rem",
                  color:"#fbbf24",letterSpacing:"0.04em",lineHeight:1.5 }}>
                  {existingCount.toLocaleString()} records from a previous session exist in the database.
                  Keep the existing data or clear it before activating?
                </div>
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px" }}>
                  <button onClick={()=>doActivate(pendingPayload,false)} disabled={busy} style={{
                    padding:"9px",background:"rgba(34,197,94,0.12)",
                    border:"1px solid rgba(34,197,94,0.4)",borderRadius:"6px",
                    color:"#4ade80",fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
                    fontSize:"0.78rem",letterSpacing:"0.1em",cursor:busy?"not-allowed":"pointer",
                  }}>Keep Data</button>
                  <button onClick={()=>doActivate(pendingPayload,true)} disabled={busy} style={{
                    padding:"9px",background:"rgba(239,68,68,0.12)",
                    border:"1px solid rgba(239,68,68,0.4)",borderRadius:"6px",
                    color:"#f87171",fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
                    fontSize:"0.78rem",letterSpacing:"0.1em",cursor:busy?"not-allowed":"pointer",
                  }}>Clear &amp; Start Fresh</button>
                </div>
              </div>
            ) : (
              <button onClick={activate} disabled={busy} style={{
                padding:"11px",
                background:busy?"rgba(29,107,255,0.15)":"#1d6bff",
                border:`1px solid ${busy?"rgba(29,107,255,0.3)":"#1d6bff"}`,
                borderRadius:"7px",
                color:busy?"#484f58":"#fff",
                fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
                fontSize:"0.85rem",letterSpacing:"0.14em",textTransform:"uppercase",
                cursor:busy?"not-allowed":"pointer",
                boxShadow:busy?"none":"0 4px 18px rgba(29,107,255,0.4)",
              }}>{busy?"Checking…":"Activate License"}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── LogoutModal ──────────────────────────────────────────────────────────────

function LogoutModal({ username, projectName, onConfirm, onClose, theme, busy }:{
  username:string; projectName:string;
  onConfirm:()=>void; onClose:()=>void; theme:Theme; busy:boolean;
}) {
  const isDark = theme === "dark";
  const [inputUser, setInputUser] = useState("");
  const [inputProj, setInputProj] = useState("");
  const confirmed = inputUser === username && inputProj === projectName;

  const border = CLR.border(isDark);
  const iS: React.CSSProperties = {
    width:"100%", padding:"8px 10px",
    background:isDark?"rgba(255,255,255,0.05)":"#f6f8fa",
    border:`1px solid ${border}`, borderRadius:"6px",
    color:CLR.text1(isDark), outline:"none",
    fontFamily:"'Share Tech Mono',monospace",
    fontSize:"0.75rem", letterSpacing:"0.04em",
  };
  const lS: React.CSSProperties = {
    display:"block", marginBottom:"5px",
    fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
    letterSpacing:"0.2em", textTransform:"uppercase", color:CLR.text3(isDark),
  };

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:9999,
      background:"rgba(0,0,0,0.82)", backdropFilter:"blur(6px)",
      display:"flex", alignItems:"center", justifyContent:"center", padding:"20px",
    }} onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div style={{
        width:"100%", maxWidth:"420px",
        ...glass(isDark),
        boxShadow:"0 40px 100px rgba(0,0,0,0.6), 0 0 0 1px rgba(220,38,38,0.2)",
        overflow:"hidden",
      }}>
        {/* Red danger stripe */}
        <div style={{ height:"3px", background:"linear-gradient(90deg,#ef4444,#dc2626,#b91c1c)" }}/>

        <div style={{ padding:"24px" }}>
          {/* Icon + title */}
          <div style={{ display:"flex", alignItems:"center", gap:"12px", marginBottom:"16px" }}>
            <div style={{
              width:"38px", height:"38px", borderRadius:"8px", flexShrink:0,
              background:"rgba(239,68,68,0.12)", border:"1px solid rgba(239,68,68,0.25)",
              display:"flex", alignItems:"center", justifyContent:"center",
            }}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                stroke={CLR.red} strokeWidth={2}>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
            </div>
            <div>
              <div style={{ fontFamily:"'Rajdhani',sans-serif", fontWeight:700, fontSize:"1rem",
                letterSpacing:"0.06em", color:CLR.text1(isDark) }}>Revoke License &amp; Log Out</div>
              <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.54rem",
                letterSpacing:"0.1em", color:CLR.text3(isDark), marginTop:"2px" }}>
                History data will be preserved
              </div>
            </div>
          </div>

          {/* Warning box */}
          <div style={{
            padding:"10px 12px", marginBottom:"18px",
            background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)",
            borderRadius:"6px", fontFamily:"'Share Tech Mono',monospace",
            fontSize:"0.6rem", color:CLR.red, letterSpacing:"0.04em", lineHeight:1.6,
          }}>
            To confirm, type your <strong>username</strong> and <strong>project name</strong> exactly as they appear on your license.
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:"12px", marginBottom:"20px" }}>
            <div>
              <label style={lS}>Username</label>
              <input type="text" value={inputUser} placeholder={username}
                style={iS} onChange={e=>setInputUser(e.target.value)}/>
            </div>
            <div>
              <label style={lS}>Project Name</label>
              <input type="text" value={inputProj} placeholder={projectName}
                style={iS} onChange={e=>setInputProj(e.target.value)}
                onKeyDown={e=>{ if(e.key==="Enter" && confirmed && !busy) onConfirm(); }}/>
            </div>
          </div>

          <div style={{ display:"flex", gap:"10px" }}>
            <button onClick={onClose} disabled={busy} style={{
              flex:1, padding:"0 16px", height:"36px", borderRadius:"6px",
              background:"transparent", border:`1px solid ${border}`,
              color:CLR.text2(isDark), cursor:busy?"not-allowed":"pointer",
              fontFamily:"'Rajdhani',sans-serif", fontWeight:600, fontSize:"0.78rem",
            }}>Cancel</button>
            <button onClick={onConfirm} disabled={!confirmed || busy} style={{
              flex:1, padding:"0 16px", height:"36px", borderRadius:"6px",
              background: confirmed && !busy ? CLR.red : "rgba(239,68,68,0.1)",
              border:`1px solid ${confirmed && !busy ? CLR.red : "rgba(239,68,68,0.2)"}`,
              color: confirmed && !busy ? "#fff" : "rgba(239,68,68,0.4)",
              cursor: confirmed && !busy ? "pointer" : "not-allowed",
              fontFamily:"'Rajdhani',sans-serif", fontWeight:700, fontSize:"0.78rem",
              letterSpacing:"0.08em",
              boxShadow: confirmed && !busy ? "0 4px 14px rgba(239,68,68,0.35)" : "none",
              transition:"all 0.15s ease",
            }}>{busy ? "Logging out…" : "Confirm Logout"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AuthLoadingScreen() {
  return (
    <div style={{ position:"fixed",inset:0,background:"#0f1117",
      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
      gap:"14px",zIndex:9999 }}>
      <div style={{ width:"28px",height:"28px",border:"2px solid #30363d",
        borderTop:`2px solid ${CLR.blue}`,borderRadius:"50%",
        animation:"spin 0.8s linear infinite" }}/>
      <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.56rem",
        letterSpacing:"0.28em",color:"#484f58",textTransform:"uppercase" }}>
        Verifying License…
      </span>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// ─── DiagTerminal ─────────────────────────────────────────────────────────────

interface DiagLine { direction: string; hex: string; device_name: string; ts: number; }

function DiagTerminal({ lines, onClose, isDark: _isDark }:{
  lines: DiagLine[]; onClose: ()=>void; isDark: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:"smooth"}); },[lines]);

  return (
    <div style={{
      position:"fixed", bottom:0, left:0, right:0, height:"260px", zIndex:8000,
      background:"#0d1117", borderTop:"2px solid #00ff8844",
      display:"flex", flexDirection:"column",
    }}>
      {/* Header */}
      <div style={{
        display:"flex", alignItems:"center", justifyContent:"space-between",
        padding:"6px 14px", borderBottom:"1px solid #00ff8822", flexShrink:0,
        background:"#0d1117",
      }}>
        <div style={{ display:"flex", alignItems:"center", gap:"10px" }}>
          <div style={{ width:"8px",height:"8px",borderRadius:"50%",
            background:"#00ff88", boxShadow:"0 0 6px #00ff88",
            animation:"pulse-dot 1.5s ease-in-out infinite" }}/>
          <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.6rem",
            letterSpacing:"0.2em",color:"#00ff88",textTransform:"uppercase" }}>
            RAW MODBUS DIAGNOSTICS
          </span>
          <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.52rem",
            color:"#3d4a5e",letterSpacing:"0.1em" }}>
            {lines.length} frames
          </span>
        </div>
        <button onClick={onClose} style={{
          background:"none",border:"1px solid #00ff8833",borderRadius:"4px",
          color:"#00ff8888",cursor:"pointer",
          fontFamily:"'Share Tech Mono',monospace",fontSize:"0.56rem",
          padding:"3px 10px",letterSpacing:"0.1em",
        }}>CLOSE ✕</button>
      </div>

      {/* Log */}
      <div style={{
        flex:1, overflowY:"auto", padding:"8px 14px",
        fontFamily:"'Share Tech Mono',monospace", fontSize:"0.62rem",
      }}>
        {lines.length === 0 ? (
          <span style={{ color:"#3d4a5e",letterSpacing:"0.14em" }}>Waiting for frames…</span>
        ) : lines.map((l,i)=>{
          const c = l.direction==="TX" ? "#60a5fa" : l.direction==="RX" ? "#00ff88" : "#ef4444";
          const ts = new Date(l.ts).toLocaleTimeString("en-GB",{hour12:false});
          return (
            <div key={i} style={{ lineHeight:"1.7", color:"#94a3b8" }}>
              <span style={{ color:"#3d4a5e" }}>[{ts}] </span>
              <span style={{ color:"#475569" }}>{l.device_name.slice(0,16).padEnd(16)} </span>
              <span style={{ color:c, fontWeight:700 }}>{l.direction === "TX" ? "►" : "◄"} {l.direction} </span>
              <span style={{ color:c+"cc" }}>{l.hex}</span>
            </div>
          );
        })}
        <div ref={bottomRef}/>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [authState,         setAuthState]         = useState<AuthState|null>(null);
  const [checkingAuth,      setCheckingAuth]       = useState(true);
  const [profiles,          setProfiles]           = useState<MeterProfile[]>([]);
  const [configuredDevices, setConfiguredDevices]  = useState<DeviceConfig[]>([]);
  const [showModal,         setShowModal]          = useState(false);
  const [showLogout,        setShowLogout]         = useState(false);
  const [logoutBusy,        setLogoutBusy]         = useState(false);
  const [timeRange,         setTimeRange]          = useState<number|null>(null);
  const [activeTab,         setActiveTab]          = useState<string>("");
  // latestByDevice: device_name → MeterReading
  const [latestByDevice,    setLatestByDevice]     = useState<Record<string,MeterReading>>({});
  // historyByDevice: device_name → ChartPoint[]
  const [historyByDevice,   setHistoryByDevice]    = useState<Record<string,ChartPoint[]>>({});
  const [lastPollMs,        setLastPollMs]         = useState(0);
  const [pollState,         setPollState]          = useState<PollState>("stopped");
  const [theme,             setTheme]              = useState<Theme>("dark");
  const [exportStatus,      setExportStatus]       = useState<ExportStatus>("idle");
  const [toast,             setToast]              = useState<ToastState>(
    {message:"",type:"success",visible:false}
  );
  const [showTerminal,      setShowTerminal]       = useState(false);
  const [diagLines,         setDiagLines]          = useState<DiagLine[]>([]);
  // Default false — safe offline assumption until backend confirms cloud build.
  const [isCloudBuild,      setIsCloudBuild]       = useState(false);

  const toastRef  = useRef<ReturnType<typeof setTimeout>|null>(null);
  const exportRef = useRef<ReturnType<typeof setTimeout>|null>(null);

  const isDark = theme === "dark";

  useEffect(()=>{ document.documentElement.setAttribute("data-theme",theme); },[theme]);
  useEffect(()=>{
    document.body.style.background = CLR.bgPage(isDark);
  },[isDark]);

  const showToast = useCallback((message:string, type:ToastState["type"])=>{
    if(toastRef.current)clearTimeout(toastRef.current);
    setToast({message,type,visible:true});
    toastRef.current=setTimeout(()=>setToast(t=>({...t,visible:false})),4000);
  },[]);

  // ── Build type + Auth (parallel on startup) ───────────────────────────────
  useEffect(()=>{
    invokeApi<BuildInfo>("get_build_info")
      .then(b => setIsCloudBuild(b.is_cloud_build))
      .catch(() => setIsCloudBuild(false)); // fail-safe: treat unknown as air-gapped
    invokeApi<AuthState>("get_auth_state")
      .then(a=>{setAuthState(a);setCheckingAuth(false);})
      .catch(()=>{setAuthState({valid:false,allowed_meters:[]});setCheckingAuth(false);});
  },[]);

  useEffect(()=>{
    if(!authState?.valid)return;
    invokeApi<PollState>("get_status").then(setPollState).catch(console.error);
    if(authState.allowed_meters.length>0){
      invokeApi<MeterProfile[]>("get_meter_profiles",{allowedMeters:authState.allowed_meters})
        .then(setProfiles)
        .catch(e=>showToast(`Failed to load profiles: ${e}`,"error"));
    }
    // Restore persisted bus config (devices + alarm thresholds) from SQLite.
    invokeApi<DeviceConfig[]>("get_saved_bus_config")
      .then(devices=>{
        if(devices.length>0){
          setConfiguredDevices(devices);
          setActiveTab(t=>t||devices[0].device_name);
          // Populate charts with previous-session readings immediately.
          Promise.all(
            devices.map(d=>
              invokeApi<MeterReading[]>("get_recent_history",{deviceName:d.device_name,limit:60})
                .catch(()=>[] as MeterReading[])
            )
          ).then(results=>{
            const histPatch: Record<string,ChartPoint[]>  = {};
            const latestPatch: Record<string,MeterReading> = {};
            devices.forEach((d,i)=>{
              const rows=results[i];
              if(!rows.length)return;
              histPatch[d.device_name]=rows.map(r=>({
                time:new Date(r.timestamp_ms).toLocaleTimeString("en-GB",{hour12:false}),
                ...r.data,
              }));
              latestPatch[d.device_name]=rows[rows.length-1];
            });
            if(Object.keys(histPatch).length){
              setHistoryByDevice(prev=>({...prev,...histPatch}));
              setLatestByDevice(prev=>({...prev,...latestPatch}));
            }
          });
        }
      })
      .catch(console.error);
  },[authState?.valid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Web-client mirror sync ────────────────────────────────────────────────
  // When running in a browser (phone/tablet), pull a snapshot of the current
  // desktop state and then keep it live via WebSocket.
  useEffect(()=>{
    if(isTauri || !authState?.valid) return;

    const base = `http://${window.location.hostname}:3030`;

    // Initial snapshot: configured devices + poll state.
    fetch(`${base}/api/status`, { method:"POST", headers:{"Content-Type":"application/json"}, body:"{}" })
      .then(r=>r.json())
      .then((data:{configured_devices:DeviceConfig[];poll_state:PollState})=>{
        if(data.configured_devices?.length){
          setConfiguredDevices(data.configured_devices);
          setActiveTab(data.configured_devices[0].device_name);
        }
        if(data.poll_state) setPollState(data.poll_state);
      })
      .catch(e=>console.warn("[mirror] status fetch failed:", e));

    // WebSocket: receive STATE_CHANGE broadcasts from the host machine.
    const ws = new WebSocket(`ws://${window.location.hostname}:3030/ws`);
    ws.onopen    = ()  => console.log("[mirror] WebSocket connected");
    ws.onmessage = (ev)=> {
      try {
        const msg = JSON.parse(ev.data) as {
          type: string;
          configured_devices?: DeviceConfig[];
          poll_state?: PollState;
          device_name?: string;
          device_id?: string;
          timestamp_ms?: number;
          data?: Record<string, number>;
        };
        if(msg.type === "STATE_CHANGE"){
          if(msg.configured_devices){
            setConfiguredDevices(msg.configured_devices);
            if(msg.configured_devices.length) setActiveTab(t=>t||msg.configured_devices![0].device_name);
          }
          if(msg.poll_state) setPollState(msg.poll_state);
        } else if(msg.type === "METER_DATA" && msg.device_name && msg.data){
          const r: MeterReading = {
            device_name: msg.device_name,
            device_id: msg.device_id ?? "",
            timestamp_ms: msg.timestamp_ms ?? Date.now(),
            data: msg.data,
          };
          setLastPollMs(r.timestamp_ms);
          setLatestByDevice(prev=>({...prev,[r.device_name]:r}));
          const time=new Date(r.timestamp_ms).toLocaleTimeString("en-GB",{hour12:false});
          setHistoryByDevice(prev=>{
            const old=prev[r.device_name]??[];
            const next=[...old];
            if(next.length>0&&next[next.length-1].time===time)
              next[next.length-1]={...next[next.length-1],...r.data};
            else next.push({time,...r.data});
            return {...prev,[r.device_name]:next.length>MAX_HISTORY?next.slice(-MAX_HISTORY):next};
          });
        }
      } catch { /* ignore malformed frames */ }
    };
    ws.onerror = (e)=> console.warn("[mirror] WebSocket error:", e);

    return ()=>{ ws.close(); };
  },[isTauri, authState?.valid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Events ────────────────────────────────────────────────────────────────
  useEffect(()=>{
    if(!authState?.valid)return;
    const subs:Promise<UnlistenFn>[]=[];

    subs.push(listenApi<MeterReading>("meter-data",e=>{
      const r=e.payload;
      setLastPollMs(r.timestamp_ms);
      setLatestByDevice(prev=>({...prev,[r.device_name]:r}));
      const time=new Date(r.timestamp_ms).toLocaleTimeString("en-GB",{hour12:false});
      setHistoryByDevice(prev=>{
        const old=prev[r.device_name]??[];
        const next=[...old];
        if(next.length>0&&next[next.length-1].time===time)
          next[next.length-1]={...next[next.length-1],...r.data};
        else next.push({time,...r.data});
        return {...prev,[r.device_name]:next.length>MAX_HISTORY?next.slice(-MAX_HISTORY):next};
      });
    }));
    subs.push(listenApi<StatusEvent>("status-changed",e=>setPollState(e.payload.state)));
    subs.push(listenApi<FaultEvent>("meter-fault",e=>
      showToast(`⚠ ${e.payload.device_name}: ${e.payload.reason}`,"warn")));
    subs.push(listenApi<DiagEvent>("diag-frame", e=>{
      const p = e.payload;
      setDiagLines(prev=>{
        const line: DiagLine = { direction:p.direction, hex:p.hex, device_name:p.device_name, ts:p.timestamp_ms };
        const next = [...prev, line];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }));

    return ()=>{subs.forEach(p=>p.then(fn=>fn()));};
  },[authState?.valid,showToast]);

  // ── Save bus config ───────────────────────────────────────────────────────
  const handleSaveBusConfig = useCallback(async (devices:DeviceConfig[])=>{
    try {
      const confirmed = await invokeApi<DeviceConfig[]>("apply_bus_config",{devices});
      setConfiguredDevices(confirmed);
      // Auto-select first tab
      if(confirmed.length>0)setActiveTab(confirmed[0].device_name);
      setShowModal(false);
      setLatestByDevice({});
      setHistoryByDevice({});
      const totalRegs=confirmed.reduce((s,d)=>s+d.selected_registers.length,0);
      showToast(`${confirmed.length} device${confirmed.length>1?"s":""} configured · ${totalRegs} registers`,"success");
    } catch(e){showToast(`Config error: ${e}`,"error");}
  },[showToast]);

  // ── Poll toggle ───────────────────────────────────────────────────────────
  const handleTogglePoll = useCallback(async ()=>{
    if(configuredDevices.length===0){showToast("Configure bus devices first.","warn");return;}
    try {
      const s=await invokeApi<PollState>("toggle_polling",{});
      setPollState(s);
      showToast(s==="running"
        ?`Polling ${configuredDevices.length} device(s)`
        :"Polling stopped",
        s==="running"?"success":"warn");
    } catch(e){showToast(`Error: ${e}`,"error");}
  },[configuredDevices,showToast]);

  // ── Clear ─────────────────────────────────────────────────────────────────
  const handleClear = useCallback(async ()=>{
    try {
      const n=await invokeApi<number>("clear_history");
      setLatestByDevice({});setHistoryByDevice({});
      showToast(`Cleared ${n.toLocaleString()} records`,"warn");
    } catch(e){showToast(`Clear failed: ${e}`,"error");}
  },[showToast]);

  // ── Export ────────────────────────────────────────────────────────────────
  const handleExport = useCallback(async (target:string|null)=>{
    const rangeLabel = timeRange === null       ? "all"
                     : timeRange <= 300         ? "live"
                     : timeRange <= 3600        ? "1h"
                     : timeRange <= 86400       ? "24h"
                     :                           "7d";
    const dateSuffix = new Date().toISOString().slice(0,10);
    const defaultName = target
      ? `${target.replace(/\s+/g,"_")}_${rangeLabel}_${dateSuffix}.xlsx`
      : `technidaq_all_${rangeLabel}_${dateSuffix}.xlsx`;
    try {
      setExportStatus("saving");
      if (!isTauri) { setExportStatus("error"); setTimeout(()=>setExportStatus("idle"),2500); return; }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const fp = await save({
        title: target ? `Export — ${target}` : "Export All Meters",
        defaultPath: defaultName,
        filters:[{name:"Excel Workbook",extensions:["xlsx"]}],
      });
      if(!fp){setExportStatus("idle");return;}
      const n = await invokeApi<number>("export_to_excel",{
        path:              fp,
        targetDevice:      target ?? null,
        timeRangeSeconds:  timeRange ?? null,
        username:          authState?.username  ?? "",
        projectName:       authState?.project_name ?? "",
      });
      setExportStatus("success");
      showToast(`Exported ${n.toLocaleString()} records${target?` — ${target}`:""}`, "success");
      if(exportRef.current)clearTimeout(exportRef.current);
      exportRef.current=setTimeout(()=>setExportStatus("idle"),2500);
    } catch(e){
      setExportStatus("error");
      showToast(`Export failed: ${e}`,"error");
      if(exportRef.current)clearTimeout(exportRef.current);
      exportRef.current=setTimeout(()=>setExportStatus("idle"),3000);
    }
  },[timeRange, authState, showToast]);

  // ── Logout ────────────────────────────────────────────────────────────────
  const handleLogout = useCallback(async ()=>{
    setLogoutBusy(true);
    try {
      await invokeApi("logout_user");
      // Reset all runtime state — history intentionally preserved in DB
      setAuthState({valid:false, allowed_meters:[]});
      setConfiguredDevices([]);
      setProfiles([]);
      setLatestByDevice({});
      setHistoryByDevice({});
      setActiveTab("");
      setPollState("stopped");
      setShowLogout(false);
    } catch(e){
      showToast(`Logout failed: ${e}`,"error");
    } finally {
      setLogoutBusy(false);
    }
  },[showToast]);

  // ── Simulation flag ───────────────────────────────────────────────────────
  const isSimulation = authState?.allowed_meters.includes("Simulation") ?? false;

  // ── Diagnostics flag ──────────────────────────────────────────────────────
  const hasDiagnostics = authState?.allowed_meters.includes("Diagnostics") ?? false;

  // ── Cloud / advanced telemetry flag ───────────────────────────────────────
  // Requires online mode AND tier 2 or higher.
  const isCloudEnabled = authState?.mode === "online" && (authState?.tier ?? 1) >= 2;

  // ── Enable/disable diagnostics when terminal is toggled ───────────────────
  useEffect(()=>{
    if (!authState?.valid) return;
    invokeApi("set_diagnostics_enabled", { enabled: showTerminal }).catch(console.error);
  }, [showTerminal, authState?.valid]);

  // ── Active tab device ─────────────────────────────────────────────────────
  const activeDevice = configuredDevices.find(d=>d.device_name===activeTab);
  const activeTabIdx = configuredDevices.findIndex(d=>d.device_name===activeTab);
  const tabAccent    = TAB_ACCENTS[activeTabIdx >= 0 ? activeTabIdx % TAB_ACCENTS.length : 0];

  const activeLatest  = activeTab ? (latestByDevice[activeTab]?.data??{}) : {};
  const activeHistory = activeTab ? (historyByDevice[activeTab]??[])        : [];

  // Chart keys: pick 1 voltage + 1 power from active tab's registers
  const chartKeys = useMemo(()=>{
    if(!activeDevice)return [];
    const names = activeDevice.selected_registers.map(r=>r.name);
    const vk = names.find(n=>n.toLowerCase().includes("voltage l-l avg"))
            ?? names.find(n=>n.toLowerCase().includes("voltage l-n"))
            ?? names.find(n=>n.toLowerCase().includes("voltage"));
    const pk = names.find(n=>n.toLowerCase().includes("active power total"))
            ?? names.find(n=>n.toLowerCase().includes("active power"));
    return ([vk,pk].filter(Boolean) as string[]).slice(0,2);
  },[activeDevice]);

  // ── Guards ────────────────────────────────────────────────────────────────
  if (checkingAuth)      return <AuthLoadingScreen/>;
  if (!authState?.valid) return <LicenseGateway onActivated={setAuthState}/>;

  return (
    <div className="tdaq-page" style={{
      display:"flex", flexDirection:"column", height:"100vh", overflow:"hidden",
    }}>
      <Toast {...toast}/>

      {showModal && (
        <DeviceSetupModal
          profiles={profiles}
          initialDevices={configuredDevices}
          onSave={handleSaveBusConfig}
          onClose={()=>setShowModal(false)}
          theme={theme}
          licensedProtocols={authState?.protocols}
          isCloudEnabled={isCloudEnabled}
          isCloudBuild={isCloudBuild}
        />
      )}

      {showLogout && (
        <LogoutModal
          username={authState?.username??""}
          projectName={authState?.project_name??""}
          onConfirm={handleLogout}
          onClose={()=>setShowLogout(false)}
          theme={theme}
          busy={logoutBusy}
        />
      )}

      <AppHeader
        pollState={pollState} lastPollMs={lastPollMs} theme={theme}
        onThemeToggle={()=>setTheme(t=>t==="dark"?"light":"dark")}
        onTogglePoll={handleTogglePoll} onClear={handleClear}
        onExport={handleExport} exportStatus={exportStatus}
        username={authState?.username??""}
        projectName={authState?.project_name??""}
        onLogout={()=>setShowLogout(true)}
        configuredDevices={configuredDevices}
        activeDeviceName={activeDevice?.device_name}
        isSimulation={isSimulation}
        onOpenTerminal={()=>setShowTerminal(t=>!t)}
        hasDiagnostics={hasDiagnostics}
        licenseMode={authState?.mode}
        licenseTier={authState?.tier}
        isCloudBuild={isCloudBuild}
        cloudRegistered={authState?.cloud_registered}
      />

      <BusBar
        configuredDevices={configuredDevices}
        pollState={pollState}
        onOpenModal={()=>setShowModal(true)}
        isDark={isDark}
      />

      <DeviceTabBar
        devices={configuredDevices}
        activeTab={activeTab}
        onSelect={setActiveTab}
        pollState={pollState}
        isDark={isDark}
      />

      {/* ── Main scrollable content ─────────────────────────────────────── */}
      <main style={{
        flex:"1 1 0", overflowY:"auto", padding:"20px",
        display:"flex", flexDirection:"column", gap:"16px",
      }}>

        {configuredDevices.length === 0 ? (
          /* ── No devices empty state ──────────────────────────────────── */
          <div style={{
            flex:1, display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            <div style={{ textAlign:"center" }}>
              <div style={{ width:56,height:56,background:CLR.blue+"18",
                border:`1px solid ${CLR.blue}30`,borderRadius:"14px",
                display:"flex",alignItems:"center",justifyContent:"center",
                margin:"0 auto 16px" }}>
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none"
                  stroke={CLR.blue} strokeWidth={1.5}>
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
                </svg>
              </div>
              <div style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"1.1rem",
                color:CLR.text1(isDark),letterSpacing:"0.04em",marginBottom:"6px" }}>
                No Bus Configured
              </div>
              <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.62rem",
                color:CLR.text3(isDark),letterSpacing:"0.1em",marginBottom:"20px" }}>
                Add your RS485 devices to begin monitoring
              </div>
              <button onClick={()=>setShowModal(true)} style={{
                padding:"10px 24px",background:CLR.blue,border:`1px solid ${CLR.blue}`,
                borderRadius:"7px",color:"#fff",cursor:"pointer",
                fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
                fontSize:"0.82rem",letterSpacing:"0.1em",
                boxShadow:`0 4px 14px ${CLR.blue}44`,
              }}>Configure Bus →</button>
            </div>
          </div>

        ) : activeDevice ? (
          <>
            {/* ── Section header ──────────────────────────────────────── */}
            <div style={{ display:"flex",alignItems:"center",gap:"10px" }}>
              <div style={{ width:"3px",height:"18px",borderRadius:"2px",background:tabAccent }}/>
              <span style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
                fontSize:"0.82rem",letterSpacing:"0.14em",textTransform:"uppercase",
                color:CLR.text1(isDark) }}>
                {activeDevice.device_name}
              </span>
              <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.58rem",
                color:CLR.text3(isDark),letterSpacing:"0.06em" }}>
                {activeDevice.meter_model.replace(/_/g," ")} · Slave {activeDevice.slave_id}
                · {activeDevice.poll_rate_ms/1000}s · {activeDevice.selected_registers.length} registers
              </span>
              <div style={{ flex:1,height:"1px",background:CLR.border(isDark) }}/>
            </div>

            {/* ── Metric cards: auto-fill, stretch to full width ───────── */}
            <div style={{
              display:"grid",
              gridTemplateColumns:"repeat(auto-fill, minmax(160px, 1fr))",
              gap:"10px",
            }}>
              {activeDevice.selected_registers.map((reg,i)=>{
                const sparkData = activeHistory.map(pt=>typeof pt[reg.name]==="number" ? pt[reg.name] as number : NaN)
                                               .filter(v=>!isNaN(v)).slice(-20);
                return (
                  <MetricCard
                    key={reg.name} name={reg.name}
                    value={activeLatest[reg.name]}
                    idx={i} isDark={isDark}
                    sparkData={sparkData}
                    minAlarm={reg.min_alarm}
                    maxAlarm={reg.max_alarm}
                  />
                );
              })}
            </div>

            {/* ── Timeframe selector ───────────────────────────────────── */}
            {(()=>{
              const ranges:[string, number|null][] = [
                ["Live",    300],
                ["1 Hour",  3600],
                ["24 Hours",86400],
                ["7 Days",  604800],
                ["All",     null],
              ];
              const rangeLabel = ranges.find(([,v])=>v===timeRange)?.[0] ?? "All";
              return (
                <div style={{
                  display:"flex", alignItems:"center", gap:"6px",
                  ...glass(isDark), padding:"6px 10px", flexShrink:0,
                }}>
                  <span style={{
                    fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
                    letterSpacing:"0.2em", textTransform:"uppercase",
                    color:CLR.text3(isDark), marginRight:"4px", whiteSpace:"nowrap",
                  }}>Export Range</span>
                  {ranges.map(([label, val])=>{
                    const active = val === timeRange;
                    return (
                      <button key={label} onClick={()=>setTimeRange(val)} style={{
                        padding:"3px 12px", height:"26px",
                        borderRadius:"5px",
                        background: active ? tabAccent+"22" : "transparent",
                        border:`1px solid ${active ? tabAccent+"66" : CLR.border(isDark)}`,
                        color: active ? tabAccent : CLR.text2(isDark),
                        fontFamily:"'Rajdhani',sans-serif",
                        fontWeight: active ? 700 : 500,
                        fontSize:"0.72rem", letterSpacing:"0.06em",
                        cursor:"pointer", whiteSpace:"nowrap",
                        transition:"all 0.12s ease",
                      }}>{label}</button>
                    );
                  })}
                  <div style={{ flex:1 }}/>
                  <span style={{
                    fontFamily:"'Share Tech Mono',monospace", fontSize:"0.54rem",
                    letterSpacing:"0.1em", color:CLR.text3(isDark),
                  }}>
                    Export will use: <span style={{ color:tabAccent }}>{rangeLabel}</span>
                  </span>
                </div>
              );
            })()}

            {/* ── Waveform chart ────────────────────────────────────────── */}
            <WaveformChart
              history={activeHistory}
              chartKeys={chartKeys}
              pollState={pollState}
              tabAccent={tabAccent}
              isDark={isDark}
            />
          </>

        ) : (
          /* ── Tab selected but activeDevice not found (shouldn't happen) */
          <div style={{ textAlign:"center",padding:"40px",
            fontFamily:"'Share Tech Mono',monospace",fontSize:"0.64rem",
            color:CLR.text3(isDark),letterSpacing:"0.14em" }}>
            Select a device tab above
          </div>
        )}

        {/* ── Status bar ─────────────────────────────────────────────────── */}
        <div style={{
          display:"flex",alignItems:"center",gap:"0",
          ...glass(isDark),
          overflow:"hidden",
          flexShrink:0,
        }}>
          {[
            {label:"Device",  value:activeDevice?.device_name??"—"},
            {label:"Protocol",   value:isSimulation?"SIM":activeDevice?.protocol?.toUpperCase()??"—",
              color:isSimulation?CLR.amber:undefined},
            {label:"Connection", value:isSimulation?"—":activeDevice
              ? (activeDevice.protocol==="tcp"
                  ? `${activeDevice.ip_address}:${activeDevice.tcp_port}`
                  : `${activeDevice.com_port} / ${activeDevice.baud_rate}`)
              : "—"},
            {label:"Engine",  value:isSimulation&&pollState==="running"?"SIMULATION":pollState.toUpperCase(),
              color:isSimulation&&pollState==="running"?CLR.amber:pollState==="running"?CLR.green:pollState==="fault"?CLR.red:CLR.text3(isDark)},
          ].map(({label,value,color},i,arr)=>(
            <div key={label} style={{
              flex:1,padding:"8px 14px",
              borderRight:i<arr.length-1?`1px solid ${CLR.border(isDark)}`:"none",
            }}>
              <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.5rem",
                letterSpacing:"0.2em",textTransform:"uppercase",color:CLR.text3(isDark),
                marginBottom:"3px" }}>{label}</div>
              <div style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
                fontSize:"0.85rem",letterSpacing:"0.05em",
                color:color??CLR.text1(isDark) }}>{value}</div>
            </div>
          ))}
        </div>

      </main>

      {showTerminal && (
        <DiagTerminal lines={diagLines} onClose={()=>setShowTerminal(false)} isDark={isDark}/>
      )}
    </div>
  );
}