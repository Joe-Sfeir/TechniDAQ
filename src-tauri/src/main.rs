// src-tauri/src/main.rs  — TechniDAQ Phase 3 (Universal SCADA Engine)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::{params, Connection};
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, RunEvent, State, WindowEvent,
};
use tokio::time::sleep;
use tokio_modbus::prelude::*;
use tokio_serial::SerialStream;

// ─── Auth ─────────────────────────────────────────────────────────────────────

const MASTER_KEY_HEX: &str =
    "6f3d9a2e1b8c4f7a0e5d2b9c6a3f1e8d4b7c0a9e2f5d8b1c4a7e0f3d6b9c2a5f";
const ACTIVATION_TTL_SECS: u64 = 3_600;
const PORT_TIMEOUT_MS:      u64 = 500;

// ─── Register Types ───────────────────────────────────────────────────────────

/// A single Modbus register entry — used both as library definition and as a
/// selected/custom register in the active polling configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterEntry {
    pub name:       String,
    pub address:    u16,
    pub length:     u16,           // 1 = 16-bit, 2 = 32-bit
    pub data_type:  String,        // "Float32" | "UInt16" | "UInt32" | "INT16" | "INT32"
    pub multiplier: f64,
}

/// Full meter profile from the embedded library.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeterProfileEntry {
    pub model:        String,
    pub display_name: String,
    pub endianness:   String,    // "ABCD" | "CDAB" | "BADC"
    pub baud_rate:    u32,
    pub parity:       String,    // "Even" | "Odd" | "None"
    pub registers:    Vec<RegisterEntry>,
}

