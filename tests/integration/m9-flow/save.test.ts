/**
 * Phase 9.11: saves through the production composition — a player collects a
 * coin and reaches a checkpoint (autosave); a brand-new host on the same
 * storage (a reloaded page) shows Continue and resumes at the checkpoint with
 * the coin still collected and counted, the lives kept, and a script's
 * `ctx.save` value back. The settings (music volume) survive too.
 */
import { describe, expect, it } from 'vitest';

import { createGameHost, type SaveStorage } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { createBehaviorModuleSpec } from '@thirdlight/runtime';

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
  appendChild(c: FakeNode): void {
    this.children.push(c);
  }
  remove(): void {}
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  allText(): string {
    return [this.textContent, ...this.children.map((c) => c.allText())].join(' ');
  }
}

const ENTITIES: Any[] = [
  { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 }, cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2 } } },
  { id: 'player-0001', components: { transform: at(0, 0.91), controller: {}, behavior: { behaviorId: 'diary', values: { speed: 1 } } } },
  { id: 'spawn-0001', components: { transform: at(0, 0.91), playerSpawn: {} } },
  { id: 'spawn-cp', components: { transform: at(6, 0.91), playerSpawn: {} } },
  { id: 'floor-0001', components: { transform: at(10, -0.5), box: { size: [40, 1, 2], material: { color: '#888888' } }, collider: { shape: { type: 'box', hx: 20, hy: 0.5 } } } },
  { id: 'coin-0001', components: { transform: at(2, 0.8), box: { size: [0.4, 0.4, 0.1], material: { color: '#ffcc00' } }, pickup: { kind: 'coin', value: 1 } } },
  { id: 'cp-0001', components: { transform: at(6, 1), gameZone: { role: 'checkpoint', size: [1, 2], safeSpawnId: 'spawn-cp', activation: { emissive: '#1bc8ff', emissiveIntensity: 1, cueAssetId: null } } } },
  { id: 'goal-0001', components: { transform: at(25, 1), gameZone: { role: 'goal', size: [1, 2] } } },
];

async function page(storage: SaveStorage, diary: unknown[]) {
  const physics = await createPhysicsPort({
    character: { x: 0, y: 0.91 },
    statics: [{ entityId: 'floor-0001', shape: { type: 'box', hx: 20, hy: 0.5 }, position: { x: 10, y: -0.5 }, rotationZ: 0 }],
    solver: { hz: 120, gravityY: SETTINGS.gravity_y },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  } as Any);
  if (!physics.ok) throw new Error(JSON.stringify(physics.error));
  // A script that writes a value into the save once, and reports what it reads.
  const script = createBehaviorModuleSpec({
    declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 10, step: 1 }] } as Any,
    artifact: {
      behaviorId: 'diary',
      sourceDigest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
      outputDigest: 'c'.repeat(64),
      ownedTransforms: [],
      requiredModules: [],
      enginePins: [],
      namespace: {
        default: {
          instantiate: () => ({}),
          step: (_s: unknown, ctx: Any) => {
            const seen = ctx.save?.get('firstVisit');
            if (seen === undefined && ctx.stepIndex > 200) ctx.save?.set('firstVisit', ctx.stepIndex);
            if (ctx.stepIndex % 50 === 0) diary.push(seen ?? null);
          },
        },
      },
    } as Any,
  });
  let move = 0;
  const ui: Any = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
  const container = new FakeNode();
  const host = createGameHost({
    snapshot: {
      snapshotId: 'save@r1',
      projectId: 'save',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: ENTITIES },
      scenes: [{ sceneId: 'scene-main', start: true, entityIds: ENTITIES.map((e) => e.id) }],
      game: { configVersion: 2, title: 'Save Test', objective: 'o', instructions: 'i', playerId: 'player-0001', cameraId: 'cam-main', spawnId: 'spawn-0001', cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } },
    },
    settings: SETTINGS,
    physics: physics.port,
    behaviorModules: [script],
    adapter: () => null,
    input: {
      sample: (stepIndex: number) => ({ stepIndex, moveX: move, jump: 'none' }),
      sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
      markConfirmConsumed: () => undefined,
      sampleUi: () => {
        const out = { ...ui };
        for (const k of Object.keys(ui)) ui[k] = false;
        return out;
      },
      dispose: () => undefined,
    },
    audio: { registerCue: () => ({ ok: true }), submit: () => ({ ok: true }), unlock: async () => ({ state: 'blocked' }), setMuted: () => ({}), setHidden: () => ({}), status: () => ({ state: 'blocked', reason: 'autoplay_denied' }), dispose: () => ({ ok: true }), liveVoices: () => 0, setVolume: () => undefined },
    readArtifact: async () => new ArrayBuffer(0),
    container,
    buildId: 'b',
    document: { createElement: () => new FakeNode() },
    flow: { levels: [{ id: 'meadow-1', name: 'Meadow 1', scenes: ['scene-main'], spawnId: 'spawn-0001' }], lives: { start: 3, max: 5 } },
    saveStorage: storage,
    saveNamespace: 'thirdlight:save',
  } as Any);
  const mounted = host.mount();
  if (!mounted.ok) throw new Error(JSON.stringify(mounted.error));
  const rt: Any = host.runtime;
  let now = 0;
  const tick = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      now += DT;
      const r = rt.tick(now);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
    }
    await new Promise((r) => setTimeout(r, 0));
  };
  const menu = (): FakeNode => container.children.find((c) => c.attrs['class']?.startsWith('tl-flow')) as FakeNode;
  const obs = (): Any => (host.observe() as Any).observation;
  const px = (): number => rt.getInterpolatedState().state.transforms.find((t: Any) => t.id === 'player-0001').position[0];
  return { host, rt, tick, ui, menu, obs, px, setMove: (m: number) => (move = m) };
}

