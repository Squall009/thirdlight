/**
 * The assembly's per-cell outputs and the slice's collision against the
 * real derive and the engine's real physics backend (Rapier through
 * physics-rapier's port): the wall, beam and banister scene's cells read
 * back per consumer, the ground surface cut into meshes a port takes, and
 * bodies dropped and swept against every derived chunk's static body —
 * onto the ground, the wall top, the beam and the rail, between the
 * banister's posts, and into a hole dug after the bodies were built.
 */
import {
  ASSEMBLY_CLASS,
  cellOutputs,
  chunkGrid,
  collisionGeometry,
  createWorldStore,
  deriveFromStore,
  FloatingOrigin,
  LIGHT_COVERAGE,
  PIECE_FAMILY,
  PIECE_SECTION,
  PLACEHOLDER_RULES,
  resolvedClassAt,
  RUN_X,
  RUN_Z,
  VOXEL_CATEGORY,
  type DerivedData,
  type PaletteStore,
} from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';
import { VoxelCollision } from '../../packages/editor/src/voxel-world/collision';
import { placeWallBeamBanister, putVoxel } from './scenes';
import { MAT } from './world-kit';

const grid = chunkGrid(32);
const C = VOXEL_CATEGORY;
const SCENE_CHUNKS = [-1, 0].flatMap((x) => [-1, 0].flatMap((y) => [-1, 0].map((z) => [x, y, z] as const)));

function scene(): PaletteStore {
  const s = createWorldStore(grid);
  placeWallBeamBanister(s);
  return s;
}

function outputsAt(s: PaletteStore, x: number, y: number, z: number): ReturnType<typeof cellOutputs> {
  const d = deriveFromStore(s, x >> 5, y >> 5, z >> 5, PLACEHOLDER_RULES);
  return cellOutputs(d, x & 31, y & 31, z & 31);
}

/** The banister grown upward: the gaps between its posts and a row over its rail filled, as a runtime build would. */
function growBanister(s: PaletteStore): void {
  for (let x = -4; x < 4; x++) {
    if ((x & 1) !== 0) putVoxel(s, x, 1, 7, MAT.timber, C.construction);
    putVoxel(s, x, 3, 7, MAT.timber, C.construction);
  }
}

