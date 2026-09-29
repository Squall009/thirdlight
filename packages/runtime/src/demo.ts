/**
 * The built-in moving-box demonstration (the only built-in module of an
 * M1 set, one whose modules declare no phases).
 *
 * Exact behavior (normative math): for every entity with a `box`
 * component, at each step the module sets, in the mutable state only:
 *
 *   x(stepIndex) = x0 + A · sin(2 · π · (stepIndex + 1) / (SIM_HZ · T))
 *
 * with A = 0.5 m, T = 4.0 s, SIM_HZ = the instance step rate.
 * `position.y/z`, `rotation`, `scale` are unchanged; non-box entities
 * (groups, the camera) are never moved. Pure function of (snapshot,
 * stepIndex): no randomness, no wall-clock input, no cross-step memory —
 * catch-up drops are exact. Bit-exact within the same JS engine.
 *
 * No user scripts: this module is compile-time-linked through the narrow registry.
 */
import type {
  RuntimeSnapshot,
  SimState,
  SimulationModule,
  SimulationModuleSpec,
} from './types';

/** Module ID (the registry's name syntax). */
export const DEMO_MODULE_ID = 'thirdlight.demo:box-motion';

/** A = 0.5 m (half-amplitude of the X oscillation). */
export const DEMO_AMPLITUDE = 0.5;
/** T = 4.0 s (period). */
export const DEMO_PERIOD_SECONDS = 4.0;

const TAU = 2 * Math.PI;

export const boxMotionSpec: SimulationModuleSpec = {
  id: DEMO_MODULE_ID,
  /**
   * One instance per runtime instance (created at instantiate).
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