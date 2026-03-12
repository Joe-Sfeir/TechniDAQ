// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
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

// ─── MASTER KEY ───────────────────────────────────────────────────────────────
//
// ⚠️  MUST MATCH the MASTER_KEY_HEX in generate_license.js exactly.
//    Change this before building a production release.
//    Generate your own: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
const MASTER_KEY_HEX: &str =
    "6f3d9a2e1b8c4f7a0e5d2b9c6a3f1e8d4b7c0a9e2f5d8b1c4a7e0f3d6b9c2a5f";

// 1-hour activation window: the license key must be used within this many
// seconds of being generated, preventing replay attacks.
const ACTIVATION_TTL_SECS: u64 = 3_600;

// ─── Poll State ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PollState {
    Stopped,
    Running,
    Fault,
}

pub struct EngineState {
    pub poll:     PollState,
    pub com_port: String,
}

pub struct SharedEngine(pub Arc<Mutex<EngineState>>);
pub struct DbConnection(pub Arc<Mutex<Connection>>);

// ─── License Types ────────────────────────────────────────────────────────────

/// Returned by `get_auth_state` to the frontend.
#[derive(Serialize, Clone, Debug)]
pub struct AuthState {
    pub valid:        bool,
    pub username:     Option<String>,
    pub project_name: Option<String>,
    pub expiry_date:  Option<i64>,  // Unix timestamp — frontend may display expiry
}

/// The JSON payload encrypted inside every license key.
#[derive(Deserialize, Debug)]
struct LicensePayload {
    created_at:    u64, // Unix seconds — token birth time
    duration_days: u64, // License length in days
}

// ─── Event Payloads ───────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct MeterReading {
    pub voltage:      f64,
    pub current:      f64,
    pub active_power: f64,
    pub total_energy: f64,
    pub timestamp_ms: u128,
    pub power_factor: f64,
    pub frequency:    f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct FaultEvent {
    pub reason:       String,
    pub timestamp_ms: u128,
}

#[derive(Serialize, Clone, Debug)]
pub struct StatusEvent {
    pub state: PollState,
}

// ─── PM2220 Register Map (0-indexed = manual address − 1) ─────────────────────

const REG_VOLTAGE:      u16 = 3027;
const REG_CURRENT:      u16 = 2999;
const REG_ACTIVE_POWER: u16 = 3053;
const REG_TOTAL_ENERGY: u16 = 3203;
const REG_FREQUENCY:    u16 = 3108;

const SLAVE_ID:        u8  = 1;
const BAUD_RATE:       u32 = 19200;
const PORT_TIMEOUT_MS: u64 = 500;

// ─── Byte-order: Schneider ABCD (big-endian words) ────────────────────────────

fn regs_to_f32(regs: &[u16]) -> f32 {
    let bytes = [
        (regs[0] >> 8)   as u8,
        (regs[0] & 0xFF) as u8,
        (regs[1] >> 8)   as u8,
        (regs[1] & 0xFF) as u8,
    ];
    f32::from_be_bytes(bytes)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn wall_clock_iso() -> String {
    let s0 = SystemTime::now().duration_since(UNIX_EPOCH)
        .unwrap_or_default().as_secs();
    let s  = s0 % 60;
    let m  = (s0 / 60) % 60;
    let h  = (s0 / 3600) % 24;
    let d  = s0 / 86400;
    let yr = 1970 + d / 365;
    let mo = (d % 365) / 30 + 1;
    let dy = (d % 365) % 30 + 1;
    format!("{yr:04}-{mo:02}-{dy:02}T{h:02}:{m:02}:{s:02}")
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .unwrap_or_default().as_millis()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .unwrap_or_default().as_secs()
}

/// Decode a hex string into bytes without any extra crates.
fn hex_decode(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err("Hex string has odd length".into());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16)
            .map_err(|_| format!("Invalid hex byte at position {i}")))
        .collect()
}

