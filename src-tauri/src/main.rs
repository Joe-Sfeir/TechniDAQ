// src-tauri/src/main.rs  — TechniDAQ Phase 4 (Multi-Meter SCADA Engine)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::{params, Connection};
use rust_xlsxwriter::{Color, DocProperties, Format, FormatAlign, FormatBorder, Image, Workbook};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, RunEvent, State, WindowEvent,
};
use tokio::time::sleep;
use tokio_modbus::prelude::*;
use tokio_serial::SerialStream;

// ─── Constants ────────────────────────────────────────────────────────────────

const MASTER_KEY_HEX:       &str = "6f3d9a2e1b8c4f7a0e5d2b9c6a3f1e8d4b7c0a9e2f5d8b1c4a7e0f3d6b9c2a5f";
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
    /// Human-readable label, e.g. "Main Incomer".  Used as the grouping key in the UI.
    pub device_name:        String,
    /// Must match a key in profiles.json, or be "Custom".
    pub meter_model:        String,
    pub slave_id:           u8,
    /// How often to poll this device, in milliseconds.  Min 200 ms.
    pub poll_rate_ms:       u64,
    /// The register subset the user selected (predefined + any custom entries).
    pub selected_registers: Vec<RegisterEntry>,
}

// ─── Engine State ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PollState { Stopped, Running, Fault }

pub struct EngineState {
    pub poll:               PollState,
    pub com_port:           String,
    pub configured_devices: Vec<DeviceConfig>,
}

pub struct SharedEngine(pub Arc<Mutex<EngineState>>);
pub struct DbConnection(pub Arc<Mutex<Connection>>);
/// Shared mutable copy of the profile library loaded from profiles.json.
pub struct ProfilesState(pub Arc<Mutex<HashMap<String, MeterProfileEntry>>>);

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

// ─── License Types ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct AuthState {
    pub valid:          bool,
    pub username:       Option<String>,
    pub project_name:   Option<String>,
    pub expiry_date:    Option<i64>,
    pub allowed_meters: Vec<String>,
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
}

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
        .map_err(|_| "Invalid or tampered license key".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|e| format!("Payload corrupt: {e}"))
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

