// src-tauri/src/main.rs  — TechniDAQ Phase 4 (Multi-Meter SCADA Engine)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Timelike;
#[cfg(feature = "cloud_sync")]
use lettre::{message::header::ContentType, transport::smtp::authentication::Credentials, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
#[cfg(feature = "cloud_sync")]
use reqwest::Client as HttpClient;
use rusqlite::{params, Connection};
use rust_xlsxwriter::{Color, DocProperties, Format, FormatAlign, FormatBorder, Image, ProtectionOptions, Shape, ShapeFont, ShapeFormat, ShapeText, ShapeTextDirection, Workbook};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, RunEvent, State, WindowEvent,
};
use axum::{
    body::Body,
    extract::{Json, Path, State as AxumState},
    extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use tokio::sync::mpsc::UnboundedSender;
use rust_embed::RustEmbed;
#[cfg(feature = "cloud_sync")]
use tokio::net::TcpStream;
use tokio::time::sleep;
use tokio_modbus::prelude::*;
use tokio_serial::SerialStream;

// ─── Constants ────────────────────────────────────────────────────────────────

const MASTER_KEY_HEX:       &str = "6f3d9a2e1b8c4f7a0e5d2b9c6a3f1e8d4b7c0a9e2f5d8b1c4a7e0f3d6b9c2a5f";
#[cfg(feature = "cloud_sync")]
const CLOUD_API_URL: &str = "https://technicloudapi.onrender.com";
#[cfg(feature = "cloud_sync")]
const SMTP_HOST: &str = "smtp.gmail.com";
#[cfg(feature = "cloud_sync")]
const SMTP_USER: &str = "joesfeir007@gmail.com";
#[cfg(feature = "cloud_sync")]
const SMTP_PASS: &str = "drrx vrdk elac oprp";
const PORT_TIMEOUT_MS:      u64  = 500;
/// Minimum gap between consecutive Modbus frames on the same RS485 bus (turnaround time).
const RS485_TURNAROUND_MS:  u64  = 25;
/// Polling tick interval — how often the loop wakes to check which devices are due.
const TICK_MS:              u64  = 50;

// ─── Data Types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterEntry {
    pub name:       String,
    pub address:    u16,
    pub length:     u16,
    pub data_type:  String,   // "Float32" | "UInt16" | "UInt32" | "INT16" | "INT32"
    pub multiplier: f64,
    #[serde(default)]
    pub min_alarm: Option<f64>,
    #[serde(default)]
    pub max_alarm: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeterProfileEntry {
    pub model:        String,
    pub display_name: String,
    pub endianness:   String,   // "ABCD" | "CDAB" | "BADC" | "DCBA"
    pub baud_rate:    u32,
    pub parity:       String,   // "Even" | "Odd" | "None"
    pub registers:    Vec<RegisterEntry>,
}

/// A fully-configured polling target — sent from the frontend when the user
/// clicks "Save Configuration".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceConfig {
    pub device_name:        String,
    pub meter_model:        String,
    pub slave_id:           u8,
    pub poll_rate_ms:       u64,
    pub selected_registers: Vec<RegisterEntry>,
    #[serde(default = "default_trigger_cycles")]
    pub alarm_trigger_cycles: u32,
    // ── Connection fields ───────────────────────────────────────────────────
    #[serde(default = "default_protocol")]
    pub protocol:    Protocol,
    #[serde(default = "default_com_port")]
    pub com_port:    String,
    #[serde(default = "default_baud_rate")]
    pub baud_rate:   u32,
    #[serde(default = "default_ip_address")]
    pub ip_address:  String,
    #[serde(default = "default_tcp_port")]
    pub tcp_port:    u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Protocol { Rtu, Tcp }

fn default_protocol()    -> Protocol { Protocol::Rtu }
fn default_com_port()    -> String   { "COM3".into()  }
fn default_baud_rate()   -> u32      { 9600            }
fn default_ip_address()  -> String   { String::new()   }
fn default_tcp_port()    -> u16      { 502              }

fn default_trigger_cycles() -> u32 { 5 }

// ─── Engine State ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PollState { Stopped, Running, Fault }

pub struct EngineState {
    pub poll:               PollState,
    pub configured_devices: Vec<DeviceConfig>,
}

pub struct SharedEngine(pub Arc<Mutex<EngineState>>);
pub struct DbConnection(pub Arc<Mutex<Connection>>);
/// Shared mutable copy of the profile library loaded from profiles.json.
pub struct ProfilesState(pub Arc<Mutex<HashMap<String, MeterProfileEntry>>>);

// ─── WebSocket Client Registry ────────────────────────────────────────────────

/// One unbounded-sender per connected web client.  Sending fails on a closed
/// socket; the broadcast helper uses `retain` to prune dead entries automatically.
type WsClientList = Arc<Mutex<Vec<UnboundedSender<String>>>>;

/// Tauri-managed wrapper so Tauri commands can also reach the WS client list.
pub struct WsClients(WsClientList);

/// Serialise the current engine state into a STATE_CHANGE WebSocket frame.
fn build_state_msg(engine: &Arc<Mutex<EngineState>>) -> String {
    if let Ok(eng) = engine.lock() {
        serde_json::json!({
            "type":               "STATE_CHANGE",
            "configured_devices": eng.configured_devices,
            "poll_state":         eng.poll,
        }).to_string()
    } else {
        r#"{"type":"STATE_CHANGE","configured_devices":[],"poll_state":"stopped"}"#.to_string()
    }
}

/// Broadcast a message to every connected web client, dropping dead connections.
fn ws_broadcast(clients: &WsClientList, msg: String) {
    if let Ok(mut list) = clients.lock() {
        list.retain(|tx| tx.send(msg.clone()).is_ok());
    }
}

// ─── Event Payloads ───────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct MeterReading {
    pub device_name:  String,   // "Main Incomer"
    pub device_id:    String,   // "Schneider_PM2220 #01"
    pub timestamp_ms: u128,
    pub data:         HashMap<String, f64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct FaultEvent  { pub device_name: String, pub reason: String, pub timestamp_ms: u128 }

#[derive(Serialize, Clone, Debug)]
pub struct StatusEvent { pub state: PollState }

#[derive(Serialize, Clone, Debug)]
pub struct DiagEvent {
    pub direction:    String,   // "TX" | "RX"
    pub hex:          String,
    pub device_name:  String,
    pub timestamp_ms: u128,
}

pub struct DiagEnabled(pub Arc<AtomicBool>);

// ─── Connection Pool Key ──────────────────────────────────────────────────────

#[derive(Hash, Eq, PartialEq, Clone, Debug)]
enum ConnKey {
    Rtu(String, u32),   // (com_port, baud_rate)
    Tcp(String, u16),   // (ip_address, tcp_port)
}

impl ConnKey {
    fn from_device(d: &DeviceConfig) -> Self {
        match d.protocol {
            Protocol::Rtu => ConnKey::Rtu(d.com_port.clone(), d.baud_rate),
            Protocol::Tcp => ConnKey::Tcp(d.ip_address.clone(), d.tcp_port),
        }
    }
}

// ─── License Types ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct AuthState {
    pub valid:             bool,
    pub username:          Option<String>,
    pub project_name:      Option<String>,
    pub expiry_date:       Option<i64>,
    pub allowed_meters:    Vec<String>,
    pub mode:              Option<String>,
    pub tier:              Option<u8>,
    pub protocols:         Option<String>,
    /// True when a `machine_api_key` has been obtained from the cloud.
    /// Always false in offline/air-gapped builds.
    pub cloud_registered:  bool,
}

#[derive(Deserialize, Debug)]
struct LicensePayload {
    created_at:     u64,
    duration_days:  u64,
    /// How many hours after `created_at` this token may still be activated.
    ttl_hours:      u64,
    username:       String,
    project_name:   String,
    allowed_meters: Vec<String>,
    #[serde(default = "default_mode")]
    mode:           String,
    #[serde(default = "default_tier")]
    tier:           u8,
    #[serde(default = "default_protocols")]
    protocols:      String,
}

fn default_mode()      -> String { "offline".into() }
fn default_tier()      -> u8     { 1 }
fn default_protocols() -> String { "All".into() }

// ─── External Profile Library ─────────────────────────────────────────────────

/// Probe candidate paths for `profiles.json` and return the first one that
/// parses successfully.  Paths tried (in order):
///   1. Directory containing the executable  (production)
///   2. `src-tauri/profiles.json`            (cargo dev run from project root)
///   3. `profiles.json` in the cwd           (flexible fallback)
fn load_profiles_from_disk() -> HashMap<String, MeterProfileEntry> {
    let candidates: Vec<PathBuf> = vec![
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("profiles.json")))
            .unwrap_or_default(),
        PathBuf::from("src-tauri/profiles.json"),
        PathBuf::from("profiles.json"),
    ];

    for path in &candidates {
        if path.exists() {
            match std::fs::read_to_string(path) {
                Ok(content) => match serde_json::from_str::<HashMap<String, MeterProfileEntry>>(&content) {
                    Ok(lib) => {
                        eprintln!("[profiles] Loaded {} profiles from {}", lib.len(), path.display());
                        return lib;
                    }
                    Err(e) => eprintln!("[profiles] Parse error in {}: {e}", path.display()),
                },
                Err(e) => eprintln!("[profiles] Read error {}: {e}", path.display()),
            }
        }
    }

    eprintln!("[profiles] WARNING: profiles.json not found in any search path — starting with empty library.");
    HashMap::new()
}

/// Returns the "Custom" device — always injected regardless of license.
fn custom_profile() -> MeterProfileEntry {
    MeterProfileEntry {
        model:        "Custom".into(),
        display_name: "Custom Device".into(),
        endianness:   "ABCD".into(),
        baud_rate:    9600,
        parity:       "None".into(),
        registers:    vec![],   // user defines all registers in the UI
    }
}

/// Returns the "Simulation" device — injected when license permits "Simulation" or "All".
fn simulation_profile() -> MeterProfileEntry {
    MeterProfileEntry {
        model:        "Simulation".into(),
        display_name: "Simulation".into(),
        endianness:   "ABCD".into(),
        baud_rate:    9600,
        parity:       "None".into(),
        registers:    vec![],
    }
}

/// Normalise a meter name for fuzzy matching: lowercase, spaces/hyphens → underscores.
fn normalize_meter_name(s: &str) -> String {
    s.to_lowercase().replace([' ', '-'], "_")
}

// ─── Byte-Order / Decode Helpers ──────────────────────────────────────────────

fn regs_to_f32(regs: &[u16], endian: &str) -> f32 {
    let [a, b, c, d] = match endian {
        "ABCD" => [regs[0]>>8, regs[0]&0xFF, regs[1]>>8, regs[1]&0xFF],
        "CDAB" => [regs[1]>>8, regs[1]&0xFF, regs[0]>>8, regs[0]&0xFF],
        "BADC" => [regs[0]&0xFF, regs[0]>>8, regs[1]&0xFF, regs[1]>>8],
        "DCBA" => [regs[1]&0xFF, regs[1]>>8, regs[0]&0xFF, regs[0]>>8],
        _      => [regs[0]>>8, regs[0]&0xFF, regs[1]>>8, regs[1]&0xFF],
    };
    f32::from_be_bytes([a as u8, b as u8, c as u8, d as u8])
}

fn regs_to_u32(regs: &[u16], endian: &str) -> u32 {
    match endian {
        "CDAB" | "DCBA" => ((regs[1] as u32) << 16) | (regs[0] as u32),
        _               => ((regs[0] as u32) << 16) | (regs[1] as u32),
    }
}

fn decode_register(regs: &[u16], endian: &str, dtype: &str, multiplier: f64) -> f64 {
    let raw: f64 = match dtype {
        "Float32"           => regs_to_f32(regs, endian) as f64,
        "UInt32" | "INT32U" => regs_to_u32(regs, endian) as f64,
        "UInt16" | "INT16U" => regs[0] as f64,
        "INT16"             => regs[0] as i16 as f64,
        "INT32"             => regs_to_u32(regs, endian) as i32 as f64,
        _                   => regs_to_f32(regs, endian) as f64,
    };
    raw * multiplier
}

// ─── Misc Helpers ─────────────────────────────────────────────────────────────

fn wall_clock_iso() -> String {
    secs_to_iso(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs())
}

