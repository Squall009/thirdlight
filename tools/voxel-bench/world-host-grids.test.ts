/**
 * `ctx.voxels` in a world with structure grids, at real boundaries: a real runtime (instantiateRuntime) whose scene
 * carries a `voxelWorld` object and a script calling `ctx.voxels`, the world and three houses each in its own grid
 * (turned 0°, 30° and 45°) opened from region files on disk, streamed and derived in `worker_threads` workers running
 * the bundled worker, the engine's physics port holding the bodies.
 *
 * Checked: the grid a point lies in (a structure's cell that is not air, else the world's own) for reads, coverage
 * and regions; rays meeting each turned house exactly (its grid, its cell, the face's normal in the world, solid and
 * light stops, through its door to its back wall); a door prop shut and opened by a script (light, `portalsOf`, and
 * paths from the street into the room: none by default while shut, one with `doors: 'shut-too'`, one once open); changes over a region spanning a house and the ground (a dig
 * opens both; a set replaces the wall's cells in the house and fills the air before it in the world grid), one change
 * reported once both grids swapped; a save of a turned house's dug wall restored into a fresh run of the same files
 * (the hole is back), each grid chunk's entry made against its shipped chunk's hash; and saves met by other files:
 * one made before a structure existed (nothing to report, the house stands), one whose structure is gone (its pieces
 * reported, never applied), one whose structure was rebuilt since (the base-mismatch rule, as for the world's own).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPhysicsPort3D } from '@thirdlight/physics-rapier';
import { createBehaviorModuleSpec, createSimulationRegistry, instantiateRuntime, neutralFrame, registerSimulationModule, type BehaviorArtifact, type BehaviorVoxels, type VoxelWorldConnection, type VoxelWorldPorts } from '@thirdlight/runtime';
import { presentVoxelWorlds } from '@thirdlight/game-host';
import { coverPointAt, voxelCoverTable, type VoxelCoverSet } from '@thirdlight/project-model';
import {
  anchoredDefinition,
  baseChunkHash,
  BUILDING_GENERATOR,
  BUILDING_GENERATOR_VERSION,
  boxChunks,
  chunkGrid,
  createDenseChunk,
  createWorldStore,
  gridChunkExtent,
  GridFrame,
  parseStructureDefinition,
  readSave,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  WorkerPool,
  type ChunkDrawBatch,
  type GridPlacement,
  type PaletteStore,
  type StructureDefinition,
} from '@thirdlight/voxel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegionSet } from './regions';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO, TEST_WORLD_ID } from './stream-node';

const grid = chunkGrid(32);
const M = VOXEL_SIZE_M;
const DT = 1 / 60;
const DECL = { properties: [] } as never;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
/** The ground's material (rows −8 … −1 over a 64 m square round the origin) and the houses'. */
const GROUND = 3;
const STONE = 9;
const OTHER = 11;

/** A 6 × 5 m room, walls 3 m (rows 1 … 6), a flat roof (row 7), a door 1.5 m wide and 2.5 m tall in its front wall (z 0). */
const HOUSE = { w: 12, d: 10, h: 6, door: [5, 7], doorH: 5 } as const;
function houseDefinition(storeys = 1): StructureDefinition {
  return anchoredDefinition(
    parseStructureDefinition({
      footprint: [{ id: 'room', points: [[0, 0], [HOUSE.w, 0], [HOUSE.w, HOUSE.d], [0, HOUSE.d]] }],
      storeys,
      storeyHeight: HOUSE.h + 1,
      foundationDepth: 0,
      roof: { shape: 'flat', overhang: 0, axis: 'x' },
      materials: { wall: STONE, floor: STONE, roof: STONE, foundation: STONE, stair: STONE },
      openings: [{ id: 'door', polygon: 'room', edge: 0, storey: 0, at: HOUSE.door[0], width: HOUSE.door[1] - HOUSE.door[0] + 1, height: HOUSE.doorH, sill: 0 }],
      stairs: [],
      generator: BUILDING_GENERATOR_VERSION,
    }),
  );
}

/** Three houses, each in its own grid turned about its footprint's middle (`centre`, metres; y its slab's underside). */
const HOUSES = [
  { id: 1, yawDeg: 0, centre: [-12, 0, -6] },
  { id: 2, yawDeg: 30, centre: [2, 0, -10] },
  { id: 3, yawDeg: 45, centre: [14, 0, -4] },
] as const;

function placeOf(id: number, yawDeg: number, centre: readonly number[]): GridPlacement {
  const yawRad = (yawDeg * Math.PI) / 180;
  const mid = [(HOUSE.w * M) / 2, 0, (HOUSE.d * M) / 2];
  const t = new GridFrame({ gridId: id, position: [0, 0, 0], yawRad }).toWorld(mid[0]!, mid[1]!, mid[2]!);
  return { gridId: id, position: [centre[0]! - t[0], centre[1]!, centre[2]! - t[2]], yawRad };
}
const PLACES = HOUSES.map((h) => placeOf(h.id, h.yawDeg, h.centre));
const frameOf = (id: number): GridFrame => new GridFrame(PLACES.find((p) => p.gridId === id)!);
/** A house cell's middle in the world (metres). */
const cellAt = (id: number, x: number, y: number, z: number): [number, number, number] => frameOf(id).toWorld((x + 0.5) * M, (y + 0.5) * M, (z + 0.5) * M);

let dir = '';
let workerFile = '';
const disks: DiskRegions[] = [];
/** The runtimes made, disposed after (their worlds' pools end with them). */
const runtimes: { dispose(): unknown }[] = [];
/** Each house's cells as written (its grid's shipped chunks). */
const houseStores = new Map<string, PaletteStore>();

