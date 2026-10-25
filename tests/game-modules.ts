/**
 * What a test composition registers, as the real compositions do.
 * The game host has no default module set: the Play preview and the export
 * pass the manifest's `modules` (resolved from what the content references)
 * and the spec table they ship. A test that composes a host directly derives
 * the same `modules` from its snapshot with the same resolver and passes the
 * same table as the preview (`packages/editor/src/preview/module-specs.ts`).
 */
import { resolveRequiredModules } from '@thirdlight/project-model';
import type { SimulationModuleSpec } from '@thirdlight/runtime';

/** The module specs a composition provides beyond the runtime's built-ins (none: the controller is built in). */
export const MODULE_SPECS: readonly SimulationModuleSpec[] = Object.freeze([]);

interface SnapshotLike {
  readonly scene?: { readonly entities?: readonly unknown[] } | null;
  readonly prefabs?: readonly { readonly entities?: readonly unknown[] }[];
}

/** The manifest `modules` a build of this snapshot would carry (throws on an unresolved module). */
export function modulesOf(snapshot: SnapshotLike): string[] {
  const entities = [...(snapshot.scene?.entities ?? []), ...(snapshot.prefabs ?? []).flatMap((p) => p.entities ?? [])] as Record<string, unknown>[];
  const r = resolveRequiredModules({ scene: { entities } });
  if (!r.ok) throw new Error(r.message);
  return r.moduleIds;
}

/** `modules` + `moduleSpecs` for a host or `composeGameRuntime` config. */
export function gameModules(snapshot: SnapshotLike): { modules: string[]; moduleSpecs: readonly SimulationModuleSpec[] } {
  return { modules: modulesOf(snapshot), moduleSpecs: MODULE_SPECS };
}

/**
 * A host config with the modules its snapshot references and the spec table
 * (a config that names its own `modules` keeps them).
 */
export function withGameModules<T>(config: T): T {
  const c = config as unknown as { snapshot: SnapshotLike; modules?: readonly string[]; moduleSpecs?: unknown };
  return { ...c, ...(c.modules === undefined ? { modules: modulesOf(c.snapshot) } : {}), ...(c.moduleSpecs === undefined ? { moduleSpecs: MODULE_SPECS } : {}) } as unknown as T;
}
