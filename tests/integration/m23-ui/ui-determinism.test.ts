/**
 * Phase 23.9a: the project UI is simulation state across the worker
 * boundary. A neutral scene with a script that publishes view-model values,
 * shows a HUD and a menu, and reacts to UI events; a recorded input carries
 * UI events (a show from a button, clicks, a focus change, a hide). Run in
 * the page and in the simulation worker: every step's digest (the view model
 * and shown documents included) is identical, and the host's UI layer
 * (drawn on a fake DOM) shows the same documents with the same values.
 */
import { describe, expect, it } from 'vitest';

import { FakeNode, behaviorModule, startHarness, type Mode } from '../m22-worker/harness';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const HZ = 120;
const DT = 1 / HZ;
const T = (position: number[]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

const SCRIPT = `
export default {
  instantiate() { return { score: 0, picks: [] }; },
  step(state, ctx) {
    if (ctx.phase !== 'intent') return;
    const ui = ctx.ui;
    if (ctx.stepIndex === 20) ui.show('hud');
    if (ctx.stepIndex % 12 === 0) state.score += 1;
    for (const e of ui.events()) {
      if (e.kind === 'click' && e.name === 'add') state.score += Number(e.value);
      if (e.kind === 'click' && e.name === 'pick') state.picks.push(e.index);
      if (e.kind === 'focus') ui.set('menu.focused', e.widget);
    }
    ui.set('hud.score', state.score);
    ui.set('menu.items', [{ name: 'a' + (state.score % 3) }, { name: 'b' }]);
    ui.set('menu.picks', state.picks.length);
  },
};
`;

const DOCS = [
  { uiDocumentId: 'hud', name: 'HUD', root: { type: 'text', id: 'score', text: 'Score {hud.score}' } },
  { uiDocumentId: 'menu', name: 'Menu', modal: true, actionMap: 'ui', root: { type: 'list', id: 'items', items: { bind: 'menu.items' }, template: { type: 'button', id: 'item', text: '{$item.name}' } } },
];

function recording(): Any[] {
  const frames: Any[] = [];
  for (let s = 0; s < 700; s += 1) {
    const f: Any = { stepIndex: s, moveX: 0, jump: 'none' };
    if (s === 100) f.ui = [{ kind: 'show', doc: 'menu', widget: 'open', name: '' }];
    if (s === 140) f.ui = [{ kind: 'click', doc: 'menu', widget: 'item', name: 'add', value: 5, index: 0 }, { kind: 'focus', doc: 'menu', widget: 'item', name: '', index: 1 }];
    if (s === 200) f.ui = [{ kind: 'click', doc: 'menu', widget: 'item', name: 'pick', index: 1 }];
    if (s === 400) f.ui = [{ kind: 'hide', doc: 'menu', widget: '', name: '' }];
    frames.push(f);
  }
  return frames;
}

async function run(mode: Mode): Promise<{ digests: string[]; shown: Map<number, string>; texts: Map<number, string>; dispose: () => Promise<void> }> {
  const container = new FakeNode();
  const snapshot = {
    snapshotId: 'ui@r1',
    projectId: 'ui',
    revision: 1,
    scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [
      { id: 'cam-main', components: { transform: T([0, 4, 12]), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
      { id: 'logic-0001', components: { transform: T([0, 0, 0]), behavior: { behaviorId: 'logic', values: {} } } },
    ] },
    uiDocuments: [{ uiDocumentId: 'hud', layer: 0, modal: false }, { uiDocumentId: 'menu', layer: 0, modal: true }],
  };
  const h = await startHarness(mode, { snapshot, settings: {}, physics: null, behaviors: [behaviorModule('logic', SCRIPT)], replay: recording(), digestSteps: true, host: { buildId: 'b', container, ui: { documents: DOCS } } });
  const shown = new Map<number, string>();
  const texts = new Map<number, string>();
  const allText = (n: Any): string => (n.textContent ?? '') + (n.children ?? []).map(allText).join('');
  let now = 10;
  await h.tick(now);
  let i = 0;
  while (h.digests.length < 600) {
    now += ((i++ % 3) + 1) * DT;
    await h.tick(now);
    const obs = h.host.observe();
    if (obs.ok && obs.observation.ui !== undefined) {
      shown.set(obs.observation.stepIndex, obs.observation.ui.shown.join(','));
      texts.set(obs.observation.stepIndex, `${allText(container).length}|${JSON.stringify(h.rt.uiView().model)}`);
    }
  }
  return { digests: [...h.digests], shown, texts, dispose: () => h.dispose() };
}

describe('phase 23.9a: the project UI in page and worker', () => {
  it('identical step digests with UI state; the host draws the same documents and values', async () => {
    const a = await run('single');
    const w = await run('worker');
    try {
      const n = Math.min(a.digests.length, w.digests.length);
      expect(a.digests.slice(0, n).findIndex((d, k) => d !== w.digests[k]), 'first differing step').toBe(-1);
      let compared = 0;
      for (const [step, s] of a.shown) {
        if (!w.shown.has(step)) continue;
        expect(w.shown.get(step), `shown at ${step}`).toBe(s);
        expect(w.texts.get(step), `drawn at ${step}`).toBe(a.texts.get(step));
        compared += 1;
      }
      expect(compared).toBeGreaterThan(100);
      const near = (m: Map<number, string>, step: number): string => {
        for (let k = step; k < step + 5; k += 1) if (m.has(k)) return m.get(k)!;
        throw new Error(`nothing near ${step}`);
      };
      expect(near(a.shown, 50)).toBe('hud');
      expect(near(a.shown, 150)).toBe('hud,menu');
      expect(near(a.shown, 450)).toBe('hud');
      // The click added 5 at step 140: the score drawn includes it.
      const score = (s: string): number => JSON.parse(s.slice(s.indexOf('|') + 1)).hud.score;
      expect(score(near(a.texts, 150))).toBe(Math.floor(150 / 12) + 1 + 5);
    } finally {
      await a.dispose();
      await w.dispose();
    }
  }, 180_000);
});
