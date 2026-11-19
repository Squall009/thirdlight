import { describe, expect, it } from 'vitest';
import { chunkGrid } from './coords';
import { LIGHT_STOP_COVERAGE } from './occupancy-walk';
import { PropLightChannel } from './prop-channel';
import { propCoverageChunk, propCoverageLocal, type PropShape } from './prop-coverage';
import type { DeriveOutput } from './stream-job';
import { packWalkBlock, walkPageOffsets, WALK_BRICK_WORDS, WALK_CELL_WORDS } from './walk-pages';
import { streamerWalkSource, type WalkStreamerView } from './walk-sources';

const grid = chunkGrid(32);
const CELL_M = 0.5;

/** A fixed sequence in [0, 1) (the same props every run). */
const seq = (i: number, k: number): number => (0.5 + i * [0.819172513, 0.671043607, 0.549700478, 0.7548776662, 0.5698402910, 0.6180339887][k]!) % 1;

/** Prop i: a turned, scaled box, sphere or capsule round the origin's chunk corners (negative cells too), across chunk faces. */
function prop(i: number, dx = 0): PropShape {
  const at: [number, number, number] = [-20 + 40 * seq(i, 0) + dx, -6 + 12 * seq(i, 1), -20 + 40 * seq(i, 2)];
  const turn = seq(i, 3) * Math.PI * 2;
  const scale = 0.6 + seq(i, 4) * 1.4;
  const yaw = [Math.cos(turn), Math.sin(turn)] as const;
  const kind = i % 3;
  if (kind === 0) {
    const [hx, hy, hz] = [0.3 + 1.5 * seq(i, 5), 0.2 + seq(i, 1), 0.3 + seq(i, 0)];
    return { inside: (x, y, z) => Math.abs(x) <= hx && Math.abs(y) <= hy && Math.abs(z) <= hz, min: [-hx, -hy, -hz], max: [hx, hy, hz], position: at, yaw, scale };
  }
  if (kind === 1) {
    const r = 0.4 + 2 * seq(i, 5);
    return { inside: (x, y, z) => x * x + y * y + z * z <= r * r, min: [-r, -r, -r], max: [r, r, r], position: at, yaw, scale };
  }
  const r = 0.3 + 0.4 * seq(i, 5);
  const h = 0.5 + seq(i, 2);
  return { inside: (x, y, z) => x * x + z * z + Math.max(0, Math.abs(y) - h) ** 2 <= r * r, min: [-r, -h - r, -r], max: [r, h + r, r], position: at, yaw, scale };
}

/** Chunks −2 … 1 on every axis (16 m chunks: the props' place spans them). */
const RESIDENT: [number, number, number][] = [];
for (let cx = -2; cx <= 1; cx++) for (let cy = -1; cy <= 0; cy++) for (let cz = -2; cz <= 1; cz++) RESIDENT.push([cx, cy, cz]);

function loadedChannel(): PropLightChannel {
  const ch = new PropLightChannel({ grid, setPart: () => true }, CELL_M);
  for (const [cx, cy, cz] of RESIDENT) ch.loaded(cx, cy, cz);
  return ch;
}

/** Every resident chunk's bytes against the whole-chunk sampling of the same props in the same order: cells that differ. */
function differFromSampling(ch: PropLightChannel, props: readonly PropShape[]): number {
  let differ = 0;
  for (const [cx, cy, cz] of RESIDENT) {
    const want = propCoverageChunk(grid, cx, cy, cz, props, CELL_M);
    const got = ch.chunk(cx, cy, cz);
    for (let i = 0; i < grid.cellsPerChunk; i++) if ((got?.[i] ?? 0) !== (want?.[i] ?? 0)) differ++;
  }
  return differ;
}

