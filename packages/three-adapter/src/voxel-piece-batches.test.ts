/**
 * Kit pieces drawn across chunks: a real chunk view over real derives (a
 * stone wall dressed with a kit coping), its piece draws read back as the
 * GPU would read them, and their per-pass counts as three asks for them
 * right before each draw.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildApron,
  chunkGrid,
  createWorldStore,
  deriveWithApron,
  FloatingOrigin,
  jobRadius,
  joinSectionsForDraw,
  MATERIAL_BITS,
  SHADER_BORDER_CELLS,
  SHADER_READ_DEPTH_CELLS,
  shaderGridSide,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  WETNESS_MAX,
  WORLD_RULES,
  worldPieceTable,
  type ChunkDrawBatch,
  type DerivedData,
  type PaletteStore,
  type PieceTable,
} from '@thirdlight/voxel';
import { INSTANCE_MATRIX_FLOATS } from './attribute-instancing';
import { applyChunkDrawBatch, VoxelChunkView, voxelStandInLook } from './voxel-chunk-view';
import { VoxelKitMeshes, type VoxelKitRecordLike } from './voxel-kit-pieces';
import { PIECE_ANCHOR_REACH_CELLS, PIECE_SOURCE_KEY } from './voxel-piece-batches';
import { createVoxelSurface, type VoxelGridRenderer } from './voxel-surface';
import { PIECE_DATA_FLOATS, PIECE_U_ATTRIBUTE, PIECE_WET_FLOAT } from './voxel-trim-u';

const grid = chunkGrid(32);
const R = jobRadius(WORLD_RULES);
const STONE = 3;
const COPING = { assetId: 'coping', digest: 'c'.repeat(64) };
const CORNER = { assetId: 'corner', digest: 'd'.repeat(64) };
const KITS: VoxelKitRecordLike[] = [{ voxelKitId: 'stone', materials: [STONE], slots: { 'edge-out-top': { meshes: [{ mesh: COPING }] }, 'edge-out-vertical': { meshes: [{ mesh: CORNER }] } } }];

/** Flat ground and a stone wall 12 long and 8 high in chunk 0,0,0 (`wet`: the wall's wetness). */
function world(wet = 0): PaletteStore {
  const s = createWorldStore(grid);
  for (let x = 2; x < 30; x++) for (let z = 2; z < 30; z++) for (let y = 0; y < 4; y++) s.setVoxel(x, y, z, { material: 1, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 });
  for (let x = 8; x < 20; x++) for (let y = 4; y < 12; y++) s.setVoxel(x, y, 16, { material: STONE, role: VOXEL_ROLE.wall, shape: 15, wetness: wet });
  return s;
}

const renderer = (): VoxelGridRenderer => ({ backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined });

function kitSet(): { meshes: VoxelKitMeshes; table: PieceTable } {
  const meshes = new VoxelKitMeshes();
  meshes.add(COPING, new THREE.BoxGeometry(0.5, 0.06, 0.06));
  meshes.add(CORNER, new THREE.BoxGeometry(0.06, 0.5, 0.06));
  return { meshes, table: worldPieceTable(KITS, 0) };
}

function view(origin = { x: 0, y: 0, z: 0 }): { v: VoxelChunkView; meshes: VoxelKitMeshes; table: PieceTable } {
  const { meshes, table } = kitSet();
  const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
  const v = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid, rebaseDistanceM: 1e9, origin }), surface, renderer: renderer(), kits: meshes.set(table, KITS) });
  return { v, meshes, table };
}

const derive = (s: PaletteStore, table: PieceTable): DerivedData => deriveWithApron(grid, WORLD_RULES, buildApron(s, 0, 0, 0, R), (out) => s.exportChunk(0, 0, 0, out), undefined, 0, { table, chunk: [0, 0, 0] });

