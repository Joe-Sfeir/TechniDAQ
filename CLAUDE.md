# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**TechniDAQ** — A Tauri v2 desktop SCADA application for polling multiple Modbus RTU power meters over RS485, displaying live readings, logging to SQLite, and exporting to Excel. The product name is "TechniDAQ" (by Technicat Group); the repo folder is named `powermeter-demo`.

## Commands

### Development
```bash
npm run tauri dev       # Start dev server + Tauri window (hot-reload frontend, recompile Rust on change)
npm run dev             # Vite frontend only (no Tauri shell)
npm run build           # tsc + Vite build (frontend only)
npm run tauri build     # Full release build (produces installer in src-tauri/target/release/bundle/)
```

### License Key Generation
```bash
node generate_license.cjs --days 365 --username "John Doe" --project "Site Alpha" --meters "Schneider_PM2220,Socomec_Diris_A40"
node generate_license.cjs --days 365 --username "John Doe" --project "Site Alpha" --meters "All"
```
Keys expire 60 minutes after generation and must be delivered immediately.

## Architecture

### Stack
- **Frontend**: React 19 + TypeScript, Vite, Tailwind CSS v3, Recharts — all in `src/App.tsx` (single-file UI)
- **Backend**: Rust (Tauri v2) in `src-tauri/src/main.rs` (single-file backend)
- **IPC**: Tauri `invoke()` calls + `listen()` events

### Backend (`src-tauri/src/main.rs`)

Three `Arc<Mutex<_>>` shared-state objects managed as Tauri State:
- `SharedEngine` — poll state (`Running`/`Stopped`/`Fault`), COM port, configured devices list
- `DbConnection` — SQLite via rusqlite (WAL mode), stored in app local data dir as `technidaq_local.db`
- `ProfilesState` — in-memory meter profile library loaded from `profiles.json`

**Polling loop** (`run_polling_loop`) runs as a Tokio background task:
- ONE serial port opened for the entire RS485 bus; baud rate/parity taken from the first non-Custom device's profile
- `ctx.set_slave()` switches Modbus slave address between devices without reopening the port
- Wakes every `TICK_MS` (50 ms); polls each device when its `poll_rate_ms` interval has elapsed
- 25 ms RS485 turnaround delay between consecutive device polls
- On any fault: emits `meter-fault` and `status-changed` events, enters `Fault` state, auto-retries after 2 s

**Tauri commands** (invoked from frontend):
- `toggle_polling(com_port)` — starts/stops the polling loop
- `apply_bus_config(devices)` — validates and stores device configurations
- `get_meter_profiles(allowed_meters)` — returns license-filtered profiles; "Custom" always included
- `reload_profiles()` — hot-reloads `profiles.json` from disk at runtime
- `export_to_excel(path, target_device)` — writes `.xlsx` from `meter_history` table
- `activate_license(key, username, project_name)` — decrypts AES-256-GCM token, stores in `settings` table
- `get_auth_state()` — returns current license validity from DB
- `clear_history()`, `get_record_count()`

**Events emitted to frontend**:
- `meter-data` → `MeterReading { device_name, device_id, timestamp_ms, data: HashMap<String, f64> }`
- `meter-fault` → `FaultEvent { device_name, reason, timestamp_ms }`
- `status-changed` → `StatusEvent { state: PollState }`

**Database schema** (recreated fresh on every app start — no migrations):
```sql
meter_history (id, timestamp TEXT, device_name TEXT, device_id TEXT, data TEXT/JSON)
settings      (id, username, project_name, expiry_date INTEGER, allowed_meters TEXT/JSON)
```

**License system**: AES-256-GCM encrypted JWT-like tokens. `MASTER_KEY_HEX` is hardcoded identically in `main.rs` and `generate_license.cjs`. Tokens must be activated within 60 minutes of generation.

### Frontend (`src/App.tsx`)

Single large component file. Key state:
- `activeTab` — per-device tab index; each configured device gets its own tab
- `readings` — `Map<device_name, MeterReading>` (latest reading per device)
- `history` — `Map<device_name, MeterReading[]>` (rolling 60-point buffer for charts)
- `authState` — license validity; gates all configuration and polling controls
- `theme` — `"dark"` | `"light"`, persisted to `localStorage`

UI sections (tabs per device + fixed tabs): Dashboard live metrics grid, Recharts line chart, Configuration wizard (device slots with register selection), License activation panel, History/Export panel.

Design system: custom `CLR` token object + `glass()` helper for glassmorphism cards. Register cards are color-coded by measurement type (voltage=blue, current=amber, power=purple, energy=green, etc.) via `regPalette()`.

### Meter Profiles (`src-tauri/profiles.json`)

External JSON file — **not compiled into the binary**. Searched at runtime in order:
1. Same directory as the executable (production)
2. `src-tauri/profiles.json` (dev, from project root)
3. `profiles.json` in cwd

Each profile key (e.g. `"Schneider_PM2220"`) maps to `MeterProfileEntry` with endianness (`ABCD`/`CDAB`/`BADC`/`DCBA`), baud rate, parity, and register definitions. Profiles can be hot-reloaded via `reload_profiles` command without restarting the app.

Supported register data types: `Float32`, `UInt16`, `UInt32`, `INT16`, `INT32`.

### Window Behavior
Closing the main window hides it to the system tray (does not quit). Tray menu has "Open Dashboard" and "Quit TechniDAQ". Double-clicking the tray icon restores the window.