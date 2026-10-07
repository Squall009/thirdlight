/**
 * Block-layer cut-aways in the block view: a roof region's triangles are
 * drawn as meshes of their own (the walls' tops under it and the floor stay
 * in the chunk's other meshes, the edge pieces on its outline go with it);
 * the subject under the roof cuts it at once on the first frame, walking out
 * fades it back in through a dithered copy with one variant material, and a
 * cut mesh stays in the shadow cameras' view with its own material (the
 * cached static shadow map has nothing to draw again).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, cutawayZones, type BlockLayerComponent, type BlockType } from '@thirdlight/runtime';

import { BlockLayerView } from './block-layers';
import { CUTAWAY_COPY_KEY, CUTAWAY_LAYER, shadowSeesCutaways, splitByCutaway } from './block-cutaway-view';
import { DrawnCasters, STATIC_CASTER_KEY } from './shadow-casters';

const LAYER: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 8, 16] }, cutaway: { regions: [{ region: 'roof' }], fade: 0.5 } };
const TYPES: BlockType[] = [
  { blockId: 'floor', name: 'Floor', variants: [{ color: '#808080' }], shape: 'full' },
  { blockId: 'wall', name: 'Wall', variants: [{ color: '#a0a0a0' }], shape: 'full' },
  { blockId: 'roof', name: 'Roof', variants: [{ color: '#c04040' }], shape: 'full' },
  { blockId: 'rail', name: 'Rail', variants: [{ color: '#40c040' }], shape: 'full', placement: 'edge' },
];
/** The roof: one row over columns 4-9, a row above the walls' tops (rows 1-3), so those tops are drawn. */
const ROOF = [4, 5, 4, 10, 6, 10];

function layerData(): unknown {
  const g = new BlockGrid(LAYER);
  const types = new Map(TYPES.map((t) => [t.blockId, t]));
  applyBlockEdits(
    g,
    [
      { kind: 'fill', box: [0, 0, 0, 16, 1, 16], cell: { block: 'floor' } },
      { kind: 'fill', box: [4, 1, 4, 10, 4, 5], cell: { block: 'wall' } },
      { kind: 'fill', box: [4, 1, 9, 10, 4, 10], cell: { block: 'wall' } },
      { kind: 'fill', box: ROOF as never, cell: { block: 'roof' } },
      // A rail on the roof's +x outline (the grid line x = 10), and one a line further out.
      { kind: 'edges', at: [10, 5, 6, 0, 10, 5, 7, 0, 12, 5, 6, 0], edge: { block: 'rail' } },
      { kind: 'region', regionId: 'roof', op: 'set', boxes: [ROOF] },
    ],
    { types, stamps: new Map() },
  );
  return { entityId: 'house', chunks: g.chunkKeys().map((k) => g.encodeChunk(k)), regions: [{ regionId: 'roof', boxes: [ROOF] }] };
}

function built(component: BlockLayerComponent = LAYER): BlockLayerView {
  const v = new BlockLayerView();
  v.setTypes(TYPES);
  v.setLayer('house', component, [0, 0, 0], layerData() as never);
  v.update();
  return v;
}

/** Every triangle of the chunk meshes: its centre and normal, and whether its mesh is a cut-away's. */
function triangles(v: BlockLayerView): { y: number; x: number; ny: number; cut: boolean; mesh: THREE.Mesh }[] {
  const out: { y: number; x: number; ny: number; cut: boolean; mesh: THREE.Mesh }[] = [];
  const cut = new Set(cutMeshes(v));
  for (const m of v.meshes()) {
    const pos = m.geometry.getAttribute('position');
    const idx = m.geometry.getIndex()!;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(pos, idx.getX(i));
      b.fromBufferAttribute(pos, idx.getX(i + 1));
      c.fromBufferAttribute(pos, idx.getX(i + 2));
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
      out.push({ x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, ny: n.y, cut: cut.has(m), mesh: m });
    }
  }
  return out;
}

