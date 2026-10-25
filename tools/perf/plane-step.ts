/**
 * The physics-only step benchmark of a side-scrolling level (a child process
 * started with `--expose-gc`, see plane-step-run.ts). It builds one generic
 * side-scroller layout straight on a physics port — block-chunk floors (one
 * compound collider per 16 m chunk), floating platforms, pillar polygons,
 * moving platforms, a one-way ledge — and drives one character through it
 * (run, turn at the level's ends, jump every 1.5 s) with a few script-style
 * queries per step (rays down from enemies, two box overlaps).
 *
 * `dim: 2` runs it on the 2D backend; `dim: 3` runs the same layout on the 3D
 * backend as the plane would: every shape given a depth (box hz, polygons as
 * convex prisms), the character never moving along z. Comparing the two is
 * what "a 2D-style scene on the one 3D backend" costs in physics alone; the
 * full runtime's step (scripts, triggers, transforms) is sim.ts.
 *
 * Input: env TL_PLANE = JSON { dim, levels, warmup, steps, seed }.
 * Output: one JSON line on stdout.
 */
import v8 from 'node:v8';
import { performance } from 'node:perf_hooks';

import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { createPhysicsPort3D } from '@thirdlight/physics-rapier/3d';
import { playerCapsuleOf, playerPhysicsOf } from '@thirdlight/runtime';

import { prng } from './generate';

type Any = any;

interface PlaneInput {
  dim: 2 | 3;
  /** Levels laid end to end, all loaded (one is a level as a game streams it). */
  levels: number;
  warmup: number;
  steps: number;
  seed: number;
}

/** One level's length along x (m), in block chunks of CHUNK_M. */
const LEVEL_M = 208;
const CHUNK_M = 16;
/** The depth a 2D shape gets on the 3D backend (m): the plan's default collider depth. */
const DEPTH_M = 1;
const HZ = 120;
const GRAVITY_Y = -19.62;
const RUN_SPEED = 6.75;
const JUMP_VELOCITY = 9.9;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

interface Box {
  x: number;
  y: number;
  hx: number;
  hy: number;
}

interface Layout {
  /** Per chunk: the floor and its raised block runs (one compound collider). */
  chunks: { x: number; parts: Box[] }[];
  platforms: Box[];
  /** Pillars (gates): authored as polygons in 2D. */
  pillars: Box[];
  oneWay: Box[];
  movers: (Box & { axis: 'x' | 'y'; range: number; period: number })[];
  enemies: { x: number; y: number }[];
  length: number;
}

function layoutOf(levels: number, seed: number): Layout {
  const rnd = prng(seed);
  const L: Layout = { chunks: [], platforms: [], pillars: [], oneWay: [], movers: [], enemies: [], length: LEVEL_M * levels };
  for (let lv = 0; lv < levels; lv += 1) {
    const x0 = lv * LEVEL_M;
    for (let c = 0; c < LEVEL_M / CHUNK_M; c += 1) {
      const cx = x0 + c * CHUNK_M;
      const parts: Box[] = [{ x: CHUNK_M / 2, y: -1, hx: CHUNK_M / 2, hy: 1 }];
      // Raised runs of 1 m blocks: a step the character jumps or autosteps.
      for (let r = 0; r < 3; r += 1) {
        const w = 1 + Math.floor(rnd() * 3);
        const h = rnd() < 0.7 ? 0.5 : 1;
        parts.push({ x: 2 + r * 5 + w / 2, y: h / 2, hx: w / 2, hy: h / 2 });
      }
      L.chunks.push({ x: cx, parts });
    }
    for (let i = 0; i < 30; i += 1) L.platforms.push({ x: x0 + 4 + rnd() * (LEVEL_M - 8), y: 2.5 + rnd() * 3, hx: 0.5 + rnd(), hy: 0.25 });
    for (let i = 0; i < 4; i += 1) L.pillars.push({ x: x0 + 30 + i * 45 + rnd() * 5, y: 1.5 + 4, hx: 0.25, hy: 1.5 });
    L.oneWay.push({ x: x0 + 100, y: 3, hx: 1, hy: 0.07 });
    for (let i = 0; i < 6; i += 1) L.movers.push({ x: x0 + 15 + i * 33, y: 3 + rnd() * 2, hx: 1, hy: 0.5, axis: i % 2 === 0 ? 'x' : 'y', range: 2 + rnd() * 2, period: 2 + rnd() * 2 });
    for (let i = 0; i < 10; i += 1) L.enemies.push({ x: x0 + 8 + rnd() * (LEVEL_M - 16), y: 1 });
  }
  return L;
}

const rect = (b: Box): [number, number][] => [[-b.hx, -b.hy], [b.hx, -b.hy], [b.hx, b.hy], [-b.hx, b.hy]];
/** A polygon's convex prism on the 3D backend (its outline at ±depth/2). */
const prism = (b: Box): number[] => rect(b).flatMap(([x, y]) => [x, y, -DEPTH_M / 2, x, y, DEPTH_M / 2]);

