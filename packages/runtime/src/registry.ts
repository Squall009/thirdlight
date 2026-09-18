/**
 * Simulation-module registry — dependencies.md §6 (narrow; normative).
 *
 * The ONLY M1 extension point. Registration happens in engine source, at
 * build time: no string-to-code resolution, no dynamic `import` of
 * project content, no file- or URL-sourced modules. Name syntax:
 * `^thirdlight\.[a-z0-9]+:[a-z0-9-]+$`. Duplicate registration ⇒
 * `config_invalid` (rejected at registration time).
 */
import { clipMessage, type RuntimeError } from './errors';
import { boxMotionSpec } from './demo';
import {
  SIM_REGISTRY_BRAND,
  type SimulationModuleSpec,
  type SimulationRegistry,
} from './types';

/** M1 registry contents: exactly one built-in module (runtime.md §7). */
export const BUILTIN_MODULES: readonly SimulationModuleSpec[] = [boxMotionSpec];

const MODULE_NAME_RE = /^thirdlight\.[a-z0-9]+:[a-z0-9-]+$/;

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
          `module name must match ^thirdlight\\.[a-z0-9]+:[a-z0-9-]+$ (got ${JSON.stringify(String(id))})`,
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
  modules.set(id, spec);
  return { ok: true };
}