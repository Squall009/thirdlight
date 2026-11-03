/**
 * The voxel chunk view against the voxel package's real derive and join: a
 * chunk drawn from its 16³ sections joined is one surface mesh holding the
 * whole-chunk derive's triangles, its stand-in pieces, and a shader grid
 * uploaded with the whole-chunk derive's entries (or its one solid entry
 * passed, no region); a shader-only change uploads the grid again and
 * builds no mesh; a floating-origin re-base moves every chunk to its new
 * 32-bit position; a chunk 8 km out, its origin never moved (Play), draws
 * with a model-view made in 64 bits, its vertices as exact as near the
 * origin, the surface and the pieces alike; the feed replaces a swap's chunks in the task that
 * announces them and counts their bytes against the stream budget.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildApron,
  chunkGrid,
  createWorldStore,
  deriveFromStore,
  deriveSectionsWithApron,
  FloatingOrigin,
  jobRadius,
  joinSectionsForDraw,
  MATERIAL_BITS,
  PLACEHOLDER_RULES,
  SHADER_BORDER_CELLS,
  shaderGridEntries,
  shaderGridSide,
  shaderSolidEntry,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  WETNESS_MAX,
  type JoinedDraw,
  type PaletteStore,
  type StreamEvent,
} from '@thirdlight/voxel';

import { feedVoxelChunkView, VoxelChunkView, voxelStandInLook, voxelSurfaceGeometry } from './voxel-chunk-view';
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
  const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX }, { look: voxelStandInLook, blendMetres: 0.25 });
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
      on: (l: (e: StreamEvent) => void) => void listeners.push(l),
      joinedChunk: (cx: number, cy: number, cz: number, _times: unknown, cells: Uint16Array) => joined(s, cx, cy, cz, cells),
      setPart: (cx: number, cy: number, cz: number, part: string, bytes: number) => {
        parts.set(`${cx},${cy},${cz}:${part}`, bytes);
        return true;
      },
    };
    const replaced: string[] = [];
    feedVoxelChunkView(view, feed, (x) => replaced.push(`${x.cx},${x.cy},${x.cz}${x.shaderOnly ? ':shader' : ''}`));
    const emit = (e: StreamEvent): void => listeners.forEach((l) => l(e));
    const corner = [[-1, 0, -1], [-1, 0, 0], [0, 0, -1], [0, 0, 0]] as const;
    for (const [cx, cy, cz] of corner) emit({ type: 'chunk', cx, cy, cz, shaderOnly: false });
    // Drawn before the swap event would follow: nothing waits for a later frame.
    expect(view.count).toBe(4);
    expect(replaced).toEqual(corner.map((c) => c.join(',')));
    for (const [cx, cy, cz] of corner) expect(parts.get(`${cx},${cy},${cz}:mesh`)).toBeGreaterThan(0);
    const builds = view.meshBuilds;
    emit({ type: 'chunk', cx: 0, cy: 0, cz: 0, shaderOnly: true });
    expect(view.meshBuilds).toBe(builds);
    expect(replaced.at(-1)).toBe('0,0,0:shader');
    emit({ type: 'unloaded', cx: 0, cy: 0, cz: 0 } as StreamEvent);
    expect(view.has(0, 0, 0)).toBe(false);
    expect(view.count).toBe(3);
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