// ─── Embedded Device Library ──────────────────────────────────────────────────
// Built from official Schneider PM2xxx register list (XLS) + manufacturer docs.
// Addresses are 0-indexed (Modbus protocol address = register_number - 1).
// All power values for PM2220 are returned by the meter in kW/kVAr/kVA.
// ─────────────────────────────────────────────────────────────────────────────
const METER_LIBRARY_JSON: &str = r#"
{
  "Schneider_PM2220": {
    "model":        "Schneider_PM2220",
    "display_name": "Schneider Electric PM2220",
    "endianness":   "ABCD",
    "baud_rate":    19200,
    "parity":       "Even",
    "registers": [
      { "name": "Current A",              "address": 2999, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current B",              "address": 3001, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current C",              "address": 3003, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current N",              "address": 3005, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current Avg",            "address": 3009, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage A-B",            "address": 3019, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage B-C",            "address": 3021, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage C-A",            "address": 3023, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L-L Avg",        "address": 3025, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage A-N",            "address": 3027, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage B-N",            "address": 3029, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage C-N",            "address": 3031, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L-N Avg",        "address": 3035, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage Unbalance L-L",  "address": 3033, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage Unbalance A-B",  "address": 3037, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage Unbalance B-C",  "address": 3039, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage Unbalance C-A",  "address": 3041, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Active Power A",         "address": 3053, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Active Power B",         "address": 3055, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Active Power C",         "address": 3057, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Active Power Total",     "address": 3059, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Reactive Power A",       "address": 3061, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Reactive Power B",       "address": 3063, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Reactive Power C",       "address": 3065, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Reactive Power Total",   "address": 3067, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Apparent Power A",       "address": 3069, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Apparent Power B",       "address": 3071, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Apparent Power C",       "address": 3073, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Apparent Power Total",   "address": 3075, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Power Factor A",         "address": 3077, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Power Factor B",         "address": 3079, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Power Factor C",         "address": 3081, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Power Factor Total",     "address": 3083, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Frequency",              "address": 3109, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Total Active Energy",    "address": 3203, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Active Energy Delivered","address": 3205, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Active Energy Received", "address": 3207, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Reactive Energy Total",  "address": 3219, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Apparent Energy Total",  "address": 3227, "length": 2, "data_type": "Float32", "multiplier": 1.0    }
    ]
  },
  "Socomec_Diris_A40": {
    "model":        "Socomec_Diris_A40",
    "display_name": "Socomec Diris A40",
    "endianness":   "CDAB",
    "baud_rate":    9600,
    "parity":       "Even",
    "registers": [
      { "name": "Voltage L1-L2",          "address": 6,  "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L2-L3",          "address": 8,  "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L3-L1",          "address": 10, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L-L Avg",        "address": 12, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L1-N",           "address": 14, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L2-N",           "address": 16, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L3-N",           "address": 18, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L-N Avg",        "address": 20, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current L1",             "address": 24, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current L2",             "address": 26, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current L3",             "address": 28, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current N",              "address": 30, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current Avg",            "address": 32, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Active Power Total",     "address": 36, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Active Power L1",        "address": 38, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Active Power L2",        "address": 40, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Active Power L3",        "address": 42, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Reactive Power Total",   "address": 44, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Reactive Power L1",      "address": 46, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Reactive Power L2",      "address": 48, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Reactive Power L3",      "address": 50, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Apparent Power Total",   "address": 52, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Power Factor Total",     "address": 60, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Power Factor L1",        "address": 62, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Power Factor L2",        "address": 64, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Power Factor L3",        "address": 66, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Frequency",              "address": 70, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Total Active Energy",    "address": 88, "length": 2, "data_type": "UInt32",  "multiplier": 0.001  },
      { "name": "Active Energy Delivered","address": 90, "length": 2, "data_type": "UInt32",  "multiplier": 0.001  },
      { "name": "Active Energy Received", "address": 92, "length": 2, "data_type": "UInt32",  "multiplier": 0.001  },
      { "name": "Reactive Energy Total",  "address": 94, "length": 2, "data_type": "UInt32",  "multiplier": 0.001  }
    ]
  },
  "Lovato_DMG": {
    "model":        "Lovato_DMG",
    "display_name": "Lovato DMG610",
    "endianness":   "ABCD",
    "baud_rate":    19200,
    "parity":       "None",
    "registers": [
      { "name": "Voltage L1-L2",          "address": 0,  "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L2-L3",          "address": 2,  "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L3-L1",          "address": 4,  "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L1-N",           "address": 6,  "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L2-N",           "address": 8,  "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Voltage L3-N",           "address": 10, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current L1",             "address": 12, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current L2",             "address": 14, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Current L3",             "address": 16, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Frequency",              "address": 20, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Active Power L1",        "address": 24, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Active Power L2",        "address": 26, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Active Power L3",        "address": 28, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Active Power Total",     "address": 30, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Reactive Power L1",      "address": 32, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Reactive Power L2",      "address": 34, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Reactive Power L3",      "address": 36, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Reactive Power Total",   "address": 38, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Apparent Power L1",      "address": 40, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Apparent Power L2",      "address": 42, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Apparent Power L3",      "address": 44, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Apparent Power Total",   "address": 46, "length": 2, "data_type": "Float32", "multiplier": 0.001  },
      { "name": "Power Factor L1",        "address": 48, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Power Factor L2",        "address": 50, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Power Factor L3",        "address": 52, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Power Factor Total",     "address": 54, "length": 2, "data_type": "Float32", "multiplier": 1.0    },
      { "name": "Total Active Energy",    "address": 64, "length": 2, "data_type": "UInt32",  "multiplier": 0.001  },
      { "name": "Active Energy Delivered","address": 66, "length": 2, "data_type": "UInt32",  "multiplier": 0.001  },
      { "name": "Active Energy Received", "address": 68, "length": 2, "data_type": "UInt32",  "multiplier": 0.001  },
      { "name": "Reactive Energy Total",  "address": 70, "length": 2, "data_type": "UInt32",  "multiplier": 0.001  }
    ]
  }
}
"#;

// ─── Engine State ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PollState { Stopped, Running, Fault }

pub struct EngineState {
    pub poll:               PollState,
    pub com_port:           String,
    pub slave_id:           u8,
    pub meter_model:        String,
    /// Active register selection (predefined + custom).  Empty = not configured.
    pub selected_registers: Vec<RegisterEntry>,
}

pub struct SharedEngine(pub Arc<Mutex<EngineState>>);
pub struct DbConnection(pub Arc<Mutex<Connection>>);

// ─── Event Payloads ───────────────────────────────────────────────────────────

/// Emitted each poll tick.  `data` maps register name → scaled engineering value.
#[derive(Serialize, Clone, Debug)]
pub struct MeterReading {
    pub device_id:    String,
    pub timestamp_ms: u128,
    pub data:         HashMap<String, f64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct FaultEvent  { pub reason: String, pub timestamp_ms: u128 }

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
    username:       String,
    project_name:   String,
    allowed_meters: Vec<String>,
}

// ─── Library Helpers ──────────────────────────────────────────────────────────

fn parse_meter_library() -> HashMap<String, MeterProfileEntry> {
    serde_json::from_str(METER_LIBRARY_JSON)
        .expect("METER_LIBRARY_JSON malformed — compile-time bug")
}

fn find_meter_profile(model: &str) -> Option<MeterProfileEntry> {
    parse_meter_library().remove(model)
}

// ─── Byte-Order Helpers ───────────────────────────────────────────────────────

fn regs_to_f32(regs: &[u16], endian: &str) -> f32 {
    let b: [u8; 4] = match endian {
        "ABCD" => [(regs[0]>>8) as u8, (regs[0]&0xFF) as u8, (regs[1]>>8) as u8, (regs[1]&0xFF) as u8],
        "CDAB" => [(regs[1]>>8) as u8, (regs[1]&0xFF) as u8, (regs[0]>>8) as u8, (regs[0]&0xFF) as u8],
        "BADC" => [(regs[0]&0xFF) as u8, (regs[0]>>8) as u8, (regs[1]&0xFF) as u8, (regs[1]>>8) as u8],
        _      => [(regs[0]>>8) as u8, (regs[0]&0xFF) as u8, (regs[1]>>8) as u8, (regs[1]&0xFF) as u8],
    };
    f32::from_be_bytes(b)
}

fn regs_to_u32(regs: &[u16], endian: &str) -> u32 {
    match endian {
        "CDAB" => ((regs[1] as u32) << 16) | (regs[0] as u32),
        _      => ((regs[0] as u32) << 16) | (regs[1] as u32),
    }
}

fn decode_register(regs: &[u16], endian: &str, dtype: &str, multiplier: f64) -> f64 {
    let raw: f64 = match dtype {
        "Float32"               => regs_to_f32(regs, endian) as f64,
        "UInt32" | "INT32U"     => regs_to_u32(regs, endian) as f64,
        "UInt16" | "INT16U"     => regs[0] as f64,
        "INT16"                 => regs[0] as i16 as f64,
        "INT32"                 => {
            let raw_u32 = regs_to_u32(regs, endian);
            raw_u32 as i32 as f64
        }
        _                       => regs_to_f32(regs, endian) as f64,
    };
    raw * multiplier
}

// ─── Misc Helpers ─────────────────────────────────────────────────────────────

fn wall_clock_iso() -> String {
    let s0 = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let (s, m, h) = (s0%60, (s0/60)%60, (s0/3600)%24);
    let d = s0/86400; let yr = 1970+d/365; let mo = (d%365)/30+1; let dy = (d%365)%30+1;
    format!("{yr:04}-{mo:02}-{dy:02}T{h:02}:{m:02}:{s:02}")
}
fn now_ms() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() }
fn now_secs() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }

