/**
 * Terrain tiles as colliders on the Rapier 3D port (real WASM), built by the
 * runtime's `terrainColliderPieces`:
 *
 * - a tile is one heightfield whose surface is `TerrainField.heightAt`
 *   exactly (rays straight down hit the field's height everywhere, cell
 *   diagonals included: both split the cell the same way);
 * - a tile with holes is cut into patches (heightfields where whole, meshes
 *   of the whole cells where cut, nothing where all hole): rays fall through
 *   the hole and hit the field's height around it;
 * - a character walks across a sloping tile at the field's height plus its
 *   capsule and falls through a hole;
 * - with `TL_PERF=1`, the build time of a 257² and a 1,025² tile (shapes made
 *   and added to the port) and a step with them.
 */
import { describe, expect, it } from 'vitest';

import { createPhysicsPort3D } from '../../../packages/physics-rapier/src/3d/index';
import { TerrainField, terrainColliderPieces, terrainTileKey, type PhysicsPort3D, type StaticColliderSpec3D, type TerrainComponent, type TerrainTile } from '../../../packages/runtime/src/index';

const HZ = 120;
const G = -19.62;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const RANGE: [number, number] = [-20, 40];
const ORIGIN = [10, -3, -7];

/** A tile of `samples` a side whose heights come from `f(x, z)` (metres above the object, sample coordinates). */
function tileOf(samples: number, f: (x: number, z: number) => number): TerrainTile {
  const heights = new Uint16Array(samples * samples);
  for (let z = 0; z < samples; z++) for (let x = 0; x < samples; x++) heights[z * samples + x] = Math.round(((f(x, z) - RANGE[0]) / (RANGE[1] - RANGE[0])) * 65535);
  return { samples, heights, weights: null, holes: null, paint: null };
}

/** Cut the cells within `r` cells of (cx, cz). */
function cut(t: TerrainTile, cx: number, cz: number, r: number): void {
  const n = t.samples - 1;
  t.holes = new Uint8Array(Math.ceil((n * n) / 8));
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) < r) t.holes[(z * n + x) >> 3]! |= 1 << ((z * n + x) & 7);
}

function component(samples: number, spacing: number): TerrainComponent {
  return { tileSamples: samples, spacing, heightRange: RANGE, tiles: [{ x: 0, z: 0, data: 'a'.repeat(64) }] };
}

function specsOf(t: TerrainTile, spacing: number): StaticColliderSpec3D[] {
  return terrainColliderPieces(t, spacing, RANGE).map((p, i) => ({ entityId: `t#terrain:0,0:${i}`, shape: p.shape, position: { x: ORIGIN[0]! + p.x, y: ORIGIN[1]!, z: ORIGIN[2]! + p.z }, rotation: IDENTITY }));
}

