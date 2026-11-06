/**
 * The assembly's per-cell outputs and the slice's collision against the
 * real derive and the engine's real physics backend (Rapier through
 * physics-rapier's port): the wall, beam and banister scene's cells read
 * back per consumer, the ground surface cut into meshes a port takes, and
 * bodies dropped and swept against every storage chunk's static body (its
 * 16³ derive sections joined, as the streamer hands them over) — onto the
 * ground, the wall top, the beam and the rail, between the banister's
 * posts, under and onto a balcony's floor edge (a whole block: walls and
 * floors are plain voxels, a detail piece adds no shape), and into a hole
 * dug after the bodies were built. Ground that is
 * a height function collides as a heightfield: drops and sweeps on it land
 * where they land on the same ground as a mesh, and ground with an
 * overhang or underside, ground leaving the chunk, or a box stays a mesh.
 * The collision ring keeps bodies only near a moving focus: added nearest
 * first, removed farthest first past its hysteresis, each counted in the
 * budget, and the physics heap stops growing once the ring has been round.
 */
import {
  ASSEMBLY_CLASS,
  buildApron,
  cellOutputs,
  chunkGrid,
  chunkKey,
  chunkOfKey,
  CollisionRing,
  collisionRingBounds,
  COLLISION_PART,
  collisionGeometry,
  createWorldStore,
  deriveFromStore,
  deriveSectionsWithApron,
  FloatingOrigin,
  groundHeightfield,
  groundHeightfieldPatches,
  jobRadius,
  joinSections,
  WORLD_RULES,
  resolvedClassAt,
  RUN_X,
  RUN_Z,
  VOXEL_ROLE,
  type CollisionBodies,
  type CollisionHeightfield,
  type CollisionSource,
  type DerivedData,
  type PaletteStore,
  type SurfaceBuffer,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { VoxelCollision } from '../../packages/editor/src/voxel-world/collision';
import { loadArea } from './regions';
import { flatGround, placeBalcony, placeWallBeamBanister, putVoxel } from './scenes';
import { MAT } from './world-kit';
import { townWorld } from './town';
import { hillyWorld } from './worlds';
import { FEATURE_BASE, FEATURE_PAD, FEATURE_TOP, FEATURE_WIDTH, featureCases, featuresStore } from './features';
import { physicsMemoryBytes3D } from '@thirdlight/physics-rapier';

const grid = chunkGrid(32);
/** The streamer's derive sections (the engine's default edge). */
const SECTION = 16;
const SECTION_IDS = Array.from({ length: (32 / SECTION) ** 3 }, (_, i) => i);

/** A chunk's collision as the streamer hands it over: its 16³ sections derived and joined. */
function joinedChunk(s: PaletteStore, cx: number, cy: number, cz: number): CollisionSource {
  const apron = buildApron(s, cx, cy, cz, jobRadius(WORLD_RULES));
  const sections = deriveSectionsWithApron(grid, WORLD_RULES, apron, (out) => s.exportChunk(cx, cy, cz, out), SECTION, SECTION_IDS).map((r) => r.assembly);
  return joinSections(grid.edge, SECTION, sections);
}
const C = VOXEL_ROLE;
const SCENE_CHUNKS = [-1, 0].flatMap((x) => [-1, 0].flatMap((y) => [-1, 0].map((z) => [x, y, z] as const)));

function scene(): PaletteStore {
  const s = createWorldStore(grid);
  placeWallBeamBanister(s);
  return s;
}

function outputsAt(s: PaletteStore, x: number, y: number, z: number): ReturnType<typeof cellOutputs> {
  const d = deriveFromStore(s, x >> 5, y >> 5, z >> 5, WORLD_RULES);
  return cellOutputs(d, x & 31, y & 31, z & 31);
}

/** The banister grown upward: the gaps between its posts and a row over its rail filled, as a runtime build would. */
function growBanister(s: PaletteStore): void {
  for (let x = -4; x < 4; x++) {
    if ((x & 1) !== 0) putVoxel(s, x, 1, 7, MAT.timber, C.wall);
    putVoxel(s, x, 3, 7, MAT.timber, C.wall);
  }
}

describe('per-cell outputs of one assembly evaluation', () => {
  it('give the placeholder rules\' beam, rail and post cells what a wall cell gets: plain voxels for render, collision, nav and light', () => {
    const s = scene();
    expect(resolvedClassAt(s, WORLD_RULES, -4, 4, 0)).toBe(ASSEMBLY_CLASS.wall);
    expect(resolvedClassAt(s, WORLD_RULES, -4, 5, -1)).toBe(ASSEMBLY_CLASS.beam | RUN_X);
    expect(resolvedClassAt(s, WORLD_RULES, -3, 2, 7)).toBe(ASSEMBLY_CLASS.rail | RUN_X);
    expect(resolvedClassAt(s, WORLD_RULES, -4, 1, 7)).toBe(ASSEMBLY_CLASS.rail | RUN_X | RUN_Z);

    const wall = outputsAt(s, -4, 5, 0);
    expect(wall).toMatchObject({ renderSolid: true, piece: null, collision: 'full', navBlocks: true, light: 255 });
    // Beams and banisters left the voxel world: their cells are whole voxels for every consumer, no piece in their place.
    const plain = { renderSolid: true, piece: null, collision: 'full', navBlocks: true, light: 255 };
    expect(outputsAt(s, -4, 5, -1)).toMatchObject(plain);
    expect(outputsAt(s, -4, 5, -1).baseFaces).toBeGreaterThan(0);
    expect(outputsAt(s, -3, 2, 7)).toMatchObject(plain);
    expect(outputsAt(s, -4, 1, 7)).toMatchObject(plain);
    // The gap between two posts is open for everything.
    expect(outputsAt(s, -3, 1, 7)).toMatchObject({ renderSolid: false, collision: 'none', navBlocks: false, light: 0, piece: null });
    // Standing: on the wall's top, and on the rail's top (a whole voxel supports like any other).
    expect(outputsAt(s, -4, 8, 0).standable).toBe(true);
    expect(outputsAt(s, -3, 3, 7).standable).toBe(true);

    growBanister(s);
    expect(resolvedClassAt(s, WORLD_RULES, -3, 2, 7)).toBe(ASSEMBLY_CLASS.wall);
    expect(outputsAt(s, -3, 2, 7)).toMatchObject({ renderSolid: true, piece: null, collision: 'full', light: 255 });
    expect(outputsAt(s, -3, 2, 7).baseFaces).toBe(2);
    expect(outputsAt(s, -3, 4, 7).standable).toBe(true);
  });

  it('cut the ground surface into meshes within a port\'s limits without losing a triangle', () => {
    const s = scene();
    const d = deriveFromStore(s, -1, -1, -1, WORLD_RULES);
    const whole = collisionGeometry(d);
    expect(whole.meshes).toHaveLength(1);
    const tris = whole.meshes[0]!.indices.length / 3;
    expect(tris).toBeGreaterThan(200);
    const cut = collisionGeometry(d, { maxVertices: 64, maxTriangles: 50 });
    expect(cut.meshes.length).toBeGreaterThan(tris / 50 - 1);
    const key = (m: { vertices: Float32Array; indices: Uint32Array }, t: number): string =>
      [0, 1, 2].map((k) => [0, 1, 2].map((a) => m.vertices[m.indices[t * 3 + k]! * 3 + a]!.toFixed(4)).join(',')).join('|');
    const want = new Set(Array.from({ length: tris }, (_, t) => key(whole.meshes[0]!, t)));
    const got: string[] = [];
    for (const m of cut.meshes) {
      expect(m.vertices.length / 3).toBeLessThanOrEqual(64);
      expect(m.indices.length / 3).toBeLessThanOrEqual(50);
      for (let t = 0; t < m.indices.length / 3; t++) got.push(key(m, t));
    }
    expect(got).toHaveLength(tris);
    expect(new Set(got)).toEqual(want);
  });
});

describe('collision through the engine physics backend', () => {
  async function world(s: PaletteStore): Promise<{ physics: VoxelCollision; rebuild: () => void }> {
    const physics = await VoxelCollision.create(grid, new FloatingOrigin({ grid, origin: { x: 0, y: 0, z: 0 } }));
    const rebuild = (): void => {
      for (const [cx, cy, cz] of SCENE_CHUNKS) physics.set(cx * 1000 + cy * 100 + cz, cx, cy, cz, joinedChunk(s, cx, cy, cz));
    };
    rebuild();
    return { physics, rebuild };
  }

  it('rests capsules on the ground, the wall top, the former beam and rail (whole voxels); a sphere passes between the posts and stops at the wall', async () => {
    const s = scene();
    const { physics, rebuild } = await world(s);
    expect(physics.count).toBe(8);
    // Feet in cells: the ground's surface is at y 0, the wall's top at 8, the beam cell's top at 6, the rail's at 3.
    const ground = physics.dropCapsule([10.5, 4, 10.5], 0.2, 0.2);
    expect(ground.grounded).toBe(true);
    expect(ground.feet[1]).toBeCloseTo(0, 0);
    expect(physics.dropCapsule([-4.5, 12, 0.5], 0.2, 0.2).feet[1]).toBeCloseTo(8, 1);
    expect(physics.dropCapsule([-4.5, 10, -0.5], 0.1, 0.1).feet[1]).toBeCloseTo(6, 1);
    const onRail = physics.dropCapsule([-2.5, 6, 7.5], 0.1, 0.1);
    expect(onRail.grounded).toBe(true);
    expect(onRail.feet[1]).toBeCloseTo(3, 1);

    // A ball rolled toward the wall at post height: between two posts and under the rail it reaches the wall (z 1 + radius);
    // in line with a post it stops at the post's cell, a whole voxel (z 8 + radius).
    const r = 0.3;
    const gap = physics.castSphere([-2.5, 1.5, 12], [0, 0, -1], 0.15, 20);
    expect(gap?.centre[2]).toBeCloseTo(1 + r, 1);
    const atPost = physics.castSphere([-3.5, 1.5, 12], [0, 0, -1], 0.15, 20);
    expect(atPost?.centre[2]).toBeCloseTo(8 + r, 1);

    // Grown upward the run is a wall: the ball stops at its face (z 8), and the capsule rests on its new top (y 4).
    growBanister(s);
    rebuild();
    expect(physics.castSphere([-2.5, 1.5, 12], [0, 0, -1], 0.15, 20)?.centre[2]).toBeCloseTo(8 + r, 1);
    expect(physics.dropCapsule([-2.5, 8, 7.5], 0.1, 0.1).feet[1]).toBeCloseTo(4, 1);

    // Dig a 2 m pit after the bodies were built, re-derive: a capsule dropped over it falls in, a metre deeper.
    for (let x = 6; x < 10; x++) for (let z = -10; z < -6; z++) for (let y = -2; y < 0; y++) putVoxel(s, x, y, z, 0, 0);
    expect(physics.dropCapsule([8, 4, -8.5], 0.15, 0.15).feet[1]).toBeCloseTo(0, 0);
    rebuild();
    const inPit = physics.dropCapsule([8, 4, -8.5], 0.15, 0.15);
    expect(inPit.grounded).toBe(true);
    expect(inPit.feet[1]).toBeLessThan(-1.5);
    expect(physics.adds).toBe(24);
    expect(physics.removes).toBe(16);
  });

  it('collides a balcony\'s floor edge as the whole block it is (no soffit shape): a capsule stands on top, a ball from below meets its underside', async () => {
    const s = createWorldStore(grid);
    placeBalcony(s);
    const { physics } = await world(s);
    // The floor's top is at y 5 (cells) over the plain floor and at its front edge alike.
    expect(physics.dropCapsule([1.5, 8, 1.5], 0.1, 0.1).feet[1]).toBeCloseTo(5, 1);
    const onEdge = physics.dropCapsule([1.5, 8, 3.5], 0.1, 0.1);
    expect(onEdge.grounded).toBe(true);
    expect(onEdge.feet[1]).toBeCloseTo(5, 1);
    // From below, a ball rising under the plain floor and under its front and side edges stops at the underside (y 4).
    const r = 0.3;
    expect(physics.castSphere([1.5, 1.5, 1.5], [0, 1, 0], 0.15, 20)?.centre[1]).toBeCloseTo(4 - r, 1);
    expect(physics.castSphere([1.5, 1.5, 3.5], [0, 1, 0], 0.15, 20)?.centre[1]).toBeCloseTo(4 - r, 1);
    expect(physics.castSphere([3.5, 1.5, 2.5], [0, 1, 0], 0.15, 20)?.centre[1]).toBeCloseTo(4 - r, 1);
  });
});

/** A surface buffer of lattice vertices (cells from the chunk's corner), split as the voxel ground splits its quads. */
function latticeSurface(edge: number, height: (i: number, k: number) => number, inset = 0): SurfaceBuffer {
  const n = edge + 1;
  const vertices = new Uint8Array(n * n * 12);
  const view = new DataView(vertices.buffer);
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
    const at = (i * n + k) * 12;
    // Positions in 1/1024 cell steps from one cell below the chunk's corner.
    view.setUint16(at, Math.round((i + 1 + (i === 0 ? inset : 0)) * 1024), true);
    view.setUint16(at + 2, Math.round((height(i, k) + 1) * 1024), true);
    view.setUint16(at + 4, (k + 1) * 1024, true);
  }
  const tris: number[] = [];
  for (let i = 0; i < edge; i++) for (let k = 0; k < edge; k++) {
    const a = i * n + k;
    // (min x, min z) → (+x, +z) diagonal, counter-clockwise seen from above.
    tris.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
  }
  return { vertexCount: n * n, vertices, indices: Uint32Array.from(tris) };
}

