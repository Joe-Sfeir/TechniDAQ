import { useState } from "react";
import { COM_PORTS } from "../constants";
import { DARK_THEME, LIGHT_THEME, CLR } from "../theme";

// ─── ComPortSelector ─────────────────────────────────────────────────────────

export default function ComPortSelector({ value, onChange, disabled, isDark }:{
  value:string; onChange:(v:string)=>void; disabled:boolean; isDark:boolean;
}) {
  const [isCustom, setIsCustom] = useState(false);
  const base: React.CSSProperties = {
    height:"30px", background:isDark ? DARK_THEME.surface : LIGHT_THEME.surface,
    border:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,borderRadius:"5px",
    color:isDark ? DARK_THEME.text : LIGHT_THEME.text,outline:"none",
    fontFamily:"'Share Tech Mono',monospace",fontSize:"0.7rem",letterSpacing:"0.06em",
    padding:"0 8px",
  };
  return (
    <div style={{ display:"flex",alignItems:"center",gap:"6px" }}>
      <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.52rem",
        letterSpacing:"0.2em",color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,textTransform:"uppercase" }}>PORT</span>
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
        background:disabled?CLR.green:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
        boxShadow:disabled?`0 0 5px ${CLR.green}`:"none" }}/>
    </div>
  );
}
