#!/usr/bin/env node
// generate_license.cjs  — TechniDAQ License Key Generator
//
// Usage:
//   node generate_license.cjs --days 365 --username "John Doe" --project "Site Alpha" --meters "Schneider_PM2220,Socomec_Diris_A40"
//   node generate_license.cjs --days 365 --username "John Doe" --project "Site Alpha" --meters "All"
//   node generate_license.cjs --days 30  --username "Demo User" --project "Demo"      --meters "All" --features "Simulation"
//   node generate_license.cjs --days 365 --username "John Doe" --project "Site Alpha" --meters "Schneider_PM2220" --features "Diagnostics,EmailAlerts"
//   node generate_license.cjs --days 365 --username "John Doe" --project "Site Alpha" --meters "All" --mode "online" --tier 2 --protocols "All"
//
// --meters    Comma-separated meter model names, or "All" to unlock every profile.
//             "Custom" grants the custom device.
//
// --features  Optional. Comma-separated feature flags to enable:
//               Simulation   — mock oscillating data, no RS485 hardware required (sales demos)
//               Diagnostics  — Modbus frame inspector panel
//               EmailAlerts  — alarm threshold email notifications
//
// --ttl_hours How many hours the key remains activatable after generation (default: 1).
//             Use 24 for next-day delivery, 168 for a week, etc.
//
// --mode      Application mode: "offline" (air-gapped, default) or "online" (cloud-connected).
// --tier      License tier: 1 (basic), 2 (professional), or 3 (enterprise). Default: 1.
// --protocols Permitted Modbus transport: "RTU", "TCP", or "All" (default: "All").

"use strict";

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

// ─── Master Key ───────────────────────────────────────────────────────────────
// MUST match MASTER_KEY_HEX in src-tauri/src/main.rs exactly.
// Generate a new one with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const MASTER_KEY_HEX =
  "6f3d9a2e1b8c4f7a0e5d2b9c6a3f1e8d4b7c0a9e2f5d8b1c4a7e0f3d6b9c2a5f";

const KNOWN_FEATURES = ["Simulation", "Diagnostics", "EmailAlerts"];

// ─── Arg Parsing ──────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
  return {
    days:      parseInt(get("--days")      ?? "365", 10),
    ttl_hours: parseInt(get("--ttl_hours") ?? "1",   10),
    username:  get("--username") ?? "",
    project:   get("--project")  ?? "",
    meters:    get("--meters")   ?? "",
    features:  get("--features") ?? "",
    mode:      get("--mode")      ?? "offline",
    tier:      parseInt(get("--tier") ?? "1", 10),
    protocols: get("--protocols") ?? "All",
  };
}

// ─── Profile Discovery ────────────────────────────────────────────────────────
function loadProfileKeys() {
  const candidates = [
    path.join(__dirname, "profiles.json"),
    path.join(__dirname, "src-tauri", "profiles.json"),
    path.join(process.cwd(), "profiles.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { return Object.keys(JSON.parse(fs.readFileSync(p, "utf8"))); } catch {}
    }
  }
  console.warn("[warn] profiles.json not found — meter names will not be validated.");
  return null;
}

// ─── Key Generation ───────────────────────────────────────────────────────────
function generateKey({ days, ttl_hours, username, project, allowed_meters, mode, tier, protocols }) {
  const payload = JSON.stringify({
    created_at:    Math.floor(Date.now() / 1000),
    duration_days: days,
    ttl_hours,
    username,
    project_name:  project,
    allowed_meters,
    mode,
    tier,
    protocols,
  });

  const masterKey = Buffer.from(MASTER_KEY_HEX, "hex");
  if (masterKey.length !== 32) throw new Error(`MASTER_KEY_HEX must be 32 bytes, got ${masterKey.length}`);

  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const authTag   = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, authTag]).toString("base64");
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const KNOWN_MODES     = ["offline", "online"];
const KNOWN_PROTOCOLS = ["RTU", "TCP", "All"];
const VALID_TIERS     = [1, 2, 3];

