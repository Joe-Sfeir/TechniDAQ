import { useState, useRef, useEffect } from "react";
import { DARK_THEME, LIGHT_THEME, CLR } from "../theme";
import type { ExportStatus } from "../types";

// ─── ExportDropdown ───────────────────────────────────────────────────────────

export default function ExportDropdown({ activeDeviceName, exportStatus, onExport, isDark }:{
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
  const labelColor = exportStatus==="success"?CLR.green : exportStatus==="error"?CLR.red : isDark ? DARK_THEME.muted : LIGHT_THEME.muted;

  const btnBase: React.CSSProperties = {
    height:"34px", background:isDark ? DARK_THEME.surface : LIGHT_THEME.surface,
    border:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
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
          style={{ ...btnBase, padding:"0 8px", borderRadius:"0 6px 6px 0", color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted }}>
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
          background:isDark ? DARK_THEME.surface : LIGHT_THEME.surface,
          border:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
          borderRadius:"8px", boxShadow:"0 8px 32px rgba(0,0,0,0.3)",
          zIndex:500, overflow:"hidden",
        }}>
          <div style={{ padding:"6px 12px", borderBottom:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
            fontFamily:"'Share Tech Mono',monospace", fontSize:"0.52rem",
            letterSpacing:"0.18em", textTransform:"uppercase", color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2 }}>
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
              onMouseEnter={e=>{if(!opt.disabled)(e.currentTarget as HTMLElement).style.background=isDark ? DARK_THEME.bg : LIGHT_THEME.bg;}}
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
                  fontSize:"0.78rem", color:isDark ? DARK_THEME.text : LIGHT_THEME.text }}>{opt.label}</div>
                <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.56rem",
                  color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2, letterSpacing:"0.04em",
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
