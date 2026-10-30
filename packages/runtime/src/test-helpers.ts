/**
 * Test-only fixture/helpers for the runtime test suite (NOT part of the
 * package's public surface — not exported from index.ts, imported only
 * by .test.ts files; same pattern as project-model's test-fixtures.ts).
 */
import type { SimState, SimulationModule, SimulationModuleSpec, RuntimeSnapshot } from './types';

/** A valid v4 scene: one camera shot, one group, one
 *  box under the group (parent before child). */
export function baseScene(): {
  schemaVersion: 4;
  sceneId: string;
  revision: number;
  entities: unknown[];
} {
  return {
    schemaVersion: 4,
    sceneId: 'scene-main',
    revision: 4,
    entities: [
      {
        id: 'cam-main',
        name: 'Main Camera',
        components: {
          transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          virtualCamera: { rig: 'fixed' },
        },
      },
      {
        id: 'group-0001',
        components: {
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
      },
      {
        id: 'box-0001',
        parentId: 'group-0001',
        components: {
          transform: { position: [0.5, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          box: { size: [0.2, 0.2, 0.2], material: { color: '#ff8800' } },
        },
      },
    ],
  };
}

/** A well-formed runtime snapshot over `scene`. */
export function snapshotOf(scene: { revision: number }, projectId = 'demo-0001'): unknown {
  const revision = scene.revision;
  return {
    snapshotId: `${projectId}@r${revision}`,
    projectId,
    revision,
    scene,
  };
}

/** Plain JSON clone (test inputs are JSON-able). */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The box entity's authored x (the demo's x0). */
export const BOX_X0 = 0.5;
export const BOX_ID = 'box-0001';
export const GROUP_ID = 'group-0001';
export const CAM_ID = 'cam-main';
/** The moving-box test module's id. */
export const BOX_MOTION_ID = 'thirdlight.demo:box-motion';
/** Its half-amplitude on X (m) and period (s). */
export const BOX_MOTION_AMPLITUDE = 0.5;
export const BOX_MOTION_PERIOD_SECONDS = 4.0;

/**
 * A module that declares no phases (it runs in the implicit transform phase), for tests that need
 * something to move: every `box` entity's x is x0 + A · sin(2π · (stepIndex + 1) / (hz · T)), a pure
 * function of the step, so catch-up drops and interpolation have exact expected values.
 */
export const boxMotionSpec: SimulationModuleSpec = {
  id: BOX_MOTION_ID,
  create(snapshot: RuntimeSnapshot, cfg: { fixedStepHz: number }): SimulationModule {
    const stepDenominator = cfg.fixedStepHz * BOX_MOTION_PERIOD_SECONDS;
    const boxes: ReadonlyArray<readonly [string, number]> = snapshot.scene.entities
      .filter((e) => e.components.box !== undefined)
      .map((e) => [e.id, e.components.transform.position[0]] as const);
    return {
      step(state: SimState, stepIndex: number): void {
        for (const [id, x0] of boxes) {
          const t = state.curr.get(id);
          if (t) t.position[0] = x0 + BOX_MOTION_AMPLITUDE * Math.sin((2 * Math.PI * (stepIndex + 1)) / stepDenominator);
        }
      },
    };
  },
};
