// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegisterEntry {
  name: string; address: number; length: number;
  data_type: string; multiplier: number;
  min_alarm?: number; max_alarm?: number;
}
export interface MeterProfile {
  model: string; display_name: string; endianness: string;
  baud_rate: number; parity: string; registers: RegisterEntry[];
}
export interface DeviceConfig {
  device_name: string; meter_model: string; slave_id: number;
  poll_rate_ms: number; selected_registers: RegisterEntry[];
  alarm_trigger_cycles: number;
  protocol:   "rtu" | "tcp";
  com_port:   string;
  baud_rate:  number;
  ip_address: string;
  tcp_port:   number;
}
export interface MeterReading {
  device_name: string; device_id: string;
  timestamp_ms: number; data: Record<string, number>;
}
export interface FaultEvent  { device_name: string; reason: string; timestamp_ms: number }
export interface StatusEvent { state: PollState }
export interface AuthState {
  valid: boolean; username?: string; project_name?: string;
  expiry_date?: number; allowed_meters: string[];
  mode?:              "offline" | "online";
  tier?:              1 | 2 | 3;
  protocols?:         "RTU" | "TCP" | "All";
  cloud_registered?:  boolean;
}
export interface DiagEvent   { direction: string; hex: string; device_name: string; timestamp_ms: number; }
export interface BuildInfo   { is_cloud_build: boolean; cloud_url: string; }
export interface OnlineAuthState {
  valid:           boolean;
  machine_id:      string;
  machine_api_key: string;
  project_id:      number;
  project_name:    string;
  tier:            number;
  allowed_meters:  string[];
  protocols:       string;
  expires_at:      string;
  node_name:       string;
  cloud_url:       string;
}

export type PollState    = "running" | "stopped" | "fault";
export type Theme        = "dark"   | "light";
export type ExportStatus = "idle"   | "saving"  | "success" | "error";
export type ChartPoint = Record<string, string|number>;
export type ViewMode = "chart" | "grid";