/// Convert a Unix timestamp (seconds) to the `YYYY-MM-DDTHH:MM:SS` format
/// used in the `meter_history.timestamp` column — enabling direct string comparison.
fn secs_to_iso(s0: u64) -> String {
    let (s, m, h) = (s0%60, (s0/60)%60, (s0/3600)%24);
    let d = s0/86400; let yr = 1970+d/365; let mo = (d%365)/30+1; let dy = (d%365)%30+1;
    format!("{yr:04}-{mo:02}-{dy:02}T{h:02}:{m:02}:{s:02}")
}

fn now_ms()   -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() }
fn now_secs() -> u64  { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }

fn hex_decode(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len()%2 != 0 { return Err("Odd hex length".into()); }
    (0..hex.len()).step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i+2], 16).map_err(|_| format!("Bad hex char at {i}")))
        .collect()
}

fn decrypt_license_token(token: &str) -> Result<LicensePayload, String> {
    let raw = B64.decode(token.trim()).map_err(|e| format!("Base64: {e}"))?;
    if raw.len() < 29 { return Err("Token too short".into()); }
    let (iv_b, ct) = raw.split_at(12);
    let key_bytes  = hex_decode(MASTER_KEY_HEX)?;
    let key        = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let plaintext  = Aes256Gcm::new(key)
        .decrypt(Nonce::from_slice(iv_b), ct)
        .map_err(|e| {
            eprintln!("[license] AES-GCM decryption error: {:?}", e);
            "Invalid or tampered license key".to_string()
        })?;
    let payload_str = String::from_utf8_lossy(&plaintext);
    serde_json::from_slice(&plaintext).map_err(|e| {
        eprintln!("[license] Deserialization failed. Payload: {}, Error: {:?}", payload_str, e);
        format!("Payload corrupt: {e}")
    })
}

/// Read or generate a stable machine identifier, stored in `app_config`.
/// Used as a stable edge-unit identity in cloud API calls.
#[cfg(feature = "cloud_sync")]
fn get_or_create_machine_id(conn: &Connection) -> String {
    if let Ok(id) = conn.query_row(
        "SELECT value FROM app_config WHERE key = 'machine_id'",
        [],
        |r| r.get::<_, String>(0),
    ) {
        return id;
    }
    // Derive a unique ID from current timestamp (ns) + OS process ID.
    // Stored permanently in app_config so it never changes after first run.
    let id = format!("edge-{:016x}{:08x}", now_ms(), std::process::id());
    let _  = conn.execute(
        "INSERT OR IGNORE INTO app_config (key, value) VALUES ('machine_id', ?1)",
        params![&id],
    );
    eprintln!("[cloud] New machine_id generated: {id}");
    id
}

/// Read `allowed_meters` from the DB without holding the lock long.
fn get_allowed_meters_from_db(db: &Arc<Mutex<Connection>>) -> Vec<String> {
    let conn = db.lock().unwrap();
    conn.query_row("SELECT allowed_meters FROM settings LIMIT 1", [],
        |r| r.get::<_, String>(0))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

/// Read `protocols` from the DB ("RTU", "TCP", or "All"). Defaults to "All".
fn get_license_protocols_from_db(db: &Arc<Mutex<Connection>>) -> String {
    let conn = db.lock().unwrap();
    conn.query_row("SELECT protocols FROM settings LIMIT 1", [],
        |r| r.get::<_, String>(0))
        .unwrap_or_else(|_| "All".into())
}

/// Generate a plausible oscillating mock value for a named register.
/// Uses wall-clock time + register index so values drift independently.
fn sim_register_value(name: &str, idx: usize) -> f64 {
    let t = now_ms() as f64 / 1000.0;
    let n = name.to_lowercase();
    // (base, amplitude, frequency_hz) — output = base + amp * sin(...)
    let (base, amp, freq) = if n.contains("volt") {
        (227.5_f64, 7.5,  0.10)   // 220–235 V
    } else if n.contains("curr") || n.contains("amp") {
        (30.0,      20.0, 0.17)   // 10–50 A
    } else if n.contains("factor") {
        (0.94,      0.04, 0.09)   // 0.90–0.98
    } else if n.contains("pow") || n.contains("kw") {
        (10.0,      5.0,  0.07)   // 5–15 kW
    } else if n.contains("freq") || n.contains("hz") {
        (50.0,      0.1,  0.013)  // 49.9–50.1 Hz
    } else {
        (50.5,      49.5, 0.11)   // 1–100 (generic)
    };
    let phase = idx as f64 * 0.7;
    base + amp * (t * freq * std::f64::consts::TAU + phase).sin()
}

fn is_license_valid(db: &Arc<Mutex<Connection>>) -> bool {
    let conn = db.lock().unwrap();
    let now  = now_secs() as i64;
    conn.query_row("SELECT expiry_date FROM settings LIMIT 1", [], |r| r.get::<_,i64>(0))
        .map(|exp| now < exp).unwrap_or(false)
}

// ─── Tauri Commands ── Engine ─────────────────────────────────────────────────

#[tauri::command]
fn toggle_polling(
    engine:     State<SharedEngine>,
    app_handle: tauri::AppHandle,
    ws:         State<WsClients>,
) -> Result<PollState, String> {
    let new_state = {
        let mut e = engine.0.lock().map_err(|e| e.to_string())?;
        e.poll = match e.poll { PollState::Running => PollState::Stopped, _ => PollState::Running };
        e.poll.clone()
    };
    app_handle.emit("status-changed", StatusEvent { state: new_state.clone() })
        .map_err(|e| e.to_string())?;
    ws_broadcast(&ws.0, build_state_msg(&engine.0));
    Ok(new_state)
}

#[tauri::command]
fn get_status(engine: State<SharedEngine>) -> Result<PollState, String> {
    Ok(engine.0.lock().map_err(|e| e.to_string())?.poll.clone())
}

#[tauri::command]
async fn logout_user(db: State<'_, DbConnection>) -> Result<(), String> {
    // ── Cloud key invalidation (fire-and-forget, non-blocking) ────────────────
    #[cfg(feature = "cloud_sync")]
    {
        let result: Option<(String, String)> = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT mode, machine_api_key FROM settings LIMIT 1",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            ).ok()
        };
        if let Some((mode, api_key)) = result {
            if mode == "online" && !api_key.is_empty() {
                tokio::spawn(async move {
                    let client = HttpClient::builder()
                        .timeout(Duration::from_secs(5))
                        .https_only(true)
                        .build()
                        .unwrap_or_else(|_| HttpClient::new());
                    let _ = client
                        .post(format!("{CLOUD_API_URL}/api/machine/logout"))
                        .bearer_auth(&api_key)
                        .send()
                        .await;
                    eprintln!("[logout] ✔ Cloud key invalidation sent");
                });
            }
        }
    }

    // Always wipe local settings regardless of cloud outcome
    db.0.lock().map_err(|e| e.to_string())?
       .execute("DELETE FROM settings", []).map_err(|e| e.to_string())?;
    eprintln!("[auth] License revoked — settings cleared, history preserved.");
    Ok(())
}

#[tauri::command]
fn clear_history(db: State<DbConnection>) -> Result<usize, String> {
    db.0.lock().map_err(|e| e.to_string())?
       .execute("DELETE FROM meter_history", []).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_record_count(db: State<DbConnection>) -> Result<i64, String> {
    db.0.lock().map_err(|e| e.to_string())?
       .query_row("SELECT COUNT(*) FROM meter_history", [], |r| r.get(0))
       .map_err(|e| e.to_string())
}


#[tauri::command]
fn save_notification_email(email: String, db: State<DbConnection>) -> Result<(), String> {
    db.0.lock().map_err(|e| e.to_string())?
        .execute(
            "INSERT OR REPLACE INTO app_config (key, value) VALUES ('dest_email', ?1)",
            params![email.trim()],
        ).map_err(|e| e.to_string())?;
    eprintln!("[notifications] Destination email saved: {}", email.trim());
    Ok(())
}

#[tauri::command]
fn get_notification_email(db: State<DbConnection>) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(conn.query_row(
        "SELECT value FROM app_config WHERE key = 'dest_email'",
        [], |r| r.get(0),
    ).unwrap_or_default())
}

#[tauri::command]
fn save_export_path(path: String, db: State<DbConnection>) -> Result<(), String> {
    db.0.lock().map_err(|e| e.to_string())?
        .execute(
            "INSERT OR REPLACE INTO app_config (key, value) VALUES ('export_path', ?1)",
            params![path.trim()],
        ).map_err(|e| e.to_string())?;
    eprintln!("[enterprise] Export directory saved: {}", path.trim());
    Ok(())
}

#[tauri::command]
fn get_export_path(db: State<DbConnection>) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    Ok(conn.query_row(
        "SELECT value FROM app_config WHERE key = 'export_path'",
        [], |r| r.get(0),
    ).unwrap_or_default())
}

#[tauri::command]
fn set_diagnostics_enabled(enabled: bool, diag: State<DiagEnabled>) -> Result<(), String> {
    diag.0.store(enabled, Ordering::Relaxed);
    eprintln!("[diag] Diagnostics {}", if enabled { "enabled" } else { "disabled" });
    Ok(())
}

// ─── Tauri Commands ── Excel Export ───────────────────────────────────────────
//
// Produces a multi-sheet workbook: one worksheet per distinct device_name.
// Each sheet has the branded report header (rows 0-4), column headers (row 5),
// and data rows (row 6+) keyed only to that device's register variables.
//
// `target_device`: Some("Main Incomer") → single-sheet export for that device
// `ts_from`/`ts_to`: optional ISO timestamp bounds ("YYYY-MM-DDTHH:MM:SS")

fn sanitize_sheet_name(name: &str) -> String {
    name.chars()
        .map(|c| if "[]*/\\?:".contains(c) { '_' } else { c })
        .take(31)
        .collect()
}