const NO_BOXES = { boxes: new Uint16Array(0), fullBoxes: 0, ramps: { vertexCount: 0, vertices: new Uint8Array(0), indices: new Uint16Array(0) } };

describe('ground as a heightfield', () => {
  it('stands for bumpy ground whose every cell bends across its diagonal: rays, sweeps and drops land where they land on the same ground as a mesh', async () => {
    // Heights in cells, on the lattice: the heightfield stands for the mesh exactly, so only a wrong split, a wrong turn
    // or a late sweep shows.
    const bumps = (i: number, k: number): number => 2 + 1.5 * Math.sin(i * 0.9) + 1.2 * Math.cos(k * 1.3) + ((i * 7 + k * 3) % 5) * 0.2;
    // The second ground's vertices on the x = 0 face sit 0.3 cells inside the chunk (as a neighbour's shared vertices may):
    // the nodes on that face are under no triangle of this chunk, so the heightfield starts a node in and the strip's
    // triangles stay a mesh.
    for (const inset of [0, 0.3]) {
      const src: CollisionSource = { edge: 32, collision: NO_BOXES, ground: latticeSurface(32, bumps, inset) };
      // Sloped ground collides as a heightfield by default; `level` keeps it a mesh.
      expect(collisionGeometry(src, {}, 'level').heightfields).toHaveLength(0);
      const geo = collisionGeometry(src);
      expect(geo.heightfields).toEqual([expect.objectContaining(inset === 0 ? { x: 0, z: 0, cellsX: 32, cellsZ: 32 } : { x: 0.5, z: 0, cellsX: 31, cellsZ: 32 })]);
      expect(geo.meshes.reduce((n, m) => n + m.indices.length / 3, 0)).toBe(inset === 0 ? 0 : 64);
      const origin = (): FloatingOrigin => new FloatingOrigin({ grid, origin: { x: 0, y: 0, z: 0 } });
      const field = await VoxelCollision.create(grid, origin());
      const mesh = await VoxelCollision.create(grid, origin(), false);
      for (const p of [field, mesh]) p.set(1, 0, 0, 0, src);
      expect(field.stats()).toMatchObject({ bodies: 1, heightfields: 1, patches: 1 });
      expect(mesh.stats()).toMatchObject({ bodies: 1, heightfields: 0 });
      expect(field.stats()['bytes'] as number).toBeLessThan((mesh.stats()['bytes'] as number) / 3);
      let worst = 0;
      // Thin rays down through points on both diagonals of cells and between them, the strip included.
      for (let x = 0.45; x < 32; x += 1.37) for (let z = 0.2; z < 32; z += 1.29) {
        const a = field.castSphere([x, 12, z], [0, -1, 0], 0.01, 20);
        const b = mesh.castSphere([x, 12, z], [0, -1, 0], 0.01, 20);
        expect(a, `${x},${z}`).not.toBeNull();
        worst = Math.max(worst, Math.abs(a!.distanceM - b!.distanceM));
      }
      expect(worst).toBeLessThan(0.001);
      expect(sweepsAgree(field, mesh, [1, 31, 1, 31], 6, 300).worst).toBeLessThan(0.01);
      for (const [x, z] of [[0.4, 5.5], [5.5, 5.5], [16.2, 9.7], [27.4, 21.1], [9.9, 30.3]] as const) {
        const a = field.dropCapsule([x, 10, z], 0.2, 0.2);
        const b = mesh.dropCapsule([x, 10, z], 0.2, 0.2);
        expect(a.grounded && b.grounded).toBe(true);
        expect(Math.abs(a.feet[1] - b.feet[1]) * 0.5, `${x},${z}`).toBeLessThan(0.01);
      }
    }
  });

  it('in the town, ground collides as heightfield patches and lands drops and sweeps as the meshes do, houses and all', async () => {
    const s = createWorldStore(grid);
    loadArea(townWorld({ footprint: 512 }).grids[0]!, s, 0, 0, 224, 224);
    const chunks: Array<[number, number, number]> = [];
    const c = { cx: 0, cy: 0, cz: 0 };
    const seen = new Set<string>();
    for (const key of s.chunkKeys()) {
      chunkOfKey(grid, key, c);
      if (c.cx < 1 || c.cx > 5 || c.cz < 1 || c.cz > 5) continue;
      for (let cy = c.cy - 1; cy <= c.cy + 1; cy++) {
        const id = `${c.cx},${cy},${c.cz}`;
        if (seen.has(id)) continue;
        seen.add(id);
        chunks.push([c.cx, cy, c.cz]);
      }
    }
    const origin = (): FloatingOrigin => new FloatingOrigin({ grid, origin: { x: 0, y: 0, z: 0 } });
    const field = await VoxelCollision.create(grid, origin());
    const mesh = await VoxelCollision.create(grid, origin(), false);
    const fields: Array<[number, number, number]> = [];
    for (const [cx, cy, cz] of chunks) {
      const d = joinedChunk(s, cx, cy, cz);
      const key = (cx * 64 + cy + 8) * 64 + cz;
      field.set(key, cx, cy, cz, d);
      mesh.set(key, cx, cy, cz, d);
      const geo = collisionGeometry(d);
      if (geo.heightfields.length === 0) continue;
      fields.push([cx, cy, cz]);
      // Joined sections' ground is the whole-chunk derive's: the same patches.
      const whole = groundHeightfieldPatches(deriveFromStore(s, cx, cy, cz, WORLD_RULES).ground, 32).patches;
      expect(whole.map((p) => [p.x0, p.z0, p.cellsX, p.cellsZ, ...p.heights])).toEqual(geo.heightfields.map((p) => [p.x / 0.5, p.z / 0.5, p.cellsX, p.cellsZ, ...p.heights]));
    }
    expect(field.stats()['heightfields']).toBe(fields.length);
    expect(fields.length).toBeGreaterThanOrEqual(5);
    expect(field.stats()['bytes'] as number).toBeLessThan(mesh.stats()['bytes'] as number);
    let worst = 0;
    let drops = 0;
    for (const [cx, , cz] of fields) {
      // Across the chunk and over its faces into the neighbours.
      for (let x = cx * 32 - 1.3; x < cx * 32 + 33; x += 4.7) for (let z = cz * 32 - 0.9; z < cz * 32 + 33; z += 5.3) {
        const a = field.castSphere([x, 200, z], [0, -1, 0], 0.01, 400);
        const b = mesh.castSphere([x, 200, z], [0, -1, 0], 0.01, 400);
        expect(a === null, `${x},${z}`).toBe(b === null);
        if (a === null || b === null) continue;
        worst = Math.max(worst, Math.abs(a.distanceM - b.distanceM));
        const slant: [number, number, number] = [0.6, -1, -0.3];
        const sa = field.castSphere([x, a.centre[1] + 6, z], slant, 0.25, 30);
        const sb = mesh.castSphere([x, a.centre[1] + 6, z], slant, 0.25, 30);
        if (sa !== null && sb !== null) worst = Math.max(worst, Math.abs(sa.distanceM - sb.distanceM));
        if (drops++ % 7 !== 0) continue;
        const fa = field.dropCapsule([x, a.centre[1] + 2, z], 0.2, 0.3);
        const fb = mesh.dropCapsule([x, a.centre[1] + 2, z], 0.2, 0.3);
        expect(fa.grounded && fb.grounded, `${x},${z}`).toBe(true);
        worst = Math.max(worst, Math.abs(fa.feet[1] - fb.feet[1]) * 0.5);
      }
    }
    expect(drops).toBeGreaterThan(50);
    expect(worst).toBeLessThan(0.01);
  }, 60_000);

  it('keeps an overhang and ground leaving the chunk as meshes, the rest of their chunks patches; boxes beside a patch', () => {
    const s = createWorldStore(grid);
    flatGround(s, -40, 104, -40, 72, 40, 4);
    // A ledge of ground over air in chunk (0, 0, 0): its underside faces down over the ground below.
    for (let x = 8; x < 20; x++) for (let z = 8; z < 20; z++) for (let y = 10; y < 13; y++) putVoxel(s, x, y, z, MAT.soil, C.terrain);
    const ledge = joinedChunk(s, 0, 0, 0);
    expect(groundHeightfield(ledge.ground, 32)).toBe('facing');
    // No patch over the ledge or the ground under it (cells 8–20, a cell of slack for the ledge's rounded rim).
    const overLedge = (p: CollisionHeightfield): boolean => p.x / 0.5 < 21 && p.x / 0.5 + p.cellsX > 7 && p.z / 0.5 < 21 && p.z / 0.5 + p.cellsZ > 7;
    const ledgeGeo = collisionGeometry(ledge);
    expect(ledgeGeo.heightfields.length).toBeGreaterThan(0);
    expect(ledgeGeo.heightfields.filter(overLedge)).toEqual([]);
    // The flat chunk beside it is one field.
    const flat = collisionGeometry(joinedChunk(s, 1, 0, 0));
    expect(flat.heightfields).toEqual([expect.objectContaining({ x: 0, z: 0, cellsX: 32, cellsZ: 32 })]);
    expect(flat.meshes).toHaveLength(0);
    // A wall on the ground: its boxes, and the ground round its foot still a field.
    for (let y = 4; y < 8; y++) putVoxel(s, 40, y, 10, MAT.stone, C.wall);
    const walled = collisionGeometry(joinedChunk(s, 1, 0, 0));
    expect(walled.boxes.length).toBeGreaterThan(0);
    expect(walled.heightfields.length).toBeGreaterThan(0);
    // Ground climbing out of the chunk's top: nodes there have no ground in it.
    for (let x = 70; x < 90; x++) for (let z = 0; z < 32; z++) for (let y = 4; y < 40; y++) putVoxel(s, x, y, z, MAT.soil, C.terrain);
    // Where the block's corner meets the chunk's face, its foot (on the lattice: a straight step's edge) and the
    // other face's riser give one node two heights, found before the uncovered nodes.
    expect(groundHeightfield(joinedChunk(s, 2, 0, 0).ground, 32)).toBe('layers');
    // Across the chunk's whole width (no corner in it) only the uncovered nodes refuse it whole; the flat ground on
    // both sides of the block is patches, none over the block (x 70–90, chunk cells 6–26).
    const wide = createWorldStore(grid);
    flatGround(wide, 32, 104, -40, 72, 40, 4);
    for (let x = 70; x < 90; x++) for (let z = -8; z < 40; z++) for (let y = 4; y < 40; y++) putVoxel(wide, x, y, z, MAT.soil, C.terrain);
    const climbing = joinedChunk(wide, 2, 0, 0);
    expect(groundHeightfield(climbing.ground, 32)).toBe('uncovered');
    const sides = collisionGeometry(climbing).heightfields;
    // The cells beside the block's foot hold its riser on their edge, so they stay triangles too.
    expect(sides.map((p) => [p.x / 0.5, p.x / 0.5 + p.cellsX, p.cellsZ])).toEqual([[0, 5, 32], [27, 32, 32]]);
  });

  it('on the hard cases, drops, rays and sweeps land within 1 cm of the meshes; patches never stand over overhangs, caves or arches', async () => {
    const s = featuresStore();
    const origin = (): FloatingOrigin => new FloatingOrigin({ grid, origin: { x: 0, y: 0, z: 0 } });
    const field = await VoxelCollision.create(grid, origin());
    const mesh = await VoxelCollision.create(grid, origin(), false);
    let groundChunks = 0;
    let withPatches = 0;
    let groundTris = 0;
    let fieldTris = 0;
    const patchCells = new Set<string>();
    for (let cx = 0; cx < FEATURE_WIDTH / 32; cx++) for (let cy = -1; cy <= 1; cy++) for (let cz = 0; cz < FEATURE_PAD / 32; cz++) {
      const d = joinedChunk(s, cx, cy, cz);
      if (d.ground.indices.length === 0 && d.collision.boxes.length === 0) continue;
      const key = (cx * 4 + cy + 1) * 4 + cz;
      field.set(key, cx, cy, cz, d);
      mesh.set(key, cx, cy, cz, d);
      const geo = collisionGeometry(d);
      const tris = d.ground.indices.length / 3;
      // The row's underside (its ground's bottom, at the base in the chunks below y 0) is never a field: not counted.
      if (tris === 0 || cy < 0) continue;
      groundChunks++;
      groundTris += tris;
      if (geo.heightfields.length === 0) continue;
      withPatches++;
      fieldTris += tris - geo.meshes.reduce((n, m) => n + m.indices.length / 3, 0);
      for (const p of geo.heightfields) for (let i = 0; i < p.cellsX; i++) for (let k = 0; k < p.cellsZ; k++) patchCells.add(`${cx * 32 + p.x / 0.5 + i},${cz * 32 + p.z / 0.5 + k}`);
    }
    // Most ground chunks carry patches; the ground they stand for is most of the row's triangles.
    expect(withPatches).toBeGreaterThan(groundChunks * 0.4);
    expect(fieldTris).toBeGreaterThan(groundTris * 0.4);
    // No patch over a column the analytic solid holds air under solid in (overhang, arch, cave): those stay meshes.
    for (const c of featureCases()) for (let x = c.x0 + 2; x < c.x0 + FEATURE_PAD - 2; x++) for (let z = 2; z < FEATURE_PAD - 2; z++) {
      // Air at least a cell deep under solid and over solid again: an underside over a floor.
      let solid = false;
      let air = 0;
      let gap = false;
      for (let y = FEATURE_TOP; y > FEATURE_BASE && !gap; y -= 0.25) {
        const inside = c.sdf(x + 0.5, y, z + 0.5) > 0;
        if (inside && solid && air >= 1) gap = true;
        if (inside) {
          solid = true;
          air = 0;
        } else if (solid) air += 0.25;
      }
      if (gap) expect(patchCells.has(`${x},${z}`), `${c.name} ${x},${z}`).toBe(false);
    }
    let worst = 0;
    let rays = 0;
    let drops = 0;
    let alongFaces = 0;
    for (let x = 1.3; x < FEATURE_WIDTH - 1; x += 3.7) for (let z = 1.1; z < FEATURE_PAD - 1; z += 4.3) {
      const a = field.castSphere([x, FEATURE_TOP + 4, z], [0, -1, 0], 0.01, 200);
      const b = mesh.castSphere([x, FEATURE_TOP + 4, z], [0, -1, 0], 0.01, 200);
      expect(a === null, `${x},${z}`).toBe(b === null);
      if (a === null || b === null) continue;
      rays++;
      worst = Math.max(worst, Math.abs(a.distanceM - b.distanceM));
      // A capsule is dropped only where nothing stands within its radius above the ground under it: a capsule that
      // starts against a cliff face is pushed out by more than the port's move allows (both shapes alike).
      const clear = [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]].every(([ox, oz]) => {
        const h = mesh.castSphere([x + ox!, FEATURE_TOP + 4, z + oz!], [0, -1, 0], 0.01, 200);
        return h !== null && Math.abs(h.distanceM - b.distanceM) < 0.25;
      });
      if (!clear) {
        // Beside a face: a capsule that starts clear of it (16 level rays at three heights of it reach no face within
        // its radius) falls along the face without the step throwing; one that starts in it throws (the port's move bound).
        const start: [number, number, number] = [x, a.centre[1] + 3, z];
        let gap = Infinity;
        for (let k = 0; k < 16; k++) for (const up of [0.4, 1, 1.6]) {
          const h = mesh.castSphere([x, start[1] + up, z], [Math.cos((k * Math.PI) / 8), 0, Math.sin((k * Math.PI) / 8)], 0.01, 4);
          if (h !== null) gap = Math.min(gap, h.distanceM);
        }
        if (gap === Infinity || gap < 0.2) continue;
        alongFaces++;
        for (const w of [field, mesh]) expect(w.dropCapsule(start, 0.2, 0.3).grounded, `${x},${z}`).toBe(true);
        continue;
      }
      if (rays % 5 !== 0) continue;
      drops++;
      const fa = field.dropCapsule([x, a.centre[1] + 3, z], 0.2, 0.3);
      const fb = mesh.dropCapsule([x, a.centre[1] + 3, z], 0.2, 0.3);
      expect(fa.grounded, `${x},${z}`).toBe(fb.grounded);
      worst = Math.max(worst, Math.abs(fa.feet[1] - fb.feet[1]) * 0.5);
    }
    expect(rays).toBeGreaterThan(2000);
    expect(drops).toBeGreaterThan(300);
    expect(alongFaces).toBeGreaterThan(30);
    expect(worst).toBeLessThan(0.01);
    const sweeps = sweepsAgree(field, mesh, [2, FEATURE_WIDTH - 2, 2, FEATURE_PAD - 2], FEATURE_TOP - 30, 3000);
    expect(sweeps.casts).toBeGreaterThan(1500);
    expect(sweeps.worst).toBeLessThan(0.01);
  }, 120_000);
});

