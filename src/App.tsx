// src/App.tsx  — TechniDAQ Phase 3 (Universal SCADA Platform)
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import "./App.css";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RegisterEntry {
  name:       string;
  address:    number;
  length:     number;
  data_type:  string;
  multiplier: number;
}

interface MeterProfile {
  model:        string;
  display_name: string;
  endianness:   string;
  baud_rate:    number;
  parity:       string;
  registers:    RegisterEntry[];
}

interface MeterReading {
  device_id:    string;
  timestamp_ms: number;
  data:         Record<string, number>;
}

interface FaultEvent  { reason: string; timestamp_ms: number }
interface StatusEvent { state: PollState }

interface AuthState {
  valid:          boolean;
  username?:      string;
  project_name?:  string;
  expiry_date?:   number;
  allowed_meters: string[];
}

interface ActiveDevice {
  profile:            MeterProfile;
  slaveId:            number;
  selectedRegisters:  RegisterEntry[];   // predefined + custom
}

type PollState    = "running" | "stopped" | "fault";
type Theme        = "dark" | "light";
type ExportStatus = "idle" | "saving" | "success" | "error";

const MAX_HISTORY = 60;
const COM_PORTS   =["COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","COM10","COM11","COM12"];
const DATA_TYPES  =["Float32","UInt16","UInt32","INT16","INT32"];

// ─── Color Palette for Dynamic Cards ─────────────────────────────────────────

const ACCENT_PALETTES =[
  { bg: "rgba(34,68,240,0.08)",  border: "rgba(34,68,240,0.25)",  text: "#6b8fff",  bar: "#2244F0" },
  { bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.25)", text: "#fbbf24",  bar: "#D97706" },
  { bg: "rgba(168,85,247,0.08)", border: "rgba(168,85,247,0.25)", text: "#c084fc",  bar: "#9333EA" },
  { bg: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.25)", text: "#34d399",  bar: "#059669" },
  { bg: "rgba(239,68,68,0.08)",  border: "rgba(239,68,68,0.25)",  text: "#f87171",  bar: "#DC2626" },
  { bg: "rgba(20,184,166,0.08)", border: "rgba(20,184,166,0.25)", text: "#2dd4bf",  bar: "#0D9488" },
  { bg: "rgba(249,115,22,0.08)", border: "rgba(249,115,22,0.25)", text: "#fb923c",  bar: "#EA580C" },
  { bg: "rgba(99,102,241,0.08)", border: "rgba(99,102,241,0.25)", text: "#818cf8",  bar: "#4F46E5" },
];

function paletteFor(name: string, idx: number) {
  const n = name.toLowerCase();
  if (n.includes("voltage") || n.includes(" v"))  return ACCENT_PALETTES[0];
  if (n.includes("current") || n.includes(" a"))  return ACCENT_PALETTES[1];
  if (n.includes("apparent"))                      return ACCENT_PALETTES[7];
  if (n.includes("reactive"))                      return ACCENT_PALETTES[4];
  if (n.includes("active power") || n.includes("power total")) return ACCENT_PALETTES[2];
  if (n.includes("energy"))                        return ACCENT_PALETTES[3];
  if (n.includes("frequen"))                       return ACCENT_PALETTES[5];
  if (n.includes("factor"))                        return ACCENT_PALETTES[6];
  return ACCENT_PALETTES[idx % ACCENT_PALETTES.length];
}

// ─── Dynamic Metric Card ──────────────────────────────────────────────────────

function DynamicCard({ name, value, idx, isDark }: {
  name: string; value: number | undefined; idx: number; isDark: boolean;
}) {
  const p = paletteFor(name, idx);
  const displayVal = value !== undefined && !isNaN(value)
    ? (Math.abs(value) >= 1000 ? value.toFixed(1) : value.toFixed(3))
    : "——";

  return (
    <div style={{
      background: isDark ? p.bg : p.bg.replace("0.08", "0.05"),
      border: `1px solid ${p.border}`,
      borderRadius: "10px",
      padding: "18px 20px 14px",
      display: "flex",
      flexDirection: "column",
      gap: "6px",
      position: "relative",
      overflow: "hidden",
      minWidth: 0,
    }}>
      <div style={{ position:"absolute", top:0, left:0, right:0, height:"2px", background: `linear-gradient(90deg, ${p.bar}, transparent)` }} />
      <div style={{
        fontFamily: "'Share Tech Mono', monospace", fontSize: "0.55rem",
        letterSpacing: "0.22em", textTransform: "uppercase", color: isDark ? "#4a5c7a" : "#8fa0cc",
      }}>{name}</div>
      <div style={{ display:"flex", alignItems:"baseline", gap:"6px" }}>
        <span style={{
          fontFamily: "'Share Tech Mono', monospace", fontSize: "1.6rem",
          fontWeight: 700, color: p.text, letterSpacing: "-0.02em", lineHeight: 1,
        }}>{displayVal}</span>
      </div>
      <div style={{
        height: "2px", marginTop: "4px", borderRadius: "1px", overflow: "hidden",
        background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)",
      }}>
        {value !== undefined && !isNaN(value) && (
          <div style={{
            height: "100%", borderRadius: "1px", transition: "width 0.5s ease",
            width: `${Math.min(100, Math.abs(value / 500) * 100)}%`, background: p.bar,
          }} />
        )}
      </div>
    </div>
  );
}

// ─── Device Setup Modal ───────────────────────────────────────────────────────

interface CustomRegisterDraft {
  name: string; address: string; length: string; data_type: string; multiplier: string;
}

const EMPTY_DRAFT: CustomRegisterDraft = {
  name: "", address: "", length: "2", data_type: "Float32", multiplier: "1.0",
};