/// Core workbook builder. Extracted so nightly automation can call it without
/// going through the Tauri command layer.
fn do_export(
    conn:          &Connection,
    path:          &str,
    target_device: Option<&str>,
    ts_from:       Option<&str>,   // inclusive lower bound ISO timestamp
    ts_to:         Option<&str>,   // inclusive upper bound ISO timestamp
    username:      &str,
    project_name:  &str,
) -> Result<usize, String> {
    // ── Discover distinct device names in scope ───────────────────────────────
    let mut dist_wheres: Vec<String> = Vec::new();
    let mut dist_params: Vec<String> = Vec::new();
    if let Some(name) = target_device {
        dist_wheres.push("device_name = ?".into());
        dist_params.push(name.to_string());
    }
    if let Some(from) = ts_from {
        dist_wheres.push("timestamp >= ?".into());
        dist_params.push(from.to_string());
    }
    if let Some(to) = ts_to {
        dist_wheres.push("timestamp <= ?".into());
        dist_params.push(to.to_string());
    }
    let dist_where = if dist_wheres.is_empty() { String::new() }
                     else { format!("WHERE {}", dist_wheres.join(" AND ")) };
    let dist_sql = format!(
        "SELECT DISTINCT device_name FROM meter_history {dist_where} ORDER BY device_name ASC"
    );
    let device_names: Vec<String> = {
        let mut stmt = conn.prepare(&dist_sql).map_err(|e| e.to_string())?;
        let result = stmt.query_map(rusqlite::params_from_iter(dist_params.iter()), |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        result
    };

    if device_names.is_empty() {
        let mut wb = Workbook::new();
        wb.add_worksheet();
        wb.save(path).map_err(|e| e.to_string())?;
        return Ok(0);
    }

    // ── Shared formats (created once, borrowed by every sheet) ────────────────
    let title_fmt = Format::new()
        .set_background_color(Color::RGB(0x0D1B3E))
        .set_font_color(Color::White)
        .set_bold()
        .set_font_size(14.0)
        .set_align(FormatAlign::Left)
        .set_align(FormatAlign::VerticalCenter);

    let meta_lbl_fmt = Format::new()
        .set_background_color(Color::RGB(0x0D1B3E))
        .set_font_color(Color::RGB(0x94A3B8))
        .set_font_size(9.0)
        .set_bold()
        .set_align(FormatAlign::Left);

    let meta_val_fmt = Format::new()
        .set_background_color(Color::RGB(0x0D1B3E))
        .set_font_color(Color::White)
        .set_font_size(9.0)
        .set_align(FormatAlign::Left);

    let hdr_fmt = Format::new()
        .set_background_color(Color::RGB(0x1535D4))
        .set_font_color(Color::White)
        .set_bold()
        .set_font_size(10.0)
        .set_align(FormatAlign::Center)
        .set_align(FormatAlign::VerticalCenter)
        .set_border_bottom(FormatBorder::Medium);

    let ts_fmt = Format::new()
        .set_font_size(9.0)
        .set_align(FormatAlign::Left);

    let n2_fmt = Format::new()
        .set_num_format("0.00")
        .set_font_size(9.0)
        .set_align(FormatAlign::Right);

    let alt_ts_fmt = Format::new()
        .set_background_color(Color::RGB(0xEEF2FF))
        .set_font_size(9.0)
        .set_align(FormatAlign::Left);

    let alt_n2_fmt = Format::new()
        .set_background_color(Color::RGB(0xEEF2FF))
        .set_num_format("0.00")
        .set_font_size(9.0)
        .set_align(FormatAlign::Right);

    // ── Logo (probed once, reused on every sheet) ─────────────────────────────
    let logo_image: Option<Image> = [
        std::env::current_exe().ok()
            .and_then(|p| p.parent().map(|d| d.join("icons/128x128.png")))
            .unwrap_or_default(),
        PathBuf::from("src-tauri/icons/128x128.png"),
        PathBuf::from("src/assets/logo.png"),
        PathBuf::from("icons/128x128.png"),
    ].iter().find(|p| p.exists()).and_then(|p| Image::new(p).ok());

    // ── Workbook ──────────────────────────────────────────────────────────────
    let mut wb = Workbook::new();
    wb.set_properties(
        &DocProperties::new()
            .set_author("Technicat Group")
            .set_company("Technicat Group")
            .set_title(&format!("{} — TechniDAQ Data Report",
                target_device.unwrap_or("All Meters")))
    );

    let export_dt   = wall_clock_iso().replace('T', " ");
    let static_cols: &[&str] = &["ID", "Timestamp", "Device ID"];
    let mut total_rows: usize = 0;

    // ── Per-device sheet loop ─────────────────────────────────────────────────
    for device_name in &device_names {
        let mut dev_params: Vec<String> = vec![device_name.clone()];
        let mut extra_clauses: Vec<&str> = Vec::new();
        if ts_from.is_some() { extra_clauses.push(" AND timestamp >= ?"); dev_params.push(ts_from.unwrap().to_string()); }
        if ts_to.is_some()   { extra_clauses.push(" AND timestamp <= ?"); dev_params.push(ts_to.unwrap().to_string()); }
        let time_clause: String = extra_clauses.concat();
        let dev_sql = format!(
            "SELECT id, timestamp, device_id, data \
             FROM meter_history WHERE device_name = ?{time_clause} ORDER BY id ASC"
        );

        #[derive(Debug)]
        struct DevRow { id: i64, timestamp: String, device_id: String, data: String }

        let dev_rows: Vec<DevRow> = {
            let mut stmt = conn.prepare(&dev_sql).map_err(|e| e.to_string())?;
            let result = stmt.query_map(
                rusqlite::params_from_iter(dev_params.iter()),
                |r| Ok(DevRow {
                    id: r.get(0)?, timestamp: r.get(1)?,
                    device_id: r.get(2)?, data: r.get(3)?,
                }),
            ).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
            result
        };

        // Build register key order for this device only
        let mut key_order: Vec<String> = Vec::new();
        let mut key_set: HashSet<String> = HashSet::new();
        let parsed: Vec<HashMap<String, f64>> = dev_rows.iter().map(|row| {
            let map: HashMap<String, f64> = serde_json::from_str(&row.data).unwrap_or_default();
            for k in map.keys() { if key_set.insert(k.clone()) { key_order.push(k.clone()); } }
            map
        }).collect();

        let total_cols = (static_cols.len() + key_order.len()) as u16;

        // ── Create worksheet ──────────────────────────────────────────────────
        let ws = wb.add_worksheet();
        ws.set_name(&sanitize_sheet_name(device_name)).map_err(|e| e.to_string())?;

        for c in 0..total_cols { ws.set_column_width(c, 22.0).ok(); }

        // ── Report header (rows 0-4) ──────────────────────────────────────────
        ws.set_row_height(0, 28.0).ok();
        ws.set_row_height(1, 16.0).ok();
        ws.set_row_height(2, 16.0).ok();
        ws.set_row_height(3, 16.0).ok();
        ws.set_row_height(4,  8.0).ok();
        ws.set_row_height(5, 20.0).ok();

        let merge_end = if total_cols > 1 { total_cols - 1 } else { 0 };
        ws.merge_range(0, 0, 0, merge_end,
            "Technicat Group \u{2014} Automated Data Report", &title_fmt)
            .map_err(|e| e.to_string())?;

        for (row_idx, (label, value)) in [
            ("Export Date:", export_dt.as_str()),
            ("User:",        username.trim()),
            ("Project:",     project_name.trim()),
        ].iter().enumerate() {
            let r = (row_idx + 1) as u32;
            ws.write_with_format(r, 0, *label, &meta_lbl_fmt).ok();
            if merge_end > 0 {
                ws.merge_range(r, 1, r, merge_end, *value, &meta_val_fmt).ok();
            } else {
                ws.write_with_format(r, 1, *value, &meta_val_fmt).ok();
            }
        }
        ws.merge_range(4, 0, 4, merge_end, "", &meta_lbl_fmt).ok();

        if let Some(ref img) = logo_image {
            ws.insert_image(0, total_cols + 1, img).ok();
        }

        // ── Column header row (row 5) ─────────────────────────────────────────
        for (c, label) in static_cols.iter().enumerate() {
            ws.write_with_format(5, c as u16, *label, &hdr_fmt).map_err(|e| e.to_string())?;
        }
        for (i, key) in key_order.iter().enumerate() {
            ws.write_with_format(5, (static_cols.len() + i) as u16, key.as_str(), &hdr_fmt)
                .map_err(|e| e.to_string())?;
        }
        ws.set_freeze_panes(6, 0).map_err(|e| e.to_string())?;

        // ── Watermark ─────────────────────────────────────────────────────────
        // Note: rust_xlsxwriter 0.80 does not expose a public set_rotation() on
        // Shape (the field is pub(crate)).  Rotate270 gives the closest visual
        // effect (vertical text) without patching the library.
        let wm_font = ShapeFont::new()
            .set_bold()
            .set_color(Color::RGB(0xEBEBEB))
            .set_size(80.0);
        let wm_fmt = ShapeFormat::new()
            .set_no_fill()
            .set_no_line();
        let wm_text = ShapeText::new().set_direction(ShapeTextDirection::Rotate270);
        let watermark = Shape::textbox()
            .set_text("Technicat Group")
            .set_font(&wm_font)
            .set_format(&wm_fmt)
            .set_text_options(&wm_text)
            .set_width(400)
            .set_height(800);
        ws.insert_shape(6, 2, &watermark).ok();

        // ── Data rows (row 6+) ────────────────────────────────────────────────
        let n = dev_rows.len();
        for (i, (row, data_map)) in dev_rows.iter().zip(parsed.iter()).enumerate() {
            let xr  = (i + 6) as u32;
            let alt = i % 2 == 1;
            ws.write(xr, 0, row.id).ok();
            let ts = row.timestamp.replace('T', " ");
            ws.write_with_format(xr, 1, ts.as_str(),
                if alt { &alt_ts_fmt } else { &ts_fmt }).ok();
            ws.write_with_format(xr, 2, row.device_id.as_str(),
                if alt { &alt_ts_fmt } else { &ts_fmt }).ok();
            for (j, key) in key_order.iter().enumerate() {
                let col = (static_cols.len() + j) as u16;
                if let Some(&val) = data_map.get(key) {
                    ws.write_with_format(xr, col, val,
                        if alt { &alt_n2_fmt } else { &n2_fmt }).ok();
                }
            }
        }

        if n > 0 {
            ws.autofilter(5, 0, (5 + n) as u32,
                (static_cols.len() + key_order.len().saturating_sub(1)) as u16).ok();
        }
        ws.protect_with_password("TDAQ_Secure_2026!");
        ws.protect_with_options(&ProtectionOptions {
            select_locked_cells:   true,
            select_unlocked_cells: true,
            ..ProtectionOptions::default()
        });
        total_rows += n;
    }

    wb.save(path).map_err(|e| e.to_string())?;
    Ok(total_rows)
}

#[tauri::command]
fn export_to_excel(
    path:               String,
    target_device:      Option<String>,
    time_range_seconds: Option<u64>,
    username:           String,
    project_name:       String,
    db:                 State<DbConnection>,
) -> Result<usize, String> {
    let ts_from = time_range_seconds.map(|s| secs_to_iso(now_secs().saturating_sub(s)));
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    do_export(&conn, &path, target_device.as_deref(), ts_from.as_deref(), None, &username, &project_name)
}

// ─── Tauri Commands ── Build Info ─────────────────────────────────────────────

#[derive(Serialize)]
struct BuildInfo {
    is_cloud_build: bool,
}

#[tauri::command]
fn get_build_info() -> BuildInfo {
    BuildInfo { is_cloud_build: cfg!(feature = "cloud_sync") }
}

// ─── Tauri Commands ── License ────────────────────────────────────────────────

#[tauri::command]
async fn activate_license(
    key:          String,
    username:     String,
    project_name: String,
    db:           State<'_, DbConnection>,
) -> Result<String, String> {
    eprintln!("[license] activate_license called — user='{}' project='{}'",
              username.trim(), project_name.trim());

    let payload = decrypt_license_token(&key).map_err(|e| {
        eprintln!("[license] ❌ decrypt failed: {e}");
        e
    })?;

    eprintln!("[license] ✔ decrypted — token_user='{}' token_project='{}' duration_days={} ttl_hours={} created_at={}",
              payload.username, payload.project_name,
              payload.duration_days, payload.ttl_hours, payload.created_at);

    let now = now_secs();
    eprintln!("[license] time check — now={now} created_at={} deadline={}",
              payload.created_at,
              payload.created_at.saturating_add(payload.ttl_hours * 3_600));

    let activation_deadline = payload.created_at.saturating_add(payload.ttl_hours * 3_600);
    if now > activation_deadline {
        let age_mins = now.saturating_sub(payload.created_at) / 60;
        let msg = format!(
            "Token expired ({age_mins} min old). Keys must be activated within {} hour(s) of generation.",
            payload.ttl_hours);
        eprintln!("[license] ❌ {msg}");
        return Err(msg);
    }
    if payload.created_at > now + 300 {
        eprintln!("[license] ❌ future timestamp: created_at={} now={now}", payload.created_at);
        return Err("Token has a future timestamp. Check system clock.".into());
    }
    if payload.username.trim() != username.trim() || payload.project_name.trim() != project_name.trim() {
        eprintln!("[license] ❌ credential mismatch — token=('{}','{}') input=('{}','{}')",
                  payload.username.trim(), payload.project_name.trim(),
                  username.trim(), project_name.trim());
        return Err("Invalid User or Project credentials for this license.".into());
    }
    if payload.allowed_meters.is_empty() {
        eprintln!("[license] ❌ no allowed meters in token");
        return Err("License contains no allowed meter models.".into());
    }

    let expiry_date = (payload.created_at + payload.duration_days * 86_400) as i64;
    let meters_json = serde_json::to_string(&payload.allowed_meters).map_err(|e| e.to_string())?;

    eprintln!("[license] writing to DB — expiry_date={expiry_date} meters={meters_json} mode={} tier={} protocols={}",
              payload.mode, payload.tier, payload.protocols);
    {
        let conn = db.0.lock().map_err(|e| {
            eprintln!("[license] ❌ DB lock failed: {e}");
            e.to_string()
        })?;
        conn.execute("DELETE FROM settings", []).map_err(|e| {
            eprintln!("[license] ❌ DELETE settings failed: {e}");
            e.to_string()
        })?;
        conn.execute(
            "INSERT INTO settings (username, project_name, expiry_date, allowed_meters, mode, tier, protocols, machine_api_key) VALUES (?1,?2,?3,?4,?5,?6,?7,'')",
            params![username.trim(), project_name.trim(), expiry_date, meters_json,
                    payload.mode, payload.tier as i64, payload.protocols],
        ).map_err(|e| {
            eprintln!("[license] ❌ INSERT settings failed: {e}");
            e.to_string()
        })?;
    } // ← DB lock released before any async work

    // ── Cloud Handshake (online mode only, cloud build only) ──────────────────
    #[cfg(feature = "cloud_sync")]
    if payload.mode == "online" {
        let machine_id = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            get_or_create_machine_id(&conn)
        };
        let client = HttpClient::builder()
            .timeout(Duration::from_secs(15))
            .https_only(true)
            .build()
            .map_err(|e| format!("HTTP client error: {e}"))?;
        let resp = client
            .post(format!("{CLOUD_API_URL}/api/machine/activate"))
            .json(&serde_json::json!({
                "license_key":  key,
                "username":     username.trim(),
                "project_name": project_name.trim(),
                "machine_id":   machine_id,
                "tier":         payload.tier,
                "protocols":    payload.protocols,
            }))
            .send()
            .await
            .map_err(|e| format!("Cloud activation request failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body   = resp.text().await.unwrap_or_default();
            return Err(format!("Cloud rejected activation: HTTP {status} — {body}"));
        }
        let json: serde_json::Value = resp.json().await
            .map_err(|e| format!("Cloud response parse error: {e}"))?;
        let api_key = json["machine_api_key"]
            .as_str()
            .ok_or_else(|| "Cloud response missing machine_api_key field".to_string())?
            .to_string();
        {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            conn.execute("UPDATE settings SET machine_api_key = ?1", params![api_key])
                .map_err(|e| format!("Failed to store machine_api_key: {e}"))?;
        }
        eprintln!("[license] ✔ Cloud handshake complete — machine registered with cloud");
    }

    let msg = format!("License activated for {} / {}. Valid {} days. Mode={} Tier={} Protocols={}.",
        username.trim(), project_name.trim(), payload.duration_days,
        payload.mode, payload.tier, payload.protocols);
    eprintln!("[license] ✔ {msg}");
    Ok(msg)
}

#[tauri::command]
fn get_auth_state(db: State<DbConnection>) -> Result<AuthState, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let now  = now_secs() as i64;
    match conn.query_row(
        "SELECT username, project_name, expiry_date, allowed_meters, mode, tier, protocols, machine_api_key FROM settings LIMIT 1", [],
        |r| Ok((
            r.get::<_,String>(0)?, r.get::<_,String>(1)?,
            r.get::<_,i64>(2)?,   r.get::<_,String>(3)?,
            r.get::<_,String>(4).unwrap_or_else(|_| "offline".into()),
            r.get::<_,i64>(5).unwrap_or(1),
            r.get::<_,String>(6).unwrap_or_else(|_| "All".into()),
            r.get::<_,String>(7).unwrap_or_default(),
        )),
    ) {
        Ok((u, p, exp, m, mode, tier, protocols, api_key)) if now < exp => Ok(AuthState {
            valid: true, username: Some(u), project_name: Some(p), expiry_date: Some(exp),
            allowed_meters:   serde_json::from_str(&m).unwrap_or_default(),
            mode:             Some(mode),
            tier:             Some(tier as u8),
            protocols:        Some(protocols),
            cloud_registered: !api_key.is_empty(),
        }),
        _ => Ok(AuthState {
            valid: false, username: None, project_name: None, expiry_date: None,
            allowed_meters: vec![], mode: None, tier: None, protocols: None,
            cloud_registered: false,
        }),
    }
}

