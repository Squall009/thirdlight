/**
 * What a test composition registers, as the real compositions do.
 * The game host has no default module set: the Play preview and the export
 * pass the manifest's `modules` (resolved from what the content references)
 * and the spec table they ship. A test that composes a host directly derives
 * the same `modules` from its snapshot with the same resolver and passes the
 * same table as the preview (`packages/editor/src/preview/module-specs.ts`).
 */
import { resolveRequiredModules } from '@thirdlight/project-model';
import { characterControllerSpec } from '@thirdlight/character';
import type { SimulationModuleSpec } from '@thirdlight/runtime';

/** The module specs a composition provides beyond the runtime's built-ins (dependency order). */
export const MODULE_SPECS: readonly SimulationModuleSpec[] = Object.freeze([characterControllerSpec]);

interface SnapshotLike {
  readonly scene?: { readonly entities?: readonly unknown[] } | null;
  readonly prefabs?: readonly { readonly entities?: readonly unknown[] }[];
}

/**
 * The manifest `modules` a build of this snapshot would carry (throws on an
 * unresolved module). Every build is 3D now; a test that builds the 2D port
 * itself (`physics2DConfigOf`, the backend being removed) gets the 2D
 * modules that port runs with.
 */
export function modulesOf(snapshot: SnapshotLike, _settings?: unknown, physics?: unknown): string[] {
  const entities = [...(snapshot.scene?.entities ?? []), ...(snapshot.prefabs ?? []).flatMap((p) => p.entities ?? [])] as Record<string, unknown>[];
  const twoD = physics !== undefined && physics !== null && (physics as { dimension?: unknown }).dimension !== 3;
  const r = resolveRequiredModules({ scene: { entities }, physicsDimension: twoD ? 2 : 3 });
  if (!r.ok) throw new Error(r.message);
  return r.moduleIds;
}

/** `modules` + `moduleSpecs` for a host or `composeGameRuntime` config. */
export function gameModules(snapshot: SnapshotLike, settings?: unknown, physics?: unknown): { modules: string[]; moduleSpecs: readonly SimulationModuleSpec[] } {
  return { modules: modulesOf(snapshot, settings, physics), moduleSpecs: MODULE_SPECS };
}

/**
 * A host config with the modules its snapshot references and the spec table
 * (a config that names its own `modules` keeps them).
 */
export function withGameModules<T>(config: T): T {
  const c = config as unknown as { snapshot: SnapshotLike; settings?: unknown; physics?: unknown; modules?: readonly string[]; moduleSpecs?: unknown };
  return { ...c, ...(c.modules === undefined ? { modules: modulesOf(c.snapshot, c.settings, c.physics) } : {}), ...(c.moduleSpecs === undefined ? { moduleSpecs: MODULE_SPECS } : {}) } as unknown as T;
}
