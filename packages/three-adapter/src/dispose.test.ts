/**
 * Phase 21.5: the dispose helpers — a released subtree fires `dispose` on
 * every node (the renderer drops its render objects), lights free their
 * shadows, owned skeletons go, other entities' nodes are skipped; node-made
 * attributes of instanced meshes are deleted from every live renderer's
 * attribute map (never the geometry's own); and the fixes built on them
 * (material library refcounts, fade copies, emissive copies, batching).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createAutoBatcher, markBatchable } from './batching';
import { disposeObjectTree, installProgramRelease, installVaoSweep, liveRenderers, releaseMrtContexts, releaseNodeAttributes, trackRenderer, trackTextureListeners } from './dispose';
import { createFadeTracker } from './fade';
import { createMaterialLibrary, type MaterialDefLike } from './material-library';
import { releaseEmissiveLooks, setEmissiveLook, SHARED_MATERIAL_KEY } from './node-materials';

const disposals = (o: THREE.Object3D): { n: number } => {
  const c = { n: 0 };
  o.addEventListener('dispose' as never, () => {
    c.n += 1;
  });
  return c;
};

/** A stub renderer with the private fields dispose.ts reads (three 0.186). */
function stubRenderer(ros: { object: unknown; geometry: THREE.BufferGeometry; extra: unknown[] }[]): { renderer: unknown; deleted: unknown[] } {
  const deleted: unknown[] = [];
  const live = new Set<unknown>(ros.flatMap((r) => r.extra));
  const renderer = {
    _objects: {
      _renderObjects: new Set(
        ros.map((r) => ({
          object: r.object,
          geometry: r.geometry,
          getAttributes: () => [...Object.values(r.geometry.attributes), ...(r.geometry.index !== null ? [r.geometry.index] : []), ...r.extra],
        })),
      ),
    },
    _attributes: {
      delete(a: unknown) {
        if (!live.has(a)) return null;
        live.delete(a);
        deleted.push(a);
        return {};
      },
    },
  };
  return { renderer, deleted };
}

describe('disposeObjectTree', () => {
  it('disposes every node of the subtree, skips other entities, frees shadows and owned skeletons, keeps geometry and material', () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial();
    let geometryDisposed = 0;
    let materialDisposed = 0;
    geometry.addEventListener('dispose', () => void (geometryDisposed += 1));
    material.addEventListener('dispose', () => void (materialDisposed += 1));
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, material);
    const light = new THREE.PointLight(0xffffff, 1);
    light.castShadow = true;
    let shadowDisposed = 0;
    const shadowDispose = light.shadow.dispose.bind(light.shadow);
    light.shadow.dispose = () => {
      shadowDisposed += 1;
      shadowDispose();
    };
    const bone = new THREE.Bone();
    const skinned = new THREE.SkinnedMesh(geometry, material);
    skinned.add(bone);
    skinned.bind(new THREE.Skeleton([bone]));
    let skeletonDisposed = 0;
    skinned.skeleton.dispose = () => void (skeletonDisposed += 1);
    const other = new THREE.Mesh(geometry, material);
    other.userData['entity'] = 'other';
    const otherChild = new THREE.Mesh(geometry, material);
    other.add(otherChild);
    root.add(mesh, light, skinned, other);
    const seen = [root, mesh, light, skinned, bone].map(disposals);
    const notSeen = [other, otherChild].map(disposals);

    const n = disposeObjectTree(root, { skip: (o) => o.userData['entity'] === 'other', ownedSkeletons: true, renderers: [] });
    expect(n).toBe(5);
    expect(seen.map((c) => c.n)).toEqual([1, 1, 1, 1, 1]);
    expect(notSeen.map((c) => c.n)).toEqual([0, 0]);
    expect(shadowDisposed).toBe(1);
    expect(skeletonDisposed).toBe(1);
    // Geometry and material belong to their owners.
    expect(geometryDisposed).toBe(0);
    expect(materialDisposed).toBe(0);
    expect(disposeObjectTree(null)).toBe(0);
  });

  it('releases the node-made attributes of instanced meshes in every live renderer, never the geometry\'s own', () => {
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const batch = new THREE.InstancedMesh(geometry, material, 1025);
    const kept = new THREE.InstancedMesh(geometry, material, 1025);
    const matrices = [new THREE.InterleavedBufferAttribute(new THREE.InstancedInterleavedBuffer(new Float32Array(16), 16, 1), 4, 0, false), {}];
    const keptMatrices = [{}];
    const a = stubRenderer([
      { object: batch, geometry, extra: matrices },
      { object: kept, geometry, extra: keptMatrices },
    ]);
    const b = stubRenderer([{ object: batch, geometry, extra: [matrices[1]] }]);
    const untrackA = trackRenderer(a.renderer);
    const untrackB = trackRenderer(b.renderer);
    expect(liveRenderers()).toEqual(expect.arrayContaining([a.renderer, b.renderer]));
    const holder = new THREE.Group();
    holder.add(batch);
    disposeObjectTree(holder);
    expect(a.deleted).toEqual(matrices);
    expect(b.deleted).toEqual([matrices[1]]);
    // The shared geometry's attributes and the other mesh's buffers stay.
    expect(a.deleted).not.toContain(geometry.attributes['position']);
    expect(a.deleted).not.toContain(keptMatrices[0]);
    untrackA();
    untrackB();
    expect(liveRenderers()).not.toContain(a.renderer);
    // Renderers without the private fields (another three version) are skipped, not an error.
    expect(releaseNodeAttributes(new Set([kept]), [{}, null])).toBe(0);
  });
});

