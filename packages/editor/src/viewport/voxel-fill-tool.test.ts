/**
 * The voxel brush tool armed with a fill or the fog brush, driven by pointer events as the Scene view hands them
 * on, in Node: a camera, a canvas rectangle, a host whose pick answers as the view's would (flat ground of 0.5 m
 * cells) and whose cell read answers from a made world. What is sent is checked as the backend reads it: one
 * `flood` stroke, one `createEntity`, one `set` or `dig` of named cells, one `smooth`. The ring and the readout are
 * drawing; the leak marks are checked by where they stand.
 */
import * as THREE from 'three';
import { canonicalEditCommand, recordValue, SHAPE_FULL, valueRole, VOXEL_ROLE, VOXEL_SIZE_M, type BrushEdit, type DigEdit, type FloodEdit, type SetEdit } from '@thirdlight/voxel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { brushStore, resetBrushStores, type BrushStore } from '../session/brush';
import { FOG_BRUSH, FOG_BRUSH_BOUNDS } from '../session/voxel-brush';
import { draggedLevelM, gasValue, metresPerPixel, type FloodLeak } from '../session/voxel-fill';
import { CELL_NOT_LOADED, type ScenePickHit } from '../voxel-world/scene-voxels-wire';
import { VoxelBrushTool, type VoxelBrushArm } from './voxel-brush-tool';
import type { FillAnswer, VoxelFillArm } from './voxel-fill-gesture';

const RECT = { left: 0, top: 0, width: 800, height: 600, x: 0, y: 0, right: 800, bottom: 600 };
const GRASS = recordValue(5, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
const WATER = recordValue(30, VOXEL_ROLE.liquid, SHAPE_FULL, 0);
const SMOKE = gasValue(41, 15);

/** The made world a fog stroke reads: ground under y = 0, a pond in its top row for x ≥ 20 cells, a puff of another gas, air. */
const worldValue = (x: number, y: number, z: number): number => (y < -1 ? GRASS : y === -1 ? (x >= 20 ? WATER : GRASS) : x === 9 && y === 1 && z === 16 ? SMOKE : 0);

function rig(o: { answer?: (op: string, args: Record<string, unknown>) => FillAnswer; cells?: 'none' | 'unloaded' } = {}) {
  const attrs = new Map<string, string>();
  const canvas = { getBoundingClientRect: () => RECT, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k), getAttribute: (k: string) => attrs.get(k) ?? null, parentElement: null } as unknown as HTMLCanvasElement;
  const camera = new THREE.PerspectiveCamera(50, RECT.width / RECT.height, 0.1, 500);
  camera.position.set(8, 30, 34);
  camera.lookAt(8, 0, 8);
  camera.updateMatrixWorld();
  const overlay = new THREE.Group();
  const strokes: [string, Record<string, unknown>][] = [];
  const sent: [string, Record<string, unknown>][] = [];
  const refused: string[] = [];
  const depths: number[] = [];
  const made: [string, string][] = [];
  const ground = (sx: number, sy: number): THREE.Vector3 | null => {
    const r = new THREE.Raycaster();
    r.setFromCamera(new THREE.Vector2((sx / RECT.width) * 2 - 1, -(sy / RECT.height) * 2 + 1), camera);
    return r.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  };
  const tool = new VoxelBrushTool(
    {
      overlay,
      camera,
      canvas: () => canvas,
      requestRender: () => undefined,
      pick: (x, y) => {
        const at = ground(x, y);
        const hit: ScenePickHit | null = at === null ? null : { world: 'yard', grid: 0, t: 1, cell: [Math.floor(at.x / VOXEL_SIZE_M), -1, Math.floor(at.z / VOXEL_SIZE_M)], normal: [0, 1, 0], record: GRASS };
        return Promise.resolve(hit);
      },
      place: () => null,
      ...(o.cells === 'none'
        ? {}
        : {
            cells: (_world: string, box: { min: readonly number[]; max: readonly number[] }) => {
              const out = new Uint32Array((box.max[0]! - box.min[0]! + 1) * (box.max[1]! - box.min[1]! + 1) * (box.max[2]! - box.min[2]! + 1));
              let i = 0;
              for (let x = box.min[0]!; x <= box.max[0]!; x++) for (let z = box.min[2]!; z <= box.max[2]!; z++) for (let y = box.min[1]!; y <= box.max[1]!; y++) out[i++] = o.cells === 'unloaded' ? CELL_NOT_LOADED : worldValue(x, y, z);
              return Promise.resolve(out);
            },
          }),
    },
    {
      stroke: async (world, c) => void strokes.push([world, c]),
      refused: (m) => void refused.push(m),
      readout: () => undefined,
      send: async (op, args) => {
        sent.push([op, args]);
        return o.answer?.(op, args) ?? { ok: true };
      },
      depth: (m) => void depths.push(m),
      made: (what, id) => void made.push([what, id]),
    },
  );
  const screen = (x: number, y: number, z: number): { x: number; y: number } => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return { x: ((p.x + 1) / 2) * RECT.width, y: ((1 - p.y) / 2) * RECT.height };
  };
  const ev = (p: { x: number; y: number }): PointerEvent => ({ clientX: p.x, clientY: p.y, button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, pointerId: 1 }) as unknown as PointerEvent;
  const stamp = (): { fill?: { gesture: { seed: number[]; level: number } | null; ring: boolean; leaks: number[][]; last: Record<string, unknown> | null }; last: Record<string, unknown> | null } => {
    tool.frame();
    return JSON.parse(canvas.getAttribute('data-voxel-brush')!);
  };
  return { tool, overlay, camera, strokes, sent, refused, depths, made, screen, ev, stamp };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let store: BrushStore;
