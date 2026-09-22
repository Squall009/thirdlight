/**
 * Export bundle import-graph check (export.md §4 step 4 / §5.2 — exact
 * allowed set, verified with the esbuild `--metafile` output):
 *
 *   export-bootstrap (packages/exporter/src/export-bootstrap.ts — that file
 *   only) → runtime → project-model (pure, inlined)
 *            → three-adapter → runtime, three
 *
 * Forbidden in the graph (any node): `backend`, `editor`, `workspace`,
 * `commands`, `mcp-adapter`, `protocol`, `exporter` (anything beyond its
 * bootstrap file), and any `node:` builtin (browser platform).
 *
 * This is the export instance of the dependencies.md §5.3 bundle graph
 * check. Pure data processing over the metafile `inputs` map: no I/O.
 */

export interface GraphReport {
  ok: boolean;
  /** The forbidden module names (≤ 8 reported, export.md §4.1). */
  forbidden: string[];
}

const MAX_REPORTED = 8;

/** The allowed input locations (export.md §5.2). */
// (Inlined into the check below: the keys may be absolute or cwd-relative,
// so the match is on the package/tooling segment, not a leading slash.)

function normalize(p: string): string {
  // Metafile input keys are absolute OR cwd-relative (esbuild uses
  // absWorkingDir for the keys); normalize separators so the segment checks
  // are stable.
  return p.replace(/\\/g, '/');
}

/**
 * Reduce a path to its repo-relative form (from the `packages/` segment
 * on) so absolute and cwd-relative metafile keys compare equal. Returns the
 * normalized path unchanged when no `packages/` segment is present.
 */
function toRepoRel(p: string): string {
  const i = p.lastIndexOf('packages/');
  return i >= 0 ? p.slice(i) : p;
}

/**
 * Check every module in the esbuild metafile input graph.
 *
 * @param metafile the esbuild metafile (its `inputs` map: entry/module path
 *        → module record; keys may be absolute or cwd-relative)
 * @param bootstrapEntry the exact export-bootstrap file path (the only
 *        allowed `exporter` node)
 */
export function checkBundleGraph(
  metafile: { inputs: Record<string, unknown> },
  bootstrapEntry: string,
): GraphReport {
  return checkGraph(metafile, bootstrapEntry, 'm1');
}

/**
 * Packet 36 — the M2 export bundle graph check (dependencies.md §4.2 export
 * row): the M2 bootstrap file plus `runtime`, `three-adapter` (incl. the
 * GLTFLoader subpath), `project-model`, `input`, `platformer`,
 * `physics-rapier`, `three` and the pinned `@dimforge/rapier2d-compat`, PLUS
 * the per-snapshot virtual modules the export build generates in memory:
 *
 *   `export-artifacts`, `export-behaviors`, `thirdlight/behavior-output:<id>`.
 *
 * Still forbidden in the graph (any node): `backend`, `editor`, `workspace`,
 * `commands`, `mcp-adapter`, `protocol`, `exporter` (beyond the bootstrap
 * file), `behavior-build`, `asset-pipeline` and any `node:` builtin.
 */
export function checkBundleGraphM2(metafile: { inputs: Record<string, unknown> }, bootstrapEntry: string): GraphReport {
  return checkGraph(metafile, bootstrapEntry, 'm2');
}

/** The two virtual-module keys the export build generates (esbuild namespaces them). */
const M2_VIRTUAL_KEYS = new Set(['thirdlight-export:export-artifacts', 'thirdlight-export:export-behaviors']);

/**
 * The M2 exporter files allowed in the bundle graph: the M2 bootstrap (that
 * file only) plus the shared composition module it imports
 * (`export-composition.ts`). Recorded as contract-change request C36-5 (the
 * C36-1 layout addition needs a second exporter file in the graph).
 */
const M2_EXPORTER_FILES = [
  'packages/exporter/src/export-bootstrap-m2.ts',
  'packages/exporter/src/export-composition.ts',
  'packages/exporter/src/export-page.ts',
];

interface GraphOptions {
  profile: 'm1' | 'm2' | 'm3';
}

