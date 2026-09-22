/**
 * Packet 51 — the pure camera math (tests/m3-camera/**): every committed
 * `fixtures/m3/camera` case replayed through the real module's
 * `followCamera` (packages/platformer-game), with strict (Object.is)
 * equality against the fixture's recorded expectations — the numeric
 * fixture equality the packet requires.
 *
 * The fixtures are the promoted, frozen packet-40 set (gameplay.md §7);
 * their values were re-derived by the packet-40 checker's reference
 * implementation. This test is an independent third derivation: the
 * module's pipeline must agree with the fixtures bit for bit, on every
 * case, at both desktop aspects (16:9 and 4:3), for follow/dead-zone,
 * smoothing (k = 0 hard target, k = 0.2/0.25 geometric decay), the
 * per-step cap, the authored-bounds clamp, the frustum clamp (including
 * the smaller-than-frustum centre fallback), the §7.4 snap pipeline
 * (k forced to 1, cap skipped) and the resize aspect change.
 *
 * No runtime, no physics: the math is pure and the fixtures are JSON.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_CONSTANTS,
  CAMERA_SNAP_EPS,
  followCamera,
  type CameraFollowInput,
} from '@thirdlight/platformer-game';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAMERA = join(REPO_ROOT, 'fixtures', 'm3', 'camera');

const json = <T>(rel: string): T => JSON.parse(readFileSync(join(CAMERA, rel), 'utf8')) as T;
const sha256 = (rel: string): string =>
  createHash('sha256').update(readFileSync(join(CAMERA, rel))).digest('hex');

/** The committed digest of the frozen camera fixture set (index.json). */
const INDEX = json<{ fixtures: Record<string, { bytes: number; sha256: string }> }>('index.json');

// ---------------------------------------------------------------------------
// The §7.2 replay: the same step loop the fixtures were derived from.
// A per-step `viewport` override (resize) changes only the aspect; a
// per-step `snap` flag switches the §7.4 pipeline for that step.
// ---------------------------------------------------------------------------

interface FollowCase {
  id: string;
  fovY?: number;
  viewport: [number, number];
  level: { minX: number; maxX: number; minY: number; maxY: number };
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  deadZone: [number, number];
  smoothing: number;
  /** The §7.4 pipeline for every step unless a step overrides it. */
  snap?: boolean;
  start: [number, number];
  steps: Array<{ player: [number, number]; viewport?: [number, number]; snap?: boolean; skipTargets?: boolean }>;
  expect: {
    halfH: number;
    halfW: number;
    positions: [number, number][];
    targets: [number, number][];
    moved: boolean[];
    range: {
      halfW: number;
      halfH: number;
      x: { clamped?: [number, number]; centeredAt?: number };
      y: { clamped?: [number, number]; centeredAt?: number };
    };
  };
}

function replay(c: FollowCase) {
  let width = c.viewport[0];
  let height = c.viewport[1];
  let C: [number, number] = c.start;
  const positions: [number, number][] = [];
  const targets: [number, number][] = [];
  const moved: boolean[] = [];
  let halfW = 0;
  let halfH = 0;
  for (const s of c.steps) {
    if (s.skipTargets === true) continue;
    if (s.viewport) {
      width = s.viewport[0];
      height = s.viewport[1];
    }
    // The case-level `snap` flag is the pipeline default; a step-level `snap`
    // overrides it for that step only (the checker's same rule).
    const snapResolved = s.snap !== undefined ? s.snap : c.snap === true;
    const input: CameraFollowInput = {
      camera: { x: C[0], y: C[1] },
      player: { x: s.player[0], y: s.player[1] },
      deadZone: { x: c.deadZone[0], y: c.deadZone[1] },
      smoothing: c.smoothing,
      bounds: c.bounds,
      level: c.level,
      fovY: c.fovY ?? 45,
      aspect: width / height,
      ...(snapResolved ? { snap: true } : {}),
    };
    const r = followCamera(input);
    positions.push([r.position.x, r.position.y]);
    targets.push([r.target.x, r.target.y]);
    moved.push(r.moved);
    halfW = r.halfW;
    halfH = r.halfH;
    C = [r.position.x, r.position.y];
  }
  const rangeFor = (min: number, max: number, half: number): { clamped?: [number, number]; centeredAt?: number } =>
    max - min >= 2 * half ? { clamped: [min + half, max - half] } : { centeredAt: (min + max) / 2 };
  // `clips` is the fixture's reserved field (always empty; the pipeline has
  // no clipping beyond the frustum clamp) — carried for subset agreement.
  return { positions, targets, moved, clips: [], halfW, halfH, range: { halfW, halfH, x: rangeFor(c.level.minX, c.level.maxX, halfW), y: rangeFor(c.level.minY, c.level.maxY, halfH) } };
}

