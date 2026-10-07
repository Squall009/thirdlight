/**
 * The scatter view: a block layer's chunks and a terrain's tile blobs come
 * in as the block and terrain views get them; each rule's copies are drawn
 * per group as one instance set, built again only where a cell changed, the
 * copies where the stored data put them.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bakeScatterCell, encodeChunkScatter, scatterBlobOf, type BlockChunk, type BlockLayerComponent, type ScatterGround, type ScatterRule, type ScatterSurface, type TerrainComponent } from '@thirdlight/runtime';

import { CUTAWAY_LAYER } from './block-cutaway-view';
import { ScatterView } from './scatter-view';
import { SHADOW_RING_METRES } from './scatter-shadows';
import { CullView } from './view-cull';
import type { ModelInstance } from './visual';

const RULE: ScatterRule = { id: 'trees', asset: { assetId: 'tree' }, density: 0.25, castShadow: true };

/** Flat ground at y = 1. */
const FLAT: ScatterSurface = {
  at(x, z) {
    return { x, y: 1, z, slope: 0, wall: false, nx: 0, ny: 1, nz: 0, cavity: () => 0, layer: () => 1 } as ScatterGround;
  },
};

function template(): ModelInstance {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1), new THREE.MeshBasicMaterial()));
  return { glbRoot: root } as unknown as ModelInstance;
}

function host(read?: (digest: string) => Promise<ArrayBuffer>) {
  const listed = new Set<THREE.Object3D>();
  let shapes = 0;
  const t = template();
  const view = new ScatterView({
    template: () => t,
    read: read ?? null,
    place: (root, shown) => void (shown ? listed.add(root) : listed.delete(root)),
    shapeChanged: () => void (shapes += 1),
  });
  return { view, listed, shapes: () => shapes };
}

const chunk = (cx: number, cz: number, size: number): BlockChunk => {
  const cell = bakeScatterCell([RULE], FLAT, null, [cx * size, cz * size, (cx + 1) * size, (cz + 1) * size], null, [0, 0, 0]).cell;
  return { cx, cz, palette: [], columns: [], scatter: encodeChunkScatter(cell)! };
};

describe('scatter view', () => {
  it('draws a block layer\'s copies, one set per rule and group, rebuilt only where a chunk changed', () => {
    const { view, listed, shapes } = host();
    const comp = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [64, 8, 64] }, scatter: [RULE] } as unknown as BlockLayerComponent;
    view.setBlockLayer('layer', comp, [10, 0, 0], [chunk(0, 0, 16), chunk(1, 0, 16)]);
    expect(view.update()).toBe(true);
    const d = view.diagnostics();
    expect(d.sets).toBe(1);
    expect(d.copies).toBeGreaterThan(100);
    expect(listed.size).toBe(1);
    expect(shapes()).toBe(1);
    // The group sits at the layer's origin: a copy's world x is the stored x plus 10.
    const mesh = view.meshes()[0]!;
    mesh.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    expect(p.x).toBeGreaterThan(10);
    // Nothing changed: nothing built.
    expect(view.update()).toBe(false);
    // A chunk's scatter gone: the group is built again with fewer copies.
    view.replaceBlockChunks('layer', [{ cx: 1, cz: 0, chunk: { cx: 1, cz: 0, palette: [], columns: [] } }]);
    expect(view.update()).toBe(true);
    expect(view.diagnostics().copies).toBeLessThan(d.copies);
    view.setHidden('layer', true);
    expect(listed.size).toBe(0);
    view.remove('layer');
    expect(view.ids()).toEqual([]);
  });

  it('reads a terrain\'s tile blobs and draws them once read', async () => {
    const blobs = new Map<string, Uint8Array>();
    const tiles = [0, 1].map((x) => {
      const cell = bakeScatterCell([RULE], FLAT, null, [x * 64, 0, x * 64 + 64, 64], null, [0, 0, 0]).cell;
      const digest = String(x).repeat(64);
      blobs.set(digest, scatterBlobOf(cell)!);
      return { x, z: 0, scatter: digest };
    });
    const { view } = host(async (d) => blobs.get(d)!.slice().buffer);
    const comp = { tileSamples: 33, spacing: 2, heightRange: [0, 10], tiles, scatter: [RULE] } as TerrainComponent;
    view.setTerrain('ground', comp, [0, 0, 0]);
    // Not read yet: nothing to build.
    expect(view.update()).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(view.update()).toBe(true);
    // Both tiles (64 m each) fall in one group: one set.
    expect(view.diagnostics()).toMatchObject({ sources: 1, cells: 2, groups: 1, sets: 1 });
    // A terrain without rules draws nothing.
    view.setTerrain('ground', { ...comp, scatter: [] }, [0, 0, 0]);
    expect(view.update()).toBe(true);
    expect(view.diagnostics().sets).toBe(0);
  });

  it('the foliage policy: near copies cast from shadow-only squares around the eye, blobs under every copy', () => {
    const near: ScatterRule = { ...RULE, castShadow: true, shadowDistance: 40, blobShadow: 0.5 };
    const { view, listed } = host();
    const comp = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [512, 8, 512] }, scatter: [near] } as unknown as BlockLayerComponent;
    const chunks: BlockChunk[] = [];
    for (let cz = 0; cz < 16; cz++) for (let cx = 0; cx < 16; cx++) chunks.push(chunk(cx, cz, 16));
    view.setBlockLayer('layer', comp, [0, 0, 0], chunks);
    const eyeAt = (x: number, z: number): CullView => {
      const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
      cam.position.set(x, 2, z);
      cam.updateMatrixWorld();
      const v = new CullView();
      v.set(cam);
      return v;
    };
    for (let i = 0; i < 20; i++) view.update(eyeAt(100, 100));
    const all = view.meshes();
    // The copies' own draws cast nothing; the blobs (a disc each) neither cast nor take shadows.
    expect(all.filter((m) => m.castShadow).length).toBe(0);
    expect(view.diagnostics().sets).toBe(2);
    // Shadow-only squares: in the shadow cameras' layer, within the distance of the eye (and their copies only near it).
    const roots = [...listed].filter((r) => r.name.startsWith('scatter-shadow:'));
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) {
      const [ix, iz] = r.name.split(':').pop()!.split(',').map(Number) as [number, number];
      const dx = Math.max(ix * SHADOW_RING_METRES - 100, 0, 100 - (ix + 1) * SHADOW_RING_METRES);
      const dz = Math.max(iz * SHADOW_RING_METRES - 100, 0, 100 - (iz + 1) * SHADOW_RING_METRES);
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(40);
      r.traverse((o) => {
        if ((o as THREE.Mesh).isMesh !== true) return;
        expect(o.layers.isEnabled(CUTAWAY_LAYER) && !o.layers.isEnabled(0)).toBe(true);
        expect((o as THREE.Mesh).castShadow).toBe(true);
      });
    }
    // The eye moves: the squares it left go (past the distance and half a square), others come.
    const before = new Set(roots.map((r) => r.name));
    for (let i = 0; i < 20; i++) view.update(eyeAt(220, 220));
    const after = [...listed].filter((r) => r.name.startsWith('scatter-shadow:')).map((r) => r.name);
    expect(after.some((n) => !before.has(n))).toBe(true);
    expect([...before].some((n) => !after.includes(n))).toBe(true);
  });
});
