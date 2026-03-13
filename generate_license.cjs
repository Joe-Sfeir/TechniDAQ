#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// TechniDAQ — Phase 2 Admin License Key Generator
// Keep this script PRIVATE. Never ship it with the app or commit to public VCS.
//
// Usage:
//   node generate_key.js \
//     --days 365 \
//     --username "John Doe" \
//     --project  "Alpha Plant" \
//     --meters   "Schneider_PM2220,Socomec_Diris_A40"
//
// All four flags are REQUIRED.
// Requirements: Node.js 16+ (built-in `crypto` only — no npm install needed)
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

// ── MASTER KEY ────────────────────────────────────────────────────────────────
// 64 hex chars = 32 bytes = AES-256 key.
// CHANGE THIS before your first production build.
// Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Then paste the SAME value into MASTER_KEY_HEX in main.rs.
// ─────────────────────────────────────────────────────────────────────────────
const MASTER_KEY_HEX =
  "6f3d9a2e1b8c4f7a0e5d2b9c6a3f1e8d4b7c0a9e2f5d8b1c4a7e0f3d6b9c2a5f";

const MASTER_KEY = Buffer.from(MASTER_KEY_HEX, "hex");
if (MASTER_KEY.length !== 32) {
  console.error("MASTER_KEY_HEX must be exactly 64 hex chars (32 bytes).");
  process.exit(1);
}

// ── Valid meter identifiers (must match METER_LIBRARY_JSON in main.rs) ────────
const KNOWN_METERS = [
  "Schneider_PM2220",
  "Socomec_Diris_A40",
  "Lovato_DMG",
];

// ── CLI Argument Parser ───────────────────────────────────────────────────────
function getArg(flag) {
  const args  = process.argv.slice(2);
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return null;
  return args[index + 1];
}

const rawDays   = getArg("--days");
const username  = getArg("--username");
const project   = getArg("--project");
const rawMeters = getArg("--meters");

// ── Validation ────────────────────────────────────────────────────────────────
const errors = [];
if (!rawDays)   errors.push("  --days <number>     e.g. --days 365");
if (!username)  errors.push("  --username <string> e.g. --username \"John Doe\"");
if (!project)   errors.push("  --project <string>  e.g. --project \"Alpha Plant\"");
if (!rawMeters) errors.push("  --meters <csv>      e.g. --meters \"Schneider_PM2220,Socomec_Diris_A40\"");

if (errors.length) {
  console.error("\n[ERROR] Missing required arguments:\n");
  errors.forEach(e => console.error(e));
  console.error(
    "\nAvailable meter models:\n" +
    KNOWN_METERS.map(m => `  * ${m}`).join("\n") + "\n"
  );
  process.exit(1);
}

const durationDays = parseInt(rawDays, 10);
if (isNaN(durationDays) || durationDays <= 0) {
  console.error("[ERROR] --days must be a positive integer.");
  process.exit(1);
}

const allowedMeters = rawMeters.split(",").map(m => m.trim()).filter(Boolean);
const unknownMeters = allowedMeters.filter(m => !KNOWN_METERS.includes(m));
if (unknownMeters.length) {
  console.error(`\n[ERROR] Unknown meter model(s): ${unknownMeters.join(", ")}`);
  console.error("Available:\n" + KNOWN_METERS.map(m => `  * ${m}`).join("\n") + "\n");
  process.exit(1);
}
if (allowedMeters.length === 0) {
  console.error("[ERROR] At least one meter model is required.");
  process.exit(1);
}

// ── Build Plaintext Payload ───────────────────────────────────────────────────
// All five fields are encrypted together and verified by the Rust engine.
// created_at: Unix seconds — used for 1-hour TTL window check.
const payload = JSON.stringify({
  created_at:     Math.floor(Date.now() / 1000),
  duration_days:  durationDays,
  username:       username.trim(),
  project_name:   project.trim(),
  allowed_meters: allowedMeters,
});

// ── Encrypt: AES-256-GCM ──────────────────────────────────────────────────────
// Token wire format: base64( IV[12] | Ciphertext[N] | AuthTag[16] )
const iv     = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);

let ciphertext = cipher.update(payload, "utf8");
ciphertext     = Buffer.concat([ciphertext, cipher.final()]);
const authTag  = cipher.getAuthTag(); // always 16 bytes

const licenseKey = Buffer.concat([iv, ciphertext, authTag]).toString("base64");

// ── Output ────────────────────────────────────────────────────────────────────
const issuedAt  = new Date();
const expiresAt = new Date(
  (Math.floor(Date.now() / 1000) + durationDays * 86400) * 1000
);

const bar = "=".repeat(64);
console.log(`\n${bar}`);
console.log("  TechniDAQ Phase 2 -- License Key Generated");
console.log(`${bar}\n`);
console.log(`  Username       : ${username}`);
console.log(`  Project        : ${project}`);
console.log(`  Allowed Meters :`);
allowedMeters.forEach(m => console.log(`                   * ${m}`));
console.log(`  Duration       : ${durationDays} days`);
console.log(`  Issued         : ${issuedAt.toISOString()}`);
console.log(`  Expires        : ${expiresAt.toISOString().slice(0, 10)}`);
console.log(`  TTL Window     : 60 minutes from now\n`);
console.log("  LICENSE KEY:");
console.log(`  ${"-".repeat(62)}`);
console.log(`  ${licenseKey}`);
console.log(`  ${"-".repeat(62)}\n`);

if (durationDays <= 7) {
  console.log(`  [WARN] Short-term key (${durationDays} days). Use for testing only.\n`);
}