describe('saves (real host, Rapier, a reloaded page)', () => {
  it('a checkpoint autosaves; a new page continues there with the coin collected, the lives and a script value', async () => {
    const map = new Map<string, string>();
    const storage: SaveStorage = { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) };
    const diary1: unknown[] = [];
    const first = await page(storage, diary1);
    await first.tick(10);
    expect(first.menu().allText()).not.toContain('Continue');
    first.ui.submit = true; // New game
    await first.tick(20);
    first.setMove(1);
    for (let i = 0; i < 40 && first.obs().checkpointId === null; i++) await first.tick(10);
    expect(first.obs().checkpointId).toBe('cp-0001');
    await first.tick(200); // the script writes its value; a later checkpoint autosave is not needed for it
    first.setMove(0);
    // Pause → Settings → music volume down (saved at once).
    first.ui.pause = true;
    await first.tick(1);
    first.ui.down = true;
    await first.tick(1);
    first.ui.down = true;
    await first.tick(1);
    first.ui.down = true;
    await first.tick(1);
    first.ui.submit = true; // Resume, Restart, Save game, [Settings]
    await first.tick(1);
    expect(first.obs().flow.screen).toBe('settings');
    first.ui.left = true;
    await first.tick(1);
    first.ui.cancel = true;
    await first.tick(1);
    // Save game → Slot 1 (includes the script value written after the checkpoint).
    first.ui.down = true;
    await first.tick(1);
    first.ui.down = true;
    await first.tick(1);
    first.ui.submit = true;
    await first.tick(1);
    expect(first.obs().flow.screen).toBe('save');
    first.ui.submit = true; // Slot 1
    await first.tick(1);
    expect(first.obs().flow.save).toMatchObject({ slots: { auto: 'ok', '1': 'ok', '2': 'empty', '3': 'empty' }, lastWrite: '1' });
    first.host.dispose();

    // The page reloads: a new host on the same storage.
    const diary2: unknown[] = [];
    const second = await page(storage, diary2);
    await second.tick(10);
    expect(second.obs().flow.volumes.music).toBeCloseTo(0.7, 5); // the settings came back
    expect(second.menu().allText()).toContain('Continue — Meadow 1');
    expect(second.menu().allText()).toContain('Load game');
    // Load game → Slot 1: at the checkpoint, the coin still collected, the value back.
    second.ui.down = true;
    await second.tick(1);
    second.ui.down = true;
    await second.tick(1);
    second.ui.submit = true;
    await second.tick(1);
    expect(second.obs().flow.screen).toBe('load');
    second.ui.submit = true; // Slot 1
    await second.tick(60);
    expect(second.obs().flow).toMatchObject({ screen: 'playing', lives: 3 });
    expect(second.obs().state).toBe('playing');
    expect(second.obs().checkpointId).toBe('cp-0001');
    expect(second.px()).toBeCloseTo(6, 0); // the checkpoint's safe spawn
    expect(second.rt.gameCounters().counters).toMatchObject({ coins: 1 });
    expect(second.rt.hiddenEntities().has('coin-0001')).toBe(true);
    await second.tick(120);
    expect(diary2.some((v) => typeof v === 'number')).toBe(true); // ctx.save.get returned the saved step
  });

  it('a damaged autosave is reported and ignored', async () => {
    const map = new Map<string, string>([['thirdlight:save:auto', '{"sum":"00000000","body":"{}"}']]);
    const storage: SaveStorage = { get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) };
    const g = await page(storage, []);
    await g.tick(5);
    expect(g.menu().allText()).toContain('Damaged save ignored: Autosave');
    expect(g.menu().allText()).not.toContain('Continue');
    expect(g.obs().flow.save.slots.auto).toBe('damaged');
    expect(g.host.control('clearSave').ok).toBe(true);
    expect(map.size).toBe(0);
  });
});
