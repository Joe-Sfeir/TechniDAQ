import { useEffect } from "react";
import logoUrl from "../assets/logo.png";
import { DARK_THEME, LIGHT_THEME, CLR, DOT_GRID_CSS } from "../theme";
import type { DeviceConfig, PollState, Theme, ExportStatus, OnlineAuthState } from "../types";
import ExportDropdown from "./ExportDropdown";

// ─── AppHeader ────────────────────────────────────────────────────────────────

export default function AppHeader({
  pollState, lastPollMs, theme, onThemeToggle, onTogglePoll,
  onClear, onExport, exportStatus,
  username, projectName, onLogout, configuredDevices, activeDeviceName,
  isSimulation, onOpenTerminal, hasDiagnostics,
  licenseMode, licenseTier, isCloudBuild, cloudRegistered,
  onlineAuthState, onlineOffline,
}:{
  pollState:PollState; lastPollMs:number; theme:Theme;
  onThemeToggle:()=>void; onTogglePoll:()=>void;
  onClear:()=>void; onExport:(t:string|null)=>void; exportStatus:ExportStatus;
  username:string; projectName:string; onLogout:()=>void;
  configuredDevices:DeviceConfig[]; activeDeviceName:string|undefined;
  isSimulation:boolean; onOpenTerminal: ()=>void; hasDiagnostics: boolean;
  licenseMode?: "offline" | "online"; licenseTier?: 1 | 2 | 3;
  isCloudBuild: boolean; cloudRegistered?: boolean;
  onlineAuthState?: OnlineAuthState|null; onlineOffline?: boolean;
}) {
  const isDark    = theme === "dark";
  const isRunning = pollState === "running";
  const isFault   = pollState === "fault";
  const timeStr   = lastPollMs > 0
    ? new Date(lastPollMs).toLocaleTimeString("en-GB",{hour12:false}) : "--:--:--";
  const statusColor = isFault ? CLR.red
    : isRunning && isSimulation ? CLR.amber
    : isRunning ? CLR.green
    : isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2;
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
      background:isDark ? DARK_THEME.sidebar : LIGHT_THEME.sidebar,
      borderBottom:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
      position:"relative", zIndex:10,
    }}>
      {/* Brand */}
      <div style={{ display:"flex",alignItems:"center",gap:"10px",flexShrink:0 }}>
        <img src={logoUrl} alt="Technicat Group" style={{ width:"36px",height:"36px",objectFit:"contain" }} />
        <div>
          <div style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:800,fontSize:"1.05rem",
            letterSpacing:"0.06em",color:isDark ? DARK_THEME.text : LIGHT_THEME.text,lineHeight:1 }}>TechniDAQ</div>
          <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.5rem",
            letterSpacing:"0.14em",color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,lineHeight:1.5 }}>
            {isCloudBuild && onlineAuthState?.valid
              ? `${onlineAuthState.node_name} · ${onlineAuthState.project_name}`
              : username ? `${username} · ${projectName||"Technicat Group"}` : (projectName||"by Technicat Group")}
          </div>
        </div>
      </div>

      {/* Edition / license badge — hard-branched on build type */}
      {!isCloudBuild ? (
        // Air-gapped binary: static label baked at compile time
        <div style={{
          flexShrink:0, display:"flex", alignItems:"center",
          padding:"3px 9px", borderRadius:"4px",
          border:`1px solid ${isDark ? DARK_THEME.amberBdr : LIGHT_THEME.amberBdr}`,
          background:isDark ? DARK_THEME.amberBg : LIGHT_THEME.amberBg,
          fontFamily:"'Share Tech Mono',monospace", fontSize:"0.48rem",
          letterSpacing:"0.14em", textTransform:"uppercase",
          color:isDark ? DARK_THEME.amber : LIGHT_THEME.amber, whiteSpace:"nowrap",
        }}>
          AIR-GAPPED EDITION
        </div>
      ) : onlineOffline ? (
        // Cloud binary — no network, running on cached config
        <div style={{
          flexShrink:0, display:"flex", alignItems:"center",
          padding:"3px 9px", borderRadius:"4px",
          border:`1px solid ${isDark ? DARK_THEME.amberBdr : LIGHT_THEME.amberBdr}`,
          background:isDark ? DARK_THEME.amberBg : LIGHT_THEME.amberBg,
          fontFamily:"'Share Tech Mono',monospace", fontSize:"0.48rem",
          letterSpacing:"0.14em", textTransform:"uppercase",
          color:isDark ? DARK_THEME.amber : LIGHT_THEME.amber, gap:"5px", whiteSpace:"nowrap",
        }}>
          <span>&#9679; OFFLINE</span>
          <span style={{ opacity:0.5 }}>·</span>
          <span>USING CACHED CONFIG</span>
        </div>
      ) : onlineAuthState?.valid ? (
        // Cloud binary — active online auth
        <div style={{
          flexShrink:0, display:"flex", alignItems:"center",
          padding:"3px 9px", borderRadius:"4px",
          border:`1px solid ${isDark ? DARK_THEME.accent+"40" : LIGHT_THEME.accent+"40"}`,
          background:isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim,
          fontFamily:"'Share Tech Mono',monospace", fontSize:"0.48rem",
          letterSpacing:"0.14em", textTransform:"uppercase",
          color:isDark ? DARK_THEME.accent : LIGHT_THEME.accent, gap:"5px", whiteSpace:"nowrap",
        }}>
          <span style={{ color:isDark ? DARK_THEME.green : LIGHT_THEME.green }}>&#9679;</span>
          <span>ONLINE</span>
          <span style={{ opacity:0.5 }}>·</span>
          <span>TIER {onlineAuthState.tier}</span>
        </div>
      ) : licenseMode ? (
        // Cloud binary — legacy encrypted-key license (offline/online mode)
        <div style={{
          flexShrink:0, display:"flex", alignItems:"center",
          padding:"3px 9px", borderRadius:"4px",
          border:`1px solid ${licenseMode==="online" && (licenseTier??1)>=2 ? (isDark ? DARK_THEME.accent+"40" : LIGHT_THEME.accent+"40") : (isDark ? DARK_THEME.amberBdr : LIGHT_THEME.amberBdr)}`,
          background:licenseMode==="online" && (licenseTier??1)>=2 ? (isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim) : (isDark ? DARK_THEME.amberBg : LIGHT_THEME.amberBg),
          fontFamily:"'Share Tech Mono',monospace", fontSize:"0.48rem",
          letterSpacing:"0.14em", textTransform:"uppercase",
          color:licenseMode==="online" && (licenseTier??1)>=2 ? (isDark ? DARK_THEME.accent : LIGHT_THEME.accent) : (isDark ? DARK_THEME.amber : LIGHT_THEME.amber),
          gap:"5px", whiteSpace:"nowrap",
        }}>
          <span>{licenseMode==="offline" ? "AIR-GAPPED" : "ONLINE"}</span>
          <span style={{ opacity:0.5 }}>·</span>
          <span>TIER {licenseTier??1}</span>
          {licenseMode === "online" && cloudRegistered && (
            <>
              <span style={{ opacity:0.5 }}>·</span>
              <span style={{ color: isDark ? DARK_THEME.green : LIGHT_THEME.green }}>&#9679; SYNCED</span>
            </>
          )}
        </div>
      ) : null}

      {/* Device summary */}
      <div style={{ flex:1,minWidth:0 }}>
        <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.62rem",
          letterSpacing:"0.08em",color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted,
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
            letterSpacing:"0.14em",color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,textTransform:"uppercase" }}>Last Poll</div>
          <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.7rem",
            color:isDark ? DARK_THEME.text : LIGHT_THEME.text }}>{timeStr}</div>
        </div>

        <div style={{ width:"1px",height:"28px",background:isDark ? DARK_THEME.border : LIGHT_THEME.border }}/>

        {/* Status */}
        <div style={{ display:"flex",alignItems:"center",gap:"6px" }}>
          <div style={{ width:"8px",height:"8px",borderRadius:"50%",
            background:statusColor,
            boxShadow:isRunning?`0 0 8px ${statusColor}`:"none" }}/>
          <span style={{
            fontFamily:"'Share Tech Mono',monospace",fontSize:"0.6rem",
            letterSpacing:"0.12em",fontWeight:700,color:statusColor,
            padding:"2px 10px",borderRadius:"20px",
            background:`${statusColor}15`,
            border:`1px solid ${statusColor}44`,
          }}>{statusLabel}</span>
        </div>

        <div style={{ width:"1px",height:"28px",background:isDark ? DARK_THEME.border : LIGHT_THEME.border }}/>
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
        <div style={{ width:"1px",height:"28px",background:isDark ? DARK_THEME.border : LIGHT_THEME.border }}/>

        {/* Poll toggle */}
        <button onClick={onTogglePoll} style={{
          display:"flex",alignItems:"center",gap:"6px",
          padding:"0 14px",height:"34px",
          background: isRunning||isFault ? (isDark ? DARK_THEME.dangerBg : LIGHT_THEME.dangerBg) : (isDark ? DARK_THEME.accent : LIGHT_THEME.accent),
          border:`1px solid ${isRunning||isFault ? (isDark ? DARK_THEME.dangerBdr : LIGHT_THEME.dangerBdr) : (isDark ? DARK_THEME.accent : LIGHT_THEME.accent)}`,
          borderRadius:"8px",
          color:isRunning||isFault ? (isDark ? DARK_THEME.danger : LIGHT_THEME.danger) : "#fff",
          fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
          fontSize:"0.78rem",letterSpacing:"0.08em",
          cursor:"pointer",
          boxShadow:isRunning||isFault?"none":`0 2px 8px ${isDark ? DARK_THEME.accent : LIGHT_THEME.accent}44`,
        }}>
          {isRunning
            ?<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            :<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>}
          {isRunning?"Stop":isFault?"Reset":"Start"}
        </button>

        <button onClick={onClear} style={{
          display:"flex",alignItems:"center",gap:"6px",
          padding:"0 12px",height:"34px",
          background:isDark ? DARK_THEME.surface : LIGHT_THEME.surface,
          border:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,borderRadius:"8px",
          color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted,fontFamily:"'Rajdhani',sans-serif",
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
            <div style={{ width:"1px",height:"28px",background:isDark ? DARK_THEME.border : LIGHT_THEME.border }}/>
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
          background:isDark ? DARK_THEME.surface : LIGHT_THEME.surface,
          border:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,borderRadius:"8px",
          color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted,cursor:"pointer",
          display:"flex",alignItems:"center",
        }}>
          {theme==="dark"
            ?<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/></svg>
            :<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>}
        </button>

        <div style={{ width:"1px",height:"28px",background:isDark ? DARK_THEME.border : LIGHT_THEME.border }}/>

        {/* Logout */}
        <button onClick={onLogout} title="Revoke license &amp; log out" style={{
          display:"flex",alignItems:"center",gap:"5px",
          padding:"0 10px",height:"34px",
          background:isDark ? DARK_THEME.dangerBg : LIGHT_THEME.dangerBg,
          border:`1px solid ${isDark ? DARK_THEME.dangerBdr : LIGHT_THEME.dangerBdr}`,borderRadius:"8px",
          color:isDark ? DARK_THEME.danger : LIGHT_THEME.danger,cursor:"pointer",
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
