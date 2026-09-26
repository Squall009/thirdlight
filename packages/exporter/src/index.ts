/**
 * @thirdlight/exporter — public surface (dependencies.md §3 row:
 * `.` — `exportProject(ctx) → result` (export.md §4), `ERROR_CODES`).
 *
 * The `.` subpath is the export operation invoked by the backend
 * (sessions.md §6.3 — `POST /api/v1/admin/projects/:projectId/export`,
 * admin scope). It is NOT an MCP tool in M1 and not a browser command.
 *
 * The browser export bundle entry (`src/export-bootstrap.ts`) is NOT a
 * public export: it is reached by file path at build time (export.md §4.2
 * bundle graph — "that file only"); the `exports` map does not expose it.
 *
 * Node-side code of this package imports no Node builtins (dependencies.md
 * §4.1: `node: []`): the workspace service AND the IO facade are injected
 * (types-only `@thirdlight/workspace` edge; `ExportFs` supplied by the
 * backend). The only external runtime dependency is `esbuild` (§7), used
 * with `write: false` so the built bytes stay in memory.
 */

export { exportProject, type ExportContext, type ExportFs } from './export';
export { exportProjectM3 } from './export-m3';
// Packet 36 — the shared M2 closure builder + the export/play runtime
// composition (dependencies.md §3 `exporter` row: "the shared
// manifest/closure builder + the packet-19 meta.json fields").
export {
  buildContentClosureM3,
  type ClosureArtifact,
  type ClosureBehavior,
  type ContentClosureCompilerPort,
  type ContentClosureError,
  type ContentClosureM3,
  type ContentClosureM3Input,
} from './content-closure';
export { checkBundleGraphM3 } from './graph';
export { decodersNeeded } from './decoders';
export {
  assertRelativeClosure,
  scanGlbContainer,
  scanImageContainer,
  scanMusicContainer,
  scanWavContainer,
  scanWasmContainer,
  textPatternCounts,
  type ContainerResult,
  type M2ScanCounts,
} from './export-content-scan';
export {
  ERROR_CODES,
  clip,
  type ExportError,
  type ExportErrorClass,
  type ExportErrorCode,
  type ExportResult,
} from './errors';
// The declared-dependency module resolver (D17), re-exported for the
// backend (whose project-model edge is types-only): templates resolve their
// declared modules at creation through the same function the closure uses.
export { physicsDimensionOf, resolveRequiredModules, type ResolveModulesResult, type UnresolvedModule } from '@thirdlight/project-model';