/// Decrypt a base64-encoded AES-256-GCM license token.
/// Token format: base64( IV[12] || Ciphertext[N] || AuthTag[16] )
fn decrypt_license_token(token: &str) -> Result<LicensePayload, String> {
    // 1. Base64-decode the token
    let raw = B64.decode(token.trim())
        .map_err(|e| format!("Invalid license key (base64): {e}"))?;

    // 2. Minimum length: 12 (IV) + 1 (at least 1 byte payload) + 16 (tag) = 29
    if raw.len() < 29 {
        return Err("License key is too short".into());
    }

    // 3. Split components
    let (iv_bytes, rest) = raw.split_at(12);
    // rest = ciphertext_bytes + auth_tag_bytes; aes-gcm expects them concatenated
    let ciphertext_with_tag = rest; // the Aead::decrypt API in aes-gcm 0.10 wants tag appended

    // 4. Build cipher from master key
    let key_bytes = hex_decode(MASTER_KEY_HEX)
        .map_err(|_| "Internal error: master key malformed".to_string())?;
    if key_bytes.len() != 32 {
        return Err("Internal error: master key must be 32 bytes".into());
    }
    let key    = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce  = Nonce::from_slice(iv_bytes);

    // 5. Decrypt (also verifies auth tag)
    let plaintext = cipher.decrypt(nonce, ciphertext_with_tag)
        .map_err(|_| "License key is invalid or has been tampered with".to_string())?;

    // 6. Parse JSON payload
    let payload: LicensePayload = serde_json::from_slice(&plaintext)
        .map_err(|e| format!("License payload corrupt: {e}"))?;

    Ok(payload)
}

/// Quick check used by the polling loop — never holds the lock across an await.
fn is_license_valid(db: &Arc<Mutex<Connection>>) -> bool {
    let conn = db.lock().unwrap();
    let now  = now_secs() as i64;
    conn.query_row(
        "SELECT expiry_date FROM settings LIMIT 1",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|expiry| now < expiry)
    .unwrap_or(false)
}

/// Emit status-changed + meter-fault without holding any Mutex.
fn emit_fault(app: &tauri::AppHandle, engine: &Arc<Mutex<EngineState>>, reason: String) {
    {
        let mut eng = engine.lock().unwrap();
        if eng.poll != PollState::Stopped {
            eng.poll = PollState::Fault;
        }
    }
    let _ = app.emit("status-changed", StatusEvent { state: PollState::Fault });
    let _ = app.emit("meter-fault",    FaultEvent { reason, timestamp_ms: now_ms() });
}

// ─── Tauri Commands — Existing ────────────────────────────────────────────────

#[tauri::command]
fn toggle_polling(
    com_port:   String,
    engine:     State<SharedEngine>,
    app_handle: tauri::AppHandle,
) -> Result<PollState, String> {
    let new_state = {
        let mut eng  = engine.0.lock().map_err(|e| e.to_string())?;
        eng.com_port = com_port.trim().to_string();
        eng.poll = match eng.poll {
            PollState::Running        => PollState::Stopped,
            PollState::Stopped
            | PollState::Fault        => PollState::Running,
        };
        eng.poll.clone()
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
fn clear_history(db: State<DbConnection>) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meter_history", [])
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_record_count(db: State<DbConnection>) -> Result<i64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM meter_history", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn export_to_excel(path: String, db: State<DbConnection>) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut wb = Workbook::new();
    let ws     = wb.add_worksheet();
    ws.set_name("TechniDAQ Data").map_err(|e| e.to_string())?;

    let hdr = Format::new()
        .set_background_color(Color::RGB(0x1535D4))
        .set_font_color(Color::White)
        .set_bold()
        .set_font_size(10.0)
        .set_align(FormatAlign::Center)
        .set_border_bottom(FormatBorder::Medium);

    let ts_f  = Format::new().set_align(FormatAlign::Left);
    let n2_f  = Format::new().set_num_format("0.00")  .set_align(FormatAlign::Right);
    let n4_f  = Format::new().set_num_format("0.0000").set_align(FormatAlign::Right);
    let at_f  = Format::new().set_background_color(Color::RGB(0xEEF2FF)).set_align(FormatAlign::Left);
    let an2_f = Format::new().set_background_color(Color::RGB(0xEEF2FF)).set_num_format("0.00")  .set_align(FormatAlign::Right);
    let an4_f = Format::new().set_background_color(Color::RGB(0xEEF2FF)).set_num_format("0.0000").set_align(FormatAlign::Right);

    let cols: &[(&str, f64)] = &[
        ("ID", 8.0), ("Timestamp", 22.0), ("Voltage (V)", 14.0),
        ("Current (A)", 14.0), ("Active Power (kW)", 18.0),
        ("Total Energy (kWh)", 20.0), ("Power Factor", 14.0), ("Frequency (Hz)", 16.0),
    ];

    for (c, (label, w)) in cols.iter().enumerate() {
        ws.set_column_width(c as u16, *w).ok();
        ws.write_with_format(0, c as u16, *label, &hdr).map_err(|e| e.to_string())?;
    }
    ws.set_freeze_panes(1, 0).map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(
        "SELECT id,timestamp,voltage,current,active_power,total_energy,power_factor,frequency
         FROM meter_history ORDER BY id ASC"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |r| Ok((
        r.get::<_,i64>(0)?,   r.get::<_,String>(1)?,
        r.get::<_,f64>(2)?,   r.get::<_,f64>(3)?,
        r.get::<_,f64>(4)?,   r.get::<_,f64>(5)?,
        r.get::<_,f64>(6)?,   r.get::<_,f64>(7)?,
    ))).map_err(|e| e.to_string())?;

    let mut n = 0usize;
    for row in rows {
        let (id, ts, v, i, p, e, pf, hz) = row.map_err(|e| e.to_string())?;
        let xr  = (n + 1) as u32;
        let alt = n % 2 == 1;
        ws.write(xr, 0, id).ok();
        ws.write_with_format(xr, 1, ts,  if alt { &at_f  } else { &ts_f  }).ok();
        ws.write_with_format(xr, 2, v,   if alt { &an2_f } else { &n2_f  }).ok();
        ws.write_with_format(xr, 3, i,   if alt { &an2_f } else { &n2_f  }).ok();
        ws.write_with_format(xr, 4, p,   if alt { &an2_f } else { &n2_f  }).ok();
        ws.write_with_format(xr, 5, e,   if alt { &an4_f } else { &n4_f  }).ok();
        ws.write_with_format(xr, 6, pf,  if alt { &an4_f } else { &n4_f  }).ok();
        ws.write_with_format(xr, 7, hz,  if alt { &an2_f } else { &n2_f  }).ok();
        n += 1;
    }
    if n > 0 { ws.autofilter(0, 0, n as u32, (cols.len()-1) as u16).ok(); }

    wb.save(&path).map_err(|e| e.to_string())?;
    Ok(n)
}

