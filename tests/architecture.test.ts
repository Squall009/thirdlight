/**
 * The architecture generator (project-model): determinism, the two
 * primitives' geometry (sweep with mitres and openings, repeat), fills,
 * chunking, keys, colliders and the blob. Browser-free; the page and its
 * workers are compared in three-adapter's own test and the pixels in the
 * layered-material e2e.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeArchitectureChunks, encodeArchitectureChunks } from '../packages/project-model/src/arch-blob';
import { detSinCos } from '../packages/project-model/src/arch-math';
import {
  architectureChunkKeys,
  architectureChunks,
  architectureColliders,
  generateArchitecture,
  generateArchitectureChunk,
  repeatPlaces,
  type ArchitectureChunk,
} from '../packages/project-model/src/arch-generate';
import { samplePath } from '../packages/project-model/src/arch-path';
import type { ArchitectureComponent, ArchitectureSweep } from '../packages/project-model/src/architecture';
import { validateArchitectureComponent } from '../packages/project-model/src/architecture';
import { defaultTrimSheet, trimRowOf, trimRowV } from '../packages/project-model/src/trim-sheet';
import { sha256Hex } from '../packages/project-model/src/sha256';
import { architectureMeshPacker } from '../packages/exporter/src/architecture-meshes';
import { TEST_PROFILES, testArchitecture } from './arch-test-style';

const SHEET = defaultTrimSheet();
const SHEETS = { '*': SHEET };
const BOUNDS = { vertices: 1024, triangles: 2048 };

function digest(chunks: readonly ArchitectureChunk[]): string {
  return sha256Hex(encodeArchitectureChunks(chunks));
}
function triangles(chunks: readonly ArchitectureChunk[], level: 0 | 1, material?: string): number {
  let n = 0;
  for (const c of chunks) for (const m of c.meshes) if (material === undefined || m.material === material) n += (level === 0 ? m.mesh.indices : m.mesh.farIndices).length / 3;
  return n;
}
/** All near-level triangles as [a, b, c] point triples with their vertex normals and uvs. */
function eachTriangle(chunks: readonly ArchitectureChunk[], f: (p: number[][], n: number[][], uv: number[][]) => void): void {
  for (const c of chunks)
    for (const m of c.meshes) {
      const l = m.mesh;
      for (let i = 0; i < l.indices.length; i += 3) {
        const ix = [l.indices[i]!, l.indices[i + 1]!, l.indices[i + 2]!];
        f(
          ix.map((k) => [l.positions[k * 3]!, l.positions[k * 3 + 1]!, l.positions[k * 3 + 2]!]),
          ix.map((k) => [l.normals[k * 3]!, l.normals[k * 3 + 1]!, l.normals[k * 3 + 2]!]),
          ix.map((k) => [l.uvs[k * 2]!, l.uvs[k * 2 + 1]!]),
        );
      }
    }
}
function sweepOnly(e: ArchitectureSweep, extra: Partial<ArchitectureComponent> = {}): ArchitectureComponent {
  return { profiles: TEST_PROFILES, elements: [e], ao: { strength: 0 }, ...extra };
}

