// src/api.ts — Chameleon Bridge
//
// Routes backend calls through the Tauri IPC bridge when running as the
// desktop app, or through the Axum REST API when running in a browser
// (phone / tablet on the same intranet).
//
// All @tauri-apps/* imports are DYNAMIC so they are never parsed or executed
// when the bundle loads in a plain browser.  Static imports from those
// packages at the top of any file will crash a browser because the modules
// read window.__TAURI_INTERNALS__ during initialisation.

// ── Types-only static imports (erased at compile time, 100% safe) ─────────────
import type { UnlistenFn, EventCallback } from "@tauri-apps/api/event";

// ── Environment detection ──────────────────────────────────────────────────────
// typeof guard avoids a ReferenceError in SSR/Node; the value check avoids a
// false-positive if a browser quirk sets the property to undefined.
export const isTauri: boolean = (() => {
  try {
    return (
      typeof window !== "undefined" &&
      typeof (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] !==
        "undefined"
    );
  } catch {
    return false;
  }
})();

// ── Command bridge ─────────────────────────────────────────────────────────────
export async function invokeApi<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri) {
    // Dynamic import: Tauri module only loaded inside the native webview.
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  // Web path: relative URL → same origin → no hardcoded IP needed.
  const res = await fetch(`/api/${cmd}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args ?? {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Event bridge ───────────────────────────────────────────────────────────────
// In web mode: returns a no-op unlisten.
// Live meter events will require a WebSocket/SSE bridge (future work).
export async function listenApi<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  if (isTauri) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<T>(event, handler);
  }
  console.debug(`[api] listenApi("${event}") — no-op in web mode`);
  return () => {};
}

// Re-export types so callers don't need to import from @tauri-apps directly.
export type { UnlistenFn, EventCallback };
