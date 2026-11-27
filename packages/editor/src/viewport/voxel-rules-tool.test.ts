/**
 * The voxel brush tool armed with the rules probe, driven by pointer events
 * as the Scene view hands them on, in Node: a camera, a canvas rectangle, a
 * host whose pick answers flat ground and whose surface read answers from a
 * made world through the kernel's own per-point form (`sceneSurfaceRead`,
 * the function the view's worker runs). The probe reads and never sends.
 */
import * as THREE from 'three';
import { recordValue, SHAPE_FULL, streamerSurfaceSource, surfaceCellsSource, surfaceFieldsOf, surfacePointOut, surfaceTable, valueOf, VOXEL_ROLE, VOXEL_SIZE_M, readValue, type SurfaceCells, type SurfaceStreamerView } from '@thirdlight/voxel';
import { beforeEach, describe, expect, it } from 'vitest';

import { brushStore, resetBrushStores, type BrushStore } from '../session/brush';
import { VOXEL_BRUSH, VOXEL_BRUSH_BOUNDS } from '../session/voxel-brush';
import { sceneSurfaceRead, type ScenePickHit, type SceneSurfaceRead } from '../voxel-world/scene-voxels-wire';
import { VoxelBrushTool, type VoxelBrushArm } from './voxel-brush-tool';
import type { RulesProbeRead } from './voxel-rules-probe';

const RECT = { left: 0, top: 0, width: 800, height: 600, x: 0, y: 0, right: 800, bottom: 600 };
const GRASS = recordValue(3, VOXEL_ROLE.terrain, SHAPE_FULL, 2);
const HALF = recordValue(3, VOXEL_ROLE.terrain, 8, 0);
const ROAD = recordValue(5, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
const WALL = recordValue(9, VOXEL_ROLE.wall, SHAPE_FULL, 0);
const WATER = recordValue(30, VOXEL_ROLE.liquid, SHAPE_FULL, 0);

/**
 * The made world, 64 cells a side from cell 0: ground to y = 3 (a road strip at x 20–23, a wall two cells thick and
 * five high at z 40–41, a pond two cells deep at x 40–47, z 8–15, its bed at y = 1), a half-filled cell at (10, 4, 10).
 */
function worldValue(x: number, y: number, z: number): number {
  if (x < 0 || z < 0 || x >= 64 || z >= 64 || y < 0 || y >= 32) return 0;
  const pond = x >= 40 && x < 48 && z >= 8 && z < 16;
  if (pond) return y <= 1 ? GRASS : y <= 3 ? WATER : 0;
  if (y <= 3) return x >= 20 && x < 24 ? ROAD : GRASS;
  if (z >= 40 && z < 42 && y < 9) return WALL;
  if (x === 10 && y === 4 && z === 10) return HALF;
  return 0;
}

/** The world as a streamer holds it: chunks of 32 cells, a ring of empty ones round the made ground, those listed loaded. */
function streamer(loaded: (cx: number, cy: number, cz: number) => boolean = () => true): SurfaceStreamerView {
  return { grid: { shift: 5 }, isResident: (cx, cy, cz) => cx >= -1 && cz >= -1 && cx < 3 && cz < 3 && cy >= -1 && cy <= 0 && loaded(cx, cy, cz), voxelAt: (x, y, z, out) => readValue(worldValue(x, y, z), out) };
}

/** The whole world as one box, for the kernel's own answer. */
function box(): SurfaceCells {
  const values = new Uint32Array(64 * 32 * 64);
  for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) for (let y = 0; y < 32; y++) values[(x * 64 + z) * 32 + y] = worldValue(x, y, z);
  return { sx: 64, sy: 32, sz: 64, ox: 0, oy: 0, oz: 0, cellM: VOXEL_SIZE_M, values };
}

