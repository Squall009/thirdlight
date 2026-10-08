/**
 * Rooms and runs (project-model): two rooms beside each other make the wall
 * they share once (its far face in the other room's rows, a door on it cut
 * through the one wall and both rooms' trims), outside presets dress the
 * outer faces, storeys stack with floors cut by holes and by a stair that
 * reaches them, stairs collide step by step, panes go on a second material,
 * pipes cap their ends, and a block layer reads the rooms: wall edges that
 * block walks (doors let them through), room regions, and its wall paint on
 * the generated faces (in the chunks' keys). Browser-free; the draw tool and
 * the pixels are in the block-editor e2e.
 */
import { describe, expect, it } from 'vitest';

import { architectureChunkKeys, architectureColliders, generateArchitecture, generateArchitectureChunk, architectureChunkInput } from '../packages/project-model/src/arch-generate';
import { bridgeHoles, triangulatePolygon } from '../packages/project-model/src/arch-mesh';
import { architecturePaintOf, architectureRoomRegions, architectureWallEdges } from '../packages/project-model/src/arch-room-grid';
import { expandArchitecture, reversedPath } from '../packages/project-model/src/arch-rooms';
import { ARCHITECTURE_STYLE_KIND, ARCHITECTURE_PRESET_KIND } from '../packages/project-model/src/arch-style-kinds';
import { architectureStylesOf } from '../packages/project-model/src/arch-style';
import { ARCHITECTURE_PANE_MATERIAL_SLOT, validateArchitectureComponent, type ArchitectureComponent, type ArchitectureOutline, type ArchitectureSweep } from '../packages/project-model/src/architecture';
import { cellKeyOf } from '../packages/project-model/src/block-grid';
import { encodeWallPaint, wallPointKey, wallPaintSteps } from '../packages/project-model/src/block-wall-paint';
import type { ModelErrorV2 } from '../packages/project-model/src/errors';
import { defaultTrimSheet } from '../packages/project-model/src/trim-sheet';

const SHEETS = { '*': defaultTrimSheet() };
const ORIGIN = [0, 0, 0];
const STARTERS = architectureStylesOf([]);

const box = (x0: number, z0: number, x1: number, z1: number, y = 0): [number, number, number][] => [
  [x0, y, z0],
  [x1, y, z0],
  [x1, y, z1],
  [x0, y, z1],
];
const room = (id: string, pts: [number, number, number][], extra: Partial<ArchitectureOutline> = {}): ArchitectureOutline => ({ id, preset: 'starter-room', path: { points: pts, closed: true }, ...extra });
/** Two 4 m rooms side by side (x 0-4 and 4-8), B's door on the wall they share (14.5 m along B: its last side, z 1-2). */
const twoRooms = (extra: Partial<ArchitectureOutline> = {}): ArchitectureComponent => ({
  elements: [],
  outlines: [room('a', box(0, 0, 4, 4)), room('b', box(4, 0, 8, 4), { openings: [{ id: 'door', at: 14.5, width: 1, bottom: 0, top: 2.1 }], ...extra })],
});
const walls = (c: ArchitectureComponent): ArchitectureSweep[] => c.elements.filter((e): e is ArchitectureSweep => e.kind === 'sweep' && e.wall === true);
/** Whether a path runs along the line x = 4 between z 0 and 4 (one of its segments). */
const onSharedLine = (e: ArchitectureSweep): boolean => {
  const p = e.path.points;
  const segs = e.path.closed === true ? p.length : p.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % p.length]!;
    if (Math.abs(a[0] - 4) < 1e-6 && Math.abs(b[0] - 4) < 1e-6 && Math.abs(a[2] - b[2]) > 1) return true;
  }
  return false;
};

