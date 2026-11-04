/**
 * The voxel chunk view against the voxel package's real derive and join: a
 * chunk drawn from its 16³ sections joined is one surface mesh holding the
 * whole-chunk derive's triangles, its stand-in pieces, and a shader grid
 * uploaded with the whole-chunk derive's entries (or its one solid entry
 * passed, no region); a shader-only change uploads the grid again and
 * builds no mesh; a floating-origin re-base moves every chunk to its new
 * 32-bit position; a chunk 8 km out, its origin never moved (Play), draws
 * with a model-view made in 64 bits, its vertices as exact as near the
 * origin, the surface and the pieces alike; a batch from the draw batcher replaces a swap's chunks in the task
 * that announces them and counts their bytes against the stream budget. With mip levels: a node of level L is one
 * object at its corner with its derive scaled to the level's cells and its grid read in them; a seam is one
 * object at its coarse node's corner shaded from whichever draw that node has; a change of the levels drawn (the
 * streamer's `seams` and `levels` events of one task) is applied as one batch, the old level drawn until then;
 * a node's new result replaces its draw, and level-0 events for chunks not drawn at level 0 draw nothing.
 * Pieces: a chunk's at high detail, a level-1 node's at low, from a kit's meshes when the view is given them.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildApron,
  ChunkDrawBatcher,
  chunkGrid,
  deriveMipNode,
  MipTree,
  createWorldStore,
  deriveFromStore,
  deriveSectionsWithApron,
  deriveWithApron,
  FloatingOrigin,
  jobRadius,
  joinSectionsForDraw,
  MATERIAL_BITS,
  PIECE_FAMILY,
  PLACEHOLDER_RULES,
  SHADER_BORDER_CELLS,
  SHADER_READ_DEPTH_CELLS,
  shaderGridEntries,
  shaderGridSide,
  shaderSolidEntry,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  WETNESS_MAX,
  type ChunkDrawBatch,
  type DerivedData,
  type FaceSeam,
  type JoinedDraw,
  type PaletteStore,
  type StreamEvent,
} from '@thirdlight/voxel';

import { applyChunkDrawBatch, standInPieceGeometry, VoxelChunkView, voxelStandInLook, voxelSurfaceGeometry, type VoxelPieceMeshes } from './voxel-chunk-view';
import { cameraRelativeModelView } from './camera-relative';
import { observerOf, wgslOf, wgslRenderer } from './test-wgsl';
import { createVoxelSurface, VOXEL_SURFACE_KEY, type VoxelGridRenderer, type VoxelSurfaceObject } from './voxel-surface';

const grid = chunkGrid(32);
const R = jobRadius(PLACEHOLDER_RULES);
const SECTION = 16;

/** A renderer that records each region upload's bytes (the WebGL 2 path: a copy from a data texture holding them). */
function recorder(): VoxelGridRenderer & { uploads: Array<{ at: THREE.Vector3; entries: Uint16Array }> } {
  const uploads: Array<{ at: THREE.Vector3; entries: Uint16Array }> = [];
  return {
    uploads,
    backend: {
      isWebGLBackend: true,
      get: () => ({}),
      copyTextureToTexture: (src, _dst, _r, at) => {
        const b = (src.image as { data: Uint8Array }).data;
        uploads.push({ at: at.clone(), entries: new Uint16Array(b.slice().buffer) });
      },
    },
    initTexture: () => undefined,
    copyTextureToTexture: () => undefined,
  };
}

/**
 * Ground sloping in x across a chunk corner at the origin, a stone wall with
 * a timber beam one cell out, and a timber banister (posts and a rail):
 * terrain, walls and pieces in chunks that meet at x = 0 and z = 0.
 */
