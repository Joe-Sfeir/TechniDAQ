#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// TechniDAQ — Offline License Key Generator (Admin Tool)
// Keep this script PRIVATE. Never ship it with the app or commit to public VCS.
//
// Usage:
//   node generate_license.js                     (365-day license)
//   node generate_license.js --days 90           (90-day license)
//
// Requirements: Node.js 16+ (uses built-in `crypto` — no npm install needed)
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

// ── MASTER KEY ────────────────────────────────────────────────────────────────
// 64 hex characters = 32 bytes = AES-256 key
// ⚠️  CHANGE THIS to your own secret before distributing any licenses.
//    Generate your own: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//    Then paste the SAME value into MASTER_KEY_HEX in main.rs.
// ─────────────────────────────────────────────────────────────────────────────
const MASTER_KEY_HEX = "9d76a182d2f83cffa28e3124cd76a856b45319bcb7d9999e16a7710c20065731";
const MASTER_KEY = Buffer.from(MASTER_KEY_HEX, "hex");

if (MASTER_KEY.length !== 32) {
  console.error("❌  MASTER_KEY_HEX must be exactly 64 hex characters (32 bytes).");
  process.exit(1);
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const daysIdx = args.indexOf("--days");
const durationDays = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) : 365;

if (isNaN(durationDays) || durationDays <= 0) {
  console.error("❌  --days must be a positive integer.");
  process.exit(1);
}

// ── Build plaintext payload ───────────────────────────────────────────────────
// created_at: Unix timestamp (seconds). The Rust engine validates that
//             activation happens within 3600 s (1 hour) of this value.
const payload = JSON.stringify({
  created_at: Math.floor(Date.now() / 1000), // Unix seconds
  duration_days: durationDays,
});

// ── Encrypt: AES-256-GCM ──────────────────────────────────────────────────────
// Token format (binary, then base64-encoded):
//   [ IV (12 bytes) | Ciphertext (N bytes) | Auth Tag (16 bytes) ]
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);

let encrypted = cipher.update(payload, "utf8");
encrypted = Buffer.concat([encrypted, cipher.final()]);
const authTag = cipher.getAuthTag(); // always 16 bytes

const tokenBuf = Buffer.concat([iv, encrypted, authTag]);
const licenseKey = tokenBuf.toString("base64");

// ── Output ────────────────────────────────────────────────────────────────────
const expiryDate = new Date((Math.floor(Date.now() / 1000) + durationDays * 86400) * 1000);

console.log("\n╔══════════════════════════════════════════════════════════════╗");
console.log("║          TechniDAQ — License Key Generated                  ║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");
console.log(`  Duration   : ${durationDays} days`);
console.log(`  Issued at  : ${new Date().toISOString()}`);
console.log(`  Expires on : ${expiryDate.toISOString().slice(0, 10)}`);
console.log(`  TTL window : 1 hour (key must be activated within 60 minutes)\n`);
console.log("  LICENSE KEY (give this to the client):");
console.log("  ────────────────────────────────────────────────────────────");
console.log(`  ${licenseKey}`);
console.log("  ────────────────────────────────────────────────────────────\n");