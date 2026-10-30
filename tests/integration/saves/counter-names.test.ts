/**
 * Counter names have one rule, from `ctx.game.add` to the save loader,
 * through the production game host (page and worker).
 *
 * A script adds to a counter whose name a save could not bring back (a
 * hyphen) and to a valid one, saves, changes the valid one and loads: the
 * refused add answered false with one log line, the valid counter comes back.
 * A save document holding a bad counter name (written by an older engine)
 * still loads: the good counters are restored, the bad name is skipped with a
 * log line.
 */
import { describe, expect, it } from 'vitest';

import { behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const SCHEMA = { version: 1, slots: 2, sections: ['components', 'storage'] };

const SCRIPT = (live: boolean) => `
export default {
  step(_state, ctx) {
    if (ctx.phase !== 'intent') return;
    const s = ctx.stepIndex;
    if (${live} && (s === 10 || s === 11)) {
      ctx.save.set('refused' + s, ctx.game.add('seen_tl-prologue', 1));
      ctx.save.set('accepted' + s, ctx.game.add('seen_tl_prologue', 1));
    }
    if (${live} && s === 20) ctx.saves.save(1);
    if (${live} && s === 30) ctx.game.add('seen_tl_prologue', 5);
    if (${live} && s === 40) ctx.saves.load(1);
    for (const r of ctx.saves.results()) ctx.save.set('result_' + r.op, r.ok);
    ctx.save.set('seen', ctx.game.counter('seen_tl_prologue'));
    ctx.save.set('good', ctx.game.counter('good'));
  },
};
`;

function snapshot(): Any {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([2, 4, 10]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 100 } } },
    { id: 'counter-0001', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'counting', values: {} } } },
  ];
  return { snapshotId: 'cnt@r1', projectId: 'cnt', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, saveSchema: SCHEMA };
}

async function run(mode: Mode, opts: { live: boolean; steps: number; replay?: Any[] }): Promise<Harness> {
  const h = await startHarness(mode, {
    snapshot: snapshot(),
    settings: SETTINGS,
    physics: null,
    digestSteps: true,
    behaviors: [behaviorModule('counting', SCRIPT(opts.live))],
    storage: true,
    ...(opts.replay !== undefined ? { replay: opts.replay } : {}),
  });
  let now = 10;
  while (h.digests.length < opts.steps) {
    now += DT;
    await h.tick(now);
    await h.host.projectSaves?.idle();
    await new Promise((r) => setTimeout(r, 0));
  }
  return h;
}

const errorsOf = (h: Harness): { code: string; reason?: string; message: string }[] => {
  const d = h.rt.getDiagnostics();
  return d.ok ? d.diagnostics.errors : [];
};

describe('counter names (page and worker)', () => {
  for (const mode of ['single', 'worker'] as const) {
    it(`${mode}: a name a save would refuse is refused by ctx.game.add (false, one log line); a valid counter survives a save and a load`, async () => {
      const h = await run(mode, { live: true, steps: 70 });
      try {
        const values = await h.storage();
        expect(values['refused10']).toBe(false);
        expect(values['refused11']).toBe(false);
        expect(values['accepted10']).toBe(true);
        expect(values['accepted11']).toBe(true);
        // (The save's own outcome was overwritten by the load, which restores ctx.save as it was at step 20.)
        expect(values['result_load']).toBe(true);
        // 2 added before the save, 5 more after it; the load brings back the 2.
        expect(values['seen']).toBe(2);
        const lines = errorsOf(h).filter((e) => e.message.includes('ctx.game.add'));
        expect(lines).toHaveLength(1);
        expect(lines[0]!.message).toContain('"seen_tl-prologue"');
        expect(h.rt.getDiagnostics().diagnostics.state).toBe('running');
      } finally {
        await h.dispose();
      }
    }, 120_000);
  }

  it('a save holding a bad counter name loads: the good counters come back, the bad name is a log line', async () => {
    const file = { format: 'thirdlight.save', version: 1, playSeconds: 3, doc: null, sections: { components: { counters: { 'bad-name': 4, good: 3, nan_value: 'x' } }, storage: {} } };
    const replay = [{ stepIndex: 20, moveX: 0, jump: 'none', saves: [{ kind: 'loaded', slot: 1, ok: true, save: file }] }];
    const h = await run('single', { live: false, steps: 40, replay });
    try {
      const values = await h.storage();
      expect(values['result_load']).toBe(true);
      expect(values['good']).toBe(3);
      const lines = errorsOf(h).filter((e) => e.message.includes('counters not restored'));
      expect(lines).toHaveLength(1);
      expect(lines[0]!.message).toContain('"bad-name"');
      expect(lines[0]!.message).toContain('"nan_value"');
    } finally {
      await h.dispose();
    }
  }, 120_000);
});
