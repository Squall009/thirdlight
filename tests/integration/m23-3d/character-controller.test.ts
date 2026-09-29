/**
 * The 3D kinematic character controller on the real Rapier 3D
 * backend through the production game host (page composition), driven by a
 * recorded input — neutral graybox fixtures: a floor, risers, a wall, ramps,
 * a ledge and a staircase.
 *
 * - step-up: the default 0.3 m step-up climbs a 0.3 m riser and not a 0.6 m block;
 * - walls block, and a diagonal push slides along one;
 * - the slope limit (controller data) decides whether a 35° ramp is walked up;
 * - a ledge higher than a step is climbed only with the ledge climb on and
 *   within its height;
 * - walking down a staircase of 0.3 m risers the character stays on the
 *   stairs (the ground snap is at least the step-up height);
 * - it faces where it moves, jumps (unless jumping is off), runs with the
 *   `run` action, reads the move relative to the camera's yaw.
 */
import { describe, expect, it } from 'vitest';

import { block, holdMove, runScene, sceneOf, STAND_Y, type Any } from './character-kit';

const RIGHT = { moveX: 1, moveY: 0 };

async function walk(controller: Any, extra: Any[], steps: number, move = RIGHT, total = steps + 120, opts: { yaw?: number; frame?: (i: number) => Any; start?: number[] } = {}) {
  const scene = sceneOf(controller, opts.start ?? [0, STAND_Y, 0], extra);
  const r = await runScene('single', scene, holdMove(steps, move.moveX, move.moveY, opts.frame), total, {}, opts.yaw);
  await r.h.dispose();
  if (r.errors.length > 0) throw new Error(JSON.stringify(r.errors));
  return r;
}

/** A ramp rising along +x from floor level at x = x0, `deg` steep (a box turned about Z). */
function ramp(id: string, x0: number, deg: number): Any {
  const t = (deg * Math.PI) / 180;
  const hx = 3;
  const hy = 0.25;
  const center = [x0 + hx * Math.cos(t) + hy * Math.sin(t), hx * Math.sin(t) - hy * Math.cos(t), 0];
  return block(id, center, [hx, hy, 2], [0, 0, Math.sin(t / 2), Math.cos(t / 2)]);
}