function world(): PaletteStore {
  const s = createWorldStore(grid);
  const set = (x: number, y: number, z: number, material: number, role: number): void => s.setVoxel(x, y, z, { material, role, shape: 15, wetness: 0 });
  for (let x = -24; x < 24; x++) for (let z = -24; z < 24; z++) {
    const top = 4 + (x >> 3);
    for (let y = -6; y < top; y++) set(x, y, z, y < top - 2 ? 2 : 1, VOXEL_ROLE.terrain);
  }
  for (let x = -6; x < 6; x++) for (let y = 4; y < 12; y++) set(x, y, 0, 3, VOXEL_ROLE.wall);
  for (let x = -6; x < 6; x++) set(x, 9, -1, 4, VOXEL_ROLE.wall);
  for (let x = -4; x < 4; x++) {
    if ((x & 1) === 0) set(x, 5 + (x >> 3), 7, 4, VOXEL_ROLE.wall);
    set(x, 6 + (x >> 3), 7, 4, VOXEL_ROLE.wall);
  }
  return s;
}

/** A chunk's 16³ sections derived with one apron (the worker's path), joined for drawing. */
function joined(s: PaletteStore, cx: number, cy: number, cz: number, cells: Uint16Array): JoinedDraw {
  const n = grid.edge / SECTION;
  const ids = Array.from({ length: n * n * n }, (_, i) => i);
  const results = deriveSectionsWithApron(grid, PLACEHOLDER_RULES, buildApron(s, cx, cy, cz, R), (out) => s.exportChunk(cx, cy, cz, out), SECTION, ids);
  return joinSectionsForDraw(grid.edge, SECTION, results.map((r) => r.assembly), cells);
}

/** A geometry's triangles as sorted position triples (cm), to compare as multisets. */
function triangles(geo: THREE.BufferGeometry | null): string[] {
  if (geo === null) return [];
  const p = geo.getAttribute('position');
  const idx = geo.index!;
  const out: string[] = [];
  const v = (i: number): string => [p.getX(i), p.getY(i), p.getZ(i)].map((c) => Math.round(c * 1000)).join(',');
  for (let t = 0; t < idx.count; t += 3) out.push([v(idx.getX(t)), v(idx.getX(t + 1)), v(idx.getX(t + 2))].join('|'));
  return out.sort();
}

function setup(): { view: VoxelChunkView; r: ReturnType<typeof recorder>; origin: FloatingOrigin } {
  const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
  const origin = new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } });
  const r = recorder();
  return { view: new VoxelChunkView({ grid, origin, surface, renderer: r }), r, origin };
}

const surfaceOf = (g: THREE.Object3D): THREE.Mesh => g.children.find((c) => !(c instanceof THREE.InstancedMesh)) as THREE.Mesh;

