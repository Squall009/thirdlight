/**
 * Export bundle import-graph check,
 * verified over the esbuild `--metafile` output.
 *
 * Allowed: the export bootstrap file (packages/exporter/src/export-bootstrap-m3.ts
 * only), the shared production composition `game-host` and the generic engine
 * packages — `runtime`, `three-adapter` (with its `effects`),
 * `project-model`, `input`, `physics-rapier` — plus `three`, the pinned
 * `@dimforge/rapier2d-compat` (and `@dimforge/rapier3d-compat`, the 3D
 * backend's `js/physics-3d.js` of a 3D project), and the per-snapshot
 * virtual modules the export build generates in memory
 * (`thirdlight:export-artifacts`, `thirdlight:export-modules`). A
 * module package outside that set (the character controller ones) is allowed only when
 * the manifest names one of its modules.
 *
 * Forbidden (any node): `backend`, `editor`, `workspace`, `commands`,
 * `mcp-adapter`, `protocol`, `exporter` beyond the bootstrap, `behavior-build`,
 * `asset-pipeline`, and any `node:` builtin. Pure data processing, no I/O.
 */

import { ENGINE_MODULES } from '@thirdlight/project-model';

export interface GraphReport {
  ok: boolean;
  /** The forbidden module names (≤ 8 reported). */
  forbidden: string[];
}

const MAX_REPORTED = 8;

/** The virtual-module keys the export build generates (esbuild namespaces them). */
const VIRTUAL_KEYS = new Set(['thirdlight-export:export-artifacts', 'thirdlight-export-modules:export-modules']);

/** Metafile keys are absolute or cwd-relative; normalize separators. */
function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

/** A path from its `packages/` segment on, so absolute and relative keys compare equal. */
function toRepoRel(p: string): string {
  const i = p.lastIndexOf('packages/');
  return i >= 0 ? p.slice(i) : p;
}

/** The generic engine packages every export may link. */
const ENGINE_PACKAGES = ['runtime', 'three-adapter', 'effects', 'project-model', 'input', 'physics-rapier', 'game-host'];

/** The packages of the modules a manifest names (`@thirdlight/<name>` → `<name>`). */
export function modulePackagesOf(moduleIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const m of ENGINE_MODULES) if (moduleIds.includes(m.id) && m.package.startsWith('@thirdlight/')) out.add(m.package.slice('@thirdlight/'.length));
  return [...out].sort();
}

function allowed(p: string, packages: readonly string[]): boolean {
  if (packages.some((name) => p.includes(`packages/${name}/src/`))) return true;
  if (p.includes('node_modules/three/')) return true;
  // The approved physics pins (decision 0005 for 3D): the compat builds and their inlined WASM modules.
  return p.includes('node_modules/@dimforge/rapier2d-compat/') || p.includes('node_modules/@dimforge/rapier3d-compat/');
}

/**
 * Check every module in the export bundle's metafile input graph against the
 * engine packages plus the packages of the manifest's modules (`moduleIds`).
 */
export function checkBundleGraphM3(metafile: { inputs: Record<string, unknown> }, bootstrapEntry: string, moduleIds: readonly string[]): GraphReport {
  const boot = toRepoRel(normalize(bootstrapEntry));
  const packages = [...new Set([...ENGINE_PACKAGES, ...modulePackagesOf(moduleIds)])];
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
    if (allowed(p, packages)) continue;
    reject(p);
  }
  return { ok: forbidden.length === 0, forbidden };
}
