/**
 * The runtime's config: the strict shape `instantiateRuntime` takes, checked
 * field by field before anything is built (an unknown or ill-typed field is
 * a `config_invalid` error naming its path).
 */
import { DEFAULT_FIXED_STEP_HZ, SAVE_LIMITS } from '@thirdlight/project-model';

import { NEUTRAL_ACTION_SOURCE, type ActionSource } from './actions';
import { clipMessage, type ErrorCode, type RuntimeError } from './errors';
import { defaultClock, hasRaf } from './frame-loop';
import type { PhysicsPort, PhysicsPort3D } from './ports';
import { isSimulationRegistry } from './registry';
import { SAVE_KEY_RE, SAVE_MAX_KEYS, SAVE_MAX_VALUE_CHARS, saveValueText } from './save-sections';
import type { SimulationRegistry } from './types';

const MIN_FIXED_STEP_HZ = 1;
const MAX_FIXED_STEP_HZ = 1000;
/** The default module selection. */
const DEFAULT_MODULES = ['thirdlight.demo:box-motion'];
/** The `config_invalid` reason for a physics-bearing set. */
export const PHYSICS_PORT_REASON = 'physics_port';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function fail(code: ErrorCode, message: string, extra?: Partial<RuntimeError>): RuntimeError {
  return { code, message: clipMessage(message), ...extra };
}

export function isPhysicsPort(v: unknown): v is PhysicsPort {
  return (
    isPlainObject(v) &&
    typeof v['stageCharacterMove'] === 'function' &&
    typeof v['step'] === 'function' &&
    typeof v['dispose'] === 'function'
  );
}

/** A 3D port carries `dimension: 3` (the 2D port has no such field). */
export function isPhysicsPort3D(v: unknown): v is PhysicsPort3D {
  return isPlainObject(v) && v['dimension'] === 3 && typeof v['stageCharacterMove'] === 'function' && typeof v['step'] === 'function' && typeof v['dispose'] === 'function';
}

