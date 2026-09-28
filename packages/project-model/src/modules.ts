/**
 * Engine modules and their resolution (charter §3 "Genre templates": builds
 * derive required modules from declared dependencies and referenced content;
 * unresolved dependencies fail validation).
 *
 * Phase 24.3: modules come only from what the project declares or
 * references — there is no module set a project gets for being a game. The
 * dependencies are:
 *   - referenced content: each component or content block references the
 *     modules it needs ({@link COMPONENT_MODULES}, {@link CONTENT_BLOCK_MODULES});
 *     a module's own needs follow from its `requires`;
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
  /**
   * Phase 24.3: a simulation module outside the runtime — the name its
   * package exports its `SimulationModuleSpec` under. A composition (the
   * export build, a Play preview) imports exactly the specs its manifest's
   * modules name; the runtime's own built-ins have none.
   */
  spec?: string;
}

export const ENGINE_MODULES: readonly EngineModule[] = Object.freeze(([
  { id: 'thirdlight.demo:box-motion', package: '@thirdlight/runtime', kind: 'simulation', requires: [] },
  { id: 'thirdlight.input:keyboard-gamepad', package: '@thirdlight/input', kind: 'port', requires: [] },
  { id: 'thirdlight.physics-rapier:2d', package: '@thirdlight/physics-rapier', kind: 'port', requires: [] },
  // Phase 23.0: the 3D backend (a project whose physics_dimension is 3).
  { id: 'thirdlight.physics-rapier:3d', package: '@thirdlight/physics-rapier', kind: 'port', requires: [] },
  // Phase 23.2: the 3D kinematic character controller (a runtime built-in, like the demo module).
  { id: 'thirdlight.character3d:controller', package: '@thirdlight/runtime', kind: 'simulation', requires: ['thirdlight.physics-rapier:3d', 'thirdlight.input:keyboard-gamepad'] },
  // Listed in dependency order (a module after the modules it needs): a
  // composition registers the selected specs in this order.
  { id: 'thirdlight.platformer:controller', package: '@thirdlight/platformer', kind: 'simulation', requires: ['thirdlight.physics-rapier:2d', 'thirdlight.input:keyboard-gamepad'], spec: 'platformerSpec' },
  { id: 'thirdlight.three-adapter:gltf-loader', package: '@thirdlight/three-adapter', kind: 'port', requires: [] },
] as EngineModule[]).map((m) => Object.freeze(m)));

const BY_ID: ReadonlyMap<string, EngineModule> = new Map(ENGINE_MODULES.map((m) => [m.id, m]));

/** Every module id this engine provides (ascending). */
export const ENGINE_MODULE_IDS: readonly string[] = Object.freeze([...BY_ID.keys()].sort());

/**
 * What a behavior may require, by engine package id → the modules that
 * dependency implies. `@thirdlight/runtime` is the behavior API itself
 * (always present). Phase 24.3: the platformer packages are not a behavior
 * dependency (the compiler no longer pins them); a script that needs the
 * character controller references it through a `controller` component.
 */
export const BEHAVIOR_PACKAGE_MODULES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '@thirdlight/runtime': [],
  '@thirdlight/physics-rapier': ['thirdlight.physics-rapier:2d'],
  '@thirdlight/input': ['thirdlight.input:keyboard-gamepad'],
  '@thirdlight/three-adapter': ['thirdlight.three-adapter:gltf-loader'],
});

/**
 * Phase 24.3: the module a scene component references, by the project's
 * physics dimension. Presence of the component is the reference; nothing
 * else about a project selects a module.
 */
export const COMPONENT_MODULES: Readonly<Record<string, { readonly plane2d: string | null; readonly world3d: string | null }>> = Object.freeze({
  // The character controller (2D: the plane controller; 3D: the kinematic character controller).
  controller: Object.freeze({ plane2d: 'thirdlight.platformer:controller', world3d: 'thirdlight.character3d:controller' }),
  // A glTF model needs the loader port.
  model: Object.freeze({ plane2d: 'thirdlight.three-adapter:gltf-loader', world3d: 'thirdlight.three-adapter:gltf-loader' }),
  // Phase 23.3: in 3D a collider alone needs the backend (rays and picks without a character); the 2D plane builds its world from the controller.
  collider: Object.freeze({ plane2d: null, world3d: 'thirdlight.physics-rapier:3d' }),
  blockLayer: Object.freeze({ plane2d: null, world3d: 'thirdlight.physics-rapier:3d' }),
});

/**
 * Phase 24.3: the modules a content block references (phase 24.7: none — the
 * platformer game block and its session and camera modules were deleted).
 */
export const CONTENT_BLOCK_MODULES: Readonly<Record<string, readonly string[]>> = Object.freeze({});

export interface ResolveModulesInput {
  /** The scene (entities' component presence is read structurally). */
  scene: { entities?: ReadonlyArray<Record<string, unknown>> } | null | undefined;
  /** Phase 24.7: the deleted game block (`content.game`); ignored (always null in a valid project). */
  game?: unknown;
  /** The reachable behaviors and what they declared. */
  behaviors?: ReadonlyArray<{ behaviorId: string; requiredModules: readonly string[] }>;
  /** Explicitly declared module ids (e.g. a template's `requiredModules`). */
  declared?: readonly string[];
  /** The M2 demo module (box motion) is selected. */
  demo?: boolean;
  /**
   * Phase 23.0: the project's physics dimension (absent: 2, the 2D plane). In
   * 3D a `controller` needs the 3D backend (`thirdlight.physics-rapier:3d`),
   * not the 2D plane controller.
   */
  physicsDimension?: 2 | 3;
}

export interface UnresolvedModule {
  /** The module or package id nobody provides. */
  id: string;
  /** What declared it: `scene`, `behavior:<id>`, or `declared`. */
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
  for (const e of input.scene?.entities ?? []) {
    const c = (e['components'] ?? {}) as Record<string, unknown>;
    for (const [component, refs] of Object.entries(COMPONENT_MODULES)) {
      if (c[component] === undefined) continue;
      const id = threeD ? refs.world3d : refs.plane2d;
      if (id !== null) want(id, 'scene');
    }
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