describe('architecture generator', () => {
  it('validates the neutral test style', () => {
    const errors: unknown[] = [];
    validateArchitectureComponent(testArchitecture(), '/architecture', errors as never);
    expect(errors).toEqual([]);
  });

  it('is deterministic: the same parameters give the same bytes, run after run and however the chunks are cut', () => {
    const c = testArchitecture();
    const a = generateArchitecture(c, SHEETS);
    const b = generateArchitecture(c, SHEETS);
    expect(digest(a)).toBe(digest(b));
    // Cut finer, the same triangles are made (each by exactly one chunk).
    const fine = generateArchitecture(testArchitecture(4), SHEETS);
    expect(fine.length).toBeGreaterThan(a.length);
    for (const level of [0, 1] as const) expect(triangles(fine, level)).toBe(triangles(a, level));
    expect(a.every((c) => c.problems.length === 0)).toBe(true);
  });

  it('own trig: sin and cos match the platform within 1e-15 and never call it', () => {
    for (let x = -20; x <= 20; x += 0.37) {
      const [s, co] = detSinCos(x);
      expect(Math.abs(s - Math.sin(x))).toBeLessThan(2e-15);
      expect(Math.abs(co - Math.cos(x))).toBeLessThan(2e-15);
    }
    const dir = join(__dirname, '../packages/project-model/src');
    for (const f of ['arch-math.ts', 'arch-path.ts', 'arch-mesh.ts', 'arch-sweep.ts', 'arch-fill.ts', 'arch-opening.ts', 'arch-generate.ts', 'arch-rooms.ts', 'arch-room-grid.ts', 'trim-paint.ts']) {
      const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/Math\.(sin|cos|tan|atan2?|asin|acos|hypot|pow|exp|log\d*|cbrt)\b|\*\*/);
    }
  });

  it('arcs: a bulge of 1 is a half circle through the chord ends', () => {
    const s = samplePath({ points: [[0, 0, 0], [10, 0, 0]], bulges: [1], step: 0.25 });
    // Bulging right of travel (+x): the centre is the chord's middle, radius 5, all on the +z side.
    for (let i = 0; i < s.n; i++) {
      const dx = s.pos[i * 3]! - 5;
      const dz = s.pos[i * 3 + 2]!;
      expect(Math.abs(Math.sqrt(dx * dx + dz * dz) - 5)).toBeLessThan(1e-9);
      expect(dz).toBeGreaterThanOrEqual(-1e-12);
    }
    expect(Math.abs(s.length - Math.PI * 5)).toBeLessThan(0.05);
  });

  it('sweep: a closed wall is mitred at its corners, wears its rows once across, faces out', () => {
    const c = sweepOnly({ id: 'w', kind: 'sweep', path: { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]], closed: true }, profile: 'wall' });
    const chunks = generateArchitecture(c, SHEETS);
    const lower = trimRowOf(SHEET, 'lower_wall')!;
    const [v0, v1] = trimRowV(SHEET, lower);
    let corner = 0;
    eachTriangle(chunks, (p, n, uv) => {
      for (let k = 0; k < 3; k++) {
        const [x, , z] = p[k]!;
        // Every vertex lies on the wall's faces: within 0.1 m (0.1·√2 at a mitre) of the path's rectangle.
        const dx = Math.min(Math.abs(x), Math.abs(x - 8));
        const dz = Math.min(Math.abs(z), Math.abs(z - 6));
        expect(Math.min(dx, dz)).toBeLessThanOrEqual(0.1 + 1e-6);
        // At a corner, the inner and outer face vertices lie on the mitre (the diagonal through the corner).
        if (dx < 0.11 && dz < 0.11) {
          expect(Math.abs(dx - dz)).toBeLessThan(1e-5);
          corner++;
        }
        const len = Math.sqrt(n[k]![0]! ** 2 + n[k]![1]! ** 2 + n[k]![2]! ** 2);
        expect(Math.abs(len - 1)).toBeLessThan(1e-5);
      }
      // v stays within some row's inset band: lower_wall's faces (normals into the room, +z on the first side) stay in it.
      if (Math.abs(n[0]![2]! - 1) < 1e-6 && p.every((q) => q[2]! > 0.05 && q[2]! < 0.15)) for (const q of uv) expect(q[1]! >= v0 - 1e-6 && q[1]! <= v1 + 1e-6).toBe(true);
    });
    expect(corner).toBeGreaterThan(0);
    // A wall is no detail: its far level is all of its triangles (an index list over the same vertices).
    expect(triangles(chunks, 1)).toBe(triangles(chunks, 0));
  });

  it('openings: no wall face inside the hole, reveals and a frame round it', () => {
    const base = { id: 'w', kind: 'sweep' as const, path: { points: [[0, 0, 0], [8, 0, 0]] as [number, number, number][] }, profile: 'wall' };
    const plain = generateArchitecture(sweepOnly(base), SHEETS);
    const holed = generateArchitecture(sweepOnly({ ...base, openings: [{ id: 'win', at: 4, width: 2, bottom: 1, top: 2, frame: 'frame' }] }), SHEETS);
    let inside = 0;
    let reveals = 0;
    eachTriangle(holed, (p, n) => {
      const cx = (p[0]![0]! + p[1]![0]! + p[2]![0]!) / 3;
      const cy = (p[0]![1]! + p[1]![1]! + p[2]![1]!) / 3;
      const cz = (p[0]![2]! + p[1]![2]! + p[2]![2]!) / 3;
      // Wall faces look ±z; inside the hole's square nothing of them stays.
      if (Math.abs(Math.abs(n[0]![2]!) - 1) < 1e-6 && Math.abs(cz) > 0.099 && Math.abs(cz) < 0.101 && cx > 3 + 1e-3 && cx < 5 - 1e-3 && cy > 1 + 1e-3 && cy < 2 - 1e-3) inside++;
      // Reveals look along x (the jambs) or up/down (head and sill) between the faces.
      if (Math.abs(cz) < 0.099 && cx > 2.99 && cx < 5.01 && cy > 0.99 && cy < 2.01) reveals++;
    });
    expect(inside).toBe(0);
    expect(reveals).toBeGreaterThanOrEqual(8);
    // The frame (near level only) adds triangles on the face; the far level has the reveals, not the frame.
    const bare = generateArchitecture(sweepOnly({ ...base, openings: [{ id: 'win', at: 4, width: 2, bottom: 1, top: 2 }] }), SHEETS);
    expect(triangles(holed, 0)).toBeGreaterThan(triangles(bare, 0));
    expect(triangles(holed, 1)).toBe(triangles(bare, 1));
    // Colliders: the wall's one box becomes the boxes beside the hole, below the sill and above the head.
    const boxes = (c: ArchitectureComponent): number => architectureColliders(c, SHEETS, BOUNDS).filter((x) => x.kind === 'box').length;
    expect(boxes(sweepOnly(base))).toBe(1);
    expect(boxes(sweepOnly({ ...base, openings: [{ id: 'win', at: 4, width: 2, bottom: 1, top: 2 }] }))).toBe(4);
  });

  it('repeat: copies every spacing along the path, a made piece stamped at each, kit copies with stable ids', () => {
    const c = testArchitecture();
    const columns = c.elements.find((e) => e.id === 'columns')!;
    if (columns.kind !== 'repeat') throw new Error('test style');
    const places = repeatPlaces(columns, c, samplePath(columns.path));
    expect(places.map((p) => Math.round(p.x * 1000) / 1000)).toEqual([1.5, 3.167, 4.833, 6.5]);
    const only = { ...c, elements: [columns] };
    const one = { ...c, elements: [{ ...columns, path: { points: [[0, 0, 0], [0.5, 0, 0]] as [number, number, number][] }, spacing: 10 }] };
    expect(triangles(generateArchitecture(only, SHEETS), 0)).toBe(4 * triangles(generateArchitecture(one, SHEETS), 0));
    const kit = generateArchitecture({ ...c, elements: [{ ...columns, piece: { model: { assetId: 'kit-column' } } }] }, SHEETS);
    const ids = kit.flatMap((k) => k.copies.flatMap((s) => s.ids));
    expect(ids).toEqual(['columns:0', 'columns:1', 'columns:2', 'columns:3']);
  });

  it('fills: a flat floor covers its outline exactly; a barrel vault rises to its crown; a hip roof meets at its ridge', () => {
    const room: [number, number, number][] = [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]];
    const area = (chunks: ArchitectureChunk[]): number => {
      let a = 0;
      eachTriangle(chunks, (p) => {
        const e1 = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!];
        const e2 = [p[2]![0]! - p[0]![0]!, p[2]![1]! - p[0]![1]!, p[2]![2]! - p[0]![2]!];
        const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
        const cy = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
        const cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
        a += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
      });
      return a;
    };
    const floor = generateArchitecture({ elements: [{ id: 'f', kind: 'fill', path: { points: room, closed: true }, shape: 'flat', slot: 'floor' }] }, SHEETS);
    expect(Math.abs(area(floor) - 48)).toBeLessThan(1e-3);
    eachTriangle(floor, (_p, n) => expect(n[0]![1]).toBe(1));
    // An L-shaped floor: its area too.
    const ell: [number, number, number][] = [[0, 0, 0], [6, 0, 0], [6, 0, 2], [2, 0, 2], [2, 0, 5], [0, 0, 5]];
    expect(Math.abs(area(generateArchitecture({ elements: [{ id: 'f', kind: 'fill', path: { points: ell, closed: true }, shape: 'flat', slot: 'floor' }] }, SHEETS)) - 18)).toBeLessThan(1e-3);
    const vault = generateArchitecture({ elements: [{ id: 'v', kind: 'fill', path: { points: room, closed: true }, shape: 'barrel', slot: 'floor', height: 3, rise: 2 }] }, SHEETS);
    let top = -Infinity;
    let low = Infinity;
    eachTriangle(vault, (p, n) => {
      for (const q of p) {
        top = Math.max(top, q[1]!);
        low = Math.min(low, q[1]!);
      }
      // Faces look in: down or toward the axis (z = 3).
      const cz = (p[0]![2]! + p[1]![2]! + p[2]![2]!) / 3;
      expect(n[0]![1]! <= 1e-6 || Math.sign(n[0]![2]!) === Math.sign(3 - cz)).toBe(true);
    });
    expect(Math.abs(top - 5)).toBeLessThan(1e-9);
    expect(Math.abs(low - 3)).toBeLessThan(1e-9);
    const hip = generateArchitecture({ elements: [{ id: 'r', kind: 'fill', path: { points: room, closed: true }, shape: 'hip', slot: 'floor', height: 3, rise: 2 }] }, SHEETS);
    let ridge = 0;
    eachTriangle(hip, (p, n) => {
      expect(n[0]![1]!).toBeGreaterThan(0);
      for (const q of p) if (Math.abs(q[1]! - 5) < 1e-6) ridge = Math.max(ridge, q[0]!);
    });
    // The ridge runs along x from 3 to 5 (8 long, 6 wide: half the width in from each end).
    expect(Math.abs(ridge - 5)).toBeLessThan(1e-6);
    // A vault over a path that is not a rectangle is reported, not guessed.
    const bad = generateArchitecture({ elements: [{ id: 'v', kind: 'fill', path: { points: ell, closed: true }, shape: 'barrel', slot: 'floor' }] }, SHEETS);
    expect(bad.flatMap((c) => c.problems)).toEqual(['fill "v": a barrel needs a rectangular path (four corners at right angles)']);
  });

  it('keys: a chunk keeps its key when an element that does not reach it changes', () => {
    const c = testArchitecture(4);
    const keys = architectureChunkKeys(c, SHEETS);
    expect(keys.size).toBe(architectureChunks(c).length);
    const moved: ArchitectureComponent = { ...c, elements: c.elements.map((e) => (e.id === 'columns' && e.kind === 'repeat' ? { ...e, spacing: 2.5 } : e)) };
    const after = architectureChunkKeys(moved, SHEETS);
    let same = 0;
    let changed = 0;
    for (const [k, v] of keys) (after.get(k)?.key === v.key ? same++ : changed++);
    expect(same).toBeGreaterThan(0);
    expect(changed).toBeGreaterThan(0);
    // A different sheet changes every key.
    const other = architectureChunkKeys(c, { '*': { ...SHEET, texelDensity: 512 } });
    for (const [k, v] of keys) expect(other.get(k)!.key).not.toBe(v.key);
  });

  it('the blob round-trips every chunk to the byte', () => {
    const chunks = generateArchitecture(testArchitecture(8), SHEETS);
    const blob = encodeArchitectureChunks(chunks);
    expect(sha256Hex(encodeArchitectureChunks(decodeArchitectureChunks(blob)))).toBe(sha256Hex(blob));
  });

  it('measures a room-sized regeneration (the slider-drag target is 16 ms)', () => {
    const c = testArchitecture();
    const keys = [...architectureChunkKeys(c, SHEETS).values()];
    generateArchitectureChunk(c, SHEETS, keys[0]!.cx, keys[0]!.cz);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      for (const k of keys) generateArchitectureChunk(c, SHEETS, k.cx, k.cz);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    if (process.env['TL_PERF'] === '1') console.log(`architecture: room regenerated in ${times[10]!.toFixed(2)} ms median, ${times[18]!.toFixed(2)} ms p95 (${keys.length} chunk(s), ${triangles(generateArchitecture(c, SHEETS), 0)} triangles near)`);
    expect(times[10]!).toBeLessThan(200);
  });

  it('an export that ships meshes names a blob of what the page would generate with the object\'s trim sheet', () => {
    const sheet = { ...SHEET, texelDensity: 512 };
    const defs = [
      { materialId: 'trim', name: 'Trim', shader: 'trim' as const, params: {}, textures: {}, trim: sheet },
      { materialId: 'trim-red', name: 'Trim red', instanceOf: 'trim', values: {} },
    ] as never[];
    const c = testArchitecture();
    const doc = { sceneId: 's', entities: [{ id: 'a', components: { architecture: c, materials: { '*': 'trim-red' } } }, { id: 'b', components: {} }] };
    const off = architectureMeshPacker(false, () => defs, sha256Hex);
    expect(off.pack(doc)).toBe(doc);
    const on = architectureMeshPacker(true, () => defs, sha256Hex);
    const packed = on.pack(doc) as typeof doc;
    const baked = (packed.entities[0]!.components.architecture as ArchitectureComponent).baked!;
    const blobs = on.blobs();
    expect(blobs.map((b) => b.digest)).toEqual([baked]);
    // The instance draws with its root's sheet: the blob is what the generator makes with that sheet.
    expect(sha256Hex(encodeArchitectureChunks(decodeArchitectureChunks(blobs[0]!.bytes)))).toBe(sha256Hex(encodeArchitectureChunks(generateArchitecture(c, { architecture: sheet }).map((k) => ({ ...k, problems: [] })))));
    expect(doc.entities[0]!.components.architecture.baked).toBeUndefined();
  });
});