// ─── Tauri Commands ── Device Library ────────────────────────────────────────

/// Returns all available profiles the user's license permits, always including Custom.
/// If `allowed_meters` contains "All", every profile in the library is returned.
#[tauri::command]
fn get_meter_profiles(
    allowed_meters: Vec<String>,
    profiles_state: State<ProfilesState>,
) -> Result<Vec<MeterProfileEntry>, String> {
    let lib = profiles_state.0.lock().map_err(|e| e.to_string())?;

    let norm_allowed: Vec<String> = allowed_meters.iter().map(|m| normalize_meter_name(m)).collect();
    let allow_all = norm_allowed.contains(&"all".to_string());

    let mut result: Vec<MeterProfileEntry> = if allow_all {
        // License grants everything — return all profiles in the library
        let mut v: Vec<MeterProfileEntry> = lib.values().cloned().collect();
        v.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        v
    } else {
        norm_allowed.iter()
            .filter(|m| m.as_str() != "custom" && m.as_str() != "simulation")
            .filter_map(|norm| {
                lib.values().find(|p| normalize_meter_name(&p.model) == *norm).cloned()
            })
            .collect()
    };

    // Inject "Custom" when license permits it ("Custom" or "All")
    let license_allows_custom = allow_all || norm_allowed.contains(&"custom".to_string());
    if license_allows_custom && !result.iter().any(|p| p.model == "Custom") {
        result.push(custom_profile());
    }

    // Inject "Simulation" when license permits it ("Simulation" or "All")
    // Clone PM2220 registers so the demo shows real variables; fall back to blank if not found.
    let license_allows_sim = allow_all || norm_allowed.contains(&"simulation".to_string());
    if license_allows_sim && !result.iter().any(|p| p.model == "Simulation") {
        let sim = lib.values()
            .find(|p| normalize_meter_name(&p.model) == "schneider_pm2220")
            .map(|pm| MeterProfileEntry {
                model:        "Simulation".into(),
                display_name: "Simulation".into(),
                endianness:   pm.endianness.clone(),
                baud_rate:    pm.baud_rate,
                parity:       pm.parity.clone(),
                registers:    pm.registers.clone(),
            })
            .unwrap_or_else(simulation_profile);
        result.push(sim);
    }

    Ok(result)
}

/// Reload the profiles library from disk (useful after the user edits profiles.json at runtime).
#[tauri::command]
fn reload_profiles(profiles_state: State<ProfilesState>) -> Result<usize, String> {
    let fresh = load_profiles_from_disk();
    let count = fresh.len();
    *profiles_state.0.lock().map_err(|e| e.to_string())? = fresh;
    eprintln!("[profiles] Reloaded — {count} profiles available");
    Ok(count)
}

/// Accept an array of fully-configured device slots from the frontend.
/// Validates each entry and stores them in engine state.
#[tauri::command]
fn apply_bus_config(
    devices:        Vec<DeviceConfig>,
    profiles_state: State<ProfilesState>,
    engine:         State<SharedEngine>,
    ws:             State<WsClients>,
) -> Result<Vec<DeviceConfig>, String> {
    if devices.is_empty() { return Err("At least one device must be configured.".into()); }

    let lib = profiles_state.0.lock().map_err(|e| e.to_string())?;

    for dev in &devices {
        if dev.device_name.trim().is_empty() {
            return Err(format!("A device is missing its name."));
        }
        if dev.slave_id == 0 || dev.slave_id > 247 {
            return Err(format!("\"{}\" — Slave ID must be 1–247, got {}", dev.device_name, dev.slave_id));
        }
        if dev.poll_rate_ms < 200 {
            return Err(format!("\"{}\" — Poll rate must be ≥ 200 ms, got {}", dev.device_name, dev.poll_rate_ms));
        }
        if dev.selected_registers.is_empty() {
            return Err(format!("\"{}\" — At least one register must be selected.", dev.device_name));
        }
        {
            let norm = normalize_meter_name(&dev.meter_model);
            let is_virtual = norm == "custom" || norm == "custom_device" || norm == "simulation";
            let in_lib = lib.values().any(|p| normalize_meter_name(&p.model) == norm);
            if !is_virtual && !in_lib {
                return Err(format!("\"{}\" — Unknown model \"{}\".", dev.device_name, dev.meter_model));
            }
        }
    }

    // Warn if devices on the same slave ID (Modbus collision)
    let mut seen_ids = HashSet::new();
    for dev in &devices {
        if !seen_ids.insert(dev.slave_id) {
            return Err(format!("Duplicate Slave ID {} — each device must have a unique address.", dev.slave_id));
        }
    }

    let total_regs: usize = devices.iter().map(|d| d.selected_registers.len()).sum();
    {
        let mut eng = engine.0.lock().map_err(|e| e.to_string())?;
        eng.configured_devices = devices.clone();
    }
    eprintln!("[engine] Bus config: {} devices, {} total registers", devices.len(), total_regs);
    ws_broadcast(&ws.0, build_state_msg(&engine.0));
    Ok(devices)
}

// ─── Async Register Read ──────────────────────────────────────────────────────

async fn read_one_register(
    ctx:    &mut tokio_modbus::client::Context,
    reg:    &RegisterEntry,
    endian: &str,
) -> Result<f64, String> {
    let regs = ctx.read_holding_registers(reg.address, reg.length)
        .await.map_err(|e| format!("{}: {e}", reg.name))?;
    if regs.len() < reg.length as usize {
        return Err(format!("{}: expected {} regs, got {}", reg.name, reg.length, regs.len()));
    }
    Ok(decode_register(&regs[..reg.length as usize], endian, &reg.data_type, reg.multiplier))
}

async fn poll_device_registers(
    ctx:       &mut tokio_modbus::client::Context,
    registers: &[RegisterEntry],
    endian:    &str,
) -> Result<HashMap<String, f64>, String> {
    let mut data = HashMap::new();
    for reg in registers {
        match read_one_register(ctx, reg, endian).await {
            Ok(v)  => { data.insert(reg.name.clone(), v); }
            Err(e) => return Err(e),
        }
    }
    Ok(data)
}

// ─── Diag + Alarm Helpers ─────────────────────────────────────────────────────

fn modbus_crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for byte in data {
        crc ^= *byte as u16;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xA001 } else { crc >> 1 };
        }
    }
    crc
}

fn fmt_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join(" ")
}

fn modbus_request_hex(slave: u8, address: u16, count: u16) -> String {
    let mut frame = vec![slave, 0x03, (address >> 8) as u8, (address & 0xFF) as u8,
                         (count >> 8) as u8, (count & 0xFF) as u8];
    let crc = modbus_crc16(&frame);
    frame.push((crc & 0xFF) as u8);
    frame.push((crc >> 8) as u8);
    fmt_hex(&frame)
}

#[cfg(feature = "cloud_sync")]
async fn send_alarm_email(dest: &str, device: &str, reg: &str, value: f64, breach: &str) {
    if SMTP_HOST.is_empty() || SMTP_USER.is_empty() || dest.is_empty() { return; }
    // Connectivity probe
    let probe = tokio::time::timeout(
        Duration::from_secs(2),
        TcpStream::connect((SMTP_HOST, 587u16)),
    ).await;
    if matches!(probe, Err(_) | Ok(Err(_))) {
        eprintln!("[email] Network unreachable — skipping alarm email");
        return;
    }
    let subject = format!("TechniDAQ Alarm — {} · {} {}", device, reg, breach);
    let body    = format!(
        "TechniDAQ has detected an alarm condition.\n\nDevice  : {}\nRegister: {}\nValue   : {:.4}\nStatus  : {}\n\nThis is an automated alert from TechniDAQ by Technicat Group.",
        device, reg, value, breach
    );
    let email = match Message::builder()
        .from(SMTP_USER.parse().unwrap())
        .to(match dest.parse() { Ok(a) => a, Err(e) => { eprintln!("[email] Bad dest addr: {e}"); return; } })
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body) {
            Ok(m) => m,
            Err(e) => { eprintln!("[email] Build error: {e}"); return; }
    };
    let creds   = Credentials::new(SMTP_USER.to_string(), SMTP_PASS.to_string());
    let mailer  = match AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(SMTP_HOST) {
        Ok(b) => b.credentials(creds).build(),
        Err(e) => { eprintln!("[email] SMTP build error: {e}"); return; }
    };
    match mailer.send(email).await {
        Ok(_)  => eprintln!("[email] Alarm sent → {dest}"),
        Err(e) => eprintln!("[email] Send failed: {e}"),
    }
}

#[cfg(not(feature = "cloud_sync"))]
async fn send_alarm_email(_dest: &str, _device: &str, _reg: &str, _value: f64, _breach: &str) {
    eprintln!("[email] Disabled in Air-Gapped build — recompile with --features cloud_sync to enable.");
}

// ─── Per-device Connection Factory ───────────────────────────────────────────

