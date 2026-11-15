/**
 * Voxel chunks in the surface cache, at the cache's own boundaries: a
 * chunk's mesh (a sloping ground and an upright wall) as a tile made
 * resident, the materials' lookup packed from it finding every drawn point's
 * texel where the cache addresses it, a traced voxel hit's address resolved
 * to the same texel, the host listing a page's voxel chunks (their charts
 * made, their units' texel points on the surface, a chunk drawn again a new
 * version, the source's budget where the tier gives none).
 */
import { mulberry32 } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';
import { VOXEL_SIZE_M } from '@thirdlight/voxel';

import { SurfaceCache } from './surface-cache';
import { SurfaceCacheHost, type SurfaceVoxelChunk } from './surface-cache-host';
import { SURFACE_READ, lookupSurfaceCpu, packSurfaceLookup } from './surface-cache-lookup';
import { SurfaceScene } from './surface-cache-scene';
import { locateVoxelFace, voxelCellOf, voxelChunkTile, voxelHitWords, type VoxelTileMesh } from './surface-cache-voxels';
import { TRACE_VOXELS } from './tracer-scene';
import { lightFrameOf } from './surface-light-frame';
import { TEXEL_POINT_FLOATS } from './surface-texels';
import type { CacheLight } from './surface-changes';

const EDGE = 32;
const CELL0: [number, number, number] = [64, 0, -32];

/** A chunk's surface (metres from its corner): ground 2 m up, rolling by a metre, and a wall facing +x at 8 m from 3 to 6 m up. */
function mesh(): VoxelTileMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = 32;
  const h = (x: number, z: number): number => 2 + 0.5 * Math.sin(x * 0.4) + 0.4 * Math.cos(z * 0.3);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i * 0.5, h(i * 0.5, j * 0.5), j * 0.5);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i;
    idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
  }
  const w = pos.length / 3;
  pos.push(8, 3, 2, 8, 6, 2, 8, 3, 10, 8, 6, 10);
  idx.push(w, w + 1, w + 2, w + 2, w + 1, w + 3);
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/** Random points on the mesh's triangles (world metres) with their triangles' normals. */
function points(m: VoxelTileMesh, n: number): { p: number[]; normal: number[] }[] {
  const r = mulberry32(5);
  const out: { p: number[]; normal: number[] }[] = [];
  const tris = m.indices.length / 3;
  for (let k = 0; k < n; k++) {
    const t = Math.floor(r() * tris);
    const v = [0, 1, 2].map((i) => [0, 1, 2].map((a) => CELL0[a]! * VOXEL_SIZE_M + m.positions[m.indices[t * 3 + i]! * 3 + a]!));
    const e1 = [0, 1, 2].map((a) => v[1]![a]! - v[0]![a]!);
    const e2 = [0, 1, 2].map((a) => v[2]![a]! - v[0]![a]!);
    const c = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const l = Math.hypot(c[0]!, c[1]!, c[2]!);
    let a = r();
    let b = r();
    if (a + b > 1) {
      a = 1 - a;
      b = 1 - b;
    }
    out.push({ p: [0, 1, 2].map((i) => v[0]![i]! + e1[i]! * a + e2[i]! * b), normal: c.map((x) => x / l) });
  }
  return out;
}

const faceOf = (n: readonly number[]): number => {
  const an = n.map(Math.abs);
  const axis = an[0]! >= an[1]! && an[0]! >= an[2]! ? 0 : an[1]! >= an[2]! ? 1 : 2;
  return axis * 2 + (n[axis]! < 0 ? 1 : 0);
};