function moverAt(m: Layout['movers'][number], t: number): { x: number; y: number } {
  const o = Math.sin((2 * Math.PI * t) / m.period) * m.range;
  return m.axis === 'x' ? { x: m.x + o, y: m.y } : { x: m.x, y: m.y + o };
}

async function portOf(input: PlaneInput, L: Layout): Promise<Any> {
  const capsule = playerCapsuleOf(undefined);
  const tuning = playerPhysicsOf(undefined);
  const controller = { offsetSkin: tuning.offsetSkin, groundSnap: tuning.groundSnap, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: tuning.autostep, ...(tuning.autostep ? { autostepHeight: tuning.autostepHeight } : {}) };
  const solver = { hz: HZ, gravityY: GRAVITY_Y };
  if (input.dim === 2) {
    const statics: Any[] = [];
    for (const c of L.chunks) statics.push({ entityId: `chunk-${c.x}`, shape: { type: 'compound', parts: c.parts.map((p) => ({ shape: { type: 'box', hx: p.hx, hy: p.hy }, x: p.x, y: p.y, angle: 0 })) }, position: { x: c.x, y: 0 }, rotationZ: 0 });
    L.platforms.forEach((b, i) => statics.push({ entityId: `plat-${i}`, shape: { type: 'box', hx: b.hx, hy: b.hy }, position: { x: b.x, y: b.y }, rotationZ: 0 }));
    L.pillars.forEach((b, i) => statics.push({ entityId: `pillar-${i}`, shape: { type: 'polygon', vertices: rect(b) }, position: { x: b.x, y: b.y }, rotationZ: 0 }));
    L.oneWay.forEach((b, i) => statics.push({ entityId: `oneway-${i}`, shape: { type: 'box', hx: b.hx, hy: b.hy }, position: { x: b.x, y: b.y }, rotationZ: 0, oneWay: true }));
    L.movers.forEach((m, i) => statics.push({ entityId: `mover-${i}`, shape: { type: 'polygon', vertices: rect(m) }, position: { x: m.x, y: m.y }, rotationZ: 0, kinematic: true }));
    return createPhysicsPort({ character: { x: 2, y: 1, radius: capsule.radius, halfHeight: capsule.halfHeight, offset: { x: capsule.offset.x, y: capsule.offset.y } }, statics, solver, controller } as Any);
  }
  const at = (x: number, y: number): Any => ({ x, y, z: 0 });
  const statics: Any[] = [];
  for (const c of L.chunks) statics.push({ entityId: `chunk-${c.x}`, shape: { type: 'compound', parts: c.parts.map((p) => ({ shape: { type: 'box', hx: p.hx, hy: p.hy, hz: DEPTH_M / 2 }, position: at(p.x, p.y), rotation: IDENTITY })) }, position: at(c.x, 0), rotation: IDENTITY });
  L.platforms.forEach((b, i) => statics.push({ entityId: `plat-${i}`, shape: { type: 'box', hx: b.hx, hy: b.hy, hz: DEPTH_M / 2 }, position: at(b.x, b.y), rotation: IDENTITY }));
  L.pillars.forEach((b, i) => statics.push({ entityId: `pillar-${i}`, shape: { type: 'convex', points: prism(b) }, position: at(b.x, b.y), rotation: IDENTITY }));
  // No one-way filter on the 3D port yet: the ledge is a plain thin box (its cost, not its behaviour).
  L.oneWay.forEach((b, i) => statics.push({ entityId: `oneway-${i}`, shape: { type: 'box', hx: b.hx, hy: b.hy, hz: DEPTH_M / 2 }, position: at(b.x, b.y), rotation: IDENTITY }));
  L.movers.forEach((m, i) => statics.push({ entityId: `mover-${i}`, shape: { type: 'convex', points: prism(m) }, position: at(m.x, m.y), rotation: IDENTITY, kinematic: true }));
  return createPhysicsPort3D({ dimension: 3, character: { position: at(2, 1), radius: capsule.radius, halfHeight: capsule.halfHeight, offset: { x: capsule.offset.x, y: capsule.offset.y, z: 0 } }, statics, solver, controller } as Any);
}

const MiB = (b: number): number => Math.round((b / 1048576) * 100) / 100;
const round = (v: number): number => Math.round(v * 10000) / 10000;

function mem(): { rssMiB: number; heapUsedMiB: number; externalMiB: number; arrayBuffersMiB: number } {
  const m = process.memoryUsage();
  return { rssMiB: MiB(m.rss), heapUsedMiB: MiB(m.heapUsed), externalMiB: MiB(m.external), arrayBuffersMiB: MiB(m.arrayBuffers) };
}