function rig(o: { surface?: 'none' | ((cell: readonly [number, number, number]) => Promise<SceneSurfaceRead | null>); world?: string } = {}) {
  const attrs = new Map<string, string>();
  const canvas = { getBoundingClientRect: () => RECT, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k), getAttribute: (k: string) => attrs.get(k) ?? null, parentElement: null } as unknown as HTMLCanvasElement;
  const camera = new THREE.PerspectiveCamera(50, RECT.width / RECT.height, 0.1, 500);
  camera.position.set(16, 30, 44);
  camera.lookAt(16, 2, 16);
  camera.updateMatrixWorld();
  const asked: (readonly [number, number, number])[] = [];
  const said: (RulesProbeRead | null)[] = [];
  const sent: unknown[] = [];
  const src = streamer();
  const ground = (sx: number, sy: number): THREE.Vector3 | null => {
    const r = new THREE.Raycaster();
    r.setFromCamera(new THREE.Vector2((sx / RECT.width) * 2 - 1, -(sy / RECT.height) * 2 + 1), camera);
    return r.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -2), new THREE.Vector3());
  };
  const tool = new VoxelBrushTool(
    {
      overlay: new THREE.Group(),
      camera,
      canvas: () => canvas,
      requestRender: () => undefined,
      pick: (x, y) => {
        const p = ground(x, y);
        const hit: ScenePickHit | null = p === null ? null : { world: o.world ?? 'yard', grid: 0, t: 1, cell: [Math.floor(p.x / VOXEL_SIZE_M), 3, Math.floor(p.z / VOXEL_SIZE_M)], normal: [0, 1, 0], record: worldValue(Math.floor(p.x / VOXEL_SIZE_M), 3, Math.floor(p.z / VOXEL_SIZE_M)) };
        return Promise.resolve(hit);
      },
      place: () => null,
      ...(o.surface === 'none'
        ? {}
        : {
            surface: (_world: string, cell: readonly [number, number, number]) => {
              asked.push(cell);
              return typeof o.surface === 'function' ? o.surface(cell) : Promise.resolve(sceneSurfaceRead(streamerSurfaceSource(src, null, cell[1]), cell));
            },
          }),
    },
    { stroke: async (w, c) => void sent.push([w, c]), refused: () => undefined, readout: () => undefined, send: async (op, args) => (sent.push([op, args]), { ok: true }), probe: (r) => void said.push(r) },
  );
  /** The screen point over the middle of ground cell (cx, cz). */
  const over = (cx: number, cz: number): PointerEvent => {
    const p = new THREE.Vector3((cx + 0.5) * VOXEL_SIZE_M, 2, (cz + 0.5) * VOXEL_SIZE_M).project(camera);
    return { clientX: ((p.x + 1) / 2) * RECT.width, clientY: ((1 - p.y) / 2) * RECT.height, button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, pointerId: 1 } as unknown as PointerEvent;
  };
  const stamp = (): { probe?: RulesProbeRead | null } => {
    tool.frame();
    return JSON.parse(canvas.getAttribute('data-voxel-brush')!);
  };
  const last = (): RulesProbeRead | null => said[said.length - 1] ?? null;
  return { tool, asked, said, sent, over, stamp, last };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let store: BrushStore;
const arm = (o: Partial<VoxelBrushArm> = {}): VoxelBrushArm => ({ kind: 'paint', navigate: false, world: 'yard', grid: 0, entityId: null, store, uses: [], shape: 'sphere', soft: false, voxel: null, probe: true, ...o });

beforeEach(() => {
  resetBrushStores();
  store = brushStore('world', 'rules', VOXEL_BRUSH, VOXEL_BRUSH_BOUNDS);
});

