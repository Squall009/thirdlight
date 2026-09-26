/**
 * Engine modules and their resolution (charter §3 "Genre templates": builds
 * derive required modules from declared dependencies and referenced content;
 * unresolved dependencies fail validation).
 *
 * The declared dependencies of a project are:
 *   - the game block (`content.game !== null`): the platformer game set;
 *   - referenced content: a `controller` component needs the platformer
 *     controller (which needs physics + input); a `model` component needs
 *     the glTF loader;
 *   - each behavior's `requiredModules` (engine package ids);
 *   - explicitly declared module ids (a template's `requiredModules`).
 *
 * Every module id must be one this engine provides; anything else is
 * `unresolved` and the caller refuses (creation, Play, export).
 */

export interface EngineModule {
  /** The module id (`<package-short>:<module>`). */
  id: string;
  /** The package that provides it. */
  package: string;
  /**
   * - `simulation`: a runtime simulation module (registered on the runtime);
   * - `port`: a capability the delivery wrapper injects (physics, input, loaders).
   */
  kind: 'simulation' | 'port';
  /** Modules this one needs (closed transitively at resolution). */
  requires: readonly string[];
}

export const ENGINE_MODULES: readonly EngineModule[] = Object.freeze(([
  { id: 'thirdlight.demo:box-motion', package: '@thirdlight/runtime', kind: 'simulation', requires: [] },
  { id: 'thirdlight.input:keyboard-gamepad', package: '@thirdlight/input', kind: 'port', requires: [] },
  { id: 'thirdlight.physics-rapier:2d', package: '@thirdlight/physics-rapier', kind: 'port', requires: [] },
  // Phase 23.0: the 3D backend (a project whose physics_dimension is 3).
  { id: 'thirdlight.physics-rapier:3d', package: '@thirdlight/physics-rapier', kind: 'port', requires: [] },
  { id: 'thirdlight.platformer:controller', package: '@thirdlight/platformer', kind: 'simulation', requires: ['thirdlight.physics-rapier:2d', 'thirdlight.input:keyboard-gamepad'] },
  { id: 'thirdlight.platformer-game:session', package: '@thirdlight/platformer-game', kind: 'simulation', requires: ['thirdlight.platformer:controller'] },
  { id: 'thirdlight.platformer-game:camera', package: '@thirdlight/platformer-game', kind: 'simulation', requires: ['thirdlight.platformer-game:session'] },
  { id: 'thirdlight.three-adapter:gltf-loader', package: '@thirdlight/three-adapter', kind: 'port', requires: [] },
] as EngineModule[]).map((m) => Object.freeze(m)));

const BY_ID: ReadonlyMap<string, EngineModule> = new Map(ENGINE_MODULES.map((m) => [m.id, m]));

/** Every module id this engine provides (ascending). */
export const ENGINE_MODULE_IDS: readonly string[] = Object.freeze([...BY_ID.keys()].sort());

/**
 * What a behavior may require, by engine package id → the modules that
 * dependency implies. `@thirdlight/runtime` is the behavior API itself
 * (always present).
 */
export const BEHAVIOR_PACKAGE_MODULES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '@thirdlight/runtime': [],
  '@thirdlight/platformer': ['thirdlight.platformer:controller'],
  '@thirdlight/physics-rapier': ['thirdlight.physics-rapier:2d'],
  '@thirdlight/input': ['thirdlight.input:keyboard-gamepad'],
  '@thirdlight/platformer-game': ['thirdlight.platformer-game:session', 'thirdlight.platformer-game:camera'],
  '@thirdlight/three-adapter': ['thirdlight.three-adapter:gltf-loader'],
});