// ─── Tauri Commands — License ─────────────────────────────────────────────────

/// Activate a license key.
///
/// Validates the cryptographic token, enforces the 1-hour TTL window, then
/// persists the computed expiry into SQLite. The next call to `get_auth_state`
/// will see the app as licensed.
#[tauri::command]
fn activate_license(
    key:          String,
    username:     String,
    project_name: String,
    db:           State<DbConnection>,
) -> Result<String, String> {
    // 1. Decode + decrypt the token
    let payload = decrypt_license_token(&key)?;

    // 2. Enforce the 1-hour activation window
    let now = now_secs();
    let age = now.saturating_sub(payload.created_at);
    if age > ACTIVATION_TTL_SECS {
        return Err(format!(
            "Activation token expired ({} minutes old — must be used within 60 minutes of generation).",
            age / 60
        ));
    }
    // Guard against tokens with a future created_at (clock skew / tampering)
    if payload.created_at > now + 300 {
        return Err("Activation token has a future timestamp. Check your system clock.".into());
    }

    // 3. Calculate the license expiry
    let expiry_date = (payload.created_at + payload.duration_days * 86_400) as i64;

    // 4. Persist to SQLite — replace any existing license
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM settings", [])
        .map_err(|e| format!("DB clear failed: {e}"))?;
    conn.execute(
        "INSERT INTO settings (username, project_name, expiry_date)
         VALUES (?1, ?2, ?3)",
        params![username.trim(), project_name.trim(), expiry_date],
    )
    .map_err(|e| format!("DB insert failed: {e}"))?;

    Ok(format!(
        "License activated for {}. Valid for {} days.",
        username.trim(),
        payload.duration_days
    ))
}

/// Check whether a valid, non-expired license is present.
///
/// Returns `{ valid: true, username, project_name, expiry_date }` if licensed,
/// or `{ valid: false }` if absent or expired.
#[tauri::command]
fn get_auth_state(db: State<DbConnection>) -> Result<AuthState, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let now  = now_secs() as i64;

    let result = conn.query_row(
        "SELECT username, project_name, expiry_date FROM settings LIMIT 1",
        [],
        |r| Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        )),
    );

    match result {
        Ok((username, project_name, expiry_date)) if now < expiry_date => {
            Ok(AuthState {
                valid: true,
                username:     Some(username),
                project_name: Some(project_name),
                expiry_date:  Some(expiry_date),
            })
        }
        _ => Ok(AuthState {
            valid:        false,
            username:     None,
            project_name: None,
            expiry_date:  None,
        }),
    }
}