describe('the voxel chunk view', () => {
  it('draws a chunk joined from 16³ sections as one surface mesh with the whole-chunk derive\'s triangles, pieces and shader grid', () => {
    const s = world();
    const { view, r } = setup();
    let grids = 0;
    let solids = 0;
    let pieces = 0;
    for (let cx = -1; cx <= 0; cx++) for (let cy = -1; cy <= 0; cy++) for (let cz = -1; cz <= 0; cz++) {
      const at = `chunk (${cx}, ${cy}, ${cz})`;
      const whole = deriveFromStore(s, cx, cy, cz, PLACEHOLDER_RULES);
      const uploads = r.uploads.length;
      const bytes = view.set(cx, cy, cz, joined(s, cx, cy, cz, view.cells));
      const g = view.root.children.find((c) => c.name === `voxel-chunk ${cx},${cy},${cz}`);
      const wholeTris = whole.ground.indices.length + whole.base.indices.length;
      if (wholeTris === 0 && whole.instances.count === 0) {
        expect(g, at).toBeUndefined();
        expect(bytes, at).toBe(0);
        continue;
      }
      expect(bytes, at).toBeGreaterThan(0);
      // One surface mesh (ground and base in one draw) plus one instanced mesh a piece family.
      const surfaces = g!.children.filter((c) => !(c instanceof THREE.InstancedMesh));
      expect(surfaces.length, at).toBe(wholeTris > 0 ? 1 : 0);
      if (wholeTris > 0) expect(triangles((surfaces[0] as THREE.Mesh).geometry), at).toEqual(triangles(voxelSurfaceGeometry([whole.ground, whole.base])));
      const drawnPieces = g!.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh).reduce((n, m) => n + m.count, 0);
      expect(drawnPieces, at).toBe(whole.instances.count);
      pieces += drawnPieces;
      // Placed at the chunk's corner relative to the origin.
      expect(g!.position.toArray(), at).toEqual([cx * 32 * VOXEL_SIZE_M, cy * 32 * VOXEL_SIZE_M, cz * 32 * VOXEL_SIZE_M]);
      if (wholeTris === 0) continue;
      const values = surfaces[0]!.userData[VOXEL_SURFACE_KEY] as VoxelSurfaceObject;
      const solid = shaderSolidEntry(whole.shader);
      if (solid >= 0) {
        solids++;
        expect(r.uploads.length, at).toBe(uploads);
        expect(values.slot.w, at).toBe(solid);
      } else {
        grids++;
        expect(r.uploads.length, at).toBe(uploads + 1);
        const up = r.uploads[r.uploads.length - 1]!;
        const want = shaderGridEntries(whole.shader, new Uint16Array(34 ** 3));
        expect(up.entries.length, at).toBe(want.length);
        expect(up.entries.every((e, i) => e === want[i]), `${at} grid entries`).toBe(true);
        expect([values.slot.x, values.slot.y, values.slot.z, values.slot.w], at).toEqual([up.at.x, up.at.y, up.at.z, -1]);
      }
    }
    expect(view.count).toBeGreaterThanOrEqual(4);
    expect(grids).toBeGreaterThan(0);
    expect(pieces).toBeGreaterThan(0);
    expect(grids + solids).toBe(view.count);
    expect(view.regions).toBe(grids);
  });

  it('draws a chunk\'s pieces at high detail and a level-1 node\'s at low, from a kit\'s meshes when given (never disposed by the view), stand-ins otherwise', () => {
    const s = world();
    const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { look: voxelStandInLook, blendMetres: 0.25 });
    const origin = new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } });
    const asked: string[] = [];
    const kit = new Map<string, THREE.BufferGeometry>();
    const disposed: string[] = [];
    const pieces: VoxelPieceMeshes = {
      geometry(family, detail) {
        const key = `${family}:${detail}`;
        asked.push(key);
        let g = kit.get(key);
        if (g === undefined) {
          kit.set(key, (g = new THREE.BoxGeometry(0.1, 0.1, 0.1)));
          g.addEventListener('dispose', () => disposed.push(key));
        }
        return g;
      },
    };
    const view = new VoxelChunkView({ grid, origin, surface, renderer: recorder(), pieces });
    // The same cells as a chunk (level 0) and as a level-1 node: only the level differs.
    const at = (cx: number, cy: number, cz: number, level: number): DerivedData => deriveWithApron(grid, PLACEHOLDER_RULES, buildApron(s, cx, cy, cz, R), (out) => s.exportChunk(cx, cy, cz, out), undefined, level);
    const [cx, cy, cz] = [[-1, -1, -1], [0, -1, -1], [-1, 0, -1], [0, 0, -1], [-1, -1, 0], [0, -1, 0], [-1, 0, 0], [0, 0, 0]].find(([x, y, z]) => at(x!, y!, z!, 0).instances.count > 0)!;
    const [d0, d1] = [at(cx!, cy!, cz!, 0), at(cx!, cy!, cz!, 1)];
    expect(d0.instances.count).toBeGreaterThan(0);
    view.set(cx!, cy!, cz!, { ...d0, solid: shaderSolidEntry(d0.shader) });
    view.set(cx!, cy!, cz!, { ...d1, solid: shaderSolidEntry(d1.shader) }, 1);
    const meshes = (name: string): THREE.InstancedMesh[] => view.root.children.find((c) => c.name === name)!.children.filter((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh);
    const high = meshes(`voxel-chunk ${cx},${cy},${cz}`);
    const low = meshes(`voxel-node 1:${cx},${cy},${cz}`);
    expect(high.every((m) => [...kit].some(([k, g]) => g === m.geometry && k.endsWith(':high')))).toBe(true);
    expect(low.every((m) => [...kit].some(([k, g]) => g === m.geometry && k.endsWith(':low')))).toBe(true);
    expect(high.reduce((n, m) => n + m.count, 0)).toBe(d0.instances.count);
    expect(view.piecesDrawn).toEqual({ high: d0.instances.count, low: d1.instances.count });
    // Each family and detail is asked for once; the kit's meshes are its own.
    expect(new Set(asked).size).toBe(asked.length);
    view.remove(cx!, cy!, cz!, 1);
    expect(view.piecesDrawn).toEqual({ high: d0.instances.count, low: 0 });
    view.dispose();
    expect(disposed).toEqual([]);
    // The stand-ins: the low mesh is the high box without its two ends along its long axis.
    for (const family of [PIECE_FAMILY.beam, PIECE_FAMILY.rail, PIECE_FAMILY.post]) {
      expect(standInPieceGeometry(family, 'high')!.index!.count / 3).toBe(12);
      expect(standInPieceGeometry(family, 'low')!.index!.count / 3).toBe(8);
    }
    expect(standInPieceGeometry(99, 'high')).toBeNull();
  });

  it('uploads only the grid for a shader change, re-places every chunk after a re-base, and frees everything on remove', () => {
    const s = world();
    const { view, r, origin } = setup();
    view.set(0, 0, 0, joined(s, 0, 0, 0, view.cells));
    view.set(-1, 0, -1, joined(s, -1, 0, -1, view.cells));
    const builds = view.meshBuilds;
    const mesh = surfaceOf(view.root.children[0]!);
    const tris = view.triangles;
    // The wall painted brick (material 5): only its shader data changes.
    for (let x = -6; x < 6; x++) for (let y = 4; y < 12; y++) s.setVoxel(x, y, 0, { material: 5, role: VOXEL_ROLE.wall, shape: 15, wetness: 3 });
    const uploads = r.uploads.length;
    const d = joined(s, 0, 0, 0, view.cells);
    expect(d.solid).toBe(-1);
    expect(view.setShader(0, 0, 0, d.solid)).toBeGreaterThan(0);
    expect(view.meshBuilds).toBe(builds);
    expect(surfaceOf(view.root.children[0]!)).toBe(mesh);
    expect(view.triangles).toBe(tris);
    expect(r.uploads.length).toBe(uploads + 1);
    expect(r.uploads[uploads]!.entries.includes(5 | (3 << MATERIAL_BITS))).toBe(true);

    // The focus 600 m away in x: the origin moves by whole chunks and every chunk is placed again, matrix included.
    const moved = origin.update(600, 0, 0);
    expect(moved).not.toBeNull();
    view.rebase();
    for (const g of view.root.children) {
      const [cx, , cz] = g.name.split(' ')[1]!.split(',').map(Number);
      const want = (cx! * 32 - origin.origin.x) * VOXEL_SIZE_M;
      expect(g.position.x).toBe(want);
      expect(g.matrix.elements[12]).toBe(want);
      expect(g.position.z).toBe((cz! * 32 - origin.origin.z) * VOXEL_SIZE_M);
    }

    view.remove(0, 0, 0);
    view.remove(-1, 0, -1);
    expect(view.count).toBe(0);
    expect(view.triangles).toBe(0);
    expect(view.instances).toBe(0);
    expect(view.regions).toBe(0);
    expect(view.pickable).toHaveLength(0);
  });

  it('replaces every chunk a swap announces in the announcing task, counts their bytes, and removes unloaded chunks', () => {
    const s = world();
    const { view } = setup();
    const listeners: Array<(e: StreamEvent) => void> = [];
    const parts = new Map<string, number>();
    const feed = {
      grid,
      on: (l: (e: StreamEvent) => void) => void listeners.push(l),
      joinedChunk: (cx: number, cy: number, cz: number, _times: unknown, cells: Uint16Array) => joined(s, cx, cy, cz, cells),
      setPart: (cx: number, cy: number, cz: number, part: string, bytes: number) => {
        parts.set(`${cx},${cy},${cz}:${part}`, bytes);
        return true;
      },
    };
    const batches: ChunkDrawBatch[] = [];
    let flush: () => void = () => {};
    const batcher = new ChunkDrawBatcher('w', feed, SECTION, (b) => {
      batches.push(b);
      const done = applyChunkDrawBatch(view, b);
      batcher.drawn(done.chunkBytes, done.coarseBytes);
    }, { schedule: (f) => (flush = f), inPlace: true });
    const emit = (e: StreamEvent): void => listeners.forEach((l) => l(e));
    const corner = [[-1, 0, -1], [-1, 0, 0], [0, 0, -1], [0, 0, 0]] as const;
    for (const [cx, cy, cz] of corner) emit({ type: 'chunk', cx, cy, cz, shaderOnly: false });
    // One batch at the end of the task: nothing is drawn before it, everything with it.
    expect(view.count).toBe(0);
    flush();
    expect(batches).toHaveLength(1);
    expect(view.count).toBe(4);
    for (const [cx, cy, cz] of corner) expect(parts.get(`${cx},${cy},${cz}:mesh`)).toBeGreaterThan(0);
    const builds = view.meshBuilds;
    emit({ type: 'chunk', cx: 0, cy: 0, cz: 0, shaderOnly: true });
    flush();
    expect(view.meshBuilds).toBe(builds);
    expect(batches.at(-1)!.chunks.map((c) => c.kind)).toEqual(['shader']);
    emit({ type: 'unloaded', cx: 0, cy: 0, cz: 0 } as StreamEvent);
    flush();
    expect(view.has(0, 0, 0)).toBe(false);
    expect(view.count).toBe(3);
  });

  it('draws mip nodes at their level and seams at their coarse node; a level change, its seams and a node\'s new result each go in as one batch', () => {
    const s = world();
    const { view, r } = setup();
    const tree = new MipTree(s);
    const node: DerivedData = deriveMipNode(tree, { level: 1, nx: -1, ny: -1, nz: -1 }, PLACEHOLDER_RULES);
    expect(node.level).toBe(1);
    expect(node.ground.indices.length).toBeGreaterThan(0);
    // A seam on the node's +x face: a piece in level-0 steps from a corner 8 cells below the finer node there.
    const fineCorner: [number, number, number] = [0 * 32 - 8, -1 * 32 - 8, -1 * 32 - 8];
    const seam: FaceSeam = { level: 1, nx: -1, ny: -1, nz: -1, face: 1, pieces: [{ origin: fineCorner, ground: node.ground, base: node.base }], counts: {} as FaceSeam['counts'] };
    // The level choice as the streamer keeps it: what is drawn now, changed whole in a swap.
    let drawn = new Set(['0,0,-1,-1', '0,0,0,-1', '0,0,-1,0', '0,0,0,0']);
    let result: DerivedData | null = node;
    const listeners: Array<(e: StreamEvent) => void> = [];
    const feed = {
      grid,
      mips: {
        lod: { drawn: { drawn: (l: number, x: number, y: number, z: number) => drawn.has(`${l},${x},${y},${z}`) } },
        derivedOf: (l: number, x: number, y: number, z: number) => (l === 1 && x === -1 && y === -1 && z === -1 ? result : null),
        seams: { seamOf: (l: number, x: number, y: number, z: number, f: number) => (l === 1 && x === -1 && y === -1 && z === -1 && f === 1 ? seam : null) },
        // The nodes' and seams' GPU bytes as the page reports them back: the stream budget's mip share counts them.
        gpuBytes: -1,
      },
      on: (l: (e: StreamEvent) => void) => void listeners.push(l),
      joinedChunk: (cx: number, cy: number, cz: number, _t: unknown, cells: Uint16Array) => joined(s, cx, cy, cz, cells),
      setPart: () => true,
    };
    let flush: () => void = () => {};
    const batches: ChunkDrawBatch[] = [];
    const batcher = new ChunkDrawBatcher('w', feed, SECTION, (b) => {
      batches.push(b);
      const done = applyChunkDrawBatch(view, b);
      batcher.drawn(done.chunkBytes, done.coarseBytes);
    }, { schedule: (f) => (flush = f) });
    const emit = (e: StreamEvent): void => listeners.forEach((l) => l(e));
    const children = [[-2, -2, -2], [-1, -2, -2], [-2, -1, -2], [-1, -1, -2], [-2, -2, -1], [-1, -2, -1], [-2, -1, -1], [-1, -1, -1]] as const;
    // Chunks under the node stream in while level 0 is drawn elsewhere: not drawn (not chosen at level 0).
    for (const [cx, cy, cz] of children) emit({ type: 'chunk', cx, cy, cz, shaderOnly: false });
    flush();
    expect(view.count).toBe(0);
    // Level 0 across the node's +x face is drawn by a swap: those chunks join then.
    emit({ type: 'levels', reason: 'swap', added: [...drawn].map((k) => k.split(',').map(Number)).map(([level, nx, ny, nz]) => ({ level: level!, nx: nx!, ny: ny!, nz: nz! })), removed: [] });
    flush();
    const level0 = view.count;
    expect(level0).toBeGreaterThanOrEqual(2);
    expect(view.levelCounts()).toEqual([level0]);

    // The swap to level 1 over (-1, -1, -1) with its seam: one task, one batch; until it is applied the old level is drawn.
    drawn = new Set([...drawn, '1,-1,-1,-1']);
    const before = batches.length;
    const uploads = r.uploads.length;
    emit({ type: 'seams', built: [{ level: 1, nx: -1, ny: -1, nz: -1, face: 1 }], removed: [] });
    emit({ type: 'levels', reason: 'swap', added: [{ level: 1, nx: -1, ny: -1, nz: -1 }], removed: [] });
    expect(view.levelCounts()).toEqual([level0]);
    flush();
    expect(batches.length).toBe(before + 1);
    expect(batches.at(-1)!.chunks.map((c) => [c.level ?? 0, c.kind])).toEqual([[1, 'draw']]);
    expect(batches.at(-1)!.seams!.map((w) => w.kind)).toEqual(['draw']);
    expect(view.levelCounts()).toEqual([level0, 1]);
    expect(view.seamCount).toBe(1);
    // Copied for the hop (the streamer keeps the node's result for its seams).
    expect(batches.at(-1)!.chunks[0]!.ground!.vertices).not.toBe(node.ground.vertices);

    const g = view.root.children.find((c) => c.name === 'voxel-node 1:-1,-1,-1')!;
    // At the node's corner: 64 level-0 cells a side.
    expect(g.position.toArray()).toEqual([-64 * VOXEL_SIZE_M, -64 * VOXEL_SIZE_M, -64 * VOXEL_SIZE_M]);
    const mesh = surfaceOf(g);
    // Positions in the level's cells (1 m): the node's derive scaled, and its grid read in 1 m cells.
    expect(triangles(mesh.geometry)).toEqual(triangles(voxelSurfaceGeometry([node.ground, node.base], 1)));
    const values = mesh.userData[VOXEL_SURFACE_KEY] as VoxelSurfaceObject;
    expect(values.cellMetres).toBe(1);
    if (shaderSolidEntry(node.shader) < 0) {
      expect(r.uploads.length).toBe(uploads + 1);
      const want = shaderGridEntries(node.shader, new Uint16Array(34 ** 3));
      expect(r.uploads.at(-1)!.entries.every((e, i) => e === want[i])).toBe(true);
    }
    // The seam: at the coarse node's corner, its piece moved there from its own origin (level-0 steps), and shaded
    // from the node's grid.
    const seamMesh = view.root.children.find((c) => c.name.startsWith('voxel-seam '))! as THREE.Mesh;
    expect(seamMesh.position.toArray()).toEqual(g.position.toArray());
    const shift = fineCorner.map((c) => (c + 64) * VOXEL_SIZE_M);
    const want = voxelSurfaceGeometry([node.ground, node.base], VOXEL_SIZE_M)!;
    const wp = want.getAttribute('position');
    const sp = seamMesh.geometry.getAttribute('position');
    expect(sp.count).toBe(wp.count);
    // voxelSurfaceGeometry counts from one cell below the corner; a seam piece from its origin.
    for (let i = 0; i < sp.count; i += 11) for (let a = 0; a < 3; a++) expect(sp.getComponent(i, a)).toBeCloseTo(wp.getComponent(i, a) + VOXEL_SIZE_M + shift[a]!, 5);
    expect(seamMesh.userData[VOXEL_SURFACE_KEY]).toBe(values);
    expect(view.seamTriangles).toBe(seamMesh.geometry.index!.count / 3);
    // Counted: the node's meshes and grid region, and the seam's mesh.
    const geoBytes = (g: THREE.BufferGeometry): number => Object.values(g.attributes).reduce((n, a) => n + (a as THREE.BufferAttribute).array.byteLength, g.index?.array.byteLength ?? 0);
    expect(feed.mips.gpuBytes).toBe(view.coarseBytes());
    expect(feed.mips.gpuBytes).toBeGreaterThanOrEqual(geoBytes(mesh.geometry) + geoBytes(seamMesh.geometry));

    // The node's new result (an edit in its ring): its draw is replaced; the seam reads the new draw's grid.
    const tris = view.triangles;
    emit({ type: 'node', level: 1, nx: -1, ny: -1, nz: -1, removed: false });
    flush();
    const again = surfaceOf(view.root.children.find((c) => c.name === 'voxel-node 1:-1,-1,-1')!);
    expect(again).not.toBe(mesh);
    expect(seamMesh.userData[VOXEL_SURFACE_KEY]).toBe(again.userData[VOXEL_SURFACE_KEY]);
    expect(view.triangles).toBe(tris);

    // Back to level 0: the node and its seam leave in the swap's batch, the level-0 chunks under it come.
    drawn = new Set([...drawn].filter((k) => k !== '1,-1,-1,-1').concat(children.map((c) => `0,${c.join(',')}`)));
    emit({ type: 'seams', built: [], removed: [{ level: 1, nx: -1, ny: -1, nz: -1, face: 1 }] });
    emit({ type: 'levels', reason: 'swap', added: children.map(([nx, ny, nz]) => ({ level: 0, nx, ny, nz })), removed: [{ level: 1, nx: -1, ny: -1, nz: -1 }] });
    expect(view.levelCounts()[1]).toBe(1);
    flush();
    expect(view.levelCounts()[1]).toBe(0);
    expect(view.seamCount).toBe(0);
    expect(view.seamTriangles).toBe(0);
    expect(feed.mips.gpuBytes).toBe(0);
    expect(view.levelCounts()[0]).toBeGreaterThan(level0);
    // A node that loses its result leaves (nothing drawn for it).
    result = null;
    emit({ type: 'node', level: 1, nx: -1, ny: -1, nz: -1, removed: true });
    flush();
    expect(view.levelCounts()[1]).toBe(0);
    view.dispose();
    expect(view.count).toBe(0);
    expect(view.regions).toBe(0);
  });
  it('draws a chunk 8 km out (origin never moved) with a model-view made in 64 bits: vertices as exact as near the origin', () => {
    const s = world();
    const { view } = setup();
    // A chunk with ground, wall and beam, drawn 512 chunks (8,192 m) out on x and z.
    const far = 512;
    view.set(far, 0, far, joined(s, 0, 0, -1, view.cells));
    const scene = new THREE.Scene();
    scene.add(view.root);
    const g = view.root.children[0]!;
    expect(g.position.x).toBe(far * 32 * VOXEL_SIZE_M);
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 300);
    camera.position.set(far * 16 + 3.37, 6.13, far * 16 + 9.71);
    camera.lookAt(far * 16 + 4, 2, far * 16 + 2);
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    const surface = surfaceOf(g);
    const piece = g.children.find((c): c is THREE.InstancedMesh => c instanceof THREE.InstancedMesh)!;
    expect(piece).toBeDefined();
    // Both programs take the view-space position from the 64-bit matrix, never from camera view × model world on the GPU.
    const r = wgslRenderer();
    for (const mesh of [surface, piece]) {
      const vertex = wgslOf(r, scene, mesh).split('@fragment')[0]!;
      expect(vertex).not.toMatch(/cameraViewMatrix \* object\./);
      expect(vertex).toMatch(/modelViewMatrix = object\.nodeUniform\d+;/);
      // Refreshed at every draw (the matrix follows a moving camera), the plain piece material too.
      expect((observerOf(r, scene, mesh) as unknown as { hasNode: boolean }).hasNode).toBe(true);
      expect(vertex).toMatch(/v_positionView = \( modelViewMatrix \* vec4<f32>\( (varyings\.)?positionLocal, 1\.0 \) \)\.xyz/);
    }
    const f = Math.fround;
    const mul32 = (a: readonly number[], b: readonly number[]): number[] => {
      const out = new Array<number>(16).fill(0);
      for (let c = 0; c < 4; c++) for (let r2 = 0; r2 < 4; r2++) {
        let acc = 0;
        for (let k = 0; k < 4; k++) acc = f(acc + f(f(a[k * 4 + r2]!) * f(b[c * 4 + k]!)));
        out[c * 4 + r2] = acc;
      }
      return out;
    };
    const apply32 = (m: readonly number[], p: THREE.Vector3): THREE.Vector3 => {
      const e = m.map(f);
      const row = (r2: number): number => f(f(f(f(e[r2]! * f(p.x)) + f(e[4 + r2]! * f(p.y))) + f(e[8 + r2]! * f(p.z))) + e[12 + r2]!);
      return new THREE.Vector3(row(0), row(1), row(2));
    };
    const pos = surface.geometry.getAttribute('position');
    let worst = 0;
    let worstGpu = 0;
    const update = (cameraRelativeModelView as unknown as { update(frame: { object: THREE.Object3D; camera: THREE.Camera }): void }).update;
    update.call(cameraRelativeModelView, { object: surface, camera });
    const mv = (cameraRelativeModelView.value as THREE.Matrix4).elements;
    // What three's node materials do by default: both matrices rounded to 32 bits and multiplied on the GPU.
    const gpu = mul32(camera.matrixWorldInverse.elements, surface.matrixWorld.elements);
    for (let i = 0; i < pos.count; i += 7) {
      const local = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      // Exact: the vertex to world metres and into the camera's space in 64 bits.
      const exact = camera.worldToLocal(surface.localToWorld(local.clone()));
      worst = Math.max(worst, apply32(mv, local).distanceTo(exact));
      worstGpu = Math.max(worstGpu, apply32(gpu, local).distanceTo(exact));
    }
    // Within a few 32-bit steps of a 10 m position (~1 µm); the default way is off by a large part of a millimetre.
    expect(worst).toBeLessThan(1e-5);
    expect(worstGpu).toBeGreaterThan(1e-4);
    // The pieces' instances apply first (to the local position), so their matrix is the same kind.
    update.call(cameraRelativeModelView, { object: piece, camera });
    const pv = (cameraRelativeModelView.value as THREE.Matrix4).elements;
    expect(Math.hypot(pv[12]!, pv[13]!, pv[14]!)).toBeLessThan(30);
  });
});
