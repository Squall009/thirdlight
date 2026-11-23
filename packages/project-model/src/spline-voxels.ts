/**
 * Splines that write voxels, as the scenes hold them: which ones, the world
 * each writes into, and the writer's definition of what it writes (its
 * `voxels` section resolved, its curve sampled where it stands, the water
 * bodies a river meets).
 *
 * The world is not stored on the spline: it is its scene's voxel world, the
 * one world its scene's `voxelWorld` objects name. A scene naming none, or
 * more than one, gives the spline no world, and the backend refuses it.
 *
 * Pure.
 */
import { SPLINE_WRITER_VERSION, VOXEL_SIZE_M, type SplineBodyMeet, type SplineVoxelDefinition } from '@thirdlight/voxel';
import { SPLINE_RIVER_DEPTH_DEFAULT, canonicalSpline, type SplineComponent, type SplineVoxelSettings } from './spline';
import { SplineCurve } from './spline-curve';
import type { SceneWaterBody } from './water-body';

/** Metres between the samples of the curve a spline writes along (half a cell: no cell falls between two). */
export const SPLINE_VOXEL_STEP = VOXEL_SIZE_M / 2;

/** A spline object with a `voxels` section, as its scene holds it. */
export interface SceneVoxelSpline {
  readonly sceneId: string | null;
  readonly entityId: string;
  readonly spline: SplineComponent & { readonly voxels: SplineVoxelSettings };
  /** Where its points are measured from (its position; null: no transform). */
  readonly position: readonly [number, number, number] | null;
  /** The voxel worlds its scene's `voxelWorld` objects name, sorted: the spline writes into the one. */
  readonly worlds: readonly string[];
}

/** Every spline object of the scenes with a `voxels` section, in scene and entity order (a scene given twice read once). */
export function sceneVoxelSplines(scenes: readonly unknown[]): SceneVoxelSpline[] {
  const out: SceneVoxelSpline[] = [];
  const seen = new Set<string>();
  for (const sc of scenes) {
    const entities = (sc as { entities?: unknown } | null)?.entities;
    if (!Array.isArray(entities)) continue;
    const sceneId = typeof (sc as { sceneId?: unknown }).sceneId === 'string' ? (sc as { sceneId: string }).sceneId : null;
    if (sceneId !== null && seen.has(sceneId)) continue;
    if (sceneId !== null) seen.add(sceneId);
    const worlds = [...new Set((entities as Array<{ components?: { voxelWorld?: { world?: unknown } } } | null>).flatMap((e) => (typeof e?.components?.voxelWorld?.world === 'string' ? [e.components.voxelWorld.world] : [])))].sort();
    for (const e of entities as Array<{ id?: unknown; components?: Record<string, unknown> } | null>) {
      const c = e?.components?.['spline'] as SplineComponent | undefined;
      if (c === undefined || typeof e?.id !== 'string' || c.voxels === undefined || !Array.isArray(c.points)) continue;
      const p = (e.components?.['transform'] as { position?: unknown } | undefined)?.position;
      const position = Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every((v) => typeof v === 'number') ? ([p[0], p[1], p[2]] as [number, number, number]) : null;
      out.push({ sceneId, entityId: e.id, spline: canonicalSpline(c) as SceneVoxelSpline['spline'], position, worlds });
    }
  }
  return out;
}

/** The world a spline writes into, or why it has none. */
export function splineVoxelWorld(s: SceneVoxelSpline): { world: string } | { why: string } {
  if (s.worlds.length === 1) return { world: s.worlds[0]! };
  return { why: s.worlds.length === 0 ? `spline ${s.entityId} writes voxels, and no voxelWorld object of its scene names a world: a spline writes into its scene's voxel world` : `spline ${s.entityId} writes voxels, and its scene names ${s.worlds.length} voxel worlds (${s.worlds.join(', ')}): a spline writes into its scene's one voxel world` };
}

/**
 * What the spline writer writes for a spline: its section resolved (a river's depth its bed's or the default), its
 * curve sampled every {@link SPLINE_VOXEL_STEP} where it stands, and for a river the bodies of `bodies` (its world's)
 * whose reach its course meets under their level. Null: it has no place.
 */
export function splineVoxelDefinition(s: SceneVoxelSpline, bodies: readonly SceneWaterBody[]): SplineVoxelDefinition | null {
  if (s.position === null) return null;
  const v = s.spline.voxels;
  const curve = SplineCurve.of(s.spline, s.position);
  const frames = curve.frames(SPLINE_VOXEL_STEP);
  if (curve.closed && frames.length > 1) frames.pop();
  const samples: number[] = [];
  for (const f of frames) samples.push(f.x, f.y, f.z, f.width);
  const depth = v.kind === 'river' ? (v.bed?.depth ?? SPLINE_RIVER_DEPTH_DEFAULT) : 0;
  const meets: SplineBodyMeet[] = [];
  if (v.kind === 'river') {
    const [x0, y0, z0, x1, , z1] = curve.bounds;
    const half = curve.maxWidth / 2;
    for (const b of bodies) {
      if (b.seed === null) continue;
      const r = b.body.reach;
      const nearX = Math.max(x0 - half, Math.min(b.seed[0], x1 + half));
      const nearZ = Math.max(z0 - half, Math.min(b.seed[2], z1 + half));
      // Inside its reach somewhere, and its level over the channel's lowest floor.
      if (Math.hypot(nearX - b.seed[0], nearZ - b.seed[2]) > r || b.body.level <= y0 - depth) continue;
      meets.push({ level: b.body.level, material: b.body.material, seed: [b.seed[0], b.seed[2]], reach: r });
    }
  }
  return {
    generator: SPLINE_WRITER_VERSION,
    kind: v.kind,
    material: v.material,
    bed: v.bed === undefined ? null : { material: v.bed.material, depth: v.bed.depth },
    depth,
    shoulder: v.shoulder === undefined ? null : { width: v.shoulder.width, slope: v.shoulder.slope },
    clear: v.clear ?? 0,
    samples,
    closed: curve.closed,
    bodies: meets,
  };
}
