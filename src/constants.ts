import type { DeviceConfig } from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_HISTORY = 60;
export const COM_PORTS   = ["COM1","COM2","COM3","COM4","COM5","COM6","COM7",
                     "COM8","COM9","COM10","COM11","COM12"];
export const DATA_TYPES  = ["Float32","UInt16","UInt32","INT16","INT32"];

export const DEFAULT_DEVICE = (): DeviceConfig => ({
  device_name:"", meter_model:"", slave_id:1, poll_rate_ms:1000, selected_registers:[], alarm_trigger_cycles:5,
  protocol:"rtu", com_port:"COM3", baud_rate:9600, ip_address:"", tcp_port:502,
});
