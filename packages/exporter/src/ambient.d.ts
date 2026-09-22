/**
 * Ambient declarations for the Node builtins referenced by the SOURCE of
 * the packages this package's program typechecks (types-only
 * `@thirdlight/workspace` edge — tsc compiles the workspace's source for its
 * types: node:fs, node:path, node:crypto, node:os + the `process` global).
 *
 * The exporter's OWN source imports no Node builtins (dependencies.md §4.1:
 * `node: []`) — all of its I/O goes through the injected `ExportFs` facade.
 * This file exists because the workspace root has no `@types/node` (not a
 * dependencies.md §7 pin) and `tsconfig.base.json` sets `types: []`. It
 * mirrors packages/workspace/src/node-ambient.d.ts; it is typecheck-only
 * (erased at build) and is not part of the public surface.
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
  /** Create a directory symlink (R7 regression tests: symlink escapes). */
  export function symlinkSync(target: string, path: string, type?: string): void;
  export function readdirSync(path: string): string[];
  /** Whole-file read (Buffer is a Uint8Array). */
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  /** Whole-file write (src tests: corrupt/simulate foreign bytes). */
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function statSync(path: string): {
    isDirectory(): boolean;
    isFile(): boolean;
    size: number;
    mtimeMs: number;
  };
  /** Canonical path (resolves symlinks) — the symlink-escape check. */
  export function realpathSync(path: string): string;
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
  /**
   * Seconds this process has been running (test-side use only: the
   * L1 clock-window guard in the E2 seam tests needs the process
   * start time — the liveness pid-reuse start-time comparison,
   * workspace.md §6.2, is group E3's (R8) to fix in the source path;
   * the test side avoids the window using the process clock).
   */
  uptime(): number;
};
/**
 * Packet 36 — the per-snapshot virtual bundle modules the export build
 * generates in memory (`export-bundle.ts`, esbuild plugin namespaces). They
 * exist only inside the M2 export bundle build; the declarations keep
 * `tsc --noEmit` able to typecheck the bootstrap source. The bundle graph
 * check allows exactly these two specifiers plus the
 * `thirdlight/behavior-output:<behaviorId>` namespace.
 */
declare module 'thirdlight:export-artifacts' {
  /** The manifest-declared asset artifact paths (relative to the output root). */
  export const assetPaths: readonly string[];
  /** The single relative reader for one declared asset path (null when undeclared). */
  export function readAsset(path: string, signal: AbortSignal | undefined): Promise<Response> | null;
}

declare module 'thirdlight:export-behaviors' {
  /** The statically linked compiled behavior outputs of this snapshot. */
  export const behaviors: readonly {
    behaviorId: string;
    declaration: unknown;
    artifact: {
      behaviorId: string;
      sourceDigest: string;
      manifestDigest: string;
      outputDigest: string;
      ownedTransforms: readonly string[];
      requiredModules: readonly string[];
    };
    namespace: unknown;
  }[];
}
