/**
 * Smoothed block-layer tops: a layer's crease angle (`smoothAngle`) averages
 * the vertex normals of tops that meet at the same height — across cells and
 * across chunk edges — and keeps edges sharper than the angle hard; optional
 * subdivided tops (`topSubdivision`). Without either field the mesher's output
 * is the very same as before they existed (a digest of a mixed fixture).
 */
import { describe, expect, it } from 'vitest';

import { BLOCK_LAYER_DEFAULT, canonicalBlockLayerComponent, validateBlockLayerComponent, type BlockType } from './block-layers';
import { BlockGrid, chunkKeyOf } from './block-grid';
import { chunkLightmapLayout } from './block-lightmap';
import { blockTopOptions, collisionMeshChunk, meshBlockChunk, shapeSource, type BlockLookResolver, type BlockTopOptions, type ChunkMeshPart } from './block-mesh';
import { subdividedHeightAt } from './block-surface';
import type { ModelErrorV2 } from './errors';

const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'grass', name: 'Grass', variants: [{ color: '#55aa55' }, { color: '#66bb66' }], shape: 'full' },
  { blockId: 'slab', name: 'Slab', variants: [{ color: '#aaaaaa' }], shape: 'half' },
  { blockId: 'ramp', name: 'Ramp', variants: [{ color: '#777777' }], shape: 'ramp', rotations: [0, 90, 180, 270] },
  { blockId: 'stairs', name: 'Stairs', variants: [{ color: '#666666' }], shape: 'stairs', rotations: [0, 90, 180, 270] },
  { blockId: 'box', name: 'Box', variants: [{ color: '#444444' }], shape: 'custom', boxes: [[0, 0, 0, 1, 0.5, 1], [0.25, 0.5, 0.25, 0.75, 1, 0.75]] },
  { blockId: 'well', name: 'Well', variants: [{ color: '#333333' }], shape: 'full', footprint: [2, 1, 2] },
];
const types = new Map(TYPES.map((t) => [t.blockId, t]));
const standIns: BlockLookResolver = { source: (t, v, fm) => ({ key: `${t.blockId}:${v}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2], t.boxes) }) };
const q = (v: number): number => Math.round(v * 16) / 16;

/** Rolling sloped ground over 2 × 2 chunks (0.5 m rows) with a few of every shape on it, a cliff and a pit. */
function mixedLayer(): BlockGrid {
  const g = new BlockGrid({ cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [32, 24, 32] } });
  const h = (x: number, z: number): number => q(8 + 3 * Math.sin(x / 5) * Math.cos(z / 6));
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) {
    if (x >= 10 && x < 12 && z >= 10 && z < 12) continue;
    // Columns 20–23 stand 4 rows higher: a cliff on both sides.
    const lift = x >= 20 && x < 24 ? 4 : 0;
    const c = [h(x, z) + lift, h(x + 1, z) + lift, h(x + 1, z + 1) + lift, h(x, z + 1) + lift];
    const row = Math.floor(Math.min(...c) - 1e-9);
    for (let y = 0; y < row; y++) g.set(x, y, z, { block: 'stone' });
    const corners = c.map((v) => v - row) as [number, number, number, number];
    g.set(x, row, z, { block: 'grass', variant: (x + z) % 2, ...(corners.every((v) => v === 1) ? {} : { corners }) });
  }
  const top = (x: number, z: number): number => g.columnTop(x, z)! + 1;
  g.set(3, top(3, 3), 3, { block: 'slab' });
  g.set(4, top(4, 3), 3, { block: 'ramp', rot: 90 });
  g.set(5, top(5, 3), 3, { block: 'stairs', rot: 180 });
  g.set(6, top(6, 3), 3, { block: 'box' });
  g.set(15, top(15, 15), 15, { block: 'well' });
  return g;
}

/** A 64-bit FNV-1a over bytes (two 32-bit lanes), enough to tell any change of the output. */
class Fnv {
  private a = 0x811c9dc5;
  private b = 0x01000193;
  update(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    for (let i = 0; i < bytes.length; i++) {
      this.a = Math.imul(this.a ^ bytes[i]!, 0x01000193) >>> 0;
      this.b = Math.imul(this.b ^ bytes[i]! ^ (i & 0xff), 0x811c9dc5 | 1) >>> 0;
    }
  }
  digest(): string {
    return `${this.a.toString(16).padStart(8, '0')}${this.b.toString(16).padStart(8, '0')}`;
  }
}

/** Every chunk's parts and collision pieces, hashed (positions, normals, uvs, indices, keys). */
function digestOf(g: BlockGrid, options?: Parameters<typeof meshBlockChunk>[5]): string {
  const hash = new Fnv();
  for (const k of g.chunkKeys()) {
    const [cx, cz] = k.split(',').map(Number) as [number, number];
    for (const p of meshBlockChunk(g, cx, cz, types, standIns, options)) {
      hash.update(p.key);
      for (const a of [p.positions, p.normals, p.uvs, p.indices]) hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    }
    for (const c of collisionMeshChunk(g, cx, cz, types)) hash.update(JSON.stringify(c));
  }
  return hash.digest();
}

/** Every vertex of a chunk's parts: position key → the normals given there (rounded), and whether it is an up-facing vertex. */
function normalsAt(parts: readonly ChunkMeshPart[], filter: (x: number, y: number, z: number) => boolean = () => true): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const p of parts) {
    for (let i = 0; i < p.positions.length / 3; i++) {
      const [x, y, z] = [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!];
      if (!filter(x, y, z)) continue;
      const n = [p.normals[i * 3]!, p.normals[i * 3 + 1]!, p.normals[i * 3 + 2]!];
      if (n[1]! <= 0.05) continue;
      const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
      let set = out.get(k);
      if (set === undefined) out.set(k, (set = new Set()));
      set.add(n.map((v) => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6)).join(','));
    }
  }
  return out;
}

const chunk = (g: BlockGrid, cx: number, cz: number, options?: BlockTopOptions): ChunkMeshPart[] => meshBlockChunk(g, cx, cz, types, standIns, options);

/** A ridge along z: two 45° slopes meeting at x = 2 (columns 0–3, rows of 4, 1 m cells). */
function ridge(): BlockGrid {
  const g = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [4, 4, 4] } });
  const h = [1, 2, 3, 2, 1];
  for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
    const row = Math.min(h[x]!, h[x + 1]!) - 1;
    for (let y = 0; y < row; y++) g.set(x, y, z, { block: 'stone' });
    g.set(x, row, z, { block: 'stone', corners: [h[x]! - row, h[x + 1]! - row, h[x + 1]! - row, h[x]! - row] });
  }
  return g;
}

const errs = (fn: (e: ModelErrorV2[]) => void): string[] => {
  const e: ModelErrorV2[] = [];
  fn(e);
  return e.map((x) => x.path);
};

describe('block-layer tops: smoothing and subdivision', () => {
  it('without smoothAngle or topSubdivision the meshes are byte for byte what they were before either existed', () => {
    expect(digestOf(mixedLayer())).toBe("28c22e5eeef272e3");
    expect(digestOf(mixedLayer(), {})).toBe("28c22e5eeef272e3");
    expect(digestOf(mixedLayer(), blockTopOptions({ smoothAngle: 0, topSubdivision: 1 }))).toBe("28c22e5eeef272e3");
  });

  it('smoothed and subdivided tops are byte for byte the same whichever way the mesher computes them', () => {
    // Pinned so a faster mesher (or one running in a worker) cannot change a single vertex.
    expect(digestOf(mixedLayer(), { smoothAngle: 40 })).toBe('4b7195e7961cd91a');
    expect(digestOf(mixedLayer(), { topSubdivision: 2 })).toBe('6a90741c7dad9f9b');
    expect(digestOf(mixedLayer(), { smoothAngle: 40, topSubdivision: 2 })).toBe('473b2e6b21c3166e');
  });

  it('smoothAngle and topSubdivision are validated, stored only when they change something, and read as top options', () => {
    const layer = { ...BLOCK_LAYER_DEFAULT };
    expect(errs((e) => validateBlockLayerComponent({ ...layer, smoothAngle: 45, topSubdivision: 2 }, '', e))).toEqual([]);
    expect(errs((e) => validateBlockLayerComponent({ ...layer, smoothAngle: 181 }, '', e))).toEqual(['/smoothAngle']);
    expect(errs((e) => validateBlockLayerComponent({ ...layer, smoothAngle: -1 }, '', e))).toEqual(['/smoothAngle']);
    expect(errs((e) => validateBlockLayerComponent({ ...layer, topSubdivision: 3 }, '', e))).toEqual(['/topSubdivision']);
    expect(errs((e) => validateBlockLayerComponent({ ...layer, topSubdivision: 1.5 }, '', e))).toEqual(['/topSubdivision']);
    expect(canonicalBlockLayerComponent({ ...layer, smoothAngle: 0, topSubdivision: 1 })).toEqual(canonicalBlockLayerComponent(layer));
    expect(canonicalBlockLayerComponent({ ...layer, smoothAngle: 30, topSubdivision: 2 })).toMatchObject({ smoothAngle: 30, topSubdivision: 2 });
    expect(blockTopOptions({ smoothAngle: 30, topSubdivision: 2 })).toEqual({ smoothAngle: 30, topSubdivision: 2 });
    expect(blockTopOptions({})).toEqual({});
  });

  it('a crease angle averages the normals where tops meet at the same height, and keeps a sharper edge hard', () => {
    const g = ridge();
    // Flat-shaded: each slope keeps its face normal, the crest has two.
    const crest = (x: number, y: number): boolean => Math.abs(x - 2) < 1e-6 && Math.abs(y - 3) < 1e-6;
    const flat = normalsAt(chunk(g, 0, 0), crest);
    expect([...flat.values()].every((s) => s.size === 2)).toBe(true);
    // 45° slopes meet at 90°: an angle of 100° averages them (straight up at the crest), 80° keeps the crease.
    const smooth = normalsAt(chunk(g, 0, 0, { smoothAngle: 100 }), crest);
    expect(flat.size).toBeGreaterThan(0);
    for (const s of smooth.values()) expect([...s]).toEqual(['0.000000,1.000000,0.000000']);
    const creased = normalsAt(chunk(g, 0, 0, { smoothAngle: 80 }), crest);
    for (const s of creased.values()) expect(s.size).toBe(2);
    // Mid-slope points (x = 1 and 3) lie between coplanar tops: one normal, the slope's own, even with the crease kept.
    const mid = normalsAt(chunk(g, 0, 0, { smoothAngle: 80 }), (x) => Math.abs(x - 1) < 1e-6 || Math.abs(x - 3) < 1e-6);
    for (const s of mid.values()) expect(s.size).toBe(1);
  });

  it('walls and cliffs are not tops: the ground at a cliff\'s foot and its top edge stay straight up', () => {
    const g = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [8, 8, 8] } });
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) for (let y = 0; y < (x >= 4 ? 3 : 1); y++) g.set(x, y, z, { block: 'stone' });
    const parts = chunk(g, 0, 0, { smoothAngle: 180 });
    const up = normalsAt(parts, (_x, y) => Math.abs(y - 1) < 1e-6 || Math.abs(y - 3) < 1e-6);
    expect(up.size).toBeGreaterThan(0);
    for (const s of up.values()) expect([...s]).toEqual(['0.000000,1.000000,0.000000']);
    // The wall keeps its own normal (−x).
    const wall = parts.flatMap((p) => Array.from({ length: p.positions.length / 3 }, (_, i) => [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.normals[i * 3]!, p.normals[i * 3 + 1]!])).filter(([x, y, nx]) => Math.abs(x! - 4) < 1e-6 && y! > 1.5 && y! < 2.5 && nx! < 0);
    expect(wall.length).toBeGreaterThan(0);
    for (const w of wall) expect([w[2], w[3]]).toEqual([-1, 0]);
  });

  it('both chunks give a point on their shared edges (sides and corners) the very same smoothed normals', () => {
    const g = mixedLayer();
    const meshes = new Map<string, Map<string, Set<string>>>();
    for (const k of g.chunkKeys()) {
      const [cx, cz] = k.split(',').map(Number) as [number, number];
      meshes.set(k, normalsAt(chunk(g, cx, cz, { smoothAngle: 45 })));
    }
    let shared = 0;
    const keys = [...meshes.keys()];
    for (let a = 0; a < keys.length; a++)
      for (let b = a + 1; b < keys.length; b++) {
        const A = meshes.get(keys[a]!)!;
        const B = meshes.get(keys[b]!)!;
        for (const [pos, normals] of A) {
          const other = B.get(pos);
          if (other === undefined) continue;
          shared += 1;
          expect([...other].sort(), `normals at ${pos} in ${keys[a]} and ${keys[b]}`).toEqual([...normals].sort());
        }
      }
    // The two chunk edges' top points (31 + 31, the pit and cliff not on them), the shared corner point among them.
    expect(shared).toBeGreaterThan(50);
    // Smoothed: a point of the rolling ground inside a chunk has a single normal.
    const inner = normalsAt(chunk(g, 0, 0, { smoothAngle: 45 }), (x, _y, z) => x > 1 && x < 9 && z > 1 && z < 9);
    expect([...inner.values()].every((s) => s.size === 1)).toBe(true);
    const innerFlat = normalsAt(chunk(g, 0, 0), (x, _y, z) => x > 1 && x < 9 && z > 1 && z < 9);
    expect([...innerFlat.values()].some((s) => s.size > 1)).toBe(true);
  });

  it('a cell written at a chunk corner re-meshes the diagonal chunk too (its corner point is shared)', () => {
    const g = mixedLayer();
    g.takeDirty();
    g.set(15, 20, 15, { block: 'stone' });
    expect(g.takeDirty().mesh.sort()).toEqual([chunkKeyOf(0, 0), chunkKeyOf(0, 1), chunkKeyOf(1, 0), chunkKeyOf(1, 1)].sort());
  });

  it('subdivided tops: 2 × 2 cut with the centre blended from the corners; collision keeps the corners\' two triangles', () => {
    const g = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [1, 2, 1] } });
    // A twisted top: the two-triangle split puts the centre at 0.5 or 1, the blend at 0.75.
    g.set(0, 0, 0, { block: 'stone', corners: [0.5, 1, 0.5, 1] });
    const tops = (parts: ChunkMeshPart[]): number[][] => {
      const out: number[][] = [];
      for (const p of parts)
        for (let i = 0; i < p.indices.length; i += 3) {
          const v = [p.indices[i]!, p.indices[i + 1]!, p.indices[i + 2]!].map((k) => [p.positions[k * 3]!, p.positions[k * 3 + 1]!, p.positions[k * 3 + 2]!]);
          const e = [0, 1, 2].map((k) => v[1]![k]! - v[0]![k]!);
          const f = [0, 1, 2].map((k) => v[2]![k]! - v[0]![k]!);
          // Facing up (the top), not a side.
          if (e[2]! * f[0]! - e[0]! * f[2]! > 1e-9) out.push(...v);
        }
      return out;
    };
    const plain = tops(chunk(g, 0, 0));
    const cut = tops(chunk(g, 0, 0, { topSubdivision: 2 }));
    expect(cut.length).toBeGreaterThan(plain.length);
    // Without the cut the centre lies on the split diagonal (at 1 here), not on the blend.
    expect(plain.filter((q) => Math.abs(q[0]! - 0.5) < 1e-6 && Math.abs(q[2]! - 0.5) < 1e-6).every((q) => Math.abs(q[1]! - 0.75) > 0.1)).toBe(true);
    const centre = cut.find((q) => Math.abs(q[0]! - 0.5) < 1e-6 && Math.abs(q[2]! - 0.5) < 1e-6);
    expect(centre?.[1]).toBeCloseTo(0.75, 6);
    expect(subdividedHeightAt([0.5, 1, 0.5, 1], 2, 0.5, 0.5)).toBeCloseTo(0.75, 9);
    // Every drawn top point lies on the subdivided surface.
    for (const q of cut) expect(q[1]).toBeCloseTo(subdividedHeightAt([0.5, 1, 0.5, 1], 2, q[0]!, q[2]!), 5);
    // Edges keep the corners' straight lines, so a neighbour cut 1 × 1 meets it without a crack.
    for (const q of cut.filter((p) => Math.abs(p[0]!) < 1e-6)) expect(q[1]).toBeCloseTo(0.5 + 0.5 * q[2]!, 6);
    // Collision is meshed without top options.
    const colTops = collisionMeshChunk(g, 0, 0, types)[0]!;
    expect(colTops.vertices.filter((_, i) => i % 3 === 1).some((y) => Math.abs(y - 0.75) < 1e-6)).toBe(false);
  });

  it('lightmap layouts: smoothing keeps the faces (same slots), its shading key changes the digest; subdivided tops still map into one square', () => {
    const g = mixedLayer();
    const flat = chunkLightmapLayout(chunk(g, 0, 0), g.cellSize);
    const smoothParts = chunk(g, 0, 0, { smoothAngle: 45 });
    expect(chunkLightmapLayout(smoothParts, g.cellSize).layout).toBe(flat.layout);
    const keyed = chunkLightmapLayout(smoothParts, g.cellSize, undefined, 'tops:45:1');
    expect(keyed.layout).not.toBe(flat.layout);
    expect(keyed.layout).toMatch(/^[0-9a-f]{16}$/);
    const cut = chunkLightmapLayout(chunk(g, 0, 0, { smoothAngle: 45, topSubdivision: 2 }), g.cellSize, undefined, 'tops:45:2');
    expect(cut.parts.every((p) => p.uv1 !== undefined && p.uv1.length === (p.positions.length / 3) * 2)).toBe(true);
    expect(cut.parts.every((p) => [...p.uv1!].every((v) => v >= 0 && v <= 1))).toBe(true);
  });
});
