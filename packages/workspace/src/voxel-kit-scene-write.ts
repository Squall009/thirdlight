/** The kit test scene written into a world as one change. */
import {
  canonicalEditCommand,
  EditRefused,
  kitTestScene,
  MATERIAL_ID_MAX,
  valueOf,
  WORLD_RULES,
  type CellBox,
  type ChunkCoord,
  type ChunkUndo,
  type VoxelRecord,
} from '@thirdlight/voxel';
import { refuse, type VoxelCommandApplied, type VoxelWorldError } from './voxel-world-answers';
import type { RegionWorld } from './voxel-world-files';

/**
 * The kit test scene's edits applied as one change: the undo record holds
 * each edit's, newest first, so writing it back takes them back in turn.
 * Cells counts the cells of the box that end different from before, so a
 * scene written over itself changes nothing and is refused as any such
 * edit is. Nothing stays applied when a step is refused.
 */
export async function writeKitTestScene(world: RegionWorld, a: Record<string, unknown>): Promise<{ ok: true; record: ChunkUndo[]; cells: number; box: CellBox; parts: number; materialSwaps: number[]; scene: NonNullable<VoxelCommandApplied['scene']> } | { ok: false; error: VoxelWorldError }> {
  const origin = a.origin;
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every((v) => Number.isSafeInteger(v))) return refuse('invalid_args', 'validation', 'origin is [x, y, z], whole world cells', '/args/origin');
  const material = a.material;
  if (typeof material !== 'number' || !Number.isInteger(material) || material < 1 || material > MATERIAL_ID_MAX) return refuse('invalid_args', 'validation', `material is a voxel material id (1-${MATERIAL_ID_MAX})`, '/args/material');
  const made = kitTestScene(WORLD_RULES, { origin: origin as [number, number, number], material });
  const [x0, y0, z0] = made.min;
  const [x1, y1, z1] = made.max;
  const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const s = world.opts.grid.shift;
  const chunks: ChunkCoord[] = [];
  for (let cx = x0 >> s; cx <= x1 >> s; cx++) for (let cy = y0 >> s; cy <= y1 >> s; cy++) for (let cz = z0 >> s; cz <= z1 >> s; cz++) chunks.push({ cx, cy, cz });
  await world.ensure(chunks);
  const store = world.store;
  const before: number[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) before.push(valueOf(store.voxelAt(x, y, z, v)));
  const record: ChunkUndo[] = [];
  let parts = 0;
  const swaps = new Set<number>();
  try {
    for (const cmd of made.commands) {
      const out = world.edit(canonicalEditCommand(cmd));
      record.unshift(...out.chunks);
      parts |= out.parts;
      for (const sw of out.materialSwaps) swaps.add(sw);
    }
  } catch (e) {
    world.undo(record);
    if (e instanceof EditRefused) return refuse(e.code, e.code === 'chunk_not_loaded' ? 'conflict' : 'validation', e.message);
    throw e;
  }
  let cells = 0;
  let k = 0;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) if (valueOf(store.voxelAt(x, y, z, v)) !== before[k++]) cells++;
  if (cells === 0) {
    world.undo(record);
    return refuse('no_change', 'validation', 'the kit test scene is already there: it changes no voxel');
  }
  const box: CellBox = { minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1 };
  return { ok: true, record, cells, box, parts, materialSwaps: [...swaps].sort((p, q) => p - q), scene: { min: made.min, max: made.max, labels: made.labels } };
}
