import type React from "react";

// ─── Design tokens ────────────────────────────────────────────────────────────

export const LIGHT_THEME = {
  bg:        "#f8fafc",
  surface:   "#ffffff",
  border:    "#e2e8f0",
  accent:    "#1a5fff",
  accentDim: "#eff6ff",
  text:      "#0f172a",
  muted:     "#64748b",
  muted2:    "#94a3b8",
  danger:    "#ef4444",
  dangerBg:  "#fef2f2",
  dangerBdr: "#fecaca",
  amber:     "#f59e0b",
  amberBg:   "#fffbeb",
  amberBdr:  "#fde68a",
  green:     "#10b981",
  greenBg:   "#ecfdf5",
  greenBdr:  "#a7f3d0",
  sidebar:   "#ffffff",
  cardShadow:"0 4px 6px -1px rgba(0,0,0,0.05), 0 2px 4px -1px rgba(0,0,0,0.03)",
};

export const DARK_THEME = {
  bg:        "#050505",
  surface:   "#111111",
  border:    "#222222",
  accent:    "#1a5fff",
  accentDim: "rgba(26,95,255,0.1)",
  text:      "#ffffff",
  muted:     "#a1a1aa",
  muted2:    "#52525b",
  danger:    "#ef4444",
  dangerBg:  "rgba(239,68,68,0.1)",
  dangerBdr: "rgba(239,68,68,0.2)",
  amber:     "#f59e0b",
  amberBg:   "rgba(245,158,11,0.1)",
  amberBdr:  "rgba(245,158,11,0.2)",
  green:     "#10b981",
  greenBg:   "rgba(16,185,129,0.1)",
  greenBdr:  "rgba(16,185,129,0.2)",
  sidebar:   "#0a0a0a",
  cardShadow:"0 10px 30px -10px rgba(0,0,0,0.5)",
};

// Palette accent colors for register/chart color coding — unchanged
export const CLR = {
  blue:   "#3b82f6",
  green:  "#22c55e",
  amber:  "#f59e0b",
  red:    "#ef4444",
  purple: "#a855f7",
  teal:   "#14b8a6",
  orange: "#f97316",
  indigo: "#6366f1",
};

// Card surface helper
export const glass = (isDark:boolean, accent?:string): React.CSSProperties => ({
  background:   isDark ? DARK_THEME.surface : LIGHT_THEME.surface,
  border:       `1px solid ${isDark ? DARK_THEME.border : LIGHT_THEME.border}`,
  borderRadius: "12px",
  boxShadow:    `${isDark ? DARK_THEME.cardShadow : LIGHT_THEME.cardShadow}${accent ? `, 0 0 0 1px ${accent}18` : ""}`,
});

// Dot-grid CSS injected once into <head>
export const DOT_GRID_CSS = `
  .tdaq-page {
    background-color: var(--pg);
    background-image: radial-gradient(circle, var(--dot) 1px, transparent 1px);
    background-size: 22px 22px;
  }
  [data-theme="dark"]  { --pg: #050505; --dot: rgba(255,255,255,0.04); }
  [data-theme="light"] { --pg: #f8fafc; --dot: rgba(15,23,42,0.06); }
  @keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:0.35} }
  @keyframes spin { to{transform:rotate(360deg)} }
  @keyframes alarm-red   { 0%,100%{box-shadow:0 0 0 1.5px #ef4444,0 0 0 3px #ef444422} 50%{box-shadow:0 0 0 2px #ef4444,0 0 16px 4px #ef444444} }
  @keyframes alarm-amber { 0%,100%{box-shadow:0 0 0 1.5px #f59e0b,0 0 0 3px #f59e0b22} 50%{box-shadow:0 0 0 2px #f59e0b,0 0 16px 4px #f59e0b44} }
  [data-theme="dark"] select { background:#111111 !important; color:#ffffff !important; }
  [data-theme="dark"] select option { background:#111111; color:#ffffff; }
  [data-theme="light"] select { background:#ffffff; color:#0f172a; }
`;

export const TAB_ACCENTS  = [CLR.blue,CLR.green,CLR.amber,CLR.purple,CLR.red,CLR.teal,CLR.orange,CLR.indigo];
export const LINE_COLORS  = ["#3b82f6","#22c55e","#f59e0b","#a855f7","#ef4444","#14b8a6","#f97316","#6366f1"];

export function regPalette(name:string, idx:number) {
  const n = name.toLowerCase();
  const P = [
    { border:CLR.blue,   value:CLR.blue },
    { border:CLR.amber,  value:CLR.amber },
    { border:CLR.purple, value:CLR.purple },
    { border:CLR.green,  value:CLR.green },
    { border:CLR.red,    value:CLR.red },
    { border:CLR.teal,   value:CLR.teal },
    { border:CLR.orange, value:CLR.orange },
    { border:CLR.indigo, value:CLR.indigo },
  ];
  if (n.includes("voltage"))                                    return P[0];
  if (n.includes("current"))                                    return P[1];
  if (n.includes("apparent"))                                   return P[7];
  if (n.includes("reactive"))                                   return P[4];
  if (n.includes("active power")||n.includes("power total"))   return P[2];
  if (n.includes("energy"))                                     return P[3];
  if (n.includes("frequen"))                                    return P[5];
  if (n.includes("factor"))                                     return P[6];
  return P[idx % P.length];
}