async fn try_connect(
    device:   &DeviceConfig,
    profiles: &Arc<Mutex<HashMap<String, MeterProfileEntry>>>,
) -> Result<tokio_modbus::client::Context, String> {
    match device.protocol {
        Protocol::Rtu => {
            let parity = {
                let lib = profiles.lock().unwrap();
                lib.get(&device.meter_model).map(|p| match p.parity.as_str() {
                    "Even" => tokio_serial::Parity::Even,
                    "Odd"  => tokio_serial::Parity::Odd,
                    _      => tokio_serial::Parity::None,
                }).unwrap_or(tokio_serial::Parity::None)
            };
            let builder = tokio_serial::new(&device.com_port, device.baud_rate)
                .parity(parity)
                .stop_bits(tokio_serial::StopBits::One)
                .data_bits(tokio_serial::DataBits::Eight)
                .timeout(Duration::from_millis(PORT_TIMEOUT_MS));
            let serial = SerialStream::open(&builder)
                .map_err(|e| format!("Cannot open {}: {e}", device.com_port))?;
            rtu::connect_slave(serial, Slave(device.slave_id)).await
                .map_err(|e| format!("Modbus RTU: {e}"))
        }
        Protocol::Tcp => {
            let addr_str = format!("{}:{}", device.ip_address, device.tcp_port);
            let addr: std::net::SocketAddr = addr_str.parse()
                .map_err(|e| format!("Bad TCP address \"{addr_str}\": {e}"))?;
            tokio::time::timeout(
                Duration::from_secs(2),
                tcp::connect_slave(addr, Slave(device.slave_id)),
            ).await
            .map_err(|_| format!("TCP connect timeout ({}:{})", device.ip_address, device.tcp_port))?
            .map_err(|e| format!("Modbus TCP: {e}"))
        }
    }
}

// ─── Multi-Device RS485 Polling Loop ─────────────────────────────────────────

