/**
 * `ctx.lighting` in a real runtime: the page's reports (the stats with their
 * lighting part, sent again as soon as the lighting changes) reach scripts;
 * `justSettled` is true in exactly the step after a report that the light
 * settled, and again only after it went unsettled and settled once more.
 */
import { describe, expect, it } from 'vitest';

import { createBehaviorModuleSpec, createSimulationRegistry, ENGINE_STATS_NONE, instantiateRuntime, neutralFrame, registerSimulationModule, type BehaviorContext, type Runtime } from './index';

const HZ = 60;
const DT = 1 / HZ;
const at = (x: number, y: number, z = 0): { position: number[]; rotation: number[]; scale: number[] } => ({ position: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

/** A loading screen's script: it logs the lighting it reads each intent step. */
function lightingStep(state: { log: string[] }, ctx: BehaviorContext): void {
  if (ctx.phase !== 'intent') return;
  const l = ctx.lighting!;
  state.log.push(`${ctx.stepIndex}:${l.tier}:${l.live ? 'live' : 'saved'}:${l.settled ? 'settled' : 'busy'}${l.justSettled ? ':just' : ''}`);
}

function makeRuntime(log: string[]): { rt: Runtime; tick(n?: number): void } {
  const spec = createBehaviorModuleSpec({
    declaration: { properties: [] } as never,
    artifact: {
      behaviorId: 'loader',
      sourceDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      outputDigest: 'c'.repeat(64),
      ownedTransforms: ['@self'],
      requiredModules: [],
      enginePins: [],
      namespace: { default: { instantiate: () => ({ log }), step: lightingStep } },
    } as never,
  });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'lit@r1',
      projectId: 'lit',
      revision: 1,
      scene: {
        schemaVersion: 4,
        sceneId: 'scene-main',
        revision: 1,
        entities: [
          { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
          { id: 'loader-0001', components: { transform: at(0, 0), behavior: { behaviorId: 'loader', values: {} } } },
        ],
      },
    },
    registry,
    modules: [spec.id],
    actions: { sample: (i: number) => neutralFrame(i) },
    settings: {},
    fixedStepHz: HZ,
    clock: () => now.t,
    driver: { kind: 'manual' },
  } as never);
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  expect(rt.start().ok).toBe(true);
  expect(rt.tick(now.t).ok).toBe(true);
  return {
    rt,
    tick: (n = 1) => {
      for (let i = 0; i < n; i += 1) {
        now.t += DT;
        const r = rt.tick(now.t);
        if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
      }
    },
  };
}

const report = (lighting: unknown): Record<string, unknown> => ({ ...ENGINE_STATS_NONE, quality: 'medium', lighting });

describe('ctx.lighting', () => {
  it('reads the page\'s lighting; justSettled is the one step after it settled, again after the next change settles', () => {
    const log: string[] = [];
    const { rt, tick } = makeRuntime(log);
    tick(2);
    // Nothing reported yet: not settled.
    expect(log.at(-1)).toMatch(/:medium:saved:busy$/);
    expect(rt.setStats!(report({ tier: 'medium', live: true, settled: false }))).toBe(true);
    tick(3);
    expect(log.slice(-3).every((l) => l.endsWith(':medium:live:busy'))).toBe(true);
    expect(rt.setStats!(report({ tier: 'medium', live: true, settled: true }))).toBe(true);
    // A report of the same state again (the next window's stats) is no new event.
    expect(rt.setStats!(report({ tier: 'medium', live: true, settled: true }))).toBe(true);
    const from = log.length;
    tick(4);
    const after = log.slice(from);
    expect(after.filter((l) => l.endsWith(':just'))).toHaveLength(1);
    expect(after[0]).toMatch(/:medium:live:settled:just$/);
    expect(after.slice(1).every((l) => l.endsWith(':medium:live:settled'))).toBe(true);
    // A lamp switched: busy, then settled again — one more event.
    rt.setStats!(report({ tier: 'medium', live: true, settled: false }));
    tick(2);
    rt.setStats!(report({ tier: 'medium', live: true, settled: true }));
    const again = log.length;
    tick(2);
    expect(log.slice(again).map((l) => l.endsWith(':just'))).toEqual([true, false]);
    // WebGL 2: the low tier's saved light.
    rt.setStats!(report({ tier: 'low', live: false, settled: true }));
    tick(1);
    expect(log.at(-1)).toMatch(/:low:saved:settled$/);
    // A malformed lighting part is refused; the last report stays.
    expect(rt.setStats!(report({ tier: 'ultra', live: false, settled: true }))).toBe(false);
    expect(rt.setStats!(report({ tier: 'low', live: 1, settled: true }))).toBe(false);
    tick(1);
    expect(log.at(-1)).toMatch(/:low:saved:settled$/);
    rt.dispose();
  });
});
