/**
 * Kit pieces in the voxel chunk view, from the real derive with a real piece
 * table and a real GLB parsed by the engine's loader port: one instanced
 * mesh a (kit piece, variant, mirror, detail) a chunk, each instance at its
 * cell, turned by its case transform (+x to +z a quarter turn) and mirrored
 * by a mirrored copy of the mesh, never by its matrix; the kit found from the
 * cell's material in the shader data; a chunk drawn before its kit's GLB has
 * loaded builds those pieces when it arrives; a kit swap draws the chunks
 * derived again with the new kit's meshes while the others keep theirs; the
 * default kit's procedural pieces where no kit binds the material.
 */
import * as THREE from 'three';
import { glbBytes } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import {
  buildApron,
  chunkGrid,
  createWorldStore,
  DEFAULT_KIT_ID,
  applyCubeRotation,
  CUBE_ROTATION_X90,
  CUBE_ROTATION_ZM90,
  cubeRotationIndex,
  DEFAULT_KIT_PIECES,
  defaultKitMesh,
  deriveWithApron,
  PIECE_STAGGER,
  PIECE_STAGGER_FRAMES,
  pieceStagger,
  FloatingOrigin,
  INSTANCE_BYTES,
  jobRadius,
  joinSectionsForDraw,
  KIT_PIECE_BASE,
  MATERIAL_BITS,
  PIECE_VARIANT_MIRROR,
  SHADER_BORDER_CELLS,
  SHADER_READ_DEPTH_CELLS,
  shaderGridSide,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  WETNESS_MAX,
  WORLD_RULES,
  worldPieceTable,
  type DerivedData,
  type PaletteStore,
  type PieceTable,
} from '@thirdlight/voxel';
import { createGltfLoaderPort } from './gltf-loader';
import { buildGlb } from './test-glb';
import { VoxelChunkView, voxelStandInLook } from './voxel-chunk-view';
import { pieceMatrix } from './voxel-piece-placement';
import { defaultKitGeometry, VoxelKitMeshes, voxelKitDebugTexture, KIT_DEBUG_TEXTURE_SIDE, type VoxelKitRecordLike } from './voxel-kit-pieces';
import { createVoxelSurface, type VoxelGridRenderer } from './voxel-surface';
import { VoxelWorldDraws } from './voxel-world-draws';
import { TRIM_DEBUG_TEXTURE_SCALE, trimDebugTexture } from './voxel-trim-debug-texture';
import { DRAFT_TRIM_LAYOUT } from '@thirdlight/project-model';

const grid = chunkGrid(32);
const R = jobRadius(WORLD_RULES);
const STONE = 3;
const TIMBER = 4;

/** Flat ground, a stone wall 12 long and 8 high on it, a timber wall one cell in front of its top half. */
function world(): PaletteStore {
  const s = createWorldStore(grid);
  const set = (x: number, y: number, z: number, material: number, role: number): void => s.setVoxel(x, y, z, { material, role, shape: 15, wetness: 0 });
  for (let x = 2; x < 30; x++) for (let z = 2; z < 30; z++) for (let y = 0; y < 4; y++) set(x, y, z, 1, VOXEL_ROLE.terrain);
  for (let x = 8; x < 20; x++) for (let y = 4; y < 12; y++) set(x, y, 16, STONE, VOXEL_ROLE.wall);
  for (let x = 8; x < 20; x++) for (let y = 8; y < 12; y++) set(x, y, 18, TIMBER, VOXEL_ROLE.wall);
  return s;
}

function renderer(): VoxelGridRenderer {
  return { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined };
}

function view2(kits: VoxelChunkView['kits']): VoxelChunkView {
  return view(kits);
}

function view(kits: VoxelChunkView['kits']): VoxelChunkView {
  const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
  return new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } }), surface, renderer: renderer(), kits });
}

const derive = (s: PaletteStore, table: PieceTable, level = 0): DerivedData => deriveWithApron(grid, WORLD_RULES, buildApron(s, 0, 0, 0, R), (out) => s.exportChunk(0, 0, 0, out), undefined, level, { table, chunk: [0, 0, 0] });

/** Draws chunk 0,0,0 from its derive, its shader grid written into the view's cells as a join does. */
function draw(v: VoxelChunkView, d: DerivedData, level = 0): void {
  const j = joinSectionsForDraw(grid.edge, grid.edge, [d], v.cells);
  v.set(0, 0, 0, { ground: j.ground, base: j.base, instances: j.instances, solid: j.solid }, level);
}

const pieceMeshes = (v: VoxelChunkView): THREE.InstancedMesh[] => v.root.children.flatMap((g) => g.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh));