describe('per-cell outputs of one assembly evaluation', () => {
  it('give a wall, a beam, a rail and a post different render, collision, nav and light results, and follow the neighbours', () => {
    const s = scene();
    expect(resolvedClassAt(s, PLACEHOLDER_RULES, -4, 4, 0)).toBe(ASSEMBLY_CLASS.wall);
    expect(resolvedClassAt(s, PLACEHOLDER_RULES, -4, 5, -1)).toBe(ASSEMBLY_CLASS.beam | RUN_X);
    expect(resolvedClassAt(s, PLACEHOLDER_RULES, -3, 2, 7)).toBe(ASSEMBLY_CLASS.rail | RUN_X);
    expect(resolvedClassAt(s, PLACEHOLDER_RULES, -4, 1, 7)).toBe(ASSEMBLY_CLASS.rail | RUN_X | RUN_Z);

    const wall = outputsAt(s, -4, 5, 0);
    expect(wall).toMatchObject({ renderSolid: true, piece: null, collision: 'full', navBlocks: true, light: 255 });
    // The wall's back face (towards the beam's side) is drawn only where no beam stands in front of it; its top row has an open top.
    expect(outputsAt(s, -4, 7, 0).baseFaces).toBeGreaterThanOrEqual(2);
    const beam = outputsAt(s, -4, 5, -1);
    expect(beam).toMatchObject({ renderSolid: false, baseFaces: 0, collision: 'partial', navBlocks: true, light: LIGHT_COVERAGE.beam });
    expect(beam.piece).toMatchObject({ family: PIECE_FAMILY.beam, section: PIECE_SECTION.body, replacesBase: true });
    const rail = outputsAt(s, -3, 2, 7);
    expect(rail).toMatchObject({ renderSolid: false, baseFaces: 0, collision: 'partial', navBlocks: true, light: LIGHT_COVERAGE.rail, standable: false });
    expect(rail.piece?.family).toBe(PIECE_FAMILY.rail);
    // A rail is a thin slab along its run: full length in x, 4/16 of a cell across z.
    expect(rail.partialBox).toEqual([0, 0, 6, 16, 16, 10]);
    const post = outputsAt(s, -4, 1, 7);
    expect(post.piece?.family).toBe(PIECE_FAMILY.post);
    expect(post.partialBox).toEqual([6, 0, 6, 10, 16, 10]);
    // The gap between two posts is open for everything.
    expect(outputsAt(s, -3, 1, 7)).toMatchObject({ renderSolid: false, collision: 'none', navBlocks: false, light: 0, piece: null });
    // Standing: on the wall's top yes, on the rail's top no (nav reads the rail as not a support).
    expect(outputsAt(s, -4, 8, 0).standable).toBe(true);
    expect(outputsAt(s, -3, 3, 7).standable).toBe(false);

    growBanister(s);
    expect(resolvedClassAt(s, PLACEHOLDER_RULES, -3, 2, 7)).toBe(ASSEMBLY_CLASS.wall);
    expect(outputsAt(s, -3, 2, 7)).toMatchObject({ renderSolid: true, piece: null, collision: 'full', light: 255 });
    // No longer replaced by a piece: the run's front and back faces are base surface again.
    expect(outputsAt(s, -3, 2, 7).baseFaces).toBe(2);
    expect(outputsAt(s, -3, 4, 7).standable).toBe(true);
  });

  it('cut the ground surface into meshes within a port\'s limits without losing a triangle', () => {
    const s = scene();
    const d = deriveFromStore(s, -1, -1, -1, PLACEHOLDER_RULES);
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
    const physics = await VoxelCollision.create(grid, new FloatingOrigin({ origin: { x: 0, y: 0, z: 0 } }));
    const rebuild = (): void => {
      for (const [cx, cy, cz] of SCENE_CHUNKS) {
        const d: DerivedData = deriveFromStore(s, cx, cy, cz, PLACEHOLDER_RULES);
        physics.set(cx * 1000 + cy * 100 + cz, cx, cy, cz, d);
      }
    };
    rebuild();
    return { physics, rebuild };
  }

  it('rests capsules on the ground, the wall top, the beam and the rail; a sphere passes between the posts and stops at the wall', async () => {
    const s = scene();
    const { physics, rebuild } = await world(s);
    expect(physics.count).toBe(8);
    // Feet in cells: the ground's surface is at y 0, the wall's top at 8, the beam's top at 5 + 13/16, the rail's at 3.
    const ground = physics.dropCapsule([10.5, 4, 10.5], 0.2, 0.2);
    expect(ground.grounded).toBe(true);
    expect(ground.feet[1]).toBeCloseTo(0, 0);
    expect(physics.dropCapsule([-4.5, 12, 0.5], 0.2, 0.2).feet[1]).toBeCloseTo(8, 1);
    expect(physics.dropCapsule([-4.5, 10, -0.5], 0.1, 0.1).feet[1]).toBeCloseTo(5 + 13 / 16, 1);
    const onRail = physics.dropCapsule([-2.5, 6, 7.5], 0.1, 0.1);
    expect(onRail.grounded).toBe(true);
    expect(onRail.feet[1]).toBeCloseTo(3, 1);

    // A ball rolled toward the wall at post height: between two posts and under the rail it reaches the wall (z 1 + radius);
    // in line with a post it stops at the post's bar (z 7 + 10/16 + radius).
    const r = 0.3;
    const gap = physics.castSphere([-2.5, 1.5, 12], [0, 0, -1], 0.15, 20);
    expect(gap?.centre[2]).toBeCloseTo(1 + r, 1);
    const atPost = physics.castSphere([-3.5, 1.5, 12], [0, 0, -1], 0.15, 20);
    expect(atPost?.centre[2]).toBeCloseTo(7 + 10 / 16 + r, 1);

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
});