/** The meshes a cut zone has moved off the view's camera layer. */
function cutMeshes(v: BlockLayerView): THREE.Mesh[] {
  return v.meshes().filter((m) => m.layers.isEnabled(CUTAWAY_LAYER));
}

describe('block view: cut-aways', () => {
  it('splits the roof (and the rail on its outline) into meshes of their own, losing no triangle', () => {
    const plain = built({ ...LAYER, cutaway: undefined } as never);
    const v = built();
    // Cut it once so the cut meshes can be told apart by their camera layer.
    v.updateCutaways(0, new THREE.Vector3(7, 1.5, 7));
    const all = triangles(v);
    expect(all.length).toBe(triangles(plain).length);
    const cut = all.filter((t) => t.cut);
    expect(cut.length).toBeGreaterThan(0);
    // Every cut triangle is the roof row's or a rail's on the outline line x = 10 (none of the rail at x = 12).
    for (const t of cut) {
      expect(t.y).toBeGreaterThanOrEqual(5 - 1e-6);
      expect(t.x).toBeLessThan(10.2);
    }
    expect(cut.some((t) => t.x > 9.9)).toBe(true);
    // The walls' tops (y = 4, facing up, right under the roof row) and the floor stay drawn.
    expect(all.some((t) => !t.cut && Math.abs(t.y - 4) < 1e-6 && t.ny > 0.99)).toBe(true);
    expect(all.some((t) => t.cut && Math.abs(t.y - 5) < 1e-6 && t.ny < -0.99)).toBe(true);
    expect(all.filter((t) => !t.cut && t.x > 11.9 && t.y > 5)).not.toHaveLength(0);
    expect(v.diagnostics().cutaway).toEqual(expect.objectContaining({ zones: 1, cut: 1, fading: 0 }));
    expect(v.diagnostics().meshes).toBeGreaterThan(plain.diagnostics().meshes);
  });

  it('a roof lying on the walls keeps the faces between them: the wall tops show when it is cut', () => {
    const onWalls = [4, 4, 4, 10, 5, 10];
    const g = new BlockGrid(LAYER);
    const types = new Map(TYPES.map((t) => [t.blockId, t]));
    applyBlockEdits(g, [{ kind: 'fill', box: [4, 1, 4, 10, 4, 5], cell: { block: 'wall' } }, { kind: 'fill', box: onWalls as never, cell: { block: 'roof' } }], { types, stamps: new Map() });
    const data = { entityId: 'house', chunks: g.chunkKeys().map((k) => g.encodeChunk(k)), regions: [{ regionId: 'roof', boxes: [onWalls] }] };
    const tops = (component: BlockLayerComponent): number => {
      const v = new BlockLayerView();
      v.setTypes(TYPES);
      v.setLayer('house', component, [0, 0, 0], data as never);
      v.update();
      v.updateCutaways(0, new THREE.Vector3(7, 1.5, 7));
      return triangles(v).filter((t) => !t.cut && Math.abs(t.y - 4) < 1e-6 && t.ny > 0.99).length;
    };
    // Hidden under the roof without a cut-away; there (one wall row of 6 cells, 2 triangles each) with one.
    expect(tops({ ...LAYER, cutaway: undefined } as never)).toBe(0);
    expect(tops(LAYER)).toBe(12);
  });

  it('the subject under the roof cuts it at once; walking out fades it back through one dithered variant', () => {
    const v = built();
    const inside = new THREE.Vector3(7, 1.5, 7);
    expect(v.updateCutaways(0, inside)).toBe(false);
    const cut = v.meshes().filter((m) => m.layers.isEnabled(CUTAWAY_LAYER));
    expect(cut.length).toBeGreaterThan(0);
    // Out of the view's camera layer, in the shadow cameras'.
    const view = new THREE.PerspectiveCamera();
    const shadow = new THREE.OrthographicCamera();
    shadowSeesCutaways(shadow);
    for (const m of cut) {
      expect(m.layers.test(view.layers)).toBe(false);
      expect(m.layers.test(shadow.layers)).toBe(true);
      expect(m.children).toHaveLength(0);
    }
    // Static casters as the host lists them (block chunks cast into the cached static map).
    const drawn = new DrawnCasters();
    for (const m of cut) {
      m.userData[STATIC_CASTER_KEY] = true;
      drawn.add(m);
    }
    const materials = cut.map((m) => m.material);

    // Out from under it: half way after a quarter second (fade 0.5 s), drawn by a copy.
    const outside = new THREE.Vector3(13.5, 1.5, 13.5);
    expect(v.updateCutaways(0.25, outside)).toBe(true);
    const copies = cut.map((m) => m.children[0] as THREE.Mesh);
    for (const c of copies) {
      expect(c.userData[CUTAWAY_COPY_KEY]).toBe(true);
      expect(c.castShadow).toBe(false);
      expect((c.material as { maskNode?: unknown }).maskNode).toBeTruthy();
    }
    expect(v.diagnostics().cutaway).toEqual(expect.objectContaining({ fading: 1 }));
    // Counts, picks and bakes pass over the copies.
    expect(v.meshes()).toHaveLength(built().meshes().length);
    const variant = copies[0]!.material;
    expect(v.updateCutaways(0.1, outside)).toBe(true);
    expect(cut[0]!.children[0]).toBe(copies[0]);
    expect(copies[0]!.material).toBe(variant);
    expect(v.updateCutaways(0.2, outside)).toBe(false);
    for (const m of cut) {
      expect(m.layers.test(view.layers)).toBe(true);
      expect(m.children).toHaveLength(0);
    }
    // In again: the same variant serves the next fade (none made per frame or per fade).
    v.updateCutaways(0.1, inside);
    expect(cut[0]!.children[0]).toBeDefined();
    expect((cut[0]!.children[0] as THREE.Mesh).material).toBe(variant);
    // The static shadow map's casters kept their material all along: nothing to draw again.
    expect(cut.map((m) => m.material)).toEqual(materials);
    expect(drawn.changed()).toBe(false);
  });

  it('the host and the game force zones over the subject (the host first)', () => {
    const v = built();
    v.updateCutaways(0, null);
    const roofMeshes = (): THREE.Mesh[] => v.meshes().filter((m) => m.layers.isEnabled(CUTAWAY_LAYER));
    expect(roofMeshes()).toHaveLength(0);
    v.setGameCutaways([['house', 'roof', true]]);
    v.updateCutaways(1, null);
    expect(roofMeshes().length).toBeGreaterThan(0);
    expect(v.setCutaway('house', 'roof', false)).toBe(true);
    v.updateCutaways(1, null);
    expect(roofMeshes()).toHaveLength(0);
    expect(v.setCutaway('house', 'cellar', true)).toBe(false);
    expect(v.setCutaway('house', 'roof', null)).toBe(true);
    v.updateCutaways(1, null);
    expect(roofMeshes().length).toBeGreaterThan(0);
  });

  it('a height plane splits off every row from it up; a layer without cut-aways is not split', () => {
    const regions = new Map([['roof', [ROOF]]]);
    const zones = cutawayZones({ cutaway: { planes: [3] } }, regions);
    // Two triangles: a floor top at y = 1, and a slab's underside at y = 3.
    const positions = new Float32Array([0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 3, 0, 1, 3, 0, 0, 3, 1]);
    const split = splitByCutaway(positions, new Uint32Array([0, 1, 2, 3, 4, 5]), zones, [1, 1, 1])!;
    expect([...split.base]).toEqual([0, 1, 2]);
    expect(split.cut).toEqual([{ zones: [0], indices: new Uint32Array([3, 4, 5]) }]);
    expect(splitByCutaway(positions, new Uint32Array([0, 1, 2]), zones, [1, 1, 1])).toBeNull();
    expect(splitByCutaway(positions, new Uint32Array([0, 1, 2, 3, 4, 5]), [], [1, 1, 1])).toBeNull();
    expect(built({ cellSize: [1, 1, 1], bounds: LAYER.bounds }).diagnostics().cutaway).toBeUndefined();
  });
});