function main() {
  const { days, ttl_hours, username, project, meters, features, mode, tier, protocols } = parseArgs();

  const errors = [];
  if (!username.trim())                                       errors.push("--username is required");
  if (!project.trim())                                        errors.push("--project is required");
  if (isNaN(days) || days < 1 || days > 3650)                errors.push("--days must be 1–3650");
  if (isNaN(ttl_hours) || ttl_hours < 1 || ttl_hours > 8760) errors.push("--ttl_hours must be 1–8760 (hours)");
  if (!meters.trim())                                         errors.push("--meters is required (comma list or 'All')");
  if (!KNOWN_MODES.includes(mode))                            errors.push(`--mode must be one of: ${KNOWN_MODES.join(", ")}`);
  if (!VALID_TIERS.includes(tier))                            errors.push(`--tier must be 1, 2, or 3`);
  if (!KNOWN_PROTOCOLS.includes(protocols))                   errors.push(`--protocols must be one of: ${KNOWN_PROTOCOLS.join(", ")}`);

  if (errors.length) {
    console.error("Errors:\n" + errors.map(e => "  · " + e).join("\n"));
    console.error([
      "",
      "Usage:",
      "  node generate_license.cjs \\",
      '    --days      365 \\',
      '    --ttl_hours 24  \\',
      '    --username  "John Doe" \\',
      '    --project   "Site Alpha" \\',
      '    --meters    "Schneider_PM2220,Socomec_Diris_A40" \\',
      '    --features  "Simulation,Diagnostics,EmailAlerts" \\',
      '    --mode      "online" \\',
      '    --tier      2 \\',
      '    --protocols "All"',
      "",
      "  # Offline air-gapped, RTU only, tier 1 (defaults):",
      '    --meters "All"',
      "",
      "  # Online tier 2, all protocols:",
      '    --meters "All" --mode "online" --tier 2 --protocols "All"',
      "",
    ].join("\n"));
    process.exit(1);
  }

  const profileKeys = loadProfileKeys();

  // ── Parse --meters ──────────────────────────────────────────────────────────
  let meterList;
  if (meters.trim() === "All") {
    meterList = ["All"];
    const list = profileKeys ? profileKeys.join(", ") + ", Custom" : "all profiles + Custom";
    console.log(`[info] --meters "All" will unlock: ${list}`);
  } else {
    meterList = meters.split(",").map(s => s.trim()).filter(Boolean);
    for (const m of meterList) {
      if (KNOWN_FEATURES.includes(m)) {
        console.warn(`[warn] "${m}" is a feature flag — move it to --features instead of --meters.`);
      } else if (m !== "Custom" && profileKeys && !profileKeys.includes(m)) {
        console.warn(`[warn] "${m}" not found in profiles.json — will be ignored at runtime.`);
      }
    }
  }

  // ── Parse --features ────────────────────────────────────────────────────────
  const featureList = features
    ? features.split(",").map(s => s.trim()).filter(Boolean)
    : [];

  for (const f of featureList) {
    if (!KNOWN_FEATURES.includes(f)) {
      console.warn(`[warn] "${f}" is not a recognised feature flag. Known flags: ${KNOWN_FEATURES.join(", ")}`);
    }
  }

  // ── Merge into allowed_meters (backend expects one flat array) ──────────────
  const allowed_meters = [...meterList, ...featureList];

  // ── Generate token ──────────────────────────────────────────────────────────
  const token       = generateKey({ days, ttl_hours, username: username.trim(), project: project.trim(), allowed_meters, mode, tier, protocols });
  const expiryDate  = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const activByDate = new Date(Date.now() + ttl_hours * 3_600_000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const metersStr   = meterList.join(", ");
  const featuresStr = featureList.length ? featureList.join(", ") : "(none)";

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║              TechniDAQ License Key Generated                ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  User      : ${username.trim().slice(0, 49).padEnd(49)}║`);
  console.log(`║  Project   : ${project.trim().slice(0, 49).padEnd(49)}║`);
  console.log(`║  Meters    : ${metersStr.slice(0, 49).padEnd(49)}║`);
  console.log(`║  Features  : ${featuresStr.slice(0, 49).padEnd(49)}║`);
  console.log(`║  Mode      : ${mode.padEnd(49)}║`);
  console.log(`║  Tier      : ${String(tier).padEnd(49)}║`);
  console.log(`║  Protocols : ${protocols.padEnd(49)}║`);
  console.log(`║  Expires   : ${expiryDate.padEnd(49)}║`);
  console.log(`║  Valid     : ${String(days).padEnd(46)} days║`);
  console.log(`║  Activate by: ${activByDate.padEnd(48)}║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("\n── License Key ─────────────────────────────────────────────────\n");
  console.log(token);
  console.log("\n────────────────────────────────────────────────────────────────");
  console.log(`[!] This key must be activated within ${ttl_hours} hour(s). Deliver promptly.\n`);
}

main();
