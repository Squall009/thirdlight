/**
 * Phase 9.10: the game flow through the production composition (the real
 * game host, platformer, Rapier, scene loading through `loadScene`):
 * the title screen, level 1 → level complete → level 2 (its scene loaded, the
 * player moved to its spawn) → the end screen; lives running out on a
 * hazard → game over → retry; the pause menu stopping the simulation; the
 * music following the screens and the music volume setting.
 */
import { describe, expect, it } from 'vitest';

import { createGameAudioOwner, createGameHost } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 8, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };

class FakeNode {
  textContent = '';
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  handlers = new Map<string, () => void>();
  appendChild(c: FakeNode): void {
    this.children.push(c);
  }
  remove(): void {}
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(t: string, h: () => void): void {
    this.handlers.set(t, h);
  }
  removeEventListener(): void {}
  /** Every text in the subtree. */
  allText(): string {
    return [this.textContent, ...this.children.map((c) => c.allText())].join(' ');
  }
}

/** A fake audio graph: gains are plain numbers; decode yields a 3 s buffer. */
function fakeAudio(): Any {
  const node = (): Any => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
  const ctx: Any = {
    state: 'running',
    currentTime: undefined,
    resume: async () => undefined,
    suspend: async () => undefined,
    close: async () => undefined,
    decodeAudioData: async () => ({ duration: 3, sampleRate: 44100, length: 132300 }),
    createBufferSource: () => ({ buffer: null, onended: null, loop: false, connect() {}, start() {}, stop() {} }),
    createGain: node,
    destination: node(),
  };
  return createGameAudioOwner({ contextFactory: () => ctx });
}

const floor = (id: string, x: number, width: number) => ({ id, components: { transform: at(x, -0.5), box: { size: [width, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: width / 2, hy: 0.5 } } } });

