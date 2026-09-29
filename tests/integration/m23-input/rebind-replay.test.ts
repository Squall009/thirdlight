/**
 * Rebinding happens on the host; the simulation sees only action
 * values. A neutral scene with a script that counts `jump` presses (and hides
 * a marker per press) and shows a second marker while the jump glyph it reads
 * is "K". Live input comes from the real browser owner (fake DOM events).
 *
 * - Run A presses Space twice. Run B presses Space, rebinds jump to K through
 *   the host's bindings API, then presses K: the jump values the simulation
 *   sampled are the same step for step, and after the rebind Space no longer
 *   jumps.
 * - Run B's recorded frames (with their input entries) replay in the page and
 *   in the simulation worker with the live run's step digests, and the script
 *   sees the new glyph in the replay too.
 */
import { describe, expect, it } from 'vitest';

import { attachBrowserInput } from '@thirdlight/input';
import type { ActionFrame } from '@thirdlight/runtime';

import { behaviorModule, startHarness } from '../m22-worker/harness';

type Any = any;
const DT = 1 / 120;
const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const INPUT = {
  actions: [
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space' }, { kind: 'gamepadButton', button: 0 }] },
    { name: 'use', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyE' }] },
  ],
};

const COUNTER = `
export default {
  instantiate() { return { n: 0 }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    if (ctx.input.pressed('jump')) {
      state.n += 1;
      ctx.game.setVisible('mark-' + state.n, false);
    }
    ctx.game.setVisible('glyph-k', ctx.input.glyphLabel('jump') === 'K');
  },
};
`;

function snapshot(): Any {
  const box = (id: string, x: number) => ({ id, components: { transform: T([x, 0, 0]), box: { size: [0.5, 0.5, 0.5], material: { color: '#8899aa' } } } });
  return {
    snapshotId: 'rebind@r1',
    projectId: 'rebind',
    revision: 1,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [{ id: 'cam-main', components: { transform: T([0, 0, 10]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } }, box('mark-1', -1), box('mark-2', 0), box('mark-3', 1), box('glyph-k', 2), { id: 'counter-0001', components: { transform: T([0, -5, 0]), behavior: { behaviorId: 'counter', values: {} } } }] },
  };
}

class FakeTarget {
  private readonly listeners = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, h: EventListenerOrEventListenerObject): void {
    const s = this.listeners.get(type) ?? new Set();
    s.add(h as unknown as (e: Event) => void);
    this.listeners.set(type, s);
  }
  removeEventListener(type: string, h: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(h as unknown as (e: Event) => void);
  }
  dispatch(type: string, e: Record<string, unknown>): void {
    for (const f of [...(this.listeners.get(type) ?? [])]) f({ type, preventDefault: () => undefined, ...e } as unknown as Event);
  }
}

function liveOwner(): { owner: Any; target: FakeTarget; frames: ActionFrame[] } {
  const target = new FakeTarget();
  const win = Object.assign(new FakeTarget(), { document: new FakeTarget(), isSecureContext: true });
  const owner: Any = attachBrowserInput(target as unknown as EventTarget, { window: win as unknown as Window, document: win.document as unknown as Document, navigator: {} as Navigator, getGamepads: () => [], inputConfig: INPUT as Any, now: () => 0 });
  const frames: ActionFrame[] = [];
  const sample = owner.sample;
  owner.sample = (i: number) => {
    const f = sample(i);
    frames.push(f);
    return f;
  };
  return { owner, target, frames };
}

/** Keys down/up at steps; an optional rebind at a step (jump → K through the host's API). */
async function liveRun(keys: [number, 'down' | 'up', string][], rebindAt: number | null): Promise<{ frames: ActionFrame[]; digests: string[]; hidden: string }> {
  const live = liveOwner();
  const h = await startHarness('single', { snapshot: snapshot(), settings: SETTINGS, physics: null, input: live.owner, behaviors: [behaviorModule('counter', COUNTER)], digestSteps: true, host: { inputConfig: INPUT } });
  try {
    let now = 10;
    await h.tick(now);
    for (let step = 0; step < 100; step += 1) {
      for (const [at, dir, code] of keys) if (at === step) live.target.dispatch(dir === 'down' ? 'keydown' : 'keyup', { code });
      if (rebindAt === step) {
        const r = h.host.bindings!.bind('jump', { device: 'keyboard', code: 'KeyK' });
        expect(r.ok).toBe(true);
      }
      now += DT;
      await h.tick(now);
    }
    const o = h.host.observe();
    return { frames: live.frames, digests: [...h.digests], hidden: o.ok ? (o.observation.hidden ?? []).join(',') : '' };
  } finally {
    await h.dispose();
  }
}

const jumps = (frames: readonly ActionFrame[]): string[] => frames.map((f) => `${f.stepIndex}:${f.actions?.['jump']?.p ?? '-'}`);

describe('a rebind changes what drives an action, not what the simulation sees', () => {
  it('the same jump values from Space→Space and Space→(rebind)→K; Space no longer jumps; the replay of the rebind run matches in page and worker', async () => {
    const a = await liveRun([[20, 'down', 'Space'], [25, 'up', 'Space'], [60, 'down', 'Space'], [65, 'up', 'Space']], null);
    const b = await liveRun([[20, 'down', 'Space'], [25, 'up', 'Space'], [60, 'down', 'KeyK'], [65, 'up', 'KeyK'], [80, 'down', 'Space'], [85, 'up', 'Space']], 40);
    // Step for step the same jump values until b's Space press at 80, which no longer jumps.
    expect(jumps(b.frames)).toEqual(jumps(a.frames));
    expect(jumps(b.frames).filter((j) => j.endsWith(':pressed')).length).toBe(2);
    // The script saw the new glyph (glyph-k hidden only in b) and counted two presses.
    expect(a.hidden).toBe('glyph-k,mark-1,mark-2');
    expect(b.hidden).toBe('mark-1,mark-2');
    // b's frames carried the input entries: the first (device, list, profile), the rebind's events and list.
    const entries = b.frames.filter((f) => f.input !== undefined);
    expect(entries[0]!.input!.actions!.map((x) => x.name)).toEqual(['jump', 'use']);
    const rebound = entries.find((f) => f.input!.events?.some((e) => e.type === 'rebound'))!;
    expect(rebound.input!.actions!.find((x) => x.name === 'jump')!.bindings[0]!.label).toBe('K');

    // The recording replays exactly (page and worker).
    const replay = b.frames.filter((f) => f.actions !== undefined || f.input !== undefined).map((f) => JSON.parse(JSON.stringify(f)) as ActionFrame);
    for (const mode of ['single', 'worker'] as const) {
      const h = await startHarness(mode, { snapshot: snapshot(), settings: SETTINGS, physics: null, replay, behaviors: [behaviorModule('counter', COUNTER)], digestSteps: true, host: { inputConfig: INPUT } });
      try {
        let now = 10;
        await h.tick(now);
        while (h.digests.length < b.digests.length) {
          now += DT;
          await h.tick(now);
        }
        expect(h.digests.slice(0, b.digests.length), mode).toEqual(b.digests);
        const o = h.host.observe();
        expect(o.ok && (o.observation.hidden ?? []).join(','), mode).toBe('mark-1,mark-2');
      } finally {
        await h.dispose();
      }
    }
  }, 120_000);
});