fn hex_decode(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len()%2 != 0 { return Err("Odd hex length".into()); }
    (0..hex.len()).step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i+2], 16).map_err(|_| format!("Bad hex at {i}")))
        .collect()
}

fn decrypt_license_token(token: &str) -> Result<LicensePayload, String> {
    let raw = B64.decode(token.trim()).map_err(|e| format!("Base64: {e}"))?;
    if raw.len() < 29 { return Err("Token too short".into()); }
    let (iv_b, ct) = raw.split_at(12);
    let key_bytes = hex_decode(MASTER_KEY_HEX)?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let plaintext = Aes256Gcm::new(key)
        .decrypt(Nonce::from_slice(iv_b), ct)
        .map_err(|_| "Invalid or tampered license key".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|e| format!("Payload corrupt: {e}"))
}

fn is_license_valid(db: &Arc<Mutex<Connection>>) -> bool {
    let conn = db.lock().unwrap();
    let now  = now_secs() as i64;
    conn.query_row("SELECT expiry_date FROM settings LIMIT 1", [], |r| r.get::<_,i64>(0))
        .map(|exp| now < exp).unwrap_or(false)
}

fn emit_fault(app: &tauri::AppHandle, engine: &Arc<Mutex<EngineState>>, reason: String) {
    { let mut e = engine.lock().unwrap(); if e.poll != PollState::Stopped { e.poll = PollState::Fault; } }
    let _ = app.emit("status-changed", StatusEvent { state: PollState::Fault });
    let _ = app.emit("meter-fault",    FaultEvent { reason, timestamp_ms: now_ms() });
}

