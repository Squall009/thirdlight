/**
 * Phase 24.3: what a test composition registers, as the real compositions do.
 * The game host has no default module set: the Play preview and the export
 * pass the manifest's `modules` (resolved from what the content references)
 * and the spec table they ship. A test that composes a host directly derives
 * the same `modules` from its snapshot with the same resolver and passes the
 * same table as the preview (`packages/editor/src/preview/module-specs.ts`).
 */
import { physicsDimensionOf, resolveRequiredModules } from '@thirdlight/project-model';
import { platformerSpec } from '@thirdlight/platformer';
import { platformerGameCameraSpec, platformerGameSessionSpec } from '@thirdlight/platformer-game';
import type { SimulationModuleSpec } from '@thirdlight/runtime';

/** The module specs a composition provides beyond the runtime's built-ins (dependency order). */
export const MODULE_SPECS: readonly SimulationModuleSpec[] = Object.freeze([platformerSpec, platformerGameSessionSpec, platformerGameCameraSpec]);

interface SnapshotLike {
  readonly scene?: { readonly entities?: readonly unknown[] } | null;
  readonly game?: unknown;
  readonly prefabs?: readonly { readonly entities?: readonly unknown[] }[];
}

/** The manifest `modules` a build of this snapshot would carry (throws on an unresolved module). */
export function modulesOf(snapshot: SnapshotLike, settings?: unknown): string[] {
  const entities = [...(snapshot.scene?.entities ?? []), ...(snapshot.prefabs ?? []).flatMap((p) => p.entities ?? [])] as Record<string, unknown>[];
  const r = resolveRequiredModules({ scene: { entities }, game: snapshot.game ?? null, physicsDimension: physicsDimensionOf(settings) });
  if (!r.ok) throw new Error(r.message);
  return r.moduleIds;
}

/** `modules` + `moduleSpecs` for a host or `composeGameRuntime` config. */
export function gameModules(snapshot: SnapshotLike, settings?: unknown): { modules: string[]; moduleSpecs: readonly SimulationModuleSpec[] } {
  return { modules: modulesOf(snapshot, settings), moduleSpecs: MODULE_SPECS };
}

/**
 * A host config with the modules its snapshot references and the spec table
 * (a config that names its own `modules` keeps them).
 */
export function withGameModules<T>(config: T): T {
  const c = config as unknown as { snapshot: SnapshotLike; settings?: unknown; modules?: readonly string[]; moduleSpecs?: unknown };
  return { ...c, ...(c.modules === undefined ? { modules: modulesOf(c.snapshot, c.settings) } : {}), ...(c.moduleSpecs === undefined ? { moduleSpecs: MODULE_SPECS } : {}) } as unknown as T;
}