describe('rooms', () => {
  it('the new fields validate; a stair that does not rise is refused', () => {
    const ok: ArchitectureComponent = {
      elements: [],
      layer: 'floor',
      outlines: [
        room('a', box(0, 0, 4, 4), { outside: 'starter-room-tall', storeys: 2, storeyHeight: 3.2, holes: [{ storey: 1, path: { points: box(1, 1, 2, 2), closed: true } }], stairs: [{ id: 's', from: [3, 0, 0.5], to: [3, 3.2, 3.5], width: 1 }], openings: [{ id: 'w', at: 2, width: 1, bottom: 1, top: 2, storey: 1, pane: true }] }),
      ],
    };
    const errors: ModelErrorV2[] = [];
    validateArchitectureComponent(ok, '/a', errors);
    expect(errors).toEqual([]);
    const bad: ArchitectureComponent = { elements: [], outlines: [room('a', box(0, 0, 4, 4), { stairs: [{ id: 's', from: [3, 0, 0], to: [3, 0, 3], width: 1 }], storeys: 0 })] };
    validateArchitectureComponent(bad, '/a', errors);
    expect(errors.map((e) => e.path)).toEqual(['/a/outlines/0/storeys', '/a/outlines/0/stairs/0/to']);
  });

  it('a wall two rooms share is made once, by the first; the other stops at its face; a door on it is cut through it and both rooms\' trims', () => {
    const x = expandArchitecture(twoRooms(), ORIGIN, STARTERS);
    expect(x.problems).toEqual([]);
    const ws = walls(x.component);
    // A's wall closed round its room, B's an open run round the other three sides.
    expect(ws.map((w) => w.id)).toEqual([expect.stringMatching(/^a-/), expect.stringMatching(/^b-.*-r0$/)]);
    expect(ws.filter(onSharedLine).map((w) => w.id)).toEqual([ws[0]!.id]);
    const run = ws[1]!;
    expect(run.path.closed).toBeUndefined();
    // The run stops at A's face (half its 0.2 m wall past the line).
    expect(run.path.points[0]).toEqual([4.1, 0, 0]);
    expect(run.path.points[run.path.points.length - 1]).toEqual([4.1, 0, 4]);
    // B's door is in A's wall (5.5 m along A: on its second side), framed both sides; B's run has no door.
    expect(ws[0]!.openings?.map((o) => [o.at, o.frameSides])).toEqual([[5.5, 'both']]);
    expect(run.openings).toBeUndefined();
    // Both rooms' baseboards are cut by the door (a moulding inset from the walls takes it at its nearest point).
    const cutTrims = x.component.elements.filter((e) => e.kind === 'sweep' && e.wall !== true && (e.openings ?? []).length > 0);
    expect(cutTrims.map((e) => e.id.slice(0, 1)).sort()).toEqual(['a', 'b']);
    // One box collider stack along the shared line (A's), cut round the door.
    const boxes = architectureColliders(x.component, {}, { vertices: 1000, triangles: 1000 }).filter((c) => c.kind === 'box' && Math.abs(c.center[0] - 4) < 0.01);
    expect(boxes.map((b) => b.id.split(':')[0]!.slice(0, 1))).toEqual(['a', 'a', 'a']);
    const chunks = generateArchitecture(x.component, SHEETS);
    expect(chunks.flatMap((c) => c.problems)).toEqual([]);
    // One draw per chunk per material: the rooms' walls, trims and fills are one mesh.
    for (const c of chunks) expect(c.meshes.length).toBeLessThanOrEqual(1);
  });

  it('the shared face wears the other room\'s inside rows; an outside preset dresses the outer faces and runs its trims along the open sides', () => {
    // A style whose wall wears "column" inside and "frame" outside, and a preset of it.
    const wallStyle = (inside: string): { graphId: string; kind: string; graph: { nodes: unknown[]; edges: unknown[] } } => ({
      graphId: `wall-${inside}`,
      kind: ARCHITECTURE_STYLE_KIND,
      graph: {
        nodes: [
          { id: 'outline', type: 'outline', position: [0, 0] },
          { id: 'wp', type: 'wall', position: [0, 0], data: { inside, outside: 'frame', lower: inside, dado: 0 } },
          { id: 'w', type: 'sweep', position: [0, 0], data: { wall: true, openings: true } },
          { id: 'bp', type: 'band', position: [0, 0], data: { slot: 'baseboard' } },
          { id: 'plinth', type: 'sweep', position: [0, 0] },
          { id: 'out', type: 'output', position: [0, 0] },
        ],
        edges: [
          { id: 'e1', from: { node: 'outline', port: 'path' }, to: { node: 'w', port: 'path' } },
          { id: 'e2', from: { node: 'wp', port: 'profile' }, to: { node: 'w', port: 'profile' } },
          { id: 'e3', from: { node: 'outline', port: 'path' }, to: { node: 'plinth', port: 'path' } },
          { id: 'e4', from: { node: 'bp', port: 'profile' }, to: { node: 'plinth', port: 'profile' } },
          { id: 'e5', from: { node: 'w', port: 'element' }, to: { node: 'out', port: 'elements' } },
          { id: 'e6', from: { node: 'plinth', port: 'element' }, to: { node: 'out', port: 'elements' } },
        ],
      },
    });
    const preset = (id: string, style: string): { graphId: string; kind: string; graph: { nodes: unknown[]; edges: unknown[] } } => ({ graphId: id, kind: ARCHITECTURE_PRESET_KIND, graph: { nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style, base: '', sheet: '' } }], edges: [] } });
    const table = architectureStylesOf([wallStyle('column'), wallStyle('crown'), preset('p-column', 'wall-column'), preset('p-crown', 'wall-crown')] as never);
    const c: ArchitectureComponent = { elements: [], outlines: [room('a', box(0, 0, 4, 4), { preset: 'p-column' }), room('b', box(4, 0, 8, 4), { preset: 'p-crown', outside: 'p-column' })] };
    const x = expandArchitecture(c, ORIGIN, table);
    expect(x.problems).toEqual([]);
    const [a, b] = walls(x.component);
    // A's wall: "frame" outside, but along the shared side its outer face wears B's inside row ("crown").
    const aProfile = x.component.profiles![a!.profile]!;
    expect(aProfile.slots).toContain('frame');
    expect(Object.values(a!.segmentSlots ?? {})).toEqual([aProfile.slots.map((s) => (s === 'frame' ? 'crown' : s))]);
    // B's outer faces wear its outside preset's inside row ("column"), not its own "frame".
    const bProfile = x.component.profiles![b!.profile]!;
    expect(bProfile.slots).not.toContain('frame');
    expect(bProfile.slots.filter((s) => s === 'column').length).toBeGreaterThan(0);
    // The outside preset's plinth runs along B's three open sides, outside (reversed: inside on the left of B's travel).
    const plinths = x.component.elements.filter((e) => e.id.startsWith('b-x'));
    expect(plinths.length).toBe(1);
    expect(plinths[0]!.path.points.map((p) => [p[0], p[2]])).toEqual([[4, 4], [8, 4], [8, 0], [4, 0]]);
  });

  it('storeys stack, floors are cut by holes and by the stair reaching them, and the stair collides step by step', () => {
    const c: ArchitectureComponent = {
      elements: [],
      outlines: [room('a', box(0, 0, 6, 4), { storeys: 2, holes: [{ storey: 1, path: { points: box(0.5, 0.5, 1.5, 1.5), closed: true } }], stairs: [{ id: 'up', from: [4.5, 0, 0.5], to: [4.5, 3, 3.5], width: 1, steps: 15 }] })],
    };
    const x = expandArchitecture(c, ORIGIN, STARTERS);
    expect(x.problems).toEqual([]);
    expect(x.rooms.map((r) => [r.id, r.floor, r.top])).toEqual([
      ['a', 0, 3],
      ['a-s1', 3, 6],
    ]);
    const floors = x.component.elements.filter((e) => e.kind === 'fill' && e.shape === 'flat' && (e.face ?? 'up') === 'up');
    expect(floors.map((f) => (f.kind === 'fill' ? (f.holes ?? []).length : -1))).toEqual([0, 2]);
    const stair = x.component.elements.find((e) => e.id === 'a-stair-up') as ArchitectureSweep;
    expect(stair.stepped).toBe(true);
    expect(x.component.profiles![stair.profile]!.cap).toBe('lower_wall');
    const steps = architectureColliders(x.component, {}, { vertices: 1000, triangles: 1000 }).filter((k) => k.id.startsWith('a-stair-up:'));
    expect(steps.length).toBe(15);
    // The top step's box reaches the upper floor.
    const tops = steps.map((k) => (k.kind === 'box' ? k.center[1] + k.half[1] : 0));
    expect(Math.max(...tops)).toBeCloseTo(3, 6);
    const chunks = generateArchitecture(x.component, SHEETS);
    expect(chunks.flatMap((k) => k.problems)).toEqual([]);
  });

  it('a hole is bridged into its outline: the triangles cover the outline less the hole', () => {
    const outer = [0, 0, 6, 0, 6, 4, 0, 4];
    const poly = bridgeHoles(outer, [[1, 1, 2, 1, 2, 2, 1, 2], [4, 1, 5, 1, 5, 3, 4, 3]]);
    const tris = triangulatePolygon(poly);
    let area = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t]!, tris[t + 1]!, tris[t + 2]!];
      area += Math.abs((poly[b * 2]! - poly[a * 2]!) * (poly[c * 2 + 1]! - poly[a * 2 + 1]!) - (poly[c * 2]! - poly[a * 2]!) * (poly[b * 2 + 1]! - poly[a * 2 + 1]!)) / 2;
    }
    expect(area).toBeCloseTo(24 - 1 - 2, 9);
  });

  it('a pane goes on the glass material slot (a second draw); a pipe\'s ends are capped', () => {
    const c: ArchitectureComponent = {
      elements: [],
      outlines: [room('a', box(0, 0, 4, 4), { openings: [{ id: 'w', at: 2, width: 1.2, bottom: 0.9, top: 2, pane: true }] }), { id: 'pipe', preset: 'starter-pipe', path: { points: [[0, 0, 6], [4, 0, 6]] } }],
    };
    const x = expandArchitecture(c, ORIGIN, STARTERS);
    const chunks = generateArchitecture(x.component, SHEETS);
    expect(chunks.flatMap((k) => k.problems)).toEqual([]);
    const mats = chunks.flatMap((k) => k.meshes.map((m) => m.material));
    expect(mats.sort()).toEqual(['architecture', ARCHITECTURE_PANE_MATERIAL_SLOT]);
    // The pipe's caps: faces looking along the pipe at both ends.
    const pipe = generateArchitecture({ ...x.component, elements: x.component.elements.filter((e) => e.id.startsWith('pipe')) }, SHEETS);
    const n = pipe.flatMap((k) => k.meshes).map((m) => m.mesh.normals);
    const along = n.reduce((count, a) => {
      for (let i = 0; i < a.length; i += 3) if (Math.abs(Math.abs(a[i]!) - 1) < 1e-6) count++;
      return count;
    }, 0);
    expect(along).toBeGreaterThan(0);
  });

  it('a reversed path walks the other way with its arcs bulging the same way', () => {
    const p = { points: [[0, 0, 0], [2, 0, 0], [2, 0, 2]] as [number, number, number][], closed: true, bulges: [0.5, 0, -0.25] };
    expect(reversedPath(p)).toEqual({ points: [[2, 0, 2], [2, 0, 0], [0, 0, 0]], closed: true, bulges: [-0, -0.5, 0.25] });
  });
});

