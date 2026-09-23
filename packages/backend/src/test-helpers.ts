/**
 * Shared helpers for the backend integration tests: an ephemeral-backend
 * factory (disposable data root + static dirs), a `ws` client wrapper with
 * message queuing, and ID allocators matching the sessions.md §3 syntaxes.
 */
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import type { Backend } from './backend';
import { createTestBackend } from './testing';

export function hex(n: number): string {
  let out = '';
  const b = randomBytes(n);
  for (let i = 0; i < b.length; i += 1) out += (b[i] ?? 0).toString(16).padStart(2, '0');
  return out;
}

/** sessions.md §3 syntaxes (client/server generators for tests). */
export const mkSessionId = (): string => `sess-${hex(16)}`;
export const mkRequestId = (): string => `req-${hex(16)}`;
export const mkNonce = (): string => hex(8);

/** The test deployment's origins (the allowlist entry is fixed). */
export const AUTHORING_ORIGIN = 'http://127.0.0.1:8501';
export const PREVIEW_ORIGIN = 'http://127.0.0.1:8502';

export interface TestBackend {
  backend: Backend;
  root: string;
  teardown: () => Promise<void>;
  /** Authoring base URL (http) with the real bound port. */
  authUrl: string;
  /** Preview base URL with the real bound port. */
  prevUrl: string;
  /** The project-scoped authoring token. */
  authToken: string;
  /** The admin token. */
  adminToken: string;
}

export interface BackendTestOptions {
  timeouts?: Record<string, number>;
  /** Extra tokens. */
  tokens?: Array<{ token: string; scope: string }>;
  /** The project id the default authoring token is bound to. */
  projectId?: string;
}

/** Start an ephemeral backend with a demo project already created. */
export async function startBackend(opts: BackendTestOptions = {}): Promise<TestBackend> {
  const projectId = opts.projectId ?? 'demo-0001';
  const authToken = `auth-${hex(8)}`;
  const adminToken = `admin-${hex(8)}`;
  const t = await createTestBackend({
    dataRoot: undefined,
    authoringOrigin: AUTHORING_ORIGIN,
    previewOrigin: PREVIEW_ORIGIN,
    authoringOrigins: [AUTHORING_ORIGIN],
    tokens: [
      { token: authToken, scope: `authoring:${projectId}` },
      { token: adminToken, scope: 'admin' },
      ...(opts.tokens ?? []),
    ],
    timeouts: opts.timeouts,
  });
  t.backend._test.service.createProject(projectId, 'Demo');
  const tb: TestBackend = {
    backend: t.backend,
    root: t.root,
    teardown: t.teardown,
    authUrl: `http://127.0.0.1:${t.backend.portAuthoring}`,
    prevUrl: `http://127.0.0.1:${t.backend.portPreview}`,
    authToken,
    adminToken,
  };
  return tb;
}

/** A `ws` client with a queued inbox + predicate waiting. */
export interface TestWs {
  ws: WebSocket;
  close(code?: number, reason?: string): void;
  send(obj: unknown): void;
  /** Wait for the first message matching `pred` (rejects after `timeoutMs`, or on socket close). */
  waitFor(pred: (m: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
  /** Wait for the next `close` event; resolves `{ code, reason }`. */
  closed: Promise<{ code: number; reason: string }>;
}

export function connectWs(url: string, headers: Record<string, string> = {}): Promise<TestWs> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const queue: unknown[] = [];
    const waiters: Array<{ pred: (m: unknown) => boolean; resolve: (m: unknown) => void; timer: number; reject: (e: Error) => void }> = [];
    let closeResolve: ((v: { code: number; reason: string }) => void) | undefined;
    let closedNow = false;
    const closed = new Promise<{ code: number; reason: string }>((r) => {
      closeResolve = r;
    });
    const failAllWaiters = (err: Error): void => {
      for (const w of waiters.splice(0, waiters.length)) {
        clearTimeout(w.timer);
        w.reject(err);
      }
    };
    const deliver = (m: unknown): void => {
      const idx = waiters.findIndex((w) => w.pred(m));
      if (idx !== -1) {
        const [w] = waiters.splice(idx, 1);
        if (w) {
          clearTimeout(w.timer);
          w.resolve(m);
        }
      } else {
        queue.push(m);
      }
    };
    ws.on('message', (data: Uint8Array) => {
      try {
        deliver(JSON.parse(new TextDecoder().decode(data)));
      } catch {
        deliver(data);
      }
    });
    ws.on('close', (code: number, reason: Uint8Array) => {
      closedNow = true;
      failAllWaiters(new Error('ws closed'));
      closeResolve?.({ code, reason: new TextDecoder().decode(reason ?? new Uint8Array(0)) });
    });
    ws.on('error', (err: Error) => {
      if (ws.readyState !== WebSocket.OPEN) reject(err);
    });
    ws.on('open', () => {
      resolve({
        ws,
        closed,
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            // already closing
          }
        },
        send: (obj) => ws.send(JSON.stringify(obj)),
        waitFor: (pred, timeoutMs = 5000) =>
          new Promise<unknown>((res, rej) => {
            if (closedNow) {
              rej(new Error('ws already closed'));
              return;
            }
            const qi = queue.findIndex(pred);
            if (qi !== -1) {
              res(queue.splice(qi, 1)[0]);
              return;
            }
            const timer = setTimeout(() => {
              const wi = waiters.findIndex((w) => w.resolve === res);
              if (wi !== -1) waiters.splice(wi, 1);
              rej(new Error(`timeout waiting for message: ${JSON.stringify(pred)}`));
            }, timeoutMs);
            waiters.push({ pred, resolve: res, timer, reject: rej });
          }),
      });
    });
  });
}

/** An `fetch` wrapper: the browser-like caller (Origin + bearer headers). */
export async function api(
  url: string,
  init: { method?: string; body?: unknown; token?: string; origin?: string | null },
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  // `origin: null` means "send no Origin header" (non-browser caller).
  if (init.origin !== null) headers.origin = init.origin ?? AUTHORING_ORIGIN;
  const res = await fetch(url, {
    method: init.method ?? 'POST',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length === 0 ? null : JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** Establish an authoring session (returns the result fields). */
export async function establish(
  tb: TestBackend,
  sessionId: string,
  origin: string | null = AUTHORING_ORIGIN,
): Promise<{ status: number; sessionId: string; connId: string; wsToken: string; revision: number }> {
  const r = await api(`${tb.authUrl}/api/v1/sessions`, {
    body: { projectId: 'demo-0001', sessionId, clientInfo: { kind: 'browser', label: 'test' } },
    token: tb.authToken,
    origin,
  });
  const j = r.json as Record<string, unknown>;
  if (r.status !== 200 || j.ok !== true) {
    throw new Error(`establish failed: ${r.status} ${JSON.stringify(j)}`);
  }
  return {
    status: r.status,
    sessionId: j.sessionId as string,
    connId: j.connId as string,
    wsToken: j.wsToken as string,
    revision: j.revision as number,
  };
}

/** Upgrade the WS channel for an established session. */
export function upgrade(tb: TestBackend, sessionId: string, wsToken: string, origin?: string | null): Promise<TestWs> {
  const q = new URLSearchParams({ sessionId, wsToken }).toString();
  const headers: Record<string, string> = {};
  if (origin !== null) headers.Origin = origin ?? AUTHORING_ORIGIN;
  return connectWs(`${tb.authUrl.replace(/^http/, 'ws')}/api/v1/ws?${q}`, headers);
}

/** A small sleep (tests run on the real clock with shortened timeouts). */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));