// ─── Async Modbus Helpers ─────────────────────────────────────────────────────

async fn read_f32(
    ctx:  &mut tokio_modbus::client::Context,
    addr: u16,
    tag:  &str,
) -> Result<f32, String> {
    let regs = ctx
        .read_holding_registers(addr, 2)
        .await
        .map_err(|e| format!("{tag}: {e}"))?;
    if regs.len() < 2 {
        return Err(format!("{tag}: expected 2 regs, got {}", regs.len()));
    }
    Ok(regs_to_f32(&regs))
}

async fn poll_pm2220(
    ctx: &mut tokio_modbus::client::Context,
) -> Result<MeterReading, String> {
    let voltage      = read_f32(ctx, REG_VOLTAGE,      "Voltage").await?      as f64;
    let current      = read_f32(ctx, REG_CURRENT,      "Current").await?      as f64;
    let active_power = read_f32(ctx, REG_ACTIVE_POWER, "ActivePower").await?  as f64;
    let total_energy = read_f32(ctx, REG_TOTAL_ENERGY, "TotalEnergy").await?  as f64;

    let frequency = match read_f32(ctx, REG_FREQUENCY, "Frequency").await {
        Ok(f)  => f as f64,
        Err(_) => 50.0,
    };

    if !(50.0..=350.0).contains(&voltage) {
        return Err(format!("Voltage OOR: {voltage:.1} V"));
    }
    if !(0.0..=500.0).contains(&current) {
        return Err(format!("Current OOR: {current:.2} A"));
    }

    let apparent     = (voltage * current) / 1_000.0;
    let power_factor = if apparent > 0.01 {
        (active_power / apparent).clamp(0.0, 1.0)
    } else { 0.0 };

    Ok(MeterReading {
        voltage, current, active_power, total_energy,
        timestamp_ms: now_ms(), power_factor, frequency,
    })
}

// ─── Main Polling Loop ────────────────────────────────────────────────────────
//
// RULE: returns (). Zero `?` operators. All errors use explicit `match`.
// RULE: std::Mutex guards are NEVER held across an `.await` point.