function DeviceSetupModal({
  profiles, initialModel, initialSlaveId, initialSelected,
  onSave, onClose, theme,
}: {
  profiles: MeterProfile[]; initialModel: string; initialSlaveId: number; initialSelected: RegisterEntry[];
  onSave: (model: string, slaveId: number, regs: RegisterEntry[]) => void; onClose: () => void; theme: Theme;
}) {
  const isDark = theme === "dark";
  const [selectedModel,  setSelectedModel]  = useState(initialModel || (profiles[0]?.model ?? ""));
  const [slaveId,        setSlaveId]        = useState(initialSlaveId);
  const [searchQuery,    setSearchQuery]    = useState("");
  const [checked,        setChecked]        = useState<Set<string>>(() => new Set(initialSelected.map(r => r.name)));
  const [customRegs,     setCustomRegs]     = useState<RegisterEntry[]>(
    initialSelected.filter(r => !profiles.flatMap(p=>p.registers).some(lr => lr.name === r.name))
  );
  const[draft,          setDraft]          = useState<CustomRegisterDraft>(EMPTY_DRAFT);
  const[draftError,     setDraftError]     = useState<string | null>(null);

  const profileRegs = useMemo(() => profiles.find(p => p.model === selectedModel)?.registers ?? [], [profiles, selectedModel]);

  const filteredRegs = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return profileRegs.filter(r => r.name.toLowerCase().includes(q) || String(r.address).includes(q) || r.data_type.toLowerCase().includes(q));
  }, [profileRegs, searchQuery]);

  const filteredCustom = customRegs.filter(r => r.name.toLowerCase().includes(searchQuery.toLowerCase()));
  const allFilteredNames  =[...filteredRegs.map(r => r.name), ...filteredCustom.map(r => r.name)];
  const allCheckedInView  = allFilteredNames.length > 0 && allFilteredNames.every(n => checked.has(n));

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    const newProfile = profiles.find(p => p.model === model);
    if (newProfile) setChecked(new Set(newProfile.registers.map(r => r.name)));
    setSearchQuery("");
  };

  const toggleReg = (name: string) => setChecked(prev => { const s = new Set(prev); s.has(name) ? s.delete(name) : s.add(name); return s; });
  const toggleAll = () => {
    if (allCheckedInView) setChecked(prev => { const s = new Set(prev); allFilteredNames.forEach(n => s.delete(n)); return s; });
    else setChecked(prev => { const s = new Set(prev); allFilteredNames.forEach(n => s.add(n)); return s; });
  };

  const addCustomRegister = () => {
    setDraftError(null);
    if (!draft.name.trim()) { setDraftError("Name is required."); return; }
    const addr = parseInt(draft.address, 10);
    if (isNaN(addr) || addr < 0 || addr > 65535) { setDraftError("Address must be 0–65535."); return; }
    const len = parseInt(draft.length, 10);
    if (![1,2,4].includes(len)) { setDraftError("Length must be 1, 2, or 4."); return; }
    const mult = parseFloat(draft.multiplier);
    if (isNaN(mult)) { setDraftError("Multiplier must be a number."); return; }
    if (customRegs.some(r => r.name === draft.name.trim())) { setDraftError("A register with this name already exists."); return; }

    const newReg: RegisterEntry = { name: draft.name.trim(), address: addr, length: len, data_type: draft.data_type, multiplier: mult };
    setCustomRegs(prev => [...prev, newReg]);
    setChecked(prev => new Set([...prev, newReg.name]));
    setDraft(EMPTY_DRAFT);
  };

  const removeCustomReg = (name: string) => {
    setCustomRegs(prev => prev.filter(r => r.name !== name));
    setChecked(prev => { const s = new Set(prev); s.delete(name); return s; });
  };

  const handleSave = () => {
    if (slaveId < 1 || slaveId > 247) { alert("Slave ID must be 1–247"); return; }
    const allRegs =[...profileRegs, ...customRegs].filter(r => checked.has(r.name));
    if (allRegs.length === 0) { alert("Select at least one register."); return; }
    onSave(selectedModel, slaveId, allRegs);
  };

  const bg       = isDark ? "#0c0f14"                  : "#ffffff";
  const border   = isDark ? "rgba(255,255,255,0.07)"   : "rgba(22,53,212,0.1)";
  const textPri  = isDark ? "#e2e8f0"                  : "#0f172a";
  const textSec  = isDark ? "#4a5c7a"                  : "#8fa0cc";
  const inputBg  = isDark ? "rgba(255,255,255,0.04)"   : "rgba(22,53,212,0.03)";
  const inputBrd = isDark ? "rgba(255,255,255,0.1)"    : "rgba(22,53,212,0.15)";
  const accent   = "#2244F0";
  const rowHover = isDark ? "rgba(255,255,255,0.03)"   : "rgba(22,53,212,0.04)";

  const inputStyle: React.CSSProperties = {
    background: inputBg, border: `1px solid ${inputBrd}`, borderRadius: "6px",
    color: textPri, fontFamily: "'Share Tech Mono', monospace",
    fontSize: "0.75rem", letterSpacing: "0.05em", outline: "none", padding: "7px 10px",
  };

  const labelStyle: React.CSSProperties = {
    fontFamily: "'Share Tech Mono', monospace", fontSize: "0.52rem",
    letterSpacing: "0.22em", color: textSec, textTransform: "uppercase", display: "block", marginBottom: "5px",
  };

  const totalSelected = [...profileRegs, ...customRegs].filter(r => checked.has(r.name)).length;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9998, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: "820px", maxHeight: "90vh", background: bg, border: `1px solid ${border}`, borderRadius: "14px", boxShadow: "0 32px 100px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ height: "2px", background: `linear-gradient(90deg, transparent, ${accent}, #00e5a0, transparent)` }} />
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding: "18px 24px 14px", borderBottom: `1px solid ${border}`, flexShrink: 0 }}>
          <div>
            <div style={{ fontFamily:"'Rajdhani',sans-serif", fontWeight:700, fontSize:"1.1rem", letterSpacing:"0.1em", color:textPri }}>Configure Device</div>
            <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.58rem", letterSpacing:"0.18em", color:textSec, marginTop:"2px" }}>{totalSelected} register{totalSelected !== 1 ? "s" : ""} selected</div>
          </div>
          <button onClick={onClose} style={{ background:"none", border:`1px solid ${border}`, borderRadius:"6px", color:textSec, cursor:"pointer", padding:"5px 10px", fontFamily:"'Share Tech Mono',monospace", fontSize:"0.6rem", letterSpacing:"0.1em" }}>ESC</button>
        </div>
        <div style={{ flex:1, overflowY:"auto", padding:"20px 24px", display:"flex", flexDirection:"column", gap:"20px" }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr auto", gap:"14px", alignItems:"end" }}>
            <div>
              <label style={labelStyle}>Meter Model</label>
              <select value={selectedModel} onChange={e => handleModelChange(e.target.value)} style={{ ...inputStyle, width:"100%" }}>
                {profiles.map(p => <option key={p.model} value={p.model}>{p.display_name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Slave ID</label>
              <input type="number" min={1} max={247} value={slaveId} onChange={e => { const v = parseInt(e.target.value,10); if (v>=1&&v<=247) setSlaveId(v); }} style={{ ...inputStyle, width:"70px", textAlign:"center" }} />
            </div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:"10px" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:"12px" }}>
              <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.6rem", letterSpacing:"0.2em", color:textSec, textTransform:"uppercase" }}>Registers ({filteredRegs.length + filteredCustom.length} shown)</div>
              <div style={{ display:"flex", alignItems:"center", gap:"8px", flex:1, justifyContent:"flex-end" }}>
                <input type="text" value={searchQuery} placeholder="Search registers…" onChange={e => setSearchQuery(e.target.value)} style={{ ...inputStyle, width:"180px", padding:"5px 10px" }} />
                <button onClick={toggleAll} style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.58rem", letterSpacing:"0.1em", padding:"5px 10px", background: allCheckedInView ? `rgba(34,68,240,0.15)` : "transparent", border: `1px solid ${allCheckedInView ? "rgba(34,68,240,0.4)" : inputBrd}`, borderRadius:"5px", color: allCheckedInView ? "#6b8fff" : textSec, cursor:"pointer", whiteSpace:"nowrap" }}>{allCheckedInView ? "Deselect All" : "Select All"}</button>
              </div>
            </div>
            <div style={{ border: `1px solid ${border}`, borderRadius:"8px", maxHeight:"260px", overflowY:"auto" }}>
              {filteredRegs.length === 0 && filteredCustom.length === 0 ? (
                <div style={{ padding:"24px", textAlign:"center", color:textSec, fontFamily:"'Share Tech Mono',monospace", fontSize:"0.65rem", letterSpacing:"0.12em" }}>No registers match your search.</div>
              ) : (
                <>
                  {filteredRegs.map(reg => <RegisterRow key={reg.name} reg={reg} checked={checked.has(reg.name)} onToggle={() => toggleReg(reg.name)} isCustom={false} textPri={textPri} textSec={textSec} border={border} accent={accent} rowHover={rowHover} isDark={isDark} />)}
                  {filteredCustom.map(reg => <RegisterRow key={reg.name} reg={reg} checked={checked.has(reg.name)} onToggle={() => toggleReg(reg.name)} isCustom={true} onRemove={() => removeCustomReg(reg.name)} textPri={textPri} textSec={textSec} border={border} accent={accent} rowHover={rowHover} isDark={isDark} />)}
                </>
              )}
            </div>
          </div>
          <div style={{ border:`1px solid ${border}`, borderRadius:"8px", overflow:"hidden" }}>
            <div style={{ padding:"10px 14px", borderBottom:`1px solid ${border}`, background: isDark ? "rgba(255,255,255,0.02)" : "rgba(22,53,212,0.02)", fontFamily:"'Share Tech Mono',monospace", fontSize:"0.58rem", letterSpacing:"0.2em", color:textSec, textTransform:"uppercase" }}>Add Custom Register</div>
            <div style={{ padding:"14px" }}>
              <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr auto", gap:"10px", alignItems:"end" }}>
                <div><label style={labelStyle}>Name</label><input type="text" value={draft.name} placeholder="e.g. Pump" onChange={e => { setDraft(d => ({...d, name: e.target.value})); setDraftError(null); }} style={{ ...inputStyle, width:"100%" }} /></div>
                <div><label style={labelStyle}>Address</label><input type="number" min={0} max={65535} value={draft.address} placeholder="0-65535" onChange={e => setDraft(d => ({...d, address: e.target.value}))} style={{ ...inputStyle, width:"100%" }} /></div>
                <div><label style={labelStyle}>Length</label><select value={draft.length} onChange={e => setDraft(d => ({...d, length: e.target.value}))} style={{ ...inputStyle, width:"100%" }}><option value="1">1 (16-bit)</option><option value="2">2 (32-bit)</option><option value="4">4 (64-bit)</option></select></div>
                <div><label style={labelStyle}>Data Type</label><select value={draft.data_type} onChange={e => setDraft(d => ({...d, data_type: e.target.value}))} style={{ ...inputStyle, width:"100%" }}>{DATA_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></div>
                <div><label style={labelStyle}>Multiplier</label><input type="text" value={draft.multiplier} placeholder="1.0" onChange={e => setDraft(d => ({...d, multiplier: e.target.value}))} style={{ ...inputStyle, width:"100%" }} /></div>
                <button onClick={addCustomRegister} style={{ padding:"7px 14px", borderRadius:"6px", background: "rgba(34,68,240,0.15)", border: "1px solid rgba(34,68,240,0.4)", color: "#6b8fff", cursor:"pointer", fontFamily:"'Rajdhani',sans-serif", fontWeight:700, fontSize:"0.7rem", letterSpacing:"0.1em", whiteSpace:"nowrap" }}>+ Add</button>
              </div>
              {draftError && <div style={{ marginTop:"8px", fontFamily:"'Share Tech Mono',monospace", fontSize:"0.62rem", color:"#f97316", letterSpacing:"0.06em" }}>⚠ {draftError}</div>}
            </div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 24px", borderTop:`1px solid ${border}`, flexShrink:0 }}>
          <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.58rem", letterSpacing:"0.12em", color:textSec }}>{totalSelected} register{totalSelected !== 1 ? "s" : ""} will be polled per second</span>
          <div style={{ display:"flex", gap:"10px" }}>
            <button onClick={onClose} style={{ padding:"8px 18px", borderRadius:"7px", background:"transparent", border:`1px solid ${border}`, color:textSec, cursor:"pointer", fontFamily:"'Rajdhani',sans-serif", fontWeight:600, fontSize:"0.8rem" }}>Cancel</button>
            <button onClick={handleSave} disabled={totalSelected === 0} style={{ padding:"8px 20px", borderRadius:"7px", background: totalSelected === 0 ? "rgba(34,68,240,0.1)" : "linear-gradient(135deg,#1635D4,#2244F0)", border:"1px solid rgba(34,68,240,0.5)", color: totalSelected === 0 ? "#4a5c7a" : "#fff", cursor: totalSelected === 0 ? "not-allowed" : "pointer", fontFamily:"'Rajdhani',sans-serif", fontWeight:700, fontSize:"0.8rem", letterSpacing:"0.08em", boxShadow: totalSelected > 0 ? "0 4px 16px rgba(34,68,240,0.3)" : "none" }}>Save Configuration</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Register Row ───────────────────────────────────────────────────────────────

function RegisterRow({ reg, checked, onToggle, isCustom, onRemove, textPri, textSec, border, accent, rowHover, isDark }: any) {
  const [hover, setHover] = useState(false);
  return (
    <div onClick={onToggle} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{ display:"flex", alignItems:"center", gap:"10px", padding:"7px 12px", background: hover ? rowHover : "transparent", borderBottom: `1px solid ${border}`, cursor:"pointer", userSelect:"none" }}>
      <div style={{ width:"14px", height:"14px", borderRadius:"3px", flexShrink:0, background: checked ? accent : "transparent", border: `1.5px solid ${checked ? accent : (isDark ? "rgba(255,255,255,0.2)" : "rgba(22,53,212,0.25)")}`, display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.12s ease" }}>
        {checked && <svg viewBox="0 0 10 10" width="10" height="10"><polyline points="1.5,5 4,7.5 8.5,2" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>}
      </div>
      <span style={{ flex:1, fontFamily:"'Share Tech Mono',monospace", fontSize:"0.7rem", color: checked ? textPri : textSec, letterSpacing:"0.04em", transition:"color 0.12s" }}>
        {reg.name}
        {isCustom && <span style={{ marginLeft:"6px", padding:"1px 5px", borderRadius:"3px", background:"rgba(0,229,160,0.12)", color:"#00e5a0", fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem", letterSpacing:"0.14em" }}>CUSTOM</span>}
      </span>
      <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.6rem", color:textSec, letterSpacing:"0.06em", minWidth:"50px", textAlign:"right" }}>@{reg.address}</span>
      <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.58rem", color:textSec, letterSpacing:"0.06em", minWidth:"56px", textAlign:"center" }}>{reg.data_type}</span>
      <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.58rem", color:textSec, letterSpacing:"0.06em", minWidth:"36px", textAlign:"right" }}>×{reg.multiplier}</span>
      {isCustom && onRemove && <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{ background:"none", border:"none", color:"#f97316", cursor:"pointer", fontSize:"0.8rem", padding:"0 2px", lineHeight:1 }}>✕</button>}
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

interface ToastState { message:string; type:"success"|"error"|"warn"; visible:boolean }
function Toast({ message, type, visible }: ToastState) {
  return (
    <div className={`toast toast-${type} ${visible ? "toast-visible" : "toast-hidden"}`}>
      {type === "success" && <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5}><polyline points="20 6 9 17 4 12"/></svg>}
      {type === "warn"    && <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>}
      {type === "error"   && <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>}
      <span>{message}</span>
    </div>
  );
}

// ─── COM Port Selector ────────────────────────────────────────────────────────

function ComPortSelector({ value, onChange, disabled }: { value:string; onChange:(v:string)=>void; disabled:boolean }) {
  const[isCustom, setIsCustom] = useState(false);
  return (
    <div className="com-port-selector">
      <span className="com-port-label">PORT</span>
      {isCustom
        ? <input type="text" className="com-port-input" value={value} disabled={disabled}
            onChange={e => onChange(e.target.value.toUpperCase())}
            onBlur={() => { if (!value) setIsCustom(false); }} autoFocus maxLength={10} />
        : <select className="com-port-select"
            value={COM_PORTS.includes(value) ? value : "__custom__"}
            onChange={e => { if (e.target.value==="__custom__") setIsCustom(true); else onChange(e.target.value); }}
            disabled={disabled}>
            {COM_PORTS.map(p => <option key={p} value={p}>{p}</option>)}
            <option value="__custom__">Custom…</option>
          </select>
      }
      <div className={`com-port-dot ${disabled ? "com-port-dot-active" : "com-port-dot-idle"}`} />
    </div>
  );
}

// ─── License Gateway ──────────────────────────────────────────────────────────

function LicenseGateway({ onActivated }: { onActivated: (auth: AuthState) => void }) {
  const [licenseKey, setLicenseKey] = useState("");
  const [username,   setUsername]   = useState("");
  const [projectName,setProjectName]= useState("");
  const [error,      setError]      = useState<string|null>(null);
  const [activating, setActivating] = useState(false);
  const [focused,    setFocused]    = useState<string|null>(null);

  const handleActivate = async () => {
    setError(null);
    if (!licenseKey.trim() || !username.trim() || !projectName.trim()) { setError("All fields are required."); return; }
    setActivating(true);
    try {
      await invoke<string>("activate_license", { key:licenseKey.trim(), username:username.trim(), projectName:projectName.trim() });
      const auth = await invoke<AuthState>("get_auth_state");
      onActivated(auth);
    } catch(err) { setError(String(err)); }
    finally { setActivating(false); }
  };

  const inp = (field:string): React.CSSProperties => ({
    width:"100%", padding:"11px 14px", background:"rgba(255,255,255,0.04)",
    border:`1px solid ${focused===field ? "rgba(34,68,240,0.7)" : "rgba(255,255,255,0.1)"}`,
    borderRadius:"7px", color:"#e2e8f0", fontFamily: field==="key" ? "'Share Tech Mono',monospace" : "'Rajdhani',sans-serif",
    fontSize: field==="key" ? "0.72rem" : "0.95rem", fontWeight: field==="key" ? 400 : 600,
    letterSpacing: field==="key" ? "0.06em" : "0.04em", outline:"none",
    boxShadow: focused===field ? "0 0 0 3px rgba(34,68,240,0.15)" : "none", transition:"all 0.2s ease",
  });

  return (
    <div style={{ position:"fixed", inset:0, background:"#050608", backgroundImage:"radial-gradient(circle, rgba(26,31,42,0.8) 1px, transparent 1px)", backgroundSize:"28px 28px", display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999 }}>
      <div style={{ width:"100%", maxWidth:460, background:"linear-gradient(145deg,#0f1318,#0a0c0f)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:"14px", boxShadow:"0 24px 80px rgba(0,0,0,0.8)", overflow:"hidden" }}>
        <div style={{ height:"2px", background:"linear-gradient(90deg,transparent,#2244F0,#00e5a0,transparent)" }} />
        <div style={{ padding:"36px 36px 32px" }}>
          <div style={{ textAlign:"center", marginBottom:"32px" }}>
            <div style={{ width:48, height:48, margin:"0 auto 14px", background:"rgba(34,68,240,0.12)", border:"1px solid rgba(34,68,240,0.3)", borderRadius:"11px", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="#2244F0"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </div>
            <div style={{ fontFamily:"'Rajdhani',sans-serif", fontWeight:700, fontSize:"1.5rem", letterSpacing:"0.08em", color:"#e2e8f0" }}>TechniDAQ</div>
            <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.55rem", letterSpacing:"0.2em", color:"#2a3550", textTransform:"uppercase", marginTop:"4px" }}>License Activation · AES-256-GCM</div>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:"16px" }}>
            <div><div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.52rem", letterSpacing:"0.22em", color:"#4a5c7a", textTransform:"uppercase", marginBottom:"6px" }}>License Key</div><textarea value={licenseKey} rows={3} placeholder="Paste your license key here…" style={{ ...inp("key"), resize:"none", lineHeight:1.6 }} onChange={e => { setLicenseKey(e.target.value); setError(null); }} onFocus={() => setFocused("key")} onBlur={() => setFocused(null)} onKeyDown={e => { if (e.key==="Enter" && !e.shiftKey) { e.preventDefault(); handleActivate(); } }} /></div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"12px" }}>
              {[["user","Username","username","john.smith"],["proj","Project","projectName","Site Alpha"]].map(([f,label,_,ph]) => (
                <div key={f}><div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.52rem", letterSpacing:"0.22em", color:"#4a5c7a", textTransform:"uppercase", marginBottom:"6px" }}>{label}</div><input type="text" placeholder={`e.g. ${ph}`} style={inp(f)} value={f==="user" ? username : projectName} onChange={e => { f==="user" ? setUsername(e.target.value) : setProjectName(e.target.value); setError(null); }} onFocus={() => setFocused(f)} onBlur={() => setFocused(null)} onKeyDown={e => { if (e.key==="Enter") handleActivate(); }} /></div>
              ))}
            </div>
            {error && <div style={{ display:"flex", gap:"8px", alignItems:"flex-start", padding:"10px 12px", background:"rgba(249,115,22,0.08)", border:"1px solid rgba(249,115,22,0.3)", borderRadius:"7px" }}><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#f97316" strokeWidth={2.5} style={{ flexShrink:0, marginTop:1 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.66rem", color:"#fb923c", letterSpacing:"0.04em", lineHeight:1.5 }}>{error}</span></div>}
            <button onClick={handleActivate} disabled={activating} style={{ padding:"12px", background: activating ? "rgba(34,68,240,0.15)" : "linear-gradient(135deg,#1635D4,#2244F0)", border:"1px solid rgba(34,68,240,0.5)", borderRadius:"7px", color: activating ? "#4a5c7a" : "#fff", fontFamily:"'Rajdhani',sans-serif", fontWeight:700, fontSize:"0.85rem", letterSpacing:"0.14em", textTransform:"uppercase", cursor: activating ? "not-allowed":"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:"8px", boxShadow: activating ? "none" : "0 4px 18px rgba(34,68,240,0.35)" }}>{activating ? "Activating…" : "Activate License"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AuthLoadingScreen() {
  return (
    <div style={{ position:"fixed",inset:0,background:"#050608",display:"flex",flexDirection:"column", alignItems:"center",justifyContent:"center",gap:"16px",zIndex:9999 }}>
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#2244F0" strokeWidth={2} style={{ animation:"spin 1s linear infinite", opacity:0.7 }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.58rem", letterSpacing:"0.28em", color:"#2a3550", textTransform:"uppercase" }}>Verifying License…</span>
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────

function Header({ pollState, latestReading, theme, onThemeToggle, onTogglePoll,
  onClear, onExport, exportStatus, comPort, onComPortChange, username, projectName, activeDevice,
  onOpenModal // <-- New function to open setup modal
}: {
  pollState: PollState; latestReading: MeterReading | null; theme: Theme;
  onThemeToggle: () => void; onTogglePoll: () => void;
  onClear: () => void; onExport: () => void; exportStatus: ExportStatus;
  comPort: string; onComPortChange: (v:string) => void;
  username: string; projectName: string; activeDevice: ActiveDevice | null;
  onOpenModal: () => void;
}) {
  const isPolling = pollState === "running" || pollState === "fault";
  const isDark    = theme === "dark";
  const btnBorder = isDark ? "rgba(255,255,255,0.06)" : "rgba(22,53,212,0.1)";
  const textDim   = isDark ? "#4a5c7a"                : "#8fa0cc";

  const timeStr = latestReading
    ? new Date(latestReading.timestamp_ms).toLocaleTimeString("en-GB", { hour12:false })
    : "--:--:--";

  const freq = latestReading
    ? Object.entries(latestReading.data).find(([k]) => k.toLowerCase().includes("frequen"))?.[1]
    : undefined;

  const statusConfig = {
    running: { label:"LIVE",    ledClass:"status-led-running", textClass:"status-text-online"  },
    stopped: { label:"STOPPED", ledClass:"status-led-stopped", textClass:"status-text-stopped" },
    fault:   { label:"FAULT",   ledClass:"status-led-fault",   textClass:"status-text-fault"   },
  }[pollState];

  const deviceLine = activeDevice
    ? `${activeDevice.profile.display_name.toUpperCase()} · RS485 · MODBUS RTU`
    : "UNIVERSAL SCADA PLATFORM";

  const exportLabel = { idle:"Export Excel", saving:"Saving…", success:"Exported!", error:"Failed" }[exportStatus];

  return (
    <header className="app-header">
      <div className="header-brand">
        <div className="logo-fallback" style={{ display:"flex" }}>
          <svg viewBox="0 0 24 24" className="logo-bolt" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        </div>
        <div className="brand-text">
          <div className="brand-name">TechniDAQ</div>
          <div className="brand-sub">by Technicat Group</div>
        </div>
      </div>

      <div className="header-center">
        <div className="device-info-primary">{deviceLine}</div>
        
        <div className="header-com-row">
          {/* Replaced the old full-width horizontal bar with this clean inline button */}
          <button
            onClick={onOpenModal}
            disabled={isPolling}
            style={{
              display:"flex", alignItems:"center", gap:"6px",
              padding:"4px 10px",
              background: isPolling ? "transparent" : (isDark ? "rgba(34,68,240,0.12)" : "rgba(22,53,212,0.07)"),
              border:`1px solid ${isPolling ? btnBorder : (isDark ? "rgba(34,68,240,0.4)" : "rgba(22,53,212,0.3)")}`,
              borderRadius:"6px",
              color: isPolling ? textDim : (isDark ? "#6b8fff" : "#1635D4"),
              fontFamily:"'Rajdhani',sans-serif", fontWeight:700,
              fontSize:"0.65rem", letterSpacing:"0.1em", textTransform:"uppercase",
              cursor: isPolling ? "not-allowed" : "pointer",
              opacity: isPolling ? 0.6 : 1,
              transition:"all 0.15s ease",
            }}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            Configure
          </button>

          <div className="header-com-divider" />

          <div className="device-info-secondary">
            {activeDevice
              ? `SLAVE ${String(activeDevice.slaveId).padStart(2,"0")} · ${activeDevice.profile.baud_rate} BAUD · ${activeDevice.selectedRegisters.length} REGISTERS`
              : "No device configured"
            }
          </div>
          <div className="header-com-divider" />
          <ComPortSelector value={comPort} onChange={onComPortChange} disabled={isPolling} />
        </div>

        {(projectName || username) && (
          <div style={{ display:"flex", alignItems:"center", gap:"8px", marginTop:"2px" }}>
            {projectName && <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.55rem", letterSpacing:"0.16em", color:"#2244F0", textTransform:"uppercase" }}>⬡ {projectName}</span>}
            {username && <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.55rem", letterSpacing:"0.16em", color:"#4a5c7a", textTransform:"uppercase" }}>· {username}</span>}
          </div>
        )}
      </div>

      <div className="header-right">
        {freq !== undefined && (
          <>
            <div className="header-stat">
              <span className="header-stat-label">FREQUENCY</span>
              <span className="header-stat-value">{freq.toFixed(2)} <span className="header-stat-unit">Hz</span></span>
            </div>
            <div className="header-divider" />
          </>
        )}
        <div className="header-stat">
          <span className="header-stat-label">LAST POLL</span>
          <span className="header-stat-value">{timeStr}</span>
        </div>
        <div className="header-divider" />
        <div className="header-status">
          <span className={`status-led ${statusConfig.ledClass}`} />
          <span className={`status-label ${statusConfig.textClass}`}>{statusConfig.label}</span>
        </div>
        <div className="header-divider" />
        <div className="header-controls">
          <button className={`ctrl-btn poll-btn-${pollState}`} onClick={onTogglePoll}>
            {isPolling
              ? <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              : <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            }
            <span>{pollState === "running" ? "Stop" : pollState === "fault" ? "Reset" : "Start"}</span>
          </button>
          <button className="ctrl-btn clear-btn" onClick={onClear}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
            <span>Clear</span>
          </button>
          <button className={`ctrl-btn export-btn export-btn-${exportStatus}`} onClick={onExport} disabled={exportStatus === "saving"}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>{exportLabel}</span>
          </button>
          <button className="ctrl-btn theme-toggle" onClick={onThemeToggle}>
            {theme === "dark"
              ? <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/></svg>
              : <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            }
            <span>{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

// ─── Chart ────────────────────────────────────────────────────────────────────

interface ChartPoint { time: string;[key: string]: string | number }

function ChartSection({ history, chartKeys, theme, pollState }: {
  history:    ChartPoint[];
  chartKeys:  string[];
  theme:      Theme;
  pollState:  PollState;
}) {
  const isDark     = theme === "dark";
  const isStopped  = pollState === "stopped";
  const gridColor  = isDark ? "rgba(255,255,255,0.04)" : "rgba(21,53,212,0.06)";
  const axisColor  = isDark ? "#2a3550" : "#c7d4ee";
  const tickColor  = isDark ? "#4a5c7a" : "#8fa3c8";
  const lineColors =["#2d5ff5","#00d4ff","#f59e0b","#34d399","#c084fc"];

  const key0 = chartKeys[0];
  const key1 = chartKeys[1];

  return (
    <div className="chart-card">
      <div className="chart-card-header">
        <div className="chart-card-title-row">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke={lineColors[0]} strokeWidth={2.5} style={{ flexShrink:0 }}>
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span className="chart-card-title">REAL-TIME WAVEFORM</span>
          <div className="chart-title-accent" style={{ background:`linear-gradient(90deg,${lineColors[0]},${lineColors[1]})` }} />
        </div>
        <div className="chart-card-meta">
          <span className="chart-window-label">WINDOW</span>
          <span className="chart-window-value">{history.length} / {MAX_HISTORY} s</span>
        </div>
      </div>

      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"6px 20px 0", gap:"12px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"12px" }}>
          {chartKeys.slice(0,2).map((k,i) => (
            <div key={k} style={{ display:"flex", alignItems:"center", gap:"6px" }}>
              <div style={{ width:"8px", height:"8px", borderRadius:"50%", background:lineColors[i], boxShadow:`0 0 6px ${lineColors[i]}80` }} />
              <span style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.6rem", color:isDark?"#8fa3c8":"#4a64a8", letterSpacing:"0.08em" }}>{k}</span>
            </div>
          ))}
        </div>
        <span className={`chart-live-badge ${isStopped?"chart-live-badge-stopped":""}`}
          style={{
            borderColor: isStopped ? "rgba(148,163,184,0.25)" : (isDark?"rgba(0,212,255,0.3)":"rgba(21,53,212,0.2)"),
            color: isStopped ? (isDark?"#4a5c7a":"#94a3b8") : (isDark?"#00d4ff":"#1535d4"),
          }}>
          <span className="chart-live-dot" style={{ background: isStopped ? "#4a5c7a" : (isDark?"#00d4ff":"#1535d4"), animationPlayState: isStopped ? "paused":"running" }}/>
          {isStopped ? "PAUSED" : "LIVE"}
        </span>
      </div>

      <div className="chart-area">
        {history.length === 0 ? (
          <div className="chart-empty">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke={tickColor} strokeWidth={1.5}>
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <span style={{ color:tickColor, fontFamily:"'Share Tech Mono',monospace", fontSize:"0.7rem", letterSpacing:"0.2em" }}>
              {isStopped ? "POLLING STOPPED" : chartKeys.length === 0 ? "NO REGISTERS SELECTED" : "AWAITING DATA…"}
            </span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={history} margin={{ top:8, right:16, left:0, bottom:0 }}>
              <CartesianGrid stroke={gridColor} strokeDasharray="4 4" vertical={false} />
              <XAxis dataKey="time" tick={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, fill:tickColor }} axisLine={{ stroke:axisColor }} tickLine={false} interval="preserveStartEnd" minTickGap={60} />
              {key0 && <YAxis yAxisId="l" orientation="left" tick={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, fill:lineColors[0] }} axisLine={false} tickLine={false} width={52} tickFormatter={v => v.toFixed(1)} />}
              {key1 && <YAxis yAxisId="r" orientation="right" tick={{ fontFamily:"'Share Tech Mono',monospace", fontSize:10, fill:lineColors[1] }} axisLine={false} tickLine={false} width={52} tickFormatter={v => v.toFixed(2)} />}
              <Tooltip contentStyle={{ background: isDark ? "rgba(8,12,24,0.97)" : "rgba(255,255,255,0.97)", border: `1px solid ${isDark?"rgba(45,95,245,0.3)":"rgba(21,53,212,0.15)"}`, borderRadius:"8px", padding:"10px 14px", fontFamily:"'Share Tech Mono',monospace", fontSize:"0.65rem" }} cursor={{ stroke:"rgba(255,255,255,0.06)", strokeWidth:1, strokeDasharray:"4 4" }} />
              <Legend wrapperStyle={{ display:"none" }} />
              {key0 && <Line yAxisId="l" type="monotone" dataKey={key0} stroke={lineColors[0]} strokeWidth={2} dot={false} activeDot={{ r:4, fill:lineColors[0] }} isAnimationActive={false} />}
              {key1 && <Line yAxisId="r" type="monotone" dataKey={key1} stroke={lineColors[1]} strokeWidth={2} dot={false} activeDot={{ r:4, fill:lineColors[1] }} isAnimationActive={false} />}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [authState,     setAuthState]     = useState<AuthState | null>(null);
  const[checkingAuth,  setCheckingAuth]  = useState(true);
  const [profiles,      setProfiles]      = useState<MeterProfile[]>([]);
  const [activeDevice,  setActiveDevice]  = useState<ActiveDevice | null>(null);
  const [showModal,     setShowModal]     = useState(false);
  const [latestReading, setLatestReading] = useState<MeterReading | null>(null);
  const[history,       setHistory]       = useState<ChartPoint[]>([]);
  const[pollState,     setPollState]     = useState<PollState>("stopped");
  const [theme,         setTheme]         = useState<Theme>("dark");
  const [exportStatus,  setExportStatus]  = useState<ExportStatus>("idle");
  const [comPort,       setComPort]       = useState("COM3");
  const[toast,         setToast]         = useState<ToastState>({ message:"", type:"success", visible:false });

  const toastRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);

  useEffect(() => {
    invoke<AuthState>("get_auth_state")
      .then(a => { setAuthState(a); setCheckingAuth(false); })
      .catch(() => { setAuthState({ valid:false, allowed_meters:[] }); setCheckingAuth(false); });
  }, []);

  const showToast = useCallback((message:string, type: ToastState["type"]) => {
    if (toastRef.current) clearTimeout(toastRef.current);
    setToast({ message, type, visible:true });
    toastRef.current = setTimeout(() => setToast(t => ({...t, visible:false})), 4000);
  },[]);

  useEffect(() => {
    if (!authState?.valid) return;
    invoke<PollState>("get_status").then(setPollState).catch(console.error);
    if (authState.allowed_meters.length > 0) {
      invoke<MeterProfile[]>("get_meter_profiles", { allowedMeters: authState.allowed_meters })
        .then(setProfiles).catch(console.error);
    }
  },[authState?.valid]);

  useEffect(() => {
    if (!authState?.valid) return;
    const subs: Promise<UnlistenFn>[] =[];
    subs.push(listen<MeterReading>("meter-data", e => {
      const r = e.payload;
      setLatestReading(r);
      const time = new Date(r.timestamp_ms).toLocaleTimeString("en-GB", { hour12:false });
      setHistory(prev => {
        const next = [...prev, { time, ...r.data }];
        return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
      });
    }));
    subs.push(listen<StatusEvent>("status-changed", e => setPollState(e.payload.state)));
    subs.push(listen<FaultEvent>("meter-fault", e => showToast(`⚠ FAULT: ${e.payload.reason}`, "warn")));
    return () => { subs.forEach(p => p.then(fn => fn())); };
  }, [authState?.valid, showToast]);

  const handleSaveConfig = useCallback(async (model: string, slaveId: number, regs: RegisterEntry[]) => {
    try {
      const profile = await invoke<MeterProfile>("apply_device_config", {
        meterModel: model, slaveId, selectedRegisters: regs,
      });
      setActiveDevice({ profile, slaveId, selectedRegisters: regs });
      setShowModal(false);
      showToast(`${profile.display_name} · ${regs.length} registers configured`, "success");
    } catch(err) {
      showToast(`Config failed: ${err}`, "error");
    }
  }, [showToast]);

  const handleTogglePoll = useCallback(async () => {
    if (!activeDevice) { showToast("Configure a device first.", "warn"); return; }
    try {
      const s = await invoke<PollState>("toggle_polling", { comPort: comPort.trim() });
      setPollState(s);
      showToast(s === "running" ? `Polling started on ${comPort}` : "Polling stopped", s === "running" ? "success" : "warn");
    } catch(err) { showToast(`Error: ${err}`, "error"); }
  }, [comPort, activeDevice, showToast]);

  const handleClear = useCallback(async () => {
    try {
      const n = await invoke<number>("clear_history");
      setHistory([]); setLatestReading(null);
      showToast(`Cleared ${n.toLocaleString()} records`, "warn");
    } catch(err) { showToast(`Clear failed: ${err}`, "error"); }
  }, [showToast]);

  const handleExport = useCallback(async () => {
    try {
      setExportStatus("saving");
      const fp = await save({ title:"Export TechniDAQ Data",
        defaultPath:`technidaq_${new Date().toISOString().slice(0,10)}.xlsx`,
        filters:[{ name:"Excel Workbook", extensions:["xlsx"] }] });
      if (!fp) { setExportStatus("idle"); return; }
      const n = await invoke<number>("export_to_excel", { path: fp });
      setExportStatus("success");
      showToast(`Exported ${n.toLocaleString()} records`, "success");
      if (exportRef.current) clearTimeout(exportRef.current);
      exportRef.current = setTimeout(() => setExportStatus("idle"), 2500);
    } catch(err) {
      setExportStatus("error");
      showToast(`Export failed: ${err}`, "error");
      if (exportRef.current) clearTimeout(exportRef.current);
      exportRef.current = setTimeout(() => setExportStatus("idle"), 3000);
    }
  }, [showToast]);

  const chartKeys = useMemo((): string[] => {
    if (!latestReading) return[];
    const keys = Object.keys(latestReading.data);
    const voltKey  = keys.find(k => k.toLowerCase().includes("voltage") && k.toLowerCase().includes("avg"))
      ?? keys.find(k => k.toLowerCase().includes("voltage"));
    const powerKey = keys.find(k => k.toLowerCase().includes("active power total"))
      ?? keys.find(k => k.toLowerCase().includes("active power"))
      ?? keys.find(k => k.toLowerCase().includes("power"));
    return [voltKey, powerKey].filter(Boolean) as string[];
  },[latestReading]);

  const isDark = theme === "dark";

  if (checkingAuth)      return <AuthLoadingScreen />;
  if (!authState?.valid) return <LicenseGateway onActivated={setAuthState} />;

  return (
    <div className="app-root">
      <div className="ambient-glow glow-tl" />
      <div className="ambient-glow glow-br" />
      <Toast {...toast} />

      {showModal && profiles.length > 0 && (
        <DeviceSetupModal
          profiles={profiles}
          initialModel={activeDevice?.profile.model ?? profiles[0]?.model ?? ""}
          initialSlaveId={activeDevice?.slaveId ?? 1}
          initialSelected={activeDevice?.selectedRegisters ?? (profiles[0]?.registers ??[])}
          onSave={handleSaveConfig}
          onClose={() => setShowModal(false)}
          theme={theme}
        />
      )}

      <Header
        pollState={pollState} latestReading={latestReading} theme={theme}
        onThemeToggle={() => setTheme(t => t === "dark" ? "light" : "dark")}
        onTogglePoll={handleTogglePoll} onClear={handleClear}
        onExport={handleExport} exportStatus={exportStatus}
        comPort={comPort} onComPortChange={setComPort}
        username={authState?.username ?? ""}
        projectName={authState?.project_name ?? ""}
        activeDevice={activeDevice}
        onOpenModal={() => setShowModal(true)}
      />

      <main className="app-main">
        <div className="section-label-row">
          <span className="section-label">
            {latestReading
              ? `Live Readings — ${latestReading.device_id}`
              : "Real-Time Measurements"}
          </span>
          <div className="section-divider" />
          <span className="section-meta">Δt = 1.000 s</span>
        </div>

        {latestReading && Object.keys(latestReading.data).length > 0 ? (
          <div style={{
            display:"grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap:"12px", marginBottom:"16px",
          }}>
            {Object.entries(latestReading.data).map(([name, value], idx) => (
              <DynamicCard key={name} name={name} value={value} idx={idx} isDark={isDark} />
            ))}
          </div>
        ) : (
          <div style={{
            height:"120px", display:"flex", alignItems:"center", justifyContent:"center",
            background: isDark ? "rgba(255,255,255,0.02)" : "rgba(22,53,212,0.02)",
            border: `1px solid ${isDark ? "rgba(255,255,255,0.05)" : "rgba(22,53,212,0.08)"}`,
            borderRadius:"10px", marginBottom:"16px",
          }}>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontFamily:"'Share Tech Mono',monospace", fontSize:"0.65rem",
                letterSpacing:"0.2em", color: isDark ? "#2a3550" : "#94a3b8", textTransform:"uppercase" }}>
                {!activeDevice ? "No device configured" : pollState === "stopped" ? "Polling stopped" : "Awaiting data…"}
              </div>
              {!activeDevice && (
                <button onClick={() => setShowModal(true)} style={{
                  marginTop:"10px", padding:"6px 14px",
                  background:"rgba(34,68,240,0.12)", border:"1px solid rgba(34,68,240,0.35)",
                  borderRadius:"6px", color:"#6b8fff", cursor:"pointer",
                  fontFamily:"'Rajdhani',sans-serif", fontWeight:700, fontSize:"0.7rem", letterSpacing:"0.1em",
                }}>Configure Device →</button>
              )}
            </div>
          </div>
        )}

        <ChartSection history={history} chartKeys={chartKeys} theme={theme} pollState={pollState} />

        <div className="status-bar">
          {[
            { label:"Device",   value: activeDevice ? `${activeDevice.profile.model.replace(/_/g," ")} #${String(activeDevice.slaveId).padStart(2,"0")}` : "—" },
            { label:"COM Port", value: comPort || "—" },
            { label:"Baud",     value: activeDevice ? activeDevice.profile.baud_rate.toLocaleString() : "—" },
            { label:"Engine",   value: pollState.toUpperCase(), cls: `engine-chip-${pollState}` },
          ].map(({ label, value, cls }) => (
            <div key={label} className={`status-chip ${cls ?? ""}`}>
              <span className="chip-label">{label}</span>
              <span className="chip-value">{value}</span>
            </div>
          ))}
        </div>

        <div className="sim-notice">
          <div className="sim-line" />
          <span className="sim-text">
            {activeDevice
              ? `RS485 MODBUS RTU · ${activeDevice.profile.display_name} · SLAVE ${activeDevice.slaveId} · FC03 HOLDING REGISTERS · ${activeDevice.profile.endianness} · ${activeDevice.selectedRegisters.length} REGISTERS`
              : "RS485 MODBUS RTU · TechniDAQ Universal SCADA · Configure a device to begin"}
          </span>
          <div className="sim-line" />
        </div>
      </main>
    </div>
  );
}