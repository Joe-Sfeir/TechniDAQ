// src/App.tsx  — TechniDAQ Phase 5 (High-Contrast Tabbed SCADA Dashboard)
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invokeApi, listenApi, isTauri, type UnlistenFn } from "./api";
// @tauri-apps/plugin-dialog is loaded dynamically so it never executes in a browser.
import "./App.css";

import type {
  DeviceConfig, MeterReading, FaultEvent, StatusEvent, AuthState, DiagEvent,
  BuildInfo, OnlineAuthState, MeterProfile,
  PollState, Theme, ExportStatus, ChartPoint,
} from "./types";
import { LIGHT_THEME, DARK_THEME, TAB_ACCENTS, glass, CLR } from "./theme";
import { MAX_HISTORY } from "./constants";

import AppHeader from "./components/AppHeader";
import BusBar from "./components/BusBar";
import DeviceTabBar from "./components/DeviceTabBar";
import MetricCard from "./components/MetricCard";
import WaveformChart from "./components/WaveformChart";
import Toast from "./components/Toast";
import type { ToastState } from "./components/Toast";
import DiagTerminal from "./components/DiagTerminal";
import type { DiagLine } from "./components/DiagTerminal";
import DeviceSetupModal from "./components/DeviceSetupModal";
import LicenseGateway from "./components/LicenseGateway";
import ProjectGateway from "./components/ProjectGateway";
import LogoutModal from "./components/LogoutModal";
import AuthLoadingScreen from "./components/AuthLoadingScreen";

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [authState,         setAuthState]         = useState<AuthState|null>(null);
  const [checkingAuth,      setCheckingAuth]       = useState(true);
  const [profiles,          setProfiles]           = useState<MeterProfile[]>([]);
  const [configuredDevices, setConfiguredDevices]  = useState<DeviceConfig[]>([]);
  const [showModal,         setShowModal]          = useState(false);
  const [showLogout,        setShowLogout]         = useState(false);
  const [logoutBusy,        setLogoutBusy]         = useState(false);
  const [timeRange,         setTimeRange]          = useState<number|null>(null);
  const [activeTab,         setActiveTab]          = useState<string>("");
  // latestByDevice: device_name → MeterReading
  const [latestByDevice,    setLatestByDevice]     = useState<Record<string,MeterReading>>({});
  // historyByDevice: device_name → ChartPoint[]
  const [historyByDevice,   setHistoryByDevice]    = useState<Record<string,ChartPoint[]>>({});
  const [lastPollMs,        setLastPollMs]         = useState(0);
  const [pollState,         setPollState]          = useState<PollState>("stopped");
  const [updateAvailable,   setUpdateAvailable]    = useState<{version:string;current:string}|null>(null);
  const [updateBusy,        setUpdateBusy]         = useState(false);
  const [updateDismissed,   setUpdateDismissed]    = useState(false);
  const [theme,             setTheme]              = useState<Theme>("dark");
  const [exportStatus,      setExportStatus]       = useState<ExportStatus>("idle");
  const [toast,             setToast]              = useState<ToastState>(
    {message:"",type:"success",visible:false}
  );
  const [showTerminal,      setShowTerminal]       = useState(false);
  const [diagLines,         setDiagLines]          = useState<DiagLine[]>([]);
  // Default false — safe offline assumption until backend confirms cloud build.
  const [isCloudBuild,      setIsCloudBuild]       = useState(false);
  const [cloudUrl,          setCloudUrl]           = useState("");
  const [onlineAuthState,   setOnlineAuthState]    = useState<OnlineAuthState|null>(null);
  const [onlineOffline,     setOnlineOffline]      = useState(false);
  const [gatewayMessage,    setGatewayMessage]     = useState<string|undefined>(undefined);

  const toastRef  = useRef<ReturnType<typeof setTimeout>|null>(null);
  const exportRef = useRef<ReturnType<typeof setTimeout>|null>(null);

  const isDark = theme === "dark";

  useEffect(()=>{ document.documentElement.setAttribute("data-theme",theme); },[theme]);
  useEffect(()=>{
    document.body.style.background = isDark ? DARK_THEME.bg : LIGHT_THEME.bg;
  },[isDark]);

  const showToast = useCallback((message:string, type:ToastState["type"])=>{
    if(toastRef.current)clearTimeout(toastRef.current);
    setToast({message,type,visible:true});
    toastRef.current=setTimeout(()=>setToast(t=>({...t,visible:false})),4000);
  },[]);

  // ── Build type + Auth on startup ──────────────────────────────────────────
  useEffect(()=>{
    invokeApi<BuildInfo>("get_build_info")
      .then(b=>{
        setIsCloudBuild(b.is_cloud_build);
        setCloudUrl(b.cloud_url ?? "");
        if(b.is_cloud_build){
          // Online path: check persisted auth, then verify with server
          invokeApi<OnlineAuthState>("get_online_auth_state")
            .then(oas=>{
              if(oas.valid){
                invokeApi<{
                  active: boolean;
                  offline?: boolean;
                  reason?: string;
                  config_version?: number;
                  desired_config?: { allowed_meters?: string[]; protocols?: string; tier?: number };
                }>("check_online_status")
                  .then(status=>{
                    if(status.active){
                      // Re-fetch from SQLite so we pick up any desired_config the
                      // backend just wrote (updated allowed_meters / tier / protocols).
                      invokeApi<OnlineAuthState>("get_online_auth_state")
                        .then(fresh=>setOnlineAuthState(fresh))
                        .catch(()=>setOnlineAuthState(oas)); // fallback to cached
                      if(status.offline) setOnlineOffline(true);
                    } else {
                      setOnlineAuthState({...oas, valid:false});
                      setGatewayMessage(status.reason ?? "Project deactivated.");
                    }
                  })
                  .catch(()=>{
                    // Network error — stay online with cached config
                    setOnlineAuthState(oas);
                    setOnlineOffline(true);
                  })
                  .finally(()=>setCheckingAuth(false));
              } else {
                setOnlineAuthState(oas); // valid:false → show ProjectGateway
                setCheckingAuth(false);
              }
            })
            .catch(()=>setCheckingAuth(false));
        } else {
          // Offline path — existing flow unchanged
          invokeApi<AuthState>("get_auth_state")
            .then(a=>{setAuthState(a);setCheckingAuth(false);})
            .catch(()=>{setAuthState({valid:false,allowed_meters:[]});setCheckingAuth(false);});
        }
      })
      .catch(()=>{
        // get_build_info failed — safe fallback to offline flow
        invokeApi<AuthState>("get_auth_state")
          .then(a=>{setAuthState(a);setCheckingAuth(false);})
          .catch(()=>{setAuthState({valid:false,allowed_meters:[]});setCheckingAuth(false);});
      });
  },[]);

  useEffect(()=>{
    const valid   = isCloudBuild ? onlineAuthState?.valid : authState?.valid;
    const meters  = isCloudBuild ? (onlineAuthState?.allowed_meters ?? []) : (authState?.allowed_meters ?? []);
    if(!valid)return;
    invokeApi<PollState>("get_status").then(setPollState).catch(console.error);
    if(meters.length>0){
      invokeApi<MeterProfile[]>("get_meter_profiles",{allowedMeters:meters})
        .then(setProfiles)
        .catch(e=>showToast(`Failed to load profiles: ${e}`,"error"));
    }
    // Restore persisted bus config (devices + alarm thresholds) from SQLite.
    invokeApi<DeviceConfig[]>("get_saved_bus_config")
      .then(devices=>{
        if(devices.length>0){
          setConfiguredDevices(devices);
          setActiveTab(t=>t||devices[0].device_name);
          // Populate charts with previous-session readings immediately.
          Promise.all(
            devices.map(d=>
              invokeApi<MeterReading[]>("get_recent_history",{deviceName:d.device_name,limit:60})
                .catch(()=>[] as MeterReading[])
            )
          ).then(results=>{
            const histPatch: Record<string,ChartPoint[]>  = {};
            const latestPatch: Record<string,MeterReading> = {};
            devices.forEach((d,i)=>{
              const rows=results[i];
              if(!rows.length)return;
              histPatch[d.device_name]=rows.map(r=>({
                time:new Date(r.timestamp_ms).toLocaleTimeString("en-GB",{hour12:false}),
                ...r.data,
              }));
              latestPatch[d.device_name]=rows[rows.length-1];
            });
            if(Object.keys(histPatch).length){
              setHistoryByDevice(prev=>({...prev,...histPatch}));
              setLatestByDevice(prev=>({...prev,...latestPatch}));
            }
          });
        }
      })
      .catch(console.error);
  },[authState?.valid, onlineAuthState?.valid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Web-client mirror sync ────────────────────────────────────────────────
  // When running in a browser (phone/tablet), pull a snapshot of the current
  // desktop state and then keep it live via WebSocket.
  useEffect(()=>{
    const activeValid = isCloudBuild ? onlineAuthState?.valid : authState?.valid;
    if(isTauri || !activeValid) return;

    const base = `http://${window.location.hostname}:3030`;

    // Initial snapshot: configured devices + poll state.
    fetch(`${base}/api/status`, { method:"POST", headers:{"Content-Type":"application/json"}, body:"{}" })
      .then(r=>r.json())
      .then((data:{configured_devices:DeviceConfig[];poll_state:PollState})=>{
        if(data.configured_devices?.length){
          setConfiguredDevices(data.configured_devices);
          setActiveTab(data.configured_devices[0].device_name);
        }
        if(data.poll_state) setPollState(data.poll_state);
      })
      .catch(e=>console.warn("[mirror] status fetch failed:", e));

    // WebSocket: receive STATE_CHANGE broadcasts from the host machine.
    const ws = new WebSocket(`ws://${window.location.hostname}:3030/ws`);
    ws.onopen    = ()  => console.log("[mirror] WebSocket connected");
    ws.onmessage = (ev)=> {
      try {
        const msg = JSON.parse(ev.data) as {
          type: string;
          configured_devices?: DeviceConfig[];
          poll_state?: PollState;
          device_name?: string;
          device_id?: string;
          timestamp_ms?: number;
          data?: Record<string, number>;
        };
        if(msg.type === "STATE_CHANGE"){
          if(msg.configured_devices){
            setConfiguredDevices(msg.configured_devices);
            if(msg.configured_devices.length) setActiveTab(t=>t||msg.configured_devices![0].device_name);
          }
          if(msg.poll_state) setPollState(msg.poll_state);
        } else if(msg.type === "METER_DATA" && msg.device_name && msg.data){
          const r: MeterReading = {
            device_name: msg.device_name,
            device_id: msg.device_id ?? "",
            timestamp_ms: msg.timestamp_ms ?? Date.now(),
            data: msg.data,
          };
          setLastPollMs(r.timestamp_ms);
          setLatestByDevice(prev=>({...prev,[r.device_name]:r}));
          const time=new Date(r.timestamp_ms).toLocaleTimeString("en-GB",{hour12:false});
          setHistoryByDevice(prev=>{
            const old=prev[r.device_name]??[];
            const next=[...old];
            if(next.length>0&&next[next.length-1].time===time)
              next[next.length-1]={...next[next.length-1],...r.data};
            else next.push({time,...r.data});
            return {...prev,[r.device_name]:next.length>MAX_HISTORY?next.slice(-MAX_HISTORY):next};
          });
        }
      } catch { /* ignore malformed frames */ }
    };
    ws.onerror = (e)=> console.warn("[mirror] WebSocket error:", e);

    return ()=>{ ws.close(); };
  },[isTauri, authState?.valid, onlineAuthState?.valid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Events ────────────────────────────────────────────────────────────────
  useEffect(()=>{
    const valid = isCloudBuild ? onlineAuthState?.valid : authState?.valid;
    if(!valid)return;
    const subs:Promise<UnlistenFn>[]=[];

    subs.push(listenApi<MeterReading>("meter-data",e=>{
      const r=e.payload;
      setLastPollMs(r.timestamp_ms);
      setLatestByDevice(prev=>({...prev,[r.device_name]:r}));
      const time=new Date(r.timestamp_ms).toLocaleTimeString("en-GB",{hour12:false});
      setHistoryByDevice(prev=>{
        const old=prev[r.device_name]??[];
        const next=[...old];
        if(next.length>0&&next[next.length-1].time===time)
          next[next.length-1]={...next[next.length-1],...r.data};
        else next.push({time,...r.data});
        return {...prev,[r.device_name]:next.length>MAX_HISTORY?next.slice(-MAX_HISTORY):next};
      });
    }));
    subs.push(listenApi<StatusEvent>("status-changed",e=>setPollState(e.payload.state)));
    subs.push(listenApi<FaultEvent>("meter-fault",e=>
      showToast(`⚠ ${e.payload.device_name}: ${e.payload.reason}`,"warn")));
    subs.push(listenApi<{reason:string}>("project-deactivated",e=>{
      setOnlineAuthState(s=>s?{...s,valid:false}:null);
      setGatewayMessage(e.payload.reason);
    }));
    subs.push(listenApi<DiagEvent>("diag-frame", e=>{
      const p = e.payload;
      setDiagLines(prev=>{
        const line: DiagLine = { direction:p.direction, hex:p.hex, device_name:p.device_name, ts:p.timestamp_ms };
        const next = [...prev, line];
        return next.length > 500 ? next.slice(-500) : next;
      });
    }));
    subs.push(listenApi<{source:string;config_version:string}>("config-updated", async ()=>{
      const devices = await invokeApi<DeviceConfig[]>("get_saved_bus_config").catch(()=>[] as DeviceConfig[]);
      if(devices.length>0) setConfiguredDevices(devices);
      showToast("Configuration updated remotely by administrator","success");
    }));
    subs.push(listenApi<{reason:string}>("config-rollback", async ()=>{
      const devices = await invokeApi<DeviceConfig[]>("get_saved_bus_config").catch(()=>[] as DeviceConfig[]);
      if(devices.length>0) setConfiguredDevices(devices);
      showToast("Remote configuration failed \u2014 rolled back to previous config","warn");
    }));
    subs.push(listenApi("profiles-updated", async ()=>{
      const meters = isCloudBuild
        ? (onlineAuthState?.allowed_meters ?? [])
        : (authState?.allowed_meters ?? []);
      if(meters.length>0){
        const updated = await invokeApi<MeterProfile[]>("get_meter_profiles",{allowedMeters:meters}).catch(()=>[] as MeterProfile[]);
        if(updated.length>0) setProfiles(updated);
      }
      showToast("Meter profiles updated by administrator","success");
    }));
    subs.push(listenApi("project-settings-updated", async ()=>{
      const fresh = await invokeApi<OnlineAuthState>("get_online_auth_state").catch(()=>null);
      if(fresh) setOnlineAuthState(fresh);
      showToast("Project settings updated by administrator","success");
    }));
    subs.push(listenApi<{version:string;current:string}>("update-available", e=>{
      setUpdateAvailable(e.payload);
    }));

    return ()=>{subs.forEach(p=>p.then(fn=>fn()));};
  },[isCloudBuild,authState?.valid,onlineAuthState?.valid,showToast]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Save bus config ───────────────────────────────────────────────────────
  const handleSaveBusConfig = useCallback(async (devices:DeviceConfig[])=>{
    try {
      const confirmed = await invokeApi<DeviceConfig[]>("apply_bus_config",{devices});
      setConfiguredDevices(confirmed);
      // Auto-select first tab
      if(confirmed.length>0)setActiveTab(confirmed[0].device_name);
      setShowModal(false);
      const keepNames = new Set(confirmed.map(d => d.device_name));
      setLatestByDevice(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => keepNames.has(k))));
      setHistoryByDevice(prev => Object.fromEntries(Object.entries(prev).filter(([k]) => keepNames.has(k))));
      const totalRegs=confirmed.reduce((s,d)=>s+d.selected_registers.length,0);
      showToast(`${confirmed.length} device${confirmed.length>1?"s":""} configured · ${totalRegs} registers`,"success");
    } catch(e){showToast(`Config error: ${e}`,"error");}
  },[showToast]);

  // ── Poll toggle ───────────────────────────────────────────────────────────
  const handleTogglePoll = useCallback(async ()=>{
    if(configuredDevices.length===0){showToast("Configure bus devices first.","warn");return;}
    try {
      const s=await invokeApi<PollState>("toggle_polling",{});
      setPollState(s);
      showToast(s==="running"
        ?`Polling ${configuredDevices.length} device(s)`
        :"Polling stopped",
        s==="running"?"success":"warn");
    } catch(e){showToast(`Error: ${e}`,"error");}
  },[configuredDevices,showToast]);

  // ── Clear ─────────────────────────────────────────────────────────────────
  const handleClear = useCallback(async ()=>{
    try {
      const n=await invokeApi<number>("clear_history");
      setLatestByDevice({});setHistoryByDevice({});
      showToast(`Cleared ${n.toLocaleString()} records`,"warn");
    } catch(e){showToast(`Clear failed: ${e}`,"error");}
  },[showToast]);

  // ── Export ────────────────────────────────────────────────────────────────
  const handleExport = useCallback(async (target:string|null)=>{
    const rangeLabel = timeRange === null       ? "all"
                     : timeRange <= 300         ? "live"
                     : timeRange <= 3600        ? "1h"
                     : timeRange <= 86400       ? "24h"
                     :                           "7d";
    const dateSuffix = new Date().toISOString().slice(0,10);
    const defaultName = target
      ? `${target.replace(/\s+/g,"_")}_${rangeLabel}_${dateSuffix}.xlsx`
      : `technidaq_all_${rangeLabel}_${dateSuffix}.xlsx`;
    try {
      setExportStatus("saving");
      if (!isTauri) { setExportStatus("error"); setTimeout(()=>setExportStatus("idle"),2500); return; }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const fp = await save({
        title: target ? `Export — ${target}` : "Export All Meters",
        defaultPath: defaultName,
        filters:[{name:"Excel Workbook",extensions:["xlsx"]}],
      });
      if(!fp){setExportStatus("idle");return;}
      const n = await invokeApi<number>("export_to_excel",{
        path:              fp,
        targetDevice:      target ?? null,
        timeRangeSeconds:  timeRange ?? null,
        username:          isCloudBuild ? (onlineAuthState?.node_name ?? "") : (authState?.username ?? ""),
        projectName:       isCloudBuild ? (onlineAuthState?.project_name ?? "") : (authState?.project_name ?? ""),
      });
      setExportStatus("success");
      showToast(`Exported ${n.toLocaleString()} records${target?` — ${target}`:""}`, "success");
      if(exportRef.current)clearTimeout(exportRef.current);
      exportRef.current=setTimeout(()=>setExportStatus("idle"),2500);
    } catch(e){
      setExportStatus("error");
      showToast(`Export failed: ${e}`,"error");
      if(exportRef.current)clearTimeout(exportRef.current);
      exportRef.current=setTimeout(()=>setExportStatus("idle"),3000);
    }
  },[timeRange, authState, showToast]);

  // ── Logout ────────────────────────────────────────────────────────────────
  const handleLogout = useCallback(async ()=>{
    setLogoutBusy(true);
    try {
      if(isCloudBuild){
        await invokeApi("logout_online");
        setOnlineAuthState(prev => prev ? {...prev, valid:false} : null);
      } else {
        await invokeApi("logout_user");
        setAuthState({valid:false, allowed_meters:[]});
      }
      // Reset all runtime state — history intentionally preserved in DB
      setConfiguredDevices([]);
      setProfiles([]);
      setLatestByDevice({});
      setHistoryByDevice({});
      setActiveTab("");
      setPollState("stopped");
      setShowLogout(false);
    } catch(e){
      showToast(`Logout failed: ${e}`,"error");
    } finally {
      setLogoutBusy(false);
    }
  },[isCloudBuild, showToast]);

  // ── Derive active meters list (works for both auth paths) ─────────────────
  const activeMeters: string[] = isCloudBuild
    ? (onlineAuthState?.allowed_meters ?? [])
    : (authState?.allowed_meters ?? []);

  // ── Simulation flag ───────────────────────────────────────────────────────
  const isSimulation = activeMeters.includes("Simulation");

  // ── Diagnostics flag ──────────────────────────────────────────────────────
  const hasDiagnostics = activeMeters.includes("Diagnostics");

  // ── Cloud / advanced telemetry flag ───────────────────────────────────────
  const isCloudEnabled = isCloudBuild
    ? true  // cloud builds are always cloud-enabled
    : (authState?.mode === "online" && (authState?.tier ?? 1) >= 2);

  // ── Enable/disable diagnostics when terminal is toggled ───────────────────
  useEffect(()=>{
    const valid = isCloudBuild ? onlineAuthState?.valid : authState?.valid;
    if (!valid) return;
    invokeApi("set_diagnostics_enabled", { enabled: showTerminal }).catch(console.error);
  }, [showTerminal, authState?.valid, onlineAuthState?.valid]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Active tab device ─────────────────────────────────────────────────────
  const activeDevice = configuredDevices.find(d=>d.device_name===activeTab);
  const activeTabIdx = configuredDevices.findIndex(d=>d.device_name===activeTab);
  const tabAccent    = TAB_ACCENTS[activeTabIdx >= 0 ? activeTabIdx % TAB_ACCENTS.length : 0];

  const activeLatest  = activeTab ? (latestByDevice[activeTab]?.data??{}) : {};
  const activeHistory = activeTab ? (historyByDevice[activeTab]??[])        : [];

  // Chart keys: all selected registers for the active tab
  const chartKeys = useMemo(()=>{
    if(!activeDevice)return [];
    return activeDevice.selected_registers.map(r=>r.name);
  },[activeDevice]);

  // ── Guards ────────────────────────────────────────────────────────────────
  if (checkingAuth) return <AuthLoadingScreen/>;
  if (isCloudBuild) {
    if (!onlineAuthState?.valid) return (
      <ProjectGateway
        cloudUrl={cloudUrl}
        onActivated={state=>{setOnlineAuthState(state);setGatewayMessage(undefined);setOnlineOffline(false);}}
        message={gatewayMessage}
      />
    );
  } else {
    if (!authState?.valid) return <LicenseGateway onActivated={setAuthState}/>;
  }

  return (
    <div className="tdaq-page" style={{
      display:"flex", flexDirection:"column", height:"100vh", overflow:"hidden",
    }}>
      <Toast {...toast}/>

      {showModal && (
        <DeviceSetupModal
          profiles={profiles}
          initialDevices={configuredDevices}
          onSave={handleSaveBusConfig}
          onClose={()=>setShowModal(false)}
          theme={theme}
          licensedProtocols={isCloudBuild ? (onlineAuthState?.protocols as "RTU"|"TCP"|"All"|undefined) : authState?.protocols}
          isCloudEnabled={isCloudEnabled}
          isCloudBuild={isCloudBuild}
        />
      )}

      {showLogout && (
        <LogoutModal
          username={isCloudBuild ? (onlineAuthState?.node_name??"") : (authState?.username??"")}
          projectName={isCloudBuild ? (onlineAuthState?.project_name??"") : (authState?.project_name??"")}
          onConfirm={handleLogout}
          onClose={()=>setShowLogout(false)}
          theme={theme}
          busy={logoutBusy}
        />
      )}

      <AppHeader
        pollState={pollState} lastPollMs={lastPollMs} theme={theme}
        onThemeToggle={()=>setTheme(t=>t==="dark"?"light":"dark")}
        onTogglePoll={handleTogglePoll} onClear={handleClear}
        onExport={handleExport} exportStatus={exportStatus}
        username={authState?.username??""}
        projectName={authState?.project_name??""}
        onLogout={()=>setShowLogout(true)}
        configuredDevices={configuredDevices}
        activeDeviceName={activeDevice?.device_name}
        isSimulation={isSimulation}
        onOpenTerminal={()=>setShowTerminal(t=>!t)}
        hasDiagnostics={hasDiagnostics}
        licenseMode={authState?.mode}
        licenseTier={authState?.tier}
        isCloudBuild={isCloudBuild}
        cloudRegistered={authState?.cloud_registered}
        onlineAuthState={onlineAuthState}
        onlineOffline={onlineOffline}
      />

      <BusBar
        configuredDevices={configuredDevices}
        onOpenModal={()=>setShowModal(true)}
        isDark={isDark}
      />

      <DeviceTabBar
        devices={configuredDevices}
        activeTab={activeTab}
        onSelect={setActiveTab}
        pollState={pollState}
        isDark={isDark}
      />

      {/* ── Main scrollable content ─────────────────────────────────────── */}
      <main style={{
        flex:"1 1 0", overflowY:"auto", padding:"20px",
        display:"flex", flexDirection:"column", gap:"16px",
      }}>

        {isCloudBuild && updateAvailable && !updateDismissed && (
          <div style={{
            display:"flex", alignItems:"center", gap:"12px",
            padding:"10px 16px",
            background:isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim,
            border:`1px solid ${isDark ? DARK_THEME.accent+"35" : LIGHT_THEME.accent+"35"}`,
            borderRadius:"8px",
            fontFamily:"'Share Tech Mono',monospace", fontSize:"0.65rem",
            letterSpacing:"0.06em", color:isDark ? DARK_THEME.accent : LIGHT_THEME.accent,
          }}>
            <span style={{flex:1}}>
              UPDATE AVAILABLE — v{updateAvailable.version} &nbsp;(current: v{updateAvailable.current})
            </span>
            <button
              onClick={async ()=>{
                setUpdateBusy(true);
                try { await invokeApi("install_update"); }
                catch(e){ showToast(`Update failed: ${e}`,"error"); setUpdateBusy(false); }
              }}
              disabled={updateBusy}
              style={{ padding:"5px 12px", background:isDark ? DARK_THEME.accent : LIGHT_THEME.accent,
                border:"none", borderRadius:"6px", color:"#fff",
                fontFamily:"'Rajdhani',sans-serif", fontWeight:700,
                fontSize:"0.75rem", cursor:updateBusy?"not-allowed":"pointer" }}
            >{updateBusy ? "Downloading…" : "Install Now"}</button>
            <button
              onClick={()=>setUpdateDismissed(true)}
              disabled={updateBusy}
              style={{ padding:"5px 10px", background:"transparent",
                border:`1px solid ${isDark ? DARK_THEME.accent+"35" : LIGHT_THEME.accent+"35"}`, borderRadius:"6px",
                color:isDark ? DARK_THEME.accent : LIGHT_THEME.accent, fontFamily:"'Rajdhani',sans-serif", fontWeight:600,
                fontSize:"0.75rem", cursor:"pointer" }}
            >Later</button>
          </div>
        )}

        {configuredDevices.length === 0 ? (
          /* ── No devices empty state ──────────────────────────────────── */
          <div style={{
            flex:1, display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            <div style={{ textAlign:"center" }}>
              <div style={{ width:56,height:56,background:isDark ? DARK_THEME.accentDim : LIGHT_THEME.accentDim,
                border:`1px solid ${isDark ? DARK_THEME.accent+"30" : LIGHT_THEME.accent+"30"}`,borderRadius:"14px",
                display:"flex",alignItems:"center",justifyContent:"center",
                margin:"0 auto 16px" }}>
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none"
                  stroke={isDark ? DARK_THEME.accent : LIGHT_THEME.accent} strokeWidth={1.5}>
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
                </svg>
              </div>
              <div style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,fontSize:"1.1rem",
                color:isDark ? DARK_THEME.text : LIGHT_THEME.text,letterSpacing:"0.04em",marginBottom:"6px" }}>
                No Bus Configured
              </div>
              <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.62rem",
                color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,letterSpacing:"0.1em",marginBottom:"20px" }}>
                Add your RS485 devices to begin monitoring
              </div>
              <button onClick={()=>setShowModal(true)} style={{
                padding:"10px 24px",background:isDark ? DARK_THEME.accent : LIGHT_THEME.accent,border:"none",
                borderRadius:"8px",color:"#fff",cursor:"pointer",
                fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
                fontSize:"0.82rem",letterSpacing:"0.1em",
                boxShadow:`0 4px 14px ${isDark ? DARK_THEME.accent : LIGHT_THEME.accent}44`,
              }}>Configure Bus →</button>
            </div>
          </div>

        ) : activeDevice ? (
          <>
            {/* ── Section header ──────────────────────────────────────── */}
            <div style={{ display:"flex",alignItems:"center",gap:"10px" }}>
              <div style={{ width:"3px",height:"18px",borderRadius:"2px",background:tabAccent }}/>
              <span style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
                fontSize:"0.82rem",letterSpacing:"0.14em",textTransform:"uppercase",
                color:isDark ? DARK_THEME.text : LIGHT_THEME.text }}>
                {activeDevice.device_name}
              </span>
              <span style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.58rem",
                color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,letterSpacing:"0.06em" }}>
                {activeDevice.meter_model.replace(/_/g," ")} · Slave {activeDevice.slave_id}
                · {activeDevice.poll_rate_ms/1000}s · {activeDevice.selected_registers.length} registers
              </span>
              <div style={{ flex:1,height:"1px",background:isDark ? DARK_THEME.border : LIGHT_THEME.border }}/>
            </div>

            {/* ── Metric cards: auto-fill, stretch to full width ───────── */}
            <div style={{
              display:"grid",
              gridTemplateColumns:"repeat(auto-fill, minmax(160px, 1fr))",
              gap:"10px",
            }}>
              {activeDevice.selected_registers.map((reg,i)=>{
                const sparkData = activeHistory.map(pt=>typeof pt[reg.name]==="number" ? pt[reg.name] as number : NaN)
                                               .filter(v=>!isNaN(v)).slice(-20);
                return (
                  <MetricCard
                    key={reg.name} name={reg.name}
                    value={activeLatest[reg.name]}
                    idx={i} isDark={isDark}
                    sparkData={sparkData}
                    minAlarm={reg.min_alarm}
                    maxAlarm={reg.max_alarm}
                  />
                );
              })}
            </div>

            {/* ── Timeframe selector ───────────────────────────────────── */}
            {(()=>{
              const ranges:[string, number|null][] = [
                ["Live",    300],
                ["1 Hour",  3600],
                ["24 Hours",86400],
                ["7 Days",  604800],
                ["All",     null],
              ];
              const rangeLabel = ranges.find(([,v])=>v===timeRange)?.[0] ?? "All";
              return (
                <div style={{
                  display:"flex", alignItems:"center", gap:"6px",
                  ...glass(isDark), padding:"6px 10px", flexShrink:0,
                }}>
                  <span style={{
                    fontFamily:"'Share Tech Mono',monospace", fontSize:"0.5rem",
                    letterSpacing:"0.2em", textTransform:"uppercase",
                    color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2, marginRight:"4px", whiteSpace:"nowrap",
                  }}>Export Range</span>
                  {ranges.map(([label, val])=>{
                    const active = val === timeRange;
                    return (
                      <button key={label} onClick={()=>setTimeRange(val)} style={{
                        padding:"3px 12px", height:"26px",
                        borderRadius:"5px",
                        background: active ? tabAccent+"22" : "transparent",
                        border:`1px solid ${active ? tabAccent+"66" : isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
                        color: active ? tabAccent : isDark ? DARK_THEME.muted : LIGHT_THEME.muted,
                        fontFamily:"'Rajdhani',sans-serif",
                        fontWeight: active ? 700 : 500,
                        fontSize:"0.72rem", letterSpacing:"0.06em",
                        cursor:"pointer", whiteSpace:"nowrap",
                        transition:"all 0.12s ease",
                      }}>{label}</button>
                    );
                  })}
                  <div style={{ flex:1 }}/>
                  <span style={{
                    fontFamily:"'Share Tech Mono',monospace", fontSize:"0.54rem",
                    letterSpacing:"0.1em", color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
                  }}>
                    Export will use: <span style={{ color:tabAccent }}>{rangeLabel}</span>
                  </span>
                </div>
              );
            })()}

            {/* ── Waveform chart ────────────────────────────────────────── */}
            <WaveformChart
              history={activeHistory}
              chartKeys={chartKeys}
              pollState={pollState}
              tabAccent={tabAccent}
              isDark={isDark}
            />
          </>

        ) : (
          /* ── Tab selected but activeDevice not found (shouldn't happen) */
          <div style={{ textAlign:"center",padding:"40px",
            fontFamily:"'Share Tech Mono',monospace",fontSize:"0.64rem",
            color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,letterSpacing:"0.14em" }}>
            Select a device tab above
          </div>
        )}

        {/* ── Status bar ─────────────────────────────────────────────────── */}
        <div style={{
          display:"flex",alignItems:"center",gap:"0",
          ...glass(isDark),
          overflow:"hidden",
          flexShrink:0,
        }}>
          {[
            {label:"Device",  value:activeDevice?.device_name??"—"},
            {label:"Protocol",   value:isSimulation?"SIM":activeDevice?.protocol?.toUpperCase()??"—",
              color:isSimulation?CLR.amber:undefined},
            {label:"Connection", value:isSimulation?"—":activeDevice
              ? (activeDevice.protocol==="tcp"
                  ? `${activeDevice.ip_address}:${activeDevice.tcp_port}`
                  : `${activeDevice.com_port} / ${activeDevice.baud_rate}`)
              : "—"},
            {label:"Engine",  value:isSimulation&&pollState==="running"?"SIMULATION":pollState.toUpperCase(),
              color:isSimulation&&pollState==="running"?CLR.amber:pollState==="running"?CLR.green:pollState==="fault"?CLR.red:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2},
          ].map(({label,value,color},i,arr)=>(
            <div key={label} style={{
              flex:1,padding:"8px 14px",
              borderRight:i<arr.length-1?`1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`:"none",
            }}>
              <div style={{ fontFamily:"'Share Tech Mono',monospace",fontSize:"0.5rem",
                letterSpacing:"0.2em",textTransform:"uppercase",color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
                marginBottom:"3px" }}>{label}</div>
              <div style={{ fontFamily:"'Rajdhani',sans-serif",fontWeight:700,
                fontSize:"0.85rem",letterSpacing:"0.05em",
                color:color??isDark ? DARK_THEME.text : LIGHT_THEME.text }}>{value}</div>
            </div>
          ))}
        </div>

      </main>

      {showTerminal && (
        <DiagTerminal lines={diagLines} onClose={()=>setShowTerminal(false)} isDark={isDark}/>
      )}
    </div>
  );
}
