/**
 * Packet 36 — the exporter's shared public types (extracted from `export.ts`
 * so the M2 pipeline modules and the injected-IO helpers can reference them
 * without an import cycle; `export.ts` re-exports both names unchanged, so the
 * package's public surface is identical).
 */
import type { WorkspaceService } from '@thirdlight/workspace';

import type { ContentClosureCompilerPort } from './content-closure';

/**
 * The injected IO facade (export.md §2 dependency-injection style — the
 * backend supplies it from its allowed `node:fs`/`node:path` edges). The
 * exporter never imports Node builtins itself.
 */
export interface ExportFs {
  join(...parts: string[]): string;
  realpath(p: string): string;
  isDirectory(p: string): boolean;
  exists(p: string): boolean;
  /** Recursive mkdir (node:fs.mkdirSync `{ recursive: true }`). */
  mkdir(p: string): void;
  write(p: string, data: Uint8Array): void;
  rename(from: string, to: string): void;
  /** Recursive, force (node:fs.rmSync). */
  rm(p: string): void;
  /** node:fs.mkdtempSync (prefix must end in `-`). */
  mkdtemp(prefix: string): string;
  read(p: string): Uint8Array;
}

export interface ExportContext {
  projectId: string;
  /**
   * The injected workspace service (types-only edge — the exporter never
   * constructs one; the backend passes its instance, export.md §2).
   */
  service: WorkspaceService;
  /** The injected IO facade (see `ExportFs`). */
  fs: ExportFs;
  /** The configured export root (sessions.md §13.7; `<exportRoot>`). */
  exportRoot: string;
  /** The engine repository tree (a forbidden export target). */
  repoRoot: string;
  /** The workspace data root (the authoring tree — a forbidden target). */
  authoringRoot: string;
  /** a — the configured authoring origin (scan pattern). */
  authoringOrigin: string;
  /** b — the configured preview origin (scan pattern). */
  previewOrigin: string;
  /** i — the configured admin/authoring token VALUES (scan pattern). */
  tokenValues: readonly string[];
  /** Absolute path of the export bundle entry (packages/exporter/src/export-bootstrap.ts). */
  bootstrapEntry: string;
  /** Absolute path of the installed three package.json (the §5.4.1 identity). */
  threePackageJson: string;
  /** Absolute path of the installed typescript package.json (meta.json dependencies). */
  typescriptPackageJson: string;
  /** Absolute path of the workspace lockfile (the recorded registry integrity). */
  lockfile: string;
  /**
   * Packet 36 — the M2 export bundle entry
   * (`packages/exporter/src/export-bootstrap-m2.ts`). Required for an M2
   * export; an M1 (schemaVersion 1 / storageVersion 1) export uses
   * `bootstrapEntry` unchanged.
   */
  m2BootstrapEntry?: string;
  /**
   * Packet 58 — the M3 export bundle entry
   * (`packages/exporter/src/export-bootstrap-m3.ts`). Required for an M3
   * (schemaVersion 3 / storageVersion 3) export; the M2 bootstrap is
   * byte-stable and untouched.
   */
  m3BootstrapEntry?: string;
  /**
   * Packet 36 — the injected packet-33 behavior compiler (the shared
   * `behavior-build` instance the backend also uses for play). Required for an
   * M2 export (the M2 bundle statically links the compiled outputs).
   */
  compiler?: ContentClosureCompilerPort;
  /**
   * Packet 36 — the injectable wall clock (milliseconds since the epoch) used
   * for the M2 manifest `capturedAt` and `meta.json.exportedAt`. Defaults to
   * `Date.now`. A fixed clock makes two exports of the same captured state
   * byte-identical except `exportedAt` (export.md §7); the backend passes no
   * clock, so a real export records the real capture second.
   */
  now?: () => number;
}
