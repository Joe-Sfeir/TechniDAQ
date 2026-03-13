#!/usr/bin/env node
// generate_key.js  — TechniDAQ Phase 5 License Key Generator
//
// Usage:
//   node generate_key.js --days 365 --username "John Doe" --project "Site Alpha" --meters "Schneider_PM2220,Socomec_Diris_A40"
//   node generate_key.js --days 365 --username "John Doe" --project "Site Alpha" --meters "All"
//   node generate_key.js --days 365 --ttl_hours 24 --username "John Doe" --project "Site Alpha" --meters "All"
//
// --ttl_hours  How many hours the key remains activatable after generation (default: 1).
//              Use 24 for next-day delivery, 168 for a week, etc.
//
// Passing "All" grants access to every profile in profiles.json plus "Custom".
// "Custom" in --meters explicitly grants the custom device without any named profiles.
// "Simulation" in --meters activates Simulation Mode: the app generates oscillating mock
//   data without requiring any physical RS485 hardware.  Useful for sales demos.
//   Example: --meters "Simulation"  or  --meters "Simulation,Schneider_PM2220"

"use strict";

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

// ─── Master Key ───────────────────────────────────────────────────────────────
// MUST match MASTER_KEY_HEX in src-tauri/src/main.rs exactly.
// Generate a new one with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const MASTER_KEY_HEX =
  "6f3d9a2e1b8c4f7a0e5d2b9c6a3f1e8d4b7c0a9e2f5d8b1c4a7e0f3d6b9c2a5f";

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
function generateKey({ days, ttl_hours, username, project, allowed_meters }) {
  const payload = JSON.stringify({
    created_at:    Math.floor(Date.now() / 1000),
    duration_days: days,
    ttl_hours,
    username,
    project_name:  project,
    allowed_meters,
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
function main() {
  const { days, ttl_hours, username, project, meters } = parseArgs();

  const errors = [];
  if (!username.trim())                             errors.push("--username is required");
  if (!project.trim())                              errors.push("--project is required");
  if (isNaN(days) || days < 1 || days > 3650)       errors.push("--days must be 1–3650");
  if (isNaN(ttl_hours) || ttl_hours < 1 || ttl_hours > 8760) errors.push("--ttl_hours must be 1–8760 (hours)");
  if (!meters.trim())                               errors.push("--meters required (comma list or 'All')");

  if (errors.length) {
    console.error("Errors:\n" + errors.map(e => "  · " + e).join("\n"));
    console.error([
      "",
      "Usage:",
      '  node generate_key.js \\',
      '    --days      365 \\',
      '    --ttl_hours 24  \\',
      '    --username  "John Doe" \\',
      '    --project   "Site Alpha" \\',
      '    --meters    "Schneider_PM2220,Socomec_Diris_A40"',
      "",
      "  # Grant all meters:",
      '    --meters    "All"',
      "",
    ].join("\n"));
    process.exit(1);
  }

  const profileKeys = loadProfileKeys();
  let allowed_meters;

  if (meters.trim() === "All") {
    allowed_meters = ["All"];
    const list = profileKeys ? profileKeys.join(", ") + ", Custom" : "all profiles + Custom";
    console.log(`[info] "All" will unlock: ${list}`);
  } else {
    allowed_meters = meters.split(",").map(s => s.trim()).filter(Boolean);
    if (profileKeys) {
      for (const m of allowed_meters) {
        if (m !== "Custom" && m !== "Simulation" && !profileKeys.includes(m)) {
          console.warn(`[warn] "${m}" not found in profiles.json — ignored at runtime.`);
        }
      }
    }
    console.log(`[info] "Custom" device is always available — no need to list it explicitly.`);
  }

  const token       = generateKey({ days, ttl_hours, username: username.trim(), project: project.trim(), allowed_meters });
  const expiryDate  = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const activByDate = new Date(Date.now() + ttl_hours * 3_600_000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const metersStr   = allowed_meters.join(", ");

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║              TechniDAQ License Key Generated                ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  User      : ${username.trim().slice(0, 49).padEnd(49)}║`);
  console.log(`║  Project   : ${project.trim().slice(0, 49).padEnd(49)}║`);
  console.log(`║  Meters    : ${metersStr.slice(0, 49).padEnd(49)}║`);
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