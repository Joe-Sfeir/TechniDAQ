// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use rust_xlsxwriter::{Color, Format, FormatAlign, FormatBorder, Workbook};
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, RunEvent, State, WindowEvent,
};
use tokio::time::sleep;
use tokio_modbus::prelude::*;   // re-exports: rtu, Reader, Slave, …
use tokio_serial::SerialStream;

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

const SLAVE_ID:         u8  = 1;
const BAUD_RATE:        u32 = 19200;
const PORT_TIMEOUT_MS:  u64 = 500;

// ─── Byte-order: Schneider ABCD (big-endian words) ────────────────────────────
// regs[0] = high 16-bit word (bytes A, B)
// regs[1] = low  16-bit word (bytes C, D)

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

/// Emit status-changed + meter-fault without holding any Mutex.
/// Returns immediately; Tauri queues the events.
fn emit_fault(app: &tauri::AppHandle, engine: &Arc<Mutex<EngineState>>, reason: String) {
    {
        let mut eng = engine.lock().unwrap();
        if eng.poll != PollState::Stopped {
            eng.poll = PollState::Fault;
        }
    }
    let _ = app.emit("status-changed", StatusEvent { state: PollState::Fault });
    let _ = app.emit("meter-fault",    FaultEvent   { reason, timestamp_ms: now_ms() });
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

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

// ─── Async Modbus helpers ─────────────────────────────────────────────────────
//
// Both functions return Result<_, String> so they can use `?` freely.

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

    // Frequency optional — fall back to nominal if register not supported
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

// ─── Main polling loop ────────────────────────────────────────────────────────
//
// Runs on Tauri's Tokio runtime via async_runtime::spawn.
//
// RULE: `run_polling_loop` returns (). Therefore NO `?` operator is EVER
// used directly in this function. All fallible calls use explicit `match`.
// The only functions that use `?` are `read_f32` and `poll_pm2220`, which
// both return Result<_, String>.

async fn run_polling_loop(
    engine: Arc<Mutex<EngineState>>,
    db:     Arc<Mutex<Connection>>,
    app:    tauri::AppHandle,
) {
    let mut ctx: Option<tokio_modbus::client::Context> = None;
    let mut active_port = String::new();

    loop {
        // ── Snapshot state — lock dropped before any .await ───────────────────
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

            // 1. Open serial port
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

            // 2. Build Modbus RTU context
            //    rtu::connect_slave is async and returns io::Result<Context>
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
                ctx = None;            // force reconnect next iteration
                emit_fault(&app, &engine, e);
                sleep(Duration::from_secs(1)).await;
                continue;
            }

            Ok(reading) => {
                // db Mutex is held for the INSERT, then dropped before the next .await
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
                } // ← MutexGuard dropped here, well before the next .await

                let _ = app.emit("meter-data", &reading);
            }
        }

        sleep(Duration::from_secs(1)).await;
    }
}

// ─── Database initialisation ──────────────────────────────────────────────────

fn init_database(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous  = NORMAL;

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