// ─── Tauri Commands ── Engine ─────────────────────────────────────────────────

#[tauri::command]
fn toggle_polling(com_port: String, engine: State<SharedEngine>, app_handle: tauri::AppHandle) -> Result<PollState, String> {
    let new_state = {
        let mut e = engine.0.lock().map_err(|e| e.to_string())?;
        e.com_port = com_port.trim().to_string();
        e.poll = match e.poll { PollState::Running => PollState::Stopped, _ => PollState::Running };
        e.poll.clone()
    };
    app_handle.emit("status-changed", StatusEvent { state: new_state.clone() }).map_err(|e| e.to_string())?;
    Ok(new_state)
}

#[tauri::command]
fn get_status(engine: State<SharedEngine>) -> Result<PollState, String> {
    Ok(engine.0.lock().map_err(|e| e.to_string())?.poll.clone())
}

#[tauri::command]
fn clear_history(db: State<DbConnection>) -> Result<usize, String> {
    db.0.lock().map_err(|e| e.to_string())?
       .execute("DELETE FROM meter_history", []).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_record_count(db: State<DbConnection>) -> Result<i64, String> {
    db.0.lock().map_err(|e| e.to_string())?
       .query_row("SELECT COUNT(*) FROM meter_history", [], |r| r.get(0)).map_err(|e| e.to_string())
}

// ─── Tauri Commands ── Excel Export (Dynamic) ─────────────────────────────────

#[tauri::command]
fn export_to_excel(path: String, db: State<DbConnection>) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // 1. Load all rows
    let mut stmt = conn.prepare(
        "SELECT id, timestamp, device_id, data FROM meter_history ORDER BY id ASC"
    ).map_err(|e| e.to_string())?;

    #[derive(Debug)]
    struct Row { id: i64, timestamp: String, device_id: String, data: String }
    let all_rows: Vec<Row> = stmt.query_map([], |r| Ok(Row {
        id:        r.get(0)?, timestamp: r.get(1)?,
        device_id: r.get(2)?, data:      r.get(3)?,
    })).map_err(|e| e.to_string())?
       .filter_map(|r| r.ok()).collect();

    // 2. Collect all unique data keys (preserving first-seen insertion order)
    let mut key_order: Vec<String> = Vec::new();
    let mut key_set:   HashSet<String> = HashSet::new();
    let parsed: Vec<HashMap<String,f64>> = all_rows.iter().map(|row| {
        let map: HashMap<String,f64> = serde_json::from_str(&row.data).unwrap_or_default();
        for k in map.keys() {
            if key_set.insert(k.clone()) { key_order.push(k.clone()); }
        }
        map
    }).collect();

    // 3. Build workbook
    let mut wb = Workbook::new();
    let ws     = wb.add_worksheet();
    ws.set_name("TechniDAQ Data").map_err(|e| e.to_string())?;

    let hdr = Format::new()
        .set_background_color(Color::RGB(0x1535D4)).set_font_color(Color::White)
        .set_bold().set_font_size(10.0).set_align(FormatAlign::Center)
        .set_border_bottom(FormatBorder::Medium);
    let ts_f  = Format::new().set_align(FormatAlign::Left);
    let n2_f  = Format::new().set_num_format("0.00").set_align(FormatAlign::Right);
    let at_f  = Format::new().set_background_color(Color::RGB(0xEEF2FF)).set_align(FormatAlign::Left);
    let an2_f = Format::new().set_background_color(Color::RGB(0xEEF2FF)).set_num_format("0.000").set_align(FormatAlign::Right);

    // Header row: ID | Timestamp | Device | <dynamic keys...>
    let static_cols = [("ID", 8.0), ("Timestamp", 22.0), ("Device", 20.0)];
    for (c, (label, w)) in static_cols.iter().enumerate() {
        ws.set_column_width(c as u16, *w).ok();
        ws.write_with_format(0, c as u16, *label, &hdr).map_err(|e| e.to_string())?;
    }
    for (i, key) in key_order.iter().enumerate() {
        let col = (static_cols.len() + i) as u16;
        ws.set_column_width(col, 18.0).ok();
        ws.write_with_format(0, col, key.as_str(), &hdr).map_err(|e| e.to_string())?;
    }
    ws.set_freeze_panes(1, 0).map_err(|e| e.to_string())?;

    // Data rows
    for (i, (row, data_map)) in all_rows.iter().zip(parsed.iter()).enumerate() {
        let xr  = (i + 1) as u32;
        let alt = i % 2 == 1;
        ws.write(xr, 0, row.id).ok();
        ws.write_with_format(xr, 1, row.timestamp.as_str(), if alt { &at_f } else { &ts_f }).ok();
        ws.write_with_format(xr, 2, row.device_id.as_str(), if alt { &at_f } else { &ts_f }).ok();
        for (j, key) in key_order.iter().enumerate() {
            let col = (static_cols.len() + j) as u16;
            if let Some(&val) = data_map.get(key) {
                ws.write_with_format(xr, col, val, if alt { &an2_f } else { &n2_f }).ok();
            }
        }
    }
    let n = all_rows.len();
    if n > 0 {
        let total_cols = (static_cols.len() + key_order.len() - 1) as u16;
        ws.autofilter(0, 0, n as u32, total_cols).ok();
    }
    wb.save(&path).map_err(|e| e.to_string())?;
    Ok(n)
}