/**
 * Slanted sphere sweeps (radius 0.05–0.5 m, down at 6–84°) from `height` cells over [x0, x1) × [z0, z1): how far the
 * field's land from the mesh's at worst. A sweep the mesh stops by a graze (a ball 5 mm thinner passes there and
 * lands where the field's does) is left out, at most 5 % of them.
 */
function sweepsAgree(field: VoxelCollision, mesh: VoxelCollision, [x0, x1, z0, z1]: readonly number[], height: number, count: number): { casts: number; worst: number } {
  let seed = 11;
  const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let casts = 0;
  let grazes = 0;
  let worst = 0;
  for (let t = 0; t < count; t++) {
    const r = [0.05, 0.15, 0.3, 0.5][t % 4]!;
    const from: [number, number, number] = [x0! + rnd() * (x1! - x0!), height, z0! + rnd() * (z1! - z0!)];
    const dir: [number, number, number] = [rnd() * 2 - 1, -(0.1 + rnd()), rnd() * 2 - 1];
    const want = mesh.castSphere(from, dir, r, 80);
    if (want === null) continue;
    casts++;
    const got = field.castSphere(from, dir, r, 80);
    const off = got === null ? Infinity : Math.abs(got.distanceM - want.distanceM);
    if (off <= 0.01) {
      worst = Math.max(worst, off);
      continue;
    }
    const thinner = mesh.castSphere(from, dir, r - 0.005, 80);
    expect(got, `${from} ${dir} r ${r}`).not.toBeNull();
    expect(Math.abs(thinner!.distanceM - got!.distanceM), `${from} ${dir} r ${r}`).toBeLessThan(0.01);
    grazes++;
  }
  expect(grazes).toBeLessThanOrEqual(casts * 0.05);
  return { casts, worst };
}