async fn run_polling_loop(
    engine:     Arc<Mutex<EngineState>>,
    db:         Arc<Mutex<Connection>>,
    profiles:   Arc<Mutex<HashMap<String, MeterProfileEntry>>>,
    app:        tauri::AppHandle,
    diag:       Arc<AtomicBool>,
    ws_clients: WsClientList,
) {
    let mut last_polled:       HashMap<String, Instant>                        = HashMap::new();
    let mut email_debounce:    HashMap<String, Instant>                        = HashMap::new();
    let mut alarm_consecutive: HashMap<String, u32>                            = HashMap::new();
    let mut conn_map:          HashMap<ConnKey, tokio_modbus::client::Context> = HashMap::new();
    let mut fault_retry:       HashMap<ConnKey, Instant>                       = HashMap::new();

    loop {
        // ── License guard ─────────────────────────────────────────────────
        if !is_license_valid(&db) {
            conn_map.clear(); fault_retry.clear();
            sleep(Duration::from_secs(5)).await;
            continue;
        }

        let (state, devices) = {
            let e = engine.lock().unwrap();
            (e.poll.clone(), e.configured_devices.clone())
        };

        // ── Idle guards ───────────────────────────────────────────────────
        if devices.is_empty() {
            conn_map.clear();
            sleep(Duration::from_millis(500)).await;
            continue;
        }

        if state == PollState::Stopped {
            conn_map.clear(); last_polled.clear();
            sleep(Duration::from_millis(250)).await;
            continue;
        }

        // Defensively handle a Fault that was set externally
        if state == PollState::Fault {
            { let mut e = engine.lock().unwrap(); e.poll = PollState::Running; }
            let _ = app.emit("status-changed", StatusEvent { state: PollState::Running });
            sleep(Duration::from_secs(2)).await;
            continue;
        }

        // ── Simulation mode ───────────────────────────────────────────────
        let is_sim = get_allowed_meters_from_db(&db).contains(&"Simulation".to_string());
        if is_sim {
            conn_map.clear();
            let tick_start = Instant::now();
            for device in &devices {
                let elapsed = last_polled.get(&device.device_name)
                    .map(|t| t.elapsed().as_millis())
                    .unwrap_or(u128::MAX);
                if elapsed < device.poll_rate_ms as u128 { continue; }

                let data: HashMap<String, f64> = device.selected_registers.iter().enumerate()
                    .map(|(i, reg)| (reg.name.clone(), sim_register_value(&reg.name, i)))
                    .collect();
                let device_id = format!("{} #{:02}", device.meter_model.replace('_', " "), device.slave_id);
                let data_json = serde_json::to_string(&data).unwrap_or_default();

                {
                    let conn = db.lock().unwrap();
                    if let Err(e) = conn.execute(
                        "INSERT INTO meter_history (timestamp, device_name, device_id, data) VALUES (?1,?2,?3,?4)",
                        params![wall_clock_iso(), &device.device_name, &device_id, &data_json],
                    ) { eprintln!("[sim] INSERT: {e}"); }
                }
                let ts = now_ms();
                let ws_frame = serde_json::json!({
                    "type": "METER_DATA",
                    "device_name": &device.device_name,
                    "device_id": &device_id,
                    "timestamp_ms": ts,
                    "data": &data,
                }).to_string();
                let _ = app.emit("meter-data", MeterReading {
                    device_name: device.device_name.clone(),
                    device_id,
                    timestamp_ms: ts,
                    data: data.clone(),
                });
                ws_broadcast(&ws_clients, ws_frame);
                last_polled.insert(device.device_name.clone(), Instant::now());

                // Alarm check
                let allowed = get_allowed_meters_from_db(&db);
                if allowed.contains(&"EmailAlerts".to_string()) {
                    let dest_email: String = {
                        let conn = db.lock().unwrap();
                        conn.query_row("SELECT value FROM app_config WHERE key='dest_email'", [], |r| r.get(0))
                            .unwrap_or_default()
                    };
                    for reg in &device.selected_registers {
                        let val = match data.get(&reg.name) { Some(&v) => v, None => continue };
                        let key = format!("{}::{}", device.device_name, reg.name);
                        let breach = if let Some(mx) = reg.max_alarm { if val > mx { Some(format!("> max {mx:.2}")) } else { None } }
                                     else if let Some(mn) = reg.min_alarm { if val < mn { Some(format!("< min {mn:.2}")) } else { None } }
                                     else { None };
                        match breach {
                            None    => { alarm_consecutive.remove(&key); }
                            Some(b) => {
                                let count = alarm_consecutive.entry(key.clone()).or_insert(0);
                                *count += 1;
                                if *count >= device.alarm_trigger_cycles {
                                    let due = email_debounce.get(&key).map_or(true, |t| t.elapsed().as_secs() >= 3600);
                                    if due {
                                        email_debounce.insert(key, Instant::now());
                                        let dest = dest_email.clone();
                                        let dev  = device.device_name.clone();
                                        let rn   = reg.name.clone();
                                        let br   = b.clone();
                                        tokio::spawn(async move { send_alarm_email(&dest, &dev, &rn, val, &br).await; });
                                    }
                                }
                            }
                        }
                    }
                }
                // Diagnostics
                if diag.load(Ordering::Relaxed) {
                    for reg in &device.selected_registers {
                        let tx_hex = modbus_request_hex(device.slave_id, reg.address, reg.length);
                        let _ = app.emit("diag-frame", DiagEvent {
                            direction: "TX".into(), hex: tx_hex,
                            device_name: device.device_name.clone(), timestamp_ms: now_ms(),
                        });
                        let val = data.get(&reg.name).copied().unwrap_or(0.0);
                        let raw_bytes = (val as u32).to_be_bytes();
                        let byte_count = (reg.length * 2) as u8;
                        let mut rx = vec![device.slave_id, 0x03, byte_count];
                        rx.extend_from_slice(&raw_bytes[..(byte_count as usize).min(4)]);
                        let crc = modbus_crc16(&rx);
                        rx.push((crc & 0xFF) as u8); rx.push((crc >> 8) as u8);
                        let _ = app.emit("diag-frame", DiagEvent {
                            direction: "RX".into(), hex: fmt_hex(&rx),
                            device_name: device.device_name.clone(), timestamp_ms: now_ms(),
                        });
                    }
                }
                sleep(Duration::from_millis(RS485_TURNAROUND_MS)).await;
            }
            let elapsed_tick = tick_start.elapsed();
            let tick_dur = Duration::from_millis(TICK_MS);
            if elapsed_tick < tick_dur { sleep(tick_dur - elapsed_tick).await; }
            continue;
        }

        // ── Real-hardware poll cycle ──────────────────────────────────────
        let tick_start = Instant::now();

        // Read protocol restriction once per tick (cheap — only one DB read).
        let license_protocols = get_license_protocols_from_db(&db);

        for device in &devices {
            // ── License protocol gate ─────────────────────────────────────
            let protocol_blocked = match license_protocols.as_str() {
                "RTU" => matches!(device.protocol, Protocol::Tcp),
                "TCP" => matches!(device.protocol, Protocol::Rtu),
                _     => false, // "All" — no restriction
            };
            if protocol_blocked {
                let proto_name = match device.protocol { Protocol::Rtu => "RTU", Protocol::Tcp => "TCP" };
                let reason = format!(
                    "License Fault: '{}' protocol not permitted — license restricts to {} only",
                    proto_name, license_protocols
                );
                eprintln!("[license] ⛔ {} — {reason}", device.device_name);
                let _ = app.emit("meter-fault", FaultEvent {
                    device_name: device.device_name.clone(),
                    reason,
                    timestamp_ms: now_ms(),
                });
                last_polled.insert(device.device_name.clone(), Instant::now());
                continue;
            }

            // Is this device due for a poll?
            let elapsed = last_polled.get(&device.device_name)
                .map(|t| t.elapsed().as_millis())
                .unwrap_or(u128::MAX);
            if elapsed < device.poll_rate_ms as u128 { continue; }

            // ── Per-device simulation bypass ──────────────────────────────────
            if normalize_meter_name(&device.meter_model) == "simulation" {
                let data: HashMap<String, f64> = device.selected_registers.iter().enumerate()
                    .map(|(i, reg)| (reg.name.clone(), sim_register_value(&reg.name, i)))
                    .collect();
                let device_id = format!("Simulation #{:02}", device.slave_id);
                let data_json = serde_json::to_string(&data).unwrap_or_default();
                {
                    let conn = db.lock().unwrap();
                    if let Err(e) = conn.execute(
                        "INSERT INTO meter_history (timestamp, device_name, device_id, data) VALUES (?1,?2,?3,?4)",
                        params![wall_clock_iso(), &device.device_name, &device_id, &data_json],
                    ) { eprintln!("[sim] INSERT: {e}"); }
                }
                let ts = now_ms();
                let ws_frame = serde_json::json!({
                    "type": "METER_DATA",
                    "device_name": &device.device_name,
                    "device_id": &device_id,
                    "timestamp_ms": ts,
                    "data": &data,
                }).to_string();
                let _ = app.emit("meter-data", MeterReading {
                    device_name: device.device_name.clone(),
                    device_id,
                    timestamp_ms: ts,
                    data,
                });
                ws_broadcast(&ws_clients, ws_frame);
                last_polled.insert(device.device_name.clone(), Instant::now());
                continue;
            }

            let conn_key = ConnKey::from_device(device);

            // Per-connection fault cooldown
            if let Some(fault_ts) = fault_retry.get(&conn_key) {
                if fault_ts.elapsed().as_secs() < 2 { continue; }
                fault_retry.remove(&conn_key);
            }

            // Lazy-connect
            if !conn_map.contains_key(&conn_key) {
                match try_connect(device, &profiles).await {
                    Ok(ctx) => {
                        eprintln!("[engine] Connected «{}» via {:?}", device.device_name, conn_key);
                        conn_map.insert(conn_key.clone(), ctx);
                    }
                    Err(e) => {
                        eprintln!("[engine] Connect error «{}»: {e}", device.device_name);
                        let _ = app.emit("meter-fault", FaultEvent {
                            device_name: device.device_name.clone(),
                            reason: e,
                            timestamp_ms: now_ms(),
                        });
                        fault_retry.insert(conn_key, Instant::now());
                        continue;
                    }
                }
            }

            // Get context and switch slave
            let ctx = conn_map.get_mut(&conn_key).unwrap();
            ctx.set_slave(Slave(device.slave_id));

            // Look up endianness for this device model
            let endian = {
                let lib = profiles.lock().unwrap();
                lib.get(&device.meter_model).map(|p| p.endianness.clone())
                   .unwrap_or_else(|| "ABCD".into())
            };

            match poll_device_registers(ctx, &device.selected_registers, &endian).await {
                Err(e) => {
                    eprintln!("[engine] Poll error «{}»: {e}", device.device_name);
                    let _ = app.emit("meter-fault", FaultEvent {
                        device_name: device.device_name.clone(),
                        reason: e,
                        timestamp_ms: now_ms(),
                    });
                    // Remove faulted connection; retry after cooldown.
                    // Other devices on different connections keep running.
                    conn_map.remove(&conn_key);
                    fault_retry.insert(conn_key, Instant::now());
                    // Do NOT break — continue polling other devices
                }
                Ok(data) => {
                    let device_id = format!("{} #{:02}", device.meter_model.replace('_', " "), device.slave_id);
                    let data_json = serde_json::to_string(&data).unwrap_or_default();

                    {
                        let conn = db.lock().unwrap();
                        if let Err(e) = conn.execute(
                            "INSERT INTO meter_history (timestamp, device_name, device_id, data) VALUES (?1,?2,?3,?4)",
                            params![wall_clock_iso(), &device.device_name, &device_id, &data_json],
                        ) { eprintln!("[db] INSERT: {e}"); }
                    }

                    let ts = now_ms();
                    let ws_frame = serde_json::json!({
                        "type": "METER_DATA",
                        "device_name": &device.device_name,
                        "device_id": &device_id,
                        "timestamp_ms": ts,
                        "data": &data,
                    }).to_string();
                    let _ = app.emit("meter-data", MeterReading {
                        device_name: device.device_name.clone(),
                        device_id,
                        timestamp_ms: ts,
                        data: data.clone(),
                    });
                    ws_broadcast(&ws_clients, ws_frame);
                    last_polled.insert(device.device_name.clone(), Instant::now());

                    // Alarm check
                    let allowed = get_allowed_meters_from_db(&db);
                    if allowed.contains(&"EmailAlerts".to_string()) {
                        let dest_email: String = {
                            let conn = db.lock().unwrap();
                            conn.query_row("SELECT value FROM app_config WHERE key='dest_email'", [], |r| r.get(0))
                                .unwrap_or_default()
                        };
                        for reg in &device.selected_registers {
                            let val = match data.get(&reg.name) { Some(&v) => v, None => continue };
                            let key = format!("{}::{}", device.device_name, reg.name);
                            let breach = if let Some(mx) = reg.max_alarm { if val > mx { Some(format!("> max {mx:.2}")) } else { None } }
                                         else if let Some(mn) = reg.min_alarm { if val < mn { Some(format!("< min {mn:.2}")) } else { None } }
                                         else { None };
                            match breach {
                                None    => { alarm_consecutive.remove(&key); }
                                Some(b) => {
                                    let count = alarm_consecutive.entry(key.clone()).or_insert(0);
                                    *count += 1;
                                    if *count >= device.alarm_trigger_cycles {
                                        let due = email_debounce.get(&key).map_or(true, |t| t.elapsed().as_secs() >= 3600);
                                        if due {
                                            email_debounce.insert(key, Instant::now());
                                            let dest = dest_email.clone();
                                            let dev  = device.device_name.clone();
                                            let rn   = reg.name.clone();
                                            let br   = b.clone();
                                            tokio::spawn(async move { send_alarm_email(&dest, &dev, &rn, val, &br).await; });
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // Diagnostics
                    if diag.load(Ordering::Relaxed) {
                        for reg in &device.selected_registers {
                            let tx_hex = modbus_request_hex(device.slave_id, reg.address, reg.length);
                            let _ = app.emit("diag-frame", DiagEvent {
                                direction: "TX".into(), hex: tx_hex,
                                device_name: device.device_name.clone(), timestamp_ms: now_ms(),
                            });
                            let val = data.get(&reg.name).copied().unwrap_or(0.0);
                            let raw_bytes = (val as u32).to_be_bytes();
                            let byte_count = (reg.length * 2) as u8;
                            let mut rx = vec![device.slave_id, 0x03, byte_count];
                            rx.extend_from_slice(&raw_bytes[..(byte_count as usize).min(4)]);
                            let crc = modbus_crc16(&rx);
                            rx.push((crc & 0xFF) as u8); rx.push((crc >> 8) as u8);
                            let _ = app.emit("diag-frame", DiagEvent {
                                direction: "RX".into(), hex: fmt_hex(&rx),
                                device_name: device.device_name.clone(), timestamp_ms: now_ms(),
                            });
                        }
                    }
                    sleep(Duration::from_millis(RS485_TURNAROUND_MS)).await;
                }
            }
        }

        // Sleep for the remainder of the tick window
        let elapsed_tick = tick_start.elapsed();
        let tick_dur     = Duration::from_millis(TICK_MS);
        if elapsed_tick < tick_dur {
            sleep(tick_dur - elapsed_tick).await;
        }
    }
}

// ─── Nightly Automation Loop ──────────────────────────────────────────────────
//
// Fires once per minute.  At 23:58–23:59 local time it exports today's data
// per device to:  [export_dir]/[device_name]/[YYYY]/[MM]/[YYYY-MM-DD].xlsx
// A catch-up trigger fires when the app starts after midnight and yesterday
// was never exported (e.g. if the machine was rebooted).
// After each nightly run it performs a WAL checkpoint, copies the database
// file, and writes a SHA-256 companion (.sha256) for MID-compliance audits.

async fn run_nightly_loop(db: Arc<Mutex<Connection>>, db_path: Arc<PathBuf>) {
    let mut last_export_date = String::new();

    loop {
        sleep(Duration::from_secs(60)).await;

        // ── Load export directory from persistent config ───────────────────
        let export_path: String = {
            let conn = db.lock().unwrap();
            conn.query_row(
                "SELECT value FROM app_config WHERE key = 'export_path'", [],
                |r| r.get(0),
            ).unwrap_or_default()
        };
        if export_path.is_empty() { continue; }

        // ── Read user/project for Excel header ────────────────────────────
        let (username, project_name): (String, String) = {
            let conn = db.lock().unwrap();
            conn.query_row(
                "SELECT username, project_name FROM settings LIMIT 1", [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ).unwrap_or_else(|_| (String::new(), String::new()))
        };

        // ── Determine trigger ─────────────────────────────────────────────
        let now_local  = chrono::Local::now();
        let today_str  = now_local.format("%Y-%m-%d").to_string();
        let hour       = now_local.hour();
        let minute     = now_local.minute();
        let yesterday: String = chrono::NaiveDate::parse_from_str(&today_str, "%Y-%m-%d")
            .map(|d| (d - chrono::Duration::days(1)).format("%Y-%m-%d").to_string())
            .unwrap_or_default();

        let (should_export, export_date) =
            if hour == 23 && minute >= 58 && last_export_date != today_str {
                (true, today_str.clone())
            } else if hour >= 1 && last_export_date < yesterday && !yesterday.is_empty() {
                (true, yesterday.clone())
            } else {
                (false, String::new())
            };

        if !should_export { continue; }

        eprintln!("[nightly] Starting export for {export_date}");

        // ── Gather device names present in history ────────────────────────
        let device_names: Vec<String> = {
            let conn = db.lock().unwrap();
            let mut stmt = match conn.prepare(
                "SELECT DISTINCT device_name FROM meter_history"
            ) {
                Ok(s) => s, Err(e) => { eprintln!("[nightly] prepare: {e}"); continue; }
            };
            stmt.query_map([], |r| r.get(0))
                .unwrap_or_else(|_| unreachable!())
                .filter_map(|r| r.ok())
                .collect()
        };

        // ── Per-device export ─────────────────────────────────────────────
        let year_s  = &export_date[..4];
        let month_s = &export_date[5..7];
        let ts_from = format!("{export_date}T00:00:00");
        let ts_to   = format!("{export_date}T23:59:59");

        for device_name in &device_names {
            let dir = PathBuf::from(&export_path)
                .join(device_name).join(year_s).join(month_s);
            if let Err(e) = std::fs::create_dir_all(&dir) {
                eprintln!("[nightly] mkdir {}: {e}", dir.display()); continue;
            }
            let file = dir.join(format!("{export_date}.xlsx"));
            let conn = db.lock().unwrap();
            match do_export(
                &conn, file.to_str().unwrap_or(""),
                Some(device_name.as_str()),
                Some(ts_from.as_str()), Some(ts_to.as_str()),
                &username, &project_name,
            ) {
                Ok(n)  => eprintln!("[nightly] {device_name}: {n} rows → {}", file.display()),
                Err(e) => eprintln!("[nightly] {device_name} export error: {e}"),
            }
        }

        // ── WAL checkpoint ────────────────────────────────────────────────
        {
            let conn = db.lock().unwrap();
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        }

        // ── MID-compliant DB backup + SHA-256 companion ───────────────────
        let backup_dir = PathBuf::from(&export_path).join("_backups");
        if std::fs::create_dir_all(&backup_dir).is_ok() {
            if let Ok(data) = std::fs::read(&*db_path) {
                let bak = backup_dir.join(format!("technidaq_{export_date}.db"));
                if std::fs::write(&bak, &data).is_ok() {
                    use sha2::{Digest, Sha256};
                    let hash_str = format!("{:x}", Sha256::digest(&data));
                    let sha_file = backup_dir.join(format!("technidaq_{export_date}.db.sha256"));
                    let _ = std::fs::write(&sha_file, hash_str);
                    eprintln!("[nightly] DB backup: {}", bak.display());
                }
            }
        }

        last_export_date = export_date;
    }
}

// ─── Store & Forward Sync Loop ────────────────────────────────────────────────
//
// Ticks every 5 seconds.  On each tick:
//   1. Read (mode, machine_api_key) from settings — skip if not online/registered.
//   2. SELECT up to 500 unsynced rows from meter_history.
//   3. POST the batch to [CLOUD_API_URL]/api/machine/ingest.
//   4. On HTTP 200: mark rows synced = 1.
//   5. Prune rows that are already synced AND older than 48 hours.
//
// This function is compiled ONLY in cloud builds (--features cloud_sync).

#[cfg(feature = "cloud_sync")]
async fn run_cloud_sync_loop(db: Arc<Mutex<Connection>>, client: HttpClient) {
    loop {
        sleep(Duration::from_secs(5)).await;

        // ── Read license state (cheap, brief lock) ─────────────────────────
        let (mode, api_key) = {
            let conn = db.lock().unwrap();
            match conn.query_row(
                "SELECT mode, machine_api_key FROM settings LIMIT 1",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            ) {
                Ok(v)  => v,
                Err(_) => continue, // no license active yet
            }
        };

        if mode != "online" || api_key.is_empty() { continue; }

        // ── 48-hour pruning of already-synced rows ─────────────────────────
        // Uses our ISO timestamp format for correct string comparison.
        {
            let cutoff = secs_to_iso(now_secs().saturating_sub(172_800));
            let conn = db.lock().unwrap();
            let _ = conn.execute(
                "DELETE FROM meter_history WHERE synced = 1 AND timestamp < ?1",
                params![cutoff],
            );
        }

        // ── Fetch unsynced batch ───────────────────────────────────────────
        let rows: Vec<(i64, String, String, String, String)> = {
            let conn = db.lock().unwrap();
            let mut stmt = match conn.prepare(
                "SELECT id, timestamp, device_name, device_id, data \
                 FROM meter_history WHERE synced = 0 ORDER BY id ASC LIMIT 500"
            ) {
                Ok(s)  => s,
                Err(e) => { eprintln!("[sync] prepare error: {e}"); continue; }
            };
            stmt.query_map([], |r| Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            )))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
        };

        if rows.is_empty() { continue; }

        let ids: Vec<i64>              = rows.iter().map(|(id, ..)| *id).collect();
        let readings: Vec<serde_json::Value> = rows.iter().map(|(_id, ts, dn, _di, data)| {
            // Parse the stored JSON string back into a Value so the API receives
            // "data": {...} (object), not "data": "{...}" (string).
            let data_obj: serde_json::Value = serde_json::from_str(data)
                .unwrap_or(serde_json::Value::Object(Default::default()));
            serde_json::json!({
                "timestamp":   ts,
                "device_name": dn,
                "data":        data_obj,
            })
        }).collect();

        // ── POST batch to cloud ────────────────────────────────────────────
        let result = client
            .post(format!("{CLOUD_API_URL}/api/machine/ingest"))
            .header("x-api-key", &api_key)
            .json(&serde_json::json!({ "telemetry_array": readings }))
            .send()
            .await;

        match result {
            Ok(resp) if resp.status().is_success() => {
                // Mark all rows in the batch as synced using safe integer list
                let id_list = ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");
                let sql     = format!("UPDATE meter_history SET synced = 1 WHERE id IN ({id_list})");
                let conn    = db.lock().unwrap();
                let _       = conn.execute(&sql, []);
                eprintln!("[sync] ✔ {} row(s) synced to cloud", ids.len());
            }
            Ok(resp) => {
                eprintln!("[sync] ✗ HTTP {} — will retry next tick", resp.status());
            }
            Err(e) => {
                eprintln!("[sync] ✗ network error: {e} — will retry");
            }
        }
    }
}

// ─── Database Init ────────────────────────────────────────────────────────────

fn init_database(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous  = NORMAL;

        -- meter_history persists across restarts to support Store & Forward.
        -- On first run this creates the table; on subsequent runs it is a no-op.
        CREATE TABLE IF NOT EXISTS meter_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp   TEXT    NOT NULL,
            device_name TEXT    NOT NULL DEFAULT '',
            device_id   TEXT    NOT NULL DEFAULT '',
            data        TEXT    NOT NULL DEFAULT '{}',
            synced      INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_mh_ts     ON meter_history (timestamp);
        CREATE INDEX IF NOT EXISTS idx_mh_name   ON meter_history (device_name);
        CREATE INDEX IF NOT EXISTS idx_mh_synced ON meter_history (synced);

        -- settings is always recreated: license state begins fresh each session.
        DROP TABLE IF EXISTS settings;
        CREATE TABLE settings (
            id               INTEGER PRIMARY KEY,
            username         TEXT    NOT NULL,
            project_name     TEXT    NOT NULL,
            expiry_date      INTEGER NOT NULL,
            allowed_meters   TEXT    NOT NULL,
            mode             TEXT    NOT NULL DEFAULT 'offline',
            tier             INTEGER NOT NULL DEFAULT 1,
            protocols        TEXT    NOT NULL DEFAULT 'All',
            machine_api_key  TEXT    NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS app_config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT ''
        );
    ")?;

    // Migration: add `synced` column to any pre-existing meter_history table
    // that was created before this column existed.  SQLite returns an error if
    // the column already exists; we intentionally ignore it.
    let _ = conn.execute(
        "ALTER TABLE meter_history ADD COLUMN synced INTEGER NOT NULL DEFAULT 0",
        [],
    );

    Ok(())
}

// ─── Axum Shared State ────────────────────────────────────────────────────────

/// Clones of every shared-state Arc passed into the Axum router so REST
/// handlers can read/write the same live data as the Tauri commands.
#[derive(Clone)]
struct AxumAppState {
    db:         Arc<Mutex<Connection>>,
    profiles:   Arc<Mutex<HashMap<String, MeterProfileEntry>>>,
    engine:     Arc<Mutex<EngineState>>,
    app:        tauri::AppHandle,
    diag:       Arc<AtomicBool>,
    ws_clients: WsClientList,
}

// ─── REST API Dispatch ────────────────────────────────────────────────────────

// Standalone helpers avoid closure type-inference failures in the async context.
fn api_e500(m: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, m.to_string())
}
fn api_e400(m: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::BAD_REQUEST, m.to_string())
}
/// Read a JSON field accepting both camelCase and snake_case key names.
fn jstr<'a>(body: &'a serde_json::Value, camel: &str, snake: &str) -> &'a str {
    body.get(camel).or_else(|| body.get(snake))
        .and_then(|v| v.as_str()).unwrap_or("")
}

/// Single POST handler for every Tauri command.  The URL segment `:cmd` maps
/// to the command name exactly as the frontend calls it (e.g. "get_auth_state").
/// JSON body carries the arguments (camelCase keys accepted alongside snake_case).
async fn api_dispatch(
    AxumState(s): AxumState<AxumAppState>,
    Path(cmd):    Path<String>,
    Json(body):   Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let ok = |v: serde_json::Value| Ok(Json(v));

    match cmd.as_str() {

        // ── Build info ────────────────────────────────────────────────────────
        "get_build_info" => {
            ok(serde_json::json!({ "is_cloud_build": cfg!(feature = "cloud_sync") }))
        }

        // ── Auth ──────────────────────────────────────────────────────────────
        "get_auth_state" => {
            let conn = s.db.lock().map_err(api_e500)?;
            let now  = now_secs() as i64;
            let auth = match conn.query_row(
                "SELECT username, project_name, expiry_date, allowed_meters, mode, tier, protocols, machine_api_key FROM settings LIMIT 1",
                [], |r: &rusqlite::Row<'_>| Ok((
                    r.get::<_,String>(0)?, r.get::<_,String>(1)?,
                    r.get::<_,i64>(2)?,   r.get::<_,String>(3)?,
                    r.get::<_,String>(4).unwrap_or_else(|_| "offline".into()),
                    r.get::<_,i64>(5).unwrap_or(1),
                    r.get::<_,String>(6).unwrap_or_else(|_| "All".into()),
                    r.get::<_,String>(7).unwrap_or_default(),
                )),
            ) {
                Ok((u, p, exp, m, mode, tier, protocols, api_key)) if now < exp => AuthState {
                    valid: true, username: Some(u), project_name: Some(p),
                    expiry_date: Some(exp),
                    allowed_meters:   serde_json::from_str(&m).unwrap_or_default(),
                    mode:             Some(mode),
                    tier:             Some(tier as u8),
                    protocols:        Some(protocols),
                    cloud_registered: !api_key.is_empty(),
                },
                _ => AuthState { valid: false, username: None, project_name: None,
                                 expiry_date: None, allowed_meters: vec![],
                                 mode: None, tier: None, protocols: None,
                                 cloud_registered: false },
            };
            ok(serde_json::to_value(auth).unwrap())
        }

        "activate_license" => {
            let key          = jstr(&body, "key",         "key"         ).to_owned();
            let username     = jstr(&body, "username",    "username"    ).to_owned();
            let project_name = jstr(&body, "projectName", "project_name").to_owned();
            let payload = decrypt_license_token(&key).map_err(api_e400)?;
            let now      = now_secs();
            let deadline = payload.created_at.saturating_add(payload.ttl_hours * 3_600);
            if now > deadline {
                let age = now.saturating_sub(payload.created_at) / 60;
                return Err(api_e400(format!(
                    "Token expired ({age} min old). Keys must be activated within {} hour(s) of generation.",
                    payload.ttl_hours)));
            }
            if payload.created_at > now + 300 {
                return Err(api_e400("Token has a future timestamp. Check system clock."));
            }
            if payload.username.trim() != username.trim()
               || payload.project_name.trim() != project_name.trim() {
                return Err(api_e400("Invalid User or Project credentials for this license."));
            }
            if payload.allowed_meters.is_empty() {
                return Err(api_e400("License contains no allowed meter models."));
            }
            let expiry = (payload.created_at + payload.duration_days * 86_400) as i64;
            let m_json = serde_json::to_string(&payload.allowed_meters).map_err(api_e500)?;
            {
                let conn = s.db.lock().map_err(api_e500)?;
                conn.execute("DELETE FROM settings", []).map_err(api_e500)?;
                conn.execute(
                    "INSERT INTO settings (username, project_name, expiry_date, allowed_meters, mode, tier, protocols, machine_api_key) VALUES (?1,?2,?3,?4,?5,?6,?7,'')",
                    params![username.trim(), project_name.trim(), expiry, m_json,
                            payload.mode, payload.tier as i64, payload.protocols],
                ).map_err(api_e500)?;
            } // ← DB lock released before any async work

            // ── Cloud Handshake (online mode only, cloud build only) ──────────
            #[cfg(feature = "cloud_sync")]
            if payload.mode == "online" {
                let machine_id = {
                    let conn = s.db.lock().map_err(api_e500)?;
                    get_or_create_machine_id(&conn)
                };
                let http = HttpClient::builder()
                    .timeout(Duration::from_secs(15))
                    .https_only(true)
                    .build()
                    .map_err(api_e500)?;
                let resp = http
                    .post(format!("{CLOUD_API_URL}/api/machine/activate"))
                    .json(&serde_json::json!({
                        "license_key":  key,
                        "username":     username.trim(),
                        "project_name": project_name.trim(),
                        "machine_id":   machine_id,
                        "tier":         payload.tier,
                        "protocols":    payload.protocols,
                    }))
                    .send()
                    .await
                    .map_err(api_e500)?;
                if resp.status().is_success() {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        if let Some(api_key) = json["machine_api_key"].as_str() {
                            let conn = s.db.lock().map_err(api_e500)?;
                            let _ = conn.execute(
                                "UPDATE settings SET machine_api_key = ?1",
                                params![api_key],
                            );
                            eprintln!("[license/rest] ✔ Cloud handshake complete");
                        }
                    }
                } else {
                    eprintln!("[license/rest] ✗ Cloud handshake HTTP {}", resp.status());
                }
            }

            ok(serde_json::to_value(format!(
                "License activated for {} / {}. Valid {} days. Mode={} Tier={} Protocols={}.",
                username.trim(), project_name.trim(), payload.duration_days,
                payload.mode, payload.tier, payload.protocols
            )).unwrap())
        }

        "logout_user" => {
            // ── Cloud key invalidation (fire-and-forget) ──────────────────────
            #[cfg(feature = "cloud_sync")]
            {
                let result: Option<(String, String)> = s.db.lock().map_err(api_e500)?
                    .query_row(
                        "SELECT mode, machine_api_key FROM settings LIMIT 1",
                        [], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                    ).ok();
                if let Some((mode, api_key)) = result {
                    if mode == "online" && !api_key.is_empty() {
                        tokio::spawn(async move {
                            let client = HttpClient::builder()
                                .timeout(Duration::from_secs(5))
                                .https_only(true)
                                .build()
                                .unwrap_or_else(|_| HttpClient::new());
                            let _ = client
                                .post(format!("{CLOUD_API_URL}/api/machine/logout"))
                                .bearer_auth(&api_key)
                                .send()
                                .await;
                            eprintln!("[logout/rest] ✔ Cloud key invalidation sent");
                        });
                    }
                }
            }

            s.db.lock().map_err(api_e500)?
                .execute("DELETE FROM settings", []).map_err(api_e500)?;
            ok(serde_json::Value::Null)
        }

        // ── Profiles ──────────────────────────────────────────────────────────
        "get_meter_profiles" => {
            let allowed: Vec<String> = body.get("allowedMeters")
                .or_else(|| body.get("allowed_meters"))
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let lib = s.profiles.lock().map_err(api_e500)?;
            let norm_allowed: Vec<String> = allowed.iter().map(|m| normalize_meter_name(m)).collect();
            let allow_all = norm_allowed.contains(&"all".to_string());
            let mut result: Vec<MeterProfileEntry> = if allow_all {
                let mut v: Vec<MeterProfileEntry> = lib.values().cloned().collect();
                v.sort_by(|a, b| a.display_name.cmp(&b.display_name));
                v
            } else {
                norm_allowed.iter()
                    .filter(|m| m.as_str() != "custom" && m.as_str() != "simulation")
                    .filter_map(|norm| {
                        lib.values().find(|p| normalize_meter_name(&p.model) == *norm).cloned()
                    })
                    .collect()
            };
            let allow_custom = allow_all || norm_allowed.contains(&"custom".to_string());
            if allow_custom && !result.iter().any(|p| p.model == "Custom") {
                result.push(custom_profile());
            }
            let allow_sim = allow_all || norm_allowed.contains(&"simulation".to_string());
            if allow_sim && !result.iter().any(|p| p.model == "Simulation") {
                let sim = lib.values()
                    .find(|p| normalize_meter_name(&p.model) == "schneider_pm2220")
                    .map(|pm| MeterProfileEntry {
                        model:        "Simulation".into(),
                        display_name: "Simulation".into(),
                        endianness:   pm.endianness.clone(),
                        baud_rate:    pm.baud_rate,
                        parity:       pm.parity.clone(),
                        registers:    pm.registers.clone(),
                    })
                    .unwrap_or_else(simulation_profile);
                result.push(sim);
            }
            ok(serde_json::to_value(result).unwrap())
        }

        // ── Bus config ────────────────────────────────────────────────────────
        "apply_bus_config" => {
            let devices: Vec<DeviceConfig> = serde_json::from_value(
                body.get("devices").cloned().unwrap_or(serde_json::Value::Array(vec![])),
            ).map_err(|e| api_e400(e.to_string()))?;
            if devices.is_empty() {
                return Err(api_e400("At least one device must be configured."));
            }
            {
                let lib = s.profiles.lock().map_err(api_e500)?;
                for dev in &devices {
                    if dev.device_name.trim().is_empty() {
                        return Err(api_e400("A device is missing its name."));
                    }
                    if dev.slave_id == 0 || dev.slave_id > 247 {
                        return Err(api_e400(format!(
                            "\"{}\" — Slave ID must be 1–247, got {}", dev.device_name, dev.slave_id)));
                    }
                    if dev.poll_rate_ms < 200 {
                        return Err(api_e400(format!(
                            "\"{}\" — Poll rate must be ≥ 200 ms, got {}", dev.device_name, dev.poll_rate_ms)));
                    }
                    if dev.selected_registers.is_empty() {
                        return Err(api_e400(format!(
                            "\"{}\" — At least one register must be selected.", dev.device_name)));
                    }
                    {
                        let norm = normalize_meter_name(&dev.meter_model);
                        let is_virtual = norm == "custom" || norm == "custom_device" || norm == "simulation";
                        let in_lib = lib.values().any(|p| normalize_meter_name(&p.model) == norm);
                        if !is_virtual && !in_lib {
                            return Err(api_e400(format!(
                                "\"{}\" — Unknown model \"{}\".", dev.device_name, dev.meter_model)));
                        }
                    }
                }
            }
            s.engine.lock().map_err(api_e500)?.configured_devices = devices.clone();
            let broadcast = build_state_msg(&s.engine);
            ws_broadcast(&s.ws_clients, broadcast);
            ok(serde_json::to_value(devices).unwrap())
        }

        // ── Polling ───────────────────────────────────────────────────────────
        "toggle_polling" => {
            let new_state = {
                let mut eng = s.engine.lock().map_err(api_e500)?;
                eng.poll = match eng.poll {
                    PollState::Running => PollState::Stopped,
                    _                  => PollState::Running,
                };
                eng.poll.clone()
            };
            // Emit to the desktop Tauri window and broadcast to web clients.
            s.app.emit("status-changed", StatusEvent { state: new_state.clone() }).ok();
            ws_broadcast(&s.ws_clients, build_state_msg(&s.engine));
            ok(serde_json::to_value(new_state).unwrap())
        }

        "get_status" => {
            let poll = s.engine.lock().map_err(api_e500)?.poll.clone();
            ok(serde_json::to_value(poll).unwrap())
        }

        // ── History ───────────────────────────────────────────────────────────
        "clear_history" => {
            let n = s.db.lock().map_err(api_e500)?
                .execute("DELETE FROM meter_history", []).map_err(api_e500)?;
            ok(serde_json::to_value(n).unwrap())
        }

        "get_record_count" => {
            let n: i64 = s.db.lock().map_err(api_e500)?
                .query_row("SELECT COUNT(*) FROM meter_history", [],
                           |r: &rusqlite::Row<'_>| r.get(0))
                .map_err(api_e500)?;
            ok(serde_json::to_value(n).unwrap())
        }

        // File-save dialog is not available in a browser.
        "export_to_excel" => Err((
            StatusCode::NOT_IMPLEMENTED,
            "Excel export requires the desktop app.".to_string(),
        )),

        // ── Config ────────────────────────────────────────────────────────────
        "get_notification_email" => {
            let v: String = s.db.lock().map_err(api_e500)?
                .query_row("SELECT value FROM app_config WHERE key = 'dest_email'",
                           [], |r: &rusqlite::Row<'_>| r.get(0))
                .unwrap_or_default();
            ok(serde_json::to_value(v).unwrap())
        }

        "save_notification_email" => {
            let email = jstr(&body, "email", "email").to_owned();
            s.db.lock().map_err(api_e500)?
                .execute("INSERT OR REPLACE INTO app_config (key, value) VALUES ('dest_email', ?1)",
                         params![email.trim()])
                .map_err(api_e500)?;
            ok(serde_json::Value::Null)
        }

        "get_export_path" => {
            let v: String = s.db.lock().map_err(api_e500)?
                .query_row("SELECT value FROM app_config WHERE key = 'export_path'",
                           [], |r: &rusqlite::Row<'_>| r.get(0))
                .unwrap_or_default();
            ok(serde_json::to_value(v).unwrap())
        }

        "save_export_path" => {
            let path = jstr(&body, "path", "path").to_owned();
            s.db.lock().map_err(api_e500)?
                .execute("INSERT OR REPLACE INTO app_config (key, value) VALUES ('export_path', ?1)",
                         params![path.trim()])
                .map_err(api_e500)?;
            ok(serde_json::Value::Null)
        }

        "set_diagnostics_enabled" => {
            let enabled = body["enabled"].as_bool().unwrap_or(false);
            s.diag.store(enabled, Ordering::Relaxed);
            ok(serde_json::Value::Null)
        }

        // ── Mirror status (used by web clients on initial load) ───────────────
        "status" => {
            let eng = s.engine.lock().map_err(api_e500)?;
            ok(serde_json::json!({
                "configured_devices": eng.configured_devices,
                "poll_state":         eng.poll,
            }))
        }

        other => Err((StatusCode::NOT_FOUND, format!("Unknown command: {other}"))),
    }
}

// ─── WebSocket Handler ────────────────────────────────────────────────────────

/// Upgrade HTTP → WebSocket, then hand off to `handle_ws_client`.
async fn ws_handler(
    ws:           WebSocketUpgrade,
    AxumState(s): AxumState<AxumAppState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_ws_client(socket, s))
}

