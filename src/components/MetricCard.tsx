import { ResponsiveContainer, LineChart, Line } from "recharts";
import { regPalette, glass, DARK_THEME, LIGHT_THEME, CLR } from "../theme";

// ─── MetricCard ───────────────────────────────────────────────────────────────

export default function MetricCard({ name, value, idx, isDark, sparkData, minAlarm, maxAlarm }:{
  name:string; value:number|undefined; idx:number; isDark:boolean;
  sparkData?: number[]; minAlarm?: number; maxAlarm?: number;
}) {
  const p      = regPalette(name, idx);
  const hasVal = value !== undefined && !isNaN(value);
  const abs    = hasVal ? Math.abs(value!) : 0;
  const display = hasVal
    ? (abs>=10000 ? value!.toFixed(0) : abs>=100 ? value!.toFixed(1)
       : abs>=1   ? value!.toFixed(2) : value!.toFixed(4))
    : "——";

  const isOverMax  = maxAlarm != null && hasVal && value! > maxAlarm;
  const isUnderMin = minAlarm != null && hasVal && value! < minAlarm;
  const alarmColor = isOverMax ? CLR.red : isUnderMin ? CLR.amber : undefined;

  return (
    <div style={{
      ...glass(isDark),
      padding:      "0",
      display:      "flex", flexDirection:"column",
      minWidth:     0, overflow:"hidden",
      position:     "relative",
      transition:   "box-shadow 0.2s ease",
      animation: alarmColor ? `${isOverMax ? "alarm-red" : "alarm-amber"} 1.2s ease-in-out infinite` : undefined,
      border: alarmColor ? `1px solid ${alarmColor}` : undefined,
    }}>
      {/* Delicate top accent line */}
      <div style={{
        height:"2px", width:"100%", flexShrink:0,
        background:`linear-gradient(90deg, ${p.border}, ${p.border}88, transparent)`,
      }}/>

      <div style={{ padding:"14px 16px 14px", display:"flex", flexDirection:"column", gap:"8px" }}>
        {/* Label */}
        <div style={{
          fontSize:"0.6rem", fontFamily:"'Share Tech Mono',monospace",
          letterSpacing:"0.18em", textTransform:"uppercase",
          color:isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
          whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis",
        }}>{name}</div>

        {/* Value — maximum legibility */}
        <div style={{
          fontSize:"1.75rem", fontWeight:700,
          fontFamily:"'Share Tech Mono',monospace",
          letterSpacing:"-0.03em", lineHeight:1,
          color: hasVal ? isDark ? DARK_THEME.text : LIGHT_THEME.text : isDark ? DARK_THEME.muted2 : LIGHT_THEME.muted2,
        }}>{display}</div>

        {/* Accent progress bar */}
        <div style={{ height:"2px", borderRadius:"1px",
          background:isDark ? "#1a1a1a" : "#f1f5f9", overflow:"hidden" }}>
          {hasVal && (
            <div style={{
              height:"100%", borderRadius:"1px",
              width:`${Math.min(100,(Math.abs(value!)/500)*100)}%`,
              background:`linear-gradient(90deg,${p.border},${p.border}99)`,
              transition:"width 0.5s ease",
            }}/>
          )}
        </div>
      </div>

      {sparkData && sparkData.length > 1 && (
        <div style={{ padding:"0 16px 10px", marginTop:"-4px" }}>
          <ResponsiveContainer width="100%" height={36}>
            <LineChart data={sparkData.map((v,i)=>({i,v}))} margin={{top:2,right:2,bottom:2,left:2}}>
              <Line type="monotone" dataKey="v" stroke={alarmColor ?? p.border}
                strokeWidth={1.5} dot={false} isAnimationActive={false}/>
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Subtle glow blob in card corner */}
      <div style={{
        position:"absolute", bottom:0, right:0,
        width:"60px", height:"60px",
        background:`radial-gradient(circle at 100% 100%, ${p.border}22, transparent 70%)`,
        pointerEvents:"none",
      }}/>
    </div>
  );
}
