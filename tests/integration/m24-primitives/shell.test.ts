/**
 * Phase 24.4j: the game shell through the production composition — the real
 * game host, the character controller and Rapier physics, a scene without
 * any game session — on the 2D plane and in 3D, in both threading modes:
 *
 * - the title (a UI document) shows first and the game waits behind it (no
 *   steps); its button's New game action starts the run;
 * - the HUD document shows while the game plays and reads the named counter
 *   a collectible raises (`$flow.counters`) and the prompts generated from
 *   the input actions (`$flow.prompts`);
 * - the pause input opens the pause document (no steps while it shows);
 *   its buttons save to a project save slot, load it back (the counter and
 *   the collectible are restored) and move on to the next listed scene (it
 *   loads and the character stands at its spawn);
 * - phase 24.8: a save carries where the play stands — a load puts the
 *   character back where it was saved (and with its velocity), unloads a
 *   scene the save did not have and loads one it had (after a restart).
 *
 * Every shell move rides on the input frame (a recording replays it); the
 * menus here are live input, so the two threading modes see them at their
 * own steps and are compared by outcome, not by digest.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { memoryProjectSaveBackend } from '@thirdlight/game-host';
import { DEFAULT_INPUT_CONFIG, DEFAULT_INPUT_CONFIG_3D } from '@thirdlight/input';
import { physics3DConfigOf } from '@thirdlight/runtime';

import { FakeNode, MODES, startHarness, type Harness, type Mode } from '../m22-worker/harness';
import { MODULES_3D } from '../m23-3d/character-kit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DT = 1 / 120;
const T = (position: number[], rotation = [0, 0, 0, 1]) => ({ position, rotation, scale: [1, 1, 1] });

const DOCS = [
  { uiDocumentId: 'title', name: 'Title', root: { type: 'panel', children: [{ type: 'button', id: 'start', text: 'New game', onClick: { do: 'engine', action: 'newGame' } }] } },
  {
    uiDocumentId: 'paused',
    name: 'Paused',
    root: {
      type: 'stack',
      direction: 'column',
      children: [
        { type: 'button', id: 'resume', text: 'Resume', onClick: { do: 'engine', action: 'resume' } },
        { type: 'button', id: 'save', text: 'Save', onClick: { do: 'engine', action: 'save', slot: '1' } },
        { type: 'button', id: 'load', text: 'Load', onClick: { do: 'engine', action: 'load', slot: '1' } },
        { type: 'button', id: 'next', text: 'Next', onClick: { do: 'engine', action: 'nextScene' } },
        { type: 'button', id: 'restart', text: 'Restart', onClick: { do: 'engine', action: 'restartLevel' } },
      ],
    },
  },
  { uiDocumentId: 'hud', name: 'HUD', root: { type: 'text', id: 'count', text: 'Items {$flow.counters.items} | {$flow.prompts}' } },
];
const SHELL = { screens: { title: 'title', pause: 'paused' }, hud: ['hud'], scenes: [{ scene: 'scene-main' }, { scene: 'scene-two', spawn: 'spawn-two' }] };

function level(dim: 2 | 3): { main: Any[]; two: Any[] } {
  const z = dim === 3;
  const box = (id: string, c: number[], h: number[]): Any => ({
    id,
    components: { transform: T(c), box: { size: [h[0]! * 2, h[1]! * 2, h[2]! * 2], material: { color: '#888888' } }, collider: { shape: z ? { type: 'box', hx: h[0], hy: h[1], hz: h[2] } : { type: 'box', hx: h[0], hy: h[1] } } },
  });
  const token = (id: string, x: number): Any => ({ id, components: { transform: T([x, 0.9, 0]), collectible: { counter: 'items', size: z ? [1, 1, 1] : [1, 1] } } });
  const main = [
    { id: 'cam-main', components: { transform: T([4, 4, 14]), camera: { type: 'perspective', fovY: 50, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: T([0, 0.91, 0]), controller: z ? { faceMovement: false } : {} } },
    box('floor-a', [3, -0.5, 0], [14, 0.5, 2]),
    token('token-a', 1.5),
    token('token-b', 3.5),
  ];
  const two = [box('floor-b', [45, -0.5, 0], [6, 0.5, 2]), { id: 'spawn-two', components: { transform: T([42, 0.91, 0]), playerSpawn: {} } }];
  return { main, two };
}

const live: Harness[] = [];
afterEach(async () => {
  for (const h of live.splice(0)) await h.dispose();
});

/** Every text under a fake DOM node, in order. */
function texts(n: Any, out: string[] = []): string[] {
  if (typeof n?.textContent === 'string' && n.textContent !== '') out.push(n.textContent);
  for (const c of n?.children ?? []) texts(c, out);
  return out;
}
/** The drawn text of the HUD document (the layer marks each document's root with its source). */
function hudText(n: Any): string | null {
  if (n?.attrs?.['data-tl-ui-source'] === 'hud') return texts(n).join('');
  for (const c of n?.children ?? []) {
    const t = hudText(c);
    if (t !== null) return t;
  }
  return null;
}

