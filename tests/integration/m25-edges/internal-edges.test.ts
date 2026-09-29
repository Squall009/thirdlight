/**
 * Phase 25.4: internal edges in 2D, through the production composition (the
 * real game host, the character controller, Rapier) on small neutral levels.
 * Static colliders that share a face (a wall of stacked boxes, a floor of
 * tiles, a slope cut in two) behave like the one collider they tile: the
 * character's path is the same, it never grounds or hangs at a seam.
 * A character pressed against a wall on its left falls as on its right
 * (D46: Rapier held it there). Also (plan §2, TL question 2): a polygon mover
 * pushes the character sideways as a box mover does (D47: it fail-stopped).
 */
import { describe, expect, it } from 'vitest';

import { createGameAudioOwner, createGameHost } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { withGameModules } from '../../game-modules';

type Any = any;
const DT = 1 / 120;
const T = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z], ...T });
const SETTINGS = { run_speed: 5, jump_velocity: 12, gravity_y: -20, max_fall_speed: -20, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
/** On a floor the capsule's centre rests at 0.91 above its top (half height 0.9 + the controller's skin). */
const REST_Y = 0.91;

class FakeNode {
  textContent = '';
  children: Any[] = [];
  appendChild(c: Any): void {
    this.children.push(c);
  }
  remove(): void {}
  setAttribute(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

type Drive = (step: number) => { moveX: number; jump: 'none' | 'pressed' | 'held' | 'released' };

/** A level of exactly `entities` (plus the camera and the player at `spawn`), driven by `drive`. */
async function level(spawn: [number, number], entities: Any[], drive: Drive) {
  const all: Any[] = [
    { id: 'cam-main', components: { transform: at(0, 4, 12), camera: { type: 'perspective', fovY: 45, near: 0.1, far: 200 } } },
    { id: 'player-0001', components: { transform: at(spawn[0], spawn[1]), controller: {} } },
    { id: 'spawn-0001', components: { transform: at(spawn[0], spawn[1]), playerSpawn: {} } },
    ...entities,
  ];
  const scene = { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: all };
  const statics = all
    .filter((e) => e.components.collider)
    .map((e) => ({
      entityId: e.id,
      shape: e.components.collider.shape,
      position: { x: e.components.transform.position[0], y: e.components.transform.position[1] },
      rotationZ: 0,
      ...(e.components.mover ? { kinematic: true } : {}),
    }));
  const physics = await createPhysicsPort({
    character: { x: spawn[0], y: spawn[1] },
    statics,
    solver: { hz: 120, gravityY: SETTINGS.gravity_y },
    controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: Math.PI / 4, minSlopeSlideRad: Math.PI / 6, autostep: false },
  } as Any);
  if (!physics.ok) throw new Error(JSON.stringify(physics.error));
  const input = {
    sample: (stepIndex: number) => ({ stepIndex, ...drive(stepIndex) }),
    sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
    markConfirmConsumed: () => undefined,
    dispose: () => undefined,
  };
  const audio: Any = createGameAudioOwner({ contextFactory: () => null } as Any);
  const host = createGameHost(withGameModules({
    snapshot: { snapshotId: 'edges@r1', projectId: 'edges', revision: 1, scene },
    settings: SETTINGS,
    physics: physics.port,
    adapter: () => null,
    input,
    audio,
    readArtifact: async () => new ArrayBuffer(0),
    container: new FakeNode(),
    buildId: 'b',
    assetPaths: {},
    document: { createElement: () => new FakeNode() },
  } as Any));
  const mounted = host.mount();
  if (!mounted.ok) throw new Error(JSON.stringify(mounted));
  let now = 0;
  const rt: Any = host.runtime;
  // The committed position after every executed step (not the interpolated frame).
  const cur = (id: string): [number, number] => {
    const t = rt.curr.get(id);
    return [t.position[0], t.position[1]];
  };
  // Every executed step: the player's and the other movers' positions.
  const steps: Record<string, [number, number]>[] = [];
  const movers = all.filter((e) => e.components.mover).map((e) => e.id as string);
  rt.setStepWatcher(() => {
    const at: Record<string, [number, number]> = { player: cur('player-0001') };
    for (const id of movers) at[id] = cur(id);
    steps.push(at);
    return false;
  });
  let cursor = 0;
  /** Run `n` fixed steps; the positions after each. */
  const record = (n: number): Record<string, [number, number]>[] => {
    while (steps.length < cursor + n) {
      now += DT;
      const r = rt.tick(now);
      if (!r.ok) throw new Error(JSON.stringify(r.error) + ' ' + JSON.stringify(rt.getDiagnostics().diagnostics?.failure ?? rt.getDiagnostics().diagnostics?.errors));
    }
    cursor += n;
    return steps.slice(cursor - n, cursor);
  };
  /** Run `n` fixed steps; the player's centre after each. */
  const run = (n: number): [number, number][] => record(n).map((s) => s['player']!);
  const failed = (): boolean => {
    const d = rt.getDiagnostics();
    return !d.ok || d.diagnostics.failed === true || d.diagnostics.errors.length > 0;
  };
  return { run, record, pos: cur, failed };
}

const solid = (id: string, x: number, y: number, shape: Any, extra: Record<string, unknown> = {}) => ({ id, components: { transform: at(x, y), collider: { shape }, ...extra } });
const boxShape = (hx: number, hy: number) => ({ type: 'box', hx, hy });
/** A rectangle as a convex polygon around its origin. */
const rectPoly = (hx: number, hy: number) => ({ type: 'polygon', vertices: [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]] });
const FLOOR = solid('floor-0001', 0, -0.5, boxShape(40, 0.5));

/** The largest per-step distance between two paths of the same length. */
function maxGap(a: [number, number][], b: [number, number][]): number {
  expect(a.length).toBe(b.length);
  let gap = 0;
  for (let i = 0; i < a.length; i++) gap = Math.max(gap, Math.hypot(a[i]![0] - b[i]![0], a[i]![1] - b[i]![1]));
  return gap;
}

/** Walk into the wall (right: +1, left: -1), jump once, keep pressing into it. */
const jumpIntoWall = (dir: number): Drive => (s) => ({ moveX: dir, jump: s === 90 ? 'pressed' : s > 90 && s < 150 ? 'held' : s === 150 ? 'released' : 'none' });

for (const [side, dir] of [['right', 1], ['left', -1]] as const) {
  describe(`phase 25.4: a wall of stacked colliders is one wall (the wall on the ${side})`, () => {
    // A 10 m wall whose face is 2 m from the start: one box, ten stacked 1 m boxes, ten stacked 1 m polygons.
    const wx = dir * 2.5;
    const walls: Record<string, Any[]> = {
      one: [solid('wall-0001', wx, 5, boxShape(0.5, 5))],
      boxes: Array.from({ length: 10 }, (_, i) => solid(`wall-${String(i + 1).padStart(4, '0')}`, wx, 0.5 + i, boxShape(0.5, 0.5))),
      polygons: Array.from({ length: 10 }, (_, i) => solid(`wall-${String(i + 1).padStart(4, '0')}`, wx, 0.5 + i, rectPoly(0.5, 0.5))),
    };
    const paths: Record<string, [number, number][]> = {};

    for (const name of Object.keys(walls)) {
      it(`sliding down a wall of ${name}: it never stops at a seam and lands on the floor`, async () => {
        const L = await level([0, REST_Y], [FLOOR, ...walls[name]!], jumpIntoWall(dir));
        const path = L.run(400);
        paths[name] = path;
        expect(L.failed()).toBe(false);
        const peak = path.reduce((m, p) => Math.max(m, p[1]), -Infinity);
        expect(peak).toBeGreaterThan(REST_Y + 2); // it rose past several seams
        // From the peak down to the floor, every step falls: no step rests on a seam or sticks to the wall.
        const top = path.findIndex((p) => p[1] === peak);
        const land = path.findIndex((p, i) => i > top && p[1] < REST_Y + 0.005);
        expect(land).toBeGreaterThan(top);
        expect(land - top).toBeLessThan(80); // a free fall from the peak (about 0.6 s)
        for (let i = top + 2; i < land && path[i]![1] > REST_Y + 0.02; i++) expect(path[i]![1]).toBeLessThan(path[i - 1]![1] - 1e-4);
        expect(path[path.length - 1]![1]).toBeCloseTo(REST_Y, 2);
        for (const p of path) expect(p[0] * dir).toBeLessThan(2 - 0.3 + 1e-3); // never inside the wall
        expect(path[path.length - 1]![0] * dir).toBeGreaterThan(2 - 0.3 - 0.02); // pressed against it
      });
    }

    it('the three walls give the same path', () => {
      expect(maxGap(paths['boxes']!, paths['one']!)).toBeLessThan(0.02);
      expect(maxGap(paths['polygons']!, paths['one']!)).toBeLessThan(0.02);
    });
  });
}

describe('phase 25.4: a floor of tiles is one floor', () => {
  // Floors with their top at y = 0 from x = -2 to 30: one box, 1 m box tiles, 0.5 m polygon tiles.
  const floors: Record<string, Any[]> = {
    one: [solid('floor-0001', 14, -0.5, boxShape(16, 0.5))],
    boxes: Array.from({ length: 32 }, (_, i) => solid(`tile-${String(i + 1).padStart(4, '0')}`, -1.5 + i, -0.5, boxShape(0.5, 0.5))),
    polygons: Array.from({ length: 64 }, (_, i) => solid(`tile-${String(i + 1).padStart(4, '0')}`, -1.75 + i * 0.5, -0.25, rectPoly(0.25, 0.25))),
  };
  const paths: Record<string, [number, number][]> = {};
  // Walk right, jump twice (landing on seams on the way), stop, walk back.
  const drive: Drive = (s) => ({
    moveX: s < 500 ? 1 : s < 560 ? 0 : -1,
    jump: s === 100 || s === 300 ? 'pressed' : s === 101 || s === 301 ? 'held' : s === 130 || s === 330 ? 'released' : 'none',
  });

  for (const name of Object.keys(floors)) {
    it(`walking and jumping on a floor of ${name}: never caught or stopped at a seam`, async () => {
      const L = await level([0, REST_Y], floors[name]!, drive);
      const path = L.run(800);
      paths[name] = path;
      expect(L.failed()).toBe(false);
      // Walking (not in a jump): full speed each step at rest height.
      for (let i = 30; i < 480; i++) { // (the path starts after the 12 settle steps; the input stops at step 500)
        if (path[i]![1] > REST_Y + 0.005 || path[i - 1]![1] > REST_Y + 0.005) continue;
        expect(path[i]![0] - path[i - 1]![0]).toBeGreaterThan(5 * DT * 0.99);
      }
      expect(path[799]![1]).toBeCloseTo(REST_Y, 2);
    });
  }

  it('the three floors give the same path', () => {
    // Within a few millimetres: a landing right on a seam can shorten that one step a little.
    expect(maxGap(paths['boxes']!, paths['one']!)).toBeLessThan(0.005);
    expect(maxGap(paths['polygons']!, paths['one']!)).toBeLessThan(0.005);
  });
});

describe('phase 25.4: a ceiling of tiles is one ceiling', () => {
  // A ceiling whose underside is at y = 2.2 from x = -2 to 30: one box, 1 m box tiles, 0.5 m polygon tiles.
  const ceilings: Record<string, Any[]> = {
    one: [solid('roof-0001', 14, 2.7, boxShape(16, 0.5))],
    boxes: Array.from({ length: 32 }, (_, i) => solid(`roof-${String(i + 1).padStart(4, '0')}`, -1.5 + i, 2.7, boxShape(0.5, 0.5))),
    polygons: Array.from({ length: 64 }, (_, i) => solid(`roof-${String(i + 1).padStart(4, '0')}`, -1.75 + i * 0.5, 2.45, rectPoly(0.25, 0.25))),
  };
  const paths: Record<string, [number, number][]> = {};
  // Run right, jumping into the ceiling again and again.
  const drive: Drive = (s) => ({ moveX: 1, jump: s % 60 === 20 ? 'pressed' : s % 60 > 20 && s % 60 < 40 ? 'held' : s % 60 === 40 ? 'released' : 'none' });
  for (const name of Object.keys(ceilings)) {
    it(`jumping into a ceiling of ${name} while running: the run never stops under a seam`, async () => {
      const L = await level([0, REST_Y], [FLOOR, ...ceilings[name]!], drive);
      const path = L.run(480);
      paths[name] = path;
      expect(L.failed()).toBe(false);
      const topY = path.reduce((m, p) => Math.max(m, p[1]), -Infinity);
      expect(topY).toBeGreaterThan(2.2 - 0.9 - 0.02); // the head reached the ceiling
      for (let i = 30; i < 480; i++) expect(path[i]![0] - path[i - 1]![0]).toBeGreaterThan(5 * DT * 0.95); // (a head bump costs a little even on one collider)
    });
  }
  it('the three ceilings give the same path', () => {
    // Within 2 cm over 4 s of repeated head bumps (each bump's slide differs by fractions of a millimetre and adds up).
    expect(maxGap(paths['boxes']!, paths['one']!)).toBeLessThan(0.02);
    expect(maxGap(paths['polygons']!, paths['one']!)).toBeLessThan(0.02);
  });
});

describe('phase 25.4: a slope cut into two polygons is one slope', () => {
  // A 30° ramp from x = 2 (y = 0) to x = 8 (y = 6·tan30), then a flat top; one polygon, or two sharing the face at x = 5.
  const t = Math.tan(Math.PI / 6);
  const one = solid('ramp-0001', 0, 0, { type: 'polygon', vertices: [[2, 0], [8, 0], [8, 6 * t]] });
  const halves = [
    solid('ramp-0001', 0, 0, { type: 'polygon', vertices: [[2, 0], [5, 0], [5, 3 * t]] }),
    solid('ramp-0002', 0, 0, { type: 'polygon', vertices: [[5, 0], [8, 0], [8, 6 * t], [5, 3 * t]] }),
  ];
  const top = solid('top-0001', 12, 6 * t - 0.5, boxShape(4, 0.5));
  const paths: Record<string, [number, number][]> = {};
  const drive: Drive = () => ({ moveX: 1, jump: 'none' });
  for (const [name, ramp] of Object.entries({ one: [one], halves })) {
    it(`walking up a slope of ${name === 'one' ? 'one polygon' : 'two polygons'}: never stopped at the seam`, async () => {
      const L = await level([0, REST_Y], [FLOOR, ...ramp, top], drive);
      const path = L.run(360);
      paths[name] = path;
      expect(L.failed()).toBe(false);
      expect(path[359]![0]).toBeGreaterThan(9); // over the top of the ramp
    });
  }
  it('both slopes give the same path', () => {
    expect(maxGap(paths['halves']!, paths['one']!)).toBeLessThan(0.02);
  });
});

describe('phase 25.4 (plan §2, TL question 2): a polygon mover pushes the character sideways', () => {
  // A 1 × 2 m block sliding left at 2 m/s into a character standing still; a box collider and the same rectangle as a polygon.
  const shapes = { box: boxShape(0.5, 1), polygon: rectPoly(0.5, 1) };
  const paths: Record<string, [number, number][]> = {};
  for (const [name, shape] of Object.entries(shapes)) {
    it(`a ${name} mover pushes the character along the floor and never overlaps it`, async () => {
      const block = solid('block-0001', 4, 1, shape, { mover: { waypoints: [[-6, 0, 0]], speed: 2, mode: 'once' } });
      const L = await level([0, REST_Y], [FLOOR, block], () => ({ moveX: 0, jump: 'none' }));
      const path: [number, number][] = [];
      for (const s of L.record(300)) {
        const [x, y] = s['player']!;
        path.push([x, y]);
        expect(x).toBeLessThan(s['block-0001']![0] - 0.5 - 0.3 + 2e-3); // the capsule stays left of the block's face
        expect(y).toBeLessThan(REST_Y + 0.01); // on the floor, not lifted
      }
      paths[name] = path;
      expect(L.failed()).toBe(false);
      expect(L.pos('block-0001')[0]).toBeLessThan(-1); // it moved 5 m and more (the settle steps move it too)
      expect(path[299]![0]).toBeLessThan(-1.7); // pushed about 2 m to the left
    });
  }
  it('both movers push the same way', () => {
    expect(maxGap(paths['polygon']!, paths['box']!)).toBeLessThan(1e-3);
  });
});
