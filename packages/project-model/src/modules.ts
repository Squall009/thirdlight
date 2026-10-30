/**
 * Engine modules and their resolution: builds derive required modules from
 * declared dependencies and referenced content; unresolved dependencies fail
 * validation.
 *
 * Modules come only from what the project declares or
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

/**
 * The engine's module ids, by what each module is. Compositions, the manifest
 * tables and the runtime's own modules name a module through these, so a
 * module id is spelled once.
 */
export const MODULE_IDS = Object.freeze({
  /** The keyboard and gamepad input port. */
  keyboardGamepad: 'thirdlight.input:keyboard-gamepad',
  /** The physics backend port. */
  physics3d: 'thirdlight.physics-rapier:3d',
  /** The kinematic character controller (a runtime built-in). */
  character3d: 'thirdlight.character3d:controller',
  /** The glTF model loader port. */
  gltfLoader: 'thirdlight.three-adapter:gltf-loader',
} as const);

/** One engine module id. */
export type EngineModuleId = (typeof MODULE_IDS)[keyof typeof MODULE_IDS];

export interface EngineModule {
  /** The module id (`<package-short>:<module>`). */
  id: EngineModuleId;
  /** The package that provides it. */
  package: string;
  /**
   * - `simulation`: a runtime simulation module (registered on the runtime);
   * - `port`: a capability the delivery wrapper injects (physics, input, loaders).
   */
  kind: 'simulation' | 'port';
  /** Modules this one needs (closed transitively at resolution). */
  requires: readonly EngineModuleId[];
  /**
   * A simulation module outside the runtime — the name its
   * package exports its `SimulationModuleSpec` under. A composition (the
   * export build, a Play preview) imports exactly the specs its manifest's
   * modules name; the runtime's own built-ins have none.
   */
  spec?: string;
}

/** The physics backend's module id: a host whose manifest names it injects the port. */
export const PHYSICS_3D_MODULE_ID = MODULE_IDS.physics3d;

export const ENGINE_MODULES: readonly EngineModule[] = Object.freeze(([
  { id: MODULE_IDS.keyboardGamepad, package: '@thirdlight/input', kind: 'port', requires: [] },
  { id: PHYSICS_3D_MODULE_ID, package: '@thirdlight/physics-rapier', kind: 'port', requires: [] },
  // The kinematic character controller (a runtime built-in). Listed in
  // dependency order (a module after the modules it needs): a composition registers the selected
  // specs in this order.
  { id: MODULE_IDS.character3d, package: '@thirdlight/runtime', kind: 'simulation', requires: [PHYSICS_3D_MODULE_ID, MODULE_IDS.keyboardGamepad] },
  { id: MODULE_IDS.gltfLoader, package: '@thirdlight/three-adapter', kind: 'port', requires: [] },
] as EngineModule[]).map((m) => Object.freeze(m)));

const BY_ID: ReadonlyMap<string, EngineModule> = new Map(ENGINE_MODULES.map((m) => [m.id, m]));

/** Every module id this engine provides (ascending). */
export const ENGINE_MODULE_IDS: readonly EngineModuleId[] = Object.freeze(ENGINE_MODULES.map((m) => m.id).sort());

/** The port modules: capabilities a delivery wrapper injects, which a host checks rather than registers. */
export const PORT_MODULE_IDS: ReadonlySet<string> = new Set(ENGINE_MODULES.filter((m) => m.kind === 'port').map((m) => m.id));

/**
 * What a behavior may require, by engine package id → the modules that
 * dependency implies. `@thirdlight/runtime` is the behavior API itself
 * (always present). A script that needs the character controller
 * references it through a `controller` component.
 */
export const BEHAVIOR_PACKAGE_MODULES: Readonly<Record<string, readonly EngineModuleId[]>> = Object.freeze({
  '@thirdlight/runtime': [],
  '@thirdlight/physics-rapier': [PHYSICS_3D_MODULE_ID],
  '@thirdlight/input': [MODULE_IDS.keyboardGamepad],
  '@thirdlight/three-adapter': [MODULE_IDS.gltfLoader],
});

/**
 * The module a scene component references. Presence of the component is the
 * reference; nothing else about a project selects a module.
 */
export const COMPONENT_MODULES: Readonly<Record<string, EngineModuleId>> = Object.freeze({
  // The kinematic character controller.
  controller: MODULE_IDS.character3d,
  // A glTF model needs the loader port.
  model: MODULE_IDS.gltfLoader,
  // A collider alone needs the backend (rays and picks without a character).
  collider: PHYSICS_3D_MODULE_ID,
  blockLayer: PHYSICS_3D_MODULE_ID,
});

/**
 * The modules a content block references (none at present).
 */
export const CONTENT_BLOCK_MODULES: Readonly<Record<string, readonly string[]>> = Object.freeze({});

export interface ResolveModulesInput {
  /** The scene (entities' component presence is read structurally). */
  scene: { entities?: ReadonlyArray<Record<string, unknown>> } | null | undefined;
  /** The reachable behaviors and what they declared. */
  behaviors?: ReadonlyArray<{ behaviorId: string; requiredModules: readonly string[] }>;
  /** Explicitly declared module ids (e.g. a template's `requiredModules`). */
  declared?: readonly string[];
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

  for (const e of input.scene?.entities ?? []) {
    const c = (e['components'] ?? {}) as Record<string, unknown>;
    for (const [component, id] of Object.entries(COMPONENT_MODULES)) if (c[component] !== undefined) want(id, 'scene');
  }
  for (const b of input.behaviors ?? []) {
    for (const pkg of b.requiredModules) {
      const ids = BEHAVIOR_PACKAGE_MODULES[pkg];
      if (ids === undefined) {
        unresolved.push({ id: pkg, requiredBy: `behavior:${b.behaviorId}` });
        continue;
      }
      for (const id of ids) want(id, `behavior:${b.behaviorId}`);
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
