// ─── Toast ────────────────────────────────────────────────────────────────────

export interface ToastState { message:string; type:"success"|"error"|"warn"; visible:boolean }

export default function Toast({ message, type, visible }:ToastState) {
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
