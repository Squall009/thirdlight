/**
 * Relief displacement as three builds it, on a real relief derive: a chunk
 * of the voxel package's relief mesh (16³ sections, joined) drawn by the
 * chunk view carries its crease weights as an attribute and culling bounds
 * grown by the deepest height depth; its vertex program (WGSL and GLSL)
 * reads the heights at an explicit level (no sharper than the vertex
 * spacing) from the albedos' A (texture layout v1 as amended), or under the debug
 * patterns from the test heights; a plain chunk's program reads none;
 * where shadows are drawn a relief chunk casts from its plain surfaces (a
 * caster only the shadow cameras see) and looks its shadow up at its plain
 * place, and three's shadow pass of a relief mesh that casts itself takes
 * the material's position node; without relief nothing of it is built. And the test
 * heights themselves: deterministic, tileable, using the 0–1 range.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { describe, expect, it } from 'vitest';
import {
  buildApron,
  chunkGrid,
  createWorldStore,
  deriveSectionsWithApron,
  FloatingOrigin,
  jobRadius,
  joinSectionsForDraw,
  MATERIAL_BITS,
  PLACEHOLDER_RULES,
  SHADER_BORDER_CELLS,
  SHADER_READ_DEPTH_CELLS,
  shaderGridSide,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  WETNESS_MAX,
  type JoinedDraw,
  type PaletteStore,
} from '@thirdlight/voxel';

import { glslRenderer, settle, wgslOf, wgslRenderer } from './test-wgsl';
import { shadowSeesCutaways } from './block-cutaway-view';
import { VOXEL_CASTER_KEY, VoxelChunkView, voxelStandInLook } from './voxel-chunk-view';
import { OFF_VIEW_LAYER } from './view-hidden';
import { RELIEF_TEST_LAYERS, RELIEF_TEST_MAX_DEPTH_M, reliefTestHeights, voxelTestRelief } from './voxel-relief';
import { createVoxelSurface, VOXEL_CREASE_ATTRIBUTE, type VoxelGridRenderer, type VoxelMaterialLook } from './voxel-surface';
import { textureHeightAt, textureSetAt, type TextureSetPoint, type TextureSetSource } from './voxel-surface-sets';
import type { N } from './effects-tsl';
import { VoxelWorldDraws } from './voxel-world-draws';

const grid = chunkGrid(32);
const R = jobRadius(PLACEHOLDER_RULES);
const SECTION = 16;
const LAYOUT = { cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS };
/** A program builder whose shadow maps are on (the lights' shadow nodes build; with no device, a WebGPU build gives the plain answer to what it can do). */
const shadowed = <T>(r: T, device = true): T => {
  (r as unknown as { shadowMap: { enabled: boolean } }).shadowMap.enabled = true;
  if (device) (r as unknown as { hasCompatibility: () => boolean }).hasCompatibility = () => false;
  return r;
};
/** Small height layers: the program and the bounds do not depend on the size. */
const SIZE = 16;
const heights = { size: SIZE, layers: RELIEF_TEST_LAYERS.map((_, k) => new Uint8Array(SIZE * SIZE).fill(40 * k)) };
const look = (m: number): VoxelMaterialLook => {
  const r = voxelTestRelief(m);
  return { ...voxelStandInLook(m), ...(r === null ? {} : { heightDepthMetres: r.depthMetres, testHeightLayer: r.layer }) };
};

/** Rock ground (id 1) with a stone wall (id 10) on it, inside chunk (0, 0, 0). */
function world(): PaletteStore {
  const s = createWorldStore(grid);
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 6; y++) s.setVoxel(x, y, z, { material: 1, role: VOXEL_ROLE.terrain, shape: 15, wetness: 0 });
  for (let x = 8; x < 20; x++) for (let y = 6; y < 14; y++) s.setVoxel(x, y, 12, { material: 10, role: VOXEL_ROLE.wall, shape: 15, wetness: 0 });
  return s;
}

