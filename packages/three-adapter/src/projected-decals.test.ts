/**
 * Projected decals: the table and world-grid index the receiving materials
 * read, and what the material steps build — nothing new without the decals'
 * light (every shader type's and every plain graph's WGSL is what it was
 * before decals; test-wgsl.ts holds the digests), the decal loop in every
 * lit material with it, one program however many decals there are.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { DECAL_CELL_BUDGET } from '@thirdlight/project-model';
import { pageFlagOn } from '@thirdlight/shared';

import { buildDecalIndex, DECAL_ROW_TEXELS, decalRowsAt, packDecalTable, type DecalRow } from './decal-index';
import { createDecalProjectors } from './decal-projectors';
import { digestOf } from './material-graph';
import { createMaterialLibrary, decalSourceOf } from './material-library';
import { withoutAmbientLight } from './node-materials';
import { applyObjectDecalLayers, DECAL_CHANNEL_BITS, DECAL_LAYER_TEST_BIT, DECALS_URL_PARAM, decalVariant, installProjectedDecalSteps, objectDecalLayers, ProjectedDecals, projectedDecalsOf } from './projected-decals';
import { graphDef, libraryScene, PLAIN_GRAPH_WGSL, PLAIN_GRAPHS, settle, SHADER_TYPE_MATERIALS, SHADER_TYPE_WGSL, testTexture, wgslOf, wgslRenderer } from './test-wgsl';

installProjectedDecalSteps();

/** A decal row with a unit box at `at` (identity rotation), drawn in `sortOrder`. */
function row(at: [number, number, number], sortOrder = 0, side = 1): DecalRow {
  return {
    worldToBox: [1 / side, 0, 0, -at[0] / side, 0, 1 / side, 0, -at[1] / side, 0, 0, 1 / side, -at[2] / side],
    min: [at[0] - side / 2, at[1] - side / 2, at[2] - side / 2],
    max: [at[0] + side / 2, at[1] + side / 2, at[2] + side / 2],
    rect: [0, 0, 1, 1],
    layers: [0, -1, -1],
    footprint: 4,
    opacity: [1, 1, 1, 1, 1, 1],
    normalFadeCos: [0, 0.3],
    edgeFade: [0.3, 0.3],
    fadeDistance: 0,
    layerMask: 255,
    tint: [1, 1, 1, 1],
    emissive: [0, 0, 0],
    aoIntensity: 1,
    roughness: 1,
    metalness: 0,
    normalScale: [1, 1],
    sortOrder,
  };
}

