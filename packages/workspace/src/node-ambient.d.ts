/**
 * Minimal ambient declarations for the Node builtins this package is
 * allowed to use (dependencies.md §4.1: workspace → node:fs, node:path,
 * node:crypto, node:os) plus the `process` global.
 *
 * Why this file exists: the workspace root has no `@types/node` (it is not
 * a dependencies.md §7 pin — no new dependency is permitted), and
 * `tsconfig.base.json` sets `types: []`. This declaration covers exactly
 * the API surface the workspace package calls; it is typecheck-only
 * (erased at build) and is not part of the public surface (index.ts does
 * not re-export it). Runtime truth is Node v22 (docs/environment.md §1);
 * any drift between these signatures and Node's actual behavior is a
 * typecheck concern, not a contract concern.
 */

declare module 'node:fs' {
  /** O_RDONLY open for a directory flush (§5.1 step 4). */
  export function openSync(path: string, flags: string): number;
  /** O_WRONLY|O_CREAT|O_EXCL temp-file open (§5.1 step 1); mode 0644. */
  export function openSync(path: string, flags: string, mode: number): number;
  /** Returns the number of bytes written (may be < data.length — partial). */
  export function writeSync(fd: number, data: Uint8Array): number;
  export function writeSync(fd: number, data: Uint8Array, position: number): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function unlinkSync(path: string): void;
  export function mkdirSync(path: string, options?: { mode?: number; recursive?: boolean }): void;
  /** Remove an empty directory (test-root cleanup). */
  export function rmdirSync(path: string): void;
  /** Create a unique temporary directory (test data roots). */
  export function mkdtempSync(prefix: string): string;
  /** Remove a file tree (test-root cleanup). */
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  /** Cheap existence check (test assertions). */
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
  /** Whole-file read (Buffer is a Uint8Array). */
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  /** Whole-file write (src tests: corrupt/simulate foreign bytes). */
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function statSync(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
  };
  /** Canonical path (resolves symlinks) — the symlink-escape check. */
  export function realpathSync(path: string): string;
  export function chmodSync(path: string, mode: number): void;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function basename(p: string): string;
  export function dirname(p: string): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(p: string): boolean;
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
  /** Seconds since boot (liveness start-time math, workspace.md §6.2). */
  export function uptime(): number;
  /** The OS temp directory (test data roots). */
  export function tmpdir(): string;
}

/** The Node process global (pid for records and temp names). */
declare const process: {
  readonly pid: number;
};