describe('three 0.186 renderer internals (stubbed)', () => {
  it('installVaoSweep deletes the vertex arrays of destroyed attributes before the next one is made, and keeps live ones', () => {
    const data = new WeakMap<object, { id: number }>();
    let id = 0;
    const deleted: unknown[] = [];
    const backend = {
      gl: { deleteVertexArray: (v: unknown) => void deleted.push(v) },
      vaoCache: {} as Record<string, unknown>,
      has: (o: object) => data.has(o),
      get: (o: object) => {
        let d = data.get(o);
        if (d === undefined) data.set(o, (d = { id: id++ }));
        return d;
      },
      _getVaoKey(attributes: readonly object[]) {
        return attributes.map((a) => `:${this.get(a).id}`).join('');
      },
      _createVao: (attributes: readonly object[]) => ({ vao: attributes.length }),
      destroyAttribute: (a: object) => void data.delete(a),
    };
    expect(installVaoSweep(backend)).toBe(true);
    const make = (attrs: object[]): unknown => {
      const key = backend._getVaoKey(attrs);
      const vao = backend._createVao(attrs);
      backend.vaoCache[key] = vao;
      return vao;
    };
    const kept = [{}, {}];
    const gone = [{}, {}];
    const keptVao = make(kept);
    const goneVao = make(gone);
    backend.destroyAttribute(gone[0]!);
    make([{}]);
    expect(deleted).toEqual([goneVao]);
    expect(Object.values(backend.vaoCache)).toContain(keptVao);
    expect(Object.values(backend.vaoCache)).not.toContain(goneVao);
    expect(installVaoSweep({})).toBe(false);
  });

  it('installVaoSweep also deletes a destroyed attribute set\'s vertex array without waiting for a new one', async () => {
    const data = new WeakMap<object, { id: number }>();
    let id = 0;
    const deleted: unknown[] = [];
    const backend = {
      gl: { deleteVertexArray: (v: unknown) => void deleted.push(v) },
      vaoCache: {} as Record<string, unknown>,
      has: (o: object) => data.has(o),
      get: (o: object) => {
        let d = data.get(o);
        if (d === undefined) data.set(o, (d = { id: id++ }));
        return d;
      },
      _getVaoKey(attributes: readonly object[]) {
        return attributes.map((a) => `:${this.get(a).id}`).join('');
      },
      _createVao: (attributes: readonly object[]) => ({ vao: attributes.length }),
      destroyAttribute: (a: object) => void data.delete(a),
    };
    expect(installVaoSweep(backend)).toBe(true);
    const attrs = [{}];
    const key = backend._getVaoKey(attrs);
    const vao = backend._createVao(attrs);
    backend.vaoCache[key] = vao;
    backend.destroyAttribute(attrs[0]!);
    expect(deleted).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(deleted).toEqual([vao]);
    expect(Object.values(backend.vaoCache)).not.toContain(vao);
  });

  it('trackTextureListeners removes the renderer\'s dispose listeners from textures that outlive it', () => {
    const map = new WeakMap<object, { onDispose?: () => void }>();
    const textures = {
      get: (o: object) => {
        let d = map.get(o);
        if (d === undefined) map.set(o, (d = {}));
        return d;
      },
      updateTexture(t: THREE.Texture) {
        const d = this.get(t);
        if (d.onDispose === undefined) {
          d.onDispose = () => undefined;
          t.addEventListener('dispose', d.onDispose);
        }
      },
      updateRenderTarget: () => undefined,
    };
    const shared = new THREE.Texture();
    const release = trackTextureListeners({ _textures: textures });
    textures.updateTexture(shared);
    expect(shared.hasEventListener('dispose', map.get(shared)!.onDispose!)).toBe(true);
    release();
    expect(shared.hasEventListener('dispose', map.get(shared)!.onDispose!)).toBe(false);
  });
});

