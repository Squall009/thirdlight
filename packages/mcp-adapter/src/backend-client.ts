/**
 * The MCP adapter's client to the backend's authoring HTTP API (the SAME
 * `/api/v1` surface the browser uses — decision 0001 §5: "MCP is a client of
 * the same command services — never a second source of truth").
 *
 * Pure Node (dependencies.md §4.3: `mcp-adapter` node: []) — uses the global
 * `fetch` (a Web global, not a Node builtin import) and the global `crypto`
 * (Web Crypto) for `requestId` generation. No `node:` imports.
 *
 * Every method returns the parsed JSON body of the backend response. Errors
 * are NOT thrown: the backend's structured `{ ok:false, error }` bodies are
 * returned as-is so the tool layer can surface them with their codes and
 * fields (revision, currentRevision, session IDs).
 */

export interface BackendClientOptions {
  /** The backend authoring origin, e.g. `http://127.0.0.1:8501` (no trailing slash). */
  readonly authoringOrigin: string;
  /** A project-scoped `authoring:<projectId>` (or `admin`) bearer token. */
  readonly token: string;
  /** Bounded optional timeout for a single request (ms). */
  readonly timeoutMs?: number;
}

export interface BackendResponse {
  readonly status: number;
  readonly body: unknown;
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/**
 * A narrow HTTP client bound to one backend origin + token. All methods hit
 * the authoring-origin routes documented in sessions.md §6–§12.
 */
export class BackendClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(opts: BackendClientOptions) {
    if (typeof opts.authoringOrigin !== 'string' || opts.authoringOrigin.length === 0) {
      throw new Error('authoringOrigin is required');
    }
    if (typeof opts.token !== 'string' || opts.token.length === 0) {
      throw new Error('token is required');
    }
    this.origin = trimOrigin(opts.authoringOrigin);
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request(method: string, path: string, body?: unknown): Promise<BackendResponse> {
    const url = `${this.origin}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text.length === 0 ? null : JSON.parse(text);
      } catch {
        // A non-JSON body (e.g. a static fallback) is returned verbatim, bounded.
        parsed = { ok: false, error: { code: 'invalid_request', cls: 'internal', message: `non-JSON backend response (status ${res.status})`, raw: text.slice(0, 512) } };
      }
      return { status: res.status, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST a commands.md envelope (mutation or query) to the project. The
   *  envelope body carries `projectId` (the backend resolves the project from
   *  the body, not the URL), so it is set here for every command. */
  command(projectId: string, envelope: Record<string, unknown>): Promise<BackendResponse> {
    const body: Record<string, unknown> = { ...envelope, projectId };
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/commands`, body);
  }

  /** GET the (bounded) session list, optionally filtered to one project. */
  listSessions(projectId?: string): Promise<BackendResponse> {
    const q = projectId !== undefined ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return this.request('GET', `/api/v1/sessions${q}`);
  }

  /** POST start a play session for the project (body: `{ options?: { demo? } }`). */
  startPlay(projectId: string, body: Record<string, unknown>): Promise<BackendResponse> {
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/play`, body);
  }

  /** POST stop an active play session. */
  stopPlay(projectId: string, playSessionId: string): Promise<BackendResponse> {
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/play/${encodeURIComponent(playSessionId)}/stop`, {});
  }

  /** POST capture a bounded screenshot from the play session's connected preview. */
  screenshot(projectId: string, playSessionId: string, maxWidth?: number): Promise<BackendResponse> {
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/play/${encodeURIComponent(playSessionId)}/screenshot`, {
      ...(maxWidth !== undefined ? { maxWidth } : {}),
    });
  }

  /** POST fetch bounded runtime diagnostics from the play session's connected preview. */
  diagnostics(projectId: string, playSessionId: string): Promise<BackendResponse> {
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/play/${encodeURIComponent(playSessionId)}/diagnostics`, {});
  }
}

/**
 * Generate a `requestId` (`req-` + 32 hex, commands.md §3) from Web Crypto
 * (the global `crypto`, not a Node builtin). Falls back to a non-CSPRNG
 * source only if Web Crypto is unavailable (still 128 random bits).
 */
export function makeRequestId(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj: { getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined =
    (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `req-${hex}`;
}