const FILL: VoxelFillArm = { kind: 'fog', material: 40, depthM: 2, reachM: 24, fadeM: 1, sceneId: 'scene-main' };
const arm = (o: Partial<VoxelBrushArm>): VoxelBrushArm => ({ kind: 'fog', navigate: false, world: 'yard', grid: 0, entityId: null, store, uses: [], shape: 'sphere', soft: false, voxel: null, ...o });

/** A press on the ground at (x, z) metres, the pointer then moved `upPx` up the screen in `steps` moves, and released. */
async function fillDrag(r: ReturnType<typeof rig>, x: number, z: number, upPx: number, steps = 4): Promise<{ x: number; y: number }> {
  const p = r.screen(x, 0, z);
  r.tool.pointerMove(r.ev(p));
  await flush();
  expect(r.tool.pointerDown(r.ev(p))).toBe('capture');
  for (let i = 1; i <= steps; i++) {
    r.tool.pointerMove(r.ev({ x: p.x, y: p.y - (upPx * i) / steps }));
    await flush();
  }
  return p;
}

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
  resetBrushStores();
  store = brushStore('test', 'fog', FOG_BRUSH, FOG_BRUSH_BOUNDS, null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Fill rail: a click and a drag are one command', () => {
  it('fog to a level: one flood from the open cell over the point clicked, the level the drag set, the gas, the reach and the fade; nothing sent before the release', async () => {
    const r = rig();
    r.tool.arm(arm({ fill: FILL }));
    // Before the press the ring already shows what a click would give.
    r.tool.pointerMove(r.ev(r.screen(6.2, 0, 8.2)));
    await flush();
    expect(r.stamp().fill).toMatchObject({ gesture: null, ring: true });
    await fillDrag(r, 6.2, 8.2, 60);
    expect(r.sent).toEqual([]);
    const perPx = metresPerPixel(50, RECT.height, r.camera.position.distanceTo(new THREE.Vector3(6.25, 0, 8.25)));
    const level = draggedLevelM(2, 60, perPx);
    expect(level).toBeGreaterThan(2);
    expect(r.stamp().fill?.gesture).toEqual({ seed: [12, 0, 16], level });
    r.tool.pointerUp(r.ev(r.screen(6.2, 0, 8.2)));
    await flush();
    expect(r.sent.length).toBe(1);
    expect(r.strokes).toEqual([]);
    const [op, args] = r.sent[0]!;
    expect(op).toBe('editVoxels');
    expect(args['world']).toBe('yard');
    const cmd = canonicalEditCommand(args['command']) as FloodEdit;
    expect(cmd).toEqual({ v: 3, grid: 0, kind: 'flood', seed: [12, 0, 16], level: level / VOXEL_SIZE_M, value: { material: 40, role: VOXEL_ROLE.gas }, reach: 48, fade: 1 });
    // The dragged level is what the next click starts from.
    expect(r.depths).toEqual([level]);
    expect(r.stamp().fill).toMatchObject({ gesture: null, leaks: [], last: { fill: 'fog', ok: true } });
    expect(r.refused).toEqual([]);
  });

  it('a click alone fills to the set depth over the point; a drag down stops a step over the surface', async () => {
    const r = rig();
    r.tool.arm(arm({ fill: { ...FILL, depthM: 3.5, fadeM: 0 } }));
    await fillDrag(r, 2.2, 4.2, 0, 1);
    r.tool.pointerUp(r.ev(r.screen(2.2, 0, 4.2)));
    await flush();
    const click = canonicalEditCommand(r.sent[0]![1]['command']) as FloodEdit;
    expect(click.level).toBe(7);
    expect(click.fade).toBeUndefined();
    await fillDrag(r, 2.2, 4.2, -400);
    r.tool.pointerUp(r.ev(r.screen(2.2, 0, 4.2)));
    await flush();
    expect((canonicalEditCommand(r.sent[1]![1]['command']) as FloodEdit).level).toBe(0.5);
  });

  it('a refused flood that names its leaks marks each place, says so, and writes nothing; the next fill that is taken clears the marks', async () => {
    const leaks: FloodLeak[] = [{ at: [12.25, 0.75, 3], kind: 'reach', cells: 6 }, { at: [-4, 1.25, 9.5], kind: 'reach', cells: 2 }];
    let leak = true;
    const r = rig({ answer: () => (leak ? { ok: false, code: 'flood_leaks', message: 'the flood leaks in 2 places', leaks } : { ok: true }) });
    r.tool.arm(arm({ fill: FILL }));
    await fillDrag(r, 6.2, 8.2, 20);
    r.tool.pointerUp(r.ev(r.screen(6.2, 0, 8.2)));
    await flush();
    expect(r.sent.length).toBe(1);
    expect(r.strokes).toEqual([]);
    expect(r.stamp().fill).toMatchObject({ leaks: [[12.25, 0.75, 3], [-4, 1.25, 9.5]], last: { fill: 'fog', ok: false, error: 'flood_leaks', leaks: 2 } });
    // The water bodies' markers, at the places named: a cross and a ring round each.
    const marks = r.overlay.getObjectByName('flood-leaks-marks') as THREE.LineSegments;
    expect(marks.userData['marks']).toBe(2);
    const pos = marks.geometry.getAttribute('position');
    const box = new THREE.Box3().setFromBufferAttribute(pos as THREE.BufferAttribute);
    expect(box.containsPoint(new THREE.Vector3(12.25, 0.75, 3))).toBe(true);
    expect(box.containsPoint(new THREE.Vector3(-4, 1.25, 9.5))).toBe(true);
    expect([pos.getX(0), pos.getY(0), pos.getZ(0)]).toEqual([12.25 - 1.5, 0.75, 3]);
    expect(r.refused.at(-1)).toMatch(/^The fog leaks past its reach at 2 places, first at \(12\.3, 0\.8, 3\.0\) m: nothing was written/);
    // The marks stay while another fill tool is picked, and go with a fill that is taken.
    r.tool.arm(arm({ fill: { ...FILL, kind: 'drain', material: null } }));
    expect(r.overlay.getObjectByName('flood-leaks-marks')).toBeDefined();
    leak = false;
    await fillDrag(r, 6.2, 8.2, 20);
    r.tool.pointerUp(r.ev(r.screen(6.2, 0, 8.2)));
    await flush();
    expect(r.overlay.getObjectByName('flood-leaks-marks')).toBeUndefined();
    expect(r.stamp().fill?.leaks).toEqual([]);
  });

  it('the marks go when the fill tools are put down', async () => {
    const r = rig({ answer: () => ({ ok: false, code: 'flood_leaks', message: 'leaks', leaks: [{ at: [1, 1, 1], kind: 'world', cells: 1 }] }) });
    r.tool.arm(arm({ fill: FILL }));
    await fillDrag(r, 6.2, 8.2, 0, 1);
    r.tool.pointerUp(r.ev(r.screen(6.2, 0, 8.2)));
    await flush();
    expect(r.overlay.getObjectByName('flood-leaks-marks')).toBeDefined();
    expect(r.refused.at(-1)).toMatch(/leaks out of the world at 1 place/);
    r.tool.arm(arm({ kind: 'dig', uses: ['size', 'spacing'] }));
    expect(r.overlay.getObjectByName('flood-leaks-marks')).toBeUndefined();
  });

  it('a drain sends air and no fade; a blocked seed and a fill that changes nothing are said, without marks', async () => {
    let code = 'flood_blocked';
    const r = rig({ answer: () => ({ ok: false, code, message: 'the flood\'s start cell is not open to it' }) });
    r.tool.arm(arm({ fill: { ...FILL, kind: 'drain', material: null } }));
    await fillDrag(r, 6.2, 8.2, 0, 1);
    r.tool.pointerUp(r.ev(r.screen(6.2, 0, 8.2)));
    await flush();
    const cmd = canonicalEditCommand(r.sent[0]![1]['command']) as FloodEdit;
    expect(cmd.value).toEqual({ material: 0, role: 0 });
    expect(cmd.fade).toBeUndefined();
    expect(cmd.level).toBe(4);
    expect(r.refused.at(-1)).toBe('The drain: the flood\'s start cell is not open to it');
    expect(r.overlay.getObjectByName('flood-leaks-marks')).toBeUndefined();
    code = 'no_change';
    await fillDrag(r, 6.2, 8.2, 0, 1);
    r.tool.pointerUp(r.ev(r.screen(6.2, 0, 8.2)));
    await flush();
    expect(r.refused.at(-1)).toMatch(/^The drain changed nothing/);
  });

  it('water makes a water body at the click: one createEntity with the seed, the level and the liquid, and no voxel stroke', async () => {
    const r = rig({ answer: () => ({ ok: true, createdId: 'e-lake' }) });
    r.tool.arm(arm({ fill: { ...FILL, kind: 'water', material: 30, depthM: 1.5 } }));
    await fillDrag(r, 6.2, 8.2, 0, 1);
    r.tool.pointerUp(r.ev(r.screen(6.2, 0, 8.2)));
    await flush();
    expect(r.strokes).toEqual([]);
    expect(r.sent).toEqual([['createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Water', transform: { position: [6.25, 0.25, 8.25] }, components: { waterBody: { world: 'yard', level: 1.5, material: 30 } } }]]);
    expect(r.made).toEqual([['water', 'e-lake']]);
    expect(r.depths).toEqual([1.5]);
  });

  it('with no material picked a fog fill and water say so and begin nothing; Esc drops a fill in flight', async () => {
    const r = rig();
    for (const fill of [{ ...FILL, material: null }, { ...FILL, kind: 'water' as const, material: null }]) {
      r.tool.arm(arm({ fill }));
      const p = r.screen(6.2, 0, 8.2);
      r.tool.pointerMove(r.ev(p));
      await flush();
      expect(r.tool.pointerDown(r.ev(p))).toBe('consume');
      expect(r.tool.pointerUp(r.ev(p))).toBe(false);
    }
    expect(r.refused).toEqual(['Fog needs a gas material: pick one in the palette, or make one.', 'Water needs a liquid material: pick one in the palette, or make one.']);
    r.tool.arm(arm({ fill: FILL }));
    await fillDrag(r, 6.2, 8.2, 30);
    expect(r.tool.cancel()).toBe(true);
    r.tool.pointerUp(r.ev(r.screen(6.2, 0, 8.2)));
    await flush();
    expect(r.sent).toEqual([]);
    expect(r.stamp().fill?.last).toEqual({ fill: 'cancelled', ok: false });
  });

  it('the spline entry: a drag from a point to another makes one spline object with its voxels preset and hands it over; a click lays nothing', async () => {
    const r = rig({ answer: () => ({ ok: true, createdId: 'e-road' }) });
    const spline = { kind: 'road', material: 7, bed: { material: 7, depth: 1 } } as const;
    r.tool.arm(arm({ fill: { ...FILL, kind: 'spline', material: null, spline } }));
    const a = r.screen(2.2, 0, 8.2);
    r.tool.pointerMove(r.ev(a));
    await flush();
    expect(r.tool.pointerDown(r.ev(a))).toBe('capture');
    for (const x of [4.2, 8.2, 12.2]) {
      r.tool.pointerMove(r.ev(r.screen(x, 0, 10.2)));
      await flush();
    }
    r.tool.pointerUp(r.ev(r.screen(12.2, 0, 10.2)));
    await flush();
    expect(r.sent).toEqual([['createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Road', transform: { position: [2.25, 0, 8.25] }, components: { spline: { points: [{ at: [0, 0, 0] }, { at: [10, 0, 2] }], width: 4, voxels: spline } } }]]);
    expect(r.made).toEqual([['spline', 'e-road']]);
    expect(r.strokes).toEqual([]);
    // A press and a release in place: no stretch, nothing sent, said why.
    r.tool.pointerMove(r.ev(a));
    await flush();
    r.tool.pointerDown(r.ev(a));
    r.tool.pointerUp(r.ev(a));
    await flush();
    expect(r.sent.length).toBe(1);
    expect(r.refused.at(-1)).toMatch(/^Drag from where it starts/);
    // No material for it: said at the press.
    r.tool.arm(arm({ fill: { ...FILL, kind: 'spline', material: null, spline: null } }));
    expect(r.tool.pointerDown(r.ev(a))).toBe('consume');
    expect(r.refused.at(-1)).toMatch(/^No voxel material for it/);
  });
});

