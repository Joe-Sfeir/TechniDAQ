import { useState } from "react";
import logoUrl from "../assets/logo.png";
import { invokeApi } from "../api";
import type { AuthState } from "../types";

// ─── License Gateway ──────────────────────────────────────────────────────────

export default function LicenseGateway({ onActivated }:{ onActivated:(auth:AuthState)=>void }) {
  const [key,      setKey]      = useState("");
  const [username, setUsername] = useState("");
  const [project,  setProject]  = useState("");
  const [error,    setError]    = useState<string|null>(null);
  const [busy,     setBusy]     = useState(false);
  const [focused,  setFocused]  = useState<string|null>(null);
  const [pendingPayload, setPendingPayload] = useState<{key:string;username:string;projectName:string}|null>(null);
  const [existingCount,  setExistingCount]  = useState(0);

  const doActivate = async (payload:{key:string;username:string;projectName:string}, clearHistory:boolean) => {
    setBusy(true);
    setPendingPayload(null);
    try {
      if(clearHistory) await invokeApi("clear_history");
      await invokeApi<string>("activate_license", payload);
      const auth = await invokeApi<AuthState>("get_auth_state");
      onActivated(auth);
    } catch(e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const activate = async () => {
    setError(null);
    if(!key.trim())     {setError("License key is required.");return;}
    if(!username.trim()){setError("Username is required.");return;}
    if(!project.trim()) {setError("Project name is required.");return;}
    setBusy(true);
    try {
      const payload = { key: key.trim(), username: username.trim(), projectName: project.trim() };
      const count = await invokeApi<number>("get_record_count");
      if(count > 0){
        setPendingPayload(payload);
        setExistingCount(count);
        setBusy(false);
        return;
      }
      await doActivate(payload, false);
    } catch(e) { setError(String(e)); setBusy(false); }
  };

  const iS = (f:string): React.CSSProperties => ({
    width:"100%", padding:"12px 14px",
    background:"rgba(0,0,0,0.4)",
    border:`1px solid ${focused===f ? "#1a5fff" : "#222222"}`,
    borderRadius:"10px", color:"#ffffff", outline:"none",
    fontFamily:f==="key"?"'Share Tech Mono',monospace":"'Rajdhani',sans-serif",
    fontSize:f==="key"?"0.72rem":"0.95rem", fontWeight:f==="key"?400:600,
    letterSpacing:f==="key"?"0.06em":"0.04em",
    boxShadow:focused===f?"0 0 0 3px rgba(26,95,255,0.2)":"none",
    transition:"border-color 0.2s, box-shadow 0.2s",
  });

  return (
    <div style={{
      position:"fixed", inset:0, background:"#050505",
      backgroundImage:"radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px)",
      backgroundSize:"24px 24px",
      display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999,
    }}>
      <div style={{
        width:"100%", maxWidth:460,
        background:"#111111", border:"1px solid #222222",
        borderRadius:"20px", boxShadow:"0 24px 80px rgba(0,0,0,0.5)",
        overflow:"hidden", position:"relative",
      }}>
        {/* Accent gradient overlay */}
        <div style={{
          position:"absolute", inset:0, pointerEvents:"none",
          background:"linear-gradient(135deg, rgba(26,95,255,0.08) 0%, transparent 60%)",
          borderRadius:"20px",
        }}/>
        <div style={{ padding:"36px", position:"relative" }}>
          {/* Brand */}
          <div style={{ display:"flex", alignItems:"center", gap:"14px", marginBottom:"32px" }}>
            <div style={{
              width:44, height:44, borderRadius:"12px",
              background:"#1a5fff",
              display:"flex", alignItems:"center", justifyContent:"center",
              flexShrink:0, boxShadow:"0 0 20px rgba(26,95,255,0.4)",
            }}>
              <img src={logoUrl} alt="Technicat Group" style={{ width:28, height:28, objectFit:"contain" }}/>
            </div>
            <div>
              <div style={{ fontFamily:"'Rajdhani',sans-serif", fontWeight:800, fontSize:"1.1rem",
                letterSpacing:"0.06em", color:"#ffffff", lineHeight:1 }}>TechniDAQ</div>
              <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.48rem",
                letterSpacing:"0.16em", color:"#52525b", marginTop:"3px", textTransform:"uppercase" }}>
                License Activation
              </div>
            </div>
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:"16px" }}>
            <div>
              <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"10px",
                letterSpacing:"0.12em", color:"#52525b", textTransform:"uppercase",
                fontWeight:700, marginBottom:"8px" }}>
                License Key
              </div>
              <textarea rows={3} value={key} placeholder="Paste your license key…"
                style={{ ...iS("key"), resize:"none", lineHeight:1.6 }}
                onChange={e=>{setKey(e.target.value);setError(null);}}
                onFocus={()=>setFocused("key")} onBlur={()=>setFocused(null)}
                onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();activate();}}}/>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"12px" }}>
              {(["user","proj"] as const).map(f=>(
                <div key={f}>
                  <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"10px",
                    letterSpacing:"0.12em", color:"#52525b", textTransform:"uppercase",
                    fontWeight:700, marginBottom:"8px" }}>
                    {f==="user"?"Username":"Project"}
                  </div>
                  <input type="text"
                    placeholder={f==="user"?"john.smith":"Site Alpha"}
                    style={iS(f)}
                    value={f==="user"?username:project}
                    onChange={e=>{f==="user"?setUsername(e.target.value):setProject(e.target.value);setError(null);}}
                    onFocus={()=>setFocused(f)} onBlur={()=>setFocused(null)}
                    onKeyDown={e=>{if(e.key==="Enter")activate();}}/>
                </div>
              ))}
            </div>
            {error&&(
              <div style={{ padding:"12px 14px",
                background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.2)",
                borderRadius:"10px", fontFamily:"'Share Tech Mono',monospace",
                fontSize:"0.62rem", color:"#ef4444", letterSpacing:"0.04em", lineHeight:1.5 }}>
                ⚠ {error}
              </div>
            )}
            {pendingPayload ? (
              <div style={{ padding:"14px",
                background:"rgba(245,158,11,0.08)", border:"1px solid rgba(245,158,11,0.2)",
                borderRadius:"10px", display:"flex", flexDirection:"column", gap:"12px" }}>
                <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.62rem",
                  color:"#f59e0b", letterSpacing:"0.04em", lineHeight:1.5 }}>
                  {existingCount.toLocaleString()} records from a previous session exist in the database.
                  Keep the existing data or clear it before activating?
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px" }}>
                  <button onClick={()=>doActivate(pendingPayload,false)} disabled={busy} style={{
                    padding:"10px", background:"rgba(16,185,129,0.1)",
                    border:"1px solid rgba(16,185,129,0.3)", borderRadius:"8px",
                    color:"#10b981", fontFamily:"'Rajdhani',sans-serif", fontWeight:700,
                    fontSize:"0.78rem", letterSpacing:"0.1em", cursor:busy?"not-allowed":"pointer",
                  }}>Keep Data</button>
                  <button onClick={()=>doActivate(pendingPayload,true)} disabled={busy} style={{
                    padding:"10px", background:"rgba(239,68,68,0.1)",
                    border:"1px solid rgba(239,68,68,0.3)", borderRadius:"8px",
                    color:"#ef4444", fontFamily:"'Rajdhani',sans-serif", fontWeight:700,
                    fontSize:"0.78rem", letterSpacing:"0.1em", cursor:busy?"not-allowed":"pointer",
                  }}>Clear &amp; Start Fresh</button>
                </div>
              </div>
            ) : (
              <button onClick={activate} disabled={busy} style={{
                padding:"13px",
                background:busy?"rgba(26,95,255,0.2)":"#1a5fff",
                border:`1px solid ${busy?"rgba(26,95,255,0.3)":"#1a5fff"}`,
                borderRadius:"10px",
                color:busy?"#52525b":"#fff",
                fontFamily:"'Rajdhani',sans-serif", fontWeight:700,
                fontSize:"0.88rem", letterSpacing:"0.14em", textTransform:"uppercase",
                cursor:busy?"not-allowed":"pointer",
                boxShadow:busy?"none":"0 4px 20px rgba(26,95,255,0.4)",
              }}>{busy?"Checking…":"Activate License"}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
