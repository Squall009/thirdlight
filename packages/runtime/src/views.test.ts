/**
 * The engine owns the view: the camera brain resolves the pose and lens the
 * renderer draws with, every step, whatever the scene holds — the live shot,
 * a scene camera of an older snapshot (as its shot), or the default pose with
 * the project's lens while nothing is live (warned). Every view read takes a
 * view key; one view exists.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_VIEW_ID, DEFAULT_VIEW_POSE } from '@thirdlight/project-model';

import { BUILTIN_MODULES, createSimulationRegistry, instantiateRuntime, registerSimulationModule, type Runtime } from './index';

const DT = 1 / 120;
const T = (position: number[], rotation: number[] = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });
const box = { id: 'box-000001', components: { transform: T([0, 0.5, 0]), box: { size: [1, 1, 1], material: { color: '#808080' } } } };

function runtimeOf(entities: unknown[], settings: Record<string, number> = {}): Runtime {
  const registry = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(registry, spec.id, spec);
  const res = instantiateRuntime({
    snapshot: { snapshotId: 'views@r1', projectId: 'views', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities } },
    registry,
    modules: [],
    driver: { kind: 'manual' },
    clock: () => 0,
    settings: { settings },
  });
  if (!res.ok) throw new Error(JSON.stringify(res.error));
  res.runtime.start();
  res.runtime.tick(0);
  return res.runtime;
}

function diagnostics(rt: Runtime) {
  const d = rt.getDiagnostics();
  if (!d.ok) throw new Error('no diagnostics');
  return d.diagnostics;
}

function steps(rt: Runtime, n: number): void {
  const r = rt.tick(diagnostics(rt).simTime + n * DT + DT / 2);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
}

const warnings = (rt: Runtime): string[] => diagnostics(rt).errors.filter((e) => e.code === 'behavior_log' && e.reason === 'warn').map((e) => e.message);

describe('the engine-owned view', () => {
  it('with no camera the view holds the default pose with the project\'s lens, and says so once', () => {
    const rt = runtimeOf([box], { camera_fov_deg: 75, camera_near_m: 0.25, camera_far_m: 500 });
    // Before the first step the renderer already has a pose: the default one.
    const pos = [9, 9, 9];
    const rot = [9, 9, 9, 9];
    expect(rt.readCameraView!(pos, rot)).toEqual({ fovY: 75, near: 0.25, far: 500, letterbox: 0 });
    expect(pos).toEqual([...DEFAULT_VIEW_POSE.position]);
    expect(rot).toEqual([...DEFAULT_VIEW_POSE.rotation]);
    steps(rt, 10);
    const view = rt.cameraView!()!;
    expect(view.live).toBeNull();
    expect(view.position).toEqual([...DEFAULT_VIEW_POSE.position]);
    expect([view.fovY, view.near, view.far]).toEqual([75, 0.25, 500]);
    expect(rt.getCamera()).toEqual({ ok: true, camera: { id: DEFAULT_VIEW_ID, fovY: 75, near: 0.25, far: 500 } });
    expect(warnings(rt).filter((m) => m.includes('no virtual camera is live'))).toHaveLength(1);
    // The view is keyed: the main view by name, an unknown view is none.
    expect(rt.cameraView!(DEFAULT_VIEW_ID)).toEqual(view);
    expect(rt.cameraView!('split-2')).toBeNull();
    expect(rt.readCameraView!(pos, rot, 'split-2')).toBeNull();
    rt.dispose();
  });

  it('a live shot owns the view; a camera without a lens uses the project\'s, one with a lens its own', () => {
    const shot = { id: 'cam-000001', components: { transform: T([2, 3, 8]), virtualCamera: { rig: 'fixed' } } };
    const close = { id: 'cam-000002', components: { transform: T([0, 1, 2]), virtualCamera: { rig: 'fixed', priority: 5, enabled: false, fovY: 30, far: 40, blend: 'cut' } } };
    const rt = runtimeOf([box, shot, close], { camera_fov_deg: 50 });
    steps(rt, 5);
    let view = rt.cameraView!()!;
    expect(view.live).toBe('cam-000001');
    expect(view.position).toEqual([2, 3, 8]);
    expect([view.fovY, view.near, view.far]).toEqual([50, 0.1, 100]);
    expect(warnings(rt)).toEqual([]);
    rt.dispose();
    // The close-up enabled at the start wins on priority: its own lens.
    const rt2 = runtimeOf([box, shot, { ...close, components: { ...close.components, virtualCamera: { ...close.components.virtualCamera, enabled: true } } }], { camera_fov_deg: 50 });
    steps(rt2, 5);
    view = rt2.cameraView!()!;
    expect(view.live).toBe('cam-000002');
    expect([view.fovY, view.near, view.far]).toEqual([30, 0.1, 40]);
    rt2.dispose();
  });

  it('a scene camera of an older snapshot plays as the lowest-priority shot with its own lens', () => {
    const old = { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 45, near: 0.5, far: 300 } } };
    const follow = { id: 'cam-000003', components: { transform: T([0, 0, 0]), virtualCamera: { rig: 'fixed', enabled: false } } };
    const rt = runtimeOf([old, box, follow]);
    steps(rt, 5);
    const view = rt.cameraView!()!;
    expect(view.live).toBe('cam-main');
    expect(view.position).toEqual([0, 4, 12]);
    expect([view.fovY, view.near, view.far]).toEqual([45, 0.5, 300]);
    expect(warnings(rt)).toEqual([]);
    rt.dispose();
    // Any camera of the scene goes live over it (it is the lowest priority).
    const rt2 = runtimeOf([old, box, { ...follow, components: { ...follow.components, virtualCamera: { rig: 'fixed' } } }]);
    steps(rt2, 5);
    expect(rt2.cameraView!()!.live).toBe('cam-000003');
    rt2.dispose();
  });
});
