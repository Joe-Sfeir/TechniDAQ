import { useState } from "react";
import { glass, CLR, DARK_THEME, LIGHT_THEME } from "../theme";
import type { Theme } from "../types";

// ─── LogoutModal ──────────────────────────────────────────────────────────────

export default function LogoutModal({ username, projectName, onConfirm, onClose, theme, busy }:{
  username:string; projectName:string;
  onConfirm:()=>void; onClose:()=>void; theme:Theme; busy:boolean;
}) {
  const isDark = theme === "dark";
  const [inputUser, setInputUser] = useState("");
  const [inputProj, setInputProj] = useState("");
  const confirmed = inputUser === username && inputProj === projectName;

  const border = isDark ? DARK_THEME.border : LIGHT_THEME.border;
  const iS: React.CSSProperties = {
    width:"100%", padding:"8px 10px",
    background:isDark ? DARK_THEME.surface : LIGHT_THEME.surface,
    border:`1px solid ${border}`, borderRadius:"6px",
    color:isDark ? DARK_THEME.text : LIGHT_THEME.text, outline:"none",
    fontFamily:"'Share Tech Mono',monospace",
    fontSize:"0.75rem", letterSpacing:"0.04em",
  };
  const lS: React.CSSProperties = {
    display:"block", marginBottom:"5px",
    fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
    letterSpacing:"0.2em", textTransform:"uppercase", color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
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
                letterSpacing:"0.06em", color:isDark ? DARK_THEME.text : LIGHT_THEME.text }}>Revoke License &amp; Log Out</div>
              <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.54rem",
                letterSpacing:"0.1em", color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2, marginTop:"2px" }}>
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
              color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted, cursor:busy?"not-allowed":"pointer",
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
