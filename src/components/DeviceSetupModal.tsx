import { useState, useEffect, useMemo } from "react";
import { TAB_ACCENTS, glass, CLR, DARK_THEME, LIGHT_THEME } from "../theme";
import { DATA_TYPES, DEFAULT_DEVICE } from "../constants";
import { invokeApi, isTauri } from "../api";
import type { DeviceConfig, MeterProfile, RegisterEntry, Theme } from "../types";
import ComPortSelector from "./ComPortSelector";

// ─── DevicePanel (accordion in modal) ────────────────────────────────────────

interface CustomRegDraft {
  name:string;address:string;length:string;data_type:string;multiplier:string;
}
const EMPTY_DRAFT:CustomRegDraft = {name:"",address:"",length:"2",data_type:"Float32",multiplier:"1.0"};

function DevicePanel({ device,index,profiles,isDark,onUpdate,onRemove,licensedProtocols,fieldErrors }:{
  device:DeviceConfig; index:number; profiles:MeterProfile[]; isDark:boolean;
  onUpdate:(d:DeviceConfig)=>void; onRemove:()=>void;
  licensedProtocols?: "RTU" | "TCP" | "All";
  fieldErrors?: Set<string>;
}) {
  const [expanded,  setExpanded]  = useState(index===0);
  useEffect(()=>{ if(fieldErrors && fieldErrors.size>0) setExpanded(true); },[fieldErrors]);
  const [search,    setSearch]    = useState("");
  const [checked,   setChecked]   = useState<Set<string>>(
    ()=>new Set(device.selected_registers.map(r=>r.name))
  );
  const [customRegs,setCustomRegs]= useState<RegisterEntry[]>(()=>{
    const profileNames = new Set(
      (profiles.find(p=>p.model===device.meter_model)?.registers??[]).map(r=>r.name)
    );
    return device.selected_registers.filter(r=>!profileNames.has(r.name));
  });
  const [draft,     setDraft]     = useState<CustomRegDraft>(EMPTY_DRAFT);
  const [draftErr,  setDraftErr]  = useState<string|null>(null);
  const [alarms,    setAlarms]    = useState<Record<string, {min?:string, max?:string}>>(()=>{
    const init: Record<string, {min?:string, max?:string}> = {};
    for (const r of device.selected_registers) {
      if (r.min_alarm !== undefined || r.max_alarm !== undefined) {
        init[r.name] = {
          min: r.min_alarm !== undefined ? String(r.min_alarm) : undefined,
          max: r.max_alarm !== undefined ? String(r.max_alarm) : undefined,
        };
      }
    }
    return init;
  });

  const profile     = profiles.find(p=>p.model===device.meter_model);
  const profileRegs = profile?.registers??[];

  const filtered = useMemo(()=>{
    const q=search.toLowerCase();
    return profileRegs.filter(r=>r.name.toLowerCase().includes(q)||String(r.address).includes(q));
  },[profileRegs,search]);
  const filteredCustom = customRegs.filter(r=>r.name.toLowerCase().includes(search.toLowerCase()));

  const allNames = [...filtered.map(r=>r.name),...filteredCustom.map(r=>r.name)];
  const allOn    = allNames.length>0 && allNames.every(n=>checked.has(n));

  useEffect(()=>{
    // Guard: if the profile hasn't loaded yet but the device already has saved
    // registers, skip the update — otherwise we'd wipe the saved selection.
    if(profileRegs.length===0 && device.selected_registers.length>0) return;
    const regs = [...profileRegs,...customRegs].filter(r=>checked.has(r.name)).map(r=>({
      ...r,
      min_alarm: alarms[r.name]?.min !== undefined && alarms[r.name]!.min !== "" ? parseFloat(alarms[r.name]!.min!) : undefined,
      max_alarm: alarms[r.name]?.max !== undefined && alarms[r.name]!.max !== "" ? parseFloat(alarms[r.name]!.max!) : undefined,
    }));
    onUpdate({...device,selected_registers:regs});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[checked,customRegs,alarms]);

  const toggleReg = (name:string) =>
    setChecked(prev=>{const s=new Set(prev);s.has(name)?s.delete(name):s.add(name);return s;});

  const handleModelChange = (model:string) => {
    const np=profiles.find(p=>p.model===model);
    setChecked(new Set((np?.registers??[]).map(r=>r.name)));
    setCustomRegs([]);
    onUpdate({...device,meter_model:model,selected_registers:np?.registers??[],
      baud_rate:np?.baud_rate??device.baud_rate});
  };

  const addCustom = () => {
    setDraftErr(null);
    if(!draft.name.trim()){setDraftErr("Name required");return;}
    const addr=parseInt(draft.address,10);
    if(isNaN(addr)||addr<0||addr>65535){setDraftErr("Address 0–65535");return;}
    const len=parseInt(draft.length,10);
    if(![1,2,4].includes(len)){setDraftErr("Length must be 1, 2, or 4");return;}
    const mult=parseFloat(draft.multiplier);
    if(isNaN(mult)){setDraftErr("Multiplier must be a number");return;}
    if(customRegs.some(r=>r.name===draft.name.trim())){setDraftErr("Name already used");return;}
    const nr:RegisterEntry={name:draft.name.trim(),address:addr,length:len,data_type:draft.data_type,multiplier:mult};
    setCustomRegs(p=>[...p,nr]);
    setChecked(p=>new Set([...p,nr.name]));
    setDraft(EMPTY_DRAFT);
  };

  const accent   = TAB_ACCENTS[index%TAB_ACCENTS.length];
  const border   = isDark ? DARK_THEME.border : LIGHT_THEME.border;
  // Poll rate shown in seconds
  const pollSecs = device.poll_rate_ms/1000;

  const iS: React.CSSProperties = {
    height:"32px",background:isDark?"rgba(255,255,255,0.04)":"#fff",
    border:`1px solid ${border}`,borderRadius:"5px",
    color:isDark ? DARK_THEME.text : LIGHT_THEME.text,fontFamily:"'Share Tech Mono',monospace",
    fontSize:"0.7rem",letterSpacing:"0.04em",outline:"none",padding:"0 8px",width:"100%",
  };
  const fe = (field:string): React.CSSProperties =>
    fieldErrors?.has(field) ? {border:`1px solid ${CLR.red}`} : {};
  const lS: React.CSSProperties = {
    display:"block",marginBottom:"4px",
    fontFamily:"'Share Tech Mono',monospace",fontSize:"0.5rem",
    letterSpacing:"0.2em",textTransform:"uppercase",color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
  };
  const selCount = [...profileRegs,...customRegs].filter(r=>checked.has(r.name)).length;

  return (
    <div style={{ ...glass(isDark), overflow:"hidden", marginBottom:"8px" }}>
      {/* Accordion header */}
      <div onClick={()=>setExpanded(e=>!e)} style={{
        display:"flex",alignItems:"center",gap:"10px",padding:"10px 14px",cursor:"pointer",
        background:isDark?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.02)",
        borderBottom:expanded?`1px solid ${border}`:"none",userSelect:"none",
      }}>
        <div style={{ width:"3px",height:"18px",borderRadius:"2px",background:accent,flexShrink:0 }}/>
        <span style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"0.85rem",
          color:isDark ? DARK_THEME.text : LIGHT_THEME.text,flex:1,minWidth:0 }}>
          {device.device_name.trim()||<span style={{opacity:0.4}}>Untitled {index+1}</span>}
        </span>
        {device.meter_model&&(
          <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.58rem",
            color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted }}>
            {profiles.find(p=>p.model===device.meter_model)?.display_name??device.meter_model}
          </span>
        )}
        {selCount>0&&(
          <span style={{ padding:"2px 8px",borderRadius:"12px",
            background:accent+"20",border:`1px solid ${accent}44`,
            color:accent,fontFamily:"'Share Tech Mono',monospace",
            fontSize:"0.54rem",letterSpacing:"0.08em" }}>
            {selCount} reg{selCount!==1?"s":""}
          </span>
        )}
        <button onClick={e=>{e.stopPropagation();onRemove();}} style={{
          background:"none",border:"none",color:CLR.red,cursor:"pointer",fontSize:"1rem",padding:"0 2px",opacity:0.65,
        }}>✕</button>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke={isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2} strokeWidth={2}
          style={{ transform:expanded?"rotate(180deg)":"rotate(0)",transition:"transform 0.2s" }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>

      {expanded&&(
        <div style={{ padding:"14px" }}>
          <div style={{ display:"grid",gridTemplateColumns:"2fr 2fr 1fr 1fr 1fr",
            gap:"10px",marginBottom:"14px" }}>
            <div>
              <label style={lS}>Device Name</label>
              <input type="text" value={device.device_name} placeholder='"Main Incomer"'
                style={{...iS,...fe('device_name')}} onChange={e=>onUpdate({...device,device_name:e.target.value})}/>
            </div>
            <div>
              <label style={lS}>Meter Model</label>
              <select value={device.meter_model} style={{...iS,cursor:"pointer",...fe('meter_model')}}
                onChange={e=>handleModelChange(e.target.value)}>
                <option value="" disabled>Select model…</option>
                {profiles.map(p=><option key={p.model} value={p.model}>{p.display_name}</option>)}
              </select>
            </div>
            <div>
              <label style={lS}>Slave ID</label>
              <input type="number" min={1} max={247} value={device.slave_id}
                style={{...iS,textAlign:"center",...fe('slave_id')}}
                onChange={e=>{const v=parseInt(e.target.value,10);if(v>=1&&v<=247)onUpdate({...device,slave_id:v});}}/>
            </div>
            <div>
              {/* ← Seconds input: ×1000 before storing */}
              <label style={lS}>Poll Rate (s)</label>
              <input type="number" min={0.2} step={0.5} value={pollSecs}
                style={{...iS,textAlign:"center"}}
                onChange={e=>{
                  const s=parseFloat(e.target.value);
                  if(s>=0.2)onUpdate({...device,poll_rate_ms:Math.round(s*1000)});
                }}/>
            </div>
            <div>
              <label style={lS}>Alarm Cycles</label>
              <input type="number" min={1} max={100} value={device.alarm_trigger_cycles}
                title="Consecutive breaching polls before alarm email fires"
                style={{...iS,textAlign:"center"}}
                onChange={e=>{
                  const v=parseInt(e.target.value,10);
                  if(v>=1&&v<=100)onUpdate({...device,alarm_trigger_cycles:v});
                }}/>
            </div>
          </div>

          {/* ── Connection settings ─────────────────────────────────────── */}
          <div style={{ display:"grid",gridTemplateColumns:"auto 1fr 1fr",gap:"10px",marginBottom:"14px",alignItems:"end" }}>
            <div>
              <label style={lS}>Protocol</label>
              <select value={device.protocol} style={{...iS,cursor:"pointer",width:"auto",paddingRight:"24px"}}
                onChange={e=>onUpdate({...device,protocol:e.target.value as "rtu"|"tcp"})}>
                {(!licensedProtocols || licensedProtocols === "All" || licensedProtocols === "RTU") && (
                  <option value="rtu">Modbus RTU</option>
                )}
                {(!licensedProtocols || licensedProtocols === "All" || licensedProtocols === "TCP") && (
                  <option value="tcp">Modbus TCP</option>
                )}
              </select>
              {licensedProtocols && licensedProtocols !== "All" && (
                <div style={{ marginTop:"3px", fontFamily:"'Share Tech Mono',monospace",
                  fontSize:"0.48rem", letterSpacing:"0.08em",
                  color: CLR.amber }}>
                  License: {licensedProtocols} only
                </div>
              )}
            </div>
            {device.protocol==="rtu" ? <>
              <div>
                <label style={lS}>COM Port</label>
                <div style={fieldErrors?.has('com_port') ? {outline:`1px solid ${CLR.red}`,borderRadius:"5px"} : {}}>
                  <ComPortSelector value={device.com_port} onChange={v=>onUpdate({...device,com_port:v})} disabled={false} isDark={isDark}/>
                </div>
              </div>
              <div>
                <label style={lS}>Baud Rate</label>
                <select value={device.baud_rate} style={{...iS,cursor:"pointer"}}
                  onChange={e=>onUpdate({...device,baud_rate:parseInt(e.target.value,10)})}>
                  {[1200,2400,4800,9600,19200,38400,57600,115200].map(b=><option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            </> : <>
              <div>
                <label style={lS}>IP Address</label>
                <input type="text" value={device.ip_address} placeholder="192.168.1.50"
                  style={{...iS,...fe('ip_address')}} onChange={e=>onUpdate({...device,ip_address:e.target.value})}/>
              </div>
              <div>
                <label style={lS}>TCP Port</label>
                <input type="number" min={1} max={65535} value={device.tcp_port}
                  style={{...iS,textAlign:"center"}}
                  onChange={e=>{const v=parseInt(e.target.value,10);if(v>0&&v<=65535)onUpdate({...device,tcp_port:v});}}/>
              </div>
            </>}
          </div>

          {device.meter_model&&(
            <>
              {/* Register search + select-all */}
              <div style={{ display:"flex",alignItems:"center",gap:"8px",marginBottom:"8px" }}>
                <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.52rem",
                  letterSpacing:"0.16em",textTransform:"uppercase",color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2 }}>
                  Registers ({filtered.length+filteredCustom.length})
                </span>
                <input type="text" value={search} placeholder="Search…"
                  onChange={e=>setSearch(e.target.value)}
                  style={{...iS,flex:1,maxWidth:"150px",height:"26px",fontSize:"0.66rem"}}/>
                <button onClick={()=>{
                  if(allOn)setChecked(prev=>{const s=new Set(prev);allNames.forEach(n=>s.delete(n));return s;});
                  else setChecked(prev=>new Set([...prev,...allNames]));
                }} style={{
                  padding:"0 10px",height:"26px",
                  background:allOn?accent+"20":"transparent",
                  border:`1px solid ${allOn?accent+"50":border}`,
                  borderRadius:"5px",color:allOn?accent:isDark ? DARK_THEME.muted : LIGHT_THEME.muted,
                  fontFamily:"'Rajdhani',sans-serif",fontWeight:600,
                  fontSize:"0.68rem",letterSpacing:"0.06em",cursor:"pointer",whiteSpace:"nowrap",
                }}>{allOn?"Deselect All":"Select All"}</button>
              </div>

              {/* Register list */}
              <div style={{ border:`1px solid ${border}`,borderRadius:"6px",
                maxHeight:"170px",overflowY:"auto",marginBottom:"12px",
                background:isDark?"rgba(0,0,0,0.2)":"rgba(0,0,0,0.01)" }}>
                {device.meter_model==="Custom" && filtered.length===0 && filteredCustom.length===0 && (
                  <div style={{
                    display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                    padding:"20px 16px",gap:"6px",
                  }}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                      stroke={CLR.amber} strokeWidth={1.5}>
                      <circle cx="12" cy="12" r="10"/>
                      <line x1="12" y1="8" x2="12" y2="12"/>
                      <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.58rem",
                      letterSpacing:"0.1em",color:CLR.amber,textAlign:"center",lineHeight:1.5 }}>
                      Custom device — use "Add Custom Register"<br/>
                      below to define your Modbus registers.
                    </span>
                  </div>
                )}
                {[...filtered.map(r=>({r,c:false})),...filteredCustom.map(r=>({r,c:true}))].map(({r,c})=>(
                  <div key={r.name} onClick={()=>toggleReg(r.name)} style={{
                    display:"flex",alignItems:"center",gap:"8px",padding:"5px 10px",
                    borderBottom:`1px solid ${isDark ? "#1a1a1a" : "#f1f5f9"}`,
                    cursor:"pointer",userSelect:"none",
                    background:checked.has(r.name)
                      ?(isDark?"rgba(29,107,255,0.06)":"rgba(29,107,255,0.03)")
                      :"transparent",
                  }}>
                    <div style={{
                      width:"13px",height:"13px",borderRadius:"3px",flexShrink:0,
                      background:checked.has(r.name)?accent:"transparent",
                      border:`1.5px solid ${checked.has(r.name)?accent:isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
                      display:"flex",alignItems:"center",justifyContent:"center",
                    }}>
                      {checked.has(r.name)&&(
                        <svg viewBox="0 0 10 10" width="9" height="9">
                          <polyline points="1.5,5 4,7.5 8.5,2" stroke="#fff"
                            strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                        </svg>
                      )}
                    </div>
                    <span style={{ flex:1,fontFamily:"'Share Tech Mono',monospace",fontSize:"0.64rem",
                      letterSpacing:"0.03em",
                      color:checked.has(r.name)?isDark ? DARK_THEME.text : LIGHT_THEME.text:isDark ? DARK_THEME.muted : LIGHT_THEME.muted,
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                      {r.name}
                      {c&&<span style={{ marginLeft:"6px",padding:"1px 4px",borderRadius:"3px",
                        background:CLR.green+"20",color:CLR.green,fontSize:"0.46rem",
                        letterSpacing:"0.1em" }}>CUSTOM</span>}
                    </span>
                    <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.54rem",
                      color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,minWidth:"40px",textAlign:"right" }}>@{r.address}</span>
                    <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.52rem",
                      color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,minWidth:"52px",textAlign:"center" }}>{r.data_type}</span>
                    {checked.has(r.name) && (
                      <div onClick={e=>e.stopPropagation()} style={{ display:"flex", gap:"3px", alignItems:"center" }}>
                        <input type="number" placeholder="Min" value={alarms[r.name]?.min??""}
                          onChange={e=>setAlarms(a=>({...a,[r.name]:{...a[r.name],min:e.target.value}}))}
                          style={{ width:"52px", height:"20px", fontSize:"0.56rem",
                            background:isDark?"rgba(255,255,255,0.06)":"#f6f8fa",
                            border:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`, borderRadius:"3px",
                            color:CLR.amber, textAlign:"center", outline:"none", padding:"0 4px",
                            fontFamily:"'Share Tech Mono',monospace" }}/>
                        <input type="number" placeholder="Max" value={alarms[r.name]?.max??""}
                          onChange={e=>setAlarms(a=>({...a,[r.name]:{...a[r.name],max:e.target.value}}))}
                          style={{ width:"52px", height:"20px", fontSize:"0.56rem",
                            background:isDark?"rgba(255,255,255,0.06)":"#f6f8fa",
                            border:`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`, borderRadius:"3px",
                            color:CLR.red, textAlign:"center", outline:"none", padding:"0 4px",
                            fontFamily:"'Share Tech Mono',monospace" }}/>
                      </div>
                    )}
                    {c&&(
                      <button onClick={e=>{e.stopPropagation();
                        setCustomRegs(p=>p.filter(x=>x.name!==r.name));
                        setChecked(p=>{const s=new Set(p);s.delete(r.name);return s;});
                      }} style={{ background:"none",border:"none",color:CLR.red,cursor:"pointer",
                        fontSize:"0.8rem",padding:"0 2px",lineHeight:1 }}>✕</button>
                    )}
                  </div>
                ))}
              </div>

              {/* Custom register builder */}
              <div style={{ border:`1px solid ${border}`,borderRadius:"6px",overflow:"hidden" }}>
                <div style={{ padding:"5px 12px",borderBottom:`1px solid ${border}`,
                  background:isDark?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.02)",
                  fontFamily:"'Share Tech Mono',monospace",fontSize:"0.5rem",
                  letterSpacing:"0.18em",textTransform:"uppercase",color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2 }}>
                  Add Custom Register
                </div>
                <div style={{ padding:"10px" }}>
                  <div style={{ display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr auto",
                    gap:"8px",alignItems:"end" }}>
                    <div>
                      <label style={lS}>Name</label>
                      <input type="text" value={draft.name} placeholder="Tag name"
                        style={{...iS,height:"28px",fontSize:"0.66rem"}}
                        onChange={e=>{setDraft(d=>({...d,name:e.target.value}));setDraftErr(null);}}/>
                    </div>
                    <div>
                      <label style={lS}>Address</label>
                      <input type="number" min={0} max={65535} value={draft.address}
                        style={{...iS,height:"28px",fontSize:"0.66rem"}}
                        onChange={e=>setDraft(d=>({...d,address:e.target.value}))}/>
                    </div>
                    <div>
                      <label style={lS}>Length</label>
                      <select value={draft.length} style={{...iS,height:"28px",fontSize:"0.66rem",cursor:"pointer"}}
                        onChange={e=>setDraft(d=>({...d,length:e.target.value}))}>
                        <option value="1">1 (16b)</option>
                        <option value="2">2 (32b)</option>
                        <option value="4">4 (64b)</option>
                      </select>
                    </div>
                    <div>
                      <label style={lS}>Type</label>
                      <select value={draft.data_type} style={{...iS,height:"28px",fontSize:"0.66rem",cursor:"pointer"}}
                        onChange={e=>setDraft(d=>({...d,data_type:e.target.value}))}>
                        {DATA_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={lS}>×Mult</label>
                      <input type="text" value={draft.multiplier} placeholder="1.0"
                        style={{...iS,height:"28px",fontSize:"0.66rem"}}
                        onChange={e=>setDraft(d=>({...d,multiplier:e.target.value}))}/>
                    </div>
                    <button onClick={addCustom} style={{
                      height:"28px",padding:"0 12px",borderRadius:"5px",
                      background:isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim,border:`1px solid ${isDark ? DARK_THEME.accent+"50" : LIGHT_THEME.accent+"50"}`,
                      color:isDark ? DARK_THEME.accent : LIGHT_THEME.accent,cursor:"pointer",
                      fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
                      fontSize:"0.7rem",letterSpacing:"0.08em",whiteSpace:"nowrap",
                    }}>+ Add</button>
                  </div>
                  {draftErr&&(
                    <div style={{ marginTop:"6px",fontFamily:"'Share Tech Mono',monospace",
                      fontSize:"0.58rem",color:CLR.amber,letterSpacing:"0.06em" }}>
                      ⚠ {draftErr}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── DeviceSetupModal ────────────────────────────────────────────────────────

export default function DeviceSetupModal({ profiles,initialDevices,onSave,onClose,theme,licensedProtocols,isCloudEnabled,isCloudBuild }:{
  profiles:MeterProfile[]; initialDevices:DeviceConfig[];
  onSave:(devices:DeviceConfig[])=>void; onClose:()=>void; theme:Theme;
  licensedProtocols?: "RTU" | "TCP" | "All";
  isCloudEnabled?: boolean;
  isCloudBuild: boolean;
}) {
  const isDark = theme==="dark";
  const [devices,setDevices] = useState<DeviceConfig[]>(()=>
    initialDevices.length>0
      ? initialDevices
      : [{...DEFAULT_DEVICE(),meter_model:profiles[0]?.model??""}]
  );
  const [notifEmail,   setNotifEmail]   = useState("");
  const [emailSaved,   setEmailSaved]   = useState(false);
  const [emailError,   setEmailError]   = useState<string|null>(null);
  const [exportDir,    setExportDir]    = useState("");
  const [dirSaved,     setDirSaved]     = useState(false);
  const [fieldErrors,  setFieldErrors]  = useState<Record<number,Set<string>>>({});

  useEffect(()=>{
    invokeApi<string>("get_notification_email").then(v=>{setNotifEmail(v);if(v)setEmailSaved(true);}).catch(console.error);
    invokeApi<string>("get_export_path").then(setExportDir).catch(()=>{});
  },[]);

  const updDevice = (i:number,d:DeviceConfig) => setDevices(p=>p.map((x,j)=>j===i?d:x));
  const remDevice = (i:number) => setDevices(p=>p.length>1?p.filter((_,j)=>j!==i):p);
  const addDevice = () => setDevices(p=>[...p,{...DEFAULT_DEVICE(),meter_model:profiles[0]?.model??""}]);

  const handleSave = () => {
    const errors: Record<number,Set<string>> = {};
    for(let i=0;i<devices.length;i++){
      const d=devices[i];
      const e=new Set<string>();
      if(!d.device_name.trim())                              e.add('device_name');
      if(!d.meter_model)                                     e.add('meter_model');
      if(d.slave_id<1||d.slave_id>247)                      e.add('slave_id');
      if(d.protocol==="rtu" && !d.com_port.trim())          e.add('com_port');
      if(d.protocol==="tcp" && !d.ip_address.trim())        e.add('ip_address');
      if(e.size>0) errors[i]=e;
    }
    if(Object.keys(errors).length>0){setFieldErrors(errors);return;}
    // Register selection is still guarded (backend will also reject, toast handles it)
    const ids=devices.map(d=>d.slave_id);
    const dup=ids.find((id,i)=>ids.indexOf(id)!==i);
    if(dup!==undefined){alert(`Duplicate Slave ID ${dup} — each device must have a unique address.`);return;}
    setFieldErrors({});
    onSave(devices);
  };

  const totalRegs = devices.reduce((s,d)=>s+d.selected_registers.length,0);
  const border    = isDark ? DARK_THEME.border : LIGHT_THEME.border;
  const iS: React.CSSProperties = {
    height:"32px", background:isDark?"rgba(255,255,255,0.04)":"#fff",
    border:`1px solid ${border}`, borderRadius:"5px",
    color:isDark ? DARK_THEME.text : LIGHT_THEME.text, fontFamily:"'Share Tech Mono',monospace",
    fontSize:"0.7rem", letterSpacing:"0.04em", outline:"none", padding:"0 8px",
  };

  return (
    <div style={{
      position:"fixed",inset:0,zIndex:9998,
      background:"rgba(0,0,0,0.78)",backdropFilter:"blur(6px)",
      display:"flex",alignItems:"center",justifyContent:"center",padding:"20px",
    }} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{
        width:"100%",maxWidth:"880px",maxHeight:"92vh",
        ...glass(isDark),
        boxShadow:"0 40px 100px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08)",
        display:"flex",flexDirection:"column",overflow:"hidden",
      }}>
        <div style={{ height:"3px",
          background:"linear-gradient(90deg,#1a5fff,#10b981,#f59e0b,#a855f7)" }}/>

        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"14px 20px 10px",borderBottom:`1px solid ${border}`,flexShrink:0 }}>
          <div>
            <div style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"1.05rem",
              letterSpacing:"0.08em",color:isDark ? DARK_THEME.text : LIGHT_THEME.text }}>Bus Configuration</div>
            <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.52rem",
              letterSpacing:"0.14em",color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,marginTop:"2px" }}>
              {devices.length} device{devices.length!==1?"s":""} · {totalRegs} registers · poll rate in seconds
            </div>
          </div>
          <button onClick={onClose} style={{
            background:"none",border:`1px solid ${border}`,borderRadius:"5px",
            color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted,cursor:"pointer",padding:"4px 10px",
            fontFamily:"'Share Tech Mono',monospace",fontSize:"0.58rem",letterSpacing:"0.08em",
          }}>ESC</button>
        </div>

        <div style={{ flex:1,overflowY:"auto",padding:"14px 20px" }}>
          {devices.map((dev,i)=>(
            <DevicePanel key={i} index={i} device={dev} profiles={profiles} isDark={isDark}
              onUpdate={d=>updDevice(i,d)} onRemove={()=>remDevice(i)}
              licensedProtocols={licensedProtocols} fieldErrors={fieldErrors[i]}/>
          ))}
          <button onClick={addDevice} style={{
            width:"100%",padding:"10px",
            background:"transparent",
            border:`1px dashed ${isDark ? DARK_THEME.accent+"40" : LIGHT_THEME.accent+"30"}`,
            borderRadius:"8px",color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
            fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
            fontSize:"0.72rem",letterSpacing:"0.12em",textTransform:"uppercase",
            cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:"8px",
          }}
            onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.borderColor=isDark ? DARK_THEME.accent+"80" : LIGHT_THEME.accent+"80";
              (e.currentTarget as HTMLElement).style.color=isDark ? DARK_THEME.accent : LIGHT_THEME.accent;}}
            onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.borderColor=isDark ? DARK_THEME.accent+"40" : LIGHT_THEME.accent+"30";
              (e.currentTarget as HTMLElement).style.color=isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2;}}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Add Another Meter
          </button>

          {/* Notifications */}
          <div style={{ marginTop:"12px", ...glass(isDark), overflow:"hidden" }}>
            <div style={{ padding:"8px 14px", borderBottom:`1px solid ${border}`,
              background:isDark?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.02)",
              fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
              letterSpacing:"0.18em", textTransform:"uppercase", color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2 }}>
              Alarm Notifications (requires EmailAlerts license)
            </div>
            <div style={{ padding:"12px 14px", display:"flex", flexDirection:"column", gap:"10px" }}>
              {/* Destination email — alerts are sent FROM the Resend account */}
              <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
                <input type="email" value={notifEmail} placeholder="Send alerts to: you@email.com"
                  onChange={e=>{setNotifEmail(e.target.value);setEmailSaved(false);setEmailError(null);}}
                  style={{ ...iS, flex:1 }}/>
                <button onClick={async ()=>{
                  try {
                    await invokeApi("save_notification_email", { email: notifEmail });
                    setEmailSaved(true);
                    setEmailError(null);
                  } catch(e) { setEmailError(String(e)); }
                }} style={{
                  height:"32px", padding:"0 14px", borderRadius:"5px",
                  background: emailSaved ? (isDark ? DARK_THEME.greenBg : LIGHT_THEME.greenBg) : (isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim),
                  border:`1px solid ${emailSaved ? (isDark ? DARK_THEME.greenBdr : LIGHT_THEME.greenBdr) : (isDark ? DARK_THEME.accent+"50" : LIGHT_THEME.accent+"50")}`,
                  color: emailSaved ? (isDark ? DARK_THEME.green : LIGHT_THEME.green) : (isDark ? DARK_THEME.accent : LIGHT_THEME.accent),
                  cursor:"pointer", fontFamily:"'Rajdhani',sans-serif",
                  fontWeight:700, fontSize:"0.72rem", whiteSpace:"nowrap",
                }}>{emailSaved ? "Saved ✓" : "Save Email"}</button>
              </div>
              {emailError && <div style={{ color: CLR.red, fontSize:"0.72rem", fontFamily:"'Rajdhani',sans-serif" }}>{emailError}</div>}

            </div>
          </div>

          {/* Enterprise Data Directory */}
          <div style={{ marginTop:"12px", ...glass(isDark), overflow:"hidden" }}>
            <div style={{ padding:"8px 14px", borderBottom:`1px solid ${border}`,
              background:isDark?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.02)",
              fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
              letterSpacing:"0.18em", textTransform:"uppercase", color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2 }}>
              Enterprise Data Directory (nightly exports + MID backups)
            </div>
            <div style={{ padding:"12px 14px", display:"flex", flexDirection:"column", gap:"8px" }}>
              <div style={{ fontSize:"0.68rem", color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted }}>
                Daily .xlsx files are written to <code style={{ fontFamily:"'Share Tech Mono',monospace" }}>[dir]/[device]/[YYYY]/[MM]/[YYYY-MM-DD].xlsx</code> at 23:58 local time.
                Encrypted DB backups + SHA-256 hash go to <code style={{ fontFamily:"'Share Tech Mono',monospace" }}>[dir]/_backups/</code>.
              </div>
              <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
                <div style={{ flex:1, ...iS, display:"flex", alignItems:"center",
                  gap:"6px", cursor:"default", overflow:"hidden" }}>
                  <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.65rem",
                    color: exportDir ? isDark ? DARK_THEME.text : LIGHT_THEME.text : isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
                    whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                    {exportDir || "No directory selected"}
                  </span>
                </div>
                <button onClick={async ()=>{
                  if (!isTauri) return; // folder picker not available in browser
                  const { open } = await import("@tauri-apps/plugin-dialog");
                  const selected = await open({ directory:true, multiple:false });
                  if (typeof selected === "string" && selected) {
                    setExportDir(selected); setDirSaved(false);
                  }
                }} style={{
                  height:"32px", padding:"0 14px", borderRadius:"5px",
                  background:isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim, border:`1px solid ${isDark ? DARK_THEME.accent+"50" : LIGHT_THEME.accent+"50"}`,
                  color:isDark ? DARK_THEME.accent : LIGHT_THEME.accent, cursor:"pointer", fontFamily:"'Rajdhani',sans-serif",
                  fontWeight:700, fontSize:"0.72rem", whiteSpace:"nowrap",
                }}>Browse</button>
                <button onClick={async ()=>{
                  if (!exportDir) return;
                  try {
                    await invokeApi("save_export_path", { path: exportDir });
                    setDirSaved(true);
                  } catch {}
                }} disabled={!exportDir} style={{
                  height:"32px", padding:"0 14px", borderRadius:"5px",
                  background: dirSaved ? (isDark ? DARK_THEME.greenBg : LIGHT_THEME.greenBg) : (isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim),
                  border:`1px solid ${dirSaved ? (isDark ? DARK_THEME.greenBdr : LIGHT_THEME.greenBdr) : (isDark ? DARK_THEME.accent+"50" : LIGHT_THEME.accent+"50")}`,
                  color: dirSaved ? (isDark ? DARK_THEME.green : LIGHT_THEME.green) : (isDark ? DARK_THEME.accent : LIGHT_THEME.accent),
                  cursor: exportDir ? "pointer" : "not-allowed",
                  fontFamily:"'Rajdhani',sans-serif",
                  fontWeight:700, fontSize:"0.72rem", whiteSpace:"nowrap",
                }}>{dirSaved ? "Saved ✓" : "Save Dir"}</button>
              </div>
            </div>
          </div>

          {/* Cloud Sync — absent from air-gapped binary, no DOM nodes, no greyed card */}
          {isCloudBuild && (
            <div style={{ marginTop:"12px", ...glass(isDark), overflow:"hidden",
              opacity: isCloudEnabled ? 1 : 0.45,
              pointerEvents: isCloudEnabled ? "auto" : "none",
            }}>
              <div style={{ padding:"8px 14px", borderBottom:`1px solid ${border}`,
                background:isDark?"rgba(255,255,255,0.02)":"rgba(0,0,0,0.02)",
                display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
                  letterSpacing:"0.18em", textTransform:"uppercase", color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2 }}>
                  Cloud Sync &amp; Telemetry
                </span>
                {!isCloudEnabled && (
                  <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.46rem",
                    letterSpacing:"0.1em", color:isDark ? DARK_THEME.amber : LIGHT_THEME.amber,
                    border:`1px solid ${isDark ? DARK_THEME.amberBdr : LIGHT_THEME.amberBdr}`, borderRadius:"3px", padding:"1px 6px" }}>
                    Requires Online · Tier 2+
                  </span>
                )}
              </div>
              <div style={{ padding:"12px 14px", display:"flex", flexDirection:"column", gap:"6px" }}>
                <div style={{ fontSize:"0.68rem", color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted }}>
                  Push live readings and alarms to the TechniDAQ cloud dashboard.
                  Available for <strong>Online</strong> licenses at <strong>Tier 2</strong> or higher.
                </div>
                {isCloudEnabled && (
                  <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.6rem",
                    letterSpacing:"0.08em", color:isDark ? DARK_THEME.green : LIGHT_THEME.green }}>
                    &#9679; CLOUD SYNC ACTIVE
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",
          padding:"10px 20px",borderTop:`1px solid ${border}`,flexShrink:0 }}>
          <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.54rem",
            letterSpacing:"0.1em",color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2 }}>
            {totalRegs} register{totalRegs!==1?"s":""} across {devices.length} device{devices.length!==1?"s":""}
          </span>
          <div style={{ display:"flex",gap:"10px" }}>
            <button onClick={onClose} style={{
              padding:"0 16px",height:"34px",borderRadius:"6px",
              background:"transparent",border:`1px solid ${border}`,
              color:isDark ? DARK_THEME.muted : LIGHT_THEME.muted,cursor:"pointer",
              fontFamily:"'Rajdhani',sans-serif",fontWeight:600,fontSize:"0.78rem",
            }}>Cancel</button>
            <button onClick={handleSave} disabled={totalRegs===0} style={{
              padding:"0 20px",height:"34px",borderRadius:"6px",
              background:totalRegs===0?(isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim):(isDark ? DARK_THEME.accent : LIGHT_THEME.accent),
              border:`1px solid ${totalRegs===0?(isDark ? DARK_THEME.accent+"30" : LIGHT_THEME.accent+"30"):(isDark ? DARK_THEME.accent : LIGHT_THEME.accent)}`,
              color:totalRegs===0?isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2:"#fff",
              cursor:totalRegs===0?"not-allowed":"pointer",
              fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"0.8rem",
              letterSpacing:"0.08em",
              boxShadow:totalRegs>0?`0 4px 14px ${isDark ? DARK_THEME.accent : LIGHT_THEME.accent}40`:"none",
            }}>Save Bus Configuration</button>
          </div>
        </div>
      </div>
    </div>
  );
}