const NONE = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };

async function run(mode: Mode, dim: 2 | 3): Promise<Record<string, Any>> {
  const { main, two } = level(dim);
  const settings = dim === 3 ? { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30, physics_dimension: 3 } : { run_speed: 4, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
  const statics = main
    .filter((e) => e.components.collider)
    .map((e) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  const physics =
    dim === 3
      ? physics3DConfigOf(main, settings)
      : { character: { x: 0, y: 0.91 }, statics, solver: { hz: 120, gravityY: settings.gravity_y }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false } };
  // The steps are the game's own (the menus hold them): walk right for 400 steps (well past both tokens), then stand.
  const replay = Array.from({ length: 2000 }, (_, i) => ({ stepIndex: i, moveX: i < 400 ? 1 : 0, ...(dim === 3 ? { moveY: 0 } : {}), jump: 'none' as const }));
  const edges: Any[] = [];
  const container = new FakeNode();
  const store = new Map<string, string>();
  const h = await startHarness(mode, {
    snapshot: {
      snapshotId: `shell${dim}@r1`,
      projectId: `shell${dim}`,
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: main },
      scenes: [
        { sceneId: 'scene-main', start: true, entityIds: main.map((e) => e.id) },
        { sceneId: 'scene-two', start: false },
      ],
      uiDocuments: DOCS.map((d) => ({ uiDocumentId: d.uiDocumentId, layer: 0, modal: false })),
      saveSchema: { version: 1, slots: 3, sections: ['components'] },
      sceneList: SHELL.scenes,
    },
    settings,
    physics,
    replay,
    digestSteps: true,
    loadScene: async (sceneId: string) => {
      if (sceneId !== 'scene-two') throw new Error('unknown scene');
      return two;
    },
    ...(dim === 3 ? { modules: MODULES_3D } : {}),
    input: {
      sample: (stepIndex: number) => ({ stepIndex, moveX: 0, jump: 'none' }),
      sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
      sampleUi: () => edges.shift() ?? NONE,
      markConfirmConsumed: () => undefined,
      dispose: () => undefined,
    },
    // The input config as the export passes it (the project declares none: the dimension's engine defaults).
    host: { container, ui: { documents: DOCS }, shell: SHELL, projectSaveBackend: memoryProjectSaveBackend(store), saveNamespace: 'shell', inputConfig: dim === 3 ? DEFAULT_INPUT_CONFIG_3D : DEFAULT_INPUT_CONFIG },
  });
  live.push(h);
  const rt: Any = h.rt;
  let now = 0;
  const frames = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) {
      now += DT;
      try {
        await h.tick(now);
      } catch (e) {
        const d = (h.rt as Any).getDiagnostics();
        throw new Error(`${String(e)} ${JSON.stringify(d.ok ? d.diagnostics.errors : d).slice(0, 1500)}`);
      }
      await h.host.projectSaves?.idle();
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  };
  const until = async (what: () => boolean, label: string, max = 2000): Promise<void> => {
    for (let i = 0; i < max && !what(); i += 1) await frames(1);
    expect(what(), `${label}: ${JSON.stringify({ step: step(), items: items(), shell: obs().shell, ui: obs().ui, paused: obs().paused, x: px() })}`).toBe(true);
  };
  const press = async (e: Partial<typeof NONE>): Promise<void> => {
    edges.push({ ...NONE, ...e });
    await frames(2);
  };
  const obs = (): Any => (h.host as Any).observe().observation;
  const step = (): number => obs().stepIndex;
  const items = (): number => rt.gameCounters().counters['items'] ?? 0;
  const px = (): number => rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === 'player-0001').position[0];
  const out: Record<string, Any> = {};

  // The title first; the game waits behind it (after the engine's settle pre-roll no step runs).
  await frames(5);
  const titleAt = step();
  await frames(30);
  out.title = { screen: obs().shell.screen, paused: obs().paused, held: step() === titleAt, ui: obs().ui.screen, hud: obs().shell.hud };
  // Its New game button (focused on show) starts the run.
  await press({ submit: true });
  await until(() => items() >= 1, 'first item');
  out.playing = { screen: obs().shell.screen, hud: obs().shell.hud, uiHud: obs().ui.hud, text: hudText(container) };
  // Pause: no steps while the pause document shows; its Save button saves slot 1.
  await press({ pause: true });
  const pausedAt = step();
  await frames(20);
  out.paused = { screen: obs().shell.screen, ui: obs().ui.screen, hud: obs().shell.hud, held: step() === pausedAt };
  await press({ down: true });
  await press({ submit: true });
  await until(() => (h.host.projectSaves?.slots() ?? []).some((s) => s.slot === 1), 'saved');
  const saved = JSON.parse(store.get('shell:slot:1:body')!);
  out.saved = { items: items(), note: obs().shell.note, body: saved.sections.components, formatVersion: saved.formatVersion, world: saved.world, x: px() };
  // Resume (the pause input again), walk on past the second token and stand.
  await press({ pause: true });
  await until(() => items() >= 2 && step() > 460, 'second item');
  out.second = { items: items(), hidden: [...(rt.hiddenEntities?.() ?? [])].sort(), x: px() };
  // Pause, Load (the focus starts at Resume again): the first save comes back (one item, the second token uncollected); the game plays on.
  await press({ pause: true });
  await press({ down: true });
  await press({ down: true });
  await press({ submit: true });
  await until(() => items() === 1 && obs().shell.screen === 'playing', 'loaded');
  await frames(30);
  out.loaded = { items: items(), hidden: [...(rt.hiddenEntities?.() ?? [])].sort(), screen: obs().shell.screen, paused: obs().paused, x: px() };
  // Pause, Next: the listed second scene loads and the character stands at its spawn.
  await press({ pause: true });
  await press({ down: true });
  await press({ down: true });
  await press({ down: true });
  await press({ submit: true });
  await until(() => (obs().scenes?.loaded ?? []).includes('scene-two') && px() > 40, 'next scene');
  await frames(30);
  out.next = { scene: obs().shell.scene, x: px(), loaded: obs().scenes.loaded };
  // Phase 24.8: save here (the second scene), then Load the first save's world back: scene-two unloads, the character is where slot 1 had it.
  // (Save to slot 1 again first so the later load needs scene-two loaded: keep slot 1's world of scene-two.)
  await press({ pause: true });
  await press({ down: true });
  await press({ submit: true });
  await until(() => obs().shell.note === 'Saved to slot 1' && JSON.parse(store.get('shell:slot:1:body')!).world.scenes.includes('scene-two'), 'saved in scene two');
  out.savedTwo = { world: JSON.parse(store.get('shell:slot:1:body')!).world, x: px() };
  // Restart (the focus is on Save: three down): the start set only (scene-two unloads), the character back at its start.
  await press({ down: true });
  await press({ down: true });
  await press({ down: true });
  await press({ submit: true });
  await until(() => !(obs().scenes?.loaded ?? []).includes('scene-two') && px() < 5 && obs().shell.screen === 'playing', 'restarted');
  await frames(20);
  out.restarted = { x: px(), loaded: obs().scenes.loaded };
  // Load slot 1: scene-two loads again and the character stands where it was saved there.
  await press({ pause: true });
  await press({ down: true });
  await press({ down: true });
  await press({ submit: true });
  await until(() => (obs().scenes?.loaded ?? []).includes('scene-two') && px() > 40, 'loaded into scene two');
  await frames(30);
  out.loadedTwo = { x: px(), loaded: obs().scenes.loaded, screen: obs().shell.screen };
  const d = rt.getDiagnostics();
  out.errors = d.ok ? d.diagnostics.errors : d;
  return out;
}

