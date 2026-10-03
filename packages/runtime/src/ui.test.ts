/**
 * The project UI in the simulation.
 *
 * - `UiState` (pure): view-model writes and reads, bounds, clear, the diff
 *   of a step (coalesced by path), show/hide order, frame events, a new run.
 * - Frames: `ActionFrame.ui` entries validate strictly and survive a
 *   recording; older frames are unchanged.
 * - The runtime: scripts publish values and show documents through
 *   `ctx.ui`; a queued UI event rides on the next sampled frame (a show entry
 *   is applied before scripts run); the events are read in the intent phase
 *   only; two runs from the same recorded input give the same UI output at
 *   every step, and a recorded frame's UI events replay exactly.
 *
 * Neutral fixtures (a scene without a game block).
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_FRAME_UI_EVENTS,
  UI_MODEL_MAX_BYTES,
  UiState,
  applyUiOutputToModel,
  createBehaviorModuleSpec,
  createRecordedActionSource,
  createSimulationRegistry,
  instantiateRuntime,
  mergeUiOutput,
  neutralFrame,
  registerSimulationModule,
  validateActionFrame,
  type ActionFrame,
  type BehaviorContext,
  type Runtime,
  type UiOutput,
} from './index';

const ROWS = [
  { uiDocumentId: 'hud', layer: 0, modal: false },
  { uiDocumentId: 'menu', layer: 10, modal: true },
  { uiDocumentId: 'toast', layer: 0, modal: false },
];

describe('UiState: the view model, shown documents and the step diff (pure)', () => {
  it('sets, reads and clears values at paths; lists by index; refuses bad paths and values', () => {
    const ui = new UiState(ROWS);
    expect(ui.set('hud.hp', 3)).toBe(true);
    expect(ui.set('hud.name', 'Ada')).toBe(true);
    expect(ui.set('party', [{ name: 'a' }, { name: 'b' }])).toBe(true);
    expect(ui.set('party.1.name', 'c')).toBe(true);
    expect(ui.set('party.2', { name: 'd' })).toBe(true); // append at the end
    expect(ui.set('party.9', { name: 'x' })).toBe(false); // past the end
    expect(ui.get('hud.hp')).toBe(3);
    expect(ui.get('party.1.name')).toBe('c');
    expect(ui.get('party')).toEqual([{ name: 'a' }, { name: 'c' }, { name: 'd' }]);
    expect(ui.get('nope.deeper')).toBeNull();
    for (const bad of ['', 'a..b', 'a b', 'a.$b', 'x'.repeat(129), 'a.b.c.d.e.f.g.h.i']) expect(ui.set(bad, 1)).toBe(false);
    for (const bad of [Number.NaN, Infinity, undefined, () => 1, 'x'.repeat(1025), new Array(257).fill(0), { 'bad key': 1 }]) expect(ui.set('v', bad)).toBe(false);
    expect(ui.set('hud.hp.inner', 1)).toBe(false); // crosses a number
    expect(ui.clear('hud.name')).toBe(true);
    expect(ui.get('hud')).toEqual({ hp: 3 });
    expect(ui.clear('party.0')).toBe(true); // a list item: the rest move up
    expect(ui.get('party.0.name')).toBe('c');
    expect(ui.clear('nope')).toBe(false);
    // Values handed out are frozen (a script cannot change the model behind the diff).
    expect(Object.isFrozen(ui.get('party'))).toBe(true);
  });

  it('keeps the view model within 64 KiB', () => {
    const ui = new UiState(ROWS);
    const chunk = 'x'.repeat(1000);
    let n = 0;
    while (ui.set(`k${n}`, chunk)) n += 1;
    expect(n).toBeGreaterThan(50);
    expect(n).toBeLessThan(UI_MODEL_MAX_BYTES / 1000 + 1);
    // Replacing a key with a smaller value still fits.
    expect(ui.set('k0', 'small')).toBe(true);
  });

  it('diffs a step: writes coalesced by path in order, shown documents, commands; a reset clears', () => {
    const ui = new UiState(ROWS);
    ui.set('hud.hp', 1);
    ui.set('hud', { hp: 2, max: 5 });
    ui.set('hud.hp', 3);
    expect(ui.show('hud')).toBe(true);
    expect(ui.show('nope')).toBe(false);
    expect(ui.command('play', 'hud', 'pop', 'hp')).toBe(true);
    expect(ui.command('play', 'nope', 'pop', undefined)).toBe(false);
    const out = ui.takeOutput()!;
    expect(out.set).toEqual([['hud', { hp: 2, max: 5 }], ['hud.hp', 3]]);
    expect(out.shown).toEqual([{ doc: 'hud', layer: 0, modal: false }]);
    expect(out.commands).toEqual([{ op: 'play', doc: 'hud', tween: 'pop', widget: 'hp' }]);
    expect(applyUiOutputToModel({}, out)).toEqual({ hud: { hp: 3, max: 5 } });
    expect(ui.takeOutput()).toBeNull();
    ui.resetRun();
    const reset = ui.takeOutput()!;
    expect(reset.reset).toBe(true);
    expect(reset.shown).toEqual([]);
    expect(applyUiOutputToModel({ a: 1 }, reset)).toEqual({});
  });

  it('merges several steps\' outputs into one (later writes win, a reset restarts)', () => {
    const a: UiOutput = { set: [['x', 1], ['y', 2]], commands: [] };
    const b: UiOutput = { set: [['x', 3], ['z']], shown: [{ doc: 'hud', layer: 0, modal: false }], commands: [{ op: 'focus', doc: 'hud', widget: 'w' }] };
    const m = mergeUiOutput(a, b)!;
    expect(m.set).toEqual([['y', 2], ['x', 3], ['z']]);
    expect(m.shown).toEqual(b.shown);
    expect(m.commands).toEqual(b.commands);
    expect(mergeUiOutput(a, { reset: true, set: [], commands: [] })).toEqual({ reset: true, set: [], commands: [] });
  });

  it('a focus command may name a list item; the view drawn over is reported, refused when it is not one', () => {
    const ui = new UiState(ROWS);
    expect(ui.command('focus', 'menu', 'slot', undefined, 3)).toBe(true);
    expect(ui.command('focus', 'menu', 'slot', undefined, -1)).toBe(false);
    expect(ui.command('focus', 'menu', 'slot', undefined, 1.5)).toBe(false);
    expect(ui.command('focus', 'menu', 'slot', undefined)).toBe(true);
    expect(ui.takeOutput()?.commands).toEqual([{ op: 'focus', doc: 'menu', widget: 'slot', index: 3 }, { op: 'focus', doc: 'menu', widget: 'slot' }]);
    expect(ui.screenView()).toEqual({ width: 1280, height: 720, aspect: 16 / 9, pixelRatio: 1 });
    expect(ui.setScreenView(2560, 1080, 1.5)).toBe(true);
    expect(ui.screenView()).toEqual({ width: 2560, height: 1080, aspect: 2560 / 1080, pixelRatio: 1.5 });
    expect(ui.setScreenView(0, 1080, 1)).toBe(false);
    expect(ui.setScreenView(800, 600, Number.NaN)).toBe(false);
    expect(ui.screenView().width).toBe(2560);
  });

  it('shows by layer, then show order; a second show brings a document to the top of its layer; frame entries show/hide/toggle', () => {
    const ui = new UiState(ROWS);
    ui.show('menu');
    ui.show('hud');
    ui.show('toast');
    expect(ui.shown().map((s) => s.doc)).toEqual(['hud', 'toast', 'menu']);
    ui.show('hud');
    expect(ui.shown().map((s) => s.doc)).toEqual(['toast', 'hud', 'menu']);
    ui.show('toast', { layer: 50, modal: true });
    expect(ui.shown().map((s) => [s.doc, s.layer, s.modal])).toEqual([['hud', 0, false], ['menu', 10, true], ['toast', 50, true]]);
    expect(ui.hide('menu')).toBe(true);
    expect(ui.hide('menu')).toBe(false);
    ui.deliver([
      { kind: 'toggle', doc: 'menu', widget: 'open', name: '' },
      { kind: 'hide', doc: 'hud', widget: '', name: '' },
      { kind: 'click', doc: 'menu', widget: 'buy', name: 'buy', value: 2 },
    ]);
    expect(ui.shown().map((s) => s.doc)).toEqual(['menu', 'toast']);
    expect(ui.events().map((e) => e.name)).toEqual(['', '', 'buy']);
    ui.deliver(undefined);
    expect(ui.events()).toEqual([]);
  });
});

describe('ActionFrame.ui: the UI events of a step', () => {
  it('validates strictly and keeps older frames unchanged', () => {
    const plain = validateActionFrame({ stepIndex: 3 });
    expect(plain.ok && !('ui' in plain.frame)).toBe(true);
    const ok = validateActionFrame({ stepIndex: 3, ui: [{ kind: 'click', doc: 'hud', widget: 'buy', name: 'buy', value: 1, index: 2 }] });
    expect(ok.ok && ok.frame.ui).toEqual([{ kind: 'click', doc: 'hud', widget: 'buy', name: 'buy', value: 1, index: 2 }]);
    const bad = [
      [{ kind: 'poke', doc: 'hud', widget: '', name: '' }],
      [{ kind: 'click', doc: 'Bad Id', widget: '', name: '' }],
      [{ kind: 'click', doc: 'hud', widget: 'a b', name: '' }],
      [{ kind: 'click', doc: 'hud', widget: '', name: '', value: { x: 1 } }],
      [{ kind: 'click', doc: 'hud', widget: '', name: '', extra: 1 }],
      new Array(MAX_FRAME_UI_EVENTS + 1).fill({ kind: 'click', doc: 'hud', widget: '', name: 'x' }),
      'nope',
    ];
    for (const ui of bad) expect(validateActionFrame({ stepIndex: 3, ui }).ok, JSON.stringify(ui).slice(0, 60)).toBe(false);
    // A recording keeps them.
    const src = createRecordedActionSource([{ stepIndex: 5, ui: [{ kind: 'submit', doc: 'hud', widget: 'name', name: 'named', value: 'Ada' }] } as ActionFrame]);
    expect(src.sample(5).ui).toEqual([{ kind: 'submit', doc: 'hud', widget: 'name', name: 'named', value: 'Ada' }]);
    expect(src.sample(6).ui).toBeUndefined();
  });
});

// --- the runtime ---------------------------------------------------------------------------

const HZ = 120;
const DT = 1 / HZ;
const at = (x: number, y: number, z = 0): { position: number[]; rotation: number[]; scale: number[] } => ({ position: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

/** A shop-like script: counts credits, publishes them, shows the HUD at the start and opens the menu on "open"; "buy" spends. */
function shopStep(state: { credits: number; log: string[] }, ctx: BehaviorContext): void {
  const ui = ctx.ui!;
  if (ctx.phase !== 'intent') {
    // The events are the intent phase's (a script that runs in both phases sees them once).
    state.log.push(`t${ctx.stepIndex}:${ui.events().length}`);
    return;
  }
  if (ctx.stepIndex === 13) ui.show('hud');
  if (ctx.stepIndex % 30 === 0) state.credits += 1;
  for (const e of ui.events()) {
    if (e.kind === 'click' && e.name === 'buy' && state.credits >= Number(e.value ?? 1)) state.credits -= Number(e.value ?? 1);
    state.log.push(`${ctx.stepIndex}:${e.kind}:${e.doc}:${e.name}:${ui.isShown('menu')}`);
  }
  ui.set('hud.credits', state.credits);
  ui.set('hud.step', ctx.stepIndex);
  const clicked = ui.event('buy');
  if (clicked !== null) ui.play('hud', 'pop');
}

