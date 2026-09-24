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

/** Parse an HTTP response body (JSON when possible; a bounded error otherwise). */
async function readResponse(res: { status: number; text(): Promise<string> }): Promise<BackendResponse> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? null : JSON.parse(text);
  } catch {
    parsed = { ok: false, error: { code: 'invalid_request', cls: 'internal', message: `non-JSON backend response (status ${res.status})`, raw: text.slice(0, 512) } };
  }
  return { status: res.status, body: parsed };
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

  /** Which registered folder project a server path belongs to (the backend walks up to thirdlight.json). */
  resolveFolder(path: string): Promise<BackendResponse> {
    return this.request('GET', `/api/v1/projects/resolve?path=${encodeURIComponent(path)}`);
  }

  /** GET the project's recent problems (bounded). */
  problems(projectId: string): Promise<BackendResponse> {
    return this.request('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/problems`);
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

  /**
   * POST the bounded input-exercise relay (sessions.md §18.1): a step-indexed
   * semantic action sequence applied in exclusive test-input mode. With no
   * connected browser the backend returns the structured `session_unavailable`.
   */
  inputRelay(projectId: string, playSessionId: string, body: Record<string, unknown>): Promise<BackendResponse> {
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/play/${encodeURIComponent(playSessionId)}/input`, body);
  }

  /**
   * POST the bounded §20 control relay (sessions.md §20.1) to an explicitly
   * presented play session. With no connected/presenting browser the backend
   * returns its structured `session_unavailable` — never a fabricated success.
   */
  gameControl(projectId: string, playSessionId: string, body: Record<string, unknown>): Promise<BackendResponse> {
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/play/${encodeURIComponent(playSessionId)}/control`, body);
  }

  /** POST the bounded §20 observation relay (body: `{ timeoutMs? }`). */
  gameObserve(projectId: string, playSessionId: string, body: Record<string, unknown>): Promise<BackendResponse> {
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/play/${encodeURIComponent(playSessionId)}/observe`, body);
  }

  // ---- packet 25 content services (the same /api/v1 surface) --------------

  /** POST create a bounded upload stage (the stage id is server-allocated). */
  createStage(projectId: string, body: Record<string, unknown> = {}): Promise<BackendResponse> {
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/content/stages`, body);
  }

  /** PUT one bounded upload frame (raw bytes; `X-Thirdlight-Offset`/`-Total`). */
  async uploadFrame(projectId: string, stageId: string, offset: number, declaredTotal: number, bytes: Uint8Array): Promise<BackendResponse> {
    const url = `${this.origin}/api/v1/projects/${encodeURIComponent(projectId)}/content/stages/${encodeURIComponent(stageId)}/bytes`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/octet-stream',
          'x-thirdlight-offset': String(offset),
          'x-thirdlight-total': String(declaredTotal),
        },
        body: bytes as unknown as BodyInit,
        signal: controller.signal,
      });
      return await readResponse(res);
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST inspect a staged source (bounded import proposal). `body` may carry
   *  the packet-48 additive `{ kind?, animation? }` request. */
  inspectStage(projectId: string, stageId: string, body: Record<string, unknown> = {}): Promise<BackendResponse> {
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/content/stages/${encodeURIComponent(stageId)}/inspect`, body);
  }

  /** GET one folder of the game folder (subfolders and importable files). */
  listProjectFiles(projectId: string, dir: string): Promise<BackendResponse> {
    const q = dir === '' ? '' : `?${new URLSearchParams({ dir }).toString()}`;
    return this.request('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/content/project-files${q}`);
  }

  /** POST inspect a file already in the game folder, in place (`{ path, displayName?, kind?, animation? }`). */
  inspectProjectFile(projectId: string, body: Record<string, unknown>): Promise<BackendResponse> {
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/content/project-files/inspect`, body);
  }

  /** Phase 12 (c): POST publish an instance-set buffer (`{ transforms }` or `{ stageId }`). */
  publishInstanceBuffer(projectId: string, body: Record<string, unknown>): Promise<BackendResponse> {
    return this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/content/buffers`, body);
  }

  /**
   * Phase 15.2: GET an instance-set buffer's bytes (the copies' transforms, 10
   * little-endian float32 each), or the backend's error. Bounded by the
   * buffer cap (65536 copies = 2.5 MiB).
   */
  async readInstanceBuffer(projectId: string, digest: string): Promise<{ ok: true; floats: Float32Array } | { ok: false; response: BackendResponse }> {
    const url = `${this.origin}/api/v1/projects/${encodeURIComponent(projectId)}/content/buffers/${encodeURIComponent(digest)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${this.token}` }, signal: controller.signal });
      if (!res.ok) return { ok: false, response: await readResponse(res) };
      const bytes = new Uint8Array(await res.arrayBuffer());
      const floats = new Float32Array(bytes.byteLength >> 2);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < floats.length; i += 1) floats[i] = view.getFloat32(i * 4, true);
      return { ok: true, floats };
    } finally {
      clearTimeout(timer);
    }
  }

  /** DELETE a stage (non-authoritative cleanup). */
  discardStage(projectId: string, stageId: string): Promise<BackendResponse> {
    return this.request('DELETE', `/api/v1/projects/${encodeURIComponent(projectId)}/content/stages/${encodeURIComponent(stageId)}`);
  }

  /** GET the bounded asset catalog page. */
  listAssets(projectId: string, limit?: number, offset?: number): Promise<BackendResponse> {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set('limit', String(limit));
    if (offset !== undefined) qs.set('offset', String(offset));
    const q = qs.toString();
    return this.request('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/content/assets${q.length > 0 ? `?${q}` : ''}`);
  }

  /** GET one asset record with its versions (never bytes). */
  contentAsset(projectId: string, assetId: string): Promise<BackendResponse> {
    return this.request('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/content/assets/${encodeURIComponent(assetId)}`);
  }

  /** GET the bounded content integrity report. */
  contentIntegrity(projectId: string): Promise<BackendResponse> {
    return this.request('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/content/integrity`);
  }

  /** GET one bounded content job (job_not_found / job_expired). */
  contentJob(projectId: string, jobId: string): Promise<BackendResponse> {
    return this.request('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/content/jobs/${encodeURIComponent(jobId)}`);
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