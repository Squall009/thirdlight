/**
 * A vertex paint stroke's preview and a paint change drawn in place: which
 * document changes are paint alone, a model's meshes drawing the brush's
 * bytes (drawn alone, then put back), a copy's slot appended to its set's
 * streams, a generated object's grid drawn over its stored paint until the
 * stored paint changes, and paint sampled again onto drawn meshes.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { pathPaintFrame, samplePathPaint, type PathPaintGrid } from '@thirdlight/runtime';

import { batchRefusal, BATCH_KEY } from './batching';
import { meshPaintOf, paintedGeometry, paintStream, PAINT_ATTRIBUTE, PAINT_MESH_KEY } from './vertex-paint-draw';
import { PathPaintOverrides, PathPaintReader, resamplePathPaint } from './vertex-paint-paths-view';
import { copyPreview, modelPreviewMeshes, swapInPreview } from './vertex-paint-preview';
import { paintOnlyChange } from './vertex-paint-update';

const hex = (c: string): string => c.repeat(64);

describe('a paint change is told apart from any other', () => {
  const doc = (components: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 'e', ...extra, components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, ...components } });
  const model = { asset: { assetId: 'rock' } };
  const paintA = { meshes: [{ mesh: 'Rock#0', vertices: 24, positions: '0123456789abcdef', paint: hex('a') }] };
  const paintB = { meshes: [{ mesh: 'Rock#0', vertices: 24, positions: '0123456789abcdef', paint: hex('b') }] };

  it('a model whose vertexPaint alone changed (added, changed, removed) is painted in place', () => {
    expect(paintOnlyChange(doc({ model }), doc({ model, vertexPaint: paintA }))).toBe(true);
    expect(paintOnlyChange(doc({ model, vertexPaint: paintA }), doc({ model, vertexPaint: paintB }))).toBe(true);
    expect(paintOnlyChange(doc({ model, vertexPaint: paintA }), doc({ model }))).toBe(true);
    // Equal by value though another object (a component the projection made again).
    expect(paintOnlyChange(doc({ model, vertexPaint: paintA }), doc({ model: { asset: { assetId: 'rock' } }, vertexPaint: paintB }))).toBe(true);
    // A moved object's document also carries its new transform: transforms reach the adapter on their own.
    expect(paintOnlyChange(doc({ model }), { ...doc({ model, vertexPaint: paintA }), components: { ...doc({ model, vertexPaint: paintA }).components, transform: { position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } })).toBe(true);
  });

  it('anything else is realized again', () => {
    expect(paintOnlyChange(doc({ model, vertexPaint: paintA }), doc({ model: { asset: { assetId: 'tree' } }, vertexPaint: paintB }))).toBe(false);
    expect(paintOnlyChange(doc({ model }), doc({ model, materials: { '*': 'm' } }))).toBe(false);
    expect(paintOnlyChange(doc({ model }), doc({ model }, { static: true }))).toBe(false);
    expect(paintOnlyChange(doc({ model }), doc({ model }, { parentId: 'p' }))).toBe(false);
    expect(paintOnlyChange(undefined, doc({ model }))).toBe(false);
    // A new document equal by value, paint and all: the host wants the object made again (its asset's options or a
    // material changed, which the document does not hold).
    expect(paintOnlyChange(doc({ model, vertexPaint: paintA }), doc({ model, vertexPaint: paintA }))).toBe(false);
    expect(paintOnlyChange(doc({ model }), doc({ model }))).toBe(false);
    // An object that draws no paint (a box) is realized again whatever changed.
    expect(paintOnlyChange(doc({ box: { size: [1, 1, 1] } }), doc({ box: { size: [1, 1, 1] }, vertexPaint: paintA }))).toBe(false);
  });

  it("an instance set's paint alone, not its buffer", () => {
    const inst = { asset: { assetId: 'rock' }, buffer: hex('1'), count: 3 };
    const paint = { copies: hex('c'), painted: 1, slots: 1, meshes: paintA.meshes };
    expect(paintOnlyChange(doc({ instances: inst }), doc({ instances: { ...inst, paint } }))).toBe(true);
    expect(paintOnlyChange(doc({ instances: inst }), doc({ instances: { ...inst, buffer: hex('2'), paint } }))).toBe(false);
  });

  it("generated architecture's and a spline's path paint", () => {
    const architecture = { elements: [], outlines: [] };
    const grids = { paths: [{ path: 'spline', side: 'top', origin: [0, 0], size: [1, 1], paint: hex('d') }] };
    expect(paintOnlyChange(doc({ architecture }), doc({ architecture: { elements: [], outlines: [] }, vertexPaint: grids }))).toBe(true);
    expect(paintOnlyChange(doc({ spline: { points: [] } }), doc({ spline: { points: [] }, vertexPaint: grids }))).toBe(true);
    expect(paintOnlyChange(doc({ spline: { points: [] } }), doc({ spline: { points: [{ at: [0, 0, 0] }] }, vertexPaint: grids }))).toBe(false);
  });
});

/** A model root with one named mesh (a box) at x = 5, batchable. */
function modelRoot(): { root: THREE.Group; mesh: THREE.Mesh } {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.position.set(5, 0, 0);
  mesh.userData[PAINT_MESH_KEY] = 'Box#0';
  mesh.userData[BATCH_KEY] = true;
  root.add(mesh);
  root.updateMatrixWorld(true);
  return { root, mesh };
}

