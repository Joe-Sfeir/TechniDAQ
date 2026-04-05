import { useState, useEffect, useMemo } from "react";
import {
  ResponsiveContainer, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import { regPalette, LINE_COLORS, glass, DARK_THEME, LIGHT_THEME } from "../theme";
import { MAX_HISTORY } from "../constants";
import type { ChartPoint, PollState, ViewMode } from "../types";

// ─── WaveformChart ────────────────────────────────────────────────────────────

export default function WaveformChart({ history, chartKeys, pollState, tabAccent, isDark }:{
  history:ChartPoint[]; chartKeys:string[]; pollState:PollState;
  tabAccent:string; isDark:boolean;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("chart");
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(()=>new Set(chartKeys));
  // Keep in sync when chartKeys changes
  useEffect(()=>setVisibleKeys(new Set(chartKeys)), [chartKeys.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const stopped   = pollState === "stopped";
  const gridColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)";
  const axisTick  = isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2;

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
        stroke={isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2} strokeWidth={1.5}>
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
      <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.65rem",
        letterSpacing:"0.2em", color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2, textTransform:"uppercase" }}>
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
        padding:"12px 16px", borderBottom:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
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
            color:isDark ? DARK_THEME.text : LIGHT_THEME.text }}>Real-Time Waveform</span>
          <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.58rem",
            color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2 }}>{history.length}/{MAX_HISTORY}pts</span>
        </div>

        {/* Right: view toggle + legend + live badge */}
        <div style={{ display:"flex", alignItems:"center", gap:"10px" }}>

          {/* ── View mode toggle ── */}
          <div style={{
            display:"flex", borderRadius:"6px", overflow:"hidden",
            border:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
          }}>
            {(["chart","grid"] as ViewMode[]).map((mode)=>{
              const active = viewMode === mode;
              return (
                <button key={mode} onClick={()=>setViewMode(mode)} style={{
                  padding:"3px 10px", height:"26px",
                  background: active
                    ? (isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim)
                    : "transparent",
                  border:"none",
                  borderRight: mode==="chart" ? `1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}` : "none",
                  cursor:"pointer",
                  display:"flex", alignItems:"center", gap:"5px",
                  color: active ? isDark ? DARK_THEME.text : LIGHT_THEME.text : isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
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
                color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted, maxWidth:"120px",
                overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{k}</span>
            </div>
          ))}

          {/* Live badge */}
          <span style={{
            padding:"2px 8px", borderRadius:"4px",
            fontFamily:"'Share Tech Mono',monospace", fontSize:"0.56rem", letterSpacing:"0.12em",
            background: stopped ? isDark ? "#1a1a1a" : "#f1f5f9" : tabAccent+"20",
            color:      stopped ? isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2     : tabAccent,
            border:     `1px solid ${stopped ? isDark ? "#1a1a1a" : "#f1f5f9" : tabAccent+"44"}`,
          }}>{stopped?"PAUSED":"LIVE"}</span>
        </div>
      </div>

      {/* Waveform line toggles */}
      {viewMode === "chart" && chartKeys.length > 0 && (
        <div style={{
          display:"flex", alignItems:"center", gap:"6px", flexWrap:"wrap",
          padding:"6px 16px", borderBottom:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
          flexShrink:0,
        }}>
          <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
            letterSpacing:"0.18em", textTransform:"uppercase", color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2, marginRight:"2px" }}>
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
                border: `1px solid ${on ? c+"88" : isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
                color: on ? c : isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
                fontFamily:"'Share Tech Mono',monospace", fontSize:"0.56rem",
                letterSpacing:"0.06em", cursor:"pointer",
                display:"flex", alignItems:"center", gap:"5px",
                transition:"all 0.12s",
              }}>
                <div style={{ width:"8px", height:"8px", borderRadius:"50%",
                  background: on ? c : isDark ? "#1a1a1a" : "#f1f5f9", flexShrink:0 }}/>
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
                  axisLine={{ stroke:isDark ? DARK_THEME.border : LIGHT_THEME.border }} tickLine={false}
                  interval="preserveStartEnd" minTickGap={60}/>
                {chartKeys.length > 0 && (
                  <YAxis yAxisId="l" orientation="left"
                    tick={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, fill:axisTick }}
                    axisLine={false} tickLine={false} width={56}
                    tickFormatter={(v:number)=>v.toFixed(1)}/>
                )}
                <Tooltip contentStyle={{
                  background:   isDark ? DARK_THEME.surface : LIGHT_THEME.surface,
                  border:       `1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
                  borderRadius: "6px", padding:"8px 12px",
                  fontFamily:   "'Share Tech Mono',monospace",
                  fontSize:     "0.66rem", color:isDark ? DARK_THEME.text : LIGHT_THEME.text,
                  boxShadow:    "0 4px 16px rgba(0,0,0,0.3)",
                }} cursor={{ stroke:isDark ? "#1a1a1a" : "#f1f5f9", strokeWidth:1, strokeDasharray:"4 4" }}/>
                <Legend wrapperStyle={{ display:"none" }}/>
                {chartKeys.filter(k=>visibleKeys.has(k)).map((k,i)=>(
                  <Line key={k} yAxisId="l" type="monotone" dataKey={k}
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
                  background: isDark ? DARK_THEME.sidebar : LIGHT_THEME.bg,
                  borderBottom:`2px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
                }}>
                  <th style={{
                    padding:"8px 14px", textAlign:"left", whiteSpace:"nowrap",
                    fontWeight:700, letterSpacing:"0.14em", textTransform:"uppercase",
                    fontSize:"0.54rem", color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
                    borderRight:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
                    minWidth:"92px",
                  }}>Timestamp</th>
                  {gridKeys.map(k => {
                    const p = regPalette(k, 0);
                    return (
                      <th key={k} style={{
                        padding:"8px 10px", textAlign:"right", whiteSpace:"nowrap",
                        fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase",
                        fontSize:"0.52rem", color:p.border,
                        borderRight:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
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
                        color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted,
                        borderRight:`1px solid ${isDark ? "#1a1a1a" : "#f1f5f9"}`,
                        borderBottom:`1px solid ${isDark ? "#1a1a1a" : "#f1f5f9"}`,
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
                            color: isNaN(num) ? isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2 : p.value,
                            borderRight:`1px solid ${isDark ? "#1a1a1a" : "#f1f5f9"}`,
                            borderBottom:`1px solid ${isDark ? "#1a1a1a" : "#f1f5f9"}`,
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
