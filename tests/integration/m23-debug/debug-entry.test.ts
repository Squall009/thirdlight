/**
 * Test and debug entry points through the production game host,
 * in the page (single thread) and in the simulation worker.
 *
 * A neutral level with one scripted box. Its script — TypeScript compiled by
 * the real behavior compiler, so the `ctx.debug` typings are checked too —
 * starts the box shifted by the injected variable `shift` (read with
 * `ctx.save` at step 0) and declares a debug command `nudge {dx: number}`
 * that moves it. The tests:
 *
 * - injected variables are visible to the script at step 0 in both modes;
 * - a debug command run through the host (the path `tl_game_control
 *   debugCommand` and the in-game console take) lands on the same step in
 *   both modes, is logged with its step, and a recording that carries the
 *   calls at those steps reproduces every step digest of the live run;
 * - the in-game console (a host option) parses a typed line and runs it.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { M2_PINNED_MODULES, compileBehavior } from '@thirdlight/behavior-build';
import { SIGNAL_DEBUG_COMMAND } from '@thirdlight/runtime';

import { FakeNode, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const BOX = { size: [0.5, 0.5, 0.5], material: { color: '#88aacc' } };

const NUDGER = `import type { BehaviorContext } from '@thirdlight/runtime';

type State = { x: number | undefined; seenShift: unknown };

export default {
  instantiate(): State {
    return { x: undefined, seenShift: undefined };
  },
  step(state: State, ctx: BehaviorContext): void {
    if (ctx.phase === 'intent') {
      if (state.x === undefined) {
        // (A new run re-instantiates the state: start from the authored x, 4.)
        const shift = ctx.save?.get('shift');
        state.seenShift = shift;
        state.x = 4 + (typeof shift === 'number' ? shift : 0);
      }
      ctx.debug?.command('nudge', { description: 'Move the box along x', args: [{ name: 'dx', type: 'number' }] }, (args) => {
        state.x = (state.x ?? 0) + (args.dx as number);
      });
      return;
    }
    if (state.x !== undefined) ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: state.x, y: 3 } });
  },
};
`;

async function compiledNudger(): Promise<{ row: Any; url: string }> {
  const container = { graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: ['@self'], files: [{ path: 'src/index.ts', text: NUDGER }] };
  const bytes = new TextEncoder().encode(`${JSON.stringify(container, null, 2)}\n`);
  const r = await compileBehavior({ behaviorId: 'nudger', declaration: { properties: [] }, containerBytes: bytes, pinnedModules: M2_PINNED_MODULES });
  if (!r.ok) throw new Error(`compile failed: ${JSON.stringify(r)}`);
  return {
    row: {
      behaviorId: 'nudger',
      sourceDigest: createHash('sha256').update(bytes).digest('hex'),
      manifestDigest: r.manifestDigest,
      outputDigest: r.outputDigest,
      declaration: r.manifest.declaration,
      ownedTransforms: r.manifest.ownedTransforms,
      requiredModules: r.manifest.requiredModules,
      path: 'nudger',
    },
    url: `data:text/javascript;base64,${Buffer.from(r.outputBytes).toString('base64')}`,
  };
}

function level(): { snapshot: Any; physics: Any } {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: at(0, 0.91), controller: {} } },
    { id: 'spawn-0001', components: { transform: at(0, 0.91), playerSpawn: {} } },
    { id: 'floor-0001', components: { transform: at(20, -0.5), box: { size: [80, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 40, hy: 0.5 } } } },
    { id: 'box-0001', components: { transform: at(4, 3), box: BOX, behavior: { behaviorId: 'nudger', values: {} } } },
  ];
  return {
    snapshot: {
      snapshotId: 'nudge@r1',
      projectId: 'nudge',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities },
    },
    physics: {
      character: { x: 0, y: 0.91 },
      statics: [{ entityId: 'floor-0001', shape: { type: 'box', hx: 40, hy: 0.5 }, position: { x: 20, y: -0.5 }, rotationZ: 0 }],
      solver: { hz: HZ, gravityY: SETTINGS.gravity_y },
      controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
    },
  };
}

const boxX = (h: Harness): number => {
  const s = h.rt.getInterpolatedState();
  return s.ok ? s.state.transforms.find((t: Any) => t.id === 'box-0001')!.position[0] : Number.NaN;
};

/** Run the level: `commands` maps a frame number to the debug commands issued (through the host) before that frame. */
async function run(mode: Mode, behavior: { row: Any; url: string }, opts: { variables?: Record<string, unknown>; replay?: Any[]; commands?: Record<number, [string, Record<string, number>][]>; frames?: number; host?: Record<string, unknown>; storage?: boolean } = {}) {
  const { snapshot, physics } = level();
  const h = await startHarness(mode, {
    snapshot,
    settings: SETTINGS,
    physics,
    behaviors: [behavior],
    enginePins: M2_PINNED_MODULES,
    digestSteps: true,
    ...(opts.variables !== undefined ? { variables: opts.variables } : {}),
    ...(opts.replay !== undefined ? { replay: opts.replay } : {}),
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.storage === true ? { storage: true } : {}),
  });
  let now = 10;
  await h.tick(now);
  const results: Any[] = [];
  for (let f = 0; f < (opts.frames ?? 120); f += 1) {
    for (const [name, args] of opts.commands?.[f] ?? []) results.push(h.host.debugCommand!(name, args));
    now += DT * (1 + (f % 3 === 0 ? 1 : 0));
    await h.tick(now);
  }
  return { h, results };
}