describe('three 0.186 renderer internals, continued (stubbed)', () => {
  it('releaseMrtContexts disposes the render objects drawn with a gone MRT and forgets its contexts', () => {
    const mrt = { id: 7 };
    const other = { id: 8 };
    const disposed: string[] = [];
    const ro = (name: string, m: unknown) => ({ context: { mrt: m }, dispose: () => void disposed.push(name) });
    const renderer = {
      _objects: { _renderObjects: new Set([ro('a', mrt), ro('b', other), ro('c', mrt)]) },
      _renderContexts: { _renderContexts: { 'x-7-0': { mrt }, 'x-7-1': { mrt }, 'x-8-0': { mrt: other }, 'x-default-0': { mrt: null } } as Record<string, { mrt: unknown }> },
    };
    expect(releaseMrtContexts(renderer, mrt)).toBe(2);
    expect(disposed).toEqual(['a', 'c']);
    expect(Object.keys(renderer._renderContexts._renderContexts)).toEqual(['x-8-0', 'x-default-0']);
    expect(releaseMrtContexts(renderer, null)).toBe(0);
  });

  it('installProgramRelease deletes the GL program and shaders three only drops from its caches (WebGL 2 only)', () => {
    const data = new Map<object, { programGPU?: unknown; shaderGPU?: unknown }>();
    const deleted: string[] = [];
    const pipeline = {};
    const stage = {};
    data.set(pipeline, { programGPU: 'program-1' });
    data.set(stage, { shaderGPU: 'shader-1' });
    const released: object[] = [];
    const renderer = {
      _pipelines: { _releasePipeline: (p: object) => void released.push(p), _releaseProgram: (p: object) => void released.push(p) },
      backend: { isWebGLBackend: true, gl: { deleteProgram: (p: string) => void deleted.push(p), deleteShader: (s: string) => void deleted.push(s) }, has: (o: object) => data.has(o), get: (o: object) => data.get(o) },
    };
    expect(installProgramRelease(renderer)).toBe(true);
    renderer._pipelines._releasePipeline(pipeline);
    renderer._pipelines._releaseProgram(stage);
    expect(deleted).toEqual(['program-1', 'shader-1']);
    expect(released).toEqual([pipeline, stage]);
    expect(installProgramRelease({ ...renderer, backend: { ...renderer.backend, isWebGLBackend: false } })).toBe(false);
  });
});

