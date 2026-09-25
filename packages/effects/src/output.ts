/**
 * Phase 20.1: the pure maths of the Output blocks, shared by the executors
 * (the renderers themselves are phase 20.2): which flipbook frame a particle
 * shows, how a billboard is oriented, which particles carry the limited
 * lights, and the order a ribbon joins particles in.
 */
import type { GraphValue } from '@thirdlight/project-model';

import { cross, length, normalize, type Vec3 } from './math';
import type { SystemState } from './evaluator';

/** The flipbook frame (0 … columns × rows − 1) of a particle. */
export function flipbookFrame(fields: Readonly<Record<string, GraphValue>>, age: number, lifetime: number): number {
  const frames = Math.max(1, Math.round(Number(fields['columns'] ?? 1)) * Math.round(Number(fields['rows'] ?? 1)));
  switch (fields['flipbook']) {
    case 'overLife': {
      const t = lifetime > 0 ? Math.min(1, Math.max(0, age / lifetime)) : 1;
      return Math.min(frames - 1, Math.floor(t * frames));
    }
    case 'fps':
      return Math.floor(Math.max(0, age) * Number(fields['fps'] ?? 12)) % frames;
    default:
      return 0;
  }
}

/** The UV rectangle [u0, v0, u1, v1] of a frame (frames read left to right, top to bottom). */
export function flipbookRect(fields: Readonly<Record<string, GraphValue>>, frame: number): [number, number, number, number] {
  const cols = Math.max(1, Math.round(Number(fields['columns'] ?? 1)));
  const rows = Math.max(1, Math.round(Number(fields['rows'] ?? 1)));
  const c = frame % cols;
  const r = Math.floor(frame / cols) % rows;
  return [c / cols, 1 - (r + 1) / rows, (c + 1) / cols, 1 - r / rows];
}

/**
 * A billboard's right and up axes (unit vectors): facing the camera; along
 * the velocity (up = the direction of travel, turned to face the camera;
 * at rest it faces the camera); or turning around a fixed axis.
 */
export function billboardAxes(orient: string, camera: { right: Vec3; up: Vec3; forward: Vec3 }, velocity: Vec3, axis: Vec3): { right: Vec3; up: Vec3 } {
  const around = (up: Vec3): { right: Vec3; up: Vec3 } => {
    const right = normalize(cross(up, camera.forward));
    return length(right) > 0 ? { right, up } : { right: camera.right, up: camera.up };
  };
  if (orient === 'velocity' && length(velocity) > 1e-6) return around(normalize(velocity));
  if (orient === 'axis' && length(axis) > 1e-6) return around(normalize(axis));
  return { right: camera.right, up: camera.up };
}

/** The particles that carry a light: the oldest living ones, at most `max` (ties by birth order). */
export function lightParticles(sys: SystemState, max: number): number[] {
  const idx = Array.from({ length: sys.count }, (_, i) => i);
  idx.sort((a, b) => sys.age[b]! - sys.age[a]! || sys.serial[a]! - sys.serial[b]!);
  return idx.slice(0, Math.max(0, Math.floor(max)));
}

/** The living particles in birth order (a ribbon joins them in this order). */
export function ribbonOrder(sys: SystemState): number[] {
  const idx = Array.from({ length: sys.count }, (_, i) => i);
  idx.sort((a, b) => sys.serial[a]! - sys.serial[b]!);
  return idx;
}