describe('phase 23.8: debug entry points in the page and the worker', () => {
  it('injected variables are what the script reads at step 0 (both modes)', async () => {
    const behavior = await compiledNudger();
    for (const mode of ['single', 'worker'] as const) {
      const plain = await run(mode, behavior, { frames: 20 });
      const shifted = await run(mode, behavior, { variables: { shift: 2.5 }, frames: 20, storage: true });
      try {
        expect(boxX(plain.h), mode).toBeCloseTo(4, 9);
        expect(boxX(shifted.h), mode).toBeCloseTo(6.5, 9);
        expect(await shifted.h.storage(), mode).toEqual({ shift: 2.5 });
      } finally {
        await plain.h.dispose();
        await shifted.h.dispose();
      }
    }
  }, 120_000);

  it('a command through the host lands on the same step in both modes, is logged, and a recording of it replays every step exactly', async () => {
    const behavior = await compiledNudger();
    const commands = { 30: [['nudge', { dx: 1.5 }]], 70: [['nudge', { dx: -0.25 }], ['nudge', { dx: 3 }]] } as Record<number, [string, Record<string, number>][]>;
    const single = await run('single', behavior, { commands });
    const worker = await run('worker', behavior, { commands });
    let replay: Awaited<ReturnType<typeof run>> | null = null;
    let replayWorker: Awaited<ReturnType<typeof run>> | null = null;
    try {
      for (const r of [...single.results, ...worker.results]) expect(r.ok, JSON.stringify(r)).toBe(true);
      const applied = single.h.rt.debugCommandState!().applied;
      expect(applied.map((a: Any) => a.args.dx)).toEqual([1.5, -0.25, 3]);
      expect(worker.h.rt.debugCommandState!().applied).toEqual(applied);
      expect(single.h.rt.debugCommandState!().registered).toEqual([SIGNAL_DEBUG_COMMAND, { name: 'nudge', description: 'Move the box along x', args: [{ name: 'dx', type: 'number' }] }]);
      expect(boxX(single.h)).toBeCloseTo(4 + 1.5 - 0.25 + 3, 9);
      const n = Math.min(single.h.digests.length, worker.h.digests.length);
      expect(n).toBeGreaterThan(100);
      expect(worker.h.digests.slice(0, n)).toEqual(single.h.digests.slice(0, n));

      // The recording: neutral frames, the calls at their logged steps (the replay input format).
      const last = applied.at(-1)!.stepIndex + 200;
      const frames: Any[] = [];
      for (let s = 0; s <= last; s += 1) {
        const calls = applied.filter((a: Any) => a.stepIndex === s).map((a: Any) => ({ name: a.name, args: a.args }));
        frames.push({ stepIndex: s, moveX: 0, jump: 'none', ...(calls.length > 0 ? { commands: calls } : {}) });
      }
      replay = await run('single', behavior, { replay: frames });
      replayWorker = await run('worker', behavior, { replay: frames });
      for (const r of [replay, replayWorker]) {
        const m = Math.min(r.h.digests.length, single.h.digests.length);
        expect(m).toBeGreaterThan(100);
        const firstDiff = r.h.digests.slice(0, m).findIndex((d, k) => d !== single.h.digests[k]);
        expect(firstDiff, `first differing step ${firstDiff} (${r.h.mode})`).toBe(-1);
        expect(r.h.rt.debugCommandState!().applied).toEqual(applied);
      }
      // Refusals: an undeclared command, wrong args.
      const bad = single.h.host.debugCommand!('warp', {});
      expect(bad.ok).toBe(false);
      const wrong = worker.h.host.debugCommand!('nudge', { dx: 'far' } as never);
      expect(wrong.ok).toBe(false);
      if (!wrong.ok) expect(wrong.error.message).toContain('must be a number');
    } finally {
      await single.h.dispose();
      await worker.h.dispose();
      await replay?.h.dispose();
      await replayWorker?.h.dispose();
    }
  }, 180_000);

  it('the in-game console (a host option) lists the commands and runs a typed line; without the option there is none', async () => {
    const behavior = await compiledNudger();
    const container = new FakeNode();
    const withConsole = await run('worker', behavior, { frames: 10, host: { debugConsole: true, container } });
    const without = await run('single', behavior, { frames: 5 });
    try {
      const con = withConsole.h.host.debugConsole!;
      expect(con).not.toBeNull();
      expect(container.children.some((c: Any) => String(c.attrs['class'] ?? '').startsWith('tl-console'))).toBe(true);
      con.setOpen(true);
      expect(con.lines().some((l) => l.startsWith('nudge <dx:number>'))).toBe(true);
      con.submit('nudge dx=2');
      con.submit('nudge far');
      expect(con.lines().at(-1)).toContain('dx must be a number');
      let now = 100;
      for (let i = 0; i < 10; i += 1) await withConsole.h.tick((now += DT));
      expect(boxX(withConsole.h)).toBeCloseTo(6, 9);
      expect(con.lines().some((l) => /^ran nudge dx=2 at step \d+$/.test(l))).toBe(true);
      expect(without.h.host.debugConsole).toBeNull();
    } finally {
      await withConsole.h.dispose();
      await without.h.dispose();
    }
  }, 120_000);
});
