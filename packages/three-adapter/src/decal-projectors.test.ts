/**
 * The decal host's changes in place: a moved decal, scripts' spawns, the
 * transient budget (oldest fade first), lifetimes, removal, a run's clear,
 * spawns stuck to an object, and the overlap budget's problem. The table and
 * index are read back from the host's data; no GPU.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { DECAL_CELL_BUDGET, DECAL_TRANSIENT_BUDGET, DECAL_TRANSIENT_FADE_SECONDS } from '@thirdlight/runtime';

import { DECAL_ROW_TEXELS, decalRowsAt, type DecalIndex } from './decal-index';
import { createDecalProjectors, type DecalRequestLike } from './decal-projectors';
import { createMaterialLibrary } from './material-library';
import { ProjectedDecals, projectedDecalsOf } from './projected-decals';
import { settle, testTexture } from './test-wgsl';

/** A renderer that draws nothing (the view's pages need a GPU: the table and index are what these read). */
const renderer = { getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0, setRenderTarget: () => undefined, render: () => undefined } as unknown as Parameters<ReturnType<typeof createDecalProjectors>['beforeFrame']>[0];

async function host(extra: { onProblem?: (code: string, message: string) => void } = {}) {
  const tex = testTexture();
  const library = createMaterialLibrary({ loadTexture: async () => tex });
  library.setMaterials([{ materialId: 'stain', name: 'stain', shader: 'decal', params: { color: '#804020' }, textures: { map: 'tex' } }]);
  const scene = new THREE.Scene();
  let clock = 0;
  const held = new Map<string, string>();
  const h = createDecalProjectors({ scene, materialOf: (k, id) => library.projectedDecal!(k, id), holdPages: (k, id) => (id === null ? held.delete(k) : held.set(k, id)), now: () => clock, ...extra });
  // The material's image first (an albedo on its way marks nothing yet).
  library.projectedDecal!('probe', 'stain');
  await settle();
  return { h, scene, held, tick: (seconds: number) => (clock += seconds * 1000) };
}

const spawnAt = (handle: number, x: number, more: Partial<DecalRequestLike> = {}): DecalRequestLike => ({ op: 'spawn', handle, entityId: null, decal: { size: [0.4, 0.4, 0.4], material: 'stain' }, position: [x, 0, 0], rotation: [0, 0, 0, 1], lifetime: 0, ...more });

/** How many decals the scene's index lists at a world point (read from the data texture the shader reads), and whether a small object there is reached. */
function listedAt(scene: THREE.Scene, x: number): number {
  const d = projectedDecalsOf(scene);
  if (d === null) return 0;
  const data = d.data.image.data as Float32Array;
  const view: DecalIndex = { origin: [d.origin.x, d.origin.y, d.origin.z], invCell: [d.invCell.x, d.invCell.y, d.invCell.z], mask: d.origin.w, probes: d.invCell.w, data: data.subarray(d.layout.x * 4), height: 0, cells: 0, entries: 0, dropped: 0, droppedDecals: 0 };
  const listed = decalRowsAt(view, { x, y: 0, z: 0 }).length;
  const probe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05));
  probe.position.set(x, 0, 0);
  probe.updateMatrixWorld();
  // The CPU's reach test agrees with the index.
  expect(d.hits(probe)).toBe(listed > 0);
  return listed;
}