/** The virtual-module keys the M3 export build generates (esbuild
 *  namespaces them): the declared asset paths + one relative fetch each. */
const M3_VIRTUAL_KEYS = new Set(['thirdlight-export:export-artifacts']);

/**
 * The M3 exporter files allowed in the bundle graph: the M3 bootstrap (that
 * file only). The M3 composition is owned by `game-host` (delivery.md §1/§3),
 * so no second exporter file enters the graph (unlike M2's
 * `export-composition.ts`).
 */
const M3_EXPORTER_FILES = ['packages/exporter/src/export-bootstrap-m3.ts'];

function checkGraph(metafile: { inputs: Record<string, unknown> }, bootstrapEntry: string, profile: GraphOptions['profile']): GraphReport {
  const boot = toRepoRel(normalize(bootstrapEntry));
  const forbidden: string[] = [];

  for (const key of Object.keys(metafile.inputs ?? {})) {
    const p = normalize(key);

    // A Node builtin can never appear in a browser-platform graph.
    if (p.startsWith('node:')) {
      if (forbidden.length < MAX_REPORTED) forbidden.push(p);
      continue;
    }

    if (profile === 'm2' && (M2_VIRTUAL_KEYS.has(p) || p.startsWith('thirdlight-behavior:thirdlight:behavior-output:'))) {
      continue;
    }

    if (profile === 'm3' && M3_VIRTUAL_KEYS.has(p)) {
      continue;
    }

    if (toRepoRel(p) === boot) continue;

    // The exporter package: ONLY its bootstrap file (plus, for M2, the shared
    // composition module) is allowed.
    if (p.includes('packages/exporter/')) {
      if (profile === 'm2' && M2_EXPORTER_FILES.some((f) => p.endsWith(f))) continue;
      if (profile === 'm3' && M3_EXPORTER_FILES.some((f) => p.endsWith(f))) continue;
      if (forbidden.length < MAX_REPORTED) forbidden.push(p);
      continue;
    }

    if (
      p.includes('packages/runtime/src/') ||
      p.includes('packages/three-adapter/src/') ||
      p.includes('packages/project-model/src/') ||
      nodeModulesAllowlist(p, profile)
    ) {
      continue;
    }

    // Everything else (backend, editor, workspace, commands, mcp-adapter,
    // protocol, behavior-build, asset-pipeline or any other package/tooling)
    // is forbidden.
    if (forbidden.length < MAX_REPORTED) {
      forbidden.push(p);
    }
  }

  return { ok: forbidden.length === 0, forbidden };
}

function nodeModulesAllowlist(p: string, profile: GraphOptions['profile']): boolean {
  if (p.includes('node_modules/three/')) return true;
  if (profile !== 'm2' && profile !== 'm3') return false;
  if (p.includes('packages/input/src/') || p.includes('packages/platformer/src/') || p.includes('packages/physics-rapier/src/')) return true;
  if (profile === 'm3' && (p.includes('packages/game-host/src/') || p.includes('packages/platformer-game/src/'))) return true;
  // The approved physics pin (dependencies.md §7): the compat build and its
  // inlined WASM module only.
  return p.includes('node_modules/@dimforge/rapier2d-compat/');
}

/**
 * Packet 58 — the M3 export bundle graph check (delivery.md §3, export.md §4
 * step 4): the M3 bootstrap file plus the single shared production composition
 * (`game-host`) and its transitive packages — `runtime`, `platformer`,
 * `platformer-game`, `three-adapter`, `project-model`, `input`,
 * `physics-rapier`, `three` and the pinned `@dimforge/rapier2d-compat` — PLUS
 * the per-snapshot virtual module the export build generates in memory
 * (`thirdlight:export-artifacts`).
 *
 * Still forbidden in the graph (any node): `backend`, `editor`, `workspace`,
 * `commands`, `mcp-adapter`, `protocol`, `exporter` (beyond the bootstrap
 * file), `behavior-build`, `asset-pipeline` and any `node:` builtin.
 */
export function checkBundleGraphM3(metafile: { inputs: Record<string, unknown> }, bootstrapEntry: string): GraphReport {
  return checkGraph(metafile, bootstrapEntry, 'm3');
}