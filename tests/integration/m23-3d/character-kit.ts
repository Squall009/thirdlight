/**
 * Phase 23.2: neutral 3D scenes for the character controller tests — a floor
 * (top at y = 0) and whatever blocks a test adds, a player capsule (the
 * default 0.3 m × 1.8 m) standing on the floor, run through the production
 * game host with the manifest's 3D module set and a recorded input.
 */
import { physics3DConfigOf, type ActionFrame } from '@thirdlight/runtime';

import { stepDigest } from '@thirdlight/game-host';

import { startHarness, type Harness, type Mode } from '../m22-worker/harness';

export type Any = any;
export const HZ = 120;
export const DT = 1 / HZ;
export const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 };
/** The manifest module set of a 3D project with a controller (project-model's resolution). */
export const MODULES_3D = ['thirdlight.character3d:controller', 'thirdlight.input:keyboard-gamepad', 'thirdlight.physics-rapier:3d'];
export const T = (position: number[], rotation: number[] = [0, 0, 0, 1], scale: number[] = [1, 1, 1]) => ({ position, rotation, scale });
export const tiltZ = (deg: number) => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];
/** The capsule origin's height standing on y = 0 (half its 1.8 m height, plus the skin). */
export const STAND_Y = 0.91;

/** A box collider (centre, half extents) as an entity. */
export function block(id: string, center: number[], half: number[], rotation?: number[]): Any {
  return { id, components: { transform: T(center, rotation), box: { size: [half[0]! * 2, half[1]! * 2, half[2]! * 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: half[0], hy: half[1], hz: half[2] } } } };
}

export function sceneOf(controller: Any, start: number[], extra: Any[], id = 'c3d'): { snapshot: Any; physics: Any; entities: Any[] } {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 6, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T(start), controller } },
    block('floor-0001', [0, -0.5, 0], [30, 0.5, 30]),
    ...extra,
  ];
  return {
    entities,
    snapshot: { snapshotId: `${id}@r1`, projectId: id, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities } },
    physics: physics3DConfigOf(entities, SETTINGS),
  };
}

/** A held move for `steps` steps from step 0 (then released), optional per-step overrides. */
export function holdMove(steps: number, moveX: number, moveY: number, extra: (i: number) => Partial<ActionFrame> = () => ({})): ActionFrame[] {
  const out: ActionFrame[] = [];
  for (let i = 0; i < steps; i += 1) out.push({ stepIndex: i, moveX, moveY, jump: 'none', ...extra(i) } as ActionFrame);
  return out;
}

export interface Run {
  h: Harness;
  digests: string[];
  /** The player's committed transform. */
  player: { position: number[]; rotation: number[] };
  errors: Any[];
  /** The player origin and grounding (1/0) after every step (single mode only). */
  path: number[][];
}

/** Run a scene with a recorded input until `steps` steps executed. */
export async function runScene(mode: Mode, scene: { snapshot: Any; physics: Any }, replay: readonly ActionFrame[], steps: number, extra: Record<string, unknown> = {}, cameraYaw?: number): Promise<Run> {
  const h = await startHarness(mode, { snapshot: scene.snapshot, settings: SETTINGS, physics: scene.physics, digestSteps: true, replay, modules: MODULES_3D, host: { buildId: 'b' }, ...extra });
  // The camera framework's yaw input (phase 23.4 provides it; a test sets it on the page runtime).
  if (cameraYaw !== undefined) (h.rt as Any).cameraYawSource = () => cameraYaw;
  const path: number[][] = [];
  if (mode === 'single') {
    const rt = h.rt;
    const digests = h.digests;
    // Keep the digest watcher and record the path too.
    rt.setStepWatcher?.(() => {
      digests.push(stepDigest(rt));
      // The committed result (the runtime's last 3D character result): x, y, z and grounded (1/0).
      const c = rt.lastCharacterResult3D;
      if (c !== undefined) path.push([c.position.x, c.position.y, c.position.z, c.grounded ? 1 : 0]);
      return false;
    });
  }
  let now = 10;
  let i = 0;
  while (h.digests.length < steps) {
    const n = [1, 2, 0, 3, 1][i++ % 5]!;
    now += n * DT + DT * 0.1 * ((i % 3) - 1);
    await h.tick(now);
  }
  const t = h.rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === 'player-0001');
  const d = h.rt.getDiagnostics();
  return { h, digests: [...h.digests], player: { position: [...t.position], rotation: [...t.rotation] }, errors: d.ok ? d.diagnostics.errors : [d], path };
}