describe('the surface read the probe asks of the view', () => {
  const kernel = (x: number, z: number, row: number) => surfaceFieldsOf(surfaceTable(box()), x, z, row, true, surfacePointOut());

  it('answers a cell with the kernel\'s own fields for the surface under it, distances included', () => {
    const src = streamer();
    // Open ground far from everything; beside the road; in the pond (the bed, under two cells of water); at the wall's foot; a half-filled cell.
    for (const [cell, row] of [[[30, 3, 30], 3], [[18, 3, 30], 3], [[44, 3, 12], 1], [[30, 3, 38], 3], [[10, 4, 10], 4]] as const) {
      const got = sceneSurfaceRead(streamerSurfaceSource(src, null, cell[1]), cell);
      expect(got.state).toBe('surface');
      if (got.state === 'surface') expect(got.point).toEqual(kernel(cell[0], cell[2], row));
    }
    const road = sceneSurfaceRead(streamerSurfaceSource(src, null, 3), [18, 3, 30]);
    const pond = sceneSurfaceRead(streamerSurfaceSource(src, null, 3), [44, 3, 12]);
    const foot = sceneSurfaceRead(streamerSurfaceSource(src, null, 3), [30, 3, 38]);
    const half = sceneSurfaceRead(streamerSurfaceSource(src, null, 4), [10, 4, 10]);
    if (road.state !== 'surface' || pond.state !== 'surface' || foot.state !== 'surface' || half.state !== 'surface') throw new Error('no surface');
    expect(road.point).toMatchObject({ material: 3, wetness: 2, sky: 1, height: 2, materialEdge: 1 });
    expect(pond.point).toMatchObject({ row: 1, waterDepth: 1, waterMaterial: 30, height: 1 });
    expect(foot.point.construction).toBe(1);
    expect(half.point.row).toBe(4);
    expect(half.point.height).toBeCloseTo(2 + (8 / SHAPE_FULL) * VOXEL_SIZE_M, 9);
    // From a cell in the air a little over the ground, the ground under it; from high up, nothing.
    expect(sceneSurfaceRead(streamerSurfaceSource(src, null, 6), [30, 6, 30])).toMatchObject({ state: 'surface', point: { row: 3 } });
    expect(sceneSurfaceRead(streamerSurfaceSource(src, null, 20), [30, 20, 30])).toEqual({ state: 'none' });
  });

  it('says a cell it would need is not loaded, never a guess', () => {
    // The chunk beside is not loaded: a point whose distances reach into it is not answered; one far from it is.
    const src = streamer((cx) => cx <= 0);
    expect(sceneSurfaceRead(streamerSurfaceSource(src, null, 3), [28, 3, 10])).toEqual({ state: 'unloaded' });
    expect(sceneSurfaceRead(streamerSurfaceSource(src, null, 3), [40, 3, 10])).toEqual({ state: 'unloaded' });
    expect(sceneSurfaceRead(streamerSurfaceSource(src, null, 3), [8, 3, 20]).state).toBe('surface');
    // The same source the kernel's box form reads through gives the same answer where both know the cells.
    const whole = sceneSurfaceRead(surfaceCellsSource(box()), [30, 3, 30]);
    expect(whole).toEqual(sceneSurfaceRead(streamerSurfaceSource(streamer(), null, 3), [30, 3, 30]));
    expect(valueOf(readValue(GRASS, { material: 0, role: 0, shape: 0, wetness: 0 }))).toBe(GRASS);
  });
});

