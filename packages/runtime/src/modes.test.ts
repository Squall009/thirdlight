/**
 * Phase 23.10 — game modes in the simulation.
 *
 * - `ModeState` (pure): the start mode, a script's switch applying at the
 *   next step boundary, a UI mode action applying at once, the enter/exit
 *   events of the step, documents shown/hidden with the camera override and
 *   blend, the fade document's time, input masking per mode, group ticking,
 *   time scale and physics hold, a new run.
 * - The runtime: behavior groups tick per mode; a switch changes the input
 *   map, the camera, the UI documents and the ticking groups in one step
 *   with no scene load; the start mode option; two runs from one recording
 *   give the same states; a restart (ctx.lifecycle) starts over in the start
 *   mode with the authored transforms.
 *
 * Neutral fixtures (explore / tactical, a field group and a board group).
 */
import { describe, expect, it } from 'vitest';

import {
  ModeState,
  createBehaviorModuleSpec,
  createRecordedActionSource,
  createSimulationRegistry,
  instantiateRuntime,
  neutralFrame,
  registerSimulationModule,
  type ActionFrame,
  type BehaviorContext,
  type GameMode,
  type ModeEffects,
  type Runtime,
} from './index';

const HZ = 120;
const DT = 1 / HZ;
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

const MODES: GameMode[] = [
  { modeId: 'explore', name: 'Explore', inputMaps: ['gameplay', 'ui'], camera: 'cam-follow', ui: ['hud'], groups: ['field'], pause: true },
  { modeId: 'tactical', name: 'Tactical', inputMaps: ['tactical', 'ui'], camera: 'cam-top', ui: ['board'], groups: ['board'], ungrouped: 'tick', pause: false, timeScale: 0.5, physics: 'hold', enter: { blend: 'linear', blendTime: 0.5, fade: 'fade', fadeTime: 0.25 } },
];
const ACTION_MAPS = { move: 'gameplay', jump: 'gameplay', select: 'tactical', pause: 'ui' };

function effects(): ModeEffects & { log: string[]; shown: Set<string> } {
  const shown = new Set<string>();
  const log: string[] = [];
  return {
    log,
    shown,
    showUi: (d) => {
      shown.add(d);
      log.push(`show:${d}`);
    },
    hideUi: (d) => {
      shown.delete(d);
      log.push(`hide:${d}`);
    },
    isShown: (d) => shown.has(d),
    setCamera: (id, blend) => log.push(`camera:${id ?? '-'}:${JSON.stringify(blend ?? null)}`),
    warn: (m) => log.push(`warn:${m}`),
  };
}

