/**
 * Terrains follow the block layers they meet (a `blocks` edit layer,
 * `terrain-blocks.ts`): the block layers a blocks layer names read from the
 * scene, and the world boxes a change of them reaches.
 *
 * A block edit re-bakes a terrain only round the columns it changed: the
 * columns whose cells differ between the chunks before and after (a chunk
 * whose paint changed: all of it), grown by a larger block's reach and the
 * blend. A block layer moved, re-gridded, given other rules or another top
 * subdivision, added or removed: its whole footprint before and after.
 *
 * Pure.
 */
import { CHUNK_SIZE, TERRAIN_BLOCKS_BLEND_DEFAULT, TerrainBlockSeam, terrainLayerOrder, type BlockChunk, type BlockLayerComponent, type BlockType, type ScatterRect, type TerrainBlocksLayer, type TerrainBlocksSource, type TerrainComponent } from '@thirdlight/project-model';

import { layerDataOf } from './block-ops';
import type { SceneDocument } from './types';

type SceneEntity = { id: string; components: Record<string, unknown> };

/** Cells round a changed column whose ground a change may move: a larger block's footprint (at most 8 cells) and the corner it shares. */
const CHANGE_MARGIN_CELLS = 9;

function positionOf(e: SceneEntity): [number, number, number] {
  const p = (e.components['transform'] as { position?: number[] } | undefined)?.position ?? [0, 0, 0];
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

/** The block layer objects a blocks layer meets: those it names (that exist), else every block layer of the scene, in scene order. */
export function blocksLayerEntities(scene: SceneDocument, layer: Pick<TerrainBlocksLayer, 'blockLayers'>): SceneEntity[] {
  const all = (scene.entities as unknown as SceneEntity[]).filter((e) => e.components['blockLayer'] !== undefined);
  if (layer.blockLayers === undefined) return all;
  const named = new Set(layer.blockLayers);
  return all.filter((e) => named.has(e.id));
}

/** The block layers a blocks layer meets, as the seam reads them. */
export function terrainBlocksSources(scene: SceneDocument, layer: Pick<TerrainBlocksLayer, 'blockLayers'>, types: ReadonlyMap<string, BlockType>): TerrainBlocksSource[] {
  return blocksLayerEntities(scene, layer).map((e) => ({ id: e.id, component: e.components['blockLayer'] as BlockLayerComponent, data: layerDataOf(scene, e.id), types, origin: positionOf(e) }));
}

/** A terrain's seams with the block layers of a scene: what `TerrainLayerStack` asks for each blocks layer. */
export function terrainBlockSeams(scene: SceneDocument, comp: TerrainComponent, origin: readonly number[], types: ReadonlyMap<string, BlockType>): (layer: TerrainBlocksLayer) => TerrainBlockSeam | null {
  return (layer) => {
    const sources = terrainBlocksSources(scene, layer, types);
    if (sources.length === 0) return null;
    return new TerrainBlockSeam(sources, { mode: layer.mode ?? 'cut', blend: layer.blend ?? TERRAIN_BLOCKS_BLEND_DEFAULT, paint: layer.paint !== false }, comp, origin);
  };
}

/** The blocks layers of a terrain that apply. */
function liveBlocksLayers(comp: TerrainComponent | undefined): TerrainBlocksLayer[] {
  if (comp?.layers === undefined) return [];
  return terrainLayerOrder(comp).filter((l): l is TerrainBlocksLayer => l.kind === 'blocks' && l.enabled !== false && (l.strength ?? 1) > 0);
}

/** The world box a block layer's chunks cover (null: none). */
function chunksRect(comp: BlockLayerComponent, origin: readonly number[], chunks: readonly BlockChunk[] | undefined): ScatterRect | null {
  let r: ScatterRect | null = null;
  const [cw, , cd] = comp.cellSize;
  for (const c of chunks ?? []) {
    const b: ScatterRect = [origin[0]! + c.cx * CHUNK_SIZE * cw, origin[2]! + c.cz * CHUNK_SIZE * cd, origin[0]! + (c.cx + 1) * CHUNK_SIZE * cw, origin[2]! + (c.cz + 1) * CHUNK_SIZE * cd];
    r = r === null ? b : [Math.min(r[0], b[0]), Math.min(r[1], b[1]), Math.max(r[2], b[2]), Math.max(r[3], b[3])];
  }
  return r;
}

/** A column's cells as a comparable string (its runs with their cells, whatever the chunk's palette). */
function columnKeyOf(c: BlockChunk, col: readonly number[]): string {
  const parts: string[] = [];
  for (let r = 2; r < col.length; r += 3) parts.push(`${col[r]}:${col[r + 1]}:${JSON.stringify(c.palette[col[r + 2]!])}`);
  return parts.join('|');
}

/** The cells (layer x, z) whose columns differ between two versions of one chunk; the whole chunk when its paint differs. */
function changedColumns(a: BlockChunk | undefined, b: BlockChunk | undefined, cx: number, cz: number): [number, number, number, number] | null {
  const whole: [number, number, number, number] = [cx * CHUNK_SIZE, cz * CHUNK_SIZE, (cx + 1) * CHUNK_SIZE - 1, (cz + 1) * CHUNK_SIZE - 1];
  if ((a?.paint ?? null) !== (b?.paint ?? null)) return whole;
  const cols = (c: BlockChunk | undefined): Map<number, string> => new Map((c?.columns ?? []).map((col) => [col[1]! * CHUNK_SIZE + col[0]!, columnKeyOf(c!, col)]));
  const ca = cols(a);
  const cb = cols(b);
  let box: [number, number, number, number] | null = null;
  for (const k of new Set([...ca.keys(), ...cb.keys()])) {
    if (ca.get(k) === cb.get(k)) continue;
    const x = cx * CHUNK_SIZE + (k % CHUNK_SIZE);
    const z = cz * CHUNK_SIZE + Math.floor(k / CHUNK_SIZE);
    box = box === null ? [x, z, x, z] : [Math.min(box[0], x), Math.min(box[1], z), Math.max(box[2], x), Math.max(box[3], z)];
  }
  return box;
}

/** The component fields the ground a block layer gives a terrain depends on. */
const groundKey = (c: BlockLayerComponent | undefined): string => (c === undefined ? '' : JSON.stringify([c.cellSize, c.bounds, c.metadataOnly ?? false, c.rules ?? null, c.topSubdivision ?? 1]));

/** The world boxes (before and after) where a block layer's change moves what it gives a terrain; empty: nothing. */
function blockLayerChangeRects(before: SceneDocument, after: SceneDocument, id: string, grow: number): ScatterRect[] {
  const e0 = (before.entities as unknown as SceneEntity[]).find((e) => e.id === id);
  const e1 = (after.entities as unknown as SceneEntity[]).find((e) => e.id === id);
  const c0 = e0?.components['blockLayer'] as BlockLayerComponent | undefined;
  const c1 = e1?.components['blockLayer'] as BlockLayerComponent | undefined;
  const d0 = c0 !== undefined ? layerDataOf(before, id) : null;
  const d1 = c1 !== undefined ? layerDataOf(after, id) : null;
  const out: ScatterRect[] = [];
  const g = (r: ScatterRect | null): void => {
    if (r !== null) out.push([r[0] - grow, r[1] - grow, r[2] + grow, r[3] + grow]);
  };
  const p0 = e0 !== undefined ? positionOf(e0) : null;
  const p1 = e1 !== undefined ? positionOf(e1) : null;
  if (c0 === undefined || c1 === undefined || groundKey(c0) !== groundKey(c1) || JSON.stringify(p0) !== JSON.stringify(p1)) {
    if (c0 !== undefined) g(chunksRect(c0, p0!, d0?.chunks));
    if (c1 !== undefined) g(chunksRect(c1, p1!, d1?.chunks));
    return out;
  }
  if (d0 === d1) return out;
  const m0 = new Map((d0?.chunks ?? []).map((c) => [`${c.cx},${c.cz}`, c]));
  const m1 = new Map((d1?.chunks ?? []).map((c) => [`${c.cx},${c.cz}`, c]));
  const [cw, , cd] = c1.cellSize;
  for (const key of new Set([...m0.keys(), ...m1.keys()])) {
    const a = m0.get(key);
    const b = m1.get(key);
    if (a === b) continue;
    const [cx, cz] = key.split(',').map(Number) as [number, number];
    const box = changedColumns(a, b, cx, cz);
    if (box === null) continue;
    g([p1![0] + (box[0] - CHANGE_MARGIN_CELLS) * cw, p1![2] + (box[1] - CHANGE_MARGIN_CELLS) * cd, p1![0] + (box[2] + 1 + CHANGE_MARGIN_CELLS) * cw, p1![2] + (box[3] + 1 + CHANGE_MARGIN_CELLS) * cd]);
  }
  return out;
}

/**
 * The world boxes each terrain of `after` must shape again because a block
 * layer one of its blocks layers meets changed (by terrain id).
 */
export function blockSeamRebakeRects(before: SceneDocument, after: SceneDocument): Map<string, ScatterRect[]> {
  const out = new Map<string, ScatterRect[]>();
  for (const e of after.entities as unknown as SceneEntity[]) {
    const comp = e.components['terrain'] as TerrainComponent | undefined;
    const live = liveBlocksLayers(comp);
    if (live.length === 0) continue;
    const list: ScatterRect[] = [];
    const seen = new Set<string>();
    for (const l of live) {
      const blend = l.blend ?? TERRAIN_BLOCKS_BLEND_DEFAULT;
      // The block layers it met before or meets now.
      const ids = new Set([...blocksLayerEntities(before, l), ...blocksLayerEntities(after, l)].map((b) => b.id));
      for (const id of ids) {
        const key = `${id}:${blend}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(...blockLayerChangeRects(before, after, id, blend));
      }
    }
    if (list.length > 0) out.set(e.id, list);
  }
  return out;
}

/** The box a blocks layer reaches on a terrain now (its block layers' chunks grown by the blend): its extent in the layer list. */
export function blocksLayerRects(scene: SceneDocument, layer: TerrainBlocksLayer): ScatterRect[] {
  const blend = layer.blend ?? TERRAIN_BLOCKS_BLEND_DEFAULT;
  const out: ScatterRect[] = [];
  for (const e of blocksLayerEntities(scene, layer)) {
    const comp = e.components['blockLayer'] as BlockLayerComponent;
    const r = chunksRect(comp, positionOf(e), layerDataOf(scene, e.id)?.chunks);
    if (r !== null) out.push([r[0] - blend - CHANGE_MARGIN_CELLS * comp.cellSize[0], r[1] - blend - CHANGE_MARGIN_CELLS * comp.cellSize[2], r[2] + blend + CHANGE_MARGIN_CELLS * comp.cellSize[0], r[3] + blend + CHANGE_MARGIN_CELLS * comp.cellSize[2]]);
  }
  return out;
}

/**
 * Where a terrain's texture coordinates should count from: the origin of the
 * first block layer its first blocks layer meets (null: it meets none, the
 * stored one stands).
 */
export function blocksUvOrigin(scene: SceneDocument, comp: TerrainComponent): [number, number] | null {
  for (const l of liveBlocksLayers(comp)) {
    const first = blocksLayerEntities(scene, l)[0];
    if (first === undefined) continue;
    const p = positionOf(first);
    return [p[0], p[2]];
  }
  return null;
}