/** A stone kit: a coping for the wall's top edges (its own GLB), nothing else. */
function stoneKit(digest: string, assetId = 'coping'): VoxelKitRecordLike {
  return { voxelKitId: 'stone', materials: [STONE], cases: { 'edge-out-top': { sections: { body: { variants: [{ high: { assetId, digest } }] } } } } };
}

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

describe('kit pieces in the chunk view', () => {
  it('draws one instanced mesh a kit piece and detail, each instance at its cell turned by its case, after the GLB arrives; the default kit elsewhere', async () => {
    const s = world();
    const kits = [stoneKit(DIGEST_A)];
    const table = worldPieceTable(kits);
    const meshes = new VoxelKitMeshes();
    const v = view(meshes.set(table, kits));
    const d = derive(s, table);
    // Before the GLB is read: the stone coping waits, the timber wall's default pieces draw.
    draw(v, d);
    const kitInstances: Array<{ cell: [number, number, number]; turns: number; mirror: boolean; material: number; piece: number }> = [];
    for (let k = 0; k < d.instances.count; k++) {
      const o = k * INSTANCE_BYTES;
      const b = d.instances.data;
      const piece = b[o + 4]! | (b[o + 5]! << 8);
      if (piece < KIT_PIECE_BASE) continue;
      const cell: [number, number, number] = [b[o]!, b[o + 1]!, b[o + 2]!];
      kitInstances.push({ cell, turns: b[o + 3]! & 3, mirror: ((b[o + 6]! | (b[o + 7]! << 8)) & PIECE_VARIANT_MIRROR) !== 0, material: s.voxelAt(cell[0], cell[1], cell[2], { material: 0, role: 0, shape: 0, wetness: 0 }).material, piece });
    }
    const stone = kitInstances.filter((i) => i.material === STONE);
    const timber = kitInstances.filter((i) => i.material === TIMBER);
    expect(stone.length).toBeGreaterThan(5);
    expect(timber.length).toBeGreaterThan(5);
    const about = v.kits!.describe.bind(v.kits);
    expect(new Set(stone.map((i) => about(i.material, i.piece)?.caseId))).toEqual(new Set(['edge-out-top']));
    expect(new Set(timber.map((i) => about(i.material, i.piece)?.kit))).toEqual(new Set([DEFAULT_KIT_ID]));
    expect(v.piecesDrawn.kit).toBe(timber.length);
    // The GLB arrives (read through the host's bytes, parsed by the loader port): the waiting pieces are built.
    const glb = buildGlb({ clip: false });
    const read: string[] = [];
    const loaded = await meshes.load(kits, async (ref) => (read.push(ref.assetId), { bytes: glb, version: 1 }), createGltfLoaderPort());
    expect(loaded).toEqual({ loaded: 1, failed: [] });
    expect(read).toEqual(['coping']);
    expect(v.piecesDrawn.kit).toBe(kitInstances.length);
    const all = pieceMeshes(v);
    // One draw a (kit piece, variant, mirror, detail): the instances of each mesh share those.
    const coping = all.filter((m) => m.geometry.getAttribute('position').count === 3);
    expect(coping.reduce((n, m) => n + m.count, 0)).toBe(stone.length);
    expect(all.length).toBe(v.pieceDraws);
    const keys = new Set(kitInstances.map((i) => `${i.material === STONE ? 's' : 't'}:${i.piece}:${i.mirror}`));
    expect(all.filter((m) => m.userData['voxelKitPiece'] === true).length).toBe(keys.size);
    // Each coping instance sits at its cell's centre, its +x turned onto the run: a quarter turn takes +x to +z.
    const m4 = new THREE.Matrix4();
    const x = new THREE.Vector3();
    const atCells = new Set(stone.map((i) => i.cell.join(',')));
    for (const mesh of coping) {
      for (let k = 0; k < mesh.count; k++) {
        mesh.getMatrixAt(k, m4);
        const p = new THREE.Vector3().setFromMatrixPosition(m4);
        const cell = [p.x, p.y, p.z].map((c) => c / VOXEL_SIZE_M - 0.5);
        expect(atCells.has(cell.map((c) => Math.round(c)).join(','))).toBe(true);
        expect(m4.determinant()).toBeCloseTo(1, 6);
        // A wall's top cell owns two copings (its front and back top edges): the instance is one of its cell's turns.
        x.set(1, 0, 0).transformDirection(m4);
        const turns = stone.filter((i) => i.cell.join(',') === cell.map((c) => Math.round(c)).join(',')).map((i) => [[1, 0], [0, 1], [-1, 0], [0, -1]][i.turns]!.join(','));
        expect(turns).toContain([Math.round(x.x), Math.round(x.z)].join(','));
      }
    }
    // The wall runs along x: its top-edge pieces are unturned (its +z edge) or half turned (its −z edge), but for the
    // top edges of its two end faces (a quarter turn each way).
    expect(stone.filter((i) => i.turns % 2 === 1).map((i) => `${i.cell.join(',')}|${i.turns}`).sort()).toEqual(['19,11,16|3', '8,11,16|1']);
    // A level-1 node of the same cells draws the same kit's piece at low detail (no low mesh: the high one).
    draw(v, derive(s, table, 1), 1);
    expect(v.piecesDrawn.low).toBeGreaterThan(0);
    // Removing the chunk and node frees every instanced mesh and its count.
    v.remove(0, 0, 0);
    v.remove(0, 0, 0, 1);
    expect([v.instances, v.pieceDraws, v.piecesDrawn.kit, v.piecesDrawn.high, v.piecesDrawn.low]).toEqual([0, 0, 0, 0, 0]);
    v.dispose();
    meshes.dispose();
  });

  it("never draws a piece's collision or occluder nodes (`_COL`, `_OCC`): only the render mesh under the node the kit names", async () => {
    // One render triangle under `Coping`, a two-triangle hull under its `Coping_COL` child and an `_OCC` stand-in beside.
    const tri = [0, 0, 0, 0.2, 0, 0, 0, 0.2, 0];
    const quad = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
    const bin = new Float32Array([...tri, ...quad, ...quad]);
    const view = (k: number, n: number): Record<string, unknown> => ({ buffer: 0, byteOffset: k * 4, byteLength: n * 4 });
    const acc = (v: number, count: number): Record<string, unknown> => ({ bufferView: v, componentType: 5126, count, type: 'VEC3', min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] });
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 2] }],
      nodes: [{ name: 'Coping', mesh: 0, children: [1] }, { name: 'Coping_COL', mesh: 1 }, { name: 'Coping_OCC', mesh: 2 }],
      meshes: [0, 1, 2].map((a) => ({ primitives: [{ attributes: { POSITION: a } }] })),
      accessors: [acc(0, 3), acc(1, 6), acc(2, 6)],
      bufferViews: [view(0, 9), view(9, 18), view(27, 18)],
      buffers: [{ byteLength: bin.byteLength }],
    };
    const glb = glbBytes(JSON.stringify(json), new Uint8Array(bin.buffer));
    for (const node of ['Coping', undefined]) {
      const kits: VoxelKitRecordLike[] = [{ voxelKitId: 'stone', materials: [STONE], cases: { 'edge-out-top': { sections: { body: { variants: [{ high: { assetId: 'coping', digest: DIGEST_A, ...(node !== undefined ? { node } : {}) } }] } } } } }];
      const table = worldPieceTable(kits);
      const meshes = new VoxelKitMeshes();
      const v = view2(meshes.set(table, kits));
      expect(await meshes.load(kits, async () => ({ bytes: glb, version: 1 }), createGltfLoaderPort())).toEqual({ loaded: 1, failed: [] });
      draw(v, derive(world(), table));
      // The render triangle draws (3 vertices); with the hull it would be 9, with the stand-in too 15 (the default
      // kit's pieces are boxes of 24 a box).
      const counts = pieceMeshes(v).map((m) => m.geometry.getAttribute('position').count);
      expect(counts.filter((c) => c === 3).length, `node ${node}`).toBeGreaterThan(0);
      expect(counts.filter((c) => c === 9 || c === 15), `node ${node}`).toEqual([]);
      v.dispose();
      meshes.dispose();
    }
  });

  it("reports the draws' GPU bytes for the stream budget again when the pieces that waited for kit meshes are built, with the kit meshes' own bytes", async () => {
    const kits = [stoneKit(DIGEST_A)];
    const table = worldPieceTable(kits);
    const meshes = new VoxelKitMeshes();
    const reports: Array<{ bytes: number[]; kits: number }> = [];
    const scene = new THREE.Scene();
    const draws = new VoxelWorldDraws({ scene: () => scene, renderer: () => renderer(), report: (_w, bytes, _coarse, k) => void reports.push({ bytes, kits: k }), kits: meshes.set(table, kits) });
    const cells = new Uint16Array(shaderGridSide(grid.edge) ** 3);
    const d = derive(world(), table);
    const j = joinSectionsForDraw(grid.edge, grid.edge, [d], cells);
    draws.receive({ world: 'w', edge: grid.edge, chunks: [{ kind: 'draw', cx: 0, cy: 0, cz: 0, ground: j.ground, base: j.base, instances: j.instances, solid: j.solid, cells }], swaps: [], sentAt: 0, joinMs: 0 });
    expect(reports).toHaveLength(1);
    const before = reports[0]!;
    // The stone copings wait for their GLB: none of their instances is counted yet.
    const s = world();
    const copings = Array.from({ length: d.instances.count }, (_, k) => k * INSTANCE_BYTES).filter((o) => (d.instances.data[o + 4]! | (d.instances.data[o + 5]! << 8)) >= KIT_PIECE_BASE && s.voxelAt(d.instances.data[o]!, d.instances.data[o + 1]!, d.instances.data[o + 2]!, { material: 0, role: 0, shape: 0, wetness: 0 }).material === STONE).length;
    expect(copings).toBeGreaterThan(5);
    await meshes.load(kits, async () => ({ bytes: buildGlb({ clip: false }), version: 1 }), createGltfLoaderPort());
    const after = reports.at(-1)!;
    expect(reports.length).toBeGreaterThan(1);
    expect([after.bytes[0], after.bytes[1], after.bytes[2]]).toEqual([0, 0, 0]);
    // A matrix an instance (64 B) more for every coping built now; the kit meshes' bytes as the set holds them.
    expect(after.bytes[3]! - before.bytes[3]!).toBe(copings * 64);
    const b = meshes.bytes();
    expect(after.kits).toBe(b.meshes + b.textures);
    expect(after.kits).toBeGreaterThan(before.kits);
    draws.dispose();
    meshes.dispose();
  });

  it('a kit swap: chunks derived again draw the new kit\'s meshes, others keep the meshes they were built with; a mirrored case draws a mirrored mesh', async () => {
    const s = world();
    const meshes = new VoxelKitMeshes();
    const port = createGltfLoaderPort();
    const glbA = buildGlb({ clip: false });
    const kitsA = [stoneKit(DIGEST_A, 'coping-a')];
    const kitsB = [stoneKit(DIGEST_B, 'coping-b')];
    await meshes.load([...kitsA, ...kitsB], async () => ({ bytes: glbA, version: 1 }), port);
    const tA = worldPieceTable(kitsA);
    const tB = worldPieceTable(kitsB);
    const v = view(meshes.set(tA, kitsA));
    draw(v, derive(s, tA));
    const geomA = meshes.mesh({ assetId: 'coping-a', digest: DIGEST_A }, false) as THREE.BufferGeometry;
    const geomB = meshes.mesh({ assetId: 'coping-b', digest: DIGEST_B }, false) as THREE.BufferGeometry;
    expect(geomA).not.toBe(geomB);
    const uses = (g: THREE.BufferGeometry): number => pieceMeshes(v).filter((m) => m.geometry === g).length;
    expect(uses(geomA)).toBeGreaterThan(0);
    v.setKits(meshes.set(tB, kitsB));
    // Not derived again yet: still kit A's coping (its geometry alive), never a mix inside one chunk.
    expect(uses(geomA)).toBeGreaterThan(0);
    expect(uses(geomB)).toBe(0);
    expect(geomA.getAttribute('position').array.length).toBeGreaterThan(0);
    // The streamer derives the chunk again with the new table: the new kit's meshes, the old ones gone from it.
    draw(v, derive(s, tB));
    expect(uses(geomA)).toBe(0);
    expect(uses(geomB)).toBeGreaterThan(0);
    // A mirrored copy is the mesh with x negated and its triangles turned (fronts stay fronts).
    const m = meshes.mesh({ assetId: 'coping-b', digest: DIGEST_B }, true) as THREE.BufferGeometry;
    const p = geomB.getAttribute('position');
    const q = m.getAttribute('position');
    for (let i = 0; i < p.count; i++) expect([q.getX(i), q.getY(i), q.getZ(i)]).toEqual([-p.getX(i) + 0, p.getY(i), p.getZ(i)]);
    const tri = (g: THREE.BufferGeometry): THREE.Vector3 => {
      const a = g.getAttribute('position');
      const ix = g.index!;
      const [v0, v1, v2] = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(a, ix.getX(k)));
      return new THREE.Vector3().subVectors(v1!, v0!).cross(new THREE.Vector3().subVectors(v2!, v0!)).normalize();
    };
    const n0 = tri(geomB);
    const n1 = tri(m);
    expect([n1.x, n1.y, n1.z].map((c) => Math.round(c) + 0)).toEqual([-Math.round(n0.x) + 0, Math.round(n0.y) + 0, Math.round(n0.z) + 0]);
    v.dispose();
    meshes.dispose();
  });

  it("builds the default kit's generated pieces: low triangle counts a level, wound out, on their cell; a labelled debug texture", () => {
    // Game-ready budgets (triangles high / low) by kind of piece.
    const budget = (id: string): [number, number] => (id.startsWith('edge-') ? [48, 16] : id.startsWith('corner-') ? [64, 24] : id.startsWith('roof-') ? [64, 24] : [160, 48]);
    const report: string[] = [];
    let own = 0;
    for (const [id, p] of Object.entries(DEFAULT_KIT_PIECES)) {
      if (p === null || p.alias !== undefined) continue;
      own++;
      const [high, low] = [false, true].map((l) => defaultKitGeometry(defaultKitMesh(id, l)!));
      const tris = [high!, low!].map((g) => g.index!.count / 3);
      expect(tris[0], id).toBeLessThanOrEqual(budget(id)[0]);
      expect(tris[1], id).toBeLessThanOrEqual(budget(id)[1]);
      expect(tris[1], id).toBeLessThan(tris[0]!);
      for (const g of [high!, low!]) {
        // Every triangle's front faces the way its vertices' normals do (wound out).
        const pos = g.getAttribute('position');
        const nor = g.getAttribute('normal');
        const ix = g.index!;
        for (let t = 0; t < ix.count; t += 3) {
          const [a, b, c] = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, ix.getX(t + k)));
          const face = new THREE.Vector3().subVectors(b!, a!).cross(new THREE.Vector3().subVectors(c!, a!));
          const n = new THREE.Vector3();
          for (let k = 0; k < 3; k++) n.add(new THREE.Vector3().fromBufferAttribute(nor, ix.getX(t + k)));
          expect(face.dot(n), `${id} triangle ${t / 3}`).toBeGreaterThan(0);
        }
        // On its cell: within half a cell of its centre and the quarter cell a cove reaches into the open cell beside it;
        // a roof-edge piece follows the plane, which runs up to a cell above its voxel's top (1.5 cells over the centre).
        g.computeBoundingBox();
        const b = g.boundingBox!;
        const reach = VOXEL_SIZE_M * (0.5 + 1 / 4) + 1e-6;
        for (const c of [b.min.x, b.min.z, b.max.x, b.max.z]) expect(Math.abs(c), id).toBeLessThanOrEqual(reach);
        expect(b.min.y, id).toBeGreaterThanOrEqual(-reach);
        expect(b.max.y, id).toBeLessThanOrEqual(id.startsWith('roof-') ? VOXEL_SIZE_M * (1.5 + 1 / 4) : reach);
      }
      const bytes = [high!, low!].map((g) => Object.values(g.attributes).reduce((n, a) => n + (a as THREE.BufferAttribute).array.byteLength, 0) + g.index!.array.byteLength);
      report.push(`${id} ${tris[0]}/${tris[1]} tris, ${bytes[0]}/${bytes[1]} B`);
    }
    // Three meshes for the ten edge and corner cases (an outer strip, a cove, an outer cap; the rest are aliases or
    // none), five roof boards, three debris pieces.
    expect(own).toBe(11);
    console.log(`[default kit] high/low: ${report.join('; ')}; no textures (the 256² debug texture), no files`);
    const t = voxelKitDebugTexture();
    expect([t.image.width, t.image.height]).toEqual([KIT_DEBUG_TEXTURE_SIDE, KIT_DEBUG_TEXTURE_SIDE]);
    const px = t.image.data as Uint8Array;
    // Labels are dark texels on the light checker: the quarter numbers and the U and V marks are there.
    let dark = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i]! < 60) dark++;
    expect(dark).toBeGreaterThan(4 * KIT_DEBUG_TEXTURE_SIDE);
    t.dispose();
  });

  it("an alias draws its target's mesh turned exactly as an explicit mesh of the turned case; determinant +1, normals out; the default kit's aliases share their target's geometry", () => {
    const s = world();
    // A thin board over a top edge (+y +z of the cell) and the same board turned under the bottom edge, as its own mesh.
    const board = (): THREE.BufferGeometry => new THREE.BoxGeometry(VOXEL_SIZE_M, 0.06, 0.06).translate(0, VOXEL_SIZE_M / 2, VOXEL_SIZE_M / 2);
    const turned = board();
    const pos = turned.getAttribute('position');
    const nor = turned.getAttribute('normal');
    for (const a of [pos, nor]) for (let i = 0; i < a.count; i++) {
      const v = applyCubeRotation(CUBE_ROTATION_X90, [a.getX(i), a.getY(i), a.getZ(i)]);
      a.setXYZ(i, v[0], v[1], v[2]);
    }
    const top = { assetId: 'board', digest: DIGEST_A };
    const bottom = { assetId: 'board-under', digest: DIGEST_B };
    const variants = (m: typeof top): { sections: { body: { variants: { high: typeof top }[] } } } => ({ sections: { body: { variants: [{ high: m }] } } });
    // Same kit id: the same seed, so the same variants and stagger.
    const aliased: VoxelKitRecordLike = { voxelKitId: 'timber', materials: [TIMBER], cases: { 'edge-out-top': variants(top), 'edge-out-bottom': { alias: { case: 'edge-out-top', rotation: CUBE_ROTATION_X90 } } } };
    const explicit: VoxelKitRecordLike = { voxelKitId: 'timber', materials: [TIMBER], cases: { 'edge-out-top': variants(top), 'edge-out-bottom': variants(bottom) } };
    const placed = (kit: VoxelKitRecordLike): { verts: string[]; dets: number[]; normals: THREE.Vector3[]; geometries: Set<THREE.BufferGeometry> } => {
      const meshes = new VoxelKitMeshes();
      meshes.add(top, board());
      meshes.add(bottom, turned.clone());
      const table = worldPieceTable([kit]);
      const v = view(meshes.set(table, [kit]));
      draw(v, derive(s, table));
      const verts: string[] = [];
      const dets: number[] = [];
      const normals: THREE.Vector3[] = [];
      const geometries = new Set<THREE.BufferGeometry>();
      const m4 = new THREE.Matrix4();
      const n3 = new THREE.Matrix3();
      for (const mesh of pieceMeshes(v).filter((x) => x.userData['voxelKitPiece'] === true && x.material !== meshes.material(0, true))) {
        geometries.add(mesh.geometry);
        const p = mesh.geometry.getAttribute('position');
        const nn = mesh.geometry.getAttribute('normal');
        for (let k = 0; k < mesh.count; k++) {
          mesh.getMatrixAt(k, m4);
          dets.push(m4.determinant());
          n3.getNormalMatrix(m4);
          const pts: string[] = [];
          let below = false;
          for (let i = 0; i < p.count; i++) {
            const w = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m4);
            pts.push(w.toArray().map((c) => c.toFixed(4)).join(','));
            if (w.y < 8 * VOXEL_SIZE_M + 0.1) below = true;
          }
          // The timber wall's underside row (y 8): its pieces are the bottom edges.
          if (below) for (let i = 0; i < nn.count; i++) normals.push(new THREE.Vector3().fromBufferAttribute(nn, i).applyMatrix3(n3).normalize());
          verts.push(pts.sort().join(' '));
        }
      }
      v.dispose();
      meshes.dispose();
      return { verts: verts.sort(), dets, normals, geometries };
    };
    const a = placed(aliased);
    const e = placed(explicit);
    expect(a.verts.length).toBeGreaterThan(20);
    expect(a.verts).toEqual(e.verts);
    // The alias draws with the top edge's geometry: one mesh for both cases.
    expect(a.geometries.size).toBe(1);
    expect(e.geometries.size).toBe(2);
    for (const d of a.dets) expect(d).toBeCloseTo(1, 5);
    // The flipped board's faces still face out: its normals, turned, point the way its own faces do (none inward).
    expect(a.normals.length).toBeGreaterThan(0);
    expect(a.normals.filter((n) => n.y > 0.9).length).toBeGreaterThan(0);
    expect(a.normals.filter((n) => n.y < -0.9).length).toBeGreaterThan(0);
    // The default kit: the vertical and bottom edges draw the top edge's strip; inner edges the floor cove; a bottom corner the top cap.
    const meshes = new VoxelKitMeshes();
    const set = meshes.world([]);
    expect(meshes.defaultMesh('edge-out-vertical', false)).toBeNull();
    const desc = (id: string): ReturnType<typeof set.describe> => {
      for (let p = KIT_PIECE_BASE; p < KIT_PIECE_BASE + 64; p++) if (set.describe(1, p)?.caseId === id) return set.describe(1, p);
      return null;
    };
    expect(desc('edge-out-vertical')).toMatchObject({ meshCaseId: 'edge-out-top', rotation: CUBE_ROTATION_ZM90 });
    expect(desc('edge-out-bottom')).toMatchObject({ meshCaseId: 'edge-out-top', rotation: CUBE_ROTATION_X90 });
    expect(desc('edge-in-top')).toMatchObject({ meshCaseId: 'edge-in-bottom', rotation: CUBE_ROTATION_X90 });
    expect(desc('corner-out-bottom')).toMatchObject({ meshCaseId: 'corner-out-top', rotation: CUBE_ROTATION_X90 });
    meshes.dispose();
  });

  it('staggers edge and corner pieces by their world cell: the same on every build, unchanged by an edit elsewhere, within 1/32 cell into the solid and 2° of twist', () => {
    const s = world();
    const table = worldPieceTable([]);
    const matrices = (st: PaletteStore): Map<string, number[][]> => {
      const meshes = new VoxelKitMeshes();
      const v = view(meshes.world([]));
      draw(v, derive(st, table));
      const out = new Map<string, number[][]>();
      for (const mesh of pieceMeshes(v)) {
        const list: number[][] = [];
        for (let k = 0; k < mesh.count; k++) list.push(mesh.getMatrixAt(k, new THREE.Matrix4()).toArray().map((c) => Math.round(c * 1e6)));
        out.set(`${out.size}`, list);
      }
      v.dispose();
      meshes.dispose();
      return out;
    };
    const flat = (m: Map<string, number[][]>): string[] => [...m.values()].flat().map((x) => x.join()).sort();
    const first = flat(matrices(s));
    expect(flat(matrices(s))).toEqual(first);
    // An edit beyond every piece's reach (a lone terrain cell in the far corner): no other instance moves.
    const far = world();
    far.setVoxel(28, 0, 28, { material: 0, role: 0, shape: 0, wetness: 0 });
    const after = new Set(flat(matrices(far)));
    const kept = first.filter((m) => after.has(m)).length;
    expect(kept).toBeGreaterThan(first.length - 12);
    // Bounds, from the placement itself: each staggered instance against the same instance unstaggered.
    const frame = PIECE_STAGGER_FRAMES['edge-out-top']!;
    const centre = new THREE.Vector3(0.25, 0.25, 0.25);
    const anchor = new THREE.Vector3(...frame.anchor).multiplyScalar(VOXEL_SIZE_M);
    let moved = 0;
    for (let x = 0; x < 64; x++) {
      for (const rot of [0, 1, 2, 3]) {
        const a = pieceMatrix(new THREE.Matrix4(), rot, 0, centre, VOXEL_SIZE_M, [x, 7, -3], 0, { turnSign: -1, rotation: 0, stagger: { frame, seed: 1234, caseIndex: 0 } });
        const b = pieceMatrix(new THREE.Matrix4(), rot, 0, centre, VOXEL_SIZE_M, [x, 7, -3], 0, { turnSign: -1, rotation: 0, stagger: null });
        const d = anchor.clone().applyMatrix4(a).distanceTo(anchor.clone().applyMatrix4(b)) / VOXEL_SIZE_M;
        expect(d).toBeLessThanOrEqual(PIECE_STAGGER.inwardMax + 1e-9);
        expect(d).toBeGreaterThanOrEqual(PIECE_STAGGER.inwardMin - 1e-9);
        const qa = new THREE.Quaternion().setFromRotationMatrix(a);
        const qb = new THREE.Quaternion().setFromRotationMatrix(b);
        expect(qa.angleTo(qb)).toBeLessThanOrEqual(PIECE_STAGGER.twistMax + 1e-9);
        // Into the solid: the anchor moves against the bisector out of the faces (the turned frame's out).
        const out = new THREE.Vector3(...frame.out).applyQuaternion(qb);
        expect(anchor.clone().applyMatrix4(a).sub(anchor.clone().applyMatrix4(b)).dot(out)).toBeLessThan(0);
        if (qa.angleTo(qb) > PIECE_STAGGER.twistMax / 4) moved++;
      }
    }
    expect(moved).toBeGreaterThan(64);
    expect(pieceStagger(1, 2, 3, 4, 0, 5, 0.5)).toEqual(pieceStagger(1, 2, 3, 4, 0, 5, 0.5));
    expect(pieceStagger(1, 2, 3, 4, 0, 5, 0.5)).not.toEqual(pieceStagger(1, 2, 3, 5, 0, 5, 0.5));
  });

  it("a trim piece's U runs along its edge's world axis: up y on a vertical edge, along x or z on a horizontal one", () => {
    const s = world();
    const m = { assetId: 'post', digest: DIGEST_A };
    const kit: VoxelKitRecordLike = { voxelKitId: 'stone', materials: [STONE], trimLayout: DRAFT_TRIM_LAYOUT.id, cases: { 'edge-out-vertical': { sections: { body: { variants: [{ high: m }] } } }, 'edge-out-top': { alias: { case: 'edge-out-vertical', rotation: cubeRotationIndex([0, -1, 0, 1, 0, 0, 0, 0, 1]) } } } };
    const meshes = new VoxelKitMeshes();
    // A post up the vertical edge (+x +z), its U along y.
    const post = new THREE.BoxGeometry(0.06, VOXEL_SIZE_M, 0.06).translate(VOXEL_SIZE_M / 2, 0, VOXEL_SIZE_M / 2);
    meshes.add(m, post);
    const table = worldPieceTable([kit]);
    const v = view(meshes.set(table, [kit]));
    draw(v, derive(s, table));
    const perM = DRAFT_TRIM_LAYOUT.pxPerMetre / DRAFT_TRIM_LAYOUT.size;
    const trim = pieceMeshes(v).filter((x) => x.userData['voxelTrimGeometry'] === true);
    expect(trim.length).toBe(2);
    let vertical = 0;
    let horizontal = 0;
    const m4 = new THREE.Matrix4();
    for (const mesh of trim) {
      const u = mesh.geometry.getAttribute('pieceU') as THREE.InstancedBufferAttribute;
      for (let k = 0; k < mesh.count; k++) {
        mesh.getMatrixAt(k, m4);
        const run = new THREE.Vector3(0, 1, 0).transformDirection(m4);
        const c = new THREE.Vector3().setFromMatrixPosition(m4);
        const axis = Math.abs(run.y) > 0.9 ? 1 : Math.abs(run.x) > 0.9 ? 0 : 2;
        const sign = run.getComponent(axis) > 0 ? 1 : -1;
        // The cell's low face on that axis (metres) gives U: its fraction of a sheet, the sign the direction.
        const lowM = (Math.round(c.getComponent(axis) / VOXEL_SIZE_M - 0.5)) * VOXEL_SIZE_M;
        const at = perM * (sign > 0 ? lowM : lowM + VOXEL_SIZE_M);
        expect(u.getX(k)).toBeCloseTo(at - Math.floor(at), 5);
        expect(u.getY(k)).toBe(sign);
        if (axis === 1) vertical++;
        else horizontal++;
      }
    }
    expect(vertical).toBeGreaterThan(10);
    expect(horizontal).toBeGreaterThan(10);
    v.dispose();
    meshes.dispose();
  });

  it("draws a kit on a trim layout with that layout's debug set: a hue a region, gutters magenta, other kits keep the cell texture", () => {
    const tex = trimDebugTexture(DRAFT_TRIM_LAYOUT);
    const side = DRAFT_TRIM_LAYOUT.size * TRIM_DEBUG_TEXTURE_SCALE;
    expect([tex.image.width, tex.image.height]).toEqual([side, side]);
    const px = tex.image.data as Uint8Array;
    const at = (u: number, v: number): number[] => {
      const o = (Math.floor(v * side) * side + Math.floor(u * side)) * 4;
      return [px[o]!, px[o + 1]!, px[o + 2]!];
    };
    // A gutter between the field and the 0.5 m strip, and reserved space, are magenta; regions are not, and differ.
    expect(at(0.5, 1088 / 4096)).toEqual([255, 0, 255]);
    expect(at(0.95, 3900 / 4096)).toEqual([255, 0, 255]);
    const centre = (id: string): number[] => {
      const r = DRAFT_TRIM_LAYOUT.regions.find((x) => x.id === id)!;
      return at(r.x === undefined ? 0.51 : (r.x[0] + 6) / 4096, (r.y[0] + 6) / 4096);
    };
    const ids = ['F1', 'S50', 'S50p', 'S25', 'S25p', 'S12', 'S12p', 'C50a', 'C25a', 'C12a'];
    for (const id of ids) expect(centre(id), id).not.toEqual([255, 0, 255]);
    expect(new Set(ids.map((id) => centre(id).join())).size).toBeGreaterThan(6);
    tex.dispose();
    const meshes = new VoxelKitMeshes();
    const trim = meshes.material(7, false, 'detail-trim') as THREE.MeshLambertMaterial;
    const plain = meshes.material(7, false) as THREE.MeshLambertMaterial;
    expect((trim.map!.image as { width: number }).width).toBe(side);
    expect(plain.map).toBe(meshes.texture);
    expect(meshes.material(9, false, 'detail-trim')).toBe(trim);
    expect((meshes.material(7, false, 'unknown-layout') as THREE.MeshLambertMaterial).map).toBe(meshes.texture);
    meshes.dispose();
  });
});