describe('ModeState (pure)', () => {
  it('starts in the first mode (or the start option), switches at the next boundary and reports the step\'s events', () => {
    const fx = effects();
    const m = new ModeState({ modes: MODES, actionMaps: ACTION_MAPS }, HZ, fx);
    expect(m.active).toBe(true);
    expect(m.setStartMode('nope')).toBe(false);
    expect(m.setStartMode(undefined)).toBe(true);
    m.beginRun(1);
    expect(m.current).toBe('explore');
    expect(fx.log).toEqual(['show:hud', 'camera:cam-follow:{"blend":"cut"}']);
    m.beginStep(1);
    expect(m.events(1)).toEqual([{ kind: 'enter', mode: 'explore', other: '' }]);
    m.beginStep(2);
    expect(m.events(2)).toEqual([]);
    // A script's switch waits for the next boundary (the last request of a step wins).
    expect(m.request('nope')).toBe(false);
    expect(m.request('tactical', { blend: 'bad' })).toBe(false);
    expect(m.request('explore')).toBe(true);
    expect(m.request('tactical')).toBe(true);
    expect(m.current).toBe('explore');
    expect(m.view().pending).toBe('tactical');
    fx.log.length = 0;
    m.beginStep(3);
    expect(m.current).toBe('tactical');
    expect(m.previous).toBe('explore');
    expect(m.events(3)).toEqual([
      { kind: 'exit', mode: 'explore', other: 'tactical' },
      { kind: 'enter', mode: 'tactical', other: 'explore' },
    ]);
    // Documents, the camera with the mode's own transition blend, the fade document.
    expect(fx.log).toEqual(['hide:hud', 'show:board', 'camera:cam-top:{"blend":"linear","time":0.5}', 'show:fade']);
    expect(m.view()).toMatchObject({ current: 'tactical', name: 'Tactical', previous: 'explore', since: 2, pending: '', pause: false, inputMaps: ['tactical', 'ui'], timeScale: 0.5, physics: 'hold', modes: ['explore', 'tactical'] });
    expect(m.timeScale()).toBe(0.5);
    expect(m.physicsHeld).toBe(true);
    expect(m.pauseAllowed).toBe(false);
    // The fade document leaves after its time (0.25 s = 30 steps).
    fx.log.length = 0;
    m.beginStep(32);
    expect(fx.log).toEqual([]);
    m.beginStep(33);
    expect(fx.log).toEqual(['hide:fade']);
    expect(m.secondsIn(3 + HZ)).toBe(1);
  });

  it('a UI mode action switches at once (before the step\'s scripts); a script transition overrides the mode\'s own', () => {
    const fx = effects();
    const m = new ModeState({ modes: MODES, actionMaps: ACTION_MAPS }, HZ, fx);
    m.beginRun(1);
    m.beginStep(5);
    fx.log.length = 0;
    m.deliver([{ kind: 'click' }, { kind: 'mode', value: 'tactical' }], 5);
    expect(m.current).toBe('tactical');
    expect(m.events(5).map((e) => `${e.kind}:${e.mode}`)).toEqual(['exit:explore', 'enter:tactical']);
    m.deliver([{ kind: 'mode', value: 'nope' }], 5);
    expect(fx.log.some((l) => l.startsWith('warn:'))).toBe(true);
    fx.log.length = 0;
    expect(m.request('explore', { blend: 'cut', fade: '' })).toBe(true);
    m.beginStep(6);
    expect(fx.log).toEqual(['hide:board', 'show:hud', 'camera:cam-follow:{"blend":"cut"}', 'hide:fade']);
  });

  it('masks the actions of inactive maps (move/jump with gameplay off) and ticks the listed groups', () => {
    const m = new ModeState({ modes: MODES, actionMaps: ACTION_MAPS }, HZ, effects());
    m.beginRun(1);
    const frame: ActionFrame = { stepIndex: 1, moveX: 0.5, moveY: -1, jump: 'held', actions: { move: { v: 1, x: 0.5, y: -1, p: 'none' }, select: { v: 1, p: 'pressed' }, pause: { v: 0, p: 'none' } } };
    // Explore: gameplay and ui active — only the tactical action reads as released.
    const e = m.mask(frame);
    expect(e.moveX).toBe(0.5);
    expect(e.actions!['select']).toEqual({ v: 0, p: 'none' });
    expect(e.actions!['move']).toBe(frame.actions!['move']);
    expect(m.ticks('field')).toBe(true);
    expect(m.ticks('board')).toBe(false);
    expect(m.ticks(undefined)).toBe(true);
    expect(m.ticksAll).toBe(false);
    m.request('tactical');
    m.beginStep(2);
    const t = m.mask(frame);
    expect([t.moveX, t.moveY, t.jump]).toEqual([0, 0, 'none']);
    expect(t.actions!['move']).toEqual({ v: 0, x: 0, y: 0, p: 'none' });
    expect(t.actions!['select']).toBe(frame.actions!['select']);
    expect(m.ticks('field')).toBe(false);
    expect(m.ticks('board')).toBe(true);
    // The recorded frame itself is untouched.
    expect(frame.moveX).toBe(0.5);
    // A mode without input maps reads every map.
    const all = new ModeState({ modes: [{ modeId: 'only', name: 'Only' }], actionMaps: ACTION_MAPS }, HZ, effects());
    all.beginRun(1);
    expect(all.mask(frame)).toBe(frame);
    expect(all.ticksAll).toBe(true);
  });

  it('without modes nothing runs', () => {
    const m = new ModeState(undefined, HZ, effects());
    m.beginRun(1);
    m.beginStep(1);
    expect(m.active).toBe(false);
    expect(m.current).toBeNull();
    expect(m.request('x')).toBe(false);
    expect(m.ticks('any')).toBe(true);
    expect(m.timeScale()).toBe(1);
  });
});

// ---- the runtime ---------------------------------------------------------------

interface Trace {
  field: number;
  board: number;
  lines: string[];
}

