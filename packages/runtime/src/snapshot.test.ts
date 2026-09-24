/**
 * Runtime snapshot validation tests (runtime.md §2).
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MODULES,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
} from './index';
import { baseScene, cloneJson, deepFreezeForTest, snapshotOf } from './test-helpers';

function registryWithDemo() {
  const r = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
  return r;
}

function badSnapshot(snapshot: unknown) {
  const res = instantiateRuntime({ snapshot, registry: registryWithDemo(), driver: { kind: 'manual' } });
  if (res.ok) throw new Error(`expected snapshot rejection, got ok: ${JSON.stringify(snapshot)}`);
  return res.error;
}

describe('snapshot validation (runtime.md §2)', () => {
  it('accepts a valid snapshot from a deep-frozen input and operates normally', () => {
    const scene = cloneJson(baseScene());
    const snapshot = deepFreezeForTest(snapshotOf(scene));
    const res = instantiateRuntime({ snapshot, registry: registryWithDemo(), driver: { kind: 'manual' } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Full run: start, 30 steps, stop — the frozen input must survive.
    let now = 0;
    const clock = () => now;
    expect(res.runtime.start().ok).toBe(true);
    res.runtime.tick(now); // anchor frame
    for (let i = 0; i < 30; i += 1) {
      now += 1 / 120;
      expect(res.runtime.tick(now).ok).toBe(true);
    }
    expect(res.runtime.stop().ok).toBe(true);
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify(snapshotOf(cloneJson(baseScene()))));
    expect(Object.isFrozen(snapshot as object)).toBe(true);
    const entity0 = (snapshot as { scene: { entities: Array<Record<string, unknown>> } }).scene.entities[0]!;
    const transform0 = (entity0.components as { transform: { position: unknown } }).transform;
    expect(Object.isFrozen(transform0.position)).toBe(true);
  });

  it('rejects a non-object snapshot (reason shape)', () => {
    for (const snap of ['nope', 42, null, [1]]) {
      const err = badSnapshot(snap);
      expect(err.code).toBe('snapshot_invalid');
      expect(err.reason).toBe('shape');
    }
  });

  it('rejects unknown wrapper fields (reason shape, path given)', () => {
    const snap = snapshotOf(baseScene()) as Record<string, unknown>;
    snap.extra = 1;
    const err = badSnapshot(snap);
    expect(err.code).toBe('snapshot_invalid');
    expect(err.reason).toBe('shape');
    expect(err.path).toBe('/extra');
  });

  it('rejects missing wrapper fields (reason shape, path given)', () => {
    for (const missing of ['snapshotId', 'projectId', 'revision', 'scene']) {
      const snap = cloneJson(snapshotOf(baseScene())) as Record<string, unknown>;
      delete snap[missing];
      const err = badSnapshot(snap);
      expect(err.code).toBe('snapshot_invalid');
      expect(err.reason).toBe('shape');
      expect(err.path).toBe(`/${missing}`);
    }
  });

  it('rejects bad projectId syntax', () => {
    for (const projectId of ['Demo', 'a'.repeat(65), 'x!', '']) {
      const scene = baseScene();
      const err = badSnapshot(snapshotOf(scene, projectId));
      expect(err.code).toBe('snapshot_invalid');
      expect(err.reason).toBe('shape');
      expect(err.path).toBe('/projectId');
    }
  });

  it('rejects non-integer / negative / > 2^53−1 revision', () => {
    for (const revision of [-1, 1.5, 2 ** 53, Number.MAX_SAFE_INTEGER + 1]) {
      const scene = cloneJson(baseScene());
      scene.revision = revision;
      const snap = { snapshotId: 'demo-0001@r0', projectId: 'demo-0001', revision, scene, game: null };
      const err = badSnapshot(snap);
      expect(err.code).toBe('snapshot_invalid');
      expect(err.reason).toBe('shape');
      expect(err.path).toBe('/revision');
    }
    // revision 0 and 2^53−1 are valid values (the scene would still have
    // to match) — only the bounds are tested here.
    const scene = cloneJson(baseScene());
    const okLow = instantiateRuntime({
      snapshot: { snapshotId: 'demo-0001@r4', projectId: 'demo-0001', revision: 4, scene, game: null },
      registry: registryWithDemo(),
      driver: { kind: 'manual' },
    });
    expect(okLow.ok).toBe(true);
  });

  it('rejects id_mismatch (snapshotId != <projectId>@r<revision>)', () => {
    // The wrapper is self-consistent (revision 5 == scene.revision 5) so
    // ONLY the snapshotId is wrong.
    const snap = {
      snapshotId: 'demo-0001@r4',
      projectId: 'demo-0001',
      revision: 5,
      scene: { ...cloneJson(baseScene()), revision: 5 },
      game: null,
    };
    const err = badSnapshot(snap);
    expect(err.code).toBe('snapshot_invalid');
    expect(err.reason).toBe('id_mismatch');
  });

  it('rejects revision_mismatch (revision != scene.revision)', () => {
    const snap = {
      snapshotId: 'demo-0001@r5',
      projectId: 'demo-0001',
      revision: 5,
      scene: cloneJson(baseScene()), // scene.revision 4
      game: null,
    };
    const err = badSnapshot(snap);
    expect(err.code).toBe('snapshot_invalid');
    expect(err.reason).toBe('revision_mismatch');
  });

  it('rejects invalid scenes carrying project-model errors (≤ 10 reported + total)', () => {
    const scene = cloneJson(baseScene());
    // 6 broken entities: 2 errors each (unknown component + bad number)
    // + the box/camera conflict on the last = well over 10 total.
    for (let i = 0; i < 6; i += 1) {
      (scene.entities as Array<Record<string, unknown>>).push({
        id: `bad-${String(i).padStart(4, '0')}`,
        components: {
          transform: { position: ['nope', 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          wobble: 1,
        },
      });
    }
    (scene.entities as Array<Record<string, unknown>>)[2]!.components = {
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      box: { size: [1, 1, 1], material: { color: '#ffffff' } },
      camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
    };
    const err = badSnapshot(snapshotOf(scene));
    expect(err.code).toBe('snapshot_invalid');
    expect(err.reason).toBe('scene_validation');
    expect(err.errorTotal).toBeGreaterThanOrEqual(11);
    expect(err.errors).toBeDefined();
    expect(err.errors!.length).toBeLessThanOrEqual(10);
    expect(err.errors!.length).toBe(10);
    for (const e of err.errors!) {
      expect(typeof e.code).toBe('string');
      expect(typeof e.path).toBe('string');
      expect(typeof e.message).toBe('string');
    }
  });

  it('never throws on arbitrary garbage configs', () => {
    for (const config of [null, 'x', 42, [], { snapshot: baseScene() }, { registry: 'nope' }]) {
      expect(() => instantiateRuntime(config)).not.toThrow();
      const res = instantiateRuntime(config);
      expect(res.ok).toBe(false);
    }
  });
});