describe('the decal index', () => {
  it('lists the decals reaching into a point\'s cell, lower sort orders first (ties in table order)', () => {
    const rows = [row([0, 0, 0], 5), row([0.2, 0, 0], -3), row([0.1, 0, 0], 5), row([40, 0, 0])];
    const index = buildDecalIndex(rows, DECAL_CELL_BUDGET);
    expect(decalRowsAt(index, { x: 0.1, y: 0, z: 0 })).toEqual([1, 0, 2]);
    expect(decalRowsAt(index, { x: 40, y: 0, z: 0 })).toEqual([3]);
    // Between them and past the decals: an empty cell (one slot read).
    expect(decalRowsAt(index, { x: 20, y: 0, z: 0 })).toEqual([]);
    expect(decalRowsAt(index, { x: 0, y: 30, z: 0 })).toEqual([]);
    expect(index.dropped).toBe(0);
  });

  it('keeps a cell\'s list within the overlap budget: the highest sort orders stay (drawn on top), the rest are counted', () => {
    const rows = Array.from({ length: DECAL_CELL_BUDGET + 3 }, (_, i) => row([0, 0, 0], i));
    const index = buildDecalIndex(rows, DECAL_CELL_BUDGET);
    const at = decalRowsAt(index, { x: 0, y: 0, z: 0 });
    expect(at).toHaveLength(DECAL_CELL_BUDGET);
    expect(at[0]).toBe(3);
    expect(at[at.length - 1]).toBe(DECAL_CELL_BUDGET + 2);
    expect(index.droppedDecals).toBe(3);
    expect(index.dropped).toBeGreaterThanOrEqual(3);
  });

  it('cells follow the decals\' sizes however far apart they are; only cells with decals are stored', () => {
    const near = buildDecalIndex([row([0, 0, 0]), row([3, 0, 0])], DECAL_CELL_BUDGET);
    expect(near.invCell[0]).toBeCloseTo(1);
    // Kilometres apart: still metre cells, a few slots, a texture of a few lines with room for changes (a dense grid would be 10^10 cells).
    const spread = buildDecalIndex([row([0, 0, 0]), row([5000, 400, 5000])], DECAL_CELL_BUDGET);
    expect(spread.invCell[0]).toBeCloseTo(1);
    expect(spread.cells).toBeLessThanOrEqual(16);
    expect(spread.height).toBeLessThanOrEqual(2);
    expect(decalRowsAt(spread, { x: 5000, y: 400, z: 5000 })).toEqual([1]);
    expect(decalRowsAt(spread, { x: 2500, y: 200, z: 2500 })).toEqual([]);
    // One huge decal among small ones makes the cells larger rather than reaching into millions.
    const huge = buildDecalIndex([row([0, 0, 0]), row([3, 0, 0]), row([0, 0, 0], 0, 400)], DECAL_CELL_BUDGET);
    expect(huge.entries).toBeLessThanOrEqual(16 * 3);
    // Its cells (counted from the world's origin) are the small ones' too: a pixel there walks all three, the boxes decide.
    expect(decalRowsAt(huge, { x: 150, y: 0, z: 150 })).toContain(2);
    expect(huge.cells).toBeLessThanOrEqual(8);
  });

  it('finds every decal\'s cell through the hash table, probing past taken slots', () => {
    // A lattice of 2,000 decals: many hash collisions on the way.
    const rows = Array.from({ length: 2000 }, (_, i) => row([(i % 50) * 1.7, Math.floor(i / 500) * 1.7, Math.floor((i % 500) / 50) * 1.7]));
    const index = buildDecalIndex(rows, DECAL_CELL_BUDGET);
    expect(index.probes).toBeGreaterThanOrEqual(1);
    // At most a quarter full.
    expect(index.cells * 4).toBeLessThanOrEqual(index.mask + 1);
    rows.forEach((r, i) => expect(decalRowsAt(index, { x: (r.min[0] + r.max[0]) / 2, y: (r.min[1] + r.max[1]) / 2, z: (r.min[2] + r.max[2]) / 2 }), `decal ${i}`).toContain(i));
  });

  it('packs a row\'s matrix, place and channels where the shader reads them', () => {
    const t = packDecalTable([row([0, 0, 0]), row([1, 2, 3], 7)]);
    const o = DECAL_ROW_TEXELS * 4;
    expect([...t.data.subarray(o, o + 12)]).toEqual([1, 0, 0, -1, 0, 1, 0, -2, 0, 0, 1, -3]);
    expect([...t.data.subarray(o + 16, o + 20)]).toEqual([0, -1, -1, 4]);
    expect(t.data[o + 31]).toBe(255);
  });
});

describe('a scene without projected decals keeps its programs', () => {
  it('the WGSL of every shader type and every plain graph is what it was, with the decal steps installed', async () => {
    const renderer = wgslRenderer();
    const types = await libraryScene(SHADER_TYPE_MATERIALS);
    const now: Record<string, string> = {};
    for (const [id, m] of Object.entries(types.meshes)) now[id] = digestOf(wgslOf(renderer, types.scene, m));
    expect(now).toEqual(SHADER_TYPE_WGSL);
    const graphs = await libraryScene(Object.entries(PLAIN_GRAPHS).map(([id, g]) => graphDef(id, g)));
    const graphNow: Record<string, string> = {};
    for (const [id, m] of Object.entries(graphs.meshes)) graphNow[id] = digestOf(wgslOf(renderer, graphs.scene, m));
    expect(graphNow).toEqual(PLAIN_GRAPH_WGSL);
  });
});