describe("a model's preview", () => {
  it('starts from the paint drawn, draws the brush bytes alone, and puts back what it drew', () => {
    const { root, mesh } = modelRoot();
    const base = mesh.geometry;
    const stored = new Uint8Array(24 * 4).fill(7);
    const painted = paintedGeometry(base, stored);
    mesh.geometry = painted;
    const meshes = modelPreviewMeshes(root);
    expect(meshes).toHaveLength(1);
    const item = meshes[0]!.item;
    expect(item.mesh).toBe('Box#0');
    expect(item.values).toEqual(stored);
    expect(item.values).not.toBe(stored);
    // Its vertices in the world.
    expect(Math.min(...Array.from(item.points).filter((_, i) => i % 3 === 0))).toBeCloseTo(4.5);
    expect(batchRefusal(mesh)).toBeNull();
    const swap = swapInPreview(meshes);
    expect(mesh.geometry).not.toBe(painted);
    expect(meshPaintOf(mesh)).toBe(item.values);
    expect(batchRefusal(mesh)).toBe('vertex paint preview');
    const attr = mesh.geometry.getAttribute(PAINT_ATTRIBUTE) as THREE.BufferAttribute;
    const v0 = attr.version;
    item.values[0] = 255;
    swap.show();
    expect(attr.version).toBeGreaterThan(v0);
    swap.undo();
    expect(mesh.geometry).toBe(painted);
    expect(batchRefusal(mesh)).toBeNull();
  });

  it('an unpainted mesh starts from nothing', () => {
    const { root } = modelRoot();
    expect(modelPreviewMeshes(root)[0]!.item.values.every((v) => v === 0)).toBe(true);
  });
});

describe("a copy's preview", () => {
  it("appends a slot for the copy to every mesh's stream (its paint copied in), the others keep theirs", () => {
    const { root } = modelRoot();
    const run = 24 * 4;
    // Two slots stored: copy 3 in slot 1.
    const pool = new Uint8Array(2 * run);
    pool.fill(9, run, 2 * run);
    const stream = paintStream(pool, 24, 2)!;
    const current = { slotOf: (c: number) => (c === 3 ? 1 : c === 0 ? 0 : -1), stream: (k: string) => (k === 'Box#0' ? stream : undefined) };
    const copyWorld = new THREE.Matrix4().makeTranslation(0, 10, 0);
    const p = copyPreview(root, current, 3, copyWorld)!;
    expect(p.paint.slotOf(3)).toBe(2);
    expect(p.paint.slotOf(0)).toBe(0);
    expect(p.paint.slotOf(7)).toBe(-1);
    const s = p.paint.stream('Box#0')!;
    expect(s.slots).toBe(3);
    const data = s.texture.image.data as Uint8Array;
    expect(Array.from(data.subarray(2 * run, 3 * run)).every((v) => v === 9)).toBe(true);
    // The copy's vertices: the mesh's place in the model, then the copy's.
    expect(Math.abs(p.items[0]!.points[1]! - 10)).toBeCloseTo(0.5);
    expect(p.items[0]!.points[0]).toBeGreaterThan(4);
    p.items[0]!.values.fill(200);
    const v = s.texture.version;
    p.show();
    expect(data[2 * run]).toBe(200);
    expect(data[run]).toBe(9);
    expect(s.texture.version).toBeGreaterThan(v);
    // Made again under a brush already painting: its own arrays are kept.
    const again = copyPreview(root, current, 3, copyWorld, new Map([['Box#0', p.items[0]!.values]]))!;
    expect(again.items[0]!.values).toBe(p.items[0]!.values);
    p.dispose();
    again.dispose();
    stream.dispose();
  });
});