describe('the decal host changing in place', () => {
  it('a moved decal is written again where it is, without a whole build', async () => {
    const { h, scene } = await host();
    const node = new THREE.Object3D();
    scene.add(node);
    h.set('d1', node, { size: [1, 1, 1], material: 'stain' });
    h.beforeFrame(renderer);
    expect(h.observe()).toMatchObject({ drawn: 1, builds: 1, updates: 0 });
    expect(listedAt(scene, 0)).toBe(1);
    for (let k = 1; k <= 10; k++) {
      node.position.set(k * 3, 0, 0);
      h.beforeFrame(renderer);
    }
    const o = h.observe();
    expect(o.builds).toBe(1);
    expect(o.updates).toBe(10);
    expect(o.updateMs).toBeLessThan(5);
    expect(listedAt(scene, 0)).toBe(0);
    expect(listedAt(scene, 30)).toBe(1);
    h.dispose();
  });

  it('spawns go in without a build; past the transient budget the oldest fade out first; a clear takes the rest', async () => {
    const { h, scene, held, tick } = await host();
    h.beforeFrame(renderer, [spawnAt(1, 0)]);
    expect(h.observe()).toMatchObject({ spawned: 1, drawn: 1 });
    expect(held.get('projected:#1')).toBe('stain');
    const builds = h.observe().builds;
    // A burst past the budget: the oldest start fading, the newest stay.
    const burst = Array.from({ length: DECAL_TRANSIENT_BUDGET + 4 }, (_, i) => spawnAt(i + 2, 2 + (i % 50) * 0.5, { position: [2 + (i % 50) * 0.5, Math.floor(i / 50), 0] }));
    for (let i = 0; i < burst.length; i += 32) h.beforeFrame(renderer, burst.slice(i, i + 32));
    let o = h.observe();
    expect(o.spawned).toBe(DECAL_TRANSIENT_BUDGET + 5);
    expect(o.fading).toBe(5);
    // A table with room for them: a build or two as it grows, never one a spawn.
    expect(o.builds - builds).toBeLessThanOrEqual(3);
    // Half-way: fading, still drawn; then past the fade (frames of 0.1 s).
    for (let t = 0; t < DECAL_TRANSIENT_FADE_SECONDS / 2; t += 0.1) {
      tick(0.1);
      h.beforeFrame(renderer);
    }
    expect(h.observe().fading).toBe(5);
    for (let t = 0; t < DECAL_TRANSIENT_FADE_SECONDS; t += 0.1) {
      tick(0.1);
      h.beforeFrame(renderer);
    }
    o = h.observe();
    expect(o.spawned).toBe(DECAL_TRANSIENT_BUDGET);
    expect(o.fading).toBe(0);
    // The first spawned (handle 1) was the oldest: gone, its pages let go.
    expect(held.has('projected:#1')).toBe(false);
    expect(listedAt(scene, 0)).toBe(0);
    h.beforeFrame(renderer, [{ ...spawnAt(0, 0), op: 'clear' }]);
    expect(h.observe()).toMatchObject({ spawned: 0, drawn: 0 });
    expect(held.size).toBe(0);
    expect(projectedDecalsOf(scene)).toBeNull();
    h.dispose();
  });

  it('a lifetime fades a spawn out at its end; a removal fades it now; a pause stops the clock', async () => {
    const { h, tick } = await host();
    h.beforeFrame(renderer, [spawnAt(1, 0, { lifetime: 3 }), spawnAt(2, 2)]);
    tick(1.5);
    h.beforeFrame(renderer);
    expect(h.observe()).toMatchObject({ spawned: 2, fading: 0 });
    tick(10);
    h.beforeFrame(renderer, [], undefined, true);
    expect(h.observe()).toMatchObject({ spawned: 2, fading: 0 });
    // Frames step at most a quarter second: the end comes over a few frames.
    for (let k = 0; k < 12; k++) {
      tick(0.25);
      h.beforeFrame(renderer);
    }
    expect(h.observe()).toMatchObject({ spawned: 1, fading: 0 });
    h.beforeFrame(renderer, [{ ...spawnAt(2, 0), op: 'remove' }]);
    expect(h.observe().fading).toBe(1);
    for (let k = 0; k < 6; k++) {
      tick(0.25);
      h.beforeFrame(renderer);
    }
    expect(h.observe().spawned).toBe(0);
    h.dispose();
  });

  it('a spawn stuck to an object moves with it and goes with it', async () => {
    const { h, scene } = await host();
    const door = new THREE.Object3D();
    scene.add(door);
    const objects = new Map<string, THREE.Object3D>([['door', door]]);
    const objectOf = (id: string): THREE.Object3D | null => objects.get(id) ?? null;
    h.beforeFrame(renderer, [spawnAt(1, 0, { entityId: 'door', position: [1, 0, 0] })], objectOf);
    expect(listedAt(scene, 1)).toBe(1);
    door.position.set(10, 0, 0);
    h.beforeFrame(renderer, [], objectOf);
    expect(listedAt(scene, 1)).toBe(0);
    expect(listedAt(scene, 11)).toBe(1);
    // On an object that is not loaded: nothing.
    h.beforeFrame(renderer, [spawnAt(2, 0, { entityId: 'gone' })], objectOf);
    expect(h.observe().spawned).toBe(1);
    // The object leaves: its spawns go too.
    h.remove('door');
    h.beforeFrame(renderer, [], objectOf);
    expect(h.observe().spawned).toBe(0);
    h.dispose();
  });

  it('reports the overlap budget once, when a cell first drops a decal', async () => {
    const problems: string[] = [];
    const { h } = await host({ onProblem: (code) => problems.push(code) });
    h.beforeFrame(renderer, Array.from({ length: DECAL_CELL_BUDGET }, (_, i) => spawnAt(i + 1, 0)));
    expect(problems).toEqual([]);
    h.beforeFrame(renderer, [spawnAt(100, 0), spawnAt(101, 0)]);
    expect(h.observe().dropped).toBeGreaterThan(0);
    h.beforeFrame(renderer, [spawnAt(102, 0)]);
    expect(problems).toEqual(['decal_overlap']);
    h.dispose();
  });
});

