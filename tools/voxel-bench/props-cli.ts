/**
 * The prop lighting channel's stamping cost (`node tools/voxel-bench/run.mjs props …`), in Node, on the simulation's
 * own code (`PropLightChannel`): a ring of resident chunks the size of the slice world's (22 × 14 × 22 = 6,776 chunks
 * of 16 m), lit props scattered over its ground by a fixed sequence (half canopies, spheres of 3 m radius 6 m up; half
 * rocks, 2.6 × 1.8 × 1.4 m boxes turned, on the ground), and three readings:
 *
 * - **one move** of a 3 m canopy alone, moved 0.25 m at a time across chunk faces (`--moves` times): ms a move, p50
 *   and p95, its stamping done (every step of it, when the channel spreads its work over steps);
 * - **one move among N** lit props (`--counts`, default 100, 400, 1600): a random prop of the N moved 0.25 m, the same;
 * - **N arriving in one step** into the loaded ring: each step's ms with the channel's work spread over steps in the
 *   simulation's slice (`--slice-ms`, default the voxel derive slice's 2 ms), the steps it took and their sum.
 *
 * A channel that does all its work in the call that hands it the change (it has no `update`) is timed in that call.
 *
 *   --counts LIST (100,400,1600)  --moves N (200)  --slice-ms MS (2)  --out FILE (~/.cache/thirdlight-voxel-bench/props/<time>.json)
 *
 * Not part of `npm test`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, uptime } from 'node:os';
import { dirname } from 'node:path';
import { chunkGrid, PropLightChannel, type PropShape } from '@thirdlight/voxel';
import { benchDir } from './bench-dirs';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const COUNTS = (opt('counts') ?? '100,400,1600').split(',').map(Number);
const MOVES = Number(opt('moves') ?? 200);
const SLICE_MS = Number(opt('slice-ms') ?? 2);
const OUT = opt('out') ?? `${benchDir('props', new Date().toISOString().slice(0, 16).replace(/[:T]/g, ''))}.json`;
const grid = chunkGrid(32);
const CELL_M = 0.5;
const CHUNK_M = 16;
/** The ring: chunks −11 … 10 across, −4 … 9 up (6,776). */
const RING = { lo: [-11, -4, -11], hi: [10, 9, 10] } as const;

/** What the channel may offer beyond the calls every version has: work spread over steps. */
interface Stepped {
  update?(more: () => boolean): void;
  readonly pending?: boolean;
}

function channel(): PropLightChannel & Stepped {
  const ch = new PropLightChannel({ grid, setPart: () => true }, CELL_M) as PropLightChannel & Stepped;
  for (let cx = RING.lo[0]; cx <= RING.hi[0]; cx++) for (let cy = RING.lo[1]; cy <= RING.hi[1]; cy++) for (let cz = RING.lo[2]; cz <= RING.hi[2]; cz++) ch.loaded(cx, cy, cz);
  return ch;
}

const canopy = (at: readonly [number, number, number]): PropShape => ({ inside: (x, y, z) => x * x + y * y + z * z <= 9, min: [-3, -3, -3], max: [3, 3, 3], position: at, yaw: [1, 0], scale: 1 });
const rock = (at: readonly [number, number, number], turn: number): PropShape => ({ inside: (x, y, z) => Math.abs(x) <= 1.3 && Math.abs(y) <= 0.9 && Math.abs(z) <= 0.7, min: [-1.3, -0.9, -0.7], max: [1.3, 0.9, 0.7], position: at, yaw: [Math.cos(turn), Math.sin(turn)], scale: 1 });

/** Prop i of the scatter: an even sequence over the ring's ground (the same places every run). */
function scatter(i: number, dx = 0): PropShape {
  const span = (RING.hi[0] - RING.lo[0] + 1) * CHUNK_M - 8;
  const x = RING.lo[0] * CHUNK_M + 4 + ((0.5 + i * 0.819172513) % 1) * span + dx;
  const z = RING.lo[2] * CHUNK_M + 4 + ((0.5 + i * 0.671043607) % 1) * span;
  return i % 2 === 0 ? canopy([x, 6.1, z]) : rock([x, 1.0, z], ((0.5 + i * 0.549700478) % 1) * Math.PI);
}

/** Hands the channel its changes and does the work: each step's ms (one step when the channel does it in the call). */
function run(ch: PropLightChannel & Stepped, changes: (readonly [string, PropShape | null])[]): number[] {
  const steps: number[] = [];
  let t0 = performance.now();
  ch.apply(changes);
  if (ch.update === undefined) return [performance.now() - t0];
  for (;;) {
    ch.update(() => performance.now() - t0 < SLICE_MS);
    steps.push(performance.now() - t0);
    if (ch.pending !== true) return steps;
    t0 = performance.now();
  }
}

const q = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return Number((s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0).toFixed(3));
};
/** A move's ms: the sum of its steps (the work it caused, wherever it ran). */
const moveStats = (moves: number[][]): Record<string, number> => {
  const totals = moves.map((m) => m.reduce((a, b) => a + b, 0));
  const worst = moves.map((m) => Math.max(...m));
  return { p50: q(totals, 50), p95: q(totals, 95), worstStepP95: q(worst, 95), stepsMax: Math.max(...moves.map((m) => m.length)) };
};

const started = new Date().toISOString();
const alone = channel();
run(alone, [['tree', canopy([8.3, 6.1, 8.2])]]);
const aloneMoves: number[][] = [];
for (let i = 0; i < MOVES; i++) aloneMoves.push(run(alone, [['tree', canopy([8.3 + 0.25 * (i % 40), 6.1, 8.2 + 0.25 * (i % 40)])]]));
console.log(`one move, a 3 m canopy alone: ${JSON.stringify(moveStats(aloneMoves))}`);

const among: Record<string, unknown> = {};
for (const n of COUNTS) {
  const ch = channel();
  const all = Array.from({ length: n }, (_, i) => [`p${i}`, scatter(i)] as const);
  const arrival = run(ch, all);
  const moves: number[][] = [];
  for (let k = 0; k < MOVES; k++) {
    const i = Math.floor(((0.5 + k * 0.7548776662) % 1) * n);
    moves.push(run(ch, [[`p${i}`, scatter(i, 0.25 * ((k % 8) + 1))]]));
  }
  const st = ch.stats();
  among[String(n)] = {
    arrival: { steps: arrival.length, totalMs: Number(arrival.reduce((a, b) => a + b, 0).toFixed(1)), worstStepMs: Number(Math.max(...arrival).toFixed(2)), p95StepMs: q(arrival, 95) },
    move: moveStats(moves),
    channel: st,
  };
  console.log(`${n} lit props: ${JSON.stringify(among[String(n)])}`);
}

const json = { started, node: process.version, host: { cpus: `${cpus().length} × ${cpus()[0]?.model ?? '?'}`, loadavg: loadavg(), uptimeH: Number((uptime() / 3600).toFixed(1)) }, ring: { chunks: (RING.hi[0] - RING.lo[0] + 1) * (RING.hi[1] - RING.lo[1] + 1) * (RING.hi[2] - RING.lo[2] + 1) }, sliceMs: SLICE_MS, moves: MOVES, alone: moveStats(aloneMoves), among };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(json, null, 1));
console.log(`written ${OUT}`);
