/**
 * Minimal ambient declarations for the Node builtins this package is
 * allowed to use (dependencies.md §4.1: backend → node:http, node:fs,
 * node:path, node:crypto), the `ws` package, and the globals the backend
 * uses (timers, process).
 *
 * Why this file exists: the workspace root has no `@types/node` and no
 * `@types/ws` (neither is a dependencies.md §7 pin — no new dependency is
 * permitted), and `tsconfig.base.json` sets `types: []`. This declaration
 * covers exactly the API surface the backend package calls; it is
 * typecheck-only (erased at build) and is not part of the public surface.
 * Runtime truth is Node v22 (docs/environment.md §1) + ws 8.21.3 (pinned);
 * any drift between these signatures and the real APIs is a typecheck
 * concern, not a contract concern.
 */

declare module 'node:http' {
  export interface IncomingMessage {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string | string[] | undefined>;
    on(event: 'data', cb: (chunk: Uint8Array) => void): this;
    on(event: 'end', cb: () => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
  }
  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: string | Uint8Array): void;
  }
  export interface Server {
    listen(port: number, host: string, cb?: () => void): this;
    close(cb?: () => void): this;
    on(event: 'request', cb: (req: IncomingMessage, res: ServerResponse) => void): this;
    on(event: 'upgrade', cb: (req: IncomingMessage, socket: unknown, head: Uint8Array) => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    once(event: 'error', cb: (err: Error) => void): this;
    off(event: 'error', cb: (err: Error) => void): this;
    address(): { port: number };
  }
  export function createServer(handler?: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number };
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function realpathSync(path: string): string;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function mkdirSync(path: string, options?: { mode?: number; recursive?: boolean }): void;
  // The workspace package's sources are typechecked inside this program
  // (import chain) — its node-ambient.d.ts is not in this program's
  // include set, so the surface it relies on is declared here too.
  export function openSync(path: string, flags: string): number;
  export function openSync(path: string, flags: string, mode: number): number;
  export function writeSync(fd: number, data: Uint8Array): number;
  export function writeSync(fd: number, data: Uint8Array, position: number): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function unlinkSync(path: string): void;
  export function rmdirSync(path: string): void;
  export function symlinkSync(target: string, path: string, type?: string): void;
  export function chmodSync(path: string, mode: number): void;
  /** Numeric flags (content-store: O_RDONLY|O_NOFOLLOW blob reads). */
  export function openSync(path: string, flags: number): number;
  /** Positional read for the O_NOFOLLOW blob read. */
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  /** Numeric open flags (`O_RDONLY`, `O_NOFOLLOW`). */
  export const constants: { readonly O_RDONLY: number; readonly O_NOFOLLOW: number };
  /** lstat (never follows a symlink) — the workspace artifact-path rules. */
  export function lstatSync(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtimeMs: number;
  };
  /** Filesystem space report (the workspace device-space quota). */
  export function statfsSync(path: string): { bavail: number | bigint; bsize: number | bigint };
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function normalize(p: string): string;
  export function dirname(p: string): string;
  export function basename(p: string): string;
  export function extname(p: string): string;
  export function isAbsolute(p: string): boolean;
  export function relative(from: string, to: string): string;
  export const sep: string;
}

declare module 'node:crypto' {
  export interface CreateHash {
    update(data: Uint8Array | string): CreateHash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): CreateHash;
  export function randomBytes(size: number): Uint8Array;
}

declare module 'node:os' {
  /** The OS temp directory (test data roots). */
  export function tmpdir(): string;
  /** Seconds since boot (workspace liveness start-time math). */
  export function uptime(): number;
}

declare module 'ws' {
  /**
   * A WebSocket connection (server-attached or client). Minimal surface:
   * the events and methods the backend and its integration tests use.
   */
  export class WebSocket {
    /** Client-side construction (integration tests). */
    constructor(address: string, options?: unknown);
    on(event: 'open', cb: () => void): this;
    on(event: 'message', cb: (data: Uint8Array, isBinary: boolean) => void): this;
    on(event: 'close', cb: (code: number, reason: Uint8Array) => void): this;
    on(event: 'error', cb: (err: Error) => void): this;
    on(event: 'unexpected-response', cb: (req: unknown, res: unknown) => void): this;
    once(event: 'open' | 'message' | 'close' | 'error' | 'unexpected-response', cb: (...args: never[]) => void): this;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    /** 0 connecting, 1 open, 2 closing, 3 closed. */
    readonly readyState: number;
    static readonly OPEN: number;
    static readonly CLOSED: number;
  }
  /** Server side: `noServer: true` + manual `handleUpgrade` per connection. */
  export class WebSocketServer {
    constructor(options: { noServer?: boolean });
    handleUpgrade(req: unknown, socket: unknown, head: Uint8Array, cb: (ws: WebSocket) => void): void;
    close(cb?: () => void): void;
  }
}

/** The Node process global. */
declare const process: {
  readonly pid: number;
  cwd(): string;
  readonly env: Record<string, string | undefined>;
  readonly exitCode: number;
  /** The process entry uses it after a clean close (never inside the library). */
  exit(code?: number): never;
  readonly stderr: { write(s: string): void };
  /** Seconds this process has been running (workspace liveness, test side). */
  uptime(): number;
  on(event: 'exit' | 'SIGINT' | 'SIGTERM', cb: (code: number | string) => void): void;
};

