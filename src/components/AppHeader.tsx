import { useEffect } from "react";
import logoUrl from "../assets/logo.png";
import { DOT_GRID_CSS } from "../theme";
import type { DeviceConfig, PollState, Theme, ExportStatus, OnlineAuthState } from "../types";
import ExportDropdown from "./ExportDropdown";
import { Play, Square, RotateCcw, Trash2, Terminal, Sun, Moon, LogOut } from "lucide-react";

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
  
  // Status logic
  let statusColorClass = "bg-zinc-500 text-zinc-500 border-zinc-500/40 bg-zinc-500/10";
  let statusDotClass = "bg-zinc-500 shadow-none";
  let statusLabel = "STOPPED";

  if (isFault) {
    statusColorClass = "bg-red-500/10 text-red-500 border-red-500/40";
    statusDotClass = "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,1)]";
    statusLabel = "FAULT";
  } else if (isRunning && isSimulation) {
    statusColorClass = "bg-amber-500/10 text-amber-500 border-amber-500/40";
    statusDotClass = "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,1)]";
    statusLabel = "SIMULATION";
  } else if (isRunning) {
    statusColorClass = "bg-emerald-500/10 text-emerald-500 border-emerald-500/40";
    statusDotClass = "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,1)]";
    statusLabel = "LIVE";
  }

  // Inject dot-grid + keyframes once
  useEffect(()=>{
    if (document.getElementById("tdaq-global-css")) return;
    const el = document.createElement("style");
    el.id = "tdaq-global-css";
    el.textContent = DOT_GRID_CSS;
    document.head.appendChild(el);
  },[]);

  return (
    <header className="flex items-center gap-4 px-5 h-[58px] shrink-0 relative z-10 bg-white/80 dark:bg-[#0a0a0a]/80 backdrop-blur-md border-b border-zinc-200 dark:border-white/10">
      
      {/* Brand */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="w-9 h-9 bg-[#1a5fff] rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(26,95,255,0.4)]">
          <img src={logoUrl} alt="Technicat Group" className="w-6 h-6 object-contain" />
        </div>
        <div>
          <div className="font-bold text-[1.05rem] tracking-[0.06em] text-zinc-900 dark:text-white leading-none uppercase">
            TechniDAQ
          </div>
          <div className="font-mono text-[0.5rem] tracking-[0.14em] text-zinc-500 dark:text-zinc-400 leading-relaxed uppercase">
            {isCloudBuild && onlineAuthState?.valid
              ? `${onlineAuthState.node_name} · ${onlineAuthState.project_name}`
              : username ? `${username} · ${projectName||"Technicat Group"}` : (projectName||"by Technicat Group")}
          </div>
        </div>
      </div>

      {/* Edition / license badge */}
      {!isCloudBuild ? (
        <div className="shrink-0 flex items-center px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/10 font-mono text-[0.48rem] tracking-[0.14em] uppercase text-amber-600 dark:text-amber-400 whitespace-nowrap">
          AIR-GAPPED EDITION
        </div>
      ) : onlineOffline ? (
        <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded border border-amber-500/40 bg-amber-500/10 font-mono text-[0.48rem] tracking-[0.14em] uppercase text-amber-600 dark:text-amber-400 whitespace-nowrap">
          <span>● OFFLINE</span>
          <span className="opacity-50">·</span>
          <span>USING CACHED CONFIG</span>
        </div>
      ) : onlineAuthState?.valid ? (
        <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#1a5fff]/40 bg-[#1a5fff]/10 font-mono text-[0.48rem] tracking-[0.14em] uppercase text-[#1a5fff] whitespace-nowrap">
          <span className="text-emerald-500">●</span>
          <span>ONLINE</span>
          <span className="opacity-50">·</span>
          <span>TIER {onlineAuthState.tier}</span>
        </div>
      ) : licenseMode ? (
        <div className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded border font-mono text-[0.48rem] tracking-[0.14em] uppercase whitespace-nowrap ${licenseMode==="online" && (licenseTier??1)>=2 ? "border-[#1a5fff]/40 bg-[#1a5fff]/10 text-[#1a5fff]" : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"}`}>
          <span>{licenseMode==="offline" ? "AIR-GAPPED" : "ONLINE"}</span>
          <span className="opacity-50">·</span>
          <span>TIER {licenseTier??1}</span>
          {licenseMode === "online" && cloudRegistered && (
            <>
              <span className="opacity-50">·</span>
              <span className="text-emerald-500">● SYNCED</span>
            </>
          )}
        </div>
      ) : null}

      {/* Device summary */}
      <div className="flex-1 min-w-0">
        <div className="font-mono text-[0.62rem] tracking-[0.08em] text-zinc-500 dark:text-zinc-400 overflow-hidden text-ellipsis whitespace-nowrap">
          {configuredDevices.length>0
            ? configuredDevices.map(d=>`${d.device_name} [S${d.slave_id}·${d.poll_rate_ms/1000}s]`).join("  ·  ")
            : "No devices configured — click Configure Bus"}
        </div>
      </div>

      {/* Right controls */}
      <div className="flex items-center gap-3 shrink-0">
        
        {/* Last poll */}
        <div className="text-right">
          <div className="font-mono text-[0.5rem] tracking-[0.14em] text-zinc-500 dark:text-zinc-400 uppercase">Last Poll</div>
          <div className="font-mono text-[0.7rem] text-zinc-900 dark:text-white">{timeStr}</div>
        </div>

        <div className="w-px h-7 bg-zinc-200 dark:bg-white/10" />

        {/* Status */}
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${statusDotClass}`} />
          <span className={`font-mono text-[0.6rem] tracking-[0.12em] font-bold px-2.5 py-0.5 rounded-full border ${statusColorClass}`}>
            {statusLabel}
          </span>
        </div>

        <div className="w-px h-7 bg-zinc-200 dark:bg-white/10" />
        
        {isSimulation && (
          <>
            <div className="flex items-center gap-1.5 px-2.5 h-7 bg-amber-500/10 border border-amber-500/40 rounded-md">
              <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500 shadow-[0_0_5px_rgba(245,158,11,1)] animate-pulse" />
              <span className="font-mono text-[0.56rem] tracking-[0.14em] text-amber-500 uppercase">
                No Hardware
              </span>
            </div>
            <div className="w-px h-7 bg-zinc-200 dark:bg-white/10" />
          </>
        )}

        {/* Poll toggle */}
        <button 
          onClick={onTogglePoll} 
          className={`flex items-center gap-1.5 px-3.5 h-8 rounded-lg font-bold text-[0.78rem] tracking-[0.08em] uppercase transition-all ${
            isRunning || isFault 
              ? "bg-red-500/10 border border-red-500/40 text-red-500 hover:bg-red-500/20" 
              : "bg-[#1a5fff] border border-[#1a5fff] text-white shadow-[0_2px_8px_rgba(26,95,255,0.3)] hover:bg-blue-600"
          }`}
        >
          {isRunning ? <Square className="w-3.5 h-3.5 fill-current" /> : isFault ? <RotateCcw className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
          {isRunning ? "Stop" : isFault ? "Reset" : "Start"}
        </button>

        <button 
          onClick={onClear} 
          className="flex items-center gap-1.5 px-3 h-8 bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg text-zinc-600 dark:text-zinc-400 font-semibold text-[0.75rem] tracking-[0.06em] hover:bg-zinc-200 dark:hover:bg-white/10 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Clear
        </button>

        <ExportDropdown activeDeviceName={activeDeviceName} exportStatus={exportStatus} onExport={onExport} isDark={isDark}/>

        {hasDiagnostics && (
          <>
            <div className="w-px h-7 bg-zinc-200 dark:bg-white/10" />
            <button 
              onClick={onOpenTerminal} 
              className="flex items-center gap-1.5 px-3 h-8 bg-emerald-500/10 border border-emerald-500/30 rounded-md text-emerald-500 font-mono text-[0.65rem] tracking-[0.1em] hover:bg-emerald-500/20 transition-colors"
            >
              <Terminal className="w-3.5 h-3.5" />
              TERMINAL
            </button>
          </>
        )}

        <button 
          onClick={onThemeToggle} 
          className="flex items-center justify-center px-2.5 h-8 bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-white/10 transition-colors"
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        <div className="w-px h-7 bg-zinc-200 dark:bg-white/10" />

        {/* Logout */}
        <button 
          onClick={onLogout} 
          title="Revoke license & log out" 
          className="flex items-center gap-1.5 px-2.5 h-8 bg-red-500/10 border border-red-500/30 rounded-lg text-red-500 font-semibold text-[0.72rem] tracking-[0.06em] hover:bg-red-500/20 transition-colors"
        >
          <LogOut className="w-3.5 h-3.5" />
          Log Out
        </button>
      </div>
    </header>
  );
}