describe('with projected decals', () => {
  it('a lit material\'s decal variant blends them in (a program of its own); unlit and mesh decal materials take none', async () => {
    const renderer = wgslRenderer();
    const decals = new ProjectedDecals();
    const lit = await libraryScene([...SHADER_TYPE_MATERIALS, { materialId: 'mark', name: 'mark', shader: 'decal', params: {}, textures: {} }]);
    const scene = lit.scene;
    for (const [id, m] of Object.entries(lit.meshes)) {
      const own = m.material as THREE.Material;
      m.material = decalVariant(own, decals);
      const wgsl = wgslOf(renderer, scene, m);
      m.material = own;
      const blended = wgsl.includes('tlDecalAlbedo');
      if (id === 'unlit' || id === 'mark') expect(blended, id).toBe(false);
      else {
        expect(blended, id).toBe(true);
        expect(digestOf(wgsl), id).not.toBe(SHADER_TYPE_WGSL[id]);
      }
    }
    // A lightmapped copy (its ambient light left out) still takes them.
    const lightmapped = (lit.meshes['standard']!.material as THREE.Material).clone();
    withoutAmbientLight(lightmapped);
    const copy = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), decalVariant(lightmapped, decals));
    scene.add(copy);
    expect(wgslOf(renderer, scene, copy)).toContain('tlDecalAlbedo');
    // Equal materials share the variant's program; a new generation of the decals' textures is a new variant.
    expect(decalVariant(lightmapped, decals)).toBe(copy.material);
    // The replaced variant is disposed, so three lets go of its draws.
    let replaced = 0;
    (copy.material as THREE.Material).addEventListener('dispose', () => (replaced += 1));
    decals.generation += 1;
    expect(decalVariant(lightmapped, decals)).not.toBe(copy.material);
    expect(replaced).toBe(1);
  });

  it('a decal is data: decals of other sizes, places and pages build the same program', async () => {
    const renderer = wgslRenderer();
    const programs = await Promise.all(
      [1, 2].map(async (k) => {
        const decals = new ProjectedDecals();
        decals.layout.set(0, 256 * k, 0, 0);
        decals.origin.set(k, 0, 0, 0);
        const { scene, meshes } = await libraryScene([SHADER_TYPE_MATERIALS[0]!]);
        const m = meshes['standard']!;
        m.material = decalVariant(m.material as THREE.Material, decals);
        return wgslOf(renderer, scene, m);
      }),
    );
    expect(programs[0]).toBe(programs[1]);
  });

  it('builds only the channels the decals change, and the per-pixel layer test only while some decal marks some layers', async () => {
    const renderer = wgslRenderer();
    const wgslWith = async (uses: number): Promise<string> => {
      const decals = new ProjectedDecals();
      decals.setUses(uses);
      const { scene, meshes } = await libraryScene([SHADER_TYPE_MATERIALS[0]!]);
      const m = meshes['standard']!;
      m.material = decalVariant(m.material as THREE.Material, decals);
      return wgslOf(renderer, scene, m);
    };
    const colourOnly = await wgslWith(DECAL_CHANNEL_BITS.albedo);
    expect(colourOnly).toContain('tlDecalAlbedo');
    expect(colourOnly).not.toContain('tlDecalBend');
    expect(colourOnly).not.toContain('tlDecalRough');
    expect(colourOnly).not.toContain('tlDecalLayers');
    const layered = await wgslWith(DECAL_CHANNEL_BITS.albedo | DECAL_CHANNEL_BITS.normal | DECAL_LAYER_TEST_BIT);
    expect(layered).toContain('tlDecalBend');
    expect(layered).toContain('tlDecalLayers');
  });

  it('only an object a decal can reach takes them: its bounds meet a decal\'s box and its layers one of the decal\'s', () => {
    const decals = new ProjectedDecals();
    decals.setBoxes([{ min: [-1, -1, -1], max: [1, 1, 1], layerMask: 0b01 }, { min: [100, 0, 0], max: [101, 1, 1], layerMask: 0b10 }]);
    const near = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    near.position.set(1.2, 0, 0);
    near.updateMatrixWorld();
    const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    far.position.set(20, 0, 0);
    far.updateMatrixWorld();
    expect(decals.hits(near)).toBe(true);
    expect(decals.hits(far)).toBe(false);
    // Outside the decal's layers: not reached.
    near.userData['__tlDecalLayers'] = 0b10;
    expect(decals.hits(near)).toBe(false);
    // It moves next to the other decal: reached again.
    near.position.set(100.5, 0.5, 0.5);
    near.updateMatrixWorld();
    expect(decals.hits(near)).toBe(true);
    // A huge object (terrain) is tested box by box.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000));
    ground.updateMatrixWorld();
    expect(decals.hits(ground)).toBe(true);
    // A decal too large for the CPU's coarse grid still reaches what it covers.
    const wide = new ProjectedDecals();
    wide.setBoxes([{ min: [-500, -50, -500], max: [500, 50, 500], layerMask: 1 }]);
    expect(wide.hits(far)).toBe(true);
    // A skinned mesh is in no layer unless set.
    expect(decals.hits(new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1)))).toBe(false);
  });
});