describe('voxel tiles in the surface cache', () => {
  const m = mesh();
  const tile = voxelChunkTile('w/64,0,-32', 1, CELL0, EDGE, () => m);
  const cache = new SurfaceCache(32 * 1024 * 1024);
  // The eye beside the chunk: its tile at the finest level.
  cache.update([CELL0[0] * VOXEL_SIZE_M + 8, 3, CELL0[2] * VOXEL_SIZE_M + 8], [tile], [], true);
  const scene = new SurfaceScene({ voxels: [tile] });
  const words = packSurfaceLookup(scene, cache);

  it('finds every drawn point\'s texel in the lookup where the cache addresses it', () => {
    expect(cache.levelOf(tile.key)).toBe(0);
    let n = 0;
    let found = 0;
    let same = 0;
    for (const s of points(m, 3000)) {
      n++;
      const face = faceOf(s.normal);
      const at = voxelCellOf(s.p, face);
      const want = locateVoxelFace(tile.made!, at.cell, face, at.fu, at.fv);
      const got = lookupSurfaceCpu(words, SURFACE_READ.voxels, s.p, s.normal);
      if (want === null) {
        expect(got).toBeNull();
        continue;
      }
      found++;
      const texel = cache.texelOf(tile.key, want.chart, want) as { page: number; x: number; y: number };
      if (got !== null && got.texture === 'atlas' && got.layer === texel.page && Math.floor(got.x) === texel.x && Math.floor(got.y) === texel.y) same++;
    }
    expect(found / n).toBeGreaterThan(0.995);
    expect(same).toBe(found);
  });

  it('resolves a traced voxel hit to the texel of its face', () => {
    let n = 0;
    let same = 0;
    for (const s of points(m, 1000)) {
      const face = faceOf(s.normal);
      const at = voxelCellOf(s.p, face);
      const want = locateVoxelFace(tile.made!, at.cell, face, at.fu, at.fv);
      if (want === null) continue;
      n++;
      const hit = { kind: TRACE_VOXELS, t: 1, normal: [0, 0, 0] as [number, number, number], face, object: 0, ...voxelHitWords(at.cell, at.fu, at.fv) };
      const got = scene.resolve(cache, hit);
      const texel = cache.texelOf(tile.key, want.chart, want);
      if (got !== null && texel !== null && 'page' in got && 'page' in texel && got.page === texel.page && Math.abs(got.x - texel.x) <= 1 && Math.abs(got.y - texel.y) <= 1) same++;
    }
    expect(n).toBeGreaterThan(900);
    // The hit's place across its face is a byte (2 mm), the lookup's exact: a texel either side at most, and nearly all the same.
    expect(same / n).toBeGreaterThan(0.99);
  });

  it('lists a page\'s voxel chunks, lights their texels on the surface, and makes a chunk drawn again new', () => {
    let version = 1;
    const chunk = (): SurfaceVoxelChunk => ({ key: 'w/64,0,-32', version, cell0: CELL0, edge: EDGE, mesh: () => m });
    const host = new SurfaceCacheHost({ layers: () => [], terrains: () => [], architecture: () => [], models: () => [], bricks: () => null }, 32 * 1024 * 1024);
    expect(host.relightBudgetMs).toBe(0);
    host.voxels.set({ chunks: () => [chunk()], walk: () => null, relightMs: 6.67 });
    expect(host.relightBudgetMs).toBe(6.67);
    host.setLive(true);
    const eye = [CELL0[0] * VOXEL_SIZE_M + 8, 3, CELL0[2] * VOXEL_SIZE_M + 8];
    // Frame times from now on (the listing waits its interval, the charts are made within the frame's slice from it).
    let now = performance.now();
    // Until the first frame plans texels (the charts made, the tile resident).
    for (let f = 0; f < 8 && host.slicesThisFrame().length === 0; f++) host.update(eye, (now += 300));
    const d = host.voxels.diagnostics();
    expect(d.tiles).toBe(1);
    expect(d.resident).toBe(1);
    expect(d.residentTexels).toBeGreaterThan(10000);
    // Handed to the pass already (planned texels count as lit: the pass lights them or gives them back).
    expect(d.litTexels).toBeLessThanOrEqual(d.residentTexels);
    // This frame's planned texels: on the chunk's surface (a normal each), within its box.
    const sun: CacheLight = { id: 'sun', kind: 'directional', on: true, position: [0, 0, 0], direction: [0, 1, 0], color: [1, 1, 1], range: 0, cone: 0, penumbra: 0 };
    const frame = lightFrameOf(host, [sun]);
    const texels = frame.slices.reduce((s, sl) => s + sl.texels, 0);
    expect(texels).toBeGreaterThan(1000);
    let onSurface = 0;
    for (let i = 0; i < texels; i++) {
      const o = i * TEXEL_POINT_FLOATS;
      const len = Math.hypot(frame.points[o + 3]!, frame.points[o + 4]!, frame.points[o + 5]!);
      const inBox = frame.points[o]! >= tile.min[0]! && frame.points[o]! <= tile.max[0]! && frame.points[o + 1]! >= 1 && frame.points[o + 1]! <= 6.5;
      if (Math.abs(len - 1) < 1e-3 && inBox) onSurface++;
    }
    expect(onSurface).toBe(texels);
    // Drawn again (an edit): a new version is made again, its units stale.
    version = 2;
    host.touch();
    for (let f = 0; f < 3; f++) host.update(eye, (now += 300));
    expect(host.voxels.diagnostics().resident).toBe(1);
    expect((host.resolveScene().scene.resolveView().voxels[0] as { version: number }).version).toBe(2);
    host.voxels.set(null);
    for (let f = 0; f < 2; f++) host.update(eye, (now += 300));
    expect(host.voxels.diagnostics().tiles).toBe(0);
    expect(host.relightBudgetMs).toBe(0);
  });
});
