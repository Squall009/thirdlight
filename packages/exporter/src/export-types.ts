/**
 * The exporter's shared public types (extracted from `export.ts`
 * so the pipeline modules and the injected-IO helpers can reference them
 * without an import cycle; `export.ts` re-exports both names unchanged, so the
 * package's public surface is identical).
 */
import type { WorkspaceService } from '@thirdlight/workspace';

import type { ContentClosureCompilerPort } from './content-closure';

/**
 * The injected IO facade (export.md dependency-injection style — the
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
   * constructs one; the backend passes its instance).
   */
  service: WorkspaceService;
  /** The injected IO facade (see `ExportFs`). */
  fs: ExportFs;
  /** The configured export root (`<exportRoot>`). */
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
  /** Absolute path of the installed three package.json (the recorded-exception identity). */
  threePackageJson: string;
  /** Absolute path of the installed typescript package.json (meta.json dependencies). */
  typescriptPackageJson: string;
  /** Absolute path of the workspace lockfile (the recorded registry integrity). */
  lockfile: string;
  /**
   * The export bundle entry
   * (`packages/exporter/src/export-bootstrap-m3.ts`).
   */
  m3BootstrapEntry: string;
  /**
   * The injected behavior compiler (the shared `behavior-build` instance the
   * backend also uses for play).
   */
  compiler: ContentClosureCompilerPort;
  /**
   * The injectable wall clock (milliseconds since the epoch) used
   * for the manifest `capturedAt` and `meta.json.exportedAt`. Defaults to
   * `Date.now`. A fixed clock makes two exports of the same captured state
   * byte-identical except `exportedAt`; the backend passes no
   * clock, so a real export records the real capture second.
   */
  now?: () => number;
}