describe("a generated object's preview", () => {
  const spline = { points: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }], width: 2 } as never;
  const frame = pathPaintFrame({ spline }, 'spline')!;
  const storedGrid: PathPaintGrid = { path: 'spline', side: 'top', origin: [0, -4], size: [41, 9], paint: hex('e') };
  const storedBytes = new Uint8Array(41 * 9 * 4).fill(40);

  async function reader(): Promise<PathPaintReader> {
    const r = new PathPaintReader(async () => storedBytes.slice().buffer);
    await new Promise<void>((resolve) => void r.sources({ spline }, [storedGrid], resolve));
    return r;
  }

  it("draws the brush's grid over one side until the stored paint changes after the stroke", async () => {
    const r = await reader();
    const o = new PathPaintOverrides();
    let redraws = 0;
    const p = o.begin('k', 'sig-1', 'spline', 'top', frame, [0, 0, 0], r.grid(storedGrid), () => (redraws += 1));
    expect(p.kind).toBe('path');
    if (p.kind !== 'path') return;
    expect(p.grid!.values).toEqual(storedBytes);
    expect(p.grid!.values).not.toBe(storedBytes);
    const brushGrid = { origin: [0, -4] as [number, number], size: [41, 9] as [number, number], values: new Uint8Array(41 * 9 * 4).fill(250) };
    p.show(brushGrid);
    expect(redraws).toBe(1);
    // The sources drawn: the brush's grid in place of the stored one.
    const sources = r.sources({ spline }, [storedGrid], () => undefined, o.of('k'));
    const out = new Uint8Array(4);
    samplePathPaint(sources as never, [5, 0, 0], [0, 1, 0], out);
    expect(out[0]).toBe(250);
    // Stored paint arriving while the brush paints goes under it.
    expect(o.stored('k', 'sig-0')).toBe(false);
    expect(o.of('k')).toBeDefined();
    let gone = false;
    void p.end(true).then(() => (gone = true));
    expect(o.of('k')).toBeDefined();
    // The stroke's stored paint: the preview gives way.
    expect(o.stored('k', 'sig-2')).toBe(true);
    expect(o.of('k')).toBeUndefined();
    await Promise.resolve();
    expect(gone).toBe(true);
  });

  it('a refused stroke takes it off at once (also after it was kept), and draws the stored paint again', async () => {
    const r = await reader();
    const o = new PathPaintOverrides();
    let redraws = 0;
    const p = o.begin('k', 'sig-1', 'spline', 'top', frame, [0, 0, 0], r.grid(storedGrid), () => (redraws += 1));
    void p.end(true);
    await p.end(false);
    expect(o.of('k')).toBeUndefined();
    expect(redraws).toBe(1);
  });

  it('a second stroke starts from the first one still drawn', () => {
    const o = new PathPaintOverrides();
    const a = o.begin('k', 's', 'spline', 'top', frame, [0, 0, 0], null, () => undefined);
    const g = { origin: [0, 0] as [number, number], size: [1, 1] as [number, number], values: new Uint8Array([1, 2, 3, 4]) };
    a.show(g);
    void a.end(true);
    const b = o.begin('k', 's', 'spline', 'top', frame, [0, 0, 0], null, () => undefined);
    expect(b.kind === 'path' && b.grid?.values).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('paint sampled again onto drawn meshes: rewritten in place, added where there was none, shared by levels', () => {
    const root = new THREE.Group();
    root.position.set(100, 0, 0);
    const lod = new THREE.Group();
    lod.position.set(5, 0, 0);
    root.add(lod);
    const positions = new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3);
    const normals = new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3);
    const near = new THREE.BufferGeometry();
    const far = new THREE.BufferGeometry();
    for (const g of [near, far]) {
      g.setAttribute('position', positions);
      g.setAttribute('normal', normals);
    }
    const a = new THREE.Mesh(near);
    const b = new THREE.Mesh(far);
    lod.add(a, b);
    root.updateMatrixWorld(true);
    const grid = { origin: [0, -4] as [number, number], size: [41, 9] as [number, number], values: new Uint8Array(41 * 9 * 4).fill(128) };
    const sources = [{ frame, grids: { top: grid } }];
    resamplePathPaint(root, [a, b], sources);
    const pa = near.getAttribute(PAINT_ATTRIBUTE) as THREE.BufferAttribute;
    expect(pa).toBeDefined();
    expect(far.getAttribute(PAINT_ATTRIBUTE)).toBe(pa);
    expect((pa.array as Uint8Array)[0]).toBe(128);
    grid.values.fill(30);
    const v = pa.version;
    resamplePathPaint(root, [a, b], sources);
    expect(near.getAttribute(PAINT_ATTRIBUTE)).toBe(pa);
    expect((pa.array as Uint8Array)[0]).toBe(30);
    expect(pa.version).toBeGreaterThan(v);
  });
});