describe('the prop lighting channel: each prop sampled once into its own cells, combined per chunk', () => {
  it('combined from 60 props sampled alone equals the whole-chunk sampling cell for cell (turned, scaled, across chunk faces, negative cells)', () => {
    const props = Array.from({ length: 60 }, (_, i) => prop(i));
    const ch = loadedChannel();
    ch.apply(props.map((p, i) => [`p${i}`, p] as const));
    ch.flush();
    let covered = 0;
    let negative = 0;
    for (const [cx, cy, cz] of RESIDENT) {
      const c = ch.chunk(cx, cy, cz);
      if (c == null) continue;
      for (const v of c) if (v !== 0) covered++;
      if (cx < 0 || cy < 0 || cz < 0) negative++;
    }
    expect(covered).toBeGreaterThan(5000);
    expect(negative).toBeGreaterThan(4);
    expect(differFromSampling(ch, props)).toBe(0);
    // A prop's own coverage: its bytes are the sampling's where it alone stands.
    const one = propCoverageLocal(props[1]!, CELL_M);
    expect(one.cells).toBeGreaterThan(0);
  });

  it('a move changes exactly the cells the prop left and entered', () => {
    const props = Array.from({ length: 40 }, (_, i) => prop(i));
    const ch = loadedChannel();
    ch.apply(props.map((p, i) => [`p${i}`, p] as const));
    ch.flush();
    const snap = (): Map<string, Uint8Array> => new Map(RESIDENT.map(([cx, cy, cz]) => [`${cx},${cy},${cz}`, ch.chunk(cx, cy, cz)?.slice() ?? new Uint8Array(grid.cellsPerChunk)]));
    for (const i of [3, 7, 11, 20]) {
      const before = snap();
      const was = propCoverageLocal(props[i]!, CELL_M);
      props[i] = prop(i, 0.75);
      const now = propCoverageLocal(props[i]!, CELL_M);
      ch.place(`p${i}`, props[i]!);
      const after = snap();
      // The cells either coverage holds, in world cells.
      const reach = new Set<string>();
      for (const c of [was, now]) for (let x = 0; x < c.size[0]; x++) for (let z = 0; z < c.size[2]; z++) for (let y = 0; y < c.size[1]; y++) if (c.bytes[(x * c.size[2] + z) * c.size[1] + y]! !== 0) reach.add(`${c.lo[0] + x},${c.lo[1] + y},${c.lo[2] + z}`);
      let changed = 0;
      for (const [key, b] of before) {
        const [cx, cy, cz] = key.split(',').map(Number) as [number, number, number];
        const a = after.get(key)!;
        for (let k = 0; k < b.length; k++) {
          if (a[k] === b[k]) continue;
          changed++;
          const x = (cx << 5) + (k >> 10);
          const z = (cz << 5) + ((k >> 5) & 31);
          const y = (cy << 5) + (k & 31);
          expect(reach.has(`${x},${y},${z}`)).toBe(true);
        }
      }
      expect(changed).toBeGreaterThan(0);
      expect(differFromSampling(ch, props)).toBe(0);
    }
  });

  it('a scene of props arriving in one step is stamped over steps of the slice, ending where stamping all at once ends', () => {
    const props = Array.from({ length: 80 }, (_, i) => prop(i));
    const sliced = loadedChannel();
    sliced.apply(props.map((p, i) => [`p${i}`, p] as const));
    // A stepping clock: each stamp costs one tick, a step's slice is 3 ticks.
    let steps = 0;
    while (sliced.pending) {
      let clock = 0;
      sliced.update(() => ++clock <= 3);
      steps++;
      expect(clock).toBeLessThanOrEqual(4);
    }
    expect(steps).toBeGreaterThanOrEqual(Math.ceil(80 / 4));
    const whole = loadedChannel();
    whole.apply(props.map((p, i) => [`p${i}`, p] as const));
    whole.flush();
    for (const [cx, cy, cz] of RESIDENT) expect(sliced.chunk(cx, cy, cz)).toEqual(whole.chunk(cx, cy, cz));
    expect(differFromSampling(sliced, props)).toBe(0);
  });

  it("the walk's light stop holds the props' cells: a block of air packs light bits where the props cover half a cell or more", () => {
    const ch = loadedChannel();
    const crate: PropShape = { inside: (x, y, z) => Math.abs(x) <= 1.3 && Math.abs(y) <= 0.9 && Math.abs(z) <= 0.7, min: [-1.3, -0.9, -0.7], max: [1.3, 0.9, 0.7], position: [4.1, 1.3, 5.2], yaw: [Math.cos(0.52), Math.sin(0.52)], scale: 1 };
    ch.place('crate', crate);
    let stopping = 0;
    const c = ch.chunk(0, 0, 0)!;
    for (const v of c) if (v >= LIGHT_STOP_COVERAGE) stopping++;
    expect(stopping).toBeGreaterThan(50);
    // A streamer whose sections are all air (derived, nothing drawn).
    const air = { solid: 0, exposed: 0, mask: null, hash: 0, assembly: null, shader: null } as DeriveOutput;
    const view: WalkStreamerView = { sections: { shift: 4 }, grid: { shift: 5, edge: 32 }, derivedOf: () => air, mips: null, isResident: () => true, voxelAt: () => null };
    const count = (props: PropLightChannel | null): number => {
      const packed = packWalkBlock(streamerWalkSource(view, null, { mips: false, props }), 0, 0, 0, 0);
      if (packed?.page == null) return 0;
      const off = walkPageOffsets('light');
      let bits = 0;
      for (let w = off.cells; w < off.cells + WALK_CELL_WORDS; w++) for (let v = packed.page[w]!; v !== 0; v &= v - 1) bits++;
      let bricks = 0;
      for (let w = off.bricks; w < off.bricks + WALK_BRICK_WORDS; w++) if (packed.page[w] !== 0) bricks++;
      expect(bricks).toBeGreaterThan(0);
      // The solid stop is the voxels' alone.
      const solid = walkPageOffsets('solid');
      for (let w = solid.cells; w < solid.cells + WALK_CELL_WORDS; w++) expect(packed.page[w]).toBe(0);
      return bits;
    };
    expect(count(ch)).toBe(stopping);
    expect(count(null)).toBe(0);
  });
});
