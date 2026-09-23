/**
 * Backend-wide helpers shared by createBackend and its route modules: ids,
 * bounds, byte lengths, MIME types.
 */
import { randomBytes } from 'node:crypto';

// ---- ID / token allocation (sessions.md §3: hex, CSPRNG) ----------------------

/** Lowercase hex of a byte string (Uint8Array has no `toString('hex')`). */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}
export function hex(n: number): string {
  return toHex(randomBytes(n));
}
export const newConnId = (): string => `conn-${hex(16)}`;
export const newPlaySessionId = (): string => `play-${hex(16)}`;
export const newWsToken = (): string => hex(32);
export const newRelayId = (): string => `relay-${hex(16)}`;

/** The commands.md §3 origin (structural local type — the backend's edge
 * table has no commands edge; the envelope is pipeline-validated). */
export interface OriginDoc {
  kind: 'browser' | 'mcp' | 'admin';
  clientId: string;
}

// ---- bounds (sessions.md §11.5) ------------------------------------------------

/** §11.5: HTTP body bound (in). */
export const MAX_HTTP_BODY = 1024 * 1024;
/** §11.5: diagnostics relay payload bound. */
export const MAX_DIAGNOSTICS = 16 * 1024;
/** §11.5: screenshot image bound (the dataUrl length, in bytes). */
export const MAX_SCREENSHOT = 1024 * 1024;

export const TEXT_ENCODER = new TextEncoder();
/** UTF-8 byte length of a string (no `Buffer` dependency). */
export function utf8Len(s: string): number {
  return TEXT_ENCODER.encode(s).length;
}
/** §11.4: the session listing bound. */
export const SESSION_LIST_MAX = 20;
/** The bounded startup log ring. */
export const STARTUP_LOG_RING = 256;

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

