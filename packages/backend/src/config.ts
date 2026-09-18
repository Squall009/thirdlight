/**
 * Backend configuration — sessions.md §13.7 (normative shape; packet 09
 * implements) + the owner-issued token store (§4.1: tokens are issued by
 * the owner's deployment — no issuance/refresh endpoint, §14) + a
 * test-only timeouts seam (§11.5 constants stand in production; the
 * m1-acceptance test-config allowance).
 */
import { sessionError } from '@thirdlight/protocol';
import type { SessionError } from '@thirdlight/protocol';

/** §11.5 M1 constants (normative) — the production defaults. */
export const DEFAULT_TIMEOUTS = {
  wsTokenTtlSeconds: 60,
  silentDropSeconds: 60,
  presentTimeoutSeconds: 15,
  inactivityTtlSeconds: 30 * 60,
  relayTimeoutSeconds: 10,
  stopAckTimeoutSeconds: 5,
  protocolErrorWindowSeconds: 60,
  protocolErrorLimit: 10,
} as const;

export type BackendTimeouts = typeof DEFAULT_TIMEOUTS;

export interface BackendTokenEntry {
  /** The bearer token value (owner-issued). */
  token: string;
  /** `authoring:<projectId>` or `admin` (§4.1). */
  scope: string;
}

export interface BackendConfig {
  dataRoot: string;
  backendId?: string;
  processMarker?: string;
  authoringOrigin: string;
  previewOrigin: string;
  authoringBind: string;
  previewBind: string;
  authoringOrigins: string[];
  editorStaticDir: string;
  previewStaticDir: string;
  exportRoot?: string;
  /**
   * Optional. The engine installation root (the repository/install tree that
   * holds `packages/` + `node_modules/`). Used ONLY by the export route
   * (export.md §3 step 3 containment + §5.4.1 identity/reference paths).
   * Proposed sessions.md §13.7 contract diff (packet 12 handoff) — additive,
   * optional; without it the export route reports `unavailable`.
   */
  engineRoot?: string;
  tokens: BackendTokenEntry[];
  /** Test-only seam (§11.5 constants stand in production). */
  timeouts?: Partial<BackendTimeouts>;
}

/** A strict origin string: scheme + host (+ port), no trailing slash. */
const ORIGIN_RE = /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/i;
const BIND_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/i;