/** Chunk (0, 0, 0)'s 16³ sections derived as the worker does, with the relief mesh `n` steps a cell (null: none), joined. */
function joined(s: PaletteStore, n: number | null): JoinedDraw {
  const ids = Array.from({ length: 8 }, (_, i) => i);
  const results = deriveSectionsWithApron(grid, PLACEHOLDER_RULES, buildApron(s, 0, 0, 0, R), (out) => s.exportChunk(0, 0, 0, out), SECTION, ids, 0, undefined, n === null ? null : () => ({ n }));
  return joinSectionsForDraw(grid.edge, SECTION, results.map((r) => r.assembly), new Uint16Array(LAYOUT.side ** 3));
}

const noUploads: VoxelGridRenderer = { backend: { isWebGLBackend: true, get: () => ({}), copyTextureToTexture: () => undefined }, initTexture: () => undefined, copyTextureToTexture: () => undefined };

/** The chunk drawn by a view with a relief surface (texture sets; `patterns`: the debug program on the test heights): its surface mesh. */
function drawn(d: JoinedDraw, relief: boolean, patterns = false, reliefOn = true): { mesh: THREE.Mesh; surface: ReturnType<typeof createVoxelSurface> } {
  const surface = createVoxelSurface(LAYOUT, { look, blendMetres: 0.25, relief: reliefOn, ...(patterns ? { patterns, ...(reliefOn ? { heights } : {}) } : {}) });
  const view = new VoxelChunkView({ grid, origin: new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } }), surface, renderer: noUploads });
  const shown = relief ? { ground: d.relief!.ground, base: d.relief!.base } : { ground: d.ground, base: d.base };
  view.set(0, 0, 0, { ...shown, instances: d.instances, solid: d.solid });
  let mesh: THREE.Mesh | null = null;
  view.root.traverse((o) => {
    if (o instanceof THREE.Mesh && o.userData['voxelKitPiece'] !== true) mesh = o;
  });
  return { mesh: mesh!, surface };
}

const stage = (src: string, which: 'vertex' | 'fragment'): string => {
  const at = src.indexOf('@fragment');
  return which === 'vertex' ? src.slice(0, at) : src.slice(at);
};