/// Maintain one connected web client.
/// • Immediately pushes the current engine snapshot as the first frame.
/// • Forwards every broadcast message from the mpsc channel to the socket.
/// • Exits (and drops the sender) when the client disconnects.
async fn handle_ws_client(mut socket: WebSocket, s: AxumAppState) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Register client; send initial snapshot.
    if let Ok(mut list) = s.ws_clients.lock() {
        list.push(tx);
    }
    let initial = build_state_msg(&s.engine);
    let _ = socket.send(WsMessage::Text(initial)).await;

    // Forward broadcasts → socket until either side closes.
    loop {
        tokio::select! {
            Some(text) = rx.recv() => {
                if socket.send(WsMessage::Text(text)).await.is_err() { break; }
            }
            msg = socket.recv() => {
                // None = clean close; Some(Err(_)) = error — either way, exit.
                if msg.map_or(true, |r| r.is_err()) { break; }
            }
        }
    }
    // Sender dropped here; ws_broadcast will prune it on the next send.
}

// ─── Intranet Web Server ──────────────────────────────────────────────────────

/// All files from `dist/` are compiled directly into the binary so the server
/// works in production regardless of where the executable is installed.
#[derive(RustEmbed)]
#[folder = "../dist"]
struct WebAssets;

async fn web_handler(uri: Uri) -> Response {
    let raw = uri.path().trim_start_matches('/');
    let path = if raw.is_empty() { "index.html" } else { raw };

    // Try the exact path first; fall back to index.html for SPA routing.
    let (data, mime) = match WebAssets::get(path) {
        Some(f) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (f.data.into_owned(), mime.to_string())
        }
        None => match WebAssets::get("index.html") {
            Some(f) => (f.data.into_owned(), "text/html".to_string()),
            None => {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::from("404 – build the frontend first (npm run build)"))
                    .unwrap();
            }
        },
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .body(Body::from(data))
        .unwrap()
}