export interface ResolveModulesInput {
  /** The scene (entities' component presence is read structurally). */
  scene: { entities?: ReadonlyArray<Record<string, unknown>> } | null | undefined;
  /** The game block (`content.game`), or null for a plain scene. */
  game: unknown;
  /** The reachable behaviors and what they declared. */
  behaviors?: ReadonlyArray<{ behaviorId: string; requiredModules: readonly string[] }>;
  /** Explicitly declared module ids (e.g. a template's `requiredModules`). */
  declared?: readonly string[];
  /** The M2 demo module (box motion) is selected. */
  demo?: boolean;
  /**
   * Phase 23.0: the project's physics dimension (absent: 2, the 2D plane). In
   * 3D a `controller` needs the 3D backend (`thirdlight.physics-rapier:3d`),
   * not the 2D platformer controller; the platformer game set (a game block)
   * is 2D-plane only until 3D game modes exist (phase 23.10).
   */
  physicsDimension?: 2 | 3;
}

export interface UnresolvedModule {
  /** The module or package id nobody provides. */
  id: string;
  /** What declared it: `game`, `scene`, `behavior:<id>`, or `declared`. */
  requiredBy: string;
}

export type ResolveModulesResult =
  | { ok: true; moduleIds: string[] }
  | { ok: false; unresolved: UnresolvedModule[]; message: string };

/** Derive the required module set, or the unresolved dependencies. */
export function resolveRequiredModules(input: ResolveModulesInput): ResolveModulesResult {
  const wanted = new Map<string, string>(); // id → first requirer
  const unresolved: UnresolvedModule[] = [];
  const want = (id: string, requiredBy: string): void => {
    if (!wanted.has(id)) wanted.set(id, requiredBy);
  };

  if (input.demo === true) want('thirdlight.demo:box-motion', 'declared');
  const threeD = input.physicsDimension === 3;
  if (threeD && input.game !== null && input.game !== undefined) {
    return {
      ok: false,
      unresolved: [{ id: 'thirdlight.platformer-game:session', requiredBy: 'game' }],
      message: 'the platformer game block runs on the 2D plane (physics_dimension 2); a 3D project plays its scenes without one until 3D game modes exist',
    };
  }
  if (input.game !== null && input.game !== undefined) {
    want('thirdlight.platformer-game:session', 'game');
    want('thirdlight.platformer-game:camera', 'game');
  }
  for (const e of input.scene?.entities ?? []) {
    const c = (e['components'] ?? {}) as Record<string, unknown>;
    if (c['controller'] !== undefined) want(threeD ? 'thirdlight.physics-rapier:3d' : 'thirdlight.platformer:controller', 'scene');
    if (c['model'] !== undefined) want('thirdlight.three-adapter:gltf-loader', 'scene');
  }
  for (const b of input.behaviors ?? []) {
    for (const pkg of b.requiredModules) {
      const ids = BEHAVIOR_PACKAGE_MODULES[pkg];
      if (ids === undefined) {
        unresolved.push({ id: pkg, requiredBy: `behavior:${b.behaviorId}` });
        continue;
      }
      // Phase 23.0: a 3D project's physics is the 3D backend.
      for (const id of ids) want(threeD && id === 'thirdlight.physics-rapier:2d' ? 'thirdlight.physics-rapier:3d' : id, `behavior:${b.behaviorId}`);
    }
  }
  for (const id of input.declared ?? []) want(id, 'declared');

  // Close transitively; anything unknown is unresolved.
  const resolved = new Set<string>();
  const queue = [...wanted.entries()];
  while (queue.length > 0) {
    const [id, by] = queue.shift()!;
    if (resolved.has(id)) continue;
    const mod = BY_ID.get(id);
    if (mod === undefined) {
      if (!unresolved.some((u) => u.id === id && u.requiredBy === by)) unresolved.push({ id, requiredBy: by });
      continue;
    }
    resolved.add(id);
    for (const dep of mod.requires) queue.push([dep, `module:${id}`]);
  }
  if (unresolved.length > 0) {
    const list = unresolved.map((u) => `${u.id} (required by ${u.requiredBy})`).join(', ');
    return { ok: false, unresolved, message: `unresolved engine module(s): ${list}` };
  }
  return { ok: true, moduleIds: [...resolved].sort() };
}