describe('the rules probe on the voxel brush tool', () => {
  it('reads the surface under the pointer and says it, asking once while the pointer rests on a cell', async () => {
    const r = rig();
    r.tool.arm(arm());
    expect(r.tool.armed()).toBe(true);
    r.tool.pointerMove(r.over(30, 30));
    await flush();
    expect(r.asked).toEqual([[30, 3, 30]]);
    expect(r.last()).toMatchObject({ world: 'yard', cell: [30, 3, 30], at: [15.25, 2, 15.25], pinned: false, read: { state: 'surface', point: { material: 3, height: 2, sky: 1 } } });
    // Another pixel of the same cell: no second read.
    const e = r.over(30, 30);
    r.tool.pointerMove({ ...e, clientX: e.clientX + 1 } as PointerEvent);
    await flush();
    expect(r.asked.length).toBe(1);
    // Another cell: read there.
    r.tool.pointerMove(r.over(44, 12));
    await flush();
    expect(r.asked.length).toBe(2);
    expect(r.last()).toMatchObject({ cell: [44, 3, 12], read: { state: 'surface', point: { waterDepth: 1 } } });
    expect(r.stamp().probe).toMatchObject({ cell: [44, 3, 12], pinned: false });
    expect(r.sent).toEqual([]);
  });

  it('holds the read where it is clicked, moves it with another click and lets go on Esc', async () => {
    const r = rig();
    r.tool.arm(arm());
    r.tool.pointerMove(r.over(30, 30));
    await flush();
    expect(r.tool.pointerDown(r.over(30, 30))).toBe('consume');
    await flush();
    expect(r.last()).toMatchObject({ cell: [30, 3, 30], pinned: true });
    const reads = r.asked.length;
    // The pointer wanders (to the column, over other ground): the held read stays.
    r.tool.pointerMove(r.over(18, 30));
    await flush();
    r.tool.leave();
    expect(r.asked.length).toBe(reads);
    expect(r.last()).toMatchObject({ cell: [30, 3, 30], pinned: true });
    // Back over the ground, a click elsewhere holds there.
    r.tool.pointerMove(r.over(18, 30));
    await flush();
    expect(r.asked.length).toBe(reads);
    expect(r.tool.pointerDown(r.over(18, 30))).toBe('consume');
    await flush();
    expect(r.last()).toMatchObject({ cell: [18, 3, 30], pinned: true, read: { state: 'surface', point: { materialEdge: 1 } } });
    // Esc lets go (and is taken); a second Esc is the editor's.
    expect(r.tool.cancel()).toBe(true);
    expect(r.last()).toBeNull();
    expect(r.tool.cancel()).toBe(false);
    r.tool.pointerMove(r.over(31, 30));
    await flush();
    expect(r.last()).toMatchObject({ cell: [31, 3, 30], pinned: false });
    // Nothing was sent, by a stroke or otherwise, and no stroke began.
    expect(r.sent).toEqual([]);
    r.tool.pointerUp(r.over(31, 30));
    await flush();
    expect(r.sent).toEqual([]);
  });

  it('reads nothing over another world\'s ground, in Navigate, or once the rail is left', async () => {
    const other = rig({ world: 'elsewhere' });
    other.tool.arm(arm());
    other.tool.pointerMove(other.over(30, 30));
    await flush();
    expect(other.asked).toEqual([]);
    expect(other.tool.pointerDown(other.over(30, 30))).toBeNull();
    const nav = rig();
    nav.tool.arm(arm({ navigate: true }));
    nav.tool.pointerMove(nav.over(30, 30));
    await flush();
    expect(nav.asked).toEqual([]);
    expect(nav.tool.pointerDown(nav.over(30, 30))).toBeNull();
    // Left for another rail: the read goes, a pinned one too.
    const r = rig();
    r.tool.arm(arm());
    r.tool.pointerMove(r.over(30, 30));
    await flush();
    r.tool.pointerDown(r.over(30, 30));
    await flush();
    r.tool.arm(arm({ probe: false, fill: { kind: 'drain', material: null, depthM: 2, reachM: 8, fadeM: 0, sceneId: null } }));
    expect(r.last()).toBeNull();
    expect(r.stamp().probe).toBeUndefined();
  });

  it('drops an answer a later read overtook, and says so when the view reads nothing', async () => {
    const waiting: ((read: SceneSurfaceRead) => void)[] = [];
    const r = rig({ surface: () => new Promise((ok) => waiting.push(ok)) });
    r.tool.arm(arm());
    r.tool.pointerMove(r.over(30, 30));
    await flush();
    r.tool.pointerMove(r.over(18, 30));
    await flush();
    expect(waiting.length).toBe(2);
    // The second answers first, then the first: the first is not shown.
    waiting[1]!({ state: 'none' });
    await flush();
    waiting[0]!({ state: 'unloaded' });
    await flush();
    expect(r.said.length).toBe(1);
    expect(r.last()).toMatchObject({ cell: [18, 3, 30], read: { state: 'none' } });
    const blind = rig({ surface: 'none' });
    blind.tool.arm(arm());
    blind.tool.pointerMove(blind.over(30, 30));
    await flush();
    expect(blind.last()).toMatchObject({ cell: [30, 3, 30], read: null });
  });
});