/** Writes a store's region files (grid `gridId`) into a folder. */
function writeStore(store: PaletteStore, folder: string, gridId: number): string[] {
  mkdirSync(folder, { recursive: true });
  const names: string[] = [];
  for (const [name, b] of new RegionSet(store, 'stacked', 512, TEST_WORLD_ID, gridId).allFiles()) {
    writeFileSync(join(folder, name), b);
    names.push(name);
  }
  return names;
}

function houseStore(def: StructureDefinition): PaletteStore {
  const s = createWorldStore(grid);
  const out = createDenseChunk(grid);
  for (const c of boxChunks(grid, BUILDING_GENERATOR.box(def))) if (BUILDING_GENERATOR.chunk(def, grid, c.cx, c.cy, c.cz, out)) s.importChunk(c.cx, c.cy, c.cz, out);
  return s;
}

beforeAll(async () => {
  const base = join(REPO, 'dist', 'voxel-bench');
  mkdirSync(base, { recursive: true });
  dir = mkdtempSync(join(base, 'world-host-grids-'));
  workerFile = await bundleWorker('stream-worker-node', join(base, `world-host-grids-worker-${process.pid}.mjs`));
  const ground = createWorldStore(grid);
  const g = { material: GROUND, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 };
  for (let x = -128; x < 128; x++) for (let z = -128; z < 128; z++) for (let y = -8; y < 0; y++) ground.setVoxel(x, y, z, g);
  writeStore(ground, join(dir, 'world'), 0);
  for (const [name, def] of [['1', houseDefinition()], ['2', houseDefinition()], ['3', houseDefinition()], ['2-tall', houseDefinition(2)]] as const) {
    const s = houseStore(def);
    houseStores.set(name, s);
    writeStore(s, join(dir, `grid-${name}`), Number(name.split('-')[0]));
  }
}, 120_000);

