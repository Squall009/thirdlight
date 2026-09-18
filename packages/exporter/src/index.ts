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
export {
  ERROR_CODES,
  clip,
  type ExportError,
  type ExportErrorClass,
  type ExportErrorCode,
  type ExportResult,
} from './errors';