/** Chunk `cx, 0, cz` drawn from chunk 0,0,0's derive (its shader grid written into the view's cells as a join does). */
function draw(v: VoxelChunkView, d: DerivedData, cx: number, cz = 0): void {
  const j = joinSectionsForDraw(grid.edge, grid.edge, [d], v.cells);
  v.set(cx, 0, cz, { ground: j.ground, base: j.base, instances: j.instances, solid: j.solid });
}

const draws = (v: VoxelChunkView): THREE.InstancedMesh[] => v.pieces.root.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);

/** Every drawn instance as the GPU reads it: its world matrix (rounded to 0.1 mm) and its data quad, by draw, sorted. */
function drawn(v: VoxelChunkView): string[] {
  v.root.updateMatrixWorld(true);
  const out: string[] = [];
  const m = new THREE.Matrix4();
  for (const mesh of draws(v)) {
    const data = mesh.geometry.getAttribute(PIECE_U_ATTRIBUTE) as THREE.InstancedBufferAttribute;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m).premultiply(mesh.matrixWorld);
      const q = Array.from(data.array.subarray(i * PIECE_DATA_FLOATS, (i + 1) * PIECE_DATA_FLOATS));
      const kind = JSON.stringify((mesh.userData[PIECE_SOURCE_KEY] as THREE.BoxGeometry).parameters);
      out.push(`${kind}|${m.elements.map((e) => Math.round(e * 1e4)).join(',')}|${q.join(',')}`);
    }
  }
  return out.sort();
}

/** The world x (metres) of each of the first `n` instances of a draw. */
function xs(mesh: THREE.InstancedMesh, n: number): number[] {
  mesh.updateMatrixWorld(true);
  const m = new THREE.Matrix4();
  return Array.from({ length: n }, (_, i) => new THREE.Vector3().setFromMatrixPosition(mesh.getMatrixAt(i, m).premultiply(mesh.matrixWorld)).x);
}

