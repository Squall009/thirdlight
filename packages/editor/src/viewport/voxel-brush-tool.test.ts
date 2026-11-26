/**
 * The voxel brush tool driven by pointer events as the Scene view hands them on, in Node: a camera, a canvas
 * rectangle and a host whose voxel pick answers as the view's would (flat ground of 0.5 m cells, or a structure's
 * grid). What a drag sends is checked as the backend reads it: one `editVoxels` brush command of the drag's thinned
 * dabs. The cursor, the trail and the readout are drawing; only what is sent, and when, is checked here.
 */
import * as THREE from 'three';
import { canonicalEditCommand, recordValue, SHAPE_FULL, VOXEL_ROLE, VOXEL_SIZE_M, type BrushEdit, type GridPlacement } from '@thirdlight/voxel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { brushStore, resetBrushStores, type BrushStore } from '../session/brush';
import { VOXEL_BRUSH, VOXEL_BRUSH_BOUNDS } from '../session/voxel-brush';
import type { ScenePickHit } from '../voxel-world/scene-voxels-wire';
import { VoxelBrushTool, type VoxelBrushArm } from './voxel-brush-tool';

const RECT = { left: 0, top: 0, width: 800, height: 600, x: 0, y: 0, right: 800, bottom: 600 };
const GRASS = recordValue(5, VOXEL_ROLE.terrain, SHAPE_FULL, 0);

type Pick = (x: number, y: number, at: THREE.Vector3 | null) => ScenePickHit | null;

function rig(pick: Pick, o: { defer?: boolean } = {}) {
  const attrs = new Map<string, string>();
  const canvas = {
    getBoundingClientRect: () => RECT,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    parentElement: null,
  } as unknown as HTMLCanvasElement;
  const camera = new THREE.PerspectiveCamera(50, RECT.width / RECT.height, 0.1, 500);
  camera.position.set(8, 30, 34);
  camera.lookAt(8, 0, 8);
  camera.updateMatrixWorld();
  const sent: [string, Record<string, unknown>][] = [];
  const refused: string[] = [];
  const readouts: (string | null)[] = [];
  /** Picks not answered yet (`defer`): each is let go by hand. */
  const waiting: (() => void)[] = [];
  /** Where a client point's ray meets the ground (y = 0). */
  const ground = (sx: number, sy: number): THREE.Vector3 | null => {
    const r = new THREE.Raycaster();
    r.setFromCamera(new THREE.Vector2((sx / RECT.width) * 2 - 1, -(sy / RECT.height) * 2 + 1), camera);
    return r.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  };
  const place: GridPlacement = { gridId: 7, position: [2, 0, 3], yawRad: 0 };
  const tool = new VoxelBrushTool(
    {
      overlay: new THREE.Group(),
      camera,
      canvas: () => canvas,
      requestRender: () => undefined,
      pick: (x, y) => {
        const hit = pick(x, y, ground(x, y));
        return o.defer === true ? new Promise((ok) => waiting.push(() => ok(hit))) : Promise.resolve(hit);
      },
      place: () => place,
    },
    { stroke: async (world, c) => void sent.push([world, c]), refused: (m) => void refused.push(m), readout: (t) => void readouts.push(t) },
  );
  /** Client px of a world point. */
  const screen = (x: number, y: number, z: number): { x: number; y: number } => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return { x: ((p.x + 1) / 2) * RECT.width, y: ((1 - p.y) / 2) * RECT.height };
  };
  const ev = (p: { x: number; y: number }, ctrl = false): PointerEvent => ({ clientX: p.x, clientY: p.y, button: 0, altKey: false, shiftKey: false, ctrlKey: ctrl, metaKey: false, pointerId: 1 }) as unknown as PointerEvent;
  const stamp = (): Record<string, unknown> => {
    tool.frame();
    return JSON.parse(canvas.getAttribute('data-voxel-brush')!) as Record<string, unknown>;
  };
  /** The one command sent, as the backend reads it. */
  const command = (i = 0): BrushEdit => canvasCommand(sent[i]![1]);
  return { tool, sent, refused, readouts, screen, ev, stamp, command, waiting };
}

const canvasCommand = (c: Record<string, unknown>): BrushEdit => canonicalEditCommand(c) as BrushEdit;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Flat ground with its top at y = 0: the cell under the point, met from above. */
const flat: Pick = (_x, _y, at) => (at === null ? null : { world: 'yard', grid: 0, t: 1, cell: [Math.floor(at.x / VOXEL_SIZE_M), -1, Math.floor(at.z / VOXEL_SIZE_M)], normal: [0, 1, 0], record: GRASS });

let store: BrushStore;
const arm = (o: Partial<VoxelBrushArm>): VoxelBrushArm => ({ kind: 'dig', navigate: false, world: 'yard', grid: 0, entityId: null, store, uses: ['size', 'spacing', 'invert'], shape: 'sphere', soft: true, voxel: null, ...o });

/** A drag along the ground from (x0, z) to (x1, z) in `steps` moves, each pick answered before the next. */
async function drag(r: ReturnType<typeof rig>, x0: number, x1: number, z: number, steps: number): Promise<void> {
  r.tool.pointerMove(r.ev(r.screen(x0, 0, z)));
  await flush();
  expect(r.tool.pointerDown(r.ev(r.screen(x0, 0, z)))).toBe('capture');
  for (let i = 1; i <= steps; i++) {
    r.tool.pointerMove(r.ev(r.screen(x0 + ((x1 - x0) * i) / steps, 0, z)));
    await flush();
  }
  r.tool.pointerUp(r.ev(r.screen(x1, 0, z)));
}

beforeEach(() => {
  // The brush listens for Ctrl on the window (its invert).
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
  resetBrushStores();
  store = brushStore('test', 'voxel', VOXEL_BRUSH, VOXEL_BRUSH_BOUNDS, null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the voxel brush tool: a drag is one command of thinned dabs', () => {
  it('a 12 m drag of a 4 m brush is one dig command: 13 dabs on cells a quarter of the brush apart from 97 picks, none sent before the release', async () => {
    const r = rig(flat);
    r.tool.arm(arm({}));
    r.tool.pointerMove(r.ev(r.screen(2.25, 0, 8.25)));
    await flush();
    expect(r.tool.pointerDown(r.ev(r.screen(2.25, 0, 8.25)))).toBe('capture');
    // 96 small moves over 12 m: far more picks than dabs.
    for (let i = 1; i <= 96; i++) {
      r.tool.pointerMove(r.ev(r.screen(2.25 + i / 8, 0, 8.25)));
      await flush();
      expect(r.sent).toHaveLength(0);
    }
    expect(r.stamp()['stroke']).toMatchObject({ kind: 'dig' });
    r.tool.pointerUp(r.ev(r.screen(14.25, 0, 8.25)));
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]![0]).toBe('yard');
    const c = r.command();
    // A 4 m brush is 9 cells across: a dab every 2 cells (a quarter of it, in whole cells), on cell centres, over the 24 cells dragged.
    expect(c).toMatchObject({ v: 3, grid: 0, kind: 'brush', shape: 'sphere', size: [4.5, 4.5, 4.5], mode: 'dig', smooth: true });
    expect(c.voxel).toBeUndefined();
    const dabs = c.points.length / 3;
    expect(dabs).toBe(13);
    expect(c.points).toEqual(Array.from({ length: 13 }, (_, i) => [4.5 + 2 * i, -0.5, 16.5]).flat());
    expect(c.points[0]).toBe(4.5);
    expect(r.stamp()['last']).toMatchObject({ stroke: 'dig', dabs });
    expect(r.readouts.at(-1)).toBeNull();
  });

  it('a fast drag (one pick 12 m on) leaves no gap: the dabs between are filled along the line', async () => {
    const r = rig(flat);
    r.tool.arm(arm({}));
    await drag(r, 2.25, 14.25, 8.25, 1);
    const c = r.command();
    expect(c.points).toEqual(Array.from({ length: 13 }, (_, i) => [4.5 + 2 * i, -0.5, 16.5]).flat());
  });

  it('each Sculpt tool sends its mode; Add writes the picked voxel in front of the ground, and with none says so', async () => {
    for (const kind of ['dig', 'smooth', 'flatten'] as const) {
      const r = rig(flat);
      r.tool.arm(arm({ kind, soft: kind !== 'smooth' }));
      await drag(r, 4.25, 8.25, 8.25, 4);
      const c = r.command();
      expect(c.mode).toBe(kind);
      expect(c.voxel).toBeUndefined();
      expect(c.smooth).toBe(kind !== 'smooth');
      expect(c.points[1]).toBe(-0.5);
    }
    const r = rig(flat);
    r.tool.arm(arm({ kind: 'add', shape: 'cylinder', voxel: { material: 5, role: VOXEL_ROLE.terrain, wetness: 0 } }));
    await drag(r, 4.25, 8.25, 8.25, 4);
    const c = r.command();
    expect(c).toMatchObject({ mode: 'add', shape: 'cylinder', voxel: { material: 5, role: VOXEL_ROLE.terrain, wetness: 0 } });
    // The cell over the ground met from above.
    expect(c.points[1]).toBe(0.5);
    r.tool.arm(arm({ kind: 'add', voxel: null }));
    r.tool.pointerMove(r.ev(r.screen(4.25, 0, 8.25)));
    await flush();
    expect(r.tool.pointerDown(r.ev(r.screen(4.25, 0, 8.25)))).toBe('consume');
    expect(r.refused.at(-1)).toMatch(/Add needs a material/);
    expect(r.sent).toHaveLength(1);
  });

  it('Flatten\'s plane is the surface under the first dab: its row plus its fill, whatever the drag passes after', async () => {
    // Ground rising a cell every 2 m along x, each surface cell 6/15 full.
    const slope: Pick = (_x, _y, at) => (at === null ? null : { world: 'yard', grid: 0, t: 1, cell: [Math.floor(at.x / VOXEL_SIZE_M), Math.floor(at.x / 2), Math.floor(at.z / VOXEL_SIZE_M)], normal: [0, 1, 0], record: recordValue(5, VOXEL_ROLE.terrain, 6, 0) });
    const r = rig(slope);
    r.tool.arm(arm({ kind: 'flatten' }));
    await drag(r, 6.25, 12.25, 8.25, 6);
    const c = r.command();
    expect(c.mode).toBe('flatten');
    expect(c.height).toBeCloseTo(3 + 6 / 15, 12);
    // The dabs climbed the slope; the plane did not move with them.
    expect(c.points.at(-2)).toBeGreaterThan(c.points[1]!);
  });

  it('Paint sends a role-less paint with its material and wetness; through the noise mask, the columns the mask lets through', async () => {
    const r = rig(flat);
    r.tool.arm(arm({ kind: 'paint', uses: ['size', 'spacing', 'mask'], voxel: { material: 9, role: VOXEL_ROLE.wall, wetness: 5 } }));
    await drag(r, 4.25, 8.25, 8.25, 4);
    const plain = r.command(0);
    expect(plain).toMatchObject({ v: 3, mode: 'paint', shape: 'sphere', size: [4.5, 4.5, 4.5], voxel: { material: 9, wetness: 5 }, smooth: false });
    // Whatever role the mode hands it, a Paint keeps each cell's own.
    expect(plain.voxel).not.toHaveProperty('role');
    store.set({ mask: { on: true, scale: 2 } });
    await drag(r, 4.25, 8.25, 8.25, 4);
    const masked = r.command(1);
    expect(masked).toMatchObject({ mode: 'paint', shape: 'box', size: [0.5, 4.5, 0.5], voxel: { material: 9, wetness: 5 } });
    expect(masked.points.length / 3).toBeGreaterThan(plain.points.length / 3);
    // The mask is the brush's, read by the tools that use one: a brush that does not, paints whole.
    r.tool.arm(arm({ kind: 'paint', uses: ['size'], voxel: { material: 9, wetness: 0 } }));
    await drag(r, 4.25, 8.25, 8.25, 4);
    expect(r.command(2).shape).toBe('sphere');
  });

  it('Ctrl held at the press swaps Add and Dig for that stroke', async () => {
    const r = rig(flat);
    r.tool.arm(arm({ kind: 'add', voxel: { material: 5, role: VOXEL_ROLE.terrain, wetness: 0 } }));
    r.tool.pointerMove(r.ev(r.screen(4.25, 0, 8.25), true));
    await flush();
    r.tool.pointerDown(r.ev(r.screen(4.25, 0, 8.25), true));
    r.tool.pointerUp(r.ev(r.screen(4.25, 0, 8.25), true));
    expect(r.command()).toMatchObject({ mode: 'dig', points: [8.5, -0.5, 16.5] });
    expect(r.command().voxel).toBeUndefined();
  });
});

describe('the voxel brush tool: grids, Escape and what is not its press', () => {
  it('on a structure\'s grid it sends that grid and its cells: a one-cell box, every cell the drag passes once; the ground under the pointer is the view\'s', async () => {
    store.set({ size: VOXEL_SIZE_M });
    // A wall of the structure's grid 7 facing −z: the cell under the pointer follows x.
    let grid = 7;
    const wall: Pick = (x) => ({ world: 'yard', grid, t: 20, cell: [Math.floor(x / 40), 3, 1], normal: [0, 0, -1], record: 77 });
    const r = rig(wall);
    r.tool.arm(arm({ kind: 'dig', grid: 7, entityId: 'house-1', shape: 'box', soft: false, uses: ['size'] }));
    r.tool.pointerMove(r.ev({ x: 205, y: 300 }));
    await flush();
    expect(r.tool.pointerDown(r.ev({ x: 205, y: 300 }))).toBe('capture');
    for (const x of [215, 245, 250, 290, 245]) {
      r.tool.pointerMove(r.ev({ x, y: 300 }));
      await flush();
    }
    r.tool.pointerUp(r.ev({ x: 245, y: 300 }));
    expect(r.sent).toEqual([['yard', { v: 3, grid: 7, kind: 'brush', shape: 'box', size: [0.5, 0.5, 0.5], points: [5.5, 3.5, 1.5, 6.5, 3.5, 1.5, 7.5, 3.5, 1.5], mode: 'dig', smooth: false }]]);
    // Add on the same wall: the cell in front of the face.
    r.tool.arm(arm({ kind: 'add', grid: 7, entityId: 'house-1', shape: 'box', soft: false, uses: ['size'], voxel: { material: 3, role: VOXEL_ROLE.pillar, wetness: 0 } }));
    r.tool.pointerMove(r.ev({ x: 205, y: 300 }));
    await flush();
    r.tool.pointerDown(r.ev({ x: 205, y: 300 }));
    r.tool.pointerUp(r.ev({ x: 205, y: 300 }));
    expect(r.command(1)).toMatchObject({ grid: 7, mode: 'add', points: [5.5, 3.5, 0.5], voxel: { material: 3, role: VOXEL_ROLE.pillar, wetness: 0 } });
    // The world's ground (grid 0) under the pointer: the press is left to the view, nothing is sent.
    grid = 0;
    r.tool.pointerMove(r.ev({ x: 420, y: 300 }));
    await flush();
    expect(r.tool.pointerDown(r.ev({ x: 420, y: 300 }))).toBeNull();
    expect(r.stamp()['hover']).toMatchObject({ grid: 0, mine: false });
    expect(r.sent).toHaveLength(2);
  });

  it('armed on the world it leaves a structure\'s cells, another world and the sky to the view; in Navigate it takes no press', async () => {
    let hit: ScenePickHit | null = { world: 'yard', grid: 7, t: 5, cell: [1, 2, 3], normal: [0, 1, 0], record: 77 };
    const r = rig(() => hit);
    r.tool.arm(arm({}));
    for (const h of [hit, { ...hit, grid: 0, world: 'other' }, null]) {
      hit = h;
      r.tool.pointerMove(r.ev({ x: 300, y: 300 }));
      await flush();
      expect(r.tool.pointerDown(r.ev({ x: 300, y: 300 }))).toBeNull();
    }
    hit = { world: 'yard', grid: 0, t: 5, cell: [1, 2, 3], normal: [0, 1, 0], record: GRASS };
    r.tool.arm(arm({ navigate: true }));
    expect(r.tool.armed()).toBe(false);
    r.tool.pointerMove(r.ev({ x: 300, y: 300 }));
    await flush();
    expect(r.tool.pointerDown(r.ev({ x: 300, y: 300 }))).toBeNull();
    expect(r.sent).toHaveLength(0);
  });

  it('Escape drops the stroke in flight: nothing is sent, at the release either', async () => {
    const r = rig(flat);
    r.tool.arm(arm({}));
    r.tool.pointerMove(r.ev(r.screen(4.25, 0, 8.25)));
    await flush();
    r.tool.pointerDown(r.ev(r.screen(4.25, 0, 8.25)));
    r.tool.pointerMove(r.ev(r.screen(9.25, 0, 8.25)));
    await flush();
    expect((r.stamp()['stroke'] as { dabs: number }).dabs).toBeGreaterThan(1);
    expect(r.tool.cancel()).toBe(true);
    expect(r.stamp()['stroke']).toBeNull();
    expect(r.tool.pointerUp(r.ev(r.screen(9.25, 0, 8.25)))).toBe(false);
    await flush();
    expect(r.sent).toHaveLength(0);
    // Nothing in flight: Esc is not the tool's.
    expect(r.tool.cancel()).toBe(false);
  });

  it('a release while the last cell is still being picked sends the stroke once, with that cell in it', async () => {
    const r = rig(flat, { defer: true });
    r.tool.arm(arm({}));
    r.tool.pointerMove(r.ev(r.screen(4.25, 0, 8.25)));
    r.waiting.shift()!();
    await flush();
    r.tool.pointerDown(r.ev(r.screen(4.25, 0, 8.25)));
    r.tool.pointerMove(r.ev(r.screen(10.25, 0, 8.25)));
    expect(r.tool.pointerUp(r.ev(r.screen(10.25, 0, 8.25)))).toBe(true);
    expect(r.sent).toHaveLength(0);
    r.waiting.shift()!();
    await flush();
    expect(r.sent).toHaveLength(1);
    const p = r.command().points;
    expect(p[0]).toBe(8.5);
    expect(p.at(-3)).toBeGreaterThanOrEqual(18.5);
  });
});
