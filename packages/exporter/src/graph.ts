/**
 * Export bundle import-graph check (export.md §4 step 4 / delivery.md §3),
 * verified over the esbuild `--metafile` output.
 *
 * Allowed: the export bootstrap file (packages/exporter/src/export-bootstrap-m3.ts
 * only), the shared production composition `game-host` and its packages —
 * `runtime`, `platformer`, `platformer-game`, `three-adapter`,
 * `project-model`, `input`, `physics-rapier` — plus `three`, the pinned
 * `@dimforge/rapier2d-compat`, and the per-snapshot virtual module the export
 * build generates in memory (`thirdlight:export-artifacts`).
 *
 * Forbidden (any node): `backend`, `editor`, `workspace`, `commands`,
 * `mcp-adapter`, `protocol`, `exporter` beyond the bootstrap, `behavior-build`,
 * `asset-pipeline`, and any `node:` builtin. Pure data processing, no I/O.
 */

export interface GraphReport {
  ok: boolean;
  /** The forbidden module names (≤ 8 reported, export.md §4.1). */
  forbidden: string[];
}

const MAX_REPORTED = 8;

/** The virtual-module keys the export build generates (esbuild namespaces them). */
const VIRTUAL_KEYS = new Set(['thirdlight-export:export-artifacts']);

/** Metafile keys are absolute or cwd-relative; normalize separators. */
function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

/** A path from its `packages/` segment on, so absolute and relative keys compare equal. */
function toRepoRel(p: string): string {
  const i = p.lastIndexOf('packages/');
  return i >= 0 ? p.slice(i) : p;
}

const ALLOWED_PACKAGES = ['runtime', 'three-adapter', 'project-model', 'input', 'platformer', 'physics-rapier', 'game-host', 'platformer-game'];

function allowed(p: string): boolean {
  if (ALLOWED_PACKAGES.some((name) => p.includes(`packages/${name}/src/`))) return true;
  if (p.includes('node_modules/three/')) return true;
  // The approved physics pin (dependencies.md §7): the compat build and its inlined WASM module.
  return p.includes('node_modules/@dimforge/rapier2d-compat/');
}

/** Check every module in the export bundle's metafile input graph. */
export function checkBundleGraphM3(metafile: { inputs: Record<string, unknown> }, bootstrapEntry: string): GraphReport {
  const boot = toRepoRel(normalize(bootstrapEntry));
  const forbidden: string[] = [];
  const reject = (p: string): void => {
    if (forbidden.length < MAX_REPORTED) forbidden.push(p);
  };
  for (const key of Object.keys(metafile.inputs ?? {})) {
    const p = normalize(key);
    if (p.startsWith('node:')) {
      reject(p);
      continue;
    }
    if (VIRTUAL_KEYS.has(p)) continue;
    if (toRepoRel(p) === boot) continue;
    if (p.includes('packages/exporter/')) {
      reject(p); // only the bootstrap file of the exporter may enter the graph
      continue;
    }
    if (allowed(p)) continue;
    reject(p);
  }
  return { ok: forbidden.length === 0, forbidden };
}