describe('fixes built on the helpers', () => {
  const RED: MaterialDefLike = { materialId: 'mat-red', name: 'Red', shader: 'standard', params: { color: '#ff0000' }, textures: {} };

  it('the material library releases a built material (and its texture copies) with its last mesh', async () => {
    const tex = new THREE.Texture();
    const lib = createMaterialLibrary({ loadTexture: async () => tex });
    lib.setMaterials([{ ...RED, textures: { map: 'albedo' } }]);
    const source = new THREE.MeshStandardMaterial({ name: 'src' });
    const a = new THREE.Mesh(new THREE.BoxGeometry(), source);
    const b = new THREE.Mesh(new THREE.BoxGeometry(), source);
    const undoA = lib.apply(a, { '*': 'mat-red' });
    const undoB = lib.apply(b, { '*': 'mat-red' });
    const built = a.material as THREE.MeshStandardMaterial;
    expect(b.material).toBe(built);
    await new Promise((r) => setTimeout(r, 0));
    const copy = built.map;
    expect(copy).not.toBeNull();
    expect(copy).not.toBe(tex);
    let builtDisposed = 0;
    let copyDisposed = 0;
    built.addEventListener('dispose', () => void (builtDisposed += 1));
    copy!.addEventListener('dispose', () => void (copyDisposed += 1));
    undoA();
    expect(builtDisposed).toBe(0);
    undoB();
    expect(builtDisposed).toBe(1);
    expect(copyDisposed).toBe(1);
    expect(b.material).toBe(source);
    // A new source (a recreated shared material) builds anew; the loaded texture itself is the loader's.
    const c = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    lib.apply(c, { '*': 'mat-red' });
    expect(c.material).not.toBe(built);
    let texDisposed = 0;
    tex.addEventListener('dispose', () => void (texDisposed += 1));
    lib.dispose();
    expect(texDisposed).toBe(0);
  });

  it('a fade released while faded disposes its own copies, not what the mesh wears by then', () => {
    const shared = new THREE.MeshStandardMaterial();
    let sharedDisposed = 0;
    shared.addEventListener('dispose', () => void (sharedDisposed += 1));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    const fades = createFadeTracker();
    fades.apply(new Map([['e1', mesh]]), new Map([['e1', 0.5]]));
    const copy = mesh.material as THREE.Material;
    let copyDisposed = 0;
    copy.addEventListener('dispose', () => void (copyDisposed += 1));
    // Something else swapped the mesh's material meanwhile (a material undo).
    const other: THREE.Material = new THREE.MeshBasicMaterial();
    (mesh as THREE.Mesh).material = other;
    fades.release('e1');
    expect(copyDisposed).toBe(1);
    expect(sharedDisposed).toBe(0);
    expect(mesh.material).toBe(other);
    expect(fades.faded()).toEqual([]);
  });

  it('releaseEmissiveLooks disposes the glow\'s own copy only', () => {
    const shared = new THREE.MeshStandardMaterial();
    shared.userData[SHARED_MATERIAL_KEY] = true;
    let sharedDisposed = 0;
    shared.addEventListener('dispose', () => void (sharedDisposed += 1));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), shared);
    setEmissiveLook(mesh, { emissive: '#ffffff', emissiveIntensity: 1 });
    const copy = mesh.material as THREE.Material;
    expect(copy).not.toBe(shared);
    let copyDisposed = 0;
    copy.addEventListener('dispose', () => void (copyDisposed += 1));
    releaseEmissiveLooks(mesh);
    expect(copyDisposed).toBe(1);
    expect(sharedDisposed).toBe(0);
  });

  it('the auto-batcher disposes a released batch mesh and frees its node-made buffers', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshLambertMaterial();
    const members = Array.from({ length: 4 }, (_, i) => {
      const m = new THREE.Mesh(geometry, material);
      m.position.x = i;
      markBatchable(m);
      scene.add(m);
      return m;
    });
    const batcher = createAutoBatcher(scene);
    const camera = new THREE.PerspectiveCamera();
    batcher.update(camera);
    expect(batcher.diagnostics().groups).toBe(1);
    let batch: THREE.InstancedMesh | null = null;
    scene.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh === true) batch = o as THREE.InstancedMesh;
    });
    expect(batch).not.toBeNull();
    const extra = [{}];
    const r = stubRenderer([{ object: batch, geometry, extra }]);
    const untrack = trackRenderer(r.renderer);
    const batchDisposals = disposals(batch!);
    // One member hidden: the group falls under four and is released.
    members[0]!.visible = false;
    batcher.update(camera);
    expect(batcher.diagnostics().groups).toBe(0);
    expect(batchDisposals.n).toBe(1);
    expect(r.deleted).toEqual(extra);
    // The group forms again; its material disposed before the next frame (the last box went) releases it at once,
    // while its render objects — the way to its instance buffers — still exist.
    members[0]!.visible = true;
    batcher.update(camera);
    expect(batcher.diagnostics().groups).toBe(1);
    let again: THREE.InstancedMesh | null = null;
    scene.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh === true) again = o as THREE.InstancedMesh;
    });
    const extra2 = [{}];
    const r2 = stubRenderer([{ object: again, geometry, extra: extra2 }]);
    const untrack2 = trackRenderer(r2.renderer);
    material.dispose();
    expect(r2.deleted).toEqual(extra2);
    let left = 0;
    scene.traverse((o) => void ((o as THREE.InstancedMesh).isInstancedMesh === true && (left += 1)));
    expect(left).toBe(0);
    untrack();
    untrack2();
    batcher.dispose();
  });
});