describe('phase 23.2: the 3D character controller (Rapier 3D, recorded input)', () => {
  it('step-up: the default 0.3 m climbs a 0.3 m riser; a 0.6 m block stops it', async () => {
    const low = await walk({}, [block('step-1', [3, 0.15, 0], [1, 0.15, 2])], 200);
    expect(low.player.position[0]).toBeGreaterThan(2.5);
    expect(low.player.position[1]).toBeGreaterThan(0.3 + STAND_Y - 0.02);
    expect(low.player.position[1]).toBeLessThan(0.3 + STAND_Y + 0.02);
    const high = await walk({}, [block('block-1', [3, 0.3, 0], [1, 0.3, 2])], 200);
    // Stopped by its face at x = 2 (capsule radius 0.3 plus the skin), still on the floor.
    expect(high.player.position[0]).toBeLessThan(1.72);
    expect(high.player.position[0]).toBeGreaterThan(1.6);
    expect(high.player.position[1]).toBeLessThan(STAND_Y + 0.02);
    // The step-up height is data: at 0.6 m the block is a step.
    const tall = await walk({ stepHeight: 0.6 }, [block('block-1', [3, 0.3, 0], [1, 0.3, 2])], 200);
    expect(tall.player.position[0]).toBeGreaterThan(2.5);
    expect(tall.player.position[1]).toBeGreaterThan(0.6 + STAND_Y - 0.02);
    // Off (0): even a 0.2 m riser stops it.
    const off = await walk({ stepHeight: 0 }, [block('step-1', [3, 0.1, 0], [1, 0.1, 2])], 200);
    expect(off.player.position[0]).toBeLessThan(1.72);
  }, 120_000);

  it('walls block; pushing diagonally into one slides along it', async () => {
    const wall = block('wall-1', [2.25, 1.5, 0], [0.25, 1.5, 6]);
    const straight = await walk({}, [wall], 240);
    expect(straight.player.position[0]).toBeLessThan(1.72);
    expect(Math.abs(straight.player.position[2]!)).toBeLessThan(0.01);
    // Right and forward (−Z at the world-axes default): blocked in x, sliding along −z.
    const diagonal = await walk({}, [wall], 240, { moveX: 0.7071, moveY: 0.7071 });
    expect(diagonal.player.position[0]).toBeLessThan(1.72);
    expect(diagonal.player.position[2]).toBeLessThan(-2);
  }, 120_000);

  it('the slope limit decides whether a 35° ramp is walked up', async () => {
    const up = await walk({ slopeLimit: 45 }, [ramp('ramp-1', 2, 35)], 300);
    expect(up.player.position[0]).toBeGreaterThan(3.5);
    expect(up.player.position[1]).toBeGreaterThan(STAND_Y + 1);
    const blocked = await walk({ slopeLimit: 25 }, [ramp('ramp-1', 2, 35)], 300);
    expect(blocked.player.position[0]).toBeLessThan(2.6);
    expect(blocked.player.position[1]).toBeLessThan(STAND_Y + 0.4);
  }, 120_000);

  it('a ledge higher than a step is climbed with the ledge climb on, within its height', async () => {
    const ledge = block('ledge-1', [3, 0.5, 0], [1, 0.5, 2]);
    const off = await walk({}, [ledge], 300);
    expect(off.player.position[0]).toBeLessThan(1.72);
    expect(off.player.position[1]).toBeLessThan(STAND_Y + 0.02);
    const on = await walk({ ledgeClimb: true }, [ledge], 300);
    expect(on.player.position[0]).toBeGreaterThan(2.3);
    expect(on.player.position[1]).toBeGreaterThan(1 + STAND_Y - 0.02);
    expect(on.player.position[1]).toBeLessThan(1 + STAND_Y + 0.03);
    // The climb takes its time (0.6 s by default): it rises over many steps, not at once.
    const rising = on.path.filter((p) => p[1]! > STAND_Y + 0.05 && p[1]! < 1 + STAND_Y - 0.05);
    expect(rising.length).toBeGreaterThan(20);
    // Above its ledge height it stays blocked.
    const short = await walk({ ledgeClimb: true, ledgeHeight: 0.8 }, [ledge], 300);
    expect(short.player.position[0]).toBeLessThan(1.72);
    expect(short.player.position[1]).toBeLessThan(STAND_Y + 0.02);
  }, 120_000);

  it('walking down a staircase of 0.3 m risers it stays on the stairs', async () => {
    // A 0.9 m platform, then three 0.3 m steps down along +x (treads 0.5 m).
    const stairs = [
      block('top-1', [0, 0.45, 0], [1.5, 0.45, 2]),
      block('stair-1', [1.75, 0.3, 0], [0.25, 0.3, 2]),
      block('stair-2', [2.25, 0.15, 0], [0.25, 0.15, 2]),
    ];
    const r = await walk({}, stairs, 220, RIGHT, 300, { start: [0, 0.9 + STAND_Y, 0] });
    expect(r.player.position[0]).toBeGreaterThan(3);
    expect(r.player.position[1]).toBeLessThan(STAND_Y + 0.02);
    // Snapped from tread to tread: grounded on (nearly) every step on the way down.
    const down = r.path.filter((p) => p[0]! > 1.3 && p[0]! < 2.8);
    const airborne = down.filter((p) => p[3] === 0).length;
    expect(down.length).toBeGreaterThan(30);
    expect(airborne).toBeLessThanOrEqual(2);
  }, 120_000);

  it('faces where it moves (turned about +Y, +Z forward), at the turn speed', async () => {
    const right = await walk({}, [], 120);
    const r = right.player.rotation;
    expect(r[0]).toBe(0);
    expect(r[2]).toBe(0);
    expect(r[1]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(r[3]).toBeCloseTo(Math.SQRT1_2, 9);
    // Forward (−Z): a half turn.
    const fwd = await walk({}, [], 120, { moveX: 0, moveY: 1 });
    expect(Math.abs(fwd.player.rotation[1]!)).toBeCloseTo(1, 9);
    expect(fwd.player.rotation[3]).toBeCloseTo(0, 9);
    // Off: the rotation stays as authored.
    const still = await walk({ faceMovement: false }, [], 120);
    expect(still.player.rotation).toEqual([0, 0, 0, 1]);
  }, 120_000);

  it('jumps (unless jumping is off); runs with the run action; reads the move relative to the camera yaw', async () => {
    const jumpAt = (i: number) => (i === 30 ? { jump: 'pressed' } : i > 30 && i < 60 ? { jump: 'held' } : i === 60 ? { jump: 'released' } : {});
    const jumps = await walk({}, [], 200, { moveX: 0, moveY: 0 }, 260, { frame: jumpAt });
    const peak = Math.max(...jumps.path.map((p) => p[1]!));
    expect(peak).toBeGreaterThan(STAND_Y + 0.8);
    expect(jumps.player.position[1]).toBeLessThan(STAND_Y + 0.02);
    const noJump = await walk({ jump: false }, [], 200, { moveX: 0, moveY: 0 }, 260, { frame: jumpAt });
    expect(Math.max(...noJump.path.map((p) => p[1]!))).toBeLessThan(STAND_Y + 0.02);
    // 1 s of walking at 2 m/s vs running at the run speed (the project's 4 m/s): twice as far
    // (the first 12 steps are the runtime's settle pre-roll, then 0.05 s / 0.1 s of acceleration).
    const walked = await walk({}, [], 120, RIGHT, 120);
    const ran = await walk({}, [], 120, RIGHT, 120, { frame: () => ({ actions: { run: { v: 1, p: 'held' } } }) });
    expect(walked.player.position[0]).toBeGreaterThan(1.7);
    expect(walked.player.position[0]).toBeLessThan(1.8);
    expect(ran.player.position[0] / walked.player.position[0]).toBeGreaterThan(1.9);
    expect(ran.player.position[0] / walked.player.position[0]).toBeLessThan(2.05);
    // The walk speed is data.
    const slow = await walk({ walkSpeed: 1 }, [], 120, RIGHT, 120);
    expect(slow.player.position[0]).toBeGreaterThan(0.85);
    expect(slow.player.position[0]).toBeLessThan(0.9);
    // A camera turned 90° (looking along −X): forward walks along −X.
    const turned = await walk({}, [], 120, { moveX: 0, moveY: 1 }, 120, { yaw: Math.PI / 2 });
    expect(turned.player.position[0]).toBeLessThan(-1.7);
    expect(Math.abs(turned.player.position[2]!)).toBeLessThan(1e-3);
  }, 120_000);
});