// ─── main ─────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // ── Database ─────────────────────────────────────────────────────
            let dir = app.path().app_local_data_dir().expect("app data dir");
            std::fs::create_dir_all(&dir).expect("create dir");
            let db_path     = dir.join("technidaq_local.db");
            let db_path_arc = Arc::new(db_path.clone());
            eprintln!("[db] {}", db_path.display());
            let conn = Connection::open(&db_path).expect("open db");
            init_database(&conn).expect("init schema");
            let db = Arc::new(Mutex::new(conn));

            // ── Profile library ───────────────────────────────────────────────
            let profiles_map = Arc::new(Mutex::new(load_profiles_from_disk()));

            // ── Engine ───────────────────────────────────────────────────────
            let engine = Arc::new(Mutex::new(EngineState {
                poll:               PollState::Stopped,
                configured_devices: vec![],
            }));

            app.manage(DbConnection(Arc::clone(&db)));
            app.manage(ProfilesState(Arc::clone(&profiles_map)));
            app.manage(SharedEngine(Arc::clone(&engine)));
            let diag_flag  = Arc::new(AtomicBool::new(false));
            app.manage(DiagEnabled(Arc::clone(&diag_flag)));
            let ws_clients: WsClientList = Arc::new(Mutex::new(vec![]));
            app.manage(WsClients(Arc::clone(&ws_clients)));

            // ── System Tray ──────────────────────────────────────────────────
            let show_i = MenuItem::with_id(app, "show", "Open Dashboard", true, None::<&str>)?;
            let sep    = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit TechniDAQ",  true, None::<&str>)?;
            let menu   = Menu::with_items(app, &[&show_i, &sep, &quit_i])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("TechniDAQ")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "show" => { if let Some(w) = app.get_webview_window("main") { let _=w.show(); let _=w.set_focus(); } }
                    "quit" => std::process::exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = ev {
                        if let Some(w) = tray.app_handle().get_webview_window("main") { let _=w.show(); let _=w.set_focus(); }
                    }
                })
                .build(app)?;

            // ── Polling task ─────────────────────────────────────────────────
            tauri::async_runtime::spawn(run_polling_loop(
                Arc::clone(&engine),
                Arc::clone(&db),
                Arc::clone(&profiles_map),
                app.handle().clone(),
                Arc::clone(&diag_flag),
                Arc::clone(&ws_clients),
            ));

            // ── Nightly automation task ───────────────────────────────────────
            tauri::async_runtime::spawn(run_nightly_loop(
                Arc::clone(&db),
                Arc::clone(&db_path_arc),
            ));

            // ── Store & Forward sync loop (cloud builds only) ─────────────────
            #[cfg(feature = "cloud_sync")]
            tauri::async_runtime::spawn(run_cloud_sync_loop(
                Arc::clone(&db),
                HttpClient::builder()
                    .timeout(Duration::from_secs(10))
                    .https_only(true)
                    .build()
                    .expect("reqwest client build failed"),
            ));

            // ── Intranet Web Server (Axum) ────────────────────────────────────
            // Serves the compiled React SPA on port 3030 for phone/tablet access.
            // REST endpoints under /api/:cmd mirror every Tauri command.
            let axum_state = AxumAppState {
                db:         Arc::clone(&db),
                profiles:   Arc::clone(&profiles_map),
                engine:     Arc::clone(&engine),
                app:        app.handle().clone(),
                diag:       Arc::clone(&diag_flag),
                ws_clients: Arc::clone(&ws_clients),
            };
            tauri::async_runtime::spawn(async move {
                let web_app = Router::new()
                    .route("/api/:cmd", post(api_dispatch))
                    .route("/ws",       get(ws_handler))
                    .fallback(web_handler)
                    .with_state(axum_state);
                let listener = tokio::net::TcpListener::bind("0.0.0.0:3030")
                    .await
                    .expect("axum bind :3030");
                eprintln!("[web] Listening on http://0.0.0.0:3030");
                axum::serve(listener, web_app).await.expect("axum serve");
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_build_info,
            toggle_polling, get_status, clear_history, get_record_count, export_to_excel,
            activate_license, get_auth_state, logout_user,
            get_meter_profiles, reload_profiles, apply_bus_config,
            save_notification_email, get_notification_email,
            set_diagnostics_enabled,
            save_export_path, get_export_path,
        ])
        .build(tauri::generate_context!())
        .expect("tauri build failed")
        .run(|app, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } = event {
                if label == "main" {
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
                }
            }
        });
}