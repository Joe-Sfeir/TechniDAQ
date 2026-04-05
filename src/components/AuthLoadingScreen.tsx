export default function AuthLoadingScreen() {
  return (
    <div style={{ position:"fixed",inset:0,background:"#0f1117",
      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
      gap:"14px",zIndex:9999 }}>
      <div style={{ width:"28px",height:"28px",border:"2px solid #30363d",
        borderTop:`2px solid #1a5fff`,borderRadius:"50%",
        animation:"spin 0.8s linear infinite" }}/>
      <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.56rem",
        letterSpacing:"0.28em",color:"#484f58",textTransform:"uppercase" }}>
        Verifying License…
      </span>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