describe('decal layers on drawables', () => {
  it('absent: every layer, a skinned mesh none; set: the mask, which builds nothing', () => {
    const mesh = new THREE.Mesh();
    const skinned = new THREE.SkinnedMesh();
    expect(objectDecalLayers(mesh)).toBe(255);
    expect(objectDecalLayers(skinned)).toBe(0);
    const root = new THREE.Group();
    root.add(mesh, skinned);
    expect(applyObjectDecalLayers(root, 4)).toBe(true);
    expect(objectDecalLayers(mesh)).toBe(4);
    expect(objectDecalLayers(skinned)).toBe(4);
    expect(applyObjectDecalLayers(root, 4)).toBe(false);
    applyObjectDecalLayers(root, undefined);
    expect(objectDecalLayers(skinned)).toBe(0);
  });
});

describe('the decal host', () => {
  it('attaches the decals to the scene while one can mark something, builds the index on change only, and takes it out with the last decal', async () => {
    const tex = testTexture();
    const library = createMaterialLibrary({ loadTexture: async () => tex });
    library.setMaterials([{ materialId: 'stain', name: 'stain', shader: 'decal', params: { color: '#804020' }, textures: { map: 'tex' } }, { materialId: 'plain', name: 'plain', shader: 'standard', params: {}, textures: {} }]);
    const scene = new THREE.Scene();
    const host = createDecalProjectors({ scene, materialOf: (h, id) => library.projectedDecal!(h, id) });
    const node = new THREE.Object3D();
    node.position.set(2, 0, 0);
    scene.add(node);
    // A renderer that draws nothing (the view's pages need a GPU: the table and index are what this reads).
    const renderer = { getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget: () => undefined, render: () => undefined } as unknown as Parameters<typeof host.beforeFrame>[0];
    host.set('d1', node, { size: [1, 1, 0.5], material: 'stain' });
    host.set('d2', node, { size: [1, 1, 0.5], material: 'plain' });
    host.set('d3', node, { size: [1, 1, 0.5], mode: 'clipped', material: 'stain' });
    await settle();
    expect(decalSourceOf(library.projectedDecal!('probe', 'stain'))?.images.albedo).not.toBeNull();
    host.beforeFrame(renderer);
    const o = host.observe();
    // A clipped decal is not projected; one naming a material that is not a decal material marks nothing.
    expect(o).toMatchObject({ decals: 2, drawn: 1, builds: 1 });
    expect(o.entries).toBeGreaterThan(0);
    expect(projectedDecalsOf(scene)?.count).toBe(1);
    // A still frame builds nothing.
    host.beforeFrame(renderer);
    expect(host.observe().builds).toBe(1);
    host.remove('d1');
    host.beforeFrame(renderer);
    expect(projectedDecalsOf(scene)).toBeNull();
    host.dispose();
  });

  it('`?decals=off` leaves them out', () => {
    expect(pageFlagOn('', DECALS_URL_PARAM)).toBe(true);
    expect(pageFlagOn('?decals=off', DECALS_URL_PARAM)).toBe(false);
    expect(pageFlagOn('?decals=0', DECALS_URL_PARAM)).toBe(false);
  });
});
