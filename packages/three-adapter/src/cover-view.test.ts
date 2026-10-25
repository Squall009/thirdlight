/**
 * Ground cover on a block layer, through the one GPU renderer: the chunks
 * the rule's reach meets get point sets (made on the page here, the
 * worker's generator), drawn per ring and thinned with distance as a
 * terrain's cover is; an edit bakes the chunks round it again (the old
 * points drawn until the new ones arrive), and sets the view left are let
 * go. A model object's upward faces and architecture's floors get point
 * sets the same way. The vertex stage's keep test is held to its CPU
 * reference, and its WGSL builds.
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { BlockGrid, bakeCoverPoints, blockChunkRect, blockScatterSurface, coverPointAt, type BlockChunk, type BlockLayerComponent, type BlockType, type ScatterRule } from '@thirdlight/runtime';

import { COVER_DRAW_KEY, coverPointsPlacement, installCoverPlacement } from './cover-gpu';
import { coverPointKept, coverShare, planCover } from './cover-placement';
import { COVER_POINT_BLOCK, listCoverPointBlocks } from './cover-points-gpu';
import { CoverView } from './cover-view';
import { ProgramWarmer, type WarmDraw } from './program-warmer';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';
import { CullView } from './view-cull';
import type { ModelInstance } from './visual';

const GRASS: ScatterRule = { id: 'grass', asset: { assetId: 'tuft' }, density: 2, cover: true, coverDistance: 40, blocks: ['soil'] };
const TYPES: BlockType[] = [{ blockId: 'soil', name: 'Soil', variants: [{ color: '#556b2f' }], shape: 'full' } as BlockType, { blockId: 'rock', name: 'Rock', variants: [{ color: '#777777' }], shape: 'full' } as BlockType];

/** A 128 × 128 m layer of 1 m cells, one row of soil (rock from x = 64 on). */
function layer(rules: ScatterRule[] = [GRASS]): { component: BlockLayerComponent; chunks: BlockChunk[] } {
  const chunks: BlockChunk[] = [];
  for (let cz = 0; cz < 8; cz++) for (let cx = 0; cx < 8; cx++) chunks.push(chunkOf(cx, cz, cx < 4 ? 0 : 1));
  return { component: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [128, 4, 128] }, scatter: rules } as BlockLayerComponent, chunks };
}

function chunkOf(cx: number, cz: number, block: number): BlockChunk {
  const columns: number[][] = [];
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) columns.push([x, z, 0, 1, block]);
  return { cx, cz, palette: [{ block: 'soil' }, { block: 'rock' }], columns };
}

function view(x: number, z: number): CullView {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  cam.position.set(x, 2, z);
  cam.lookAt(x, 0, z + 10);
  cam.updateMatrixWorld();
  const v = new CullView();
  v.set(cam);
  return v;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function tuft(): ModelInstance {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5), new MeshStandardNodeMaterial()));
  return { glbRoot: root } as unknown as ModelInstance;
}

