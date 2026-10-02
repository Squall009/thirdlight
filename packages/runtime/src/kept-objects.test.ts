/**
 * Kept objects (`keepLoaded`) through the runtime's scene set: a kept
 * camera, player and object (with its child) stay when their scene unloads,
 * scene-less, listed with the spawned copies; loading that scene again brings
 * no second copy; a kept player arrives at a listed scene's spawn when that
 * scene loads; a kept object's reference into a scene that went reads as
 * empty and is reported once; a scene holding a player that is not kept does
 * not unload; scripts spawn kept copies and switch the flag on a handle.
 */
import { describe, expect, it } from 'vitest';

import { createBehaviorModuleSpec, createSimulationRegistry, instantiateRuntime, neutralFrame, registerSimulationModule, type BehaviorArtifact, type Runtime } from './index';

const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0): unknown => ({ position: [x, y, z], ...T });
const box = { size: [1, 1, 1], material: { color: '#808080' } };

function port(placed: { x: number; y: number }[]): unknown {
  let pos = { x: 0, y: 0.91 };
  return {
    stageCharacterMove() {},
    step() {
      return { requested: { x: 0, y: 0 }, applied: { x: 0, y: 0 }, position: { ...pos }, grounded: true, supportNormal: { x: 0, y: 1 }, contacts: { ground: true, wall: false, head: false, steepSlope: false }, snapped: false };
    },
    reset() {},
    clearCharacterMotion() {},
    placeCharacter(c: { x: number; y: number }) {
      placed.push({ ...c });
      pos = { x: c.x, y: c.y };
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    characterClearance() {
      return { ok: true, supportNormal: { x: 0, y: 1 } };
    },
    addStaticColliders() {},
    removeStaticColliders() {},
    diagnostics() {
      return {};
    },
    dispose() {},
  };
}

/** The title scene: a kept camera (aimed at the level's box), a kept player, a kept crate with a child, a spawn, a driver script. */
function titleEntities(playerKept: boolean): unknown[] {
  return [
    { id: 'cam-000001', keepLoaded: true, components: { transform: at(0, 2, 8), virtualCamera: { rig: 'fixed', target: 'box-level' } } },
    { id: 'player-000001', ...(playerKept ? { keepLoaded: true } : {}), components: { transform: at(0, 0.91), controller: {} } },
    { id: 'crate-000001', keepLoaded: true, components: { transform: at(2, 0), box } },
    { id: 'lid-000001', parentId: 'crate-000001', components: { transform: at(0, 1), box } },
    { id: 'spawn-000001', components: { transform: at(0, 0.91), playerSpawn: {} } },
    { id: 'driver-000001', components: { transform: at(0, -9), behavior: { behaviorId: 'driver', values: {} } } },
  ];
}

const LEVEL = [
  { id: 'box-level', components: { transform: at(10, 0), box } },
  { id: 'spawn-level', components: { transform: at(12, 0.91), playerSpawn: {} } },
];

type Ctx = { spawn(p: string, o: unknown): string | null; entity(id: string): { set(c: string, v: unknown): { ok: boolean; message?: string }; get(c: string): Record<string, unknown> | null } | null };

function harness(opts: { playerKept?: boolean; script?: (ctx: Ctx, step: number) => void } = {}) {
  const placed: { x: number; y: number }[] = [];
  let step = 0;
  const artifact: BehaviorArtifact = {
    behaviorId: 'driver',
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
    requiredModules: [],
    enginePins: [],
    namespace: { default: { instantiate: () => ({}), step: (_s: unknown, ctx: unknown) => { if ((ctx as { phase?: string }).phase === 'intent') opts.script?.(ctx as Ctx, (step += 1)); } } },
  };
  const driver = createBehaviorModuleSpec({ declaration: { properties: [] } as never, artifact });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, driver.id, driver);
  const now = { t: 0 };
  const res = instantiateRuntime({
    snapshot: {
      snapshotId: 'kept@r1',
      projectId: 'kept',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: 'scene-title', revision: 1, entities: titleEntities(opts.playerKept ?? true) },
      scenes: [
        { sceneId: 'scene-title', start: true },
        { sceneId: 'scene-level', start: false },
      ],
      sceneList: [{ scene: 'scene-level', spawn: 'spawn-level' }],
      prefabs: [{ prefabId: 'prefab-0001', displayName: 'Crate', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'root', components: { transform: at(0, 0), box } }] }],
    },
    registry,
    modules: [driver.id],
    actions: { sample: (i: number) => neutralFrame(i) },
    physics: port(placed) as never,
    settings: {},
    clock: () => now.t,
    driver: { kind: 'manual' },
  });
  if (!res.ok) throw new Error(JSON.stringify(res.error));
  const rt: Runtime = res.runtime;
  expect(rt.start().ok).toBe(true);
  expect(rt.tick(0).ok).toBe(true);
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i += 1) {
      now.t += DT;
      const r = rt.tick(now.t);
      if (!r.ok) throw new Error(`${JSON.stringify(r.error)} ${JSON.stringify((rt.getDiagnostics() as { diagnostics?: { errors?: unknown } }).diagnostics?.errors)}`);
    }
  };
  const serve = (entities: unknown[]): void => {
    for (const r of rt.takeSceneRequests!()) rt.provideScene!(r.sceneId, { ok: true, entities: entities as never });
  };
  const ids = (): string[] => (rt.getInterpolatedState() as { state: { transforms: { id: string }[] } }).state.transforms.map((t) => t.id);
  return { rt, tick, serve, ids, placed };
}