describe('rooms on a block layer', () => {
  it('cell-aligned walls block the edges they stand on; the door lets passage through; rooms are regions', () => {
    const x = expandArchitecture(twoRooms(), ORIGIN, STARTERS);
    // The object stands 1 m above the layer's origin and 2 cells in: layer = object + offset.
    const offset = [2, 1, 2];
    const edges = architectureWallEdges(x.component, offset, [1, 1, 1]);
    const at = (x0: number, y: number, z: number, axis: number): boolean | undefined => edges.get(cellKeyOf(x0, y, z) * 2 + axis);
    // The shared wall: the line x = 6 (layer), cells z 2..5, rows 1..3 (a 3 m wall standing on row 1).
    for (const z of [2, 4, 5]) for (const y of [1, 2, 3]) expect(at(6, y, z, 0)).toBe(true);
    // The door (1 m wide, 2.1 m tall, z 1-2 of the object): cell z 3 open in rows 1 and 2, the lintel row closed.
    expect([at(6, 1, 3, 0), at(6, 2, 3, 0), at(6, 3, 3, 0)]).toEqual([false, false, true]);
    expect(at(6, 0, 3, 0)).toBeUndefined();
    expect(at(6, 4, 3, 0)).toBeUndefined();
    // The rooms' outer sides on the z lines.
    expect(at(3, 1, 2, 1)).toBe(true);
    expect(at(9, 2, 6, 1)).toBe(true);
    const regions = architectureRoomRegions(x.rooms, offset, [1, 1, 1]);
    expect(regions.map((r) => r.regionId)).toEqual(['a', 'b']);
    expect(regions[0]!.boxes).toEqual([2, 3, 4, 5].map((z) => [2, 1, z, 6, 4, z + 1]));
  });

  it('a room on a layer lays its ground floor just over the cells (not in their plane); upper floors stay', () => {
    const c: ArchitectureComponent = { elements: [], layer: 'floor', outlines: [room('a', box(0, 0, 4, 4), { storeys: 2 })] };
    const x = expandArchitecture(c, ORIGIN, STARTERS);
    const floors = x.component.elements.filter((e) => e.kind === 'fill' && e.shape === 'flat' && (e.face ?? 'up') === 'up');
    expect(floors.map((f) => (f.kind === 'fill' ? (f.height ?? 0) : NaN))).toEqual([0.01, 0]);
    const off = expandArchitecture({ ...c, layer: undefined } as ArchitectureComponent, ORIGIN, STARTERS);
    expect(off.component.elements.filter((e) => e.kind === 'fill' && e.shape === 'flat' && (e.face ?? 'up') === 'up').map((f) => (f.kind === 'fill' ? (f.height ?? 0) : NaN))).toEqual([0, 0]);
  });

  it('the layer\'s wall paint shows on the generated faces (grime, wetness), in the chunks\' keys, and survives regeneration', () => {
    const c = twoRooms();
    // Paint the layer's wall points on the plane x = 0 (A's west wall), side 1 (the columns x = 0's −x sides), rows 0-2.
    const st = wallPaintSteps([1, 1, 1]);
    const points = new Map<number, Uint8Array>();
    for (let z = 0; z < 4; z++) for (let j = 0; j <= st.along; j++) for (let k = 0; k <= 3 * st.up; k++) points.set(wallPointKey(0, z, 1, j, k), Uint8Array.from([0, 0, 255, 0, 200]));
    const layer = { cellSize: [1, 1, 1], wallPaint: true };
    const paint = architecturePaintOf(layer, [{ cx: 0, cz: 0, wallPaint: encodeWallPaint(points)! }], [0, 0, 0], [0, 0, 0])!;
    expect(paint).not.toBeNull();
    const plain = expandArchitecture(c, ORIGIN, STARTERS).component;
    const painted = expandArchitecture(c, ORIGIN, STARTERS, { paint }).component;
    const kPlain = architectureChunkKeys(plain, SHEETS);
    const kPainted = architectureChunkKeys(painted, SHEETS);
    expect(kPainted.get('0,0')!.key).not.toBe(kPlain.get('0,0')!.key);
    const k = kPainted.get('0,0')!;
    const chunk = generateArchitectureChunk(architectureChunkInput(painted, k), SHEETS, 0, 0);
    const m = chunk.meshes[0]!.mesh;
    let grimy = 0;
    let wet = 0;
    for (let i = 0; i < m.positions.length / 3; i++) {
      const [x, y, z] = [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
      const g = m.colors[i * 4 + 1]!;
      // Only the outer face of A's west wall (x = -0.1, looking −x; its foot moulding too), under 3 m, is painted.
      if (g > 0) {
        expect(x < 0 && m.normals[i * 3]! < -0.5 && z >= -0.2 && z <= 4.2 && y <= 3 + 1e-6).toBe(true);
        grimy++;
        if (m.colors[i * 4 + 2]! > 150) wet++;
      }
    }
    expect(grimy).toBeGreaterThan(0);
    expect(wet).toBeGreaterThan(0);
    // The same bytes made again (a worker, the page, an export).
    const again = generateArchitectureChunk(architectureChunkInput(painted, k), SHEETS, 0, 0);
    expect(Array.from(again.meshes[0]!.mesh.colors)).toEqual(Array.from(m.colors));
  });
});
