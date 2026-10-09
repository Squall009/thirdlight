/**
 * Live blocks: a block type marked `live` spawns its prefab variant as a real
 * entity per cell while the game runs (a door, a lamp, a trigger, a sound),
 * with its scripts, movers, lights and children. The cell is what is
 * authored and saved; the entity is the runtime's and never in a scene file.
 *
 * The prefab's root is the cell's static part: the chunk mesh draws its model
 * merged with the other blocks (as for any prefab look), so the spawned root
 * carries no model, and nothing may move or animate it. Moving parts (a door
 * leaf, a lever) are its children. A root without a model draws nothing in
 * the chunk (a logic-only cell: a trigger, a sound).
 *
 * Ids come from the cell, so a cell names the same objects in every run, in
 * a replay and after a save is loaded, and a layer's live blocks never use
 * the scene's id space: `<layer>-<x>_<y>_<z>` for the root (negative
 * coordinates as `m<n>`), `-<i>` after it for the prefab's i-th object. A
 * live edge piece (`block-edges.ts`: a door) is named by its edge the same
 * way with `x` or `z` after the coordinates (an edge on an x or a z line). A
 * layer id too long to fit the id syntax is shortened to a hash of it.
 *
 * Pure data rules; the runtime keeps the entities (`runtime/src/live-blocks.ts`).
 */
import type { BlockType } from './block-layers';
import { ID_MAX_LENGTH } from './validate';

/** The root's components that would move or animate the model the chunk draws merged: refused on a live block's prefab root. */
export const LIVE_BLOCK_ROOT_REFUSED: readonly string[] = Object.freeze(['mover', 'patrol', 'gravity', 'animator', 'modelAnimation', 'socketAttach']);
/** Components no object of a live block's prefab may carry (a player body, a nested layer). */
export const LIVE_BLOCK_PREFAB_REFUSED: readonly string[] = Object.freeze(['controller', 'blockLayer']);

/** The root components the spawned root leaves to the chunk mesh (its model is drawn merged with the blocks). */
export const LIVE_BLOCK_ROOT_MERGED: readonly string[] = Object.freeze(['model', 'materials', 'materialParams']);

/**
 * Room kept for a child's `-<i>`: up to 9,999 objects, above the prefab
 * limit so raising that limit does not rename the live blocks of layers
 * with ids near the length limit.
 */
const CHILD_SUFFIX_MAX = 5;
/**
 * The longest cell part (`m4096_m1024_m4096`, an edge's with its axis
 * letter) the layer bounds (`BLOCK_LIMITS`) allow. A number, not read from
 * them: block-layers imports this module, so its limits are not there yet
 * while this one loads; a test holds the two together.
 */
export const LIVE_CELL_PART_MAX = 18;

const coord = (n: number): string => (n < 0 ? `m${-n}` : String(n));

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The prefix a layer's live block ids start with (its id, or a hash of a long one). */
export function liveBlockPrefix(layerId: string): string {
  return layerId.length + 1 + LIVE_CELL_PART_MAX + CHILD_SUFFIX_MAX <= ID_MAX_LENGTH ? layerId : `l${fnv1a(layerId)}`;
}

/** The id of a live block's root object (its anchor cell's). */
export function liveBlockRootId(layerId: string, x: number, y: number, z: number): string {
  return `${liveBlockPrefix(layerId)}-${coord(x)}_${coord(y)}_${coord(z)}`;
}

/** The id of a live edge piece's root object (its edge's: x, y, z and the line it stands on). */
export function liveEdgeRootId(layerId: string, x: number, y: number, z: number, axis: number): string {
  return `${liveBlockRootId(layerId, x, y, z)}${axis === 0 ? 'x' : 'z'}`;
}

/** The ids of a live block's objects: the root, then `-<i>` for the prefab's other objects in its order. */
export function liveBlockIds(rootId: string, count: number): string[] {
  const ids = [rootId];
  for (let i = 1; i < count; i++) ids.push(`${rootId}-${i}`);
  return ids;
}

/**
 * Where a live block's root stands: the bottom centre of its footprint
 * (`f`: turned by the rotation, `rotatedFootprint`), turned by the
 * cell's rotation about +Y, unit scale — the frame the chunk mesh draws the
 * prefab's model in.
 */
export function liveBlockPlacement(
  origin: { x: number; y: number; z: number },
  cellSize: readonly number[],
  f: readonly number[],
  rot: number | undefined,
  x: number,
  y: number,
  z: number,
): { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] } {
  const a = (((rot ?? 0) * Math.PI) / 180) / 2;
  return {
    position: [origin.x + (x + f[0]! / 2) * cellSize[0]!, origin.y + y * cellSize[1]!, origin.z + (z + f[2]! / 2) * cellSize[2]!],
    rotation: rot === undefined || rot === 0 ? [0, 0, 0, 1] : [0, Math.sin(a), 0, Math.cos(a)],
    scale: [1, 1, 1],
  };
}

/** Whether a block type spawns entities (a live type with at least one prefab look). */
export function blockTypeLive(t: Pick<BlockType, 'live' | 'variants'>): boolean {
  return t.live === true && t.variants.some((v) => v.prefab !== undefined);
}

/** Why a prefab cannot be a live block's (null: it can). */
export function liveBlockPrefabProblem(prefab: { readonly entities: readonly { readonly parentLocalId?: string; readonly keepLoaded?: boolean; readonly components: Readonly<Record<string, unknown>> }[] }): string | null {
  const root = prefab.entities.find((e) => e.parentLocalId === undefined);
  if (root === undefined) return 'the prefab has no root object';
  const moving = LIVE_BLOCK_ROOT_REFUSED.filter((c) => root.components[c] !== undefined);
  if (moving.length > 0) return `its root is the cell's static part (drawn merged with the blocks) and cannot carry ${moving.join(', ')}: put moving parts on a child`;
  for (const e of prefab.entities) {
    const bad = LIVE_BLOCK_PREFAB_REFUSED.filter((c) => e.components[c] !== undefined);
    if (bad.length > 0) return `a live block cannot carry ${bad.join(', ')}`;
    if (e.keepLoaded === true) return 'a live block comes and goes with its cell: no object of it is kept loaded';
  }
  return null;
}