afterAll(async () => {
  for (const rt of runtimes) rt.dispose();
  for (const d of disks) await d.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(workerFile, { force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What a job reads of the script's context: the voxels and the generic component access. */
type Ctx = { voxels: BehaviorVoxels; entity(id: string): { set(component: string, patch: Record<string, unknown>): { ok: boolean; message: string } } | null };

/** A running game over the test world with the houses `grids` names (each grid's folder, by its id): `inStep` runs a function in the script's next step. */
async function game(grids: ReadonlyArray<{ readonly id: number; readonly folder: string }>, extra: readonly Record<string, unknown>[] = [], play: { wrap?(ports: VoxelWorldPorts): VoxelWorldPorts; modelBounds?: Record<string, { min: number[]; max: number[] }> } = {}): Promise<{ inStep<R>(fn: (v: BehaviorVoxels, ctx: Ctx) => R | undefined, what: string): Promise<R>; changes: BehaviorVoxels['changes'][number][]; mismatches: BehaviorVoxels['mismatches'][number][]; walk(): { pending: boolean; grids?: { pending: number; links: number } } | undefined }> {
  const r = await createPhysicsPort3D({ character: { position: { x: 0, y: 0, z: 0 }, radius: 0.3, halfHeight: 0.5, offset: { x: 0, y: 0.8, z: 0 } }, noCharacter: true, statics: [], solver: { hz: 60, gravityY: -9.81 }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: 0.8, minSlopeSlideRad: 0.9, autostep: false } });
  if (!r.ok) throw new Error(r.error.message);
  const ports = {
    open: async (): Promise<VoxelWorldConnection> => {
      const disk = new DiskRegions(join(dir, 'world'));
      disks.push(disk);
      const pool = new WorkerPool({ size: 2, create: () => nodePoolWorker(workerFile), timeoutMs: 10_000, maxQueued: 256 });
      const opened = await Promise.all(
        grids.map(async (g) => {
          const d = new DiskRegions(join(dir, g.folder));
          disks.push(d);
          const source = d.source(grid, 'stacked', 512, 64, g.id);
          const names = [...new RegionSet(houseStores.get(g.folder.replace('grid-', ''))!, 'stacked', 512, TEST_WORLD_ID, g.id).allFiles()].map(([n]) => n);
          return { place: PLACES.find((p) => p.gridId === g.id)!, source, extent: await gridChunkExtent(source, 'stacked', names) };
        }),
      );
      // A presentation makes the grids' connections itself, from where they are placed and each grid opened by its id.
      return { grid, worldId: TEST_WORLD_ID, source: disk.source(grid, 'stacked', 512), pool, grids: opened, placements: opened.map((o) => o.place), openGrid: (id: number) => Promise.resolve(opened.find((o) => o.place.gridId === id) ?? null) };
    },
  };
  let job: ((v: BehaviorVoxels, ctx: Ctx) => boolean) | null = null;
  const changes: BehaviorVoxels['changes'][number][] = [];
  const mismatches: BehaviorVoxels['mismatches'][number][] = [];
  let seen: unknown = null;
  const art: BehaviorArtifact = {
    behaviorId: 'probe',
    sourceDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
    outputDigest: 'c'.repeat(64),
    ownedTransforms: [],
    requiredModules: [],
    enginePins: [],
    namespace: {
      default: {
        instantiate: () => ({}),
        step: (_s: unknown, ctx: Ctx) => {
          if (ctx.voxels.changes !== seen) {
            seen = ctx.voxels.changes;
            changes.push(...ctx.voxels.changes);
            mismatches.push(...ctx.voxels.mismatches);
          }
          if (job?.(ctx.voxels, ctx) === true) job = null;
        },
        dispose: () => {},
      },
    },
  } as never;
  const spec = createBehaviorModuleSpec({ declaration: DECL, artifact: art });
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
  const snapshot = {
    snapshotId: 'grids-0001@r1',
    projectId: 'grids-0001',
    revision: 1,
    scene: {
      schemaVersion: 4,
      sceneId: 'scene-main',
      revision: 1,
      entities: [
        { id: 'world', components: { transform: { position: [0, 1, -6], ...T }, voxelWorld: { world: 'a', ring: { loadRadius: 40, loadHeight: 24 }, collision: { radius: 24, height: 16 } } } },
        { id: 'probe', components: { transform: { position: [0, 0, 0], ...T }, behavior: { behaviorId: 'probe', values: {} } } },
        ...extra,
      ],
    },
    scenes: [{ sceneId: 'scene-main', start: true, entityIds: ['world', 'probe', ...extra.map((e) => e['id'] as string)] }],
    ...(play.modelBounds !== undefined ? { modelBounds: play.modelBounds } : {}),
  };
  const now = { t: 0 };
  const res = instantiateRuntime({ snapshot, registry, modules: [spec.id], actions: { sample: (i: number) => neutralFrame(i) }, physics: r.port, settings: {}, clock: () => now.t, driver: { kind: 'manual' }, voxels: play.wrap?.(ports) ?? ports } as never);
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  runtimes.push(rt);
  expect(rt.start().ok).toBe(true);
  const inStep = async <R>(fn: (v: BehaviorVoxels, ctx: Ctx) => R | undefined, what: string): Promise<R> => {
    let out = null as { r: R } | null;
    job = (v, ctx) => {
      const x = fn(v, ctx);
      if (x !== undefined) out = { r: x };
      return out !== null;
    };
    const t0 = performance.now();
    while (out === null) {
      if (performance.now() - t0 > 60_000) throw new Error(`timed out waiting for ${what}`);
      now.t += DT;
      const t = rt.tick(now.t);
      if (!t.ok) throw new Error(`tick failed: ${JSON.stringify(t.error)}`);
      await sleep(1);
    }
    return out!.r;
  };
  /** The world's walk diagnostics (the world's graph and its grids' graphs and links). */
  const walk = (): { pending: boolean; grids?: { pending: number; links: number } } | undefined => {
    const d = rt.getDiagnostics();
    return d.ok ? (d.diagnostics as { voxelWorlds?: Array<{ walk?: { pending: boolean; grids?: { pending: number; links: number } } }> }).voxelWorlds?.[0]?.walk : undefined;
  };
  return { inStep, changes, mismatches, walk };
}

const ALL = HOUSES.map((h) => ({ id: h.id, folder: `grid-${h.id}` }));
type Game = Awaited<ReturnType<typeof game>>;
type PathAnswer = BehaviorVoxels['paths'][number];
/** The street before a house's door and a place in its room (metres). */
const street = (id: number): [number, number, number] => frameOf(id).toWorld(3.25, 0.25, -3);
const inRoom = (id: number): [number, number, number] => cellAt(id, 6, 1, 5);
/** Whether a path's last point is the room's place (its floor middle under it). */
const endsIn = (a: PathAnswer, id: number): boolean => {
  const end = a.points.at(-1);
  const r = inRoom(id);
  return end !== undefined && Math.hypot(end[0] - r[0], end[2] - r[2]) <= Math.SQRT2 * M + 1e-6 && Math.abs(end[1] - (r[1] - M / 2)) < 1e-6;
};
/**
 * Until the world's and the grids' walk graphs and their links have nothing to make for ten steps: a query asked while
 * they are being made answers from what is made so far (a door's link not yet made: no way in).
 */
async function walkMade(g: Game): Promise<void> {
  let quiet = 0;
  await g.inStep(() => {
    const w = g.walk();
    quiet = w !== undefined && !w.pending && w.grids !== undefined && w.grids.pending === 0 && w.grids.links > 0 ? quiet + 1 : 0;
    return quiet >= 10 ? true : undefined;
  }, 'the walk graphs and their links made');
}
/**
 * A path from the street into each house's room per option set, asked once in one step and read as answered at
 * later steps (keyed `<house>:<option index>`). Asked once: a query asked again every step queues behind itself.
 */
async function paths(g: Game, options: readonly Parameters<BehaviorVoxels['findPath']>[2][]): Promise<Map<string, PathAnswer>> {
  const ids = new Map<number, string>();
  const out = new Map<string, PathAnswer>();
  return g.inStep((v) => {
    if (ids.size === 0) for (const h of HOUSES) options.forEach((o, i) => ids.set(v.findPath(street(h.id), inRoom(h.id), o), `${h.id}:${i}`));
    for (const a of v.paths) if (ids.has(a.path)) out.set(ids.get(a.path)!, a);
    return out.size === ids.size ? out : undefined;
  }, 'the paths answered');
}
/** Every house and the ground round them: what the checks read and change. */
const AREA = { min: [-22, -4, -20] as [number, number, number], max: [24, 8, 6] as [number, number, number] };
/** Until every house's cells and the ground round them are loaded and every chunk's derive is in (coverage reads it). */
const ready = (v: BehaviorVoxels): true | undefined => (v.isResident(AREA) && HOUSES.every((h) => v.coverageAt(...cellAt(h.id, 3, 2, 0)) !== null && v.coverageAt(...cellAt(h.id, 3, 2, 4)) !== null) ? true : undefined);

describe('ctx.voxels in a world with structure grids', () => {
  it('reads answer from the grid a point lies in: a structure cell that is not air, else the world’s own; regions name the structure round a room', async () => {
    const g = await game(ALL);
    await g.inStep(ready, 'the houses loaded and derived');
    const out = await g.inStep((v) => {
      const room = v.regionAt(...cellAt(2, 6, 3, 5));
      // The houses' stamps land over steps in the derive slice: their rooms are known once those are stitched.
      if (room === null || room.kind === 'unknown') return undefined;
      return {
        wall: HOUSES.map((h) => v.get(...cellAt(h.id, 3, 2, 0))),
        door: v.get(...cellAt(2, 6, 2, 0)),
        room: v.get(...cellAt(2, 6, 3, 5)),
        under: v.get(...cellAt(2, 6, -2, 5)),
        cover: [v.coverageAt(...cellAt(2, 3, 2, 0)), v.coverageAt(...cellAt(2, 6, 3, 5))],
        material: v.materialAt(...cellAt(2, 3, 2, 0)),
        region: { kind: room.kind, grid: room.grid },
        outside: v.regionAt(...cellAt(2, 6, 3, -8))?.grid ?? null,
      };
    }, 'the room stitched');
    for (const w of out.wall) expect(w).toMatchObject({ material: STONE, role: VOXEL_ROLE.wall, shape: 15 });
    // The door's cells are openings of the house (not air: the structure's); the room is the world's own air; the ground under it the world's.
    expect(out.door).toMatchObject({ material: STONE, role: VOXEL_ROLE.opening });
    expect(out.room).toMatchObject({ material: 0 });
    expect(out.under).toMatchObject({ material: GROUND });
    expect(out.cover).toEqual([1, 0]);
    expect(out.region).toEqual({ kind: 'room', grid: 2 });
    expect(out.outside).toBe(0);
  }, 120_000);

  it('a ray meets each turned house exactly (0°, 30°, 45°): its grid, its cell, the face turned into the world; through the door to the back wall', async () => {
    const g = await game(ALL);
    await g.inStep(ready, 'the houses loaded and derived');
    const rays = await g.inStep((v) =>
      HOUSES.map((h) => {
        const f = frameOf(h.id);
        const dir = f.toWorld(0, 0, 1).map((c, a) => c - f.toWorld(0, 0, 0)[a]!) as [number, number, number];
        const from = f.toWorld(2.25, 1.25, -3);
        const door = f.toWorld(3.25, 1.25, -3);
        return { yaw: h.yawDeg, solid: v.raycast(from, dir, 20), light: v.raycast(from, dir, 20, { stop: 'light' }), door: v.raycast(door, dir, 20), dir };
      }),
    'the rays',
    );
    for (const r of rays) {
      const s = Math.sin((r.yaw * Math.PI) / 180);
      const c = Math.cos((r.yaw * Math.PI) / 180);
      for (const hit of [r.solid, r.light]) {
        expect(hit, `${r.yaw}°`).not.toBeNull();
        expect(hit!.grid).toBe(HOUSES.find((h) => h.yawDeg === r.yaw)!.id);
        expect(hit!.cell).toEqual([4, 2, 0]);
        expect(hit!.distance).toBeCloseTo(3, 6);
        expect(hit!.normal[0]).toBeCloseTo(-s, 6);
        expect(hit!.normal[1]).toBeCloseTo(0, 6);
        expect(hit!.normal[2]).toBeCloseTo(-c, 6);
        expect(hit!.voxel).toMatchObject({ material: STONE, role: VOXEL_ROLE.wall });
      }
      // The door's opening cells stop nothing: the ray meets the back wall's inside face.
      expect(r.door?.grid).toBe(HOUSES.find((h) => h.yawDeg === r.yaw)!.id);
      expect(r.door?.cell[2]).toBe(HOUSE.d - 1);
      expect(r.door?.distance).toBeCloseTo(3 + (HOUSE.d - 1) * M, 6);
    }
  }, 120_000);

  it('a door prop shuts its opening exactly (0°, 30°, 45°): a light ray stops at it, portalsOf names it shut; opened by a script, the light passes', async () => {
    // A portal prop a house, standing in its door (the join is by place: its middle lies in the door's opening cells).
    const doors = HOUSES.map((h) => ({ id: `door-${h.id}`, components: { transform: { position: frameOf(h.id).toWorld(((HOUSE.door[0] + HOUSE.door[1] + 1) / 2) * M, M, 0.5 * M), rotation: [0, Math.sin((h.yawDeg * Math.PI) / 360), 0, Math.cos((h.yawDeg * Math.PI) / 360)], scale: [1, 1, 1] }, voxelPortal: { open: false, stops: { light: true, sight: true, walk: true } } } }));
    const g = await game(ALL, doors);
    await g.inStep(ready, 'the houses loaded and derived');
    const look = (v: BehaviorVoxels) =>
      HOUSES.map((h) => {
        const f = frameOf(h.id);
        const dir = f.toWorld(0, 0, 1).map((c, a) => c - f.toWorld(0, 0, 0)[a]!) as [number, number, number];
        const room = v.regionAt(...cellAt(h.id, 6, 2, 5));
        const portals = room === null ? [] : v.portalsOf(room.id);
        return { yaw: h.yawDeg, light: v.raycast(f.toWorld(3.25, 1.25, -3), dir, 20, { stop: 'light' }), portal: portals.find((p) => p.prop === `door-${h.id}`) ?? null };
      });
    // Shut: joined, said, and the light ray meets the door's world cells, short of the back wall.
    const shut = await g.inStep((v) => {
      const r = look(v);
      return r.every((x) => x.portal !== null && x.light !== null && x.light.distance < 3 + M) ? r : undefined;
    }, 'every door joined and shut in the light');
    for (const r of shut) {
      expect(r.portal, `${r.yaw}°`).toMatchObject({ prop: `door-${HOUSES.find((h) => h.yawDeg === r.yaw)!.id}`, open: false, stops: { light: true, sight: true, walk: true } });
      expect(r.light!.grid, `${r.yaw}° the ray stops in the world's cells at the door`).toBe(0);
      expect(r.light!.distance).toBeGreaterThan(3 - 2 * M);
    }
    // Shut to walkers: no way from the street into the room by default; through the shut door with `shut-too`.
    await walkMade(g);
    const shutWays = await paths(g, [{}, { doors: 'shut-too' }]);
    for (const h of HOUSES) {
      expect(shutWays.get(`${h.id}:0`)!.status, `${h.yawDeg}° shut, open-only`).toBe('unreachable');
      expect(shutWays.get(`${h.id}:1`)!.status, `${h.yawDeg}° shut, shut-too`).toBe('found');
      expect(endsIn(shutWays.get(`${h.id}:1`)!, h.id), `${h.yawDeg}° ends in the room`).toBe(true);
    }
    // Opened by a script through the generic component access: the light and the default path pass again.
    await g.inStep((_v, ctx) => (HOUSES.every((h) => ctx.entity(`door-${h.id}`)?.set('voxelPortal', { open: true }).ok === true) ? true : undefined), 'doors opened');
    const open = await g.inStep((v) => {
      const r = look(v);
      return r.every((x) => x.portal?.open === true && x.light !== null && x.light.distance > 3 + M) ? r : undefined;
    }, 'every door open in the light');
    for (const r of open) {
      expect(r.light!.grid).toBe(HOUSES.find((h) => h.yawDeg === r.yaw)!.id);
      expect(r.light!.cell[2]).toBe(HOUSE.d - 1);
    }
    // Open: the default walker goes in.
    await walkMade(g);
    const openWays = await paths(g, [{}]);
    for (const h of HOUSES) {
      expect(openWays.get(`${h.id}:0`)!.status, `${h.yawDeg}° open`).toBe('found');
      expect(endsIn(openWays.get(`${h.id}:0`)!, h.id)).toBe(true);
    }
  }, 180_000);

  it('the walker\'s width at the 1.5 m doors, a reach through them, and a path asked in the step of a dig going through the hole', async () => {
    const g = await game(ALL);
    await g.inStep(ready, 'the houses loaded and derived');
    await walkMade(g);
    // The default character (0.3 m) and a 0.7 m walker (three cells) go in by each 1.5 m door; 0.8 m (four cells) does not.
    const ways = await paths(g, [{}, { radius: 0.7 }, { radius: 0.8 }]);
    for (const h of HOUSES) {
      expect(ways.get(`${h.id}:0`)!.status, `${h.yawDeg}° 0.3 m`).toBe('found');
      expect(endsIn(ways.get(`${h.id}:0`)!, h.id)).toBe(true);
      expect(ways.get(`${h.id}:1`)!.status, `${h.yawDeg}° 0.7 m`).toBe('found');
      expect(ways.get(`${h.id}:2`)!.status, `${h.yawDeg}° 0.8 m`).toBe('unreachable');
    }
    // A reach from the street before the 30° house: places in its room (house cells x 1 … 10, z 1 … 8) among them.
    let reachId = -1;
    const reached = await g.inStep((v) => {
      if (reachId < 0) reachId = v.reach(street(2), 10, { points: true });
      return v.reaches.find((r) => r.reach === reachId);
    }, 'the reach answered');
    // (`unknown` where the world's reach meets chunks of the ring's edge not made: its answer, not the grids'.)
    expect(['found', 'unknown']).toContain(reached.status);
    const inside = reached.points!.filter((p) => {
      const q = frameOf(2).toGrid(p[0], p[1], p[2]);
      return q[0] / M > 1 && q[0] / M < 10 && q[2] / M > 1 && q[2] / M < 8;
    });
    expect(inside.length).toBeGreaterThan(20);
    // In one step: the 0° house's back wall dug (three cells wide, 2 m) and a path asked from behind it into the room.
    const f = frameOf(1);
    const a = f.toWorld(5 * M + 0.01, 1 * M + 0.01, (HOUSE.d - 1) * M + 0.01);
    const b = f.toWorld(8 * M - 0.01, 5 * M - 0.01, HOUSE.d * M - 0.01);
    const behind = f.toWorld(6.5 * M, 0.25, HOUSE.d * M + 3);
    const order: string[] = [];
    let pathId = -1;
    let digEdit = -1;
    const answer = await g.inStep((v) => {
      if (pathId < 0) {
        const r = v.dig({ min: [Math.min(a[0], b[0]), a[1], Math.min(a[2], b[2])], max: [Math.max(a[0], b[0]), b[1], Math.max(a[2], b[2])] });
        if (!r.ok) throw new Error(r.message);
        digEdit = r.edit;
        pathId = v.findPath(behind, inRoom(1));
        return undefined;
      }
      if (v.changes.some((c) => c.edit === digEdit)) order.push('dig swapped');
      const p = v.paths.find((x) => x.path === pathId);
      if (p !== undefined) order.push('path answered');
      return p;
    }, 'the path through the hole');
    expect(answer.status).toBe('found');
    expect(answer.stale).toBeUndefined();
    expect(answer.length).toBeLessThan(9);
    expect(order.indexOf('dig swapped')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('dig swapped')).toBeLessThanOrEqual(order.indexOf('path answered'));
    // It waited for the dig's chunks and the house's links (the queries across graphs count it).
    expect((g.walk() as { grids?: { waits: number } } | undefined)?.grids?.waits ?? 0).toBeGreaterThan(0);
  }, 180_000);

  it('a change spanning a house and the ground changes both, each in its own cells, as one change; a set replaces the wall and fills the air before it in the world grid', async () => {
    const g = await game(ALL);
    await g.inStep(ready, 'the houses loaded and derived');
    // A ball on the 30° house's front wall at its foot: the wall's cells and the ground under it.
    const foot = cellAt(2, 3, 0, 0);
    const ball = { center: [foot[0], foot[1], foot[2]] as [number, number, number], radius: 1.1 };
    const dug = await g.inStep((v) => v.dig(ball), 'the dig');
    expect(dug.ok).toBe(true);
    const after = await g.inStep((v) => ({ wall: v.get(...cellAt(2, 3, 1, 0)), ground: v.get(foot[0], foot[1] - 0.75, foot[2]), again: v.dig(ball) }), 'the reads');
    expect(after.wall).toMatchObject({ material: 0 });
    expect(after.ground).toMatchObject({ material: 0 });
    expect(after.again).toMatchObject({ ok: true, cells: 0 });
    const edit = (dug as { edit: number }).edit;
    const change = await g.inStep(() => g.changes.find((c) => c.edit === edit), 'the dig swapped in');
    // The house's chunk (a turned box) and the ground's chunk, in one change.
    expect(change.chunks.length).toBeGreaterThanOrEqual(2);
    expect(change.shaderOnly).toBe(false);
    // A set over the 45° house's front wall and the air before it: the wall in the house, the air in the world grid.
    const f = frameOf(3);
    const wall = cellAt(3, 3, 3, 0);
    const before = f.toWorld(1.75, 1.75, -1.25);
    const box = { min: [Math.min(wall[0], before[0]) - 0.1, wall[1] - 0.1, Math.min(wall[2], before[2]) - 0.1] as [number, number, number], max: [Math.max(wall[0], before[0]) + 0.1, wall[1] + 0.1, Math.max(wall[2], before[2]) + 0.1] as [number, number, number] };
    const set = await g.inStep((v) => v.set(box, { material: OTHER, role: VOXEL_ROLE.wall }), 'the set');
    expect(set.ok).toBe(true);
    // Rays read the derived occupancy: the set's swap first (both grids').
    await g.inStep(() => g.changes.find((c) => c.edit === (set as { edit: number }).edit), 'the set swapped in');
    const dir = f.toWorld(0, 0, 1).map((c, a) => c - f.toWorld(0, 0, 0)[a]!) as [number, number, number];
    const read = await g.inStep((v) => ({ wall: v.get(...wall), front: v.raycast(f.toWorld(1.75, 1.75, -3), dir, 10) }), 'the set read');
    expect(read.wall).toMatchObject({ material: OTHER, role: VOXEL_ROLE.wall });
    // From the street the ray meets the world grid's new cells before the wall; the wall cell itself is the house's.
    expect(read.front?.grid).toBe(0);
    expect(read.front?.voxel?.material).toBe(OTHER);
  }, 120_000);

  it('a save keeps a turned house’s dug wall (each grid chunk against its shipped hash) and a fresh run of the same files brings the hole back', async () => {
    const g = await game(ALL);
    await g.inStep(ready, 'the houses loaded and derived');
    const hole = cellAt(2, 3, 2, 0);
    expect((await g.inStep((v) => v.dig({ center: hole, radius: 0.6 }), 'the dig')).ok).toBe(true);
    const id = await g.inStep((v) => v.save(), 'the save asked');
    const save = await g.inStep((v) => v.saves.find((s) => s.save === id), 'the save answered');
    expect(save.ok).toBe(true);
    const entries = readSave(save.bytes!, grid, TEST_WORLD_ID, (b) => b).chunks;
    const house = entries.filter((e) => e.grid === 2);
    expect(house.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.grid === 2)).toBe(true);
    const shipped = houseStores.get('2')!;
    for (const e of house) expect([...e.base]).toEqual([...baseChunkHash(grid, shipped.encodeChunk(e.cx, e.cy, e.cz))]);
    // A fresh run over the same files: the wall is whole until the save is restored, then the hole is there.
    const h = await game(ALL);
    await h.inStep(ready, 'the houses loaded and derived');
    expect(await h.inStep((v) => v.get(...hole), 'the wall')).toMatchObject({ material: STONE });
    expect((await h.inStep((v) => v.restore(save.text!, 'base'), 'the restore')).ok).toBe(true);
    expect(await h.inStep((v) => v.get(...hole), 'the hole')).toMatchObject({ material: 0 });
    expect(h.mismatches).toEqual([]);
  }, 180_000);

  it('saves met by other files: made before the structure existed (nothing reported), its structure gone (reported, left out), its structure rebuilt (the base-mismatch rule)', async () => {
    // Before: a game without the houses digs the ground; restored into a world with them, nothing is reported.
    const bare = await game([]);
    await bare.inStep((v) => (v.isResident(AREA) ? true : undefined), 'the ground loaded');
    const pit = [0, -0.25, 2] as [number, number, number];
    expect((await bare.inStep((v) => v.dig({ center: pit, radius: 0.6 }), 'the dig')).ok).toBe(true);
    const sid = await bare.inStep((v) => v.save(), 'the save asked');
    const before = await bare.inStep((v) => v.saves.find((s) => s.save === sid), 'the save answered');
    const full = await game(ALL);
    await full.inStep(ready, 'the houses loaded and derived');
    expect((await full.inStep((v) => v.restore(before.text!, 'save'), 'the restore')).ok).toBe(true);
    expect(await full.inStep((v) => ({ pit: v.get(...pit), wall: v.get(...cellAt(2, 3, 2, 0)) }), 'the reads')).toMatchObject({ pit: { material: 0 }, wall: { material: STONE } });
    // A save holding the 30° house's dug wall.
    const hole = cellAt(2, 3, 2, 0);
    expect((await full.inStep((v) => v.dig({ center: hole, radius: 0.6 }), 'the dig')).ok).toBe(true);
    const hid = await full.inStep((v) => v.save(), 'the save asked');
    const holed = await full.inStep((v) => v.saves.find((s) => s.save === hid), 'the save answered');
    const pieces = readSave(holed.bytes!, grid, TEST_WORLD_ID, (b) => b).chunks.filter((e) => e.grid === 2).length;
    // The structure gone from the world: its pieces are reported (grid 2, not kept), nothing crashes, the rest lands.
    const gone = await game(ALL.filter((x) => x.id !== 2));
    await gone.inStep((v) => (v.isResident(AREA) ? true : undefined), 'the world loaded');
    expect((await gone.inStep((v) => v.restore(holed.text!, 'save'), 'the restore')).ok).toBe(true);
    const reported = await gone.inStep(() => (gone.mismatches.length >= pieces ? gone.mismatches : undefined), 'the mismatches');
    expect(reported.filter((m) => m.grid === 2)).toHaveLength(pieces);
    expect(reported.every((m) => m.grid === 2 && !m.kept)).toBe(true);
    expect(await gone.inStep((v) => v.get(...pit), 'the pit')).toMatchObject({ material: 0 });
    // The structure rebuilt (a second storey): its chunk's hash differs, reported as the world's own are; `save` keeps the hole.
    const rebuilt = await game([{ id: 1, folder: 'grid-1' }, { id: 2, folder: 'grid-2-tall' }, { id: 3, folder: 'grid-3' }]);
    await rebuilt.inStep(ready, 'the houses loaded and derived');
    expect((await rebuilt.inStep((v) => v.restore(holed.text!, 'save'), 'the restore')).ok).toBe(true);
    const again = await rebuilt.inStep(() => (rebuilt.mismatches.some((m) => m.grid === 2) ? rebuilt.mismatches : undefined), 'the mismatch');
    expect(again.some((m) => m.grid === 2 && m.kept)).toBe(true);
    expect(await rebuilt.inStep((v) => v.get(...hole), 'the hole')).toMatchObject({ material: 0 });
  }, 240_000);
});

describe('ground cover in a game with structures and props', () => {
  it('reaches the page with the world\'s draw batches: grown on the ground, none where a house stands (0°, 30°, 45°: its stamp closes the ground), a static model\'s box kept clear and a model that is not static grown over', async () => {
    const table = voxelCoverTable({
      materials: [{ materialId: 'ground', name: 'Ground', shader: 'standard', params: {}, textures: {}, voxel: { id: GROUND, use: 'terrain', dressing: 'turf' } }] as never,
      dressings: [{ dressingFormat: 1, dressingId: 'turf', name: 'Turf', species: [{ model: 'tuft', class: 'cover', density: 4 }] }],
    });
    const batches: ChunkDrawBatch[] = [];
    // Two crates of one model on the open ground south of the houses: one marked static, one not.
    const crate = (id: string, x: number, isStatic: boolean): Record<string, unknown> => ({ id, ...(isStatic ? { static: true } : {}), components: { transform: { position: [x, 0, 2], ...T }, model: { asset: { assetId: 'crate' } } } });
    const g = await game(ALL, [crate('crate-static', -4, true), crate('crate-loose', 6, false)], {
      wrap: (ports) => presentVoxelWorlds(ports, (b) => batches.push(b), [], 0, undefined, undefined, false, 0, new Map(), undefined, table).ports,
      modelBounds: { crate: { min: [-1, 0, -1], max: [1, 1.5, 1] } },
    });
    await g.inStep(ready, 'the houses loaded and derived');
    // What each column holds as the batches left it, once no batch brought cover for a while.
    const held = new Map<string, readonly VoxelCoverSet[]>();
    let read = 0;
    let quiet = 0;
    await g.inStep(() => {
      const before = read;
      for (; read < batches.length; read++) {
        const b = batches[read]!;
        if (b.world !== 'a') continue;
        for (const c of b.cover ?? []) {
          if (c.sets === undefined) held.delete(`${c.cx},${c.cz}`);
          else held.set(`${c.cx},${c.cz}`, c.sets as unknown as VoxelCoverSet[]);
        }
      }
      quiet = held.size > 0 && read === before ? quiet + 1 : 0;
      return quiet >= 120 ? true : undefined;
    }, 'the ground cover of the drawn columns');
    const points = [...held.values()].flatMap((sets) => sets.flatMap((s) => Array.from({ length: s.points.count }, (_, i) => coverPointAt(s.points, i))));
    expect(points.length).toBeGreaterThan(5000);
    // On the ground's top (the cells' fill: 0 m), every one.
    for (const p of points) expect(p.y).toBeCloseTo(0, 5);
    // Each house's floor is 6 × 5 m in its own frame: nothing inside it but for the cell the stamp may be off by.
    for (const h of HOUSES) {
      const f = frameOf(h.id);
      const inside = points.filter((p) => {
        const q = f.toGrid(p.x, p.y, p.z);
        return q[0] > 0.75 && q[0] < HOUSE.w * M - 0.75 && q[2] > 0.75 && q[2] < HOUSE.d * M - 0.75;
      });
      expect(inside, `house ${h.id}`).toEqual([]);
      // And the ground round it grows: within 3 m outside its walls.
      const round = points.filter((p) => {
        const q = f.toGrid(p.x, p.y, p.z);
        return q[0] > -3 && q[0] < HOUSE.w * M + 3 && q[2] > -3 && q[2] < HOUSE.d * M + 3 && (q[0] < -0.75 || q[0] > HOUSE.w * M + 0.75 || q[2] < -0.75 || q[2] > HOUSE.d * M + 0.75);
      });
      expect(round.length, `round house ${h.id}`).toBeGreaterThan(100);
    }
    const under = (x: number): number => points.filter((p) => p.x > x - 0.95 && p.x < x + 0.95 && p.z > 1.05 && p.z < 2.95).length;
    expect(under(-4)).toBe(0);
    expect(under(6)).toBeGreaterThan(5);
    // A batch that brings cover never brings it before its column's chunks were drawn.
    const drawn = new Set<string>();
    for (const b of batches) {
      if (b.world !== 'a') continue;
      for (const c of b.chunks) if (c.kind === 'draw' && (c.level ?? 0) === 0) drawn.add(`${c.cx},${c.cz}`);
      for (const c of b.cover ?? []) expect(drawn.has(`${c.cx},${c.cz}`), `cover of ${c.cx},${c.cz} before its draw`).toBe(true);
    }
  }, 240_000);
});

describe('ctx.voxels.surfaceAt', () => {
  it('answers the surface under a point with the fields derived from the voxels: open ground, a room’s floor and its roof in the structure’s own grid, the ground beside a wall through the stamp, water, gas and wetness the same step they are written', async () => {
    const g = await game(ALL);
    await g.inStep(ready, 'the houses loaded and derived');
    const LIQUID = 20;
    const MIST = 40;
    // House 1 stands square to the world: its east wall's cells are the world columns x −9.5 … −9.
    const beside: [number, number, number] = [-8.25, 0.2, -6];
    const out = await g.inStep((v) => {
      const wall = v.surfaceAt(...beside, { distances: true });
      // The houses' stamps land over steps in the derive slice: the ground reads the wall once its stamp is in.
      if (wall === null || wall.construction !== 1) return undefined;
      const open: [number, number, number] = [0.25, 0.3, 2.25];
      const before = v.surfaceAt(...open, { distances: true });
      // A pit two cells deep filled with a liquid, mist over it, wet ground and another material near the open point.
      const dug = v.dig({ min: [4, -1, 2], max: [5, 0, 3] });
      const filled = v.set({ min: [4, -1, 2], max: [5, 0, 3] }, { material: LIQUID, role: VOXEL_ROLE.liquid, shape: 15 });
      const fog = v.set({ min: [4, 0.5, 2], max: [5, 1.5, 3] }, { material: MIST, role: VOXEL_ROLE.gas, shape: 9 });
      const wet = v.paint({ at: [0.25, -0.25, 2.25] }, { wetness: 4 });
      const other = v.paint({ at: [1.75, -0.25, 2.25] }, { material: OTHER });
      return {
        wall,
        before,
        edits: [dug, filled, fog, wet, other].map((e) => e.ok),
        after: v.surfaceAt(...open, { distances: true }),
        plain: v.surfaceAt(...open),
        named: v.world('a')!.surfaceAt(...open),
        pond: v.surfaceAt(4.25, 0.3, 2.25),
        swimmer: v.surfaceAt(4.25, -0.6, 2.25),
        room: HOUSES.map((h) => v.surfaceAt(...cellAt(h.id, 6, 2, 5), { distances: true })),
        roof: HOUSES.map((h) => v.surfaceAt(...cellAt(h.id, 6, 9, 5))),
        floors: HOUSES.map((h) => cellAt(h.id, 6, 0, 5)),
        under: v.surfaceAt(-12, -0.2, -6),
        high: v.surfaceAt(0.25, 2.3, 2.25),
        far: v.surfaceAt(1000, 0, 1000),
        bad: v.surfaceAt(Number.NaN, 0, 0),
      };
    }, 'the ground beside house 1 reading its wall');
    expect(out.wall).toMatchObject({ grid: 0, material: GROUND, role: VOXEL_ROLE.terrain, height: 0, slope: 0, sky: true, construction: 1, water: null, gas: null });
    // Open ground: nothing built or of another material within 8 m.
    expect(out.before).toEqual({ grid: 0, at: [0.25, -0.25, 2.25], height: 0, slope: 0, material: GROUND, role: VOXEL_ROLE.terrain, wetness: 0, sky: true, water: null, gas: null, materialEdge: 8, construction: 8 });
    expect(out.edits).toEqual([true, true, true, true, true]);
    // The same step: the wetness painted, the other material three columns off.
    expect(out.after).toMatchObject({ wetness: 4, material: GROUND, materialEdge: 1.5, construction: 8 });
    expect(out.plain).toMatchObject({ wetness: 4, materialEdge: null, construction: null });
    expect(out.named).toEqual(out.plain);
    // The pit's bed a metre under the ground, the liquid to the ground's level, the mist a cell over it.
    const pond = { grid: 0, at: [4.25, -1.25, 2.25], height: -1, sky: true, water: { top: 0, depth: 1, material: LIQUID }, gas: { bottom: 0.5, top: 1.5, density: 0.6, material: MIST } };
    expect(out.pond).toMatchObject(pond);
    expect(out.swimmer).toMatchObject(pond);
    // The pit's walls stand a metre over the bed either side: the bed between them reads steep.
    expect(out.pond!.slope).toBeGreaterThan(45);
    HOUSES.forEach((h, i) => {
      const room = out.room[i]!;
      // The floor is row 0 of the house's own grid (the generator's slab, its top 0.5 m up), a block: construction 0, whatever its yaw.
      expect(room, `house ${h.id}`).toMatchObject({ grid: h.id, material: STONE, role: VOXEL_ROLE.foundation, slope: 0, sky: false, construction: 0, water: null, gas: null });
      expect(room.height).toBeCloseTo(0.5, 9);
      room.at.forEach((c, a) => expect(c, `house ${h.id} at ${a}`).toBeCloseTo(out.floors[i]![a]!, 9));
      expect(out.roof[i], `house ${h.id} roof`).toMatchObject({ grid: h.id, role: VOXEL_ROLE.roof, sky: true });
      expect(out.roof[i]!.height).toBeCloseTo(4, 9);
    });
    // The ground under a house's floor is no surface; nor is there one within reach 2 m over the open ground, nor where nothing is loaded.
    expect([out.under, out.high, out.far, out.bad]).toEqual([null, null, null, null]);
  });
});