async function portWith(statics: StaticColliderSpec3D[], at: { x: number; y: number; z: number }): Promise<PhysicsPort3D> {
  const made = await createPhysicsPort3D({
    dimension: 3,
    character: { position: at, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 } },
    statics,
    solver: { hz: HZ, gravityY: G },
    controller: { offsetSkin: 0.01, groundSnap: 0.2, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  return made.port;
}

/** A ray straight down from 100 m above (x, z): the height it hits, or null. */
function down(port: PhysicsPort3D, x: number, z: number): number | null {
  const hit = port.raycast!({ x, y: 100, z }, { x: 0, y: -1, z: 0 }, 500);
  return hit === null ? null : 100 - hit.distance;
}

/** Bumpy enough that a cell's two diagonals give different surfaces. */
const bumps = (x: number, z: number): number => 3 * Math.sin(x * 1.3) * Math.cos(z * 0.9) + 0.7 * Math.sin(x * 3.1 + z * 2.3) + z * 0.2;

describe('terrain tiles as Rapier colliders', () => {
  it('a whole tile is one heightfield on exactly TerrainField.heightAt (cell diagonals included)', async () => {
    const t = tileOf(17, bumps);
    const spacing = 1.5;
    const specs = specsOf(t, spacing);
    expect(specs.length).toBe(1);
    expect((specs[0]!.shape as { type: string }).type).toBe('heightfield');
    const field = new TerrainField(component(17, spacing), ORIGIN, new Map([[terrainTileKey(0, 0), t]]));
    const port = await portWith(specs, { x: ORIGIN[0]! - 50, y: 50, z: 0 });
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      // Points all over the tile, inside cells off their diagonals.
      const x = ORIGIN[0]! + ((i * 0.613) % 16) * spacing + 0.01;
      const z = ORIGIN[2]! + ((i * 0.377) % 16) * spacing + 0.01;
      const want = field.heightAt(x, z)!;
      const got = down(port, x, z);
      expect(got, `(${x}, ${z})`).not.toBeNull();
      worst = Math.max(worst, Math.abs(got! - want));
    }
    expect(worst).toBeLessThan(2e-3);
    port.dispose();
  });

  it('a tile with holes: patches (heightfields and meshes), rays fall through the hole and hit the field around it', async () => {
    const t = tileOf(33, bumps);
    cut(t, 12, 24, 3);
    const spacing = 1;
    const specs = specsOf(t, spacing);
    const kinds = specs.map((s) => (s.shape as { type: string }).type);
    // 32 cells → 2 × 2 patches of 16; the hole lies in one: the other three are two rectangles of whole patches.
    expect(kinds).toEqual(['heightfield', 'heightfield', 'mesh']);
    const field = new TerrainField(component(33, spacing), ORIGIN, new Map([[terrainTileKey(0, 0), t]]));
    const port = await portWith(specs, { x: ORIGIN[0]! - 50, y: 50, z: 0 });
    expect(down(port, ORIGIN[0]! + 12, ORIGIN[2]! + 24)).toBeNull();
    expect(field.holeAt(ORIGIN[0]! + 12, ORIGIN[2]! + 24)).toBe(true);
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const x = ORIGIN[0]! + ((i * 0.613) % 32) + 0.01;
      const z = ORIGIN[2]! + ((i * 0.377) % 32) + 0.01;
      const want = field.heightAt(x, z);
      const got = down(port, x, z);
      if (want === null) expect(got, `hole at (${x}, ${z})`).toBeNull();
      else worst = Math.max(worst, Math.abs(got! - want));
    }
    expect(worst).toBeLessThan(2e-3);
    port.dispose();
  });

  it('a character walks over a sloping tile at the field\'s height and falls through its hole', async () => {
    const gentle = (x: number, z: number): number => 0.15 * x + 0.3 * Math.sin(z * 0.5);
    const t = tileOf(65, gentle);
    cut(t, 40, 32, 4);
    const spacing = 0.5;
    const field = new TerrainField(component(65, spacing), ORIGIN, new Map([[terrainTileKey(0, 0), t]]));
    const sx = ORIGIN[0]! + 10;
    const sz = ORIGIN[2]! + 16;
    // The capsule's origin is its centre: 0.9 m over its feet (a little more on a slope: its round bottom and the skin).
    const port = await portWith(specsOf(t, spacing), { x: sx, y: field.heightAt(sx, sz)! + 1.0, z: sz });
    let v = 0;
    let grounded = false;
    const settle = (n: number, dx: number): { x: number; y: number; z: number } => {
      let p = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < n; i++) {
        v = grounded ? 0 : Math.max(-30, v + G / HZ);
        port.stageCharacterMove({ x: dx / HZ, y: v / HZ, z: 0 });
        const r = port.step();
        grounded = r.grounded;
        p = r.position;
      }
      return p;
    };
    const rest = settle(HZ / 2, 0);
    expect(grounded).toBe(true);
    expect(Math.abs(rest.y - (field.heightAt(rest.x, rest.z)! + 0.9))).toBeLessThan(0.05);
    // Walk +x at 2 m/s: on the ground along the slope until the hole (its cells from x 18 m to 22 m in the tile).
    let fell = false;
    for (let k = 0; k < 6 * HZ && !fell; k += 10) {
      const p = settle(10, 2);
      const ground = field.heightAt(p.x, p.z);
      if (ground !== null && p.x < ORIGIN[0]! + 17) expect(Math.abs(p.y - (ground + 0.9)), `at x ${p.x.toFixed(2)}`).toBeLessThan(0.08);
      if (p.y < field.heightAt(ORIGIN[0]! + 17, sz)! - 3) fell = true;
    }
    expect(fell, 'fell through the hole').toBe(true);
    port.dispose();
  });

  it.runIf(process.env['TL_PERF'] === '1')('build time: a 257² and a 1,025² tile, whole and holed', async () => {
    for (const samples of [257, 1025]) {
      for (const holed of [false, true]) {
        const t = tileOf(samples, (x, z) => bumps(x / 8, z / 8));
        if (holed) cut(t, samples / 3, samples / 2, samples / 10);
        const port = await portWith([], { x: -1000, y: 50, z: -1000 });
        const t0 = performance.now();
        const specs = specsOf(t, 1);
        const t1 = performance.now();
        port.addStaticColliders!(specs);
        const t2 = performance.now();
        port.stageCharacterMove({ x: 0, y: -0.01, z: 0 });
        port.step();
        const t3 = performance.now();
        port.stageCharacterMove({ x: 0, y: -0.01, z: 0 });
        port.step();
        const t4 = performance.now();
        console.log(`terrain collision ${samples}² ${holed ? 'holed' : 'whole'}: ${specs.length} colliders, shapes ${(t1 - t0).toFixed(1)} ms, port add ${(t2 - t1).toFixed(1)} ms, first step ${(t3 - t2).toFixed(2)} ms, next step ${(t4 - t3).toFixed(2)} ms`);
        port.dispose();
      }
    }
  });
});