async function run(input: PlaneInput): Promise<Record<string, unknown>> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('run with --expose-gc');
  gc();
  const before = mem();
  const L = layoutOf(input.levels, input.seed);
  const t0 = performance.now();
  const made = await portOf(input, L);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const port = made.port;
  const initMs = performance.now() - t0;
  gc();
  const afterInit = mem();

  const dt = 1 / HZ;
  const jumpEvery = Math.round(HZ * 1.5);
  let dir = 1;
  let vy = 0;
  let x = 2;
  let t = 0;
  let step = 0;
  const poses2: Any[] = L.movers.map((_, i) => ({ entityId: `mover-${i}`, position: { x: 0, y: 0 }, rotationZ: 0 }));
  const poses3: Any[] = L.movers.map((_, i) => ({ entityId: `mover-${i}`, position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY }));
  const delta2 = { x: 0, y: 0 };
  const delta3 = { x: 0, y: 0, z: 0 };
  const down2 = { x: 0, y: -1 };
  const down3 = { x: 0, y: -1, z: 0 };
  const box2 = { type: 'box', hx: 0.5, hy: 0.5 };
  const box3 = { type: 'box', hx: 0.5, hy: 0.5, hz: DEPTH_M / 2 };
  const one = (): void => {
    t += dt;
    step += 1;
    for (let i = 0; i < L.movers.length; i += 1) {
      const p = moverAt(L.movers[i]!, t);
      const pose = input.dim === 2 ? poses2[i] : poses3[i];
      pose.position.x = p.x;
      pose.position.y = p.y;
    }
    if (input.dim === 2) port.setKinematicPositions(poses2);
    else port.setKinematicPoses(poses3);
    if (x > L.length - 4) dir = -1;
    else if (x < 4) dir = 1;
    if (step % jumpEvery === 0) vy = JUMP_VELOCITY;
    vy = Math.max(vy + GRAVITY_Y * dt, -24);
    const d = input.dim === 2 ? delta2 : delta3;
    d.x = dir * RUN_SPEED * dt;
    d.y = vy * dt;
    port.stageCharacterMove(d);
    const r = port.step();
    x = r.position.x;
    if (r.grounded && vy < 0) vy = 0;
    if (r.position.y < -20) {
      if (input.dim === 2) port.reset({ x: 2, y: 1 });
      else port.placeCharacter({ x: 2, y: 1, z: 0 });
      x = 2;
      vy = 0;
    }
    // Script-style queries: each enemy's ground ray, two hitbox overlaps.
    for (const e of L.enemies) {
      if (Math.abs(e.x - x) > 40) continue;
      if (input.dim === 2) port.raycast({ x: e.x, y: e.y }, down2, 4);
      else port.raycast({ x: e.x, y: e.y, z: 0 }, down3, 4);
    }
    for (let k = 0; k < 2; k += 1) {
      if (input.dim === 2) port.overlap(box2, { x: x + k, y: 1 });
      else port.overlap(box3, { x: x + k, y: 1, z: 0 });
    }
  };

  for (let i = 0; i < input.warmup; i += 1) one();
  // Allocation: median heap growth per step over windows without a collection in them.
  const perStep: number[] = [];
  for (let w = 0; w < 12; w += 1) {
    gc();
    const h0 = v8.getHeapStatistics().used_heap_size;
    for (let i = 0; i < 120; i += 1) one();
    const h1 = v8.getHeapStatistics().used_heap_size;
    if (h1 >= h0) perStep.push((h1 - h0) / 120);
  }
  perStep.sort((a, b) => a - b);
  const times = new Float64Array(input.steps);
  for (let i = 0; i < input.steps; i += 1) {
    const a = performance.now();
    one();
    times[i] = performance.now() - a;
  }
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  times.sort();
  const pct = (q: number): number => round(times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)]!);
  gc();
  const afterRun = mem();
  const diag = port.diagnostics();
  port.dispose();
  return {
    ok: true,
    dim: input.dim,
    levels: input.levels,
    implementation: diag.implementation,
    colliders: diag.worldColliderCount,
    bodies: diag.worldBodyCount,
    initMs: round(initMs),
    stepMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: round(times[times.length - 1]!), mean: round(mean) },
    steps: input.steps,
    bytesPerStep: Math.round(perStep[Math.floor(perStep.length / 2)] ?? -1),
    memory: { before, afterInit, afterRun },
    endX: round(x),
  };
}

if (process.env['TL_PLANE'] !== undefined) {
  run(JSON.parse(process.env['TL_PLANE']) as PlaneInput)
    .then((r) => {
      process.stdout.write(`${JSON.stringify(r)}\n`);
      process.exit(0);
    })
    .catch((e: Error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(e.stack ?? e) })}\n`);
      process.exit(1);
    });
}