describe('the channels a projected decal sets', () => {
  it('only those it has an image or a value for: no tint without a colour, no ORM from an emissive mask alone', async () => {
    const tex = testTexture();
    const library = createMaterialLibrary({ loadTexture: async () => tex });
    library.setMaterials([
      { materialId: 'crack', name: 'crack', shader: 'decal', params: {}, textures: { normalMap: 'tex' } },
      { materialId: 'wet', name: 'wet', shader: 'decal', params: { roughness: 0.1 }, textures: {} },
      { materialId: 'rune', name: 'rune', shader: 'decal', params: { emissive: '#40c0ff', emissiveIntensity: 3 }, textures: { emissiveMap: 'tex' } },
      { materialId: 'grime', name: 'grime', shader: 'decal', params: {}, textures: { ormMap: 'tex' } },
      { materialId: 'paint', name: 'paint', shader: 'decal', params: { color: '#c02020' }, textures: {} },
      { materialId: 'stain', name: 'stain', shader: 'decal', params: {}, textures: { map: 'tex' } },
    ]);
    const scene = new THREE.Scene();
    const h = createDecalProjectors({ scene, materialOf: (k, id) => library.projectedDecal!(k, id) });
    const ids = ['crack', 'wet', 'rune', 'grime', 'paint', 'stain'];
    for (const id of ids) library.projectedDecal!(`probe:${id}`, id);
    await settle();
    ids.forEach((id, k) => {
      const node = new THREE.Object3D();
      node.position.set(k * 10, 0, 0);
      scene.add(node);
      h.set(id, node, { size: [1, 1, 1], material: id });
    });
    h.beforeFrame(renderer);
    expect(h.observe().drawn).toBe(ids.length);
    const data = projectedDecalsOf(scene)!.data.image.data as Float32Array;
    // Albedo, normal, roughness, metalness, occlusion, emission (a row's texels 5 and 6).
    const opacity = (k: number): number[] => [...data.subarray(k * DECAL_ROW_TEXELS * 4 + 20, k * DECAL_ROW_TEXELS * 4 + 26)].map((v) => (v > 0 ? 1 : 0));
    expect(opacity(0)).toEqual([0, 1, 0, 0, 0, 0]);
    expect(opacity(1)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(opacity(2)).toEqual([0, 0, 0, 0, 0, 1]);
    expect(opacity(3)).toEqual([0, 0, 1, 1, 1, 0]);
    expect(opacity(4)).toEqual([1, 0, 0, 0, 0, 0]);
    expect(opacity(5)).toEqual([1, 0, 0, 0, 0, 0]);
    h.dispose();
  });
});

describe('the normal fade at its largest angle', () => {
  it('marks every facing, back faces too, as the clipper keeps them', async () => {
    const { h, scene } = await host();
    const node = new THREE.Object3D();
    scene.add(node);
    h.set('all', node, { size: [1, 1, 1], material: 'stain', normalFade: 180 });
    h.beforeFrame(renderer);
    const data = projectedDecalsOf(scene)!.data.image.data as Float32Array;
    // The shader's smoothstep(fade, full, facing) is 1 for any facing in −1…1.
    expect(data[27]!).toBeLessThan(-1);
    h.dispose();
  });
});

describe('the objects a changed decal can reach', () => {
  it('are found again only near it: a kept test is brought up to date through the decals that changed', () => {
    const decals = new ProjectedDecals();
    decals.setBoxes([{ min: [-1, -1, -1], max: [1, 1, 1], layerMask: 255 }]);
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    a.updateMatrixWorld();
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    b.position.set(10, 0, 0);
    b.updateMatrixWorld();
    expect(decals.hits(a)).toBe(true);
    expect(decals.hits(b)).toBe(false);
    // The decal moves from a to b: a loses it, b gains it.
    decals.setBox(0, { min: [9, -1, -1], max: [11, 1, 1], layerMask: 255 });
    expect(decals.hits(a)).toBe(false);
    expect(decals.hits(b)).toBe(true);
    // A second decal comes at a: a gains it, b keeps the first.
    decals.setBox(1, { min: [-1, -1, -1], max: [1, 1, 1], layerMask: 255 });
    expect(decals.hits(a)).toBe(true);
    expect(decals.hits(b)).toBe(true);
    // Both go.
    decals.setBox(0, undefined);
    decals.setBox(1, undefined);
    expect(decals.hits(a)).toBe(false);
    expect(decals.hits(b)).toBe(false);
    expect(decals.count).toBe(0);
  });
});