const MAIN = [
  { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
  { id: 'player-0001', components: { transform: at(0, 0.91), controller: {} } },
  { id: 'spawn-0001', components: { transform: at(0, 0.91), playerSpawn: {} } },
  floor('floor-0001', 5, 20),
  { id: 'goal-0001', components: { transform: at(6, 1), gameZone: { role: 'goal', size: [1, 2] } } },
  { id: 'lava-0001', components: { transform: at(-6, 0.5), gameZone: { role: 'hazard', size: [1, 1] } } },
];
const LEVEL2 = [
  floor('floor-0002', 105, 20),
  { id: 'spawn-0002', components: { transform: at(100, 0.91), playerSpawn: {} } },
  { id: 'goal-0002', components: { transform: at(104, 1), gameZone: { role: 'goal', size: [1, 2] } } },
];

const FLOW = {
  levels: [
    { id: 'meadow-1', name: 'Meadow 1', scenes: ['scene-main'], spawnId: 'spawn-0001', music: 'music-1' },
    { id: 'meadow-2', name: 'Meadow 2', scenes: ['scene-main', 'scene-two'], spawnId: 'spawn-0002', music: 'music-2' },
  ],
  lives: { start: 2, max: 5 },
  title: { subtitle: 'Two little levels', music: 'music-title' },
  hud: { preset: 'corners', timer: true },
  texts: { credits: 'Made in Thirdlight' },
  volumes: { music: 0.5, sfx: 1 },
};

async function game() {
  const statics = MAIN.filter((e: Any) => e.components.collider).map((e: Any) => ({ entityId: e.id, shape: e.components.collider.shape, position: { x: e.components.transform.position[0], y: e.components.transform.position[1] }, rotationZ: 0 }));
  const physics = await createPhysicsPort({
    character: { x: 0, y: 0.91 },
    statics,
    solver: { hz: 120, gravityY: SETTINGS.gravity_y },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  } as Any);
  if (!physics.ok) throw new Error(JSON.stringify(physics.error));
  let move = 0;
  const ui: Any = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
  const input = {
    sample: (stepIndex: number) => ({ stepIndex, moveX: move, jump: 'none' }),
    sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
    markConfirmConsumed: () => undefined,
    sampleUi: () => {
      const out = { ...ui };
      for (const k of Object.keys(ui)) ui[k] = false;
      return out;
    },
    dispose: () => undefined,
  };
  const audio = fakeAudio();
  await audio.unlock();
  const container = new FakeNode();
  const host = createGameHost({
    snapshot: {
      snapshotId: 'flow@r1',
      projectId: 'flow',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: MAIN },
      scenes: [
        { sceneId: 'scene-main', start: true, entityIds: MAIN.map((e) => e.id) },
        { sceneId: 'scene-two', start: false },
      ],
      game: { configVersion: 2, title: 'Flow Test', objective: 'Reach both goals', instructions: 'Walk right', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
    },
    settings: SETTINGS,
    physics: physics.port,
    adapter: () => null,
    input,
    audio,
    readArtifact: async () => new Uint8Array([1, 2, 3]).buffer,
    assetPaths: { 'music-1': 'a/1', 'music-2': 'a/2', 'music-title': 'a/t' },
    container,
    buildId: 'b',
    document: { createElement: () => new FakeNode() },
    loadScene: async (sceneId: string) => {
      if (sceneId !== 'scene-two') throw new Error('unknown scene');
      return LEVEL2 as Any;
    },
    flow: FLOW,
  } as Any);
  const mounted = host.mount();
  if (!mounted.ok) throw new Error(JSON.stringify(mounted.error));
  let now = 0;
  const rt: Any = host.runtime;
  const tick = async (n = 1): Promise<void> => {
    for (let i = 0; i < n; i++) {
      now += DT;
      const r = rt.tick(now);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      if (i % 20 === 0) await Promise.resolve(); // let scene loads and decodes resolve
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  const obs = (): Any => (host.observe() as Any).observation;
  const pos = (): number[] => rt.getInterpolatedState().state.transforms.find((x: Any) => x.id === 'player-0001').position;
  const menuRoot = (): FakeNode => container.children.find((c) => c.attrs['class']?.startsWith('tl-flow')) as FakeNode;
  return { host, rt, tick, obs, pos, ui, setMove: (m: number) => (move = m), menuRoot, container };
}

describe('game flow (real host, platformer, Rapier, scene loading)', () => {
  it('title → level 1 → level complete → level 2 (its scene loaded, its spawn) → the end screen; music per screen', async () => {
    const g = await game();
    await g.tick(20);
    expect(g.obs().flow.screen).toBe('title');
    expect(g.menuRoot().allText()).toContain('Flow Test');
    expect(g.menuRoot().allText()).toContain('Two little levels');
    expect(g.obs().flow.music).toMatchObject({ assetId: 'music-title', playing: true });
    // New game (the first item) with the submit edge.
    g.ui.submit = true;
    await g.tick(30);
    expect(g.obs().flow).toMatchObject({ screen: 'playing', levelId: 'meadow-1', lives: 2 });
    expect(g.obs().state).toBe('playing');
    expect(g.obs().flow.music.assetId).toBe('music-1');
    g.setMove(1);
    await g.tick(240);
    expect(g.obs().state).toBe('won');
    expect(g.obs().flow.screen).toBe('levelComplete');
    expect(g.menuRoot().allText()).toContain('Level complete');
    expect(g.menuRoot().allText()).toMatch(/Time 0:0\d\.\d/);
    g.setMove(0);
    g.ui.submit = true; // Next level
    await g.tick(60);
    expect(g.obs().scenes.loaded.sort()).toEqual(['scene-main', 'scene-two']);
    expect(g.obs().flow).toMatchObject({ screen: 'playing', levelId: 'meadow-2' });
    expect(g.obs().state).toBe('playing');
    expect(g.pos()[0]).toBeCloseTo(100, 0); // at level 2's spawn
    expect(g.obs().flow.music.assetId).toBe('music-2');
    g.setMove(1);
    await g.tick(240);
    expect(g.obs().flow.screen).toBe('levelComplete');
    g.setMove(0);
    g.ui.submit = true; // Finish
    await g.tick(5);
    expect(g.obs().flow.screen).toBe('finished');
    expect(g.menuRoot().allText()).toContain('Made in Thirdlight');
  });

  it('lives run out on a hazard: game over (paused), retry restores the lives and restarts the level', async () => {
    const g = await game();
    await g.tick(10);
    expect(g.host.control('start').ok).toBe(true); // the relay's start = a new game
    await g.tick(20);
    g.setMove(-1); // into the lava, twice
    for (let i = 0; i < 20 && g.obs().flow.screen === 'playing'; i++) await g.tick(60);
    expect(g.obs().flow).toMatchObject({ screen: 'gameOver', lives: 0 });
    const step = g.obs().stepIndex;
    await g.tick(60);
    expect(g.obs().stepIndex).toBe(step); // paused
    g.setMove(0);
    g.ui.submit = true; // Retry level
    await g.tick(40);
    expect(g.obs().flow).toMatchObject({ screen: 'playing', lives: 2, levelId: 'meadow-1' });
    expect(g.obs().deathCount).toBe(0);
    expect(Math.abs(g.pos()[0])).toBeLessThan(0.5);
  });

  it('pause stops the steps; settings change the music volume (the music bus gain)', async () => {
    const g = await game();
    await g.tick(10);
    g.host.control('start');
    await g.tick(20);
    expect(g.obs().flow.music.gain).toBeCloseTo(0.5, 5);
    g.ui.pause = true;
    await g.tick(2);
    expect(g.obs().flow.screen).toBe('paused');
    const step = g.obs().stepIndex;
    await g.tick(30);
    expect(g.obs().stepIndex).toBe(step);
    g.ui.down = true;
    await g.tick(1);
    g.ui.down = true;
    await g.tick(1);
    g.ui.submit = true; // Resume, Restart level, [Settings]
    await g.tick(1);
    expect(g.obs().flow.screen).toBe('settings');
    g.ui.right = true; // Music volume +10 %
    await g.tick(1);
    expect(g.obs().flow.volumes.music).toBeCloseTo(0.6, 5);
    expect(g.obs().flow.music.gain).toBeCloseTo(0.6, 5);
    expect(g.menuRoot().attrs['data-music-gain']).toBe('0.60');
    g.ui.cancel = true; // back to the pause menu
    await g.tick(1);
    expect(g.obs().flow.screen).toBe('paused');
    g.ui.pause = true; // resume
    await g.tick(10);
    expect(g.obs().flow.screen).toBe('playing');
    expect(g.obs().stepIndex).toBeGreaterThan(step);
  });
});
