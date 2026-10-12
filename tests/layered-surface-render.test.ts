/**
 * The layered surface in the renderer: what the Layer weights node reads on
 * each kind of mesh, a mesh-UV layer kept inside its sheet's rows, a layer
 * the material does not use read not at all, a trim material drawn as the
 * layered surface it is — and the programs of scenes that use none of it.
 *
 * The legacy digests are the WGSL of a graph shaped like the layered template
 * as projects stored it before the Layer weights node existed (weights from
 * COLOR_0 "first", wetness from COLOR_1 "zero"), recorded before vertex paint
 * fed those weights (three r186): an unpainted mesh must keep its program.
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';

import { defaultTrimSheet, layeredMaterial } from '../packages/project-model/src/index';
import { compileMaterialGraph, digestOf, isArrayTexture, TRIM_DATA_ATTRIBUTE, type GraphCompileEnv, type MaterialGraphLike } from '../packages/three-adapter/src/material-graph';
import { createMaterialLibrary, type MaterialDefLike } from '../packages/three-adapter/src/material-library';
import { graphDef, litScene, settle, testTexture, wgslOf, wgslRenderer } from '../packages/three-adapter/src/test-wgsl';
import { PAINT_ATTRIBUTE } from '../packages/three-adapter/src/vertex-paint-draw';

const n = (id: string, type: string, data?: Record<string, unknown>) => ({ id, type, position: [0, 0] as [number, number], ...(data !== undefined ? { data } : {}) });
const e = (id: string, from: string, fp: string, to: string, tp: string) => ({ id, from: { node: from, port: fp }, to: { node: to, port: tp } });

/** The template's weights and wetness as stored graphs read them before the Layer weights node. */
const LEGACY: MaterialGraphLike = {
  nodes: [n('out', 'pbr'), n('w', 'vertexColor', { absent: 'first' }), n('wet', 'vertexColor', { set: 'COLOR_1', absent: 'zero' }), n('hb', 'heightBlend'), n('mix', 'weightedMix'), n('c1', 'color', { color: '#ff0000' }), n('c2', 'color', { color: '#00ff00' }), n('s', 'split')],
  edges: [e('a', 'w', 'rgba', 'hb', 'weights'), e('b', 'hb', 'weights', 'mix', 'weights'), e('c', 'c1', 'rgb', 'mix', 'a'), e('d', 'c2', 'rgb', 'mix', 'b'), e('f', 'mix', 'out', 'out', 'baseColor'), e('g', 'wet', 'rgba', 's', 'in'), e('h', 's', 'x', 'out', 'roughness')],
};
/** Its WGSL on a plain mesh, a painted block layer's (COLOR_0 and COLOR_1) and a mesh with its own vertex colours. */
const LEGACY_WGSL = { plain: 'c2a9acfb2d7f07ff', stored: '1b5b46d655629062', colours: '4ab7c0b4c6999ea8' };

/** A sphere carrying these extra vec4 attributes (zeros). */
function sphere(attrs: readonly string[]): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 8, 6);
  const count = g.getAttribute('position').count;
  for (const a of attrs) g.setAttribute(a, a === PAINT_ATTRIBUTE ? new THREE.BufferAttribute(new Uint8Array(count * 4), 4, true) : new THREE.BufferAttribute(new Float32Array(count * 4), 4));
  return g;
}

/** The WGSL digest of each geometry wearing `def` (through a material library). */
async function digests(def: MaterialDefLike, geometries: Readonly<Record<string, readonly string[]>>, all: readonly MaterialDefLike[] = [def]): Promise<{ digests: Record<string, string>; text: Record<string, string> }> {
  const library = createMaterialLibrary({ loadTexture: async () => testTexture() });
  library.setMaterials(all);
  const scene = litScene();
  const meshes: Record<string, THREE.Mesh> = {};
  for (const [k, attrs] of Object.entries(geometries)) {
    const m = new THREE.Mesh(sphere(attrs), new THREE.MeshStandardMaterial());
    scene.add(m);
    library.apply(m, { '*': def.materialId });
    meshes[k] = m;
  }
  await settle();
  const r = wgslRenderer();
  const text: Record<string, string> = {};
  for (const [k, m] of Object.entries(meshes)) text[k] = wgslOf(r, scene, m);
  return { digests: Object.fromEntries(Object.entries(text).map(([k, t]) => [k, digestOf(t)])), text };
}

const env = (textures: Record<string, THREE.Texture>): GraphCompileEnv => ({
  globals: { time: TSL.uniform(0), windDir: TSL.uniform(new THREE.Vector2(1, 0)), strength: TSL.uniform(1), gust: TSL.uniform(0), gustFreq: TSL.uniform(0), turb: TSL.uniform(0), wetness: TSL.uniform(0) },
  texture: (id) => textures[id] ?? null,
  fn: () => null,
});

/** Every texture read under a node tree, with whether it reads with given derivatives. */
function textureReads(root: unknown): { array: boolean; grad: boolean }[] {
  const out: { array: boolean; grad: boolean }[] = [];
  const seen = new Set<unknown>();
  const visit = (x: unknown): void => {
    if (x === null || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x);
    const node = x as { isTextureNode?: boolean; value?: THREE.Texture; gradNode?: unknown };
    if (node.isTextureNode === true && node.value !== undefined) out.push({ array: isArrayTexture(node.value), grad: node.gradNode != null });
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (k === 'referenceNode') continue;
      if (Array.isArray(v)) v.forEach(visit);
      else if (v !== null && typeof v === 'object' && (v as { isNode?: boolean }).isNode === true) visit(v);
    }
  };
  visit(root);
  return out;
}

