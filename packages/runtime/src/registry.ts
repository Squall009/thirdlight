/**
 * Simulation-module registry — dependencies.md §6 (narrow; normative).
 *
 * The ONLY M1 extension point. Registration happens in engine source, at
 * build time: no string-to-code resolution, no dynamic `import` of
 * project content, no file- or URL-sourced modules. Name syntax:
 * `^thirdlight\.[a-z0-9-]+:[a-z0-9-]+$`. Duplicate registration ⇒
 * `config_invalid` (rejected at registration time).
 *
 * CC-49-3: the first segment admits hyphens (package-style names). The
 * promoted M3 contracts pin the module IDs `thirdlight.platformer-game:session`
 * / `thirdlight.platformer-game:camera` (gameplay.md, runtime.md §12.1
 * inventory, delivery.md module catalog, the `platformer-game` package) while
 * the carried-over M1 name syntax `^thirdlight\.[a-z0-9]+:[a-z0-9-]+$` rejects
 * them. The module ID is the specific pin; the minimal additive resolution is
 * to widen the first segment to `[a-z0-9-]+`. Additive: every M1/M2 name
 * still matches and no test pins the rejection. See the packet-49 handoff.
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

/** The accepted M2 controller module ID (runtime.md §12.1 inventory). */
export const PLATFORMER_MODULE_ID = 'thirdlight.platformer:controller';

/**
 * The built-in M1 demo spec. Its `excludes`/`legacyTransformOwners` metadata
 * implements runtime.md §12.1/§12.4 when the demo participates in an M2 set
 * (the demo owns every `box` entity and cannot coexist with the controller
 * module). The demo's `create` and step math are byte-identical to the
 * accepted M1 implementation.
 */
const demoBuiltinSpec: SimulationModuleSpec = {
  id: DEMO_MODULE_ID,
  excludes: [PLATFORMER_MODULE_ID],
  legacyTransformOwners: (snapshot) =>
    snapshot.scene.entities.filter((e) => e.components.box !== undefined).map((e) => e.id),
  create: (snapshot, cfg) => boxMotionSpec.create(snapshot, cfg),
};

/** M1 registry contents: exactly one built-in module (runtime.md §7). */
export const BUILTIN_MODULES: readonly SimulationModuleSpec[] = [demoBuiltinSpec];

const MODULE_NAME_RE = /^thirdlight\.[a-z0-9-]+:[a-z0-9-]+$/;

/**
 * Validate a declared phase list (runtime.md §12.1): non-empty, no
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

/** Create an empty simulation-module registry (dependencies.md §6). */
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
 * outside the §6 syntax are rejected at registration time
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
          `module name must match ^thirdlight\\.[a-z0-9-]+:[a-z0-9-]+$ (got ${JSON.stringify(String(id))})`,
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