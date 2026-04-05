import { useRef, useEffect } from "react";

// ─── DiagTerminal ─────────────────────────────────────────────────────────────

export interface DiagLine { direction: string; hex: string; device_name: string; ts: number; }

export default function DiagTerminal({ lines, onClose, isDark: _isDark }:{
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
