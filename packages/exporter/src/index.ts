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

export { exportProject, exportProjectM1, type ExportContext, type ExportFs } from './export';
export { exportProjectM2 } from './export-m2';
export { exportProjectM3 } from './export-m3';
// Packet 36 — the shared M2 closure builder + the export/play runtime
// composition (dependencies.md §3 `exporter` row: "the shared
// manifest/closure builder + the packet-19 meta.json fields").
export {
  buildContentClosure,
  buildContentClosureM3,
  type ClosureArtifact,
  type ClosureBehavior,
  type ContentClosure,
  type ContentClosureCompilerPort,
  type ContentClosureError,
  type ContentClosureInput,
  type ContentClosureM3,
  type ContentClosureM3Input,
  type ContentClosureResult,
} from './content-closure';
export {
  composeExportRuntime,
  exportModuleIds,
  verifyManifestIdentity,
  EXPORT_MANIFEST_KEYS,
  type ComposeExportRuntimeInput,
  type ComposeExportRuntimeResult,
  type CompositionManifest,
  type ExportBehaviorLink,
} from './export-composition';
export { checkBundleGraphM2, checkBundleGraphM3 } from './graph';
// The shared manifest/digest helpers (project-model values re-exported so
// value-only consumers such as `backend` keep their types-only
// `backend → project-model` edge, dependencies.md §4.1).
export {
  BUILD_OPTIONS_RECORD,
  MANIFEST_KEYS,
  M2_ENGINE_PINS,
  M2_KNOWN_MODULE_IDS,
  M2_MODULE_PACKAGES,
  RUNTIME_CONTENT_MANIFEST_MAX_BYTES,
  RUNTIME_CONTENT_MANIFEST_VERSION,
  RUNTIME_CONTENT_TYPE,
  buildOptionsRecordBytes,
  captureManifest,
  capturedViewDigest,
  digestBytes,
  digestEmittedClosure,
  manifestBuildIdInput,
  recipeDigestOf,
  requiredModuleIds,
  versionFactsDigest,
  type CaptureManifestInput,
  type CaptureManifestResult,
  type EmittedArtifactDigest,
  type ManifestAssetInput,
  type ManifestBehaviorInput,
  type ManifestError,
  type RuntimeContentManifest,
} from '@thirdlight/project-model';
export {
  assertRelativeClosure,
  scanGlbContainer,
  scanM2TextBundle,
  scanWavContainer,
  scanWasmContainer,
  textPatternCounts,
  type ContainerResult,
  type M2ScanCounts,
  type M2TextScanReport,
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
export { resolveRequiredModules, type ResolveModulesResult, type UnresolvedModule } from '@thirdlight/project-model';