function director(trace: Trace) {
  return (_s: unknown, ctx: BehaviorContext): void => {
    if (ctx.phase !== 'intent') return;
    const modes = ctx.modes!;
    for (const e of modes.events()) trace.lines.push(`${ctx.stepIndex}:${e.kind}:${e.mode}:${e.other}`);
    if (ctx.input.pressed('toggle')) modes.switch(modes.is('explore') ? 'tactical' : 'explore');
    if (ctx.input.held('select')) trace.lines.push(`${ctx.stepIndex}:select`);
    if (ctx.input.held('jump')) trace.lines.push(`${ctx.stepIndex}:jump`);
    if (ctx.stepIndex === 700) ctx.lifecycle!.restart();
  };
}

function makeRuntime(frames: readonly ActionFrame[] | null, trace: Trace, startMode?: string): { rt: Runtime; tick(n?: number): void } {
  const mk = (behaviorId: string, step: (s: unknown, ctx: BehaviorContext) => void, owned: string[] = []) =>
    createBehaviorModuleSpec({
      declaration: { properties: [] } as never,
      artifact: { behaviorId, sourceDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), outputDigest: 'c'.repeat(64), ownedTransforms: owned, requiredModules: [], enginePins: [], namespace: { default: { step } } } as never,
    });
  const field = mk('field', (_s, ctx) => {
    if (ctx.phase !== 'intent') return;
    trace.field += 1;
  });
  const board = mk('board', (_s, ctx) => {
    if (ctx.phase === 'intent') trace.board += 1;
    else ctx.emit({ kind: 'transform', entityId: 'piece-0001', position: { x: trace.board * 0.01 } } as never);
  }, ['piece-0001']);
  const dir = mk('director', director(trace));
  const registry = createSimulationRegistry();
  for (const s of [field, board, dir]) registerSimulationModule(registry, s.id, s);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'modes@r1',
      projectId: 'modes',
      revision: 1,
      scene: {
        schemaVersion: 4,
        sceneId: 'scene-main',
        revision: 1,
        entities: [
          { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } } },
          { id: 'cam-follow', components: { transform: at(0, 2, 6), virtualCamera: { rig: 'fixed' } } },
          { id: 'cam-top', components: { transform: at(0, 20, 0), virtualCamera: { rig: 'fixed', priority: -5 } } },
          { id: 'walker-0001', components: { transform: at(0, 0), behavior: { behaviorId: 'field', values: {} }, behaviorGroup: { group: 'field' } } },
          { id: 'piece-0001', components: { transform: at(1, 0), behavior: { behaviorId: 'board', values: {} }, behaviorGroup: { group: 'board' } } },
          { id: 'logic-0001', components: { transform: at(0, 0), behavior: { behaviorId: 'director', values: {} } } },
        ],
      },
      uiDocuments: [
        { uiDocumentId: 'hud', layer: 0, modal: false },
        { uiDocumentId: 'board', layer: 0, modal: false },
        { uiDocumentId: 'fade', layer: 50, modal: false },
      ],
      modes: { modes: MODES, actionMaps: { ...ACTION_MAPS, toggle: 'ui' } },
    },
    registry,
    modules: [field.id, board.id, dir.id],
    actions: frames !== null ? createRecordedActionSource(frames) : { sample: (i: number) => neutralFrame(i) },
    settings: {},
    fixedStepHz: HZ,
    clock: () => now.t,
    driver: { kind: 'manual' },
    ...(startMode !== undefined ? { startMode } : {}),
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

function recording(): ActionFrame[] {
  const frames: ActionFrame[] = [];
  const button = (p: 'pressed' | 'held') => ({ v: 1, p });
  for (let s = 0; s < 900; s += 1) {
    const f: ActionFrame = { stepIndex: s, moveX: 0, jump: 'none', actions: {} };
    const actions: Record<string, { v: number; p: 'pressed' | 'held' | 'none' }> = {};
    if (s === 100) actions['toggle'] = button('pressed');
    if (s >= 50 && s < 60) actions['select'] = button('held'); // explore: the tactical map is off
    if (s >= 150 && s < 155) actions['select'] = button('held'); // tactical: on
    if (s >= 150 && s < 155) actions['jump'] = button('held'); // tactical: gameplay is off
    if (s === 300) f.ui = [{ kind: 'mode', doc: 'board', widget: 'back', name: '', value: 'explore' }];
    (f as { actions: unknown }).actions = actions;
    frames.push(f);
  }
  return frames;
}