function expectStrict(actual: unknown, expected: unknown, path: string): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path}: array expected`).toBe(true);
    const a = actual as unknown[];
    expect(a.length, `${path}: length`).toBe(expected.length);
    expected.forEach((v, i) => expectStrict(a[i], v, `${path}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    const a = actual as Record<string, unknown>;
    for (const k of Object.keys(expected as Record<string, unknown>)) {
      expectStrict(a[k], (expected as Record<string, unknown>)[k], `${path}.${k}`);
    }
    return;
  }
  expect(Object.is(actual, expected), `${path}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`).toBe(true);
}

const FILES = ['follow.json', 'bounds.json', 'snap.json', 'resize.json'] as const;

describe('packet 51 — committed camera fixtures through the real followCamera (numeric equality)', () => {
  for (const file of FILES) {
    it(`${file}: every case is bit-equal to the recorded expectations`, () => {
      const doc = json<{ cases: FollowCase[] }>(file);
      expect(doc.cases.length, `${file}: no cases`).toBeGreaterThan(0);
      for (const c of doc.cases) {
        const actual = replay(c);
        expectStrict(actual, c.expect, c.id);
      }
    });
  }

  it('the fixture set is the frozen committed set (index.json digests)', () => {
    for (const [rel, meta] of Object.entries(INDEX.fixtures)) {
      expect(sha256(rel), `${rel} sha256`).toBe(meta.sha256);
      expect(readFileSync(join(CAMERA, rel)).length, `${rel} bytes`).toBe(meta.bytes);
    }
  });

  it('the module exposes the §7.1 contract constants the fixtures pin', () => {
    expect(CAMERA_CONSTANTS.cameraZ).toBe(12);
    expect(CAMERA_CONSTANTS.cameraMaxStep).toBe(4);
    expect(CAMERA_CONSTANTS.cameraSnapEps).toBe(1e-9);
    expect(CAMERA_CONSTANTS.defaultAspect).toBe(16 / 9);
    expect(CAMERA_SNAP_EPS).toBe(1e-9);
    // The closed form the fixtures use: halfH = 12·tan(22.5°) = 12(√2 − 1).
    const r = followCamera({
      camera: { x: 0, y: 0 },
      player: { x: 0.1, y: 0 },
      deadZone: { x: 0.5, y: 0.5 },
      smoothing: 0,
      bounds: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
      level: { minX: -100, maxX: 100, minY: -100, maxY: 100 },
      fovY: 45,
      aspect: 16 / 9,
    });
    expect(r.halfH).toBe(4.970562748477141);
    expect(r.halfW).toBe(8.836555997292695);
  });

  it('the resize.json viewport dimension sets: accepted and rejected exactly', () => {
    const doc = json<{ rejected: { width: number | string; height: number | string }[]; accepted: { width: number; height: number }[] }>('resize.json');
    const dim = (v: number | string): number => Number(v);
    // Independent re-derivation of the §7.5 predicate (gameplay.md §7.5):
    // finite, positive, ≤ 16384 on both axes.
    const accepted = (w: number, h: number): boolean =>
      Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= 16384 && h <= 16384;
    for (const c of doc.rejected) {
      expect(accepted(dim(c.width), dim(c.height)), `${JSON.stringify(c)} must be rejected`).toBe(false);
    }
    for (const c of doc.accepted) {
      expect(accepted(c.width, c.height), `${JSON.stringify(c)} must be accepted`).toBe(true);
    }
  });
});