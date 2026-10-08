/**
 * World streaming on the page: which cells a view holds (the ring, then the
 * hysteresis while the budget has room, the rings never cut and their
 * overflow reported once), cells let go through the resource manager (freed
 * at its settle, kept when taken again first), and the block view and the
 * scatter view keeping only what is round the eye — and the same pixels'
 * worth (the same chunks and copies) back when it returns.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BlockGrid, applyBlockEdits, bakeScatterCell, createResourceManager, scatterBlobOf, type BlockType, type ScatterGround, type ScatterRule, type ScatterSurface, type TerrainComponent } from '@thirdlight/runtime';

import { BlockLayerView } from './block-layers';
import { ScatterView, SCATTER_GROUP_METRES } from './scatter-view';
import { CullView } from './view-cull';
import type { ModelInstance } from './visual';
import { PageWorldStream, WORLD_STREAM_HOLDER } from './world-stream';

const MB = 1024 * 1024;

describe('page world streaming', () => {
  it('holds the ring, then what the hysteresis keeps while the budget has room; the rings alone are never cut but reported once', () => {
    const problems: string[] = [];
    const s = new PageWorldStream({ budgetBytes: 10 * MB, resources: null, onProblem: (code) => problems.push(code) });
    s.beginFrame([0, 0, 0]);
    const ring = { radius: 100, hysteresis: 20 };
    const cells = [
      { key: 'a', d: 0, bytes: 4 * MB, resident: false },
      { key: 'b', d: 90, bytes: 4 * MB, resident: false },
      // Past the ring, within the hysteresis: kept while resident, nearest first, while there is room.
      { key: 'c', d: 105, bytes: 1 * MB, resident: true },
      { key: 'd', d: 110, bytes: 2 * MB, resident: true },
      { key: 'e', d: 112, bytes: 1 * MB, resident: false },
      { key: 'f', d: 130, bytes: 1 * MB, resident: true },
    ];
    expect([...s.residency('terrain-tile', 't', cells, ring)].sort()).toEqual(['a', 'b', 'c']);
    expect(s.diagnostics().kinds['terrain-tile']).toMatchObject({ inRing: 2, kept: 1, evicted: 1 });
    // Asking again replaces the object's last answer (not added to it).
    expect([...s.residency('terrain-tile', 't', cells, ring)].sort()).toEqual(['a', 'b', 'c']);
    expect(s.diagnostics().ringBytes).toBe(8 * MB);
    // Another object's cells count against the same budget: its kept cell has no room left.
    expect([...s.residency('block-chunk', 'b', [{ key: 'y', d: 105, bytes: 2 * MB, resident: true }], ring)]).toEqual([]);
    // Rings over the budget: all of them held, reported once at the next frame (and again only after it went back under).
    expect(s.residency('block-chunk', 'x', [{ key: 'x', d: 0, bytes: 11 * MB, resident: false }], ring).size).toBe(1);
    s.beginFrame([0, 0, 0]);
    s.beginFrame([0, 0, 0]);
    expect(problems).toEqual(['world_streaming_over_budget']);
    expect(s.diagnostics().overBudget).toBe(true);
    s.forgetObject('x');
    s.beginFrame([0, 0, 0]);
    expect(s.diagnostics().overBudget).toBe(false);
  });

  it('a cell let go is freed at the resource manager\'s settle, kept when taken again first, and counted with the page\'s resources', async () => {
    const resources = createResourceManager();
    const s = new PageWorldStream({ budgetBytes: 64 * MB, resources });
    const freed: string[] = [];
    s.hold('block-chunk', 'g/0,0', 1000, () => freed.push('0,0'));
    s.hold('block-chunk', 'g/1,0', 2000, () => freed.push('1,0'));
    await Promise.resolve();
    expect(resources.observe().resident['block-chunk']).toEqual({ count: 2, bytes: 3000 });
    expect(resources.holders('block-chunk', 'g/0,0')).toEqual([WORLD_STREAM_HOLDER]);
    s.release('block-chunk', 'g/0,0');
    s.release('block-chunk', 'g/1,0');
    // Taken again before the settle (the camera turned back): kept.
    s.hold('block-chunk', 'g/1,0', 2500, () => freed.push('1,0 again'));
    expect(s.holds('block-chunk', 'g/0,0')).toBe(false);
    expect(s.has('block-chunk', 'g/0,0')).toBe(true);
    resources.settle();
    expect(freed).toEqual(['0,0']);
    expect(s.has('block-chunk', 'g/0,0')).toBe(false);
    expect(resources.observe().resident['block-chunk']).toEqual({ count: 1, bytes: 2500 });
    expect(s.diagnostics().kinds['block-chunk']).toMatchObject({ resident: 1, bytes: 2500 });
  });
});

const TYPES: BlockType[] = [{ blockId: 'soil', name: 'Soil', variants: [{ color: '#886644' }], shape: 'full' }];

describe('block view streaming', () => {
  it('meshes only the chunks in the render ring round the eye, drops those it left at the settle, and meshes them again on return', async () => {
    // 8 × 1 chunks of 1 m cells along x (128 m), render ring 20 m (hysteresis 2 m).
    const comp = { cellSize: [1, 1, 1] as [number, number, number], bounds: { min: [0, 0, 0] as [number, number, number], max: [128, 2, 16] as [number, number, number] }, streaming: { render: 20, hysteresis: 2 } };
    const g = new BlockGrid(comp);
    applyBlockEdits(g, [{ kind: 'fill', box: [0, 0, 0, 128, 1, 16], cell: { block: 'soil' } }], { types: new Map(TYPES.map((t) => [t.blockId, t])), stamps: new Map() });
    const resources = createResourceManager();
    const stream = new PageWorldStream({ budgetBytes: 64 * MB, resources });
    const view = new BlockLayerView({ stream });
    view.setTypes(TYPES);
    view.setLayer('g', comp, [0, 0, 0], { entityId: 'g', chunks: g.chunkKeys().map((k) => g.encodeChunk(k)!) } as never);
    // A frame, then the page's task ends (the holds' loads settle) and the host settles the manager.
    const frame = async (x: number): Promise<void> => {
      stream.beginFrame([x, 5, 8]);
      view.update([x, 5, 8]);
      await Promise.resolve();
      resources.settle();
    };
    await frame(8);
    // Within 20 m of x = 8: chunks 0 (0–16 m) and 1 (16–32 m, 8 m away); chunk 2 starts 24 m away.
    expect(view.diagnostics().chunks).toBe(2);
    const near = view.layerMeshes('g').map((m) => (m.geometry.getAttribute('position') as THREE.BufferAttribute).count).sort();
    await frame(100);
    // Round x = 100: chunks 4 (64–80, 20 m), 5, 6, 7; 0 and 1 dropped.
    expect(view.diagnostics().chunks).toBe(4);
    expect(stream.diagnostics().kinds['block-chunk']).toMatchObject({ resident: 4, inRing: 4 });
    await frame(8);
    expect(view.diagnostics().chunks).toBe(2);
    // The same meshes back.
    expect(view.layerMeshes('g').map((m) => (m.geometry.getAttribute('position') as THREE.BufferAttribute).count).sort()).toEqual(near);
    expect(resources.observe().frees['block-chunk']).toBe(6);
  });
});

const RULE: ScatterRule = { id: 'trees', asset: { assetId: 'tree' }, density: 0.01 };
const FLAT: ScatterSurface = { at: (x, z) => ({ x, y: 1, z, slope: 0, wall: false, nx: 0, ny: 1, nz: 0, cavity: () => 0, layer: () => 1 }) as ScatterGround };

describe('scatter view streaming', () => {
  it('reads and draws only the groups in the scatter ring; a group left goes at the settle and comes back the same', async () => {
    const tile = 512;
    const blobs = new Map<string, Uint8Array>();
    // Tiles 0 and 8 along x: groups 0 and 2 (four 512 m tiles a group).
    const tiles = [0, 8].map((x) => {
      const cell = bakeScatterCell([RULE], FLAT, null, [x * tile, 0, x * tile + tile, tile], null, [0, 0, 0]).cell;
      const digest = String(x).repeat(64);
      blobs.set(digest, scatterBlobOf(cell)!);
      return { x, z: 0, scatter: digest };
    });
    const reads: string[] = [];
    const resources = createResourceManager();
    const stream = new PageWorldStream({ budgetBytes: 64 * MB, resources });
    const t = { glbRoot: (() => {
      const root = new THREE.Group();
      root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1), new THREE.MeshBasicMaterial()));
      return root;
    })() } as unknown as ModelInstance;
    const view = new ScatterView({ template: () => t, read: async (d) => (reads.push(d), blobs.get(d)!.slice().buffer), place: () => undefined, stream });
    const comp = { tileSamples: 257, spacing: 2, heightRange: [0, 10], tiles, scatter: [RULE], streaming: { render: 3000, scatter: 600 } } as TerrainComponent;
    view.setTerrain('ground', comp, [0, 0, 0]);
    const eye = (x: number): CullView => {
      const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 10_000);
      cam.position.set(x, 2, 100);
      cam.updateMatrixWorld();
      const v = new CullView();
      v.set(cam);
      return v;
    };
    const frame = async (x: number): Promise<void> => {
      stream.beginFrame([x, 2, 100]);
      view.update(eye(x));
      await new Promise((r) => setTimeout(r, 0));
      view.update(eye(x));
      resources.settle();
    };
    await frame(100);
    // Only group 0's tile read and made.
    expect(reads).toEqual(['0'.repeat(64)]);
    const first = view.diagnostics();
    expect(first).toMatchObject({ groups: 1, sets: 1 });
    await frame(2 * SCATTER_GROUP_METRES + 100);
    expect(reads).toEqual(['0'.repeat(64), '8'.repeat(64)]);
    expect(view.diagnostics()).toMatchObject({ groups: 1, sets: 1 });
    await frame(100);
    // Read again (its copies went with it) and made with the same copies.
    expect(reads.length).toBe(3);
    expect(view.diagnostics().copies).toBe(first.copies);
  });
});