describe('game modes in the runtime', () => {
  it('a switch changes the input map, the camera, the UI documents and the ticking groups in one step, without a scene load', () => {
    const trace: Trace = { field: 0, board: 0, lines: [] };
    const { rt, tick } = makeRuntime(recording(), trace);
    tick(40);
    expect(rt.modeView!()!.current).toBe('explore');
    expect(rt.uiView!().shown.map((s) => s.doc)).toEqual(['hud']);
    expect(rt.cameraView!()!.live).toBe('cam-follow');
    const set0 = rt.sceneSet!().revision;
    tick(80); // step ~120: the toggle at 100 switched at 101
    const lines = trace.lines;
    expect(lines).toContain('0:enter:explore:');
    expect(lines.filter((l) => l.endsWith(':select')).every((l) => Number(l.split(':')[0]) >= 150)).toBe(true); // explore masked select
    const enter = lines.find((l) => l.includes(':enter:tactical:'))!;
    expect(enter).toBe('101:enter:tactical:explore');
    expect(lines).toContain('101:exit:explore:tactical');
    const view = rt.modeView!()!;
    expect(view).toMatchObject({ current: 'tactical', previous: 'explore', since: 101, timeScale: 0.5, physics: 'hold', pause: false });
    expect(rt.uiView!().shown.map((s) => s.doc)).toEqual(['board', 'fade']);
    const cam = rt.cameraView!()!;
    expect(cam.live).toBe('cam-top');
    expect(rt.sceneSet!().revision).toBe(set0); // nothing loaded or unloaded
    // Groups: the field group stopped at the switch, the board group started.
    const fieldAt = trace.field;
    const boardAt = trace.board;
    expect(boardAt).toBeGreaterThan(0);
    // The time scale halves the steps per second from here: 120 ticks run ~60 steps.
    const s0 = stepOf(rt);
    tick(120);
    expect(stepOf(rt) - s0).toBeGreaterThan(50);
    expect(stepOf(rt) - s0).toBeLessThan(70);
    expect(trace.field).toBe(fieldAt);
    expect(trace.board).toBeGreaterThan(boardAt);
    // Tactical reads select (its map) and not jump (gameplay is off).
    expect(lines.filter((l) => l.endsWith(':select')).length).toBe(5);
    expect(lines.filter((l) => l.endsWith(':jump')).length).toBe(0);
    // The fade document left after its 0.25 s.
    expect(rt.uiView!().shown.map((s) => s.doc)).toEqual(['board']);
    rt.dispose();
  });

  it('a UI mode action switches before the step\'s scripts; a restart starts over in the start mode at the authored transforms', () => {
    const trace: Trace = { field: 0, board: 0, lines: [] };
    const { rt, tick } = makeRuntime(recording(), trace);
    tick(40 + 80 + 400); // past the UI switch at step 300 (the time scale halves steps while tactical)
    expect(trace.lines).toContain('300:enter:explore:tactical');
    expect(rt.modeView!()!.current).toBe('explore');
    while (stepOf(rt) < 705) tick(1);
    // The restart asked for at step 700 applied at 701: the start mode's enter event, the piece back home.
    expect(trace.lines).toContain('701:enter:explore:');
    const st = rt.getInterpolatedState();
    const piece = st.ok ? st.state.transforms.find((t) => t.id === 'piece-0001') : undefined;
    expect(piece?.position[0]).toBe(1);
    rt.dispose();
  });

  it('the start mode option; two runs from one recording give the same mode states and UI at every step', () => {
    const trace: Trace = { field: 0, board: 0, lines: [] };
    const started = makeRuntime(null, trace, 'tactical');
    started.tick(5);
    expect(started.rt.modeView!()!.current).toBe('tactical');
    expect(trace.lines).toContain('0:enter:tactical:');
    started.rt.dispose();
    expect(() => makeRuntime(null, trace, 'nope')).toThrow(/startMode/);
    const run = (): string[] => {
      const t: Trace = { field: 0, board: 0, lines: [] };
      const { rt, tick } = makeRuntime(recording(), t);
      const out: string[] = [];
      for (let i = 0; i < 600; i += 1) {
        tick(1);
        out.push(`${stepOf(rt)}|${JSON.stringify(rt.modeView!())}|${JSON.stringify(rt.uiView!().shown)}|${rt.cameraView!()!.live}|${t.field}|${t.board}`);
      }
      rt.dispose();
      return out;
    };
    expect(run()).toEqual(run());
  });
});
