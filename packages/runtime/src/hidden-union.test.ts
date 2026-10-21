/**
 * What the renderer hides is one set: the objects scripts hid
 * (`ctx.game.setVisible`) joined with the objects switched off. A one-for-one
 * swap (hide one, show another in the same step) keeps the hidden set's size,
 * so the joined set must follow its members, not its size.
 */
import { describe, expect, it } from 'vitest';

import { createBehaviorModuleSpec, createSimulationRegistry, instantiateRuntime, neutralFrame, registerSimulationModule } from './index';

const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number): unknown => ({ position: [x, 0, 0], ...T });
const box = { size: [1, 1, 1], material: { color: '#808080' } };

interface Ctx {
  stepIndex: number;
  game: { setVisible(id: string, visible: boolean): void };
  entity(id: string): { set(component: string, value: unknown): void };
}

function run(script: (ctx: Ctx) => void) {
  const spec = createBehaviorModuleSpec({
    declaration: { properties: [] } as never,
    artifact: {
      behaviorId: 'driver',
      sourceDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      outputDigest: 'c'.repeat(64),
      ownedTransforms: [],
      requiredModules: [],
      enginePins: [],
      namespace: { default: { instantiate: () => ({}), step: (_s: unknown, ctx: Ctx) => script(ctx) } },
    } as never,
  });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'swap@r1',
      projectId: 'swap',
      revision: 1,
      scene: {
        schemaVersion: 4,
        sceneId: 'scene-main',
        revision: 1,
        entities: [
          { id: 'cam-main', components: { transform: { position: [0, 2, 10], ...T }, camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
          { id: 'driver-1', components: { transform: at(0), behavior: { behaviorId: 'driver', values: {} } } },
          { id: 'night-1', components: { transform: at(1), box } },
          { id: 'model-a', components: { transform: at(2), box } },
          { id: 'model-b', visible: false, components: { transform: at(3), box } },
        ],
      },
      scenes: [{ sceneId: 'scene-main', start: true }],
    } as never,
    registry,
    modules: [spec.id],
    actions: { sample: (i: number) => neutralFrame(i) },
    settings: {},
    clock: () => now.t,
    driver: { kind: 'manual' },
  } as never);
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  expect(rt.start().ok).toBe(true);
  const tick = (n: number): void => {
    for (let i = 0; i < n; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify((rt.getDiagnostics() as { diagnostics: { errors: unknown[] } }).diagnostics.errors)}`);
    }
  };
  return { rt, tick };
}

describe('the hidden set the renderer reads', () => {
  it('a one-for-one swap in one step (with objects switched off) shows the new object and hides the old one', () => {
    let swapAt = -1;
    let last = 0;
    const h = run((ctx) => {
      last = ctx.stepIndex;
      if (ctx.stepIndex === 2) ctx.entity('night-1').set('object', { active: false });
      if (ctx.stepIndex === swapAt) {
        ctx.game.setVisible('model-a', false);
        ctx.game.setVisible('model-b', true);
      }
    });
    h.tick(10);
    const before = h.rt.hiddenEntities!();
    expect([...before].sort()).toEqual(['model-b', 'night-1']);
    swapAt = last + 5;
    h.tick(30);
    expect([...h.rt.hiddenEntities!()].sort()).toEqual(['model-a', 'night-1']);
  });
});
