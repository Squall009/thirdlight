/**
 * Phase 12 (b): scripts query objects by tag. The runtime loads a v3 scene
 * with folders and a tag registry, resolves effective masks once (own OR every
 * folder above; inactive entities left out), and a behavior sees them through
 * `ctx.tags` in `instantiate` and `step`.
 */
import { describe, expect, it } from 'vitest';

import {
  createBehaviorModuleSpec,
  createSimulationRegistry,
  createTagQuery,
  instantiateRuntime,
  registerSimulationModule,
  resolveSnapshotHierarchy,
  type BehaviorArtifact,
  type SimulationPhaseModule,
  type BehaviorTagQuery,
  type RuntimeSnapshot,
} from './index';

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const BOX = { size: [1, 1, 1], material: { color: '#ffffff' } };
const TAGS = [
  { bit: 0, name: 'hazard' },
  { bit: 4, name: 'pickup' },
];

/** Hazards folder (hazard) > spike; lava (own hazard + pickup); Off folder (inactive) > buried (hazard); scripted box. */
function scene(): unknown {
  return {
    schemaVersion: 3,
    sceneId: 'scene-main',
    revision: 1,
    entities: [
      { id: 'cam-main', components: { transform: T, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } },
      { id: 'folder-0001', name: 'Hazards', tags: 0b1, components: { folder: {} } },
      { id: 'box-0001', name: 'spike', parentId: 'folder-0001', components: { transform: T, box: BOX } },
      { id: 'box-0002', name: 'lava', tags: 0b10001, components: { transform: T, box: BOX } },
      { id: 'folder-0002', name: 'Off', active: false, components: { folder: {} } },
      { id: 'box-0003', name: 'buried', parentId: 'folder-0002', tags: 0b1, components: { transform: T, box: BOX } },
      { id: 'box-0004', name: 'scripted', components: { transform: T, box: BOX, behavior: { behaviorId: 'behavior-0001', values: { speed: 1 } } } },
    ],
  };
}

const snapshot = (): RuntimeSnapshot =>
  ({ snapshotId: 'demo-0001@r1', projectId: 'demo-0001', revision: 1, scene: scene(), game: null, tags: TAGS }) as unknown as RuntimeSnapshot;

describe('ctx.tags', () => {
  it('a behavior queries by tag mask in instantiate and step (effective masks, inactive left out)', () => {
    const seen: { instantiate?: unknown; step?: unknown } = {};
    const art: BehaviorArtifact = {
      behaviorId: 'behavior-0001',
      sourceDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      outputDigest: 'c'.repeat(64),
      ownedTransforms: [],
      requiredModules: [],
      enginePins: [],
      namespace: {
        default: {
          instantiate: (_p: unknown, inst: { tags: BehaviorTagQuery }) => {
            seen.instantiate = inst.tags.query(inst.tags.mask('hazard'));
            return {};
          },
          step: (_s: unknown, ctx: { tags: BehaviorTagQuery }) => {
            const t = ctx.tags;
            seen.step = {
              any: t.query(t.mask('Hazard', 'pickup')),
              all: t.query(t.mask('hazard', 'pickup'), 'all'),
              lava: t.of('box-0002'),
              spikeIsHazard: t.has('box-0001', t.mask('hazard')),
            };
          },
        },
      },
    };
    const spec = createBehaviorModuleSpec({ declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 10, step: 1 }] }, artifact: art });
    // The snapshot as the runtime loads it (folders + inactive resolved away),
    // then the behavior module over it — the game-module composition around a
    // v3 scene is exercised end to end by the Play e2e.
    const loaded = resolveSnapshotHierarchy(snapshot());
    const settings = { gravity_y: -20, run_speed: 6, jump_velocity: 9, max_fall_speed: 20, max_slope_climb_deg: 50, min_slope_slide_deg: 40 };
    const mod = spec.create(loaded, { fixedStepHz: 120, settings, sceneVersion: 3, game: null }) as SimulationPhaseModule;
    const ctx = { stepIndex: 0, phase: 'intent', action: {}, settings, physics: {}, state: {}, intents: Object.freeze([]), emit: () => undefined };
    mod.step('intent', ctx as never);
    expect(seen.instantiate).toEqual(['box-0001', 'box-0002']);
    expect(seen.step).toEqual({ any: ['box-0001', 'box-0002'], all: ['box-0002'], lava: 0b10001, spikeIsHazard: true });
  });

  it('unknown names and a bad match mode fail loudly; the snapshot registry is validated', () => {
    const q = createTagQuery(snapshot());
    expect(() => q.mask('ghost')).toThrow(/unknown tag "ghost"/);
    expect(() => q.query(1, 'some' as never)).toThrow(/any" or "all/);
    const registry = createSimulationRegistry();
    const bad = instantiateRuntime({
      snapshot: { ...snapshot(), tags: [{ bit: 40, name: 'x' }] } as unknown as RuntimeSnapshot,
      registry,
      modules: [],
      driver: { kind: 'manual' },
      clock: () => 0,
    });
    expect(bad.ok).toBe(false);
  });
});
