import { TAB_ACCENTS } from "../theme";
import type { DeviceConfig } from "../types";
import { Settings2 } from "lucide-react";

// ─── BusBar ───────────────────────────────────────────────────────────────────

export default function BusBar({ configuredDevices, onOpenModal, isDark }:{
  configuredDevices:DeviceConfig[];
  onOpenModal:()=>void; isDark:boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-5 h-[38px] shrink-0 bg-zinc-50 dark:bg-[#0a0a0a]/50 backdrop-blur-sm border-b border-zinc-200 dark:border-white/10">
      
      <button 
        onClick={onOpenModal} 
        className="flex items-center gap-1.5 px-3 h-[26px] bg-[#1a5fff]/10 border border-[#1a5fff]/50 rounded-md text-[#1a5fff] font-bold text-[0.7rem] tracking-[0.1em] uppercase hover:bg-[#1a5fff]/20 transition-colors"
      >
        <Settings2 className="w-3 h-3" />
        Configure Bus
      </button>

      {configuredDevices.length > 0 && (
        <>
          <span className="text-zinc-300 dark:text-white/10 text-[0.8rem]">|</span>
          
          {configuredDevices.map((d, i) => (
            <div key={d.device_name} className="flex items-center gap-1.5">
              <div 
                className="w-1.5 h-1.5 rounded-full" 
                style={{ background: TAB_ACCENTS[i % TAB_ACCENTS.length] }} 
              />
              <span className="font-mono text-[0.58rem] text-zinc-500 dark:text-zinc-400 tracking-[0.05em]">
                {d.device_name} · S{d.slave_id} · {d.poll_rate_ms / 1000}s
              </span>
            </div>
          ))}
          
          <span className="ml-auto font-mono text-[0.54rem] text-zinc-400 dark:text-zinc-500">
            {configuredDevices.reduce((s, d) => s + d.selected_registers.length, 0)} registers total
          </span>
        </>
      )}
    </div>
  );
}