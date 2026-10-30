/**
 * The frozen engine an export bundles from.
 *
 * `npm run build` copies the engine sources every export bundle may link into
 * `dist/export-engine/` (the same moment it builds the Play bundles), and the
 * backend's exports bundle from that copy. An export never reads the
 * working tree at request time, so what a user exports is the engine Play
 * serves, whatever is being edited under `packages/` meanwhile.
 *
 * The copy keeps the repository's layout (`packages/<name>/src/…`, each
 * package's package.json and tsconfig.json, the shared tsconfig base), so
 * esbuild resolves, transforms and tree-shakes it exactly as the live tree
 * and the output bytes are the same. Third-party code (three, Rapier) is
 * pinned by the lockfile and is read from the installed node_modules.
 */
import { ENGINE_MODULES } from '@thirdlight/project-model';

/** The frozen engine's folder, relative to the engine root. */
export const EXPORT_ENGINE_DIR = 'dist/export-engine';

/** The export bundle entry, relative to an engine (the live root or the frozen copy). */
export const EXPORT_BOOTSTRAP = 'packages/exporter/src/export-bootstrap.ts';

/** The generic engine packages every export may link. */
export const ENGINE_PACKAGES: readonly string[] = ['runtime', 'three-adapter', 'effects', 'project-model', 'input', 'physics-rapier', 'game-host', 'shared'];

/** The packages of the modules a manifest names (`@thirdlight/<name>` → `<name>`). */
export function modulePackagesOf(moduleIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const m of ENGINE_MODULES) if (moduleIds.includes(m.id) && m.package.startsWith('@thirdlight/')) out.add(m.package.slice('@thirdlight/'.length));
  return [...out].sort();
}

/**
 * The packages the frozen engine holds: every package an export bundle may
 * link (the engine packages and those of every known module), and the
 * exporter, whose bootstrap and worker entries the bundles start from.
 */
export function exportEnginePackages(): string[] {
  return [...new Set([...ENGINE_PACKAGES, ...modulePackagesOf(ENGINE_MODULES.map((m) => m.id)), 'exporter'])].sort();
}

/** True when a path lies inside a frozen engine copy. */
export function inFrozenEngine(path: string): boolean {
  return path.replace(/\\/g, '/').includes(`${EXPORT_ENGINE_DIR}/`);
}