describe('kit pieces drawn across chunks', () => {
  it('draw one instanced mesh a piece kind for every chunk; adds, removes and swaps leave buffers equal to a rebuild', () => {
    const { v, table } = view();
    const d = derive(world(), table);
    for (let cx = 0; cx < 6; cx++) draw(v, d, cx);
    const per = v.piecesOf(0, 0, 0);
    expect(per).toBeGreaterThan(5);
    // Two piece kinds (coping, corner) over six chunks: two draws, not twelve.
    expect(v.pieceDraws).toBe(2);
    expect(draws(v).length).toBe(2);
    expect(v.instances).toBe(6 * per);
    // Drawn after every surface of the view (three sorts the opaque list by render order first).
    const surfaces: THREE.Mesh[] = [];
    v.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh === true && o.parent !== v.pieces.root) surfaces.push(o as THREE.Mesh);
    });
    expect(surfaces.length).toBeGreaterThan(0);
    for (const m of draws(v)) expect(m.renderOrder).toBeGreaterThan(Math.max(...surfaces.map((x) => x.renderOrder)));
    // Remove, add, swap (a chunk replaced by another derive), in any order.
    v.remove(2, 0, 0);
    v.remove(4, 0, 0);
    draw(v, d, 9);
    draw(v, derive(world(5), table), 1);
    draw(v, d, 3, 4);
    const after = drawn(v);
    // A rebuild of the same chunks in another order.
    const fresh = view().v;
    draw(fresh, d, 3, 4);
    draw(fresh, derive(world(5), table), 1);
    for (const cx of [9, 5, 3, 0]) draw(fresh, d, cx);
    expect(after).toEqual(drawn(fresh));
    expect(v.instances).toBe(fresh.instances);
    // Everything gone: no draw left.
    for (const [cx, cz] of [[0, 0], [1, 0], [3, 0], [5, 0], [9, 0], [3, 4]] as const) v.remove(cx, 0, cz);
    expect([v.instances, v.pieceDraws, v.pieces.root.children.length]).toEqual([0, 0, 0]);
    v.dispose();
    fresh.dispose();
  });

  it('a batch changes its chunks\' pieces together, at its end; a chunk past the anchor\'s reach moves it and nothing moves on screen', () => {
    const { v, table } = view();
    const d = derive(world(), table);
    const j = joinSectionsForDraw(grid.edge, grid.edge, [d], v.cells);
    draw(v, d, 0);
    draw(v, d, 1);
    const before = drawn(v);
    const versions = (): number[] => draws(v).map((m) => m.instanceMatrix.version);
    const was = versions();
    // One streamer task: chunk 1 goes, chunk 2 comes. Inside the batch nothing is written; after it, both at once.
    const chunk = (cx: number): ChunkDrawBatch['chunks'][number] => ({ kind: 'draw', cx, cy: 0, cz: 0, ground: j.ground, base: j.base, instances: j.instances, solid: j.solid, cells: j.solid >= 0 ? undefined : v.cells.slice() }) as unknown as ChunkDrawBatch['chunks'][number];
    let mid: number[] = [];
    v.inBatch(() => {
      v.remove(1, 0, 0);
      mid = versions();
      draw(v, d, 2);
    });
    expect(mid).toEqual(was);
    const moved = drawn(v);
    expect(moved).not.toEqual(before);
    expect(moved.length).toBe(before.length);
    // The same through a streamer batch.
    applyChunkDrawBatch(v, { world: 'w', chunks: [{ kind: 'remove', cx: 2, cy: 0, cz: 0 }, chunk(1)] } as unknown as ChunkDrawBatch);
    expect(drawn(v)).toEqual(before);
    // A chunk 1.6 km out: the anchor moves to it, every instance stays where it was in the world.
    const far = Math.ceil((PIECE_ANCHOR_REACH_CELLS + 1200) / grid.edge);
    const anchorAt = v.pieces.root.position.x;
    draw(v, d, far);
    expect(v.pieces.root.position.x).not.toBe(anchorAt);
    const withFar = drawn(v);
    const alone = view().v;
    for (const cx of [0, 1, far]) draw(alone, d, cx);
    expect(withFar).toEqual(drawn(alone));
    // The far chunk's matrices are small (metres from the anchor, which is its corner now).
    const m = new THREE.Matrix4();
    let near = 0;
    for (const mesh of draws(v)) for (let i = 0; i < mesh.count; i++) if (Math.abs(mesh.getMatrixAt(i, m).elements[12]!) < grid.edge * VOXEL_SIZE_M) near++;
    expect(near).toBe(v.piecesOf(far, 0, 0));
    expect(INSTANCE_MATRIX_FLOATS).toBe(16);
    v.dispose();
    alone.dispose();
  });

  it("each pass draws the leading part it needs: the view its chunks', a still shadow camera its own too, a moved camera everything", async () => {
    const { v, table } = view();
    const d = derive(world(), table);
    // Chunks 0 … 9 along x (16 m each).
    for (let cx = 0; cx < 10; cx++) draw(v, d, cx);
    const scene = new THREE.Scene();
    scene.add(v.root);
    scene.updateMatrixWorld(true);
    const [mesh] = draws(v);
    const total = mesh!.count;
    const per = total / 10;
    // A narrow view looking down −z at chunks 2 and 3 (x 32 … 64 m).
    const cam = new THREE.PerspectiveCamera(20, 1, 0.5, 200);
    cam.position.set(48, 3, 60);
    cam.lookAt(48, 3, 8);
    cam.updateMatrixWorld(true);
    const shadow = new THREE.OrthographicCamera(-8, 8, 8, -8, 1, 400);
    shadow.up.set(0, 0, -1);
    shadow.position.set(136, 100, 8);
    shadow.lookAt(136, 0, 8);
    shadow.updateMatrixWorld(true);
    const r = {} as never;
    const pass = (camera: THREE.Camera, override: boolean): number => {
      scene.overrideMaterial = override ? new THREE.MeshBasicMaterial() : null;
      mesh!.onBeforeRender(r, scene, camera, mesh!.geometry, mesh!.material as THREE.Material, null as never);
      const n = mesh!.count;
      mesh!.onAfterRender(r, scene, camera, mesh!.geometry, mesh!.material as THREE.Material, null as never);
      return n;
    };
    // A camera first met draws everything; from its next pass on, its chunks only.
    expect(pass(cam, false)).toBe(total);
    const inView = pass(cam, false);
    expect(inView).toBeGreaterThan(0);
    expect(inView).toBeLessThan(total / 2);
    expect(inView % per).toBe(0);
    for (const x of xs(mesh!, inView)) expect(x).toBeGreaterThan(16);
    for (const x of xs(mesh!, inView)) expect(x).toBeLessThan(80);
    // Outside a pass the draw holds all.
    expect(mesh!.count).toBe(total);
    // The shadow pass (an override material) over chunk 8: everything at first, then the view's and its own chunks.
    expect(pass(shadow, true)).toBe(total);
    expect(pass(cam, false)).toBe(inView);
    // Its chunks are picked once the frame is drawn (a microtask: never between two passes of a frame).
    await Promise.resolve();
    // Its chunks by their spheres (a chunk's half diagonal and a metre round it): chunk 8 and its two neighbours.
    const inShadow = pass(shadow, true);
    expect(inShadow - inView).toBe(3 * per);
    const own = xs(mesh!, inShadow).slice(inView);
    expect(own.every((x) => x > 112 && x < 160)).toBe(true);
    expect(own.some((x) => x > 128 && x < 144)).toBe(true);
    // The view moves on to chunks 6 and 7: culled again before its next draw, the shadow's part kept.
    cam.position.set(112, 3, 60);
    cam.lookAt(112, 3, 8);
    cam.updateMatrixWorld(true);
    const nextShadow = pass(shadow, true);
    const nextView = pass(cam, false);
    expect(nextView).toBeGreaterThan(0);
    // Chunk 8 is still the shadow's (chunks the view sees too come first, once).
    expect(nextShadow).toBeGreaterThan(nextView);
    expect(nextShadow).toBeLessThan(total);
    expect(xs(mesh!, nextShadow).some((x) => x > 128 && x < 144)).toBe(true);
    for (const x of xs(mesh!, nextView)) expect(x).toBeGreaterThan(80);
    // The shadow camera moves: it draws everything until the view culls for it again.
    shadow.position.x += 64;
    shadow.updateMatrixWorld(true);
    expect(pass(shadow, true)).toBe(total);
    await Promise.resolve();
    expect(pass(cam, false)).toBe(nextView);
    // It now looks at x 192 … 208, past the last chunk: no chunk is its own.
    expect(pass(shadow, true)).toBe(nextView);
    v.dispose();
  });

  it("pieces wear their dressing cell's wetness; a wetness paint (shader data only) rewrites it, no mesh built", () => {
    const { v, table } = view();
    const dry = derive(world(0), table);
    draw(v, dry, 0);
    const wetOf = (): number[] => draws(v).flatMap((m) => Array.from({ length: m.count }, (_, i) => (m.geometry.getAttribute(PIECE_U_ATTRIBUTE) as THREE.InstancedBufferAttribute).array[i * PIECE_DATA_FLOATS + PIECE_WET_FLOAT]!));
    expect(wetOf().every((w) => w === 0)).toBe(true);
    const builds = v.meshBuilds;
    // The wall soaked to level 5: only the shader data comes (as a paint's batch does).
    const soaked = derive(world(5), table);
    const j = joinSectionsForDraw(grid.edge, grid.edge, [soaked], v.cells);
    v.setShader(0, 0, 0, j.solid);
    expect(v.meshBuilds).toBe(builds);
    const wet = wetOf();
    expect(wet.length).toBeGreaterThan(5);
    for (const w of wet) expect(w).toBeCloseTo(5 / WETNESS_MAX, 6);
    v.dispose();
  });
});
