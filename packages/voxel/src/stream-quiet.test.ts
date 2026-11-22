import { describe, expect, it } from 'vitest';
import { chunkNearFoci, collisionRingBounds } from './collision-ring';
import { chunkGrid } from './coords';
import type { ChunkBox } from './grid-place';
import { chooseLevels, levelNodeDistance, type LevelNode } from './lod-select';
import { quietReach } from './stream-quiet';
import { DEFAULT_LEVEL_RINGS, DEFAULT_STREAM_RING, inLoadRing, MIP_RING_HYSTERESIS_CELLS, pastUnloadRing, type Focus } from './stream-ring';

const grid = chunkGrid(32);
const ring = DEFAULT_STREAM_RING;
const levelRings = { radii: [...DEFAULT_LEVEL_RINGS.radii], hysteresis: DEFAULT_LEVEL_RINGS.hysteresis };
const mipRadii = new Map([
  [1, ring.loadRadius],
  [2, ring.loadRadius],
]);
const bounds = collisionRingBounds({ radius: 96, height: 48 });

/** A small seeded generator (the test is the same every run). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Every ring decision the streamer makes about a box's chunks and the nodes over them, from a focus. */
function decisions(box: ChunkBox, f: Focus, previous: ReturnType<typeof chooseLevels>['drawn'] | null, collide: boolean): { key: string; drawn: ReturnType<typeof chooseLevels>['drawn'] } {
  const out: string[] = [];
  for (let cx = box.min[0]; cx <= box.max[0]; cx++) for (let cy = box.min[1]; cy <= box.max[1]; cy++) for (let cz = box.min[2]; cz <= box.max[2]; cz++) {
    out.push(`${inLoadRing(grid, ring, f, cx, cy, cz)}${pastUnloadRing(grid, ring, f, cx, cy, cz)}`);
    if (collide) out.push(`${chunkNearFoci(grid, [f], cx, cy, cz, bounds.radius, bounds.height)}${chunkNearFoci(grid, [f], cx, cy, cz, bounds.keepRadius, bounds.keepHeight)}`);
  }
  for (const l of [1, 2]) {
    for (let nx = box.min[0] >> l; nx <= box.max[0] >> l; nx++) for (let nz = box.min[2] >> l; nz <= box.max[2] >> l; nz++) {
      const d = levelNodeDistance(grid, [f], { level: l, nx, ny: 0, nz });
      out.push(`${d > mipRadii.get(l)!}${d > mipRadii.get(l)! + MIP_RING_HYSTERESIS_CELLS}`);
    }
  }
  const roots: LevelNode[] = [];
  for (let nx = box.min[0] >> 2; nx <= box.max[0] >> 2; nx++) for (let ny = box.min[1] >> 2; ny <= box.max[1] >> 2; ny++) for (let nz = box.min[2] >> 2; nz <= box.max[2] >> 2; nz++) roots.push({ level: 2, nx, ny, nz });
  const inBox = (l: number, x: number, y: number, z: number): boolean => x >= box.min[0] >> l && x <= box.max[0] >> l && y >= box.min[1] >> l && y <= box.max[1] >> l && z >= box.min[2] >> l && z <= box.max[2] >> l;
  const { drawn } = chooseLevels({ grid, maxLevel: 2, rings: levelRings, foci: [f], roots, ready: inBox, previous, extent: box });
  out.push([...drawn.nodes()].map((n) => `${n.level}:${n.nx},${n.ny},${n.nz}`).sort().join(' '));
  return { key: out.join('|'), drawn };
}