function makeRuntime(frames: readonly ActionFrame[] | null, logs: string[][]): { rt: Runtime; tick(n?: number): void } {
  const spec = createBehaviorModuleSpec({
    declaration: { properties: [] } as never,
    artifact: {
      behaviorId: 'shop',
      sourceDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      outputDigest: 'c'.repeat(64),
      ownedTransforms: ['@self'],
      requiredModules: [],
      enginePins: [],
      namespace: {
        default: {
          instantiate: () => {
            const s = { credits: 0, log: [] as string[] };
            logs.push(s.log);
            return s;
          },
          step: shopStep,
        },
      },
    } as never,
  });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'ui@r1',
      projectId: 'ui',
      revision: 1,
      scene: {
        schemaVersion: 4,
        sceneId: 'scene-main',
        revision: 1,
        entities: [
          { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
          { id: 'shop-0001', components: { transform: at(0, 0), behavior: { behaviorId: 'shop', values: {} } } },
        ],
      },
      uiDocuments: ROWS,
    },
    registry,
    modules: [spec.id],
    actions: frames !== null ? createRecordedActionSource(frames) : { sample: (i: number) => neutralFrame(i) },
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

const stepOf = (rt: Runtime): number => {
  const d = rt.getDiagnostics();
  return d.ok ? d.diagnostics.stepIndex : -1;
};

describe('ctx.ui in the runtime', () => {
  it('publishes values and shows documents; a queued event rides on the next frame and a show entry applies before scripts', () => {
    const logs: string[][] = [];
    const { rt, tick } = makeRuntime(null, logs);
    tick(20);
    const first = rt.takeUiOutput!()!;
    expect(first.shown).toEqual([{ doc: 'hud', layer: 0, modal: false }]);
    expect(rt.uiView!().model).toMatchObject({ hud: { credits: expect.any(Number), step: expect.any(Number) } });
    tick(100); // credits accrue
    const before = (rt.uiView!().model as { hud: { credits: number } }).hud.credits;
    expect(before).toBeGreaterThan(2);
    const at0 = stepOf(rt);
    expect(rt.queueUiEvent!({ kind: 'show', doc: 'menu', widget: 'open', name: '' }).ok).toBe(true);
    expect(rt.queueUiEvent!({ kind: 'click', doc: 'menu', widget: 'buy', name: 'buy', value: 2 }).ok).toBe(true);
    expect(rt.queueUiEvent!({ kind: 'show', doc: 'nope', widget: '', name: '' }).ok).toBe(false);
    expect(rt.queueUiEvent!({ kind: 'click', doc: 'menu', widget: 'a b', name: 'x' } as never).ok).toBe(false);
    tick(1);
    const log = logs[0]!;
    // Both events arrived in the very next step, the show applied before the script ran.
    expect(log.filter((l) => !l.startsWith('t'))).toEqual([`${at0}:show:menu::true`, `${at0}:click:menu:buy:true`]);
    // The transform phase saw no events (they are read once per step, in the intent phase).
    expect(log.filter((l) => l === `t${at0}:0`)).toHaveLength(1);
    const out = rt.takeUiOutput!()!;
    expect(out.shown?.map((s) => s.doc)).toEqual(['hud', 'menu']);
    expect(out.commands).toEqual([{ op: 'play', doc: 'hud', tween: 'pop', widget: '' }]);
    expect((rt.uiView!().model as { hud: { credits: number } }).hud.credits).toBe(before - 2);
    rt.dispose();
  });

  it('two runs from the same recorded input publish the same UI at every step; recorded UI events replay exactly', () => {
    const frames: ActionFrame[] = [];
    for (let s = 0; s < 400; s += 1) {
      const f: ActionFrame = { stepIndex: s };
      if (s === 150) f.ui = [{ kind: 'toggle', doc: 'menu', widget: 'open', name: '' }];
      if (s === 151) f.ui = [{ kind: 'click', doc: 'menu', widget: 'buy', name: 'buy', value: 1, index: 0 }, { kind: 'focus', doc: 'menu', widget: 'sell', name: '' }];
      if (s === 300) f.ui = [{ kind: 'toggle', doc: 'menu', widget: 'open', name: '' }];
      frames.push(f);
    }
    const run = (): { outputs: string[]; log: string[] } => {
      const logs: string[][] = [];
      const { rt, tick } = makeRuntime(frames, logs);
      const outputs: string[] = [];
      for (let i = 0; i < 380; i += 1) {
        tick(1);
        outputs.push(`${stepOf(rt)}:${JSON.stringify(rt.takeUiOutput!())}`);
      }
      rt.dispose();
      return { outputs, log: logs[0]!.filter((l) => !l.startsWith('t')) };
    };
    const a = run();
    const b = run();
    expect(b.outputs).toEqual(a.outputs);
    expect(a.log).toEqual(['150:toggle:menu::true', '151:click:menu:buy:true', '151:focus:menu::true', '300:toggle:menu::false']);
  });
});