describe('relief displacement', () => {
  it('draws a relief chunk with its crease weights and bounds grown by the deepest height depth; its vertex stage reads the albedos\' heights at an explicit level on both backends (the patterns: the test heights), a plain chunk\'s reads none', async () => {
    await settle();
    const s = world();
    const d = joined(s, 4);
    expect(d.relief).toBeDefined();
    const { mesh, surface } = drawn(d, true);
    const geo = mesh.geometry;
    const crease = geo.getAttribute(VOXEL_CREASE_ATTRIBUTE);
    expect(crease.count).toBe(d.relief!.ground.vertexCount + d.relief!.base.vertexCount);
    const bytes = [...d.relief!.ground.crease.subarray(0, d.relief!.ground.vertexCount), ...d.relief!.base.crease.subarray(0, d.relief!.base.vertexCount)];
    for (let i = 0; i < crease.count; i += 97) expect(crease.getX(i)).toBeCloseTo(bytes[i]! / 255, 6);
    // Both kinds of vertex are there: fixed (creases, borders) and free.
    expect(bytes.some((b) => b === 0) && bytes.some((b) => b === 255)).toBe(true);
    // The bounds: the plain positions' sphere grown by the deepest height depth of any material (rock's).
    expect(surface.reliefDepthM).toBe(RELIEF_TEST_MAX_DEPTH_M);
    const plain = new THREE.BufferGeometry().setAttribute('position', geo.getAttribute('position'));
    plain.computeBoundingSphere();
    expect(geo.boundingSphere!.radius).toBeCloseTo(plain.boundingSphere!.radius + RELIEF_TEST_MAX_DEPTH_M, 6);
    const scene = new THREE.Scene().add(new THREE.HemisphereLight(0xffffff, 0x444444, 1), new THREE.DirectionalLight(0xffffff, 2), mesh);
    const wgsl = wgslOf(wgslRenderer(), scene, mesh);
    const vs = stage(wgsl, 'vertex');
    // Two materials, three projections each of the albedo array (its A), every one at an explicit level (the vertex
    // stage has no derivatives).
    expect((vs.match(/\btextureSampleLevel\s*\(/g) ?? []).length).toBe(6);
    expect(vs).toMatch(/texture_2d_array<f32>/);
    // The blend's grid reads (eight cells, the one under a roof apex, an owned face's cell) and the table's.
    expect((vs.match(/\btextureLoad\(\s*\w+,\s*vec3<i32>\(/g) ?? []).length).toBe(10);
    expect(vs).toMatch(new RegExp(`\\b${VOXEL_CREASE_ATTRIBUTE}\\b`));
    // The fragment's lighting normal is the normal maps' (no bump from screen derivatives on top): its derivatives are
    // a plain textured surface's. The debug patterns: the same displacement from the test heights, and the lighting
    // normal bent by them (derivatives more).
    const dpdx = (src: string): number => (stage(src, 'fragment').match(/\bdpdx\b/g) ?? []).length;
    const plainTextured = drawn(d, false, false, false).mesh;
    expect(dpdx(wgsl)).toBe(dpdx(wgslOf(wgslRenderer(), new THREE.Scene().add(new THREE.DirectionalLight(0xffffff, 2), plainTextured), plainTextured)));
    const dbg = drawn(d, true, true);
    const dwgsl = wgslOf(wgslRenderer(), new THREE.Scene().add(new THREE.DirectionalLight(0xffffff, 2), dbg.mesh), dbg.mesh);
    expect((stage(dwgsl, 'vertex').match(/\btextureSampleLevel\s*\(/g) ?? []).length).toBe(6);
    const plainDbg = drawn(d, false, true, false).mesh;
    expect(dpdx(dwgsl)).toBeGreaterThan(dpdx(wgslOf(wgslRenderer(), new THREE.Scene().add(new THREE.DirectionalLight(0xffffff, 2), plainDbg), plainDbg)));
    expect(dbg.surface.reliefDepthM).toBe(RELIEF_TEST_MAX_DEPTH_M);
    const glsl = wgslOf(glslRenderer(), scene, mesh);
    // The GLSL vertex program is the first of the two (each starts with its #version line).
    const gvs = glsl.slice(0, glsl.indexOf('#version', 1));
    expect((gvs.match(/\btextureLod\s*\(/g) ?? []).length).toBe(6);
    // A plain chunk of the same surface: no crease attribute, no height read in its vertex stage, no grown bounds.
    const flat = drawn(joined(s, null), false).mesh;
    expect(flat.geometry.getAttribute(VOXEL_CREASE_ATTRIBUTE)).toBeUndefined();
    const fvs = stage(wgslOf(wgslRenderer(), new THREE.Scene().add(new THREE.DirectionalLight(0xffffff, 2), flat), flat), 'vertex');
    expect(fvs).not.toMatch(/\btextureSampleLevel\s*\(/);
    expect(fvs).not.toMatch(/\btextureLoad\s*\(/);
  });

  it("casts a relief chunk's shadow from its plain surfaces where shadows are drawn: the relief mesh casts none, a plain caster only the shadow cameras see casts, and the relief looks its shadow up at its plain place; `reliefCasters: 'relief'` casts the displaced mesh as before", async () => {
    await settle();
    const d = joined(world(), 4);
    const surface = createVoxelSurface(LAYOUT, { look, blendMetres: 0.25, relief: true });
    const origin = new FloatingOrigin({ grid, rebaseDistanceM: 512, origin: { x: 0, y: 0, z: 0 } });
    const draw = { ground: d.relief!.ground, base: d.relief!.base, caster: { ground: d.ground, base: d.base }, instances: d.instances, solid: d.solid };
    const meshesOf = (view: VoxelChunkView): THREE.Mesh[] => {
      const out: THREE.Mesh[] = [];
      view.root.traverse((o) => {
        if (o instanceof THREE.Mesh && o.userData['voxelKitPiece'] !== true) out.push(o);
      });
      return out;
    };
    const view = new VoxelChunkView({ grid, origin, surface, renderer: noUploads, shadows: true });
    const bytes = view.set(0, 0, 0, draw);
    const meshes = meshesOf(view);
    const relief = meshes.find((m) => m.geometry.getAttribute(VOXEL_CREASE_ATTRIBUTE) !== undefined)!;
    const caster = meshes.find((m) => m.userData[VOXEL_CASTER_KEY] === true)!;
    expect(meshes.length).toBe(2);
    expect([relief.castShadow, relief.receiveShadow, relief.layers.isEnabled(0)]).toEqual([false, true, true]);
    // The caster: the plain triangles, cast only (the view's camera, layer 0, never draws it; a shadow camera that sees
    // the off-view layer does), its world place the relief mesh's.
    expect([caster.castShadow, caster.receiveShadow, caster.layers.isEnabled(0), caster.layers.isEnabled(OFF_VIEW_LAYER)]).toEqual([true, false, false, true]);
    expect(caster.geometry.index!.count).toBe(d.ground.indices.length + d.base.indices.length);
    expect(caster.geometry.getAttribute(VOXEL_CREASE_ATTRIBUTE)).toBeUndefined();
    caster.updateWorldMatrix(true, false);
    relief.updateWorldMatrix(true, false);
    expect(caster.matrixWorld.equals(relief.matrixWorld)).toBe(true);
    const cam = new THREE.PerspectiveCamera();
    const shadowCam = new THREE.OrthographicCamera();
    shadowSeesCutaways(shadowCam);
    expect([caster.layers.test(cam.layers), caster.layers.test(shadowCam.layers), relief.layers.test(cam.layers)]).toEqual([false, true, true]);
    expect(view.pickable).toEqual([relief]);
    // Counted as drawn GPU bytes; its triangles apart from the view's (a sixteenth of the lattice's here).
    const reliefTris = (d.relief!.ground.indices.length + d.relief!.base.indices.length) / 3;
    expect(view.triangles).toBe(reliefTris);
    expect(view.casterTriangles).toBe((d.ground.indices.length + d.base.indices.length) / 3);
    expect(view.casterTriangles).toBeLessThan(reliefTris / 8);
    expect(bytes).toBeGreaterThan(new VoxelChunkView({ grid, origin, surface, renderer: noUploads, shadows: true }).set(0, 0, 0, { ...draw, caster: undefined } as never));
    // The caster's shadow pass reads no height and no grid (its material shades nothing).
    const renderer = wgslRenderer() as unknown as { _getShadowNodes(m: THREE.Material): { positionNode: unknown; colorNode: unknown } };
    expect(renderer._getShadowNodes(caster.material as THREE.Material)).toMatchObject({ positionNode: null, colorNode: null });
    // The relief receives at the plain place: with a shadowed sun its program looks the shadow up at the undisplaced
    // position (without the received position node: at the displaced one); both backends build it.
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.castShadow = true;
    const probe = new THREE.Mesh(relief.geometry, relief.material);
    probe.userData = relief.userData;
    probe.receiveShadow = true;
    const lit = new THREE.Scene().add(sun, probe);
    const withPlain = wgslOf(shadowed(wgslRenderer()), lit, probe);
    const kept = surface.material.receivedShadowPositionNode;
    surface.material.receivedShadowPositionNode = null;
    surface.material.needsUpdate = true;
    const without = wgslOf(shadowed(wgslRenderer()), lit, probe);
    surface.material.receivedShadowPositionNode = kept;
    surface.material.needsUpdate = true;
    // What the shadow lookup's world position is made of in the vertex stage: the geometry's own position attribute
    // (the plain place) or the displaced local position.
    const lookupFrom = (src: string): string => {
      const v = /shadowPositionWorld = (\w+);/.exec(src)![1]!;
      return new RegExp(`varyings\\.${v} = ([^;]+);`).exec(stage(src, 'vertex'))![1]!;
    };
    expect(lookupFrom(withPlain)).toMatch(/vec4<f32>\( position, 1\.0 \)/);
    expect(lookupFrom(without)).toMatch(/positionLocal/);
    expect(wgslOf(shadowed(glslRenderer(), false), lit, probe)).toMatch(/shadowPositionWorld/);
    // Removed: the caster goes with the chunk.
    view.remove(0, 0, 0);
    expect([view.triangles, view.casterTriangles, meshesOf(view).length]).toEqual([0, 0, 0]);
    // Without shadows nothing of it is built; `relief` casters: the relief mesh casts itself, displaced (three's shadow
    // pass takes the material's position node, which builds the displacement for a relief chunk).
    const noShadows = new VoxelChunkView({ grid, origin, surface, renderer: noUploads });
    noShadows.set(0, 0, 0, draw);
    expect(meshesOf(noShadows).length).toBe(1);
    const asBefore = new VoxelChunkView({ grid, origin, surface, renderer: noUploads, shadows: true, reliefCasters: 'relief' });
    asBefore.set(0, 0, 0, draw);
    const [own] = meshesOf(asBefore);
    expect(meshesOf(asBefore).length).toBe(1);
    expect(own!.castShadow).toBe(true);
    expect(renderer._getShadowNodes(surface.material).positionNode).toBe(surface.material.positionNode);
    const shadowMat = new (await import('three/webgpu')).MeshBasicNodeMaterial();
    shadowMat.positionNode = surface.material.positionNode;
    const shadowMesh = new THREE.Mesh(own!.geometry, shadowMat as unknown as THREE.Material);
    shadowMesh.userData = own!.userData;
    const vs = stage(wgslOf(wgslRenderer(), new THREE.Scene().add(shadowMesh), shadowMesh), 'vertex');
    expect((vs.match(/\btextureSampleLevel\s*\(/g) ?? []).length).toBe(6);
  });

  it("draws a game's relief chunks displaced (Play, exports and the Scene view draw through VoxelWorldDraws): a batch's ring state sets the fade, the vertex stage moves them; a view's switch draws them flat", async () => {
    await settle();
    const d = joined(world(), 4);
    const scene = new THREE.Scene().add(new THREE.DirectionalLight(0xffffff, 2));
    const draws = new VoxelWorldDraws({ scene: () => scene, renderer: () => noUploads, report: () => undefined });
    const crease = (r: typeof d.relief): { ground: typeof d.ground & { crease: Uint8Array }; base: typeof d.base & { crease: Uint8Array } } => ({ ground: r!.ground, base: r!.base });
    draws.receive({ world: 'w', edge: grid.edge, chunks: [{ kind: 'draw', cx: 0, cy: 0, cz: 0, ...crease(d.relief), instances: d.instances, solid: d.solid }], swaps: [], relief: { n: 4, radius: 16, focus: [16, 8, 16] }, sentAt: 0, joinMs: 0 });
    const r = draws.stats().worlds['w']!.relief!;
    expect([r.n, r.radiusM, r.displace]).toEqual([4, 8, true]);
    expect(r.vertices).toBe(d.relief!.ground.vertexCount + d.relief!.base.vertexCount);
    let mesh: THREE.Mesh | null = null;
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh && o.userData['voxelKitPiece'] !== true && o.geometry.getAttribute(VOXEL_CREASE_ATTRIBUTE) !== undefined) mesh = o;
    });
    expect(mesh).not.toBeNull();
    const vs = stage(wgslOf(wgslRenderer(), scene, mesh!), 'vertex');
    // The texture sets' program: the albedo array's heights read at an explicit level for the two materials' three projections.
    expect((vs.match(/\btextureSampleLevel\s*\(/g) ?? []).length).toBe(6);
    draws.setRelief({ displace: false });
    expect(draws.stats().worlds['w']!.relief!.displace).toBe(false);
    draws.dispose();
  });

  it("reads a texture set's height from the albedo array's A alone (pixel and vertex stage), its lighting normal from the normal array, and the height nowhere from the normal array", () => {
    const TSL: N = TSLTyped;
    const array = (name: string): THREE.DataArrayTexture => Object.assign(new THREE.DataArrayTexture(new Uint8Array(8), 1, 1, 2), { name });
    const src: TextureSetSource = { maps: { albedo: TSL.texture(array('albedo')), normal: TSL.texture(array('normal')), orm: TSL.texture(array('orm')) }, look: () => TSL.vec4(0, 0, 0, 0), matMask: 2 ** MATERIAL_BITS };
    const at: TextureSetPoint = { n: TSL.vec3(0, 1, 0), p: TSL.vec3(0, 0, 0), gu: TSL.float(0), gv: TSL.float(0), bn: TSL.vec3(0, 1, 0) };
    // The arrays a node graph samples (the names of the textures behind its texture nodes).
    const sampled = (node: N): string[] => {
      const names = new Set<string>();
      node.traverse((x: N) => x.isTextureNode === true && names.add(x.value.name));
      return [...names].sort();
    };
    for (const m of [1, 2 ** MATERIAL_BITS + 1]) {
      const set = textureSetAt(src, TSL.float(m), at);
      expect(sampled(set.height)).toEqual(['albedo']);
      expect(sampled(set.albedo)).toEqual(['albedo']);
      expect(sampled(set.normal)).toEqual(['normal']);
      expect(sampled(textureHeightAt(src, TSL.float(m), at, TSL.float(2)))).toEqual(['albedo']);
    }
  });

  it('builds nothing of relief without it (programs as before), and refuses a look naming a test layer the heights lack or a negative depth', () => {
    const plain = createVoxelSurface(LAYOUT, { look, blendMetres: 0.25, patterns: true });
    expect(plain.material.positionNode).toBeNull();
    expect(plain.material.normalNode).toBeNull();
    expect(plain.reliefDepthM).toBe(0);
    // The texture sets' program has a normal of its own (the normal maps'), still nothing of relief.
    const textured = createVoxelSurface(LAYOUT, { look, blendMetres: 0.25 });
    expect(textured.material.positionNode).toBeNull();
    expect(textured.material.normalNode).not.toBeNull();
    expect(textured.reliefDepthM).toBe(0);
    expect(() => createVoxelSurface(LAYOUT, { look: () => ({ colour: 0, pattern: 0, testHeightLayer: 9 }), blendMetres: 0.25, patterns: true, heights })).toThrow(/relief layer 9/);
    expect(() => createVoxelSurface(LAYOUT, { look: () => ({ colour: 0, pattern: 0, heightDepthMetres: -0.01 }), blendMetres: 0.25 })).toThrow(/height depth/);
  });
});

describe('the relief test heights', () => {
  it('are five deterministic, tileable layers using the 0–1 range (rows and joints where the material has them)', () => {
    const size = 256;
    const a = reliefTestHeights(size);
    const b = reliefTestHeights(size);
    expect(a.length).toBe(RELIEF_TEST_LAYERS.length);
    for (let k = 0; k < a.length; k++) {
      const l = a[k]!;
      expect(l.length).toBe(size * size);
      expect(l.every((v, i) => v === b[k]![i]), RELIEF_TEST_LAYERS[k]).toBe(true);
      let lo = 255;
      let hi = 0;
      for (const v of l) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      expect(hi - lo, RELIEF_TEST_LAYERS[k]).toBeGreaterThan(120);
      // Tileable: the last column runs on into the first (and the last row into the first) as any two neighbours do.
      let wrap = 0;
      let inner = 0;
      for (let y = 0; y < size; y++) {
        wrap += Math.abs(l[y * size + size - 1]! - l[y * size]!);
        inner += Math.abs(l[y * size + size / 2]! - l[y * size + size / 2 - 1]!);
      }
      for (let x = 0; x < size; x++) {
        wrap += Math.abs(l[(size - 1) * size + x]! - l[x]!);
        inner += Math.abs(l[(size / 2) * size + x]! - l[(size / 2 - 1) * size + x]!);
      }
      expect(wrap, RELIEF_TEST_LAYERS[k]).toBeLessThan(inner * 2.5 + size * 4);
    }
  });
});