describe('kept objects', () => {
  it('stay when their scene unloads, come back no second time, follow listed spawns, and report references that went', () => {
    const h = harness();
    // The level loads: the kept player arrives at its listed spawn (no transition named one).
    expect(h.rt.requestScene!('load', 'scene-level').ok).toBe(true);
    h.serve(LEVEL);
    h.tick(2);
    expect(h.rt.sceneSet!().status['scene-level']).toBe('loaded');
    expect(h.placed.at(-1)).toEqual({ x: 12, y: 0.91 });

    // The title unloads: what is kept stays (scene-less), the rest goes.
    expect(h.rt.requestScene!('unload', 'scene-title').ok).toBe(true);
    h.tick();
    expect(h.rt.sceneSet!().status['scene-title']).toBe('unloaded');
    const live = h.ids();
    expect(live).toEqual(expect.arrayContaining(['cam-000001', 'player-000001', 'crate-000001', 'lid-000001', 'box-level']));
    expect(live).not.toContain('spawn-000001');
    expect(live).not.toContain('driver-000001');
    expect(h.rt.sceneSet!().spawned.map((e) => e.id)).toEqual(['cam-000001', 'player-000001', 'crate-000001', 'lid-000001']);
    // The kept camera is still the view.
    expect(h.rt.cameraView!()?.live).toBe('cam-000001');

    // The title loads again: no second copy of what stayed; the rest comes back.
    expect(h.rt.requestScene!('load', 'scene-title').ok).toBe(true);
    h.serve(titleEntities(true));
    h.tick(2);
    expect(h.rt.sceneSet!().status['scene-title']).toBe('loaded');
    const again = h.ids();
    expect(again.filter((id) => id === 'cam-000001' || id === 'crate-000001' || id === 'lid-000001' || id === 'player-000001')).toHaveLength(4);
    expect(again).toContain('spawn-000001');
    expect(h.rt.takeProblems!()).toEqual([]);

    // The level unloads: the kept camera's target went — it reads as empty, said once.
    expect(h.rt.requestScene!('unload', 'scene-level').ok).toBe(true);
    h.tick();
    const problems = h.rt.takeProblems!();
    expect(problems.map((p) => p.code)).toEqual(['kept_reference_unloaded']);
    expect(problems[0]!.message).toContain('"cam-000001" → "box-level"');
    h.tick(5);
    expect(h.rt.cameraView!()?.live).toBe('cam-000001');
    h.rt.dispose();
  });

  it('a scene holding a player that is not kept does not unload', () => {
    const h = harness({ playerKept: false });
    const r = h.rt.requestScene!('unload', 'scene-title');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toContain('not kept loaded');
    h.rt.dispose();
  });

  it('scripts spawn kept copies and switch the flag on a handle', () => {
    const seen: Record<string, unknown> = {};
    const h = harness({
      script: (ctx, n) => {
        if (n === 1) seen['spawned'] = ctx.spawn('prefab-0001', { position: [5, 0, 0], keepLoaded: true });
        if (n === 3) {
          seen['spawnedKept'] = ctx.entity(String(seen['spawned']))?.get('object')?.['keepLoaded'];
          seen['lidRefused'] = ctx.entity('lid-000001')?.set('object', { keepLoaded: false }).ok;
          seen['spawnOff'] = ctx.entity('spawn-000001')?.set('object', { keepLoaded: true }).ok;
        }
        if (n === 5) seen['spawnKept'] = ctx.entity('spawn-000001')?.get('object')?.['keepLoaded'];
      },
    });
    h.tick(8);
    expect(seen).toMatchObject({ spawnedKept: true, lidRefused: false, spawnOff: true, spawnKept: true });
    // The spawn kept by the script stays when the title unloads.
    expect(h.rt.requestScene!('unload', 'scene-title').ok).toBe(true);
    h.tick();
    expect(h.ids()).toContain('spawn-000001');
    h.rt.dispose();
  });
});
