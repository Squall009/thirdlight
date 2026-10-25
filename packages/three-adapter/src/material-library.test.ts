/**
 * The material library's assignment rules (no WebGL needed): a
 * mesh material named `n` takes mapping[n], else mapping["*"]; one built
 * material per (material, source) is shared; undo restores the file's; a
 * changed definition rebuilds; textures load once.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createMaterialLibrary, type MaterialDefLike } from './material-library';
import { SAMPLED_TEXTURES_KEY } from './texture-streaming';

function model(): THREE.Group {
  const g = new THREE.Group();
  const bark = new THREE.MeshStandardMaterial({ name: 'bark', color: 0x553311 });
  const leaf = new THREE.MeshStandardMaterial({ name: 'leaf', color: 0x33aa33 });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(), bark), new THREE.Mesh(new THREE.BoxGeometry(), leaf));
  return g;
}
const mats = (g: THREE.Object3D): THREE.Material[] => g.children.map((c) => (c as THREE.Mesh).material as THREE.Material);
const FOLIAGE: MaterialDefLike = { materialId: 'mat-foliage', name: 'Foliage', shader: 'foliage', params: { windBend: 2 }, textures: {} };
const RED: MaterialDefLike = { materialId: 'mat-red', name: 'Red', shader: 'standard', params: { color: '#ff0000' }, textures: {} };

describe('material library', () => {
  it('applies by material name with "*" as the fallback, shares built materials, and undoes', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([FOLIAGE, RED]);
    const a = model();
    const b = model();
    const [barkA, leafA] = mats(a);
    const undoA = lib.apply(a, { '*': 'mat-foliage', bark: 'mat-red' });
    lib.apply(b, { '*': 'mat-foliage', bark: 'mat-red' });
    expect(mats(a)[0]!.name).toBe('Red');
    expect((mats(a)[0] as THREE.MeshStandardMaterial).color.getHexString()).toBe('ff0000');
    expect(mats(a)[1]!.name).toBe('Foliage');
    // The leaf keeps the file's colour (the foliage material sets none) and is double-sided.
    expect((mats(a)[1] as THREE.MeshStandardMaterial).color.getHex()).toBe(0x33aa33);
    expect(mats(a)[1]!.side).toBe(THREE.DoubleSide);
    expect(lib.animated()).toBe(true);
    undoA();
    expect(mats(a)).toEqual([barkA, leafA]);
  });

  it('holds the wind still on request: foliage then keeps no view drawing, water still does', () => {
    let changes = 0;
    const lib = createMaterialLibrary({ loadTexture: async () => null, onChange: () => void (changes += 1) });
    const WATER: MaterialDefLike = { materialId: 'mat-water', name: 'Water', shader: 'water', params: {}, textures: {} };
    lib.setMaterials([FOLIAGE, WATER]);
    lib.apply(model(), { '*': 'mat-foliage' });
    expect(lib.animated()).toBe(true);
    const before = changes;
    lib.setWindHeld(true);
    expect(changes, 'the view is asked to draw the held pose').toBe(before + 1);
    lib.setWindHeld(true);
    expect(changes, 'no change, no request').toBe(before + 1);
    expect(lib.animated()).toBe(false);
    lib.tick(5);
    expect(lib.animated()).toBe(false);
    lib.apply(model(), { '*': 'mat-water' });
    expect(lib.animated()).toBe(true);
    lib.setWindHeld(false);
    expect(lib.animated()).toBe(true);
  });

  it('rebuilds when a definition changes and drops a vanished material', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([RED]);
    const a = model();
    lib.apply(a, { '*': 'mat-red' });
    const before = mats(a)[0];
    lib.setMaterials([{ ...RED, params: { color: '#00ff00' } }]);
    expect(mats(a)[0]).not.toBe(before);
    expect((mats(a)[0] as THREE.MeshStandardMaterial).color.getHexString()).toBe('00ff00');
    lib.setMaterials([]);
    expect(mats(a)[0]!.name).toBe('bark');
  });

  it('keeps a model file\'s normal scale with its sign, the green turned around where the frame comes from the UVs', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([RED]);
    // As three's glTF loader leaves them on a mesh without tangents: scale on x, y turned around.
    for (const [x, y] of [
      [1.5, -1.5],
      [-2, 2],
    ] as const) {
      const g = new THREE.Group();
      const src = new THREE.MeshStandardMaterial({ name: 'bark' });
      src.normalScale.set(x, y);
      g.add(new THREE.Mesh(new THREE.BoxGeometry(), src));
      lib.apply(g, { '*': 'mat-red' });
      const m = mats(g)[0] as THREE.MeshStandardMaterial;
      // BoxGeometry has no tangents: the frame is derived and y is −x.
      expect([m.normalScale.x, m.normalScale.y]).toEqual([x, -x]);
    }
  });

  it('loads a texture once and puts it on the slot', async () => {
    let loads = 0;
    const tex = new THREE.Texture();
    const lib = createMaterialLibrary({
      loadTexture: async () => {
        loads += 1;
        return tex;
      },
    });
    lib.setMaterials([{ ...RED, textures: { map: 'tex-1' } }]);
    const a = model();
    lib.apply(a, { '*': 'mat-red' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const m = mats(a)[0] as THREE.MeshStandardMaterial;
    expect(m.map).not.toBeNull();
    expect(m.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(loads).toBe(1);
  });
  it('shares one prepared texture per (texture, colour space, wrap, tiling) across model files, freed with its last material', async () => {
    const tex = new THREE.Texture();
    const lib = createMaterialLibrary({ loadTexture: async () => tex });
    lib.setMaterials([
      { ...RED, textures: { map: 'tex-1', normalMap: 'tex-1' } },
      { ...RED, materialId: 'mat-tiled', name: 'Tiled', params: { color: '#ff0000', tiling: [4, 4] }, textures: { map: 'tex-1' } },
    ]);
    const files = [model(), model(), model()];
    const undo = files.map((g) => lib.apply(g, { '*': 'mat-red' }));
    const tiled = model();
    lib.apply(tiled, { '*': 'mat-tiled' });
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    const meshes = files.flatMap((g) => mats(g)) as THREE.MeshStandardMaterial[];
    // Six built materials (two per file), one colour copy and one data copy of the texture.
    expect(new Set(meshes).size).toBe(6);
    expect(new Set(meshes.map((m) => m.map)).size).toBe(1);
    expect(new Set(meshes.map((m) => m.normalMap)).size).toBe(1);
    const map = meshes[0]!.map!;
    expect(map).not.toBe(tex);
    expect(map.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(meshes[0]!.normalMap!.colorSpace).toBe(THREE.NoColorSpace);
    // Another tiling is another copy.
    const tiledMap = (mats(tiled)[0] as THREE.MeshStandardMaterial).map!;
    expect(tiledMap).not.toBe(map);
    expect(tiledMap.repeat.x).toBe(4);
    let disposed = 0;
    map.addEventListener('dispose', () => (disposed += 1));
    undo[0]!();
    undo[1]!();
    expect(disposed).toBe(0);
    undo[2]!();
    expect(disposed).toBe(1);
  });

  it('a graph material whose texture parameter changes draws the texture it replaces until the new one arrives, then lets it go', async () => {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const texA = new THREE.Texture();
    const texB = new THREE.Texture();
    let arriveB: (t: THREE.Texture) => void = () => undefined;
    const lib = createMaterialLibrary({ loadTexture: (id) => (id === 'tex-a' ? Promise.resolve(texA) : new Promise((r) => (arriveB = r))) });
    const graph = {
      nodes: [
        { id: 'out', type: 'unlit', position: [400, 0] as [number, number] },
        { id: 'skin', type: 'parameter', position: [0, 0] as [number, number], data: { key: 'skin' } },
        { id: 'read', type: 'sampleTexture', position: [200, 0] as [number, number] },
      ],
      edges: [
        { id: 'e1', from: { node: 'skin', port: 'value' }, to: { node: 'read', port: 'tex' } },
        { id: 'e2', from: { node: 'read', port: 'rgb' }, to: { node: 'out', port: 'color' } },
      ],
    };
    const skinned = (tex: string): MaterialDefLike => ({ materialId: 'mat-skin', name: 'Skin', shader: 'standard', params: {}, textures: {}, graph, parameters: [{ key: 'skin', type: 'texture', default: tex }] });
    const sampled = (o: THREE.Object3D): unknown[] => (((mats(o)[0]!.userData[SAMPLED_TEXTURES_KEY] as THREE.Texture[] | undefined) ?? []).map((t) => t.source));
    lib.setMaterials([skinned('tex-a')]);
    const a = model();
    lib.apply(a, { '*': 'mat-skin' });
    await tick();
    await tick();
    expect(sampled(a)).toEqual([texA.source]);
    const copyA = (mats(a)[0]!.userData[SAMPLED_TEXTURES_KEY] as THREE.Texture[])[0]!;
    let copyADisposed = 0;
    copyA.addEventListener('dispose', () => void (copyADisposed += 1));
    // Another texture there, on its way: the material draws texture A meanwhile (not nothing, which reads white).
    lib.setMaterials([skinned('tex-b')]);
    await tick();
    expect(sampled(a)).toEqual([texA.source]);
    expect(copyADisposed).toBe(0);
    // It arrives: texture B is drawn, and texture A, drawn by nothing now, is let go.
    arriveB(texB);
    await tick();
    await tick();
    expect(sampled(a)).toEqual([texB.source]);
    expect(copyADisposed).toBe(1);
  });

  it("a texture still loading is drawn as the host's stand-ins, each better one in turn, then as itself; each stand-in is let go", async () => {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const final = new THREE.Texture();
    const first = new THREE.Texture();
    const better = new THREE.Texture();
    const late = new THREE.Texture();
    let arrive: (t: THREE.Texture) => void = () => undefined;
    let show: (t: THREE.Texture) => void = () => undefined;
    const asked: string[] = [];
    const lib = createMaterialLibrary({
      loadTexture: () => new Promise((r) => (arrive = r)),
      // The stand-in is asked for before the texture itself, once.
      previewTexture: (id, s) => {
        asked.push(id);
        show = s;
        return first;
      },
    });
    const graph = {
      nodes: [
        { id: 'out', type: 'unlit', position: [400, 0] as [number, number] },
        { id: 'read', type: 'sampleTexture', position: [200, 0] as [number, number], data: { texture: 'tex-slow' } },
      ],
      edges: [{ id: 'e', from: { node: 'read', port: 'rgb' }, to: { node: 'out', port: 'color' } }],
    };
    lib.setMaterials([{ materialId: 'mat-slow', name: 'Slow', shader: 'standard', params: {}, textures: {}, graph }]);
    const o = model();
    lib.apply(o, { '*': 'mat-slow' });
    const sampled = (): unknown[] => (((mats(o)[0]!.userData[SAMPLED_TEXTURES_KEY] as THREE.Texture[] | undefined) ?? []).map((t) => t.source));
    const disposed = new Set<THREE.Texture>();
    for (const t of [first, better, late]) t.addEventListener('dispose', () => void disposed.add(t));
    // Drawn as the first stand-in at once (not the absent value's white).
    expect(sampled()).toEqual([first.source]);
    expect(asked).toEqual(['tex-slow']);
    show(better);
    await tick();
    expect(sampled()).toEqual([better.source]);
    expect(disposed.has(first)).toBe(true);
    arrive(final);
    await tick();
    await tick();
    expect(sampled()).toEqual([final.source]);
    expect(disposed.has(better)).toBe(true);
    // A stand-in shown after the texture arrived is let go at once.
    show(late);
    expect(disposed.has(late)).toBe(true);
    expect(sampled()).toEqual([final.source]);
    expect(asked).toEqual(['tex-slow']);
  });

  it('a texture that cannot be made is drawn as its last stand-in, freed with it', async () => {
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const stand = new THREE.Texture();
    let fail: (t: THREE.Texture | null) => void = () => undefined;
    const lib = createMaterialLibrary({ loadTexture: () => new Promise((r) => (fail = r)), previewTexture: () => stand });
    const graph = {
      nodes: [
        { id: 'out', type: 'unlit', position: [400, 0] as [number, number] },
        { id: 'read', type: 'sampleTexture', position: [200, 0] as [number, number], data: { texture: 'tex-over' } },
      ],
      edges: [{ id: 'e', from: { node: 'read', port: 'rgb' }, to: { node: 'out', port: 'color' } }],
    };
    lib.setMaterials([{ materialId: 'mat-over', name: 'Over', shader: 'standard', params: {}, textures: {}, graph }]);
    const o = model();
    const undo = lib.apply(o, { '*': 'mat-over' });
    const sampled = (): unknown[] => (((mats(o)[0]!.userData[SAMPLED_TEXTURES_KEY] as THREE.Texture[] | undefined) ?? []).map((t) => t.source));
    let disposed = 0;
    stand.addEventListener('dispose', () => void (disposed += 1));
    fail(null);
    await tick();
    await tick();
    expect(sampled()).toEqual([stand.source]);
    expect(disposed).toBe(0);
    undo();
    lib.dispose();
    expect(disposed).toBe(1);
  });
});
