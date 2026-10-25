/**
 * The 2D collider shapes in their 3D form on the Rapier 3D backend, against
 * the 2D backend: the same authored colliders (a box without a depth, a
 * convex polygon, a concave outline, a one-way shelf) go through the
 * runtime's own spec builders to both ports, and a character locked to the
 * plane z = 0 on the 3D port runs the same moves (walk, jump, fall) as the
 * 2D character. Where it is matches the 2D port's within the tolerance below
 * at every step, and whenever both stand on something it is the same collider.
 * Through the production game host, a 3D project's player jumps up through a
 * one-way shelf authored as a 2D box (its depth the default), stands on it and
 * drops through it with down + jump.
 */
import { describe, expect, it } from 'vitest';

import { convexPieces } from '@thirdlight/project-model';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { createPhysicsPort3D } from '@thirdlight/physics-rapier/3d';
import { staticColliderOf, staticColliderOf3D, type PhysicsPort3D, type StaticColliderSpec, type StaticColliderSpec3D } from '@thirdlight/runtime';

import { runScene, sceneOf, STAND_Y } from './character-kit';

type Any = any;
const HZ = 120;
const G = -19.62;
/** Where the two ports may differ (m): Rapier's 2D and 3D sweeps settle a few millimetres apart on contact (measured: at most 6 mm). */
const TOLERANCE = 0.01;
const T = (position: number[]) => ({ transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
const FLOOR = { id: 'floor', components: { ...T([0, -0.5, 0]), collider: { shape: { type: 'box', hx: 30, hy: 0.5 } } } };
const CONTROLLER = { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false };
const VALLEY: [number, number][] = [[0, 0], [6, 0], [6, 2], [5, 2], [5, 1], [1, 1], [1, 2], [0, 2]];

/** The moves: walk right, a jump when grounded at or after `jumpAt` (and again 90 steps later), with 2D-style gravity. */
function moves(jumpAt: number, speed = 3): (i: number, grounded: boolean, vy: number) => { dx: number; vy: number } {
  const jumps = [jumpAt, jumpAt + 90];
  return (i, grounded, vy) => {
    const jump = grounded && jumps.length > 0 && i >= jumps[0]!;
    if (jump) jumps.shift();
    const next = grounded ? (jump ? 10 : 0) : Math.max(-30, vy + G / HZ);
    return { dx: speed / HZ, vy: next };
  };
}

interface Trace {
  x: number[];
  y: number[];
  ground: (string | null)[];
}

async function run2D(statics: StaticColliderSpec[], start: [number, number], steps: number, jumpAt: number, speed: number): Promise<Trace> {
  const made = await createPhysicsPort({ character: { x: start[0], y: start[1] }, statics, solver: { hz: HZ, gravityY: G }, controller: CONTROLLER } as Any);
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const port = made.port;
  const next = moves(jumpAt, speed);
  const out: Trace = { x: [], y: [], ground: [] };
  let vy = 0;
  let grounded = false;
  for (let i = 0; i < steps; i++) {
    const m = next(i, grounded, vy);
    vy = m.vy;
    port.stageCharacterMove({ x: m.dx, y: vy / HZ });
    const r = port.step();
    grounded = r.grounded && vy <= 0;
    out.x.push(r.position.x);
    out.y.push(r.position.y);
    out.ground.push(r.grounded ? (r.groundEntityId ?? null) : null);
  }
  port.dispose();
  return out;
}

async function run3D(statics: StaticColliderSpec3D[], start: [number, number], steps: number, jumpAt: number, speed: number): Promise<Trace & { z: number[] }> {
  const made = await createPhysicsPort3D({
    dimension: 3,
    character: { position: { x: start[0], y: start[1], z: 0 }, radius: 0.3, halfHeight: 0.6, offset: { x: 0, y: 0, z: 0 }, plane: { axis: 'z', origin: 0 } },
    statics,
    solver: { hz: HZ, gravityY: G },
    controller: CONTROLLER,
  });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const port: PhysicsPort3D = made.port;
  const next = moves(jumpAt, speed);
  const out = { x: [] as number[], y: [] as number[], z: [] as number[], ground: [] as (string | null)[] };
  let vy = 0;
  let grounded = false;
  for (let i = 0; i < steps; i++) {
    const m = next(i, grounded, vy);
    vy = m.vy;
    port.stageCharacterMove({ x: m.dx, y: vy / HZ, z: 0 });
    const r = port.step();
    grounded = r.grounded && vy <= 0;
    out.x.push(r.position.x);
    out.y.push(r.position.y);
    out.z.push(r.position.z);
    out.ground.push(r.grounded ? (r.groundEntityId ?? null) : null);
  }
  port.dispose();
  return out;
}

/** Both ports' traces from the same authored entities (`twoD`: what the 2D port gets where its form differs). */
async function compare(entities: Any[], twoD: Any[] = entities, start: [number, number] = [0, 0.91], steps = 480, jumpAt = 90, speed = 3): Promise<{ a: Trace; b: Trace & { z: number[] } }> {
  const specs2 = twoD.map((e) => staticColliderOf(e.id, e.components)).filter((s): s is StaticColliderSpec => s !== null);
  const specs3 = entities.map((e) => staticColliderOf3D(e.id, e.components)).filter((s): s is StaticColliderSpec3D => s !== null);
  const a = await run2D(specs2, start, steps, jumpAt, speed);
  const b = await run3D(specs3, start, steps, jumpAt, speed);
  if (process.env['TL_TRACE'] === '1') for (let i = 0; i < a.x.length; i += 10) console.log(i, a.x[i]!.toFixed(3), a.y[i]!.toFixed(3), a.ground[i], '|', b.x[i]!.toFixed(3), b.y[i]!.toFixed(3), b.ground[i]);
  return { a, b };
}

function expectMatch(a: Trace, b: Trace & { z: number[] }): void {
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < a.x.length; i++) {
    const d = Math.max(Math.abs(a.x[i]! - b.x[i]!), Math.abs(a.y[i]! - b.y[i]!));
    if (d > worst) [worst, worstAt] = [d, i];
  }
  expect(worst, `worst difference ${worst.toFixed(4)} m at step ${worstAt}`).toBeLessThanOrEqual(TOLERANCE);
  // Whenever both stand on something it is the same collider. Whether a step counts as grounded
  // differs at a ledge's edge and on the first step (the controllers' own rules, not the shapes').
  expect(a.ground.filter((g, i) => g !== null && b.ground[i] !== null && g !== b.ground[i])).toEqual([]);
  expect(a.ground.filter((g, i) => (g === null) !== (b.ground[i] === null)).length).toBeLessThanOrEqual(a.ground.length * 0.03);
  expect(b.z.every((z) => z === 0)).toBe(true);
}

describe('2D collider shapes on the 3D backend match the 2D backend for a plane-locked character', () => {
  it('a box without a depth: walks into a 1 m block, jumps onto it and off its far side', async () => {
    const block = { id: 'block', components: { ...T([3, 0.5, 0]), collider: { shape: { type: 'box', hx: 1, hy: 0.5 } } } };
    const { a, b } = await compare([FLOOR, block], undefined, [0, 0.91], 480, 120, 1.5);
    expect(a.ground).toContain('block');
    expectMatch(a, b);
  });

  it('a convex polygon: a ramp walked up and jumped off', async () => {
    const ramp = { id: 'ramp', components: { ...T([0, 0, 0]), collider: { shape: { type: 'polygon', vertices: [[0, 0], [5, 0], [5, 1]] } } } };
    const { a, b } = await compare([FLOOR, ramp], undefined, [-2, 0.91], 480, 400);
    expect(a.ground).toContain('ramp');
    expectMatch(a, b);
  });

  it('a concave outline (a valley) as convex prisms against the same pieces as 2D polygons', async () => {
    const pieces = convexPieces(VALLEY);
    expect(pieces.length).toBeGreaterThan(1);
    const outline = { id: 'valley', components: { ...T([1, 0, 0]), collider: { shape: { type: 'polygon', vertices: VALLEY } } } };
    const asPolygons = { id: 'valley', components: { ...T([1, 0, 0]), collider: { shape: { type: 'compound', shapes: pieces.map((vertices) => ({ type: 'polygon', vertices })) } } } };
    const { a, b } = await compare([FLOOR, outline], [FLOOR, asPolygons], [-1, 0.91], 600, 60);
    expect(a.ground).toContain('valley');
    expectMatch(a, b);
  });

  it('a one-way shelf: jumped up through and landed on, walked off its end', async () => {
    const shelf = { id: 'shelf', components: { ...T([2, 1.2, 0]), collider: { shape: { type: 'box', hx: 2, hy: 0.1 }, oneWay: true } } };
    const { a, b } = await compare([FLOOR, shelf], undefined, [-1.5, 0.91], 360, 20);
    expect(a.ground).toContain('shelf');
    expect(b.ground).toContain('shelf');
    expectMatch(a, b);
  });
});

describe('2D shapes and one-way colliders in a 3D project, through the game host', () => {
  it('jumps up through a one-way shelf (a box without a depth), stands on it, drops through with down + jump', async () => {
    const shelf = { id: 'shelf-0001', components: { ...T([0, 1, 0]), collider: { shape: { type: 'box', hx: 3, hy: 0.1 }, oneWay: true } } };
    const ramp = { id: 'ramp-0001', components: { ...T([4, 0, 0]), collider: { shape: { type: 'polygon', vertices: [[0, 0], [3, 0], [3, 0.5]] }, depth: 2 } } };
    const scene = sceneOf({}, [0, STAND_Y, 0], [shelf, ramp], 'oneway3d');
    const replay = Array.from({ length: 720 }, (_, s) => ({
      stepIndex: s,
      moveX: s >= 330 ? 1 : 0,
      moveY: 0,
      jump: s === 30 || s === 200 ? 'pressed' : (s > 30 && s < 90) || (s > 200 && s < 210) ? 'held' : s === 90 || s === 210 ? 'released' : 'none',
      actions: s >= 190 && s < 210 ? { navigate: { v: 1, x: 0, y: -1, p: 'held' } } : {},
    }));
    const r = await runScene('single', scene, replay as Any, 700);
    expect(r.errors).toEqual([]);
    // (The path starts after the runtime's settle pre-roll, a few steps before the recording's step 0.)
    const at = (i: number) => r.path[i]!;
    // Up through the shelf (its underside at 0.9 never stops the head) and standing on its top (1.1).
    expect(Math.max(...r.path.slice(0, 100).map((p) => p[1]!))).toBeGreaterThan(1.1 + STAND_Y);
    expect(at(150)[1]).toBeCloseTo(1.1 + STAND_Y, 2);
    expect(at(150)[3]).toBe(1);
    // Down + jump: back on the floor.
    expect(at(280)[1]).toBeCloseTo(STAND_Y, 2);
    // Walking right it goes up the ramp (a 2 m deep prism from x 4, its top 0.5 at x 7).
    const onRamp = r.path.filter((p) => p[0]! > 5 && p[0]! < 6.5);
    expect(onRamp.length).toBeGreaterThan(10);
    for (const p of onRamp) expect(p[1]! - STAND_Y).toBeGreaterThan(0.1);
    await r.h.dispose();
  }, 60_000);
});