// ─── Tauri Commands ── License ────────────────────────────────────────────────

#[tauri::command]
fn activate_license(key: String, username: String, project_name: String, db: State<DbConnection>) -> Result<String, String> {
    let payload = decrypt_license_token(&key)?;
    let now = now_secs();
    let age = now.saturating_sub(payload.created_at);
    if age > ACTIVATION_TTL_SECS {
        return Err(format!("Token expired ({} min old). Keys must be used within 60 minutes.", age/60));
    }
    if payload.created_at > now + 300 {
        return Err("Token has future timestamp. Check system clock.".into());
    }
    if payload.username.trim() != username.trim() || payload.project_name.trim() != project_name.trim() {
        return Err("Invalid User or Project credentials for this license.".into());
    }
    if payload.allowed_meters.is_empty() {
        return Err("License contains no allowed meter models.".into());
    }
    let expiry_date = (payload.created_at + payload.duration_days * 86_400) as i64;
    let meters_json = serde_json::to_string(&payload.allowed_meters).map_err(|e| e.to_string())?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM settings", []).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (username, project_name, expiry_date, allowed_meters) VALUES (?1,?2,?3,?4)",
        params![username.trim(), project_name.trim(), expiry_date, meters_json],
    ).map_err(|e| e.to_string())?;
    Ok(format!("License activated for {} / {}. Valid for {} days.", username.trim(), project_name.trim(), payload.duration_days))
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
            valid: true, username: Some(u), project_name: Some(p),
            expiry_date: Some(exp),
            allowed_meters: serde_json::from_str(&m).unwrap_or_default(),
        }),
        _ => Ok(AuthState { valid: false, username: None, project_name: None, expiry_date: None, allowed_meters: vec![] }),
    }
}

// ─── Tauri Commands ── Device Library ────────────────────────────────────────

/// Return full meter profiles for the models listed in `allowed_meters`.
#[tauri::command]
fn get_meter_profiles(allowed_meters: Vec<String>) -> Result<Vec<MeterProfileEntry>, String> {
    let lib = parse_meter_library();
    Ok(allowed_meters.iter().filter_map(|m| lib.get(m).cloned()).collect())
}