/// Generate a plausible oscillating mock value for a named register.
/// Uses wall-clock time + register index so values drift independently.
fn sim_register_value(name: &str, idx: usize) -> f64 {
    let t = now_ms() as f64 / 1000.0;
    let n = name.to_lowercase();
    let (base, amp, freq) = if n.contains("voltage") {
        (228.0_f64, 5.0, 0.10)
    } else if n.contains("current") {
        (28.0,  8.0,   0.17)
    } else if n.contains("power") && !n.contains("factor") {
        (6_000.0, 1_500.0, 0.07)
    } else if n.contains("frequen") {
        (49.97, 0.05, 0.013)
    } else if n.contains("factor") {
        (0.94,  0.04, 0.09)
    } else {
        (50.0,  25.0, 0.11)
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
    com_port:   String,
    engine:     State<SharedEngine>,
    app_handle: tauri::AppHandle,
) -> Result<PollState, String> {
    let new_state = {
        let mut e = engine.0.lock().map_err(|e| e.to_string())?;
        e.com_port = com_port.trim().to_string();
        e.poll = match e.poll { PollState::Running => PollState::Stopped, _ => PollState::Running };
        e.poll.clone()
    };
    app_handle.emit("status-changed", StatusEvent { state: new_state.clone() })
        .map_err(|e| e.to_string())?;
    Ok(new_state)
}

#[tauri::command]
fn get_status(engine: State<SharedEngine>) -> Result<PollState, String> {
    Ok(engine.0.lock().map_err(|e| e.to_string())?.poll.clone())
}

#[tauri::command]
fn logout_user(db: State<DbConnection>) -> Result<(), String> {
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

// ─── Tauri Commands ── Excel Export ───────────────────────────────────────────
//
// Produces a multi-sheet workbook: one worksheet per distinct device_name.
// Each sheet has the branded report header (rows 0-4), column headers (row 5),
// and data rows (row 6+) keyed only to that device's register variables.
//
// `target_device`:      Some("Main Incomer") → single-sheet export for that device
// `time_range_seconds`: Some(3600)           → WHERE timestamp >= now-1h

fn sanitize_sheet_name(name: &str) -> String {
    name.chars()
        .map(|c| if "[]*/\\?:".contains(c) { '_' } else { c })
        .take(31)
        .collect()
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
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // ── Compute optional time cutoff ──────────────────────────────────────────
    let time_cutoff: Option<String> = time_range_seconds
        .map(|secs| secs_to_iso(now_secs().saturating_sub(secs)));

    // ── Discover distinct device names in scope ───────────────────────────────
    let mut dist_wheres: Vec<String> = Vec::new();
    let mut dist_params: Vec<String> = Vec::new();
    if let Some(ref name) = target_device {
        dist_wheres.push("device_name = ?".to_string());
        dist_params.push(name.clone());
    }
    if let Some(ref cutoff) = time_cutoff {
        dist_wheres.push("timestamp >= ?".to_string());
        dist_params.push(cutoff.clone());
    }
    let dist_where = if dist_wheres.is_empty() { String::new() }
                     else { format!("WHERE {}", dist_wheres.join(" AND ")) };
    let dist_sql = format!(
        "SELECT DISTINCT device_name FROM meter_history {dist_where} ORDER BY device_name ASC"
    );
    let device_names: Vec<String> = {
        let mut stmt = conn.prepare(&dist_sql).map_err(|e| e.to_string())?;
        stmt.query_map(rusqlite::params_from_iter(dist_params.iter()), |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect()
    };

    if device_names.is_empty() {
        let mut wb = Workbook::new();
        wb.add_worksheet();
        wb.save(&path).map_err(|e| e.to_string())?;
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
        PathBuf::from("icons/128x128.png"),
    ].iter().find(|p| p.exists()).and_then(|p| Image::new(p).ok());

    // ── Workbook ──────────────────────────────────────────────────────────────
    let mut wb = Workbook::new();
    wb.set_properties(
        &DocProperties::new()
            .set_author("Technicat Group")
            .set_company("Technicat Group")
            .set_title(&format!("{} — TechniDAQ Data Report",
                target_device.as_deref().unwrap_or("All Meters")))
    );

    let export_dt   = wall_clock_iso().replace('T', " ");
    // Static columns present on every sheet (device name is implicit — it's the sheet)
    let static_cols: &[&str] = &["ID", "Timestamp", "Device ID"];
    let mut total_rows: usize = 0;

    // ── Per-device sheet loop ─────────────────────────────────────────────────
    for device_name in &device_names {
        // Build per-device query
        let mut dev_params: Vec<String> = vec![device_name.clone()];
        let time_clause = match &time_cutoff {
            Some(cutoff) => { dev_params.push(cutoff.clone()); " AND timestamp >= ?" }
            None         => "",
        };
        let dev_sql = format!(
            "SELECT id, timestamp, device_id, data \
             FROM meter_history WHERE device_name = ?{time_clause} ORDER BY id ASC"
        );

        #[derive(Debug)]
        struct DevRow { id: i64, timestamp: String, device_id: String, data: String }

        let dev_rows: Vec<DevRow> = {
            let mut stmt = conn.prepare(&dev_sql).map_err(|e| e.to_string())?;
            stmt.query_map(
                rusqlite::params_from_iter(dev_params.iter()),
                |r| Ok(DevRow {
                    id: r.get(0)?, timestamp: r.get(1)?,
                    device_id: r.get(2)?, data: r.get(3)?,
                }),
            ).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect()
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
        ws.protect();
        total_rows += n;
    }

    wb.save(&path).map_err(|e| e.to_string())?;
    Ok(total_rows)
}

// ─── Tauri Commands ── License ────────────────────────────────────────────────

#[tauri::command]
fn activate_license(
    key:          String,
    username:     String,
    project_name: String,
    db:           State<DbConnection>,
) -> Result<String, String> {
    let payload = decrypt_license_token(&key)?;
    let now = now_secs();
    let activation_deadline = payload.created_at.saturating_add(payload.ttl_hours * 3_600);
    if now > activation_deadline {
        let age_mins = now.saturating_sub(payload.created_at) / 60;
        return Err(format!(
            "Token expired ({} min old). Keys must be activated within {} hour(s) of generation.",
            age_mins, payload.ttl_hours
        ));
    }
    if payload.created_at > now + 300 {
        return Err("Token has a future timestamp. Check system clock.".into());
    }
    if payload.username.trim() != username.trim() || payload.project_name.trim() != project_name.trim() {
        return Err("Invalid User or Project credentials for this license.".into());
    }
    if payload.allowed_meters.is_empty() {
        return Err("License contains no allowed meter models.".into());
    }
    let expiry_date  = (payload.created_at + payload.duration_days * 86_400) as i64;
    let meters_json  = serde_json::to_string(&payload.allowed_meters).map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM settings", []).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (username, project_name, expiry_date, allowed_meters) VALUES (?1,?2,?3,?4)",
        params![username.trim(), project_name.trim(), expiry_date, meters_json],
    ).map_err(|e| e.to_string())?;
    Ok(format!("License activated for {} / {}. Valid {} days.",
        username.trim(), project_name.trim(), payload.duration_days))
}

#[tauri::command]
fn get_auth_state(db: State<DbConnection>) -> Result<AuthState, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let now  = now_secs() as i64;
    match conn.query_row(
        "SELECT username, project_name, expiry_date, allowed_meters FROM settings LIMIT 1", [],
        |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,i64>(2)?, r.get::<_,String>(3)?)),
    ) {
        Ok((u, p, exp, m)) if now < exp => Ok(AuthState {
            valid: true, username: Some(u), project_name: Some(p), expiry_date: Some(exp),
            allowed_meters: serde_json::from_str(&m).unwrap_or_default(),
        }),
        _ => Ok(AuthState { valid:false, username:None, project_name:None, expiry_date:None, allowed_meters:vec![] }),
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

    let mut result: Vec<MeterProfileEntry> = if allowed_meters.contains(&"All".to_string()) {
        // License grants everything — return all profiles in the library
        let mut v: Vec<MeterProfileEntry> = lib.values().cloned().collect();
        v.sort_by(|a, b| a.display_name.cmp(&b.display_name));
        v
    } else {
        allowed_meters.iter()
            .filter(|m| m.as_str() != "Custom" && m.as_str() != "Simulation")
            .filter_map(|m| lib.get(m).cloned())
            .collect()
    };

    // "Custom" is available only when the license explicitly permits it ("Custom" or "All")
    let license_allows_custom = allowed_meters.contains(&"All".to_string())
        || allowed_meters.contains(&"Custom".to_string());
    if license_allows_custom && !result.iter().any(|p| p.model == "Custom") {
        result.push(custom_profile());
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
        if dev.meter_model != "Custom" && !lib.contains_key(&dev.meter_model) {
            return Err(format!("\"{}\" — Unknown model \"{}\".", dev.device_name, dev.meter_model));
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

// ─── Multi-Device RS485 Polling Loop ─────────────────────────────────────────
//
// Architecture:
//   • ONE serial port is opened for the whole bus.
//   • Baud rate / parity comes from the FIRST non-Custom device's profile.
//   • The loop wakes every TICK_MS and polls each device that is "due"
//     (i.e., more than poll_rate_ms has elapsed since it was last polled).
//   • Between consecutive device polls a short RS485 turnaround delay is
//     inserted to prevent bus contention.
//   • `ctx.set_slave()` switches the Modbus slave address mid-stream without
//     reopening the serial port.
// ─────────────────────────────────────────────────────────────────────────────

async fn run_polling_loop(
    engine:   Arc<Mutex<EngineState>>,
    db:       Arc<Mutex<Connection>>,
    profiles: Arc<Mutex<HashMap<String, MeterProfileEntry>>>,
    app:      tauri::AppHandle,
) {
    let mut ctx:        Option<tokio_modbus::client::Context> = None;
    let mut active_port = String::new();
    // last_polled is keyed by device_name → Instant
    let mut last_polled: HashMap<String, Instant> = HashMap::new();

    loop {
        // ── License guard ─────────────────────────────────────────────────────
        if !is_license_valid(&db) {
            if ctx.is_some() { ctx = None; active_port.clear(); }
            sleep(Duration::from_secs(5)).await;
            continue;
        }

        let (state, com_port, devices) = {
            let e = engine.lock().unwrap();
            (e.poll.clone(), e.com_port.clone(), e.configured_devices.clone())
        };

        // ── Idle guards ───────────────────────────────────────────────────────
        if devices.is_empty() {
            if ctx.is_some() { ctx = None; active_port.clear(); }
            sleep(Duration::from_millis(500)).await;
            continue;
        }

        if state == PollState::Stopped {
            if ctx.is_some() { ctx = None; active_port.clear(); last_polled.clear(); }
            sleep(Duration::from_millis(250)).await;
            continue;
        }

        // ── Auto-reset from fault ─────────────────────────────────────────────
        if state == PollState::Fault {
            ctx = None; active_port.clear(); last_polled.clear();
            { let mut e = engine.lock().unwrap(); e.poll = PollState::Running; }
            let _ = app.emit("status-changed", StatusEvent { state: PollState::Running });
            sleep(Duration::from_secs(2)).await;
            continue;
        }

        // ── Simulation mode ───────────────────────────────────────────────────
        // If the license has "Simulation" in allowed_meters, skip the serial
        // port entirely and emit oscillating mock data for each configured device.
        let is_sim = get_allowed_meters_from_db(&db).contains(&"Simulation".to_string());
        if is_sim {
            if ctx.is_some() { ctx = None; active_port.clear(); }
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

                // Persist
                {
                    let conn = db.lock().unwrap();
                    if let Err(e) = conn.execute(
                        "INSERT INTO meter_history (timestamp, device_name, device_id, data) VALUES (?1,?2,?3,?4)",
                        params![wall_clock_iso(), &device.device_name, &device_id, &data_json],
                    ) { eprintln!("[sim] INSERT: {e}"); }
                }
                // Emit
                let _ = app.emit("meter-data", MeterReading {
                    device_name: device.device_name.clone(),
                    device_id,
                    timestamp_ms: now_ms(),
                    data,
                });
                last_polled.insert(device.device_name.clone(), Instant::now());
                sleep(Duration::from_millis(RS485_TURNAROUND_MS)).await;
            }
            let elapsed_tick = tick_start.elapsed();
            let tick_dur = Duration::from_millis(TICK_MS);
            if elapsed_tick < tick_dur { sleep(tick_dur - elapsed_tick).await; }
            continue;
        }

        // ── (Re)connect serial port ───────────────────────────────────────────
        if ctx.is_none() || com_port != active_port {
            ctx = None;
            last_polled.clear();

            // Determine bus parameters from the first non-Custom device
            let bus_profile = {
                let lib = profiles.lock().unwrap();
                devices.iter()
                    .filter(|d| d.meter_model != "Custom")
                    .find_map(|d| lib.get(&d.meter_model).cloned())
            };

            let (baud, parity_str) = bus_profile
                .map(|p| (p.baud_rate, p.parity.clone()))
                .unwrap_or((9600, "None".into()));

            let parity = match parity_str.as_str() {
                "Even" => tokio_serial::Parity::Even,
                "Odd"  => tokio_serial::Parity::Odd,
                _      => tokio_serial::Parity::None,
            };

            let builder = tokio_serial::new(&com_port, baud)
                .parity(parity)
                .stop_bits(tokio_serial::StopBits::One)
                .data_bits(tokio_serial::DataBits::Eight)
                .timeout(Duration::from_millis(PORT_TIMEOUT_MS));

            let serial = match SerialStream::open(&builder) {
                Ok(s)  => s,
                Err(e) => {
                    eprintln!("[serial] Cannot open {com_port}: {e}");
                    { let mut eng = engine.lock().unwrap(); eng.poll = PollState::Fault; }
                    let _ = app.emit("status-changed", StatusEvent { state: PollState::Fault });
                    let _ = app.emit("meter-fault", FaultEvent {
                        device_name: "BUS".into(),
                        reason:      format!("Cannot open {com_port}: {e}"),
                        timestamp_ms: now_ms(),
                    });
                    sleep(Duration::from_secs(3)).await;
                    continue;
                }
            };

            // Use first device's slave ID as the initial slave for the connection
            let first_slave = Slave(devices[0].slave_id);
            match rtu::connect_slave(serial, first_slave).await {
                Ok(c)  => { ctx = Some(c); active_port = com_port.clone(); }
                Err(e) => {
                    eprintln!("[modbus] Connect failed: {e}");
                    { let mut eng = engine.lock().unwrap(); eng.poll = PollState::Fault; }
                    let _ = app.emit("status-changed", StatusEvent { state: PollState::Fault });
                    let _ = app.emit("meter-fault", FaultEvent {
                        device_name: "BUS".into(),
                        reason:      format!("Modbus connect {com_port}: {e}"),
                        timestamp_ms: now_ms(),
                    });
                    sleep(Duration::from_secs(3)).await;
                    continue;
                }
            }
            eprintln!("[engine] Bus open: {com_port} {baud} baud, {} devices", devices.len());
        }

        // ── Poll cycle ────────────────────────────────────────────────────────
        let tick_start = Instant::now();
        let mut any_fault = false;

        'devices: for device in &devices {
            // Is this device due for a poll?
            let elapsed = last_polled.get(&device.device_name)
                .map(|t| t.elapsed().as_millis())
                .unwrap_or(u128::MAX);

            if elapsed < device.poll_rate_ms as u128 { continue; }

            // Look up endianness — Custom devices default to ABCD
            let endian = {
                let lib = profiles.lock().unwrap();
                lib.get(&device.meter_model).map(|p| p.endianness.clone())
                   .unwrap_or_else(|| "ABCD".into())
            };

            // Switch slave on the shared connection
            let ctx_ref = ctx.as_mut().unwrap();
            ctx_ref.set_slave(Slave(device.slave_id));

            match poll_device_registers(ctx_ref, &device.selected_registers, &endian).await {
                Err(e) => {
                    eprintln!("[engine] Poll error «{}»: {e}", device.device_name);
                    let _ = app.emit("meter-fault", FaultEvent {
                        device_name: device.device_name.clone(),
                        reason:      e,
                        timestamp_ms: now_ms(),
                    });
                    // Hard fault — break and reconnect on next cycle
                    ctx = None; active_port.clear(); last_polled.clear();
                    any_fault = true;
                    break 'devices;
                }
                Ok(data) => {
                    let device_id = format!("{} #{:02}", device.meter_model.replace('_', " "), device.slave_id);
                    let data_json = serde_json::to_string(&data).unwrap_or_default();

                    // Persist
                    {
                        let conn = db.lock().unwrap();
                        if let Err(e) = conn.execute(
                            "INSERT INTO meter_history (timestamp, device_name, device_id, data) VALUES (?1,?2,?3,?4)",
                            params![wall_clock_iso(), &device.device_name, &device_id, &data_json],
                        ) { eprintln!("[db] INSERT: {e}"); }
                    }

                    // Emit to frontend
                    let _ = app.emit("meter-data", MeterReading {
                        device_name: device.device_name.clone(),
                        device_id,
                        timestamp_ms: now_ms(),
                        data,
                    });

                    last_polled.insert(device.device_name.clone(), Instant::now());

                    // RS485 inter-device turnaround delay
                    sleep(Duration::from_millis(RS485_TURNAROUND_MS)).await;
                }
            }
        }

        if any_fault {
            // Emit engine-level fault so the header LED goes red
            { let mut eng = engine.lock().unwrap(); eng.poll = PollState::Fault; }
            let _ = app.emit("status-changed", StatusEvent { state: PollState::Fault });
            sleep(Duration::from_secs(2)).await;
            continue;
        }

        // Sleep for the remainder of the tick window
        let elapsed_tick = tick_start.elapsed();
        let tick_dur     = Duration::from_millis(TICK_MS);
        if elapsed_tick < tick_dur {
            sleep(tick_dur - elapsed_tick).await;
        }
    }
}

// ─── Database Init ────────────────────────────────────────────────────────────

fn init_database(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous  = NORMAL;

        DROP TABLE IF EXISTS meter_history;
        CREATE TABLE meter_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp   TEXT    NOT NULL,
            device_name TEXT    NOT NULL DEFAULT '',
            device_id   TEXT    NOT NULL DEFAULT '',
            data        TEXT    NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_mh_ts   ON meter_history (timestamp);
        CREATE INDEX IF NOT EXISTS idx_mh_name ON meter_history (device_name);

        DROP TABLE IF EXISTS settings;
        CREATE TABLE settings (
            id             INTEGER PRIMARY KEY,
            username       TEXT    NOT NULL,
            project_name   TEXT    NOT NULL,
            expiry_date    INTEGER NOT NULL,
            allowed_meters TEXT    NOT NULL
        );
    ")
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
            let db_path = dir.join("technidaq_local.db");
            eprintln!("[db] {}", db_path.display());
            let conn = Connection::open(&db_path).expect("open db");
            init_database(&conn).expect("init schema");
            let db = Arc::new(Mutex::new(conn));

            // ── Profile library ───────────────────────────────────────────────
            let profiles_map = Arc::new(Mutex::new(load_profiles_from_disk()));

            // ── Engine ───────────────────────────────────────────────────────
            let engine = Arc::new(Mutex::new(EngineState {
                poll:               PollState::Stopped,
                com_port:           "COM3".into(),
                configured_devices: vec![],
            }));

            app.manage(DbConnection(Arc::clone(&db)));
            app.manage(ProfilesState(Arc::clone(&profiles_map)));
            app.manage(SharedEngine(Arc::clone(&engine)));

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
            ));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_polling, get_status, clear_history, get_record_count, export_to_excel,
            activate_license, get_auth_state, logout_user,
            get_meter_profiles, reload_profiles, apply_bus_config,
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