describe('the collision ring', () => {
  it('gives bodies only to chunks near a moving focus: nearest first in, farthest first out past the hysteresis, counted as a part; the heap stops growing', async () => {
    // A hilly strip 480 m along x and 48 m across, every chunk of it resident.
    const s = createWorldStore(grid);
    loadArea(hillyWorld({ footprint: 1024 }).grids[0]!, s, -480, -48, 480, 48);
    const groundY = (x: number, z: number): number => {
      const v = { material: 0, role: 0, shape: 0, wetness: 0 };
      for (let y = 300; y > -140; y--) if (s.voxelAt(x, y, z, v).material !== 0) return y + 1;
      throw new Error(`no ground at ${x}, ${z}`);
    };
    const joins = new Map<number, CollisionSource>();
    const parts = new Map<number, number>();
    const physics = await VoxelCollision.create(grid, new FloatingOrigin({ grid, origin: { x: 0, y: 0, z: 0 } }));
    let removing: number[] | null = null;
    const bodies: CollisionBodies = {
      set: (k, cx, cy, cz, src) => physics.set(k, cx, cy, cz, src),
      remove: (k) => {
        removing?.push(k);
        physics.remove(k);
      },
    };
    const inStrip = (cx: number, cz: number): boolean => cx >= -15 && cx < 15 && cz >= -2 && cz < 2;
    const feed = {
      isResident: (cx: number, _cy: number, cz: number): boolean => inStrip(cx, cz),
      joinedChunk: (cx: number, cy: number, cz: number): CollisionSource => {
        const k = chunkKey(grid, cx, cy, cz);
        let j = joins.get(k);
        if (j === undefined) joins.set(k, (j = joinedChunk(s, cx, cy, cz)));
        return j;
      },
      setPart: (cx: number, cy: number, cz: number, part: string, bytes: number): boolean => {
        expect(part).toBe(COLLISION_PART);
        const k = chunkKey(grid, cx, cy, cz);
        if (bytes > 0) parts.set(k, bytes);
        else parts.delete(k);
        return true;
      },
    };
    const ring = new CollisionRing({
      grid,
      bodies,
      feed,
      // 32 m around and 12 m up and down, 8 m kept: small, so the strip holds many rings.
      bounds: collisionRingBounds({ radius: 64, height: 24 }, 16),
    });
    expect(ring.bounds).toEqual({ radius: 64, height: 24, keepRadius: 80, keepHeight: 40 });
    const E = grid.edge;
    const gap = (p: number, lo: number): number => (p < lo ? lo - p : p > lo + E ? p - lo - E : 0);
    const within = (f: { x: number; y: number; z: number }, cx: number, cy: number, cz: number, r: number, h: number): boolean => Math.hypot(gap(f.x, cx * E), gap(f.z, cz * E)) < r && gap(f.y, cy * E) < h;
    const hasGeometry = (cx: number, cy: number, cz: number): boolean => {
      const j = feed.joinedChunk(cx, cy, cz);
      return j.ground.indices.length > 0 || j.collision.boxes.length > 0;
    };
    let focus = { x: 0, y: 0, z: 0 };
    const goTo = (x: number): { added: number; removed: number; removedOrder: number[] } => {
      focus = { x, y: groundY(x, 0) + 4, z: 0 };
      ring.setFoci([focus]);
      removing = [];
      let added = 0;
      let removed = 0;
      for (;;) {
        const u = ring.update();
        added += u.added;
        removed += u.removed;
        if (u.waiting === 0) break;
      }
      const order = removing;
      removing = null;
      return { added, removed, removedOrder: order };
    };
    const check = (): void => {
      // Every body within the keep bounds; every chunk within the add bounds with something to collide has one.
      const c = { cx: 0, cy: 0, cz: 0 };
      let n = 0;
      for (const k of parts.keys()) {
        chunkOfKey(grid, k, c);
        expect(within(focus, c.cx, c.cy, c.cz, 80, 40), `(${c.cx}, ${c.cy}, ${c.cz}) from ${focus.x}`).toBe(true);
        expect(ring.has(c.cx, c.cy, c.cz)).toBe(true);
        n++;
      }
      for (let cx = Math.floor((focus.x - 64) / E); cx <= Math.floor((focus.x + 64) / E); cx++) for (let cz = -2; cz < 2; cz++) for (let cy = Math.floor((focus.y - 24) / E); cy <= Math.floor((focus.y + 24) / E); cy++) {
        if (!within(focus, cx, cy, cz, 64, 24) || !inStrip(cx, cz)) continue;
        expect(parts.has(chunkKey(grid, cx, cy, cz)), `(${cx}, ${cy}, ${cz}) from ${focus.x}`).toBe(hasGeometry(cx, cy, cz));
      }
      // Counted once each: the parts, the ring's bytes and the physics side agree, and every body is one of the port's.
      expect(n).toBe(ring.count);
      expect(physics.count).toBe(ring.count);
      expect([...parts.values()].reduce((a, b) => a + b, 0)).toBe(ring.bytes);
      expect(ring.bytes).toBe(physics.bytes);
    };

    const first = goTo(0);
    expect(first.added).toBeGreaterThan(8);
    expect(first.removed).toBe(0);
    check();
    // Across a chunk edge and back, 4 m each way: once both sides' chunks are in, the hysteresis keeps them.
    const edge = 2 * E;
    goTo(edge - 8);
    goTo(edge + 8);
    goTo(edge - 8);
    const settled = { adds: ring.adds, removes: ring.removes };
    for (let i = 0; i < 5; i++) {
      expect(goTo(edge + 8)).toMatchObject({ added: 0, removed: 0 });
      expect(goTo(edge - 8)).toMatchObject({ added: 0, removed: 0 });
    }
    expect({ adds: ring.adds, removes: ring.removes }).toEqual(settled);
    check();

    // A flight along the strip and back, a chunk's half at a time: bodies follow the focus, removals farthest first.
    const heaps: number[] = [];
    let most = 0;
    for (let trip = 0; trip < 3; trip++) {
      for (const x of [...Array.from({ length: 27 }, (_, i) => i * 16), ...Array.from({ length: 27 }, (_, i) => 416 - i * 16), ...Array.from({ length: 27 }, (_, i) => -i * 16), ...Array.from({ length: 27 }, (_, i) => -416 + i * 16)]) {
        const u = goTo(x);
        const d = u.removedOrder.map((k) => {
          chunkOfKey(grid, k, c0);
          return Math.hypot(gap(focus.x, c0.cx * E), gap(focus.z, c0.cz * E));
        });
        for (let i = 1; i < d.length; i++) expect(d[i]!).toBeLessThanOrEqual(d[i - 1]!);
        most = Math.max(most, ring.count);
        check();
      }
      heaps.push(physicsMemoryBytes3D()!);
    }
    // The ring holds what is near the focus, never the strip: the count stays near the first ring's.
    expect(most).toBeLessThanOrEqual(2 * first.added);
    expect(ring.adds).toBeGreaterThan(10 * first.added);
    // The later trips' ~600 bodies (tens of MB added and removed) fit in what the first trip's removed bodies freed:
    // the heap grows by a few 64 KiB pages at most (fragmentation), not by what was added.
    expect(heaps[2]! - heaps[0]!).toBeLessThanOrEqual(4 * 65_536);

    // A capsule dropped by the focus lands; one dropped 100 m behind it, where no body is, falls through.
    const here = physics.dropCapsule([focus.x + 2, focus.y, 2], 0.2, 0.3);
    expect(here.grounded).toBe(true);
    const behind = physics.dropCapsule([focus.x + 200, groundY(focus.x + 200, 2) + 2, 2], 0.2, 0.3, 120);
    expect(behind.grounded).toBe(false);

    // The time slice: none left, one body an update all the same.
    const slow = new CollisionRing({ grid, bodies, feed, bounds: ring.bounds, addMsPerUpdate: 0 });
    slow.setFoci([{ x: 200, y: groundY(200, 0) + 4, z: 0 }]);
    const u = slow.update();
    expect(u.added).toBe(1);
    expect(u.waiting).toBeGreaterThan(0);
  }, 120_000);
});
const c0 = { cx: 0, cy: 0, cz: 0 };
