/**
 * Simulation-module registry (narrow).
 *
 * The ONLY simulation extension point. Registration happens in engine source, at
 * build time: no string-to-code resolution, no dynamic `import` of
 * project content, no file- or URL-sourced modules. Name syntax:
 * `^thirdlight\.[a-z0-9-]+:[a-z0-9_-]+$`. Duplicate registration ⇒
 * `config_invalid` (rejected at registration time). The first segment
 * admits hyphens (package-style names).
 */
import { clipMessage, type RuntimeError } from './errors';
import { boxMotionSpec, DEMO_MODULE_ID } from './demo';
import { SIMULATION_PHASE_ORDER } from './types';
import {
  SIM_REGISTRY_BRAND,
  type SimulationModuleSpec,
  type SimulationPhase,
  type SimulationRegistry,
} from './types';

/** The character controller module ID. */
export const CHARACTER_MODULE_ID = 'thirdlight.character:controller';


/**
 * The built-in M1 demo spec. Its `excludes`/`legacyTransformOwners` metadata
 * applies when the demo participates in an M2 set (the demo owns every
 * `box` entity and cannot coexist with the controller module). The demo's
 * `create` and step math are byte-identical in both set kinds.
 */
const demoBuiltinSpec: SimulationModuleSpec = {
  id: DEMO_MODULE_ID,
  excludes: [CHARACTER_MODULE_ID],
  legacyTransformOwners: (snapshot) =>
    snapshot.scene.entities.filter((e) => e.components.box !== undefined).map((e) => e.id),
  create: (snapshot, cfg) => boxMotionSpec.create(snapshot, cfg),
};

/** M1 registry contents: exactly one built-in module. */
export const BUILTIN_MODULES: readonly SimulationModuleSpec[] = [demoBuiltinSpec];

// The name takes `_` because a script's module is named by its behavior id, which the project model's ID syntax allows `_` in.
const MODULE_NAME_RE = /^thirdlight\.[a-z0-9-]+:[a-z0-9_-]+$/;

/**
 * Validate a declared phase list: non-empty, no
 * duplicates, canonical order. Returns a reason string on failure.
 */
export function validatePhaseList(phases: unknown): { ok: true; phases: readonly SimulationPhase[] } | { ok: false; message: string } {
  if (!Array.isArray(phases) || phases.length === 0) {
    return { ok: false, message: 'phases must be a non-empty array' };
  }
  const rank = (p: SimulationPhase): number => SIMULATION_PHASE_ORDER.indexOf(p);
  let last = -1;
  const seen = new Set<string>();
  for (const p of phases) {
    if (typeof p !== 'string' || !SIMULATION_PHASE_ORDER.includes(p as SimulationPhase)) {
      return { ok: false, message: `unknown simulation phase ${JSON.stringify(String(p))}` };
    }
    if (seen.has(p)) return { ok: false, message: `duplicate simulation phase "${p}"` };
    seen.add(p);
    const r = rank(p as SimulationPhase);
    if (r <= last) return { ok: false, message: `phases are not in canonical order (${SIMULATION_PHASE_ORDER.join(' → ')})` };
    last = r;
  }
  return { ok: true, phases: phases as readonly SimulationPhase[] };
}

/** Create an empty simulation-module registry. */
export function createSimulationRegistry(): SimulationRegistry {
  return { [SIM_REGISTRY_BRAND]: new Map() };
}

export function isSimulationRegistry(value: unknown): value is SimulationRegistry {
  return (
    typeof value === 'object' &&
    value !== null &&
    SIM_REGISTRY_BRAND in (value as object) &&
    (value as SimulationRegistry)[SIM_REGISTRY_BRAND] instanceof Map
  );
}

/**
 * Register a compile-time-linked module spec. Duplicate names and names
 * outside the name syntax are rejected at registration time
 * (`config_invalid`).
 */
export function registerSimulationModule(
  registry: SimulationRegistry,
  id: string,
  spec: SimulationModuleSpec,
): { ok: true } | { ok: false; error: RuntimeError } {
  if (!isSimulationRegistry(registry)) {
    return {
      ok: false,
      error: {
        code: 'config_invalid',
        reason: 'registry',
        message: 'registerSimulationModule: first argument is not a simulation registry',
      },
    };
  }
  if (typeof id !== 'string' || !MODULE_NAME_RE.test(id)) {
    return {
      ok: false,
      error: {
        code: 'config_invalid',
        reason: 'module_name',
        message: clipMessage(
          `module name must match ^thirdlight\\.[a-z0-9-]+:[a-z0-9_-]+$ (got ${JSON.stringify(String(id))})`,
        ),
      },
    };
  }
  const modules = registry[SIM_REGISTRY_BRAND];
  if (modules.has(id)) {
    return {
      ok: false,
      error: {
        code: 'config_invalid',
        reason: 'duplicate_module',
        message: `duplicate registration of module "${id}"`,
      },
    };
  }
  if (typeof spec?.create !== 'function') {
    return {
      ok: false,
      error: {
        code: 'config_invalid',
        reason: 'module_spec',
        message: `module spec for "${id}" must be { id, create(snapshot, cfg) }`,
      },
    };
  }
  if (spec.phases !== undefined) {
    const phaseCheck = validatePhaseList(spec.phases);
    if (!phaseCheck.ok) {
      return {
        ok: false,
        error: {
          code: 'config_invalid',
          reason: 'module_phases',
          message: `module "${id}": ${phaseCheck.message}`,
        },
      };
    }
  }
  modules.set(id, spec);
  return { ok: true };
}