describe.each([2, 3] as const)('the game shell (dimension %s)', (dim) => {
  it.each(MODES)('title, HUD, pause, save, load and the next scene through the game host (threading: %s)', async (mode) => {
    const o = await run(mode, dim);
    expect(o.errors).toEqual([]);
    expect(o.title).toEqual({ screen: 'title', paused: true, held: true, ui: 'title', hud: [] });
    expect(o.playing.screen).toBe('playing');
    expect(o.playing.hud).toEqual(['hud']);
    expect(o.playing.uiHud).toEqual(['hud']);
    // The HUD reads the counter and the prompts generated from the input actions (the engine defaults here).
    // (The fake DOM keeps replaced text nodes: the latest text is last.)
    // The prompts are the gameplay actions of the dimension's default input, named by the bindings' glyph labels.
    const prompts = dim === 3 ? 'W S A D move · Left Shift run · Space jump · J attack · E interact' : 'A / D move · Space jump · J attack · E interact';
    expect(o.playing.text.endsWith(`Items 1 | ${prompts}`), o.playing.text).toBe(true);
    expect(o.paused).toEqual({ screen: 'pause', ui: 'paused', hud: [], held: true });
    expect(o.saved.items).toBe(1);
    expect(o.saved.note).toBe('Saved to slot 1');
    expect(o.saved.body.counters).toEqual({ items: 1 });
    expect(Object.keys(o.saved.body.collected)).toEqual(['token-a']);
    expect(o.second.items).toBe(2);
    expect(o.second.hidden).toEqual(['token-a', 'token-b']);
    expect(o.second.x).toBeGreaterThan(5);
    expect({ ...o.loaded, x: undefined }).toEqual({ items: 1, hidden: ['token-a'], screen: 'playing', paused: false, x: undefined });
    // Phase 24.8: the save (format version 2) carries where the play stood, and the load put the character back there
    // (not where it walked to since); it saved walking, so it keeps its velocity and eases to a stop just ahead.
    expect(o.saved.formatVersion).toBe(2);
    expect(o.saved.world.scenes).toEqual(['scene-main']);
    expect(o.saved.world.character.position[0]).toBeCloseTo(o.saved.x, 6);
    expect(o.saved.world.character.velocity[0]).toBeGreaterThan(1);
    expect(o.loaded.x).toBeGreaterThanOrEqual(o.saved.x - 0.05);
    expect(o.loaded.x).toBeLessThan(o.saved.x + 0.5);
    expect(o.loaded.x).toBeLessThan(o.second.x - 1);
    expect(o.next.scene).toEqual({ index: 1, id: 'scene-two' });
    expect(o.next.loaded).toContain('scene-two');
    expect(o.next.x).toBeGreaterThan(40);
    expect(o.next.x).toBeLessThan(44);
    // Phase 24.8: a save in the second scene, a restart (the start set only), a load: scene-two loads and the character stands where it was saved.
    expect(o.savedTwo.world.scenes).toEqual(['scene-main', 'scene-two']);
    expect(o.savedTwo.world.listedScene).toBe(1);
    expect(o.restarted.loaded).not.toContain('scene-two');
    expect(o.restarted.x).toBeLessThan(5);
    expect(o.loadedTwo.loaded).toContain('scene-two');
    expect(o.loadedTwo.screen).toBe('playing');
    expect(Math.abs(o.loadedTwo.x - o.savedTwo.x)).toBeLessThan(0.05);
  }, 180_000);
});
