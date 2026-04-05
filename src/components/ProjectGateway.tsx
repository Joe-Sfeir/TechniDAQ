import { useState } from "react";
import { invokeApi } from "../api";
import type { OnlineAuthState } from "../types";
import { BackgroundGrid } from "./BackgroundGrid";
import { Folder, Lock, Server, AlertCircle, ArrowRight, Loader2 } from "lucide-react";

// ─── ProjectGateway (cloud builds only) ──────────────────────────────────────

export default function ProjectGateway({
  cloudUrl, onActivated, message,
}:{
  cloudUrl: string;
  onActivated: (state: OnlineAuthState) => void;
  message?: string;
}) {
  const [projectName, setProjectName] = useState("");
  const [projectKey,  setProjectKey]  = useState("");
  const [nodeName,    setNodeName]    = useState("");
  const [error,       setError]       = useState<string|null>(null);
  const [busy,        setBusy]        = useState(false);
  const [pendingPayload, setPendingPayload] = useState<{projectName:string;projectKey:string;nodeName:string}|null>(null);
  const [existingCount,  setExistingCount]  = useState(0);

  const doActivate = async (payload:{projectName:string;projectKey:string;nodeName:string}, clearHistory:boolean) => {
    console.log("[ProjectGateway] doActivate called with payload:", payload);
    setBusy(true);
    setPendingPayload(null);
    try {
      if(clearHistory) {
        console.log("[ProjectGateway] Clearing history first...");
        await invokeApi("clear_history");
      }
      const params = {
        projectName: payload.projectName,
        projectKey:  payload.projectKey,
        nodeName:    payload.nodeName,
        cloudUrl:    cloudUrl,
      };
      console.log("[ProjectGateway] Calling activate_online_project with:", params);
      const result = await invokeApi<OnlineAuthState>("activate_online_project", params);
      console.log("[ProjectGateway] Success! Result:", result);
      onActivated(result);
    } catch(e) {
      console.error("[ProjectGateway] Error:", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const activate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    console.log("[ProjectGateway] activate called");
    setError(null);
    if(!projectName.trim()){ setError("Project Name is required."); return; }
    if(!projectKey.trim())  { setError("Project Key is required.");  return; }
    setBusy(true);
    try {
      const payload = { projectName: projectName.trim(), projectKey: projectKey.trim(), nodeName: nodeName.trim() || "this-node" };
      console.log("[ProjectGateway] Created payload:", payload);
      const count = await invokeApi<number>("get_record_count");
      console.log("[ProjectGateway] Record count:", count);
      if(count > 0){
        setPendingPayload(payload);
        setExistingCount(count);
        setBusy(false);
        return;
      }
      await doActivate(payload, false);
    } catch(e) {
      console.error("[ProjectGateway] activate error:", e);
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#050505] text-white font-sans selection:bg-[#1a5fff]/30 overflow-hidden flex flex-col items-center justify-center p-6 z-[9999]">
      <BackgroundGrid />
      
      <div className="relative z-10 w-full max-w-md bg-white/5 backdrop-blur-2xl border border-white/10 rounded-3xl p-8 md:p-10 shadow-2xl animate-in fade-in slide-in-from-bottom-8 duration-700">
        <div className="absolute top-0 right-0 w-full h-full bg-gradient-to-bl from-[#1a5fff]/10 to-transparent opacity-50 pointer-events-none rounded-3xl"></div>
        
        {/* Brand Header */}
        <div className="flex items-center space-x-4 mb-10 relative z-10">
          <div className="w-10 h-10 bg-[#1a5fff] flex items-center justify-center font-black text-lg tracking-tighter shadow-[0_0_20px_rgba(26,95,255,0.4)] rounded-xl">
            TG
          </div>
          <div>
            <div className="font-bold tracking-[0.15em] text-sm uppercase">Technicat</div>
            <div className="text-[10px] text-zinc-400 tracking-[0.08em] uppercase">Project Activation</div>
          </div>
        </div>

        <div className="relative z-10">
          <h1 className="text-2xl font-bold tracking-tight mb-2 text-white">
            Activate Node
          </h1>
          <p className="text-sm text-zinc-400 mb-8">
            Enter your project details to connect this device
          </p>

          {message && (
            <div className="flex items-center gap-2 p-3 mb-6 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span className="text-xs">{message}</span>
            </div>
          )}

          <form onSubmit={activate} className="space-y-6">
            {/* Project Name */}
            <div>
              <label className="block text-[10px] font-bold tracking-[0.15em] text-zinc-500 uppercase mb-2">Project Name</label>
              <div className="relative">
                <Folder className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                <input 
                  type="text" 
                  required 
                  value={projectName} 
                  onChange={(e) => { setProjectName(e.target.value); setError(null); }} 
                  placeholder="e.g. Site Alpha" 
                  className="w-full bg-black/40 border border-white/10 rounded-xl pl-11 pr-4 py-3 text-white focus:outline-none focus:border-[#1a5fff] transition-colors text-sm"
                />
              </div>
            </div>

            {/* Project Key */}
            <div>
              <label className="block text-[10px] font-bold tracking-[0.15em] text-zinc-500 uppercase mb-2">Project Key</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                <input 
                  type="password" 
                  required 
                  value={projectKey} 
                  onChange={(e) => { setProjectKey(e.target.value); setError(null); }} 
                  placeholder="Paste your project key…" 
                  className="w-full bg-black/40 border border-white/10 rounded-xl pl-11 pr-4 py-3 text-white focus:outline-none focus:border-[#1a5fff] transition-colors text-sm"
                />
              </div>
            </div>

            {/* Node Name */}
            <div>
              <label className="block text-[10px] font-bold tracking-[0.15em] text-zinc-500 uppercase mb-2">
                Node Name <span className="opacity-50 normal-case tracking-normal font-normal">(optional)</span>
              </label>
              <div className="relative">
                <Server className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
                <input 
                  type="text" 
                  value={nodeName} 
                  onChange={(e) => { setNodeName(e.target.value); setError(null); }} 
                  placeholder="e.g. panel-01 (defaults to this-node)" 
                  className="w-full bg-black/40 border border-white/10 rounded-xl pl-11 pr-4 py-3 text-white focus:outline-none focus:border-[#1a5fff] transition-colors text-sm"
                />
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span className="text-xs">{error}</span>
              </div>
            )}

            {pendingPayload ? (
              <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex flex-col gap-4">
                <div className="text-xs text-amber-400 leading-relaxed">
                  {existingCount.toLocaleString()} records from a previous session exist in the database.
                  Keep the existing data or clear it before activating?
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button 
                    type="button"
                    onClick={() => doActivate(pendingPayload, false)} 
                    disabled={busy} 
                    className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-500 font-bold text-xs tracking-wide hover:bg-emerald-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Keep Data
                  </button>
                  <button 
                    type="button"
                    onClick={() => doActivate(pendingPayload, true)} 
                    disabled={busy} 
                    className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-500 font-bold text-xs tracking-wide hover:bg-red-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Clear Data
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="submit" 
                disabled={busy}
                className="w-full flex items-center justify-center gap-2 bg-[#1a5fff] text-white py-4 font-bold tracking-[0.15em] uppercase text-xs hover:bg-blue-600 transition-colors rounded-xl mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? (
                  <Loader2 className="animate-spin h-4 w-4 text-white" />
                ) : (
                  <>Activate Node <ArrowRight className="w-4 h-4" /></>
                )}
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}