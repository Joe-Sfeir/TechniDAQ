import { TAB_ACCENTS, DARK_THEME, LIGHT_THEME, CLR } from "../theme";
import type { DeviceConfig, PollState } from "../types";

// ─── DeviceTabBar ─────────────────────────────────────────────────────────────

export default function DeviceTabBar({ devices, activeTab, onSelect, pollState, isDark }:{
  devices:DeviceConfig[]; activeTab:string; onSelect:(n:string)=>void;
  pollState:PollState; isDark:boolean;
}) {
  if (devices.length === 0) return null;
  return (
    <div style={{
      display:"flex", alignItems:"center", gap:"4px",
      padding:"0 20px",
      height:"48px",
      background:isDark ? DARK_THEME.sidebar : LIGHT_THEME.sidebar,
      borderBottom:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
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
              ? `1px solid ${isDark ? DARK_THEME.accent+"30" : LIGHT_THEME.accent+"30"}`
              : "1px solid transparent",
            borderRadius:"8px",
            background: isActive
              ? (isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim)
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
                ? (isFault ? CLR.red : isLive ? accent : isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2)
                : isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
              boxShadow: isActive && isLive && !isFault ? `0 0 7px ${accent}` : "none",
              animation: isActive && isLive && !isFault ? "pulse-dot 2s ease-in-out infinite" : "none",
            }}/>
            {/* Name */}
            <span style={{
              fontFamily:"'Rajdhani',sans-serif",
              fontWeight: isActive ? 700 : 500,
              fontSize:"0.83rem", letterSpacing:"0.04em",
              color: isActive ? isDark ? DARK_THEME.text : LIGHT_THEME.text : isDark ? DARK_THEME.muted : LIGHT_THEME.muted,
            }}>{dev.device_name||`Device ${i+1}`}</span>
            {/* Slave ID pill */}
            <span style={{
              fontFamily:"'Share Tech Mono',monospace", fontSize:"0.54rem",
              letterSpacing:"0.08em",
              color: isActive ? accent : isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
              padding:"1px 6px", borderRadius:"20px",
              border:`1px solid ${isActive ? accent+"40" : isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
              background: isActive ? accent+"10" : "transparent",
            }}>S{dev.slave_id}</span>
          </button>
        );
      })}
    </div>
  );
}
