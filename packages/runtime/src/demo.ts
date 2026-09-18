/**
 * The built-in moving-box demonstration — runtime.md §7 (M1's only
 * gameplay behavior; the only M1 built-in simulation module).
 *
 * Exact behavior (normative math, §7.1): for every entity with a `box`
 * component, at each step the module sets, in the mutable state only:
 *
 *   x(stepIndex) = x0 + A · sin(2 · π · (stepIndex + 1) / (SIM_HZ · T))
 *
 * with A = 0.5 m, T = 4.0 s, SIM_HZ = the instance step rate (§3.1).
 * `position.y/z`, `rotation`, `scale` are unchanged; non-box entities
 * (groups, the camera) are never moved. Pure function of (snapshot,
 * stepIndex): no randomness, no wall-clock input, no cross-step memory —
 * catch-up drops are exact (§5.2). Bit-exact within the same JS engine
 * (§7.3).
 *
 * §7.3 (normative non-goal): no user scripts — this module is
 * compile-time-linked through the narrow registry (dependencies.md §6).
 */
import type {
  RuntimeSnapshot,
  SimState,
  SimulationModule,
  SimulationModuleSpec,
} from './types';

/** Module ID (runtime.md §7; dependencies.md §6 name syntax). */
export const DEMO_MODULE_ID = 'thirdlight.demo:box-motion';

/** A = 0.5 m (half-amplitude of the X oscillation, §7.1). */
export const DEMO_AMPLITUDE = 0.5;
/** T = 4.0 s (period, §7.1). */
export const DEMO_PERIOD_SECONDS = 4.0;

const TAU = 2 * Math.PI;

export const boxMotionSpec: SimulationModuleSpec = {
  id: DEMO_MODULE_ID,
  /**
   * One instance per runtime instance (created at instantiate, §3.1).
   * Closes over the snapshot's box entities (their x0 and document order);
   * the snapshot is deep-frozen and read-only.
   */
  create(snapshot: RuntimeSnapshot, cfg: { fixedStepHz: number }): SimulationModule {
    const hz = cfg.fixedStepHz;
    const stepDenominator = hz * DEMO_PERIOD_SECONDS;
    const boxes: ReadonlyArray<readonly [string, number]> = snapshot.scene.entities
      .filter((e) => e.components.box !== undefined)
      .map((e) => [e.id, e.components.transform.position[0]] as const);
    return {
      step(state: SimState, stepIndex: number): void {
        for (const [id, x0] of boxes) {
          const t = state.curr.get(id);
          if (!t) continue;
          t.position[0] =
            x0 + DEMO_AMPLITUDE * Math.sin((TAU * (stepIndex + 1)) / stepDenominator);
        }
      },
    };
  },
};