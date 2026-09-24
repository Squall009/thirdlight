/**
 * Phase 14.5: the flow controller's pad rebinding (saved with the settings),
 * menu sounds on the `ui` bus with their own volume, each level's ambience
 * and the title screen's background scene and pan.
 */
import { describe, expect, it } from 'vitest';
import type { GameView } from '@thirdlight/runtime';

import { createFlowController, type FlowConfigLike } from './flow';
import { titleAnchor } from './host';
import type { HostDomNode } from './hud';
import { createSaveStore, type SaveStorage } from './save';

class Node implements HostDomNode {
  textContent = '';
  attrs: Record<string, string> = {};
  children: Node[] = [];
  parent: Node | null = null;
  appendChild(c: HostDomNode): void {
    (c as Node).parent = this;
    this.children.push(c as Node);
  }
  remove(): void {
    if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const NO_UI = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
const DEFAULT_ACTIONS = {
  actions: [
    { name: 'move', type: 'axis1d', map: 'gameplay', bindings: [{ kind: 'keys1d', negative: 'KeyA', positive: 'KeyD' }, { kind: 'gamepadButtons1d', negative: 14, positive: 15 }, { kind: 'gamepadAxis', axis: 0 }] },
    { name: 'jump', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Space' }, { kind: 'gamepadButton', button: 0 }] },
    { name: 'attack', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyJ' }, { kind: 'gamepadButton', button: 2 }] },
    { name: 'interact', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyE' }, { kind: 'gamepadButton', button: 3 }] },
  ],
};

function memoryStorage(): SaveStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v), remove: (k) => void data.delete(k) } as SaveStorage & { data: Map<string, string> };
}

function harness(flow: FlowConfigLike, storage = memoryStorage()) {
  const sounds: { id: string; bus: string | undefined }[] = [];
  const volumes: Record<string, number> = {};
  const configured: unknown[] = [];
  const sceneOps: string[] = [];
  let padCapture: ((b: number | null) => void) | null = null;
  const root = new Node();
  const input = {
    captureKey: () => () => undefined,
    capturePadButton: (cb: (b: number | null) => void) => {
      padCapture = cb;
      return () => (padCapture = null);
    },
    configure: (c: unknown) => configured.push(c),
    config: structuredClone(DEFAULT_ACTIONS) as { actions: { name: string; type: string; map: string; bindings: unknown[] }[] },
  };
  let run = 0;
  const ctl = createFlowController({
    flow,
    gameTitle: 'Menus',
    objective: '',
    instructions: '',
    dom: { createElement: () => new Node() },
    container: root,
    runtime: {
      requestScene: (op, id) => {
        sceneOps.push(`${op} ${id}`);
        return { ok: true };
      },
      startLevel: () => {
        run += 1;
        return { ok: true };
      },
      runState: () => ({ checkpointId: null, counters: {}, collected: [], defeated: [], health: null, values: {} }),
      setPaused: () => undefined,
      gameCounters: () => ({ counters: {}, health: null }),
    },
    audio: {
      setVolume: (bus, v) => void (volumes[bus] = v),
      playSound: (id, _v, bus) => {
        sounds.push({ id, bus });
        return true;
      },
    },
    input,
    save: createSaveStore(storage, 'test'),
  });
  const view = (state: GameView['state']): GameView => ({ runId: `run-${run}`, state, simTime: 0, deathCount: 0, checkpointId: null }) as unknown as GameView;
  const frame = (ui: Partial<typeof NO_UI> = {}, state: GameView['state'] = 'awaitingStart'): boolean => ctl.frame(view(state), { ...NO_UI, ...ui });
  const itemNodes = (): Node[] => {
    const panel = root.children[0]!.children.find((c) => c.children.length > 0 && c.attrs['class'] === 'tl-flow__panel')!;
    return panel.children.find((c) => c.attrs['class'] === 'tl-flow__items')!.children;
  };
  const labels = (): string[] => itemNodes().map((c) => c.textContent);
  /** Move the selection to the item whose label starts with `prefix`. */
  const select = (prefix: string): void => {
    const i = labels().findIndex((l) => l.startsWith(prefix));
    expect(i, `${prefix} in ${labels().join(' | ')}`).toBeGreaterThanOrEqual(0);
    const at = itemNodes().findIndex((c) => (c.attrs['class'] ?? '').includes('is-selected'));
    for (let k = at; k < i; k++) frame({ down: true });
    for (let k = at; k > i; k--) frame({ up: true });
  };
  return { ctl, sounds, volumes, configured, input, sceneOps, storage, frame, labels, select, capture: (b: number | null) => padCapture?.(b), capturing: () => padCapture !== null };
}

const LEVELS: FlowConfigLike['levels'] = [
  { id: 'one', name: 'One', scenes: ['s-main', 's1'], spawnId: 'p1', ambience: ['wind', 'hum'] },
  { id: 'two', name: 'Two', scenes: ['s-main', 's2'], spawnId: 'p2' },
];

describe('pad rebinding in the settings', () => {
  it('rebinds jump to pad button 3: the input owner is reconfigured, the label shows it and the settings keep it', () => {
    const g = harness({ levels: LEVELS });
    g.select('Settings');
    g.frame({ submit: true });
    expect(g.ctl.screen).toBe('settings');
    expect(g.labels()).toEqual(expect.arrayContaining(['Jump (pad): button 0', 'Move left (pad): button 14', 'Move right (pad): button 15', 'Interact (pad): button 3']));
    expect(g.labels()).not.toContain('Menu sounds volume: 100%'); // no menu sounds: no volume for them
    g.select('Jump (pad)');
    g.frame({ submit: true });
    expect(g.capturing()).toBe(true);
    g.frame({ cancel: true }); // menus wait while a button is awaited
    expect(g.ctl.screen).toBe('settings');
    g.capture(3);
    expect(g.labels()).toContain('Jump (pad): button 3');
    const jump = (g.configured.at(-1) as typeof DEFAULT_ACTIONS).actions.find((a) => a.name === 'jump')!;
    expect(jump.bindings).toEqual([{ kind: 'key', code: 'Space' }, { kind: 'gamepadButton', button: 3 }]);
    expect(g.ctl.observe().pad).toEqual({ jump: 3 });
    expect(JSON.parse(g.storage.data.get('test:settings')!).pad).toEqual({ jump: 3 });

    // Move right onto button 5: the move action's button pair changes, left stays 14.
    g.select('Move right (pad)');
    g.frame({ submit: true });
    g.capture(5);
    const move = (g.configured.at(-1) as typeof DEFAULT_ACTIONS).actions.find((a) => a.name === 'move')!;
    expect(move.bindings.filter((b) => b.kind === 'gamepadButtons1d')).toEqual([{ kind: 'gamepadButtons1d', negative: 14, positive: 5 }]);

    // A cancelled capture changes nothing.
    g.select('Attack (pad)');
    g.frame({ submit: true });
    g.capture(null);
    expect(g.labels()).toContain('Attack (pad): button 2');

    // A new session (a reload) applies the saved pad buttons at once.
    const again = harness({ levels: LEVELS }, g.storage);
    expect(again.ctl.observe().pad).toEqual({ jump: 3, right: 5 });
    expect((again.input.config.actions.find((a) => a.name === 'jump')!.bindings as unknown[]).at(-1)).toEqual({ kind: 'gamepadButton', button: 3 });
  });

  it('refuses damaged saved pad values', () => {
    const storage = memoryStorage();
    storage.data.set('test:settings', JSON.stringify({ music: 0.5, sfx: 1, quality: 'high', keys: {}, ui: 7, pad: { jump: 99, attack: 1.5, left: 4 } }));
    const s = createSaveStore(storage, 'test').readSettings()!;
    expect(s.pad).toEqual({ left: 4 });
    expect('ui' in s).toBe(false);
  });
});

describe('menu sounds', () => {
  it('move, confirm and back play on the ui bus; the settings have their volume (saved)', () => {
    const g = harness({ levels: LEVELS, sounds: { move: 'snd-move', confirm: 'snd-ok', back: 'snd-back' }, volumes: { music: 0.8, sfx: 1, ui: 0.6 } });
    expect(g.volumes['ui']).toBeCloseTo(0.6, 5);
    g.frame({ down: true });
    expect(g.sounds.at(-1)).toEqual({ id: 'snd-move', bus: 'ui' });
    g.select('Settings');
    g.frame({ submit: true });
    expect(g.sounds.at(-1)).toEqual({ id: 'snd-ok', bus: 'ui' });
    expect(g.labels()).toContain('Menu sounds volume: 60%');
    g.select('Menu sounds volume');
    g.frame({ right: true });
    expect(g.volumes['ui']).toBeCloseTo(0.7, 5);
    expect(JSON.parse(g.storage.data.get('test:settings')!).ui).toBeCloseTo(0.7, 5);
    g.frame({ cancel: true });
    expect(g.ctl.screen).toBe('title');
    expect(g.sounds.at(-1)).toEqual({ id: 'snd-back', bus: 'ui' });
    expect(g.ctl.observe().menuSounds).toEqual({ played: g.sounds.length, last: 'back' });
    expect(g.sounds.every((s) => s.bus === 'ui')).toBe(true);
  });

  it('a game without menu sounds plays none', () => {
    const g = harness({ levels: LEVELS });
    g.frame({ down: true });
    g.frame({ submit: true });
    expect(g.sounds).toEqual([]);
    expect(g.ctl.observe().menuSounds.played).toBe(0);
  });
});

describe('ambience and the title background', () => {
  it("a level's ambience loops while it plays or is paused, not on the title or other levels", () => {
    const g = harness({ levels: LEVELS });
    expect(g.ctl.ambience()).toEqual([]);
    g.ctl.newGame();
    expect(g.ctl.ambience()).toEqual(['wind', 'hum']);
    g.frame({}, 'playing');
    g.frame({ pause: true }, 'playing');
    expect(g.ctl.screen).toBe('paused');
    expect(g.ctl.ambience()).toEqual(['wind', 'hum']);
    g.frame({ cancel: true }, 'playing');
    g.frame({}, 'won');
    expect(g.ctl.screen).toBe('levelComplete');
    expect(g.ctl.ambience()).toEqual([]);
    g.frame({ submit: true }, 'won');
    expect(g.ctl.observe().levelId).toBe('two');
    expect(g.ctl.ambience()).toEqual([]);
  });

  it('the title background scene is loaded at the title and unloaded when a level starts; the pan comes with it', () => {
    const g = harness({ levels: LEVELS, title: { scene: 's-title', pan: { distance: 4, seconds: 20 } } });
    expect(g.sceneOps).toEqual(['load s-title']);
    expect(g.ctl.titleView()).toEqual({ scene: 's-title', pan: { distance: 4, seconds: 20 } });
    g.ctl.newGame();
    expect(g.sceneOps).toEqual(['load s-title', 'unload s-title']);
    expect(g.ctl.titleView()).toBeNull();
    g.frame({}, 'playing');
    g.frame({ pause: true }, 'playing');
    g.select('Quit to title');
    g.frame({ submit: true }, 'playing');
    expect(g.ctl.screen).toBe('title');
    expect(g.sceneOps.at(-1)).toBe('load s-title');
    expect(g.ctl.titleView()?.scene).toBe('s-title');
  });

  it('without a title scene or pan nothing is loaded (the first level start shows, as before)', () => {
    const g = harness({ levels: LEVELS, title: { subtitle: 'x' } });
    expect(g.sceneOps).toEqual([]);
    expect(g.ctl.titleView()).toEqual({ scene: null, pan: null });
  });

  it('titleAnchor: the first player spawn, else the middle of the objects', () => {
    const t = (p: number[]): unknown => ({ transform: { position: p } });
    expect(titleAnchor([{ components: t([0, 0, 0]) }, { components: { ...(t([5, 1, 0]) as object), playerSpawn: {} } }])).toEqual([5, 1, 0]);
    expect(titleAnchor([{ components: t([0, 0, 0]) }, { components: t([10, 4, -2]) }])).toEqual([5, 2, -1]);
    expect(titleAnchor([])).toBeNull();
  });
});