describe('how far a grid\'s focus may move before its plan could change', () => {
  it('moves no ring decision about its chunks or their nodes for any move shorter than it, and one longer can', () => {
    const rnd = random(47);
    let crossed = 0;
    let near = 0;
    let tested = 0;
    for (let i = 0; i < 400; i++) {
      // A house of one to two chunks a side, somewhere within the unload ring of the focus.
      const c = [Math.floor(rnd() * 24) - 12, Math.floor(rnd() * 4) - 2, Math.floor(rnd() * 24) - 12];
      const box: ChunkBox = { min: [c[0]!, c[1]!, c[2]!], max: [c[0]! + Math.floor(rnd() * 2), c[1]! + 1, c[2]! + Math.floor(rnd() * 2)] };
      const f: Focus = { x: (rnd() - 0.5) * 300, y: (rnd() - 0.5) * 60, z: (rnd() - 0.5) * 300 };
      const collide = rnd() < 0.5;
      const reach = quietReach({ grid, extent: box, focus: f, lead: f, ring, levelRings, maxLevel: 2, mipRadii, ...(collide ? { collision: bounds } : {}) });
      expect(reach).toBeGreaterThanOrEqual(0);
      const first = decisions(box, f, null, collide);
      // The choice as the streamer would hold it: made once more from where it stands (its splits are the hysteresis).
      const at = decisions(box, f, decisions(box, f, first.drawn, collide).drawn, collide);
      for (let k = 0; k < 6; k++) {
        const a = rnd() * 2 * Math.PI;
        const e = rnd() * 2 - 1;
        const len = reach * 0.999 * rnd();
        const g: Focus = { x: f.x + Math.cos(a) * Math.sqrt(1 - e * e) * len, y: f.y + e * len, z: f.z + Math.sin(a) * Math.sqrt(1 - e * e) * len };
        expect(decisions(box, g, at.drawn, collide).key).toBe(at.key);
        tested++;
      }
      // Past the reach, along the way that closes the nearest gap fastest, something changes in some of the cases.
      if (reach < 40) {
        near++;
        for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]] as const) {
          const g: Focus = { x: f.x + d[0] * (reach + 1.01), y: f.y + d[1] * (reach + 1.01), z: f.z + d[2] * (reach + 1.01) };
          if (decisions(box, g, at.drawn, collide).key !== at.key) {
            crossed++;
            break;
          }
        }
      }
    }
    expect(tested).toBe(2400);
    // The reach is not a loose bound: a cell past it along an axis a decision moves in a good share of the cases (each
    // ring is compared both with and without its hysteresis, and only one of the two binds in a given state; the
    // nearest gap may also close fastest off the axes).
    expect(near).toBeGreaterThan(100);
    expect(crossed).toBeGreaterThan(near / 5);
  });

  it('compares the levels and the bodies for the chunks that hold cells, the loads for the whole box', () => {
    const box: ChunkBox = { min: [-2, -2, -2], max: [3, 3, 3] };
    const held: ChunkBox = { min: [0, 0, 0], max: [1, 1, 1] };
    // 60 m from the held chunks' near side, along x: the level-0 ring's edge (64 m) is 4 m on for their level-1 node.
    const f: Focus = { x: -120, y: 10, z: 16 };
    const inner = quietReach({ grid, extent: box, held, focus: f, lead: f, ring, levelRings, maxLevel: 2, mipRadii });
    expect(inner).toBeCloseTo(8, 5);
    // Along the way out the air's nodes meet their rings where the held chunks' do not.
    let wider = 0;
    for (let x = -100; x > -500; x -= 7) {
      const g: Focus = { x, y: 10, z: 16 };
      const whole = quietReach({ grid, extent: box, focus: g, lead: g, ring, levelRings, maxLevel: 2, mipRadii });
      const held1 = quietReach({ grid, extent: box, held, focus: g, lead: g, ring, levelRings, maxLevel: 2, mipRadii });
      expect(held1).toBeGreaterThanOrEqual(whole);
      if (held1 > whole + 1) wider++;
    }
    expect(wider).toBeGreaterThan(10);
    // The lead point's length is taken off the loads' gaps only.
    const lead = { x: f.x + 4, y: f.y, z: f.z };
    expect(quietReach({ grid, extent: box, held, focus: f, lead, ring, levelRings, maxLevel: 2, mipRadii })).toBeCloseTo(inner, 5);
    const nearLoad: Focus = { x: -ring.loadRadius - 2 * 32 - 6, y: 10, z: 16 };
    const atLoad = quietReach({ grid, extent: box, held, focus: nearLoad, lead: nearLoad, ring, levelRings, maxLevel: 2, mipRadii });
    expect(quietReach({ grid, extent: box, held, focus: nearLoad, lead: { x: nearLoad.x + 3, y: 10, z: 16 }, ring, levelRings, maxLevel: 2, mipRadii })).toBeCloseTo(Math.max(0, atLoad - 3), 5);
  });
});

describe('the level choice over a structure grid\'s read box', () => {
  it('chooses what it chose without the box, and covers no node past it (only the 2 : 1 check looks there)', () => {
    const box: ChunkBox = { min: [5, -1, 6], max: [8, 2, 9] };
    const ready = (l: number, x: number, y: number, z: number): boolean => x >= box.min[0] >> l && x <= box.max[0] >> l && y >= box.min[1] >> l && y <= box.max[1] >> l && z >= box.min[2] >> l && z <= box.max[2] >> l && (l === 0 || (x + z) % 3 !== 0);
    const roots: LevelNode[] = [];
    for (let nx = box.min[0] >> 2; nx <= box.max[0] >> 2; nx++) for (let ny = box.min[1] >> 2; ny <= box.max[1] >> 2; ny++) for (let nz = box.min[2] >> 2; nz <= box.max[2] >> 2; nz++) roots.push({ level: 2, nx, ny, nz });
    for (const fx of [0, 120, 200, 260, 330, 400, 520]) {
      const f = { x: fx, y: 0, z: 200 };
      const asked = [0, 0];
      const askedPast = [0, 0];
      const counted = (k: number) => (l: number, x: number, y: number, z: number): boolean => {
        asked[k]!++;
        if (!(x >= box.min[0] >> l && x <= box.max[0] >> l && y >= box.min[1] >> l && y <= box.max[1] >> l && z >= box.min[2] >> l && z <= box.max[2] >> l)) askedPast[k]!++;
        return ready(l, x, y, z);
      };
      const a = chooseLevels({ grid, maxLevel: 2, rings: levelRings, foci: [f], roots, ready: counted(0), previous: null });
      const b = chooseLevels({ grid, maxLevel: 2, rings: levelRings, foci: [f], roots, ready: counted(1), previous: null, extent: box });
      const list = (d: typeof a.drawn): string => [...d.nodes()].map((n) => `${n.level}:${n.nx},${n.ny},${n.nz}`).sort().join(' ');
      expect(list(b.drawn)).toBe(list(a.drawn));
      expect(list(b.drawn).length).toBeGreaterThan(0);
      expect(b.stats.unbalanced).toBe(a.stats.unbalanced);
      expect(asked[1]).toBeGreaterThan(0);
      expect(askedPast[1]).toBeLessThan(askedPast[0]! / 4);
    }
  });
});
