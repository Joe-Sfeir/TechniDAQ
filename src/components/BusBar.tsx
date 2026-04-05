import { TAB_ACCENTS, DARK_THEME, LIGHT_THEME } from "../theme";
import type { DeviceConfig } from "../types";

// ─── BusBar ───────────────────────────────────────────────────────────────────

export default function BusBar({ configuredDevices, onOpenModal, isDark }:{
  configuredDevices:DeviceConfig[];
  onOpenModal:()=>void; isDark:boolean;
}) {
  return (
    <div style={{
      display:"flex",alignItems:"center",gap:"10px",
      padding:"0 20px",height:"38px",flexShrink:0,
      background: isDark ? DARK_THEME.sidebar : LIGHT_THEME.sidebar,
      borderBottom:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
    }}>
      <button onClick={onOpenModal} style={{
        display:"flex",alignItems:"center",gap:"6px",
        padding:"0 12px",height:"26px",
        background:isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim,
        border:`1px solid ${isDark ? DARK_THEME.accent+"50" : LIGHT_THEME.accent+"50"}`,
        borderRadius:"6px",
        color:isDark ? DARK_THEME.accent : LIGHT_THEME.accent,
        fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
        fontSize:"0.7rem",letterSpacing:"0.1em",textTransform:"uppercase",
        cursor:"pointer",opacity:1,
      }}>
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
        </svg>
        Configure Bus
      </button>
      {configuredDevices.length>0 && (
        <>
          <span style={{ color:isDark ? DARK_THEME.border : LIGHT_THEME.border,fontSize:"0.8rem" }}>|</span>
          {configuredDevices.map((d,i)=>(
            <div key={d.device_name} style={{ display:"flex",alignItems:"center",gap:"5px" }}>
              <div style={{ width:"5px",height:"5px",borderRadius:"50%",
                background:TAB_ACCENTS[i%TAB_ACCENTS.length] }}/>
              <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.58rem",
                color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted,letterSpacing:"0.05em" }}>
                {d.device_name} · S{d.slave_id} · {d.poll_rate_ms/1000}s
              </span>
            </div>
          ))}
          <span style={{ marginLeft:"auto",fontFamily:"'Share Tech Mono',monospace",
            fontSize:"0.54rem",color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2 }}>
            {configuredDevices.reduce((s,d)=>s+d.selected_registers.length,0)} registers total
          </span>
        </>
      )}
    </div>
  );
}
