/**
 * Scripts' asset handles through the production game host, in the page
 * and in the simulation worker: the host carries out the loads (here an
 * injected loader standing in for the page's) and its answers are the
 * simulation's input. A script spawns an object where it is when its assets
 * turn ready, so the step of the answer shows in every later step digest.
 *
 * - A live run records the step its answer arrived at; that recording
 *   replays to the live run's step digests in the page and the worker,
 *   though the replaying hosts answer at other times (at once, or never).
 * - The same script with the answer arriving later is another run (the
 *   answer's step is input, not something the simulation waits for).
 */
import { describe, expect, it } from 'vitest';

import { behaviorModule, startHarness, type Harness, type Mode } from '../m22-worker/harness';

type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const IDS = ['tex-a', 'tex-b', 'tex-c'];

const SCRIPT = `
export default {
  instantiate() { return { h: 0, done: false, released: false }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    if (state.h === 0) { state.h = ctx.assets.load('batch'); return; }
    if (state.done && !state.released) {
      state.released = ctx.assets.release(state.h);
    } else if (!state.done && ctx.assets.ready(state.h)) {
      state.done = true;
      ctx.spawn('marker', { position: [ctx.stepIndex * 0.01, 1, ctx.assets.ids(state.h).length] });
    }
  },
};
`;

function snapshot(): Any {
  const entities: Any[] = [
    { id: 'cam-main', components: { transform: T([0, 4, 10]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 100 } } },
    { id: 'loader-0001', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'loader', values: {} } } },
  ];
  const prefabs = [{ prefabId: 'marker', displayName: 'Marker', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'box-0001', name: 'Marker', components: { transform: T([0, 0, 0]), box: { size: [1, 1, 1], material: { color: '#ffffff' } } } }] }];
  return { snapshotId: 'hdl@r1', projectId: 'hdl', revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities }, prefabs };
}

/** The neutral live input (what a recording's other steps replay as), remembering the step it last gave a frame for. */
function neutralInput() {
  const input = {
    last: -1,
    sample: (stepIndex: number) => {
      input.last = stepIndex;
      return { stepIndex };
    },
    sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
    markConfirmConsumed: () => undefined,
    dispose: () => undefined,
  };
  return input;
}

/** A loader that answers when `open()` is called (or at once, or never). */
function gatedLoader(when: 'gate' | 'now' | 'never') {
  const waiting: (() => void)[] = [];
  const asked: string[] = [];
  return {
    asked,
    open: () => waiting.splice(0).forEach((go) => go()),
    load: (key: string): Promise<readonly string[]> => {
      asked.push(key);
      if (when === 'now') return Promise.resolve(IDS);
      return new Promise((resolve) => {
        if (when === 'gate') waiting.push(() => resolve(IDS));
      });
    },
  };
}

async function run(mode: Mode, opts: { steps: number; openAtTick?: number; loader: ReturnType<typeof gatedLoader>; replay?: Any[] }): Promise<{ h: Harness; digests: string[]; readyAt: number }> {
  const input = neutralInput();
  const h = await startHarness(mode, {
    snapshot: snapshot(),
    settings: SETTINGS,
    physics: null,
    digestSteps: true,
    behaviors: [behaviorModule('loader', SCRIPT)],
    host: { loadAssets: (key: string) => opts.loader.load(key) },
    input,
    ...(opts.replay !== undefined ? { replay: opts.replay } : {}),
  });
  // The step whose frame carried the answer (the page's runtime only: the live run is recorded there).
  let readyAt = -1;
  let sawReady = false;
  if (mode === 'single') {
    h.rt.setStepObserver?.(() => {
      if (!sawReady && (h.rt.assetHandlesState?.() ?? '').includes(':ready:')) {
        sawReady = true;
        // The answer rode on the frame of this step.
        readyAt = input.last;
      }
    });
  }
  let now = 10;
  let i = 0;
  while (h.digests.length < opts.steps) {
    now += DT;
    await h.tick(now);
    i += 1;
    if (i === opts.openAtTick) opts.loader.open();
    // The host's loads (promises) finish between frames, as a browser's do between rAFs.
    await new Promise((r) => setTimeout(r, 0));
  }
  return { h, digests: [...h.digests], readyAt };
}

describe('asset handles replay alike however long the loads take (page and worker)', () => {
  it('a live run\'s recording replays to its step digests with the replaying hosts answering at other times', async () => {
    const live = await run('single', { steps: 90, openAtTick: 25, loader: gatedLoader('gate') });
    try {
      expect(live.readyAt).toBeGreaterThan(20);
      // The spawned marker sits where the answer's step put it.
      const spawned = live.h.rt.sceneSet().spawned;
      expect(spawned.length).toBe(1);
      const recording = [{ stepIndex: live.readyAt, assets: [{ handle: 1, ok: true, assets: IDS }] }];
      for (const mode of ['single', 'worker'] as const) {
        for (const when of ['now', 'never'] as const) {
          const loader = gatedLoader(when);
          const replay = await run(mode, { steps: 90, loader, replay: recording });
          try {
            // The replaying host was asked (the script loads) but its answer is not taken.
            expect(loader.asked).toEqual(['batch']);
            const n = Math.min(replay.digests.length, live.digests.length);
            expect(n).toBeGreaterThan(80);
            expect(replay.digests.slice(0, n), `${mode}, host answering ${when}`).toEqual(live.digests.slice(0, n));
          } finally {
            await replay.h.dispose();
          }
        }
      }
      // The answer arriving later is another run: the simulation read what arrived when.
      const later = await run('single', { steps: 90, openAtTick: 50, loader: gatedLoader('gate') });
      try {
        expect(later.readyAt).toBeGreaterThan(live.readyAt);
        expect(later.digests.slice(0, 89)).not.toEqual(live.digests.slice(0, 89));
      } finally {
        await later.h.dispose();
      }
    } finally {
      await live.h.dispose();
    }
  }, 120_000);
});