describe('ground cover on block layers', () => {
  it('draws the chunks the reach meets from point sets, bakes them again round an edit, lets go of those the view left', async () => {
    const template = tuft();
    const listed = new Set<THREE.Object3D>();
    const cover = new CoverView({ template: () => template, place: (r, on) => void (on ? listed.add(r) : listed.delete(r)), tile: () => undefined, surface: () => null });
    cover.setTypes(TYPES);
    const { component, chunks } = layer();
    cover.setBlockLayer('layer', component, [0, 0, 0], chunks);
    const run = async (x: number, z: number, frames: number): Promise<void> => {
      for (let i = 0; i < frames; i++) {
        cover.update(view(x, z));
        await flush();
      }
    };
    // On the soil, 20 m in: the 16 chunks within 40 m (all soil) get their sets, about 2 points a m².
    await run(20, 20, 3);
    let g = cover.diagnostics().gpu!;
    expect(g.pointSets).toBe(16);
    expect(g.pointsPending).toBe(0);
    expect(g.points / (16 * 256 * 2)).toBeGreaterThan(0.9);
    expect(g.points / (16 * 256 * 2)).toBeLessThan(1.1);
    expect(g.draws).toBeGreaterThan(0);
    expect(g.candidates).toBeGreaterThan(0);
    expect(g.candidates % COVER_POINT_BLOCK).toBe(0);
    expect(listed.size).toBeGreaterThan(0);
    const before = g.points;
    // Chunk (0, 0) turned to rock: its old points stay drawn until its new set (none) arrives; the chunks round it are baked again too.
    cover.replaceBlockChunks('layer', [{ cx: 0, cz: 0, chunk: chunkOf(0, 0, 1) }]);
    expect(cover.diagnostics().gpu!.points).toBe(before);
    await run(20, 20, 2);
    g = cover.diagnostics().gpu!;
    expect(g.pointsPending).toBe(0);
    expect(before - g.points).toBeGreaterThan(400);
    expect(before - g.points).toBeLessThan(620);
    // Far off the layer: nothing listed, and the sets let go after a while.
    await run(600, 600, 400);
    g = cover.diagnostics().gpu!;
    expect(g.draws).toBe(0);
    expect(g.pointSets).toBe(0);
    expect(listed.size).toBe(0);
    cover.dispose();
  });

  it('grows on a model object\'s upward faces where it settles and on architecture\'s floors, and lets both go', async () => {
    const template = tuft();
    // An 8 × 8 m slab facing up (a plane turned flat inside the model), its object turned a quarter about up.
    const slab = new THREE.Group();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new MeshStandardNodeMaterial());
    plane.rotation.x = -Math.PI / 2;
    slab.add(plane);
    const world = new THREE.Matrix4().compose(new THREE.Vector3(20, 1, 20), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), new THREE.Vector3(1, 1, 1));
    const cover = new CoverView({
      template: (id) => (id === 'slab' ? ({ glbRoot: slab } as unknown as ModelInstance) : template),
      place: () => undefined,
      tile: () => undefined,
      surface: () => null,
      worldMatrix: (id, out) => (id === 'rock' ? (out.copy(world), true) : false),
    });
    const moss: ScatterRule = { id: 'moss', asset: { assetId: 'tuft' }, density: 2, cover: true, coverDistance: 40 };
    cover.setModel('rock', { asset: { assetId: 'slab' }, scatter: [moss] });
    const run = async (frames: number): Promise<void> => {
      for (let i = 0; i < frames; i++) {
        cover.update(view(20, 10));
        await flush();
      }
    };
    // Baked once it has stood still a few frames: about 2 points a m² of its 64.
    await run(4);
    expect(cover.diagnostics().gpu?.pointSets ?? 0).toBe(0);
    await run(12);
    let g = cover.diagnostics().gpu!;
    expect(g.pointsPending).toBe(0);
    expect(g.points / 128).toBeGreaterThan(0.85);
    expect(g.points / 128).toBeLessThan(1.15);
    // A generated floor (6 × 4 m) beside it: its points join, in their own source.
    const floors = Float32Array.from([0, 0, 0, 0, 0, 4, 6, 0, 4, 0, 0, 0, 6, 0, 4, 6, 0, 0]);
    cover.setArchitecture('house', [moss], [10, 0, 10], floors);
    await run(3);
    g = cover.diagnostics().gpu!;
    expect(cover.diagnostics().sources).toBe(2);
    expect((g.points - 128) / 48).toBeGreaterThan(0.6);
    // The object let go (and not realized again): its cover goes; the floors' without rules too.
    cover.setModel('rock', null);
    cover.setArchitecture('house', undefined, [10, 0, 10], null);
    await run(2);
    expect(cover.diagnostics().sources).toBe(0);
    cover.dispose();
  });

  it('keeps the rule\'s density near the eye and thins it with distance, each point drawn by one ring, every kept point listed', () => {
    const rule: ScatterRule = { id: 'm', asset: { assetId: 'tuft' }, density: 4, cover: true, coverDistance: 60, blocks: ['soil'] };
    const all = layer([rule]);
    const soil = { ...all, chunks: all.chunks.map((c) => chunkOf(c.cx, c.cz, 0)) };
    const grid = BlockGrid.from(soil.component, { entityId: 'l', chunks: soil.chunks });
    const surface = blockScatterSurface({ grid, types: new Map(TYPES.map((t) => [t.blockId, t])), origin: [0, 0, 0], topSubdivision: 1 });
    const plan = planCover(rule, 60, { distances: [0, 20], culls: false, radius: 0.3 }, 16);
    const eye: [number, number] = [64, 64];
    const kept: { x: number; z: number; ring: number }[] = [];
    for (let cz = 0; cz < 8; cz++) {
      for (let cx = 0; cx < 8; cx++) {
        const set = bakeCoverPoints(rule, surface, blockChunkRect([0, 0, 0], [1, 1, 1], cx, cz), [0, 0, 0]);
        plan.rings.forEach((ring, k) => {
          const out = new Float32Array(4 * 64);
          const n = listCoverPointBlocks(ring, { cx, cz, set, slots: [...Array(64).keys()] }, out, 0);
          let listed = 0;
          for (let i = 0; i < n; i++) listed += out[i * 4 + 1]!;
          for (let i = 0; i < set.count; i++) {
            const p = coverPointAt(set, i);
            if (!coverPointKept(p, ring, plan.thinning, eye)) continue;
            kept.push({ x: p.x, z: p.z, ring: k });
            // A kept point lies in the prefix the ring lists.
            expect(i).toBeLessThan(listed);
          }
        });
      }
    }
    const seen = new Set<string>();
    for (const p of kept) {
      const key = `${p.x.toFixed(4)},${p.z.toFixed(4)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    const band = (a: number, b: number): number => kept.filter((p) => Math.hypot(p.x - eye[0], p.z - eye[1]) >= a && Math.hypot(p.x - eye[0], p.z - eye[1]) < b).length / (Math.PI * (b * b - a * a));
    const want = (a: number, b: number): number => {
      let sum = 0;
      for (let k = 0; k < 64; k++) {
        const d = a + ((k + 0.5) / 64) * (b - a);
        sum += rule.density * coverShare(plan.thinning, d) * d;
      }
      return sum / (((a + b) / 2) * 64);
    };
    for (const [a, b] of [[0, 15], [15, 30], [30, 42], [42, 52], [52, 57]] as const) expect(band(a, b) / want(a, b)).toBeGreaterThan(0.9), expect(band(a, b) / want(a, b)).toBeLessThan(1.1);
    expect(kept.every((p) => Math.hypot(p.x - eye[0], p.z - eye[1]) < 60)).toBe(true);
  });

  it("builds every ring's programs ahead of its first draw, and keeps its draws when the point texture grows", async () => {
    installCoverPlacement();
    const template = tuft();
    const listed = new Set<THREE.Object3D>();
    let wanted = 0;
    let idle = true;
    const warmer = new ProgramWarmer({ idle: () => idle, want: () => void (wanted += 1) });
    const handed: WarmDraw[] = [];
    // Dense enough that the sets near the layer outgrow the point texture's first size.
    const dense: ScatterRule = { ...GRASS, density: 8 };
    const cover = new CoverView({ template: () => template, place: (r, on) => void (on ? listed.add(r) : listed.delete(r)), tile: () => undefined, surface: () => null, warm: (w) => (handed.push(w), warmer.add(w)) });
    cover.setTypes(TYPES);
    const { component, chunks } = layer([dense]);
    cover.setBlockLayer('layer', component, [0, 0, 0], chunks);
    // Far from the layer: no ring reaches it, yet each ring's draws are made and handed over.
    cover.update(view(-400, -400));
    const rings = planCover(dense, 40, { distances: [0], culls: false, radius: 0.25 }, 16).rings.length;
    expect(handed.length).toBe(rings);
    expect(listed.size).toBe(0);
    // Held for the precompile: in the scene, shown, more than one copy (three keys such a draw by its mesh, as when it lists copies).
    idle = false;
    warmer.frame();
    expect(wanted).toBe(1);
    expect(listed.size).toBe(rings);
    const held = [...listed].flatMap((r) => r.children as THREE.Mesh[]);
    expect(held.every((m) => m.visible && (m as unknown as { count: number }).count > 1)).toBe(true);
    // Its WGSL builds as held (the program the precompile makes is the one the ring draws with).
    const scene = litScene();
    expect(wgslOf(wgslRenderer(), scene, held[0]!)).toMatch(/instance_index/);
    // The precompile ran: they go back to drawing nothing, out of the scene.
    idle = true;
    cover.update(view(-400, -400));
    warmer.frame();
    expect(listed.size).toBe(0);
    expect(held.every((m) => !m.visible)).toBe(true);
    expect(warmer.stats()).toEqual({ warmed: rings, waiting: 0 });
    // On the layer: its sets arrive (the point texture grows) and every ring draws with the draws built ahead.
    for (let i = 0; i < 4; i++) {
      cover.update(view(20, 20));
      await flush();
    }
    const g = cover.diagnostics().gpu!;
    expect(g.points).toBeGreaterThan(64 * COVER_POINT_BLOCK);
    const drawn = cover.meshes();
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((m) => held.includes(m))).toBe(true);
    expect(handed.length).toBe(rings);
  });

  it('builds its vertex stage for a mesh of the model (the WGSL three makes from it, the same nodes WebGL 2 builds)', () => {
    installCoverPlacement();
    const plan = planCover(GRASS, 40, { distances: [0], culls: false, radius: 0.3 }, 16);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 0.1), new MeshStandardNodeMaterial());
    const blocks = new THREE.DataTexture(new Float32Array(1024 * 4), 1024, 1, THREE.RGBAFormat, THREE.FloatType);
    const points = new THREE.DataTexture(new Float32Array(1024 * 4 * 16), 1024, 16, THREE.RGBAFormat, THREE.FloatType);
    mesh.userData[COVER_DRAW_KEY] = coverPointsPlacement({ ring: plan.rings[0]!, plan, rule: { ...GRASS, align: 1 }, blocks, points, chunk: [16, 16], eye: TSL.uniform(new THREE.Vector2()), local: new THREE.Matrix4() });
    (mesh as unknown as { count: number }).count = 512;
    const scene = litScene();
    scene.add(mesh);
    const wgsl = wgslOf(wgslRenderer(), scene, mesh);
    expect(wgsl).toMatch(/instance_index/);
    expect(wgsl).toMatch(/textureLoad/);
  });
});
