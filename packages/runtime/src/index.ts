/**
 * @thirdlight/runtime — public surface (dependencies.md §3 row:
 * `instantiateRuntime`, `createSimulationRegistry`,
 * `registerSimulationModule`, `BUILTIN_MODULES`, types (snapshot,
 * diagnostics, module interfaces), `ERROR_CODES`).
 *
 * Thirdlight M1 play/runtime core (docs/contracts/runtime.md, packet 08):
 * the runtime snapshot input (strict, re-validated, deep-frozen), the
 * instantiate/start/stop/dispose lifecycle with a single frame-driver
 * owner, the separate mutable simulation state, fixed-step scheduling
 * with bounded catch-up (120 Hz, MAX_CATCHUP_STEPS 8, drop-and-resync),
 * the read-only render interpolation policy, the built-in moving-box
 * demonstration (`thirdlight.demo:box-motion`), and structured
 * diagnostics.
 *
 * Pure core (dependencies.md §4.1): imports `@thirdlight/project-model`
 * only — no three.js, no Node built-ins, no I/O. Runs unmodified in the
 * play-preview bundle, the export bundle, and the Node test harness
 * (runtime.md §9).
 */
export { ERROR_CODES, type ErrorCode, type RuntimeError } from './errors';
export {
  type CameraInfo,
  type DiagnosticErrorEntry,
  type InstantiateConfig,
  type InterpolatedState,
  type InterpolatedTransform,
  type ModuleConfig,
  type Runtime,
  type RuntimeDiagnostics,
  type RuntimeSnapshot,
  type RuntimeStateName,
  type SimEntityData,
  type SimState,
  type SimulationModule,
  type SimulationModuleSpec,
  type SimulationRegistry,
  type TransformState,
} from './types';
export { BUILTIN_MODULES, createSimulationRegistry, registerSimulationModule } from './registry';
export { instantiateRuntime } from './runtime';