/// Apply device configuration to the polling engine.
/// `selected_registers` contains the user's chosen register subset (predefined + custom).
#[tauri::command]
fn apply_device_config(
    meter_model:        String,
    slave_id:           u8,
    selected_registers: Vec<RegisterEntry>,
    engine:             State<SharedEngine>,
) -> Result<MeterProfileEntry, String> {
    if slave_id == 0 || slave_id > 247 {
        return Err(format!("Slave ID must be 1–247, got {slave_id}"));
    }
    if selected_registers.is_empty() {
        return Err("At least one register must be selected.".into());
    }
    let profile = find_meter_profile(&meter_model)
        .ok_or_else(|| format!("Unknown meter model: '{meter_model}'"))?;
    {
        let mut eng = engine.0.lock().map_err(|e| e.to_string())?;
        eng.slave_id           = slave_id;
        eng.meter_model        = meter_model;
        eng.selected_registers = selected_registers.clone();
    }
    eprintln!("[engine] Config: {} · Slave {} · {} registers", profile.display_name, slave_id, selected_registers.len());
    Ok(profile)
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

/// Poll all selected registers and return a data map.
async fn poll_selected_registers(
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

// ─── Main Polling Loop ────────────────────────────────────────────────────────

async fn run_polling_loop(engine: Arc<Mutex<EngineState>>, db: Arc<Mutex<Connection>>, app: tauri::AppHandle) {
    let mut ctx:           Option<tokio_modbus::client::Context> = None;
    let mut active_profile: Option<MeterProfileEntry>            = None;
    let mut active_port   = String::new();
    let mut active_slave:   u8 = 0;
    let mut active_model  = String::new();

    loop {
        if !is_license_valid(&db) {
            if ctx.is_some() { ctx = None; active_profile = None; active_port.clear(); }
            sleep(Duration::from_secs(5)).await;
            continue;
        }

        let (state, com_port, slave_id, meter_model, selected_registers) = {
            let e = engine.lock().unwrap();
            (e.poll.clone(), e.com_port.clone(), e.slave_id, e.meter_model.clone(), e.selected_registers.clone())
        };

        if meter_model.is_empty() || selected_registers.is_empty() {
            if ctx.is_some() { ctx = None; active_profile = None; active_port.clear(); }
            sleep(Duration::from_millis(500)).await;
            continue;
        }

        if state == PollState::Stopped {
            if ctx.is_some() { ctx = None; active_profile = None; active_port.clear(); }
            sleep(Duration::from_millis(250)).await;
            continue;
        }

        if state == PollState::Fault {
            ctx = None; active_profile = None; active_port.clear(); active_slave = 0;
            { let mut e = engine.lock().unwrap(); e.poll = PollState::Running; }
            let _ = app.emit("status-changed", StatusEvent { state: PollState::Running });
        }

        let device_changed = slave_id != active_slave || meter_model != active_model;
        if device_changed && ctx.is_some() {
            ctx = None; active_profile = None; active_port.clear();
        }

        // ── Connect ───────────────────────────────────────────────────────────
        if ctx.is_none() || com_port != active_port {
            let profile = match find_meter_profile(&meter_model) {
                Some(p) => p,
                None => {
                    emit_fault(&app, &engine, format!("Unknown model '{meter_model}'"));
                    sleep(Duration::from_secs(2)).await; continue;
                }
            };
            let parity = match profile.parity.as_str() {
                "Even" => tokio_serial::Parity::Even,
                "Odd"  => tokio_serial::Parity::Odd,
                _      => tokio_serial::Parity::None,
            };
            active_port  = com_port.clone();
            active_slave = slave_id;
            active_model = meter_model.clone();
            let builder = tokio_serial::new(&com_port, profile.baud_rate)
                .parity(parity).stop_bits(tokio_serial::StopBits::One)
                .data_bits(tokio_serial::DataBits::Eight)
                .timeout(Duration::from_millis(PORT_TIMEOUT_MS));
            let serial = match SerialStream::open(&builder) {
                Ok(s)  => s,
                Err(e) => {
                    emit_fault(&app, &engine, format!("Cannot open {com_port}: {e}"));
                    sleep(Duration::from_secs(1)).await; continue;
                }
            };
            match rtu::connect_slave(serial, Slave(slave_id)).await {
                Ok(c)  => { ctx = Some(c); active_profile = Some(profile); }
                Err(e) => {
                    emit_fault(&app, &engine, format!("Modbus connect {com_port}: {e}"));
                    sleep(Duration::from_secs(1)).await; continue;
                }
            }
        }

        // ── Poll ──────────────────────────────────────────────────────────────
        let endian = active_profile.as_ref().map(|p| p.endianness.as_str()).unwrap_or("ABCD");
        let result = poll_selected_registers(ctx.as_mut().unwrap(), &selected_registers, endian).await;
        match result {
            Err(e) => {
                eprintln!("[engine] Poll error: {e}");
                ctx = None; active_profile = None;
                emit_fault(&app, &engine, e);
                sleep(Duration::from_secs(1)).await; continue;
            }
            Ok(data) => {
                let device_id   = format!("{} #{:02}", active_model.replace('_', " "), active_slave);
                let data_json   = serde_json::to_string(&data).unwrap_or_default();
                {
                    let conn = db.lock().unwrap();
                    if let Err(e) = conn.execute(
                        "INSERT INTO meter_history (timestamp, device_id, data) VALUES (?1,?2,?3)",
                        params![wall_clock_iso(), &device_id, &data_json],
                    ) { eprintln!("[db] INSERT: {e}"); }
                }
                let _ = app.emit("meter-data", MeterReading {
                    device_id, timestamp_ms: now_ms(), data,
                });
            }
        }
        sleep(Duration::from_secs(1)).await;
    }
}

// ─── Database Init ────────────────────────────────────────────────────────────

fn init_database(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous  = NORMAL;

        -- Phase 3: Dynamic JSON payload storage.
        -- `data` is a JSON object mapping register name → float value.
        CREATE TABLE IF NOT EXISTS meter_history (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT    NOT NULL,
            device_id TEXT    NOT NULL DEFAULT '',
            data      TEXT    NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_mh_timestamp ON meter_history (timestamp);

        -- Settings / license (Phase 2 schema)
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
            let dir = app.path().app_local_data_dir().expect("app data dir");
            std::fs::create_dir_all(&dir).expect("create dir");
            let db_path = dir.join("technidaq_local.db");
            eprintln!("[db] {}", db_path.display());
            let conn = Connection::open(&db_path).expect("open db");
            init_database(&conn).expect("init schema");
            let db     = Arc::new(Mutex::new(conn));
            let engine = Arc::new(Mutex::new(EngineState {
                poll:               PollState::Stopped,
                com_port:           "COM3".into(),
                slave_id:           1,
                meter_model:        String::new(),
                selected_registers: vec![],
            }));
            app.manage(DbConnection(Arc::clone(&db)));
            app.manage(SharedEngine(Arc::clone(&engine)));

            let show_i = MenuItem::with_id(app, "show", "Open Dashboard", true, None::<&str>)?;
            let sep    = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit TechniDAQ",  true, None::<&str>)?;
            let menu   = Menu::with_items(app, &[&show_i, &sep, &quit_i])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("TechniDAQ").menu(&menu).show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "show" => { if let Some(w) = app.get_webview_window("main") { let _=w.show(); let _=w.set_focus(); } }
                    "quit" => std::process::exit(0), _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = ev {
                        if let Some(w) = tray.app_handle().get_webview_window("main") { let _=w.show(); let _=w.set_focus(); }
                    }
                })
                .build(app)?;
            tauri::async_runtime::spawn(run_polling_loop(Arc::clone(&engine), Arc::clone(&db), app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_polling, get_status, clear_history, get_record_count, export_to_excel,
            activate_license, get_auth_state,
            get_meter_profiles, apply_device_config,
        ])
        .build(tauri::generate_context!())
        .expect("build failed")
        .run(|app, event| {
            if let RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } = event {
                if label == "main" { api.prevent_close(); if let Some(w) = app.get_webview_window("main") { let _=w.hide(); } }
            }
        });
}