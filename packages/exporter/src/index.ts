/**
 * @thirdlight/exporter — public surface (dependencies.md row:
 * `.` — `exportProject(ctx) → result`, `ERROR_CODES`).
 *
 * The `.` subpath is the export operation invoked by the backend
 * (`POST /api/v1/admin/projects/:projectId/export`, admin scope). It is not
 * a browser command.
 *
 * The browser export bundle entry (`src/export-bootstrap-m3.ts`) is NOT a
 * public export: it is reached by file path at build time (the bundle graph
 * allows "that file only"); the `exports` map does not expose it.
 *
 * Node-side code of this package imports no Node builtins (dependencies.md
 * `node: []`): the workspace service AND the IO facade are injected
 * (types-only `@thirdlight/workspace` edge; `ExportFs` supplied by the
 * backend). The only external runtime dependency is `esbuild`, used
 * with `write: false` so the built bytes stay in memory.
 */

export { exportProject, type ExportContext, type ExportFs } from './export';
export { exportProjectM3 } from './export-m3';
// The shared closure builder + the export/play runtime composition
// (dependencies.md `exporter` row: "the shared manifest/closure builder").
export {
  buildContentClosureM3,
  closureCacheStats,
  type ClosureArtifact,
  type ClosureLibraryModule,
  type ClosureSourceMap,
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
  scanAssetContainer,
  scanFontContainer,
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
// The declared-dependency module resolver, re-exported for the
// backend (whose project-model edge is types-only): templates resolve their
// declared modules at creation through the same function the closure uses.
export { physicsDimensionOf, resolveRequiredModules, type ResolveModulesResult, type UnresolvedModule } from '@thirdlight/project-model';