async fn run_polling_loop(
    engine: Arc<Mutex<EngineState>>,
    db:     Arc<Mutex<Connection>>,
    app:    tauri::AppHandle,
) {
    let mut ctx: Option<tokio_modbus::client::Context> = None;
    let mut active_port = String::new();

    loop {
        // ── License gate — checked every tick, lock dropped before .await ──────
        if !is_license_valid(&db) {
            // Drop the ctx so the serial port is released while unlicensed
            if ctx.is_some() {
                ctx = None;
                active_port.clear();
                eprintln!("[engine] License invalid — port released");
            }
            sleep(Duration::from_secs(5)).await;
            continue;
        }

        // ── Snapshot engine state — lock dropped before any .await ────────────
        let (state, com_port) = {
            let e = engine.lock().unwrap();
            (e.poll.clone(), e.com_port.clone())
        };

        // ── STOPPED ───────────────────────────────────────────────────────────
        if state == PollState::Stopped {
            if ctx.is_some() {
                ctx = None;
                active_port.clear();
                eprintln!("[engine] Stopped — port released");
            }
            sleep(Duration::from_millis(250)).await;
            continue;
        }

        // ── FAULT: clear state and force a reconnect next tick ────────────────
        if state == PollState::Fault {
            ctx = None;
            active_port.clear();
            {
                let mut e = engine.lock().unwrap();
                e.poll = PollState::Running;
            }
            let _ = app.emit("status-changed", StatusEvent { state: PollState::Running });
            eprintln!("[engine] Fault cleared — will reconnect to {com_port}");
        }

        // ── CONNECT (or reconnect if port changed) ────────────────────────────
        if ctx.is_none() || com_port != active_port {
            ctx = None;
            active_port = com_port.clone();
            eprintln!("[engine] Opening {com_port} @ {BAUD_RATE} 8E1");

            let builder = tokio_serial::new(&com_port, BAUD_RATE)
                .parity(tokio_serial::Parity::Even)
                .stop_bits(tokio_serial::StopBits::One)
                .data_bits(tokio_serial::DataBits::Eight)
                .timeout(Duration::from_millis(PORT_TIMEOUT_MS));

            let serial = match SerialStream::open(&builder) {
                Ok(s)  => s,
                Err(e) => {
                    let r = format!("Cannot open {com_port}: {e}");
                    eprintln!("[engine] {r}");
                    emit_fault(&app, &engine, r);
                    sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };

            let new_ctx = match rtu::connect_slave(serial, Slave(SLAVE_ID)).await {
                Ok(c)  => c,
                Err(e) => {
                    let r = format!("Modbus connect failed on {com_port}: {e}");
                    eprintln!("[engine] {r}");
                    emit_fault(&app, &engine, r);
                    sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };

            ctx = Some(new_ctx);
            eprintln!("[engine] Connected to {com_port} slave {SLAVE_ID}");
        }

        // ── POLL ──────────────────────────────────────────────────────────────
        let reading_result = poll_pm2220(ctx.as_mut().unwrap()).await;

        match reading_result {
            Err(e) => {
                eprintln!("[engine] Poll error: {e}");
                ctx = None;
                emit_fault(&app, &engine, e);
                sleep(Duration::from_secs(1)).await;
                continue;
            }

            Ok(reading) => {
                // db Mutex held only for the INSERT, dropped before next .await
                {
                    let conn = db.lock().unwrap();
                    if let Err(e) = conn.execute(
                        "INSERT INTO meter_history
                            (timestamp,voltage,current,active_power,
                             total_energy,power_factor,frequency)
                         VALUES (?1,?2,?3,?4,?5,?6,?7)",
                        params![
                            wall_clock_iso(),
                            reading.voltage,    reading.current,
                            reading.active_power, reading.total_energy,
                            reading.power_factor, reading.frequency,
                        ],
                    ) { eprintln!("[db] {e}"); }
                } // ← MutexGuard dropped here, before the .await below

                let _ = app.emit("meter-data", &reading);
            }
        }

        sleep(Duration::from_secs(1)).await;
    }
}

// ─── Database Initialisation ──────────────────────────────────────────────────

fn init_database(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous  = NORMAL;

        -- Telemetry history (unchanged)
        CREATE TABLE IF NOT EXISTS meter_history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp    TEXT    NOT NULL,
            voltage      REAL    NOT NULL,
            current      REAL    NOT NULL,
            active_power REAL    NOT NULL,
            total_energy REAL    NOT NULL,
            power_factor REAL    NOT NULL,
            frequency    REAL    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_meter_history_timestamp
            ON meter_history (timestamp);

        -- License / settings (single-row table)
        CREATE TABLE IF NOT EXISTS settings (
            id           INTEGER PRIMARY KEY,
            username     TEXT    NOT NULL,
            project_name TEXT    NOT NULL,
            expiry_date  INTEGER NOT NULL   -- Unix timestamp (seconds)
        );
    ")
}

// ─── main ─────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // ── SQLite ────────────────────────────────────────────────────────
            let dir = app.path().app_local_data_dir()
                .expect("app data dir");
            std::fs::create_dir_all(&dir).expect("create dir");
            let db_path = dir.join("technidaq_local.db");
            eprintln!("[db] {}", db_path.display());
            let conn = Connection::open(&db_path).expect("open db");
            init_database(&conn).expect("init schema");

            let db     = Arc::new(Mutex::new(conn));
            let engine = Arc::new(Mutex::new(EngineState {
                poll:     PollState::Stopped,
                com_port: "COM3".into(),
            }));

            app.manage(DbConnection(Arc::clone(&db)));
            app.manage(SharedEngine(Arc::clone(&engine)));

            // ── System Tray ───────────────────────────────────────────────────
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
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => std::process::exit(0),
                    _      => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = ev {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ── Async polling loop on Tauri's Tokio runtime ───────────────────
            tauri::async_runtime::spawn(run_polling_loop(
                Arc::clone(&engine),
                Arc::clone(&db),
                app.handle().clone(),
            ));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            toggle_polling,
            get_status,
            clear_history,
            get_record_count,
            export_to_excel,
            activate_license,
            get_auth_state,
        ])
        .build(tauri::generate_context!())
        .expect("build failed")
        .run(|app, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } = event {
                if label == "main" {
                    api.prevent_close();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }
        });
}