export function parseBackendConfig(value: unknown):
  | { ok: true; config: BackendConfig }
  | { ok: false; error: SessionError } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: sessionError('invalid_request', 'validation', 'backend config must be an object') };
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set([
    'dataRoot', 'backendId', 'processMarker',
    'authoringOrigin', 'previewOrigin', 'authoringBind', 'previewBind',
    'authoringOrigins', 'editorStaticDir', 'previewStaticDir', 'exportRoot',
    'engineRoot',
    'tokens', 'timeouts',
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      return { ok: false, error: sessionError('invalid_request', 'validation', `unknown config field "${k}"`, { path: `/${k}` }) };
    }
  }
  const str = (k: string, required: boolean): { v?: string; e?: SessionError } => {
    const v = obj[k];
    if (v === undefined) {
      if (required) return { e: sessionError('invalid_request', 'validation', `config field "${k}" is required`, { path: `/${k}` }) };
      return {};
    }
    if (typeof v !== 'string' || v.length === 0) {
      return { e: sessionError('field_type', 'validation', `config field "${k}" must be a non-empty string`, { path: `/${k}` }) };
    }
    return { v };
  };
  const dataRoot = str('dataRoot', true);
  if (dataRoot.e) return { ok: false, error: dataRoot.e };
  const backendId = str('backendId', false);
  if (backendId.e) return { ok: false, error: backendId.e };
  const processMarker = str('processMarker', false);
  if (processMarker.e) return { ok: false, error: processMarker.e };
  const authoringOrigin = str('authoringOrigin', true);
  if (authoringOrigin.e) return { ok: false, error: authoringOrigin.e };
  if (!ORIGIN_RE.test(authoringOrigin.v!)) {
    return { ok: false, error: sessionError('field_value', 'validation', 'authoringOrigin must be an exact origin (scheme + host + port, no trailing slash)', { path: '/authoringOrigin' }) };
  }
  const previewOrigin = str('previewOrigin', true);
  if (previewOrigin.e) return { ok: false, error: previewOrigin.e };
  if (!ORIGIN_RE.test(previewOrigin.v!)) {
    return { ok: false, error: sessionError('field_value', 'validation', 'previewOrigin must be an exact origin', { path: '/previewOrigin' }) };
  }
  const authoringBind = str('authoringBind', true);
  if (authoringBind.e) return { ok: false, error: authoringBind.e };
  if (!BIND_RE.test(authoringBind.v!)) {
    return { ok: false, error: sessionError('field_value', 'validation', 'authoringBind must be host:port', { path: '/authoringBind' }) };
  }
  const previewBind = str('previewBind', true);
  if (previewBind.e) return { ok: false, error: previewBind.e };
  if (!BIND_RE.test(previewBind.v!)) {
    return { ok: false, error: sessionError('field_value', 'validation', 'previewBind must be host:port', { path: '/previewBind' }) };
  }
  const editorStaticDir = str('editorStaticDir', true);
  if (editorStaticDir.e) return { ok: false, error: editorStaticDir.e };
  const previewStaticDir = str('previewStaticDir', true);
  if (previewStaticDir.e) return { ok: false, error: previewStaticDir.e };
  const exportRoot = str('exportRoot', false);
  if (exportRoot.e) return { ok: false, error: exportRoot.e };
  const engineRoot = str('engineRoot', false);
  if (engineRoot.e) return { ok: false, error: engineRoot.e };
  // authoringOrigins: non-empty exact allowlist, no wildcards (§4.2).
  const ao = obj.authoringOrigins;
  if (!Array.isArray(ao) || ao.length === 0) {
    return { ok: false, error: sessionError('field_value', 'validation', 'authoringOrigins must be a non-empty array of exact Origin strings', { path: '/authoringOrigins' }) };
  }
  for (const o of ao) {
    if (typeof o !== 'string' || !ORIGIN_RE.test(o) || o.includes('*')) {
      return { ok: false, error: sessionError('field_value', 'validation', 'authoringOrigins entries must be exact origin strings (no wildcards)', { path: '/authoringOrigins' }) };
    }
  }
  // tokens: non-empty, unique (token, scope) pairs; scopes per §4.1.
  const tokensRaw = obj.tokens as unknown[];
  if (!Array.isArray(tokensRaw) || tokensRaw.length === 0) {
    return { ok: false, error: sessionError('field_value', 'validation', 'tokens must be a non-empty array of { token, scope }', { path: '/tokens' }) };
  }
  const tokens: BackendTokenEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tokensRaw.length; i += 1) {
    const e = tokensRaw[i];
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      return { ok: false, error: sessionError('field_type', 'validation', 'token entry must be an object', { path: `/tokens/${i}` }) };
    }
    const rec = e as Record<string, unknown>;
    const token = rec.token;
    const scope = rec.scope;
    if (
      typeof token !== 'string' || token.length < 1 || token.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(token) ||
      typeof scope !== 'string' || (scope !== 'admin' && !scope.startsWith('authoring:'))
    ) {
      return {
        ok: false,
        error: sessionError('field_value', 'validation', 'token entry must be { token (1–256, no control chars), scope: "admin" | "authoring:<projectId>" }', { path: `/tokens/${i}` }),
      };
    }
    const entry: BackendTokenEntry = { token, scope };
    const key = `${entry.scope}\u0000${entry.token}`;
    if (seen.has(key)) {
      return { ok: false, error: sessionError('field_value', 'validation', 'duplicate token for the same scope', { path: `/tokens/${i}` }) };
    }
    seen.add(key);
    tokens.push(entry);
  }
  // timeouts: test-only seam — partial overrides, positive numbers.
  let timeouts: Partial<BackendTimeouts> = {};
  if (obj.timeouts !== undefined) {
    const to = obj.timeouts as Record<string, unknown>;
    if (typeof to !== 'object' || to === null || Array.isArray(to)) {
      return { ok: false, error: sessionError('field_type', 'validation', 'timeouts must be an object', { path: '/timeouts' }) };
    }
    for (const [k, v] of Object.entries(to)) {
      if (!(k in DEFAULT_TIMEOUTS)) {
        return { ok: false, error: sessionError('field_unexpected', 'validation', `unknown timeout "${k}"`, { path: `/timeouts/${k}` }) };
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        return { ok: false, error: sessionError('field_value', 'validation', `timeouts.${k} must be a positive number (seconds)`, { path: `/timeouts/${k}` }) };
      }
      (timeouts as Record<string, number>)[k] = v;
    }
  }
  const config: BackendConfig = {
    dataRoot: dataRoot.v!,
    authoringOrigin: authoringOrigin.v!,
    previewOrigin: previewOrigin.v!,
    authoringBind: authoringBind.v!,
    previewBind: previewBind.v!,
    authoringOrigins: [...ao] as string[],
    editorStaticDir: editorStaticDir.v!,
    previewStaticDir: previewStaticDir.v!,
    tokens,
  };
  if (backendId.v !== undefined) config.backendId = backendId.v;
  if (processMarker.v !== undefined) config.processMarker = processMarker.v;
  if (exportRoot.v !== undefined) config.exportRoot = exportRoot.v;
  if (engineRoot.v !== undefined) config.engineRoot = engineRoot.v;
  if (Object.keys(timeouts).length > 0) config.timeouts = timeouts;
  return { ok: true, config };
}

export function mergeTimeouts(overrides?: Partial<BackendTimeouts>): BackendTimeouts {
  return { ...DEFAULT_TIMEOUTS, ...overrides };
}