describe('the fog brush on the Paint rail', () => {
  const GAS = { material: 40, role: VOXEL_ROLE.gas, wetness: 0 };
  /** A drag along the ground from x0 to x1 (metres) at z. */
  async function drag(r: ReturnType<typeof rig>, x0: number, x1: number, z: number): Promise<void> {
    r.tool.pointerMove(r.ev(r.screen(x0, 0, z)));
    await flush();
    expect(r.tool.pointerDown(r.ev(r.screen(x0, 0, z)))).toBe('capture');
    for (let x = x0 + 0.5; x <= x1; x += 0.5) {
      r.tool.pointerMove(r.ev(r.screen(x, 0, z)));
      await flush();
    }
    r.tool.pointerUp(r.ev(r.screen(x1, 0, z)));
    await flush();
    await flush();
  }
  const triples = (flat: readonly number[]): [number, number, number][] => Array.from({ length: flat.length / 3 }, (_, k) => [flat[k * 3]!, flat[k * 3 + 1]!, flat[k * 3 + 2]!]);

  it('paint is one set of the open cells under the dabs with the gas at the density: no ground cell, no water cell, the other gas written over', async () => {
    const r = rig();
    store.set({ size: 2.5 });
    r.tool.arm(arm({ kind: 'fog', uses: ['size', 'spacing', 'invert'], voxel: GAS, density: 6 }));
    // From the grass onto the pond (the water begins at x = 10 m).
    await drag(r, 4.2, 12.2, 8.2);
    expect(r.sent).toEqual([]);
    expect(r.strokes.length).toBe(1);
    const cmd = canonicalEditCommand(r.strokes[0]![1]) as SetEdit;
    expect(cmd.kind).toBe('set');
    expect(cmd.voxel).toEqual({ material: 40, role: VOXEL_ROLE.gas, wetness: 0, shape: 6 });
    const cells = triples(cmd.cells);
    expect(cells.length).toBeGreaterThan(100);
    // The dabs sit on the cells over the ground, so the brush's lower half lies in ground and water: none of it is named.
    for (const [x, y, z] of cells) {
      const v = worldValue(x, y, z);
      expect(v === 0 || v === SMOKE, `${x},${y},${z}`).toBe(true);
      expect(y).toBeGreaterThanOrEqual(0);
    }
    expect(cells.some(([x]) => x >= 20)).toBe(true);
    expect(cells.some((c) => c.join() === '9,1,16')).toBe(true);
    expect(r.stamp().last).toMatchObject({ stroke: 'fog', ok: true, cells: cells.length });
  });

  it('erase is one dig of the gas cells under the dabs alone; with no fog under the brush nothing is sent', async () => {
    const r = rig();
    store.set({ size: 2.5 });
    r.tool.arm(arm({ kind: 'fog-erase', uses: ['size', 'spacing', 'invert'], voxel: GAS }));
    await drag(r, 3.2, 6.2, 8.2);
    expect(r.strokes.length).toBe(1);
    const cmd = canonicalEditCommand(r.strokes[0]![1]) as DigEdit;
    expect(cmd).toMatchObject({ kind: 'dig', cells: [9, 1, 16] });
    expect(valueRole(worldValue(9, 1, 16))).toBe(VOXEL_ROLE.gas);
    await drag(r, 14.2, 16.2, 2.2);
    expect(r.strokes.length).toBe(1);
    expect(r.refused.at(-1)).toBe('No fog under the brush.');
    expect(r.stamp().last).toMatchObject({ stroke: 'fog-erase', ok: false, refused: 'nothing' });
  });

  it('smooth is the brush\'s smooth with the gas as its voxel (so it relaxes that gas and no ground)', async () => {
    const r = rig();
    r.tool.arm(arm({ kind: 'fog-smooth', uses: ['size', 'spacing'], soft: true, voxel: GAS }));
    await drag(r, 4.2, 8.2, 8.2);
    expect(r.strokes.length).toBe(1);
    const cmd = canonicalEditCommand(r.strokes[0]![1]) as BrushEdit;
    expect(cmd).toMatchObject({ kind: 'brush', mode: 'smooth', smooth: true, voxel: GAS });
    // Its dabs sit over the ground, where the fog is.
    expect(cmd.points[1]).toBe(0.5);
  });

  it('cells the view has not read are never written: no read, or none loaded, sends nothing and says so; without a gas picked nothing begins', async () => {
    for (const cells of ['none', 'unloaded'] as const) {
      const r = rig({ cells });
      r.tool.arm(arm({ kind: 'fog', uses: ['size', 'spacing'], voxel: GAS, density: 6 }));
      await drag(r, 4.2, 6.2, 8.2);
      expect(r.strokes, cells).toEqual([]);
      expect(r.refused.length, cells).toBe(1);
    }
    const r = rig();
    r.tool.arm(arm({ kind: 'fog', uses: ['size', 'spacing'], voxel: null }));
    const p = r.screen(4.2, 0, 8.2);
    r.tool.pointerMove(r.ev(p));
    await flush();
    expect(r.tool.pointerDown(r.ev(p))).toBe('consume');
    expect(r.refused).toEqual(['Fog needs a gas material: pick one in the palette.']);
  });
});
