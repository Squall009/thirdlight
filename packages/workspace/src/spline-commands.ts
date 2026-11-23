/**
 * Splines through the commands: a project command that makes, changes,
 * moves or deletes a spline with a `voxels` section (or the section itself)
 * writes its voxels in the backend, after the structures' and before the
 * water's (ground, buildings, water), as one stroke a world attached to the
 * command's project entry (one undo step with the scene edit).
 *
 * The splines of every scene are compared with before by object id, each
 * by what the writer would write (its section resolved, its curve sampled
 * where it stands, and for a river the water bodies it meets: a body's level
 * changed writes the river meeting it again). A spline whose scene names no
 * voxel world, or more than one, is refused (`reference_missing`) and the
 * command taken back, as a structure or a body is.
 */
import { sceneVoxelSplines, sceneWaterBodies, splineVoxelDefinition, splineVoxelWorld } from '@thirdlight/project-model';
import type { CellBox, SplineVoxelDefinition } from '@thirdlight/voxel';
import type { SplineChange } from './voxel-spline-writes';
import type { VoxelCommandApplied, VoxelWorldError, VoxelWorlds } from './voxel-worlds';

/** A voxel spline as a scene holds it: its world (or why it has none) and what it writes there. */
interface HeldSpline {
  readonly world: string | null;
  readonly why: string | null;
  readonly definition: SplineVoxelDefinition | null;
  /** What the writer compares (the definition as JSON). */
  readonly key: string;
}

function splinesOf(scenes: readonly unknown[]): Map<string, HeldSpline> {
  const bodies = sceneWaterBodies(scenes);
  const out = new Map<string, HeldSpline>();
  for (const s of sceneVoxelSplines(scenes)) {
    if (out.has(s.entityId)) continue;
    const w = splineVoxelWorld(s);
    if (!('world' in w)) {
      out.set(s.entityId, { world: null, why: w.why, definition: null, key: '' });
      continue;
    }
    const definition = splineVoxelDefinition(s, bodies.filter((b) => b.body.world === w.world));
    out.set(s.entityId, { world: w.world, why: null, definition, key: JSON.stringify(definition) });
  }
  return out;
}

/** Whether a project's scenes hold a spline that writes voxels. */
export function scenesHoldVoxelSplines(scenes: readonly unknown[]): boolean {
  return sceneVoxelSplines(scenes).length > 0;
}

/**
 * The command's splines written, a stroke a world in world name order; with each world's changed cells (what the
 * water follows). A refusal takes back the strokes it made and answers why.
 */
export async function writeSplineChanges(worlds: VoxelWorlds, projectId: string, scenesBefore: readonly unknown[], scenes: readonly unknown[]): Promise<{ ok: true; voxels: VoxelCommandApplied[]; boxes: Map<string, CellBox[]> } | { ok: false; error: VoxelWorldError }> {
  const was = splinesOf(scenesBefore);
  const now = splinesOf(scenes);
  const byWorld = new Map<string, SplineChange[]>();
  const add = (world: string, ch: SplineChange): void => void (byWorld.get(world) ?? byWorld.set(world, []).get(world)!).push(ch);
  for (const id of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const a = was.get(id);
    const b = now.get(id);
    if (a !== undefined && b !== undefined && a.world === b.world && a.key === b.key) continue;
    if (b !== undefined && b.world === null) return { ok: false, error: { code: 'reference_missing', cls: 'validation', message: b.why!, path: '/components/spline/voxels' } };
    if (a?.world != null && a.world !== b?.world) add(a.world, { entityId: id, definition: null });
    if (b?.world != null) add(b.world, { entityId: id, definition: b.definition });
  }
  const voxels: VoxelCommandApplied[] = [];
  const boxes = new Map<string, CellBox[]>();
  for (const world of [...byWorld.keys()].sort()) {
    const r = await worlds.writeSplines(projectId, world, byWorld.get(world)!, null);
    if (r.ok) {
      voxels.push(r);
      const changed = (r.splines ?? []).flatMap((x) => (x.box === null ? [] : [x.box]));
      if (changed.length > 0) boxes.set(world, changed);
      continue;
    }
    if (r.error.code === 'no_change') continue;
    for (const done of voxels.reverse()) await worlds.step(projectId, done.world, 'undo', done.stroke, null);
    return { ok: false, error: r.error };
  }
  return { ok: true, voxels, boxes };
}