describe('a scene without the layered surface keeps its programs', () => {
  it('a stored layered graph builds what it did on every unpainted mesh; a painted one reads its paint', async () => {
    const def = graphDef('legacy', LEGACY);
    const { digests: now, text } = await digests(def, { plain: [], stored: ['color', 'color_1'], colours: ['color'], painted: [PAINT_ATTRIBUTE] });
    expect({ plain: now['plain'], stored: now['stored'], colours: now['colours'] }).toEqual(LEGACY_WGSL);
    expect(text['painted']).toContain(PAINT_ATTRIBUTE);
    expect(text['plain']).not.toContain(PAINT_ATTRIBUTE);
  });
});

describe('the layered surface', () => {
  it('the Layer weights node: stored weights, a mesh\'s own colours, trim data, paint and nothing are programs of their own; an unpainted plain mesh reads no attribute', async () => {
    const m = layeredMaterial('mat-layers', 'Layers') as unknown as MaterialDefLike;
    const { digests: now, text } = await digests(m, { plain: [], stored: ['color', 'color_1'], colours: ['color'], trim: [TRIM_DATA_ATTRIBUTE], painted: [PAINT_ATTRIBUTE], paintedTrim: [TRIM_DATA_ATTRIBUTE, PAINT_ATTRIBUTE] });
    expect(new Set(Object.values(now)).size).toBe(6);
    expect(text['trim']).toContain(TRIM_DATA_ATTRIBUTE);
    expect(text['plain']).not.toContain(PAINT_ATTRIBUTE);
    expect(text['stored']).not.toContain(PAINT_ATTRIBUTE);
    expect(text['painted']).toContain(PAINT_ATTRIBUTE);
  });

  it('a mesh-UV layer reads at the centroid with its derivatives shortened to the sheet\'s rows; without rows, a plain read', () => {
    const sheet = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const graph: MaterialGraphLike = {
      nodes: [n('out', 'pbr'), n('mode', 'float', { value: 3 }), n('s', 'projectedSample', { texture: 'sheet' })],
      edges: [e('a', 'mode', 'value', 's', 'mode'), e('b', 's', 'rgb', 'out', 'baseColor')],
    };
    const rows = compileMaterialGraph({ graph, trim: defaultTrimSheet() }, env({ sheet }));
    expect(rows.problems).toEqual([]);
    expect(textureReads(rows.slots.color)).toEqual([{ array: false, grad: true }]);
    const plain = compileMaterialGraph({ graph }, env({ sheet }));
    expect(textureReads(plain.slots.color)).toEqual([{ array: false, grad: false }]);
  });

  it('a world layer\'s side-projected normal map on a mesh without tangents reads the frame its pixels derive (no tangent varying to divide by zero)', async () => {
    const m = layeredMaterial('mat-walls', 'Walls');
    const walls = { ...m, parameters: m.parameters!.map((p) => (p.key === 'normals' ? { ...p, default: 'tex' } : p.key === 'albedoHeight' ? { ...p, default: 'tex' } : p.key === 'layerProjection' ? { ...p, default: [3, 1, 1, 1] } : p)) } as unknown as MaterialDefLike;
    const { text } = await digests(walls, { plain: [], tangents: ['tangent'] });
    expect(text['plain']).not.toContain('v_tangentWorld');
    expect(text['tangents']).toContain('v_tangentWorld');
  });

  it('a layer the material does not use reads no texture and reports nothing', () => {
    const graph: MaterialGraphLike = {
      nodes: [n('out', 'pbr'), n('layer', 'float', { value: -1 }), n('s', 'projectedSample', { texture: 'gone', absent: 'black' })],
      edges: [e('a', 'layer', 'value', 's', 'layer'), e('b', 's', 'rgb', 'out', 'baseColor')],
    };
    const c = compileMaterialGraph({ graph }, env({}));
    expect(c.problems).toEqual([]);
    expect(c.textures).toEqual([]);
    expect(textureReads(c.slots.color)).toEqual([]);
  });

  it('a trim material draws as its layered surface: a compiled graph, its rows the generator\'s', async () => {
    const trim: MaterialDefLike = { materialId: 'mat-trim', name: 'Trim', shader: 'trim', params: {}, textures: { map: 'sheet', normalMap: 'sheet', ormMap: 'sheet' }, trim: defaultTrimSheet() };
    const library = createMaterialLibrary({ loadTexture: async () => testTexture() });
    library.setMaterials([trim]);
    const mesh = new THREE.Mesh(sphere([]), new THREE.MeshStandardMaterial());
    library.apply(mesh, { '*': 'mat-trim' });
    await settle();
    expect(library.graphProblems('mat-trim')).toEqual([]);
    expect(library.trimSheetOf('mat-trim')).toEqual(defaultTrimSheet());
    const reads = textureReads((mesh.material as unknown as { colorNode: unknown }).colorNode);
    expect(reads.length).toBe(2);
    expect(reads.every((r) => r.grad)).toBe(true);
  });

  it('a layered material\'s mesh-UV layers and generated walls follow its trim sheets\' rows', () => {
    const sheet: MaterialDefLike = { materialId: 'sheet-a', name: 'A', shader: 'trim', params: {}, textures: {}, trim: defaultTrimSheet() };
    const walls = { ...(layeredMaterial('mat-walls', 'Walls') as unknown as MaterialDefLike), layerSheets: ['sheet-a'] };
    const library = createMaterialLibrary({ loadTexture: async () => testTexture() });
    library.setMaterials([sheet, walls]);
    expect(library.trimSheetOf('mat-walls')).toEqual(defaultTrimSheet());
    library.setMaterials([walls]);
    expect(library.trimSheetOf('mat-walls')).toBeNull();
  });
});