/** Strict config parsing. */
export function parseConfig(config: unknown): { cfg: ParsedConfig } | { error: RuntimeError } {
  if (!isPlainObject(config)) {
    return { error: fail('config_invalid', 'config must be an object', { reason: 'shape', path: '' }) };
  }
  const allowed = new Set([
    'snapshot',
    'registry',
    'modules',
    'actions',
    'physics',
    'settings',
    'clock',
    'driver',
    'fixedStepHz',
    'onFrame',
    'variables',
    'startMode',
    'projectSettings',
  ]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      return {
        error: fail('config_invalid', `unknown config field "${key}" (strict shape)`, {
          reason: 'shape',
          path: `/${key}`,
        }),
      };
    }
  }
  if (!('snapshot' in config)) {
    return { error: fail('config_invalid', 'config field "snapshot" is required', { reason: 'missing', path: '/snapshot' }) };
  }
  if (!isSimulationRegistry(config.registry)) {
    return {
      error: fail('config_invalid', 'config field "registry" must be a simulation registry (createSimulationRegistry)', {
        reason: 'registry',
        path: '/registry',
      }),
    };
  }
  let modules: string[];
  if (config.modules === undefined) {
    modules = [...DEFAULT_MODULES];
  } else if (
    !Array.isArray(config.modules) ||
    config.modules.some((m) => typeof m !== 'string')
  ) {
    return { error: fail('config_invalid', 'config field "modules" must be an array of module ID strings', { reason: 'shape', path: '/modules' }) };
  } else {
    modules = [...(config.modules as string[])];
  }
  let actions: ActionSource;
  if (config.actions === undefined) {
    actions = NEUTRAL_ACTION_SOURCE;
  } else if (!isPlainObject(config.actions) || typeof config.actions['sample'] !== 'function') {
    return {
      error: fail('config_invalid', 'config field "actions" must be an ActionSource ({ sample(stepIndex) })', {
        reason: 'actions',
        path: '/actions',
      }),
    };
  } else {
    actions = config.actions as unknown as ActionSource;
  }
  let physics: PhysicsPort | undefined;
  let physics3d: PhysicsPort3D | undefined;
  if (config.physics !== undefined && isPhysicsPort3D(config.physics)) {
    // A 3D project's port (the runtime holds one or the other).
    physics3d = config.physics;
  } else if (config.physics !== undefined) {
    if (!isPhysicsPort(config.physics)) {
      return {
        error: fail('config_invalid', 'config field "physics" must be an initialized PhysicsPort', {
          reason: PHYSICS_PORT_REASON,
          path: '/physics',
        }),
      };
    }
    physics = config.physics;
  }
  let clock: () => number;
  let clockLabel: 'performance' | 'injected';
  if (config.clock !== undefined) {
    if (typeof config.clock !== 'function') {
      return { error: fail('config_invalid', 'config field "clock" must be a function () => seconds', { reason: 'shape', path: '/clock' }) };
    }
    clock = config.clock as () => number;
    clockLabel = 'injected';
  } else {
    const def = defaultClock();
    if (!def) {
      return { error: fail('config_invalid', 'no default clock available — inject a clock (monotonic seconds)', { reason: 'clock', path: '/clock' }) };
    }
    clock = def;
    clockLabel = 'performance';
  }
  let driverKind: 'raf' | 'manual';
  if (config.driver === undefined) {
    driverKind = hasRaf() ? 'raf' : 'manual';
  } else if (!isPlainObject(config.driver) || Object.keys(config.driver).length !== 1 || !(config.driver.kind === 'raf' || config.driver.kind === 'manual')) {
    return { error: fail('config_invalid', 'config field "driver" must be { kind: "raf" | "manual" }', { reason: 'shape', path: '/driver' }) };
  } else if (config.driver.kind === 'raf' && !hasRaf()) {
    return { error: fail('config_invalid', 'the "raf" driver requires requestAnimationFrame (absent in this environment)', { reason: 'driver', path: '/driver' }) };
  } else {
    driverKind = config.driver.kind;
  }
  let hz = DEFAULT_FIXED_STEP_HZ;
  if (config.fixedStepHz !== undefined) {
    if (
      typeof config.fixedStepHz !== 'number' ||
      !Number.isInteger(config.fixedStepHz) ||
      config.fixedStepHz < MIN_FIXED_STEP_HZ ||
      config.fixedStepHz > MAX_FIXED_STEP_HZ
    ) {
      return { error: fail('config_invalid', `config field "fixedStepHz" must be an integer in [${MIN_FIXED_STEP_HZ}, ${MAX_FIXED_STEP_HZ}]`, { reason: 'shape', path: '/fixedStepHz' }) };
    }
    hz = config.fixedStepHz;
  }
  let onFrame: (() => void) | undefined;
  if (config.onFrame !== undefined) {
    if (typeof config.onFrame !== 'function') {
      return { error: fail('config_invalid', 'config field "onFrame" must be a function', { reason: 'shape', path: '/onFrame' }) };
    }
    onFrame = config.onFrame as () => void;
  }
  // Injected script variables (ctx.save from step 0), under ctx.save's own rules.
  let variables: Record<string, unknown> | undefined;
  if (config.variables !== undefined) {
    const v = config.variables;
    if (!isPlainObject(v) || Object.keys(v).length > SAVE_MAX_KEYS) {
      return { error: fail('config_invalid', `config field "variables" must map at most ${SAVE_MAX_KEYS} keys to JSON values`, { reason: 'shape', path: '/variables' }) };
    }
    variables = {};
    for (const [k, value] of Object.entries(v)) {
      const text = saveValueText(value);
      if (!SAVE_KEY_RE.test(k) || text === null) {
        return { error: fail('config_invalid', `variable ${JSON.stringify(k.slice(0, 64))}: a key is 1-64 of A-Z a-z 0-9 _ . : - and a value JSON of at most ${SAVE_MAX_VALUE_CHARS} characters`, { reason: 'shape', path: `/variables/${k.slice(0, 64)}` }) };
      }
      variables[k] = JSON.parse(text) as unknown;
    }
  }
  // The game mode runs start in (checked against the snapshot's modes at instantiate).
  const startMode = config.startMode;
  if (startMode !== undefined && (typeof startMode !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(startMode))) {
    return { error: fail('config_invalid', 'config field "startMode" must be a game mode id', { reason: 'shape', path: '/startMode' }) };
  }
  // The stored project settings document (checked field by field against the save schema by the runtime).
  let projectSettings: Record<string, unknown> | undefined;
  if (config.projectSettings !== undefined) {
    if (!isPlainObject(config.projectSettings) || Object.keys(config.projectSettings).length > SAVE_LIMITS.settingsFields) {
      return { error: fail('config_invalid', `config field "projectSettings" must map at most ${SAVE_LIMITS.settingsFields} keys to values`, { reason: 'shape', path: '/projectSettings' }) };
    }
    projectSettings = { ...(config.projectSettings as Record<string, unknown>) };
  }
  return {
    cfg: {
      snapshot: config.snapshot,
      registry: config.registry as SimulationRegistry,
      modules,
      actions,
      physics,
      ...(physics3d !== undefined ? { physics3d } : {}),
      settings: config.settings,
      clock,
      clockLabel,
      driverKind,
      hz,
      onFrame,
      ...(variables !== undefined ? { variables } : {}),
      ...(startMode !== undefined ? { startMode } : {}),
      ...(projectSettings !== undefined ? { projectSettings } : {}),
    },
  };
}

export interface ParsedConfig {
  snapshot: unknown;
  registry: SimulationRegistry;
  modules: string[];
  actions: ActionSource;
  physics?: PhysicsPort;
  /** The 3D port (instead of `physics`). */
  physics3d?: PhysicsPort3D;
  settings: unknown;
  clock: () => number;
  clockLabel: 'performance' | 'injected';
  driverKind: 'raf' | 'manual';
  hz: number;
  onFrame?: () => void;
  variables?: Record<string, unknown>;
  startMode?: string;
  projectSettings?: Record<string, unknown>;
}
