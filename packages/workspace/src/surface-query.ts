/**
 * `querySurface` — the ground at world points for editors, MCP and tools:
 * `{points: [[x, z] | [x, y, z], …], sceneId?}` answers each point with the
 * height, normal, slope and material layer weights of whichever block layer
 * or terrain is there (`surface-query.ts`: the highest ground at or below
 * the point — [x, z] asks for the top — a block layer on a tie), read from
 * the stored cells and tiles the way a game's `ctx.surface` reads them.
 * Without `sceneId` every scene's block layers and terrains are asked (a
 * game loads scenes into one world).
 *
 * Only the terrain tiles under the points are read.
 */
import { blockTypesOf, layerDataOf, type CommandError, type ContentDocument, type SceneDocument } from '@thirdlight/commands';
import {
  BlockGrid,
  SurfaceRuleSet,
  TerrainField,
  blockKitView,
  flatTerrainTile,
  footprintAnchors,
  surfaceAt,
  terrainFlatStep,
  terrainTileKey,
  terrainTileSize,
  type BlockLayerComponent,
  type SceneV4,
  type SurfaceSource,
  type TerrainComponent,
  type TerrainTile,
} from '@thirdlight/project-model';

import { readSourceBlob } from './content-store';
import { fieldUnexpected, fieldValueType, pointerSegment } from './errors';
import { contentCtx } from './service-content';
import type { Core, ProjectSession } from './session';
import { terrainTileOfBlob } from './terrain-edits';
import { TERRAIN_QUERY_POINTS_MAX } from './terrain-query';
import type { QueryResult } from './types';

function failure(projectId: string, error: CommandError): QueryResult {
  return { ok: false, op: 'querySurface', projectId, error } as unknown as QueryResult;
}

const positionOf = (e: { components: unknown }): number[] => (e.components as { transform?: { position?: number[] } }).transform?.position ?? [0, 0, 0];

export function serveQuerySurface(core: Core, s: ProjectSession, projectId: string, a: Record<string, unknown>): QueryResult {
  const state = s.v4!;
  for (const k of Object.keys(a)) if (!['sceneId', 'points'].includes(k)) return failure(projectId, fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'sceneId, points'));
  const sceneId = a['sceneId'];
  if (sceneId !== undefined && (typeof sceneId !== 'string' || !state.scenes.has(sceneId))) return failure(projectId, fieldValueType('/args/sceneId', sceneId, 'a scene id of the project', 'no such scene'));
  const points = a['points'];
  if (!Array.isArray(points) || points.length === 0 || points.length > TERRAIN_QUERY_POINTS_MAX || !points.every((p) => Array.isArray(p) && (p.length === 2 || p.length === 3) && p.every((v) => typeof v === 'number' && Number.isFinite(v)))) {
    return failure(projectId, fieldValueType('/args/points', points, `1 to ${TERRAIN_QUERY_POINTS_MAX} world points [x, z] or [x, y, z]`, 'points is a list of [x, z] (the top surface) or [x, y, z] (the ground at or below)'));
  }
  const pts = (points as number[][]).map((p) => (p.length === 2 ? { x: p[0]!, y: Infinity, z: p[1]! } : { x: p[0]!, y: p[1]!, z: p[2]! }));
  const scenes = sceneId !== undefined ? [state.scenes.get(sceneId as string)!] : [...state.scenes.values()];
  const content = s.content as unknown as ContentDocument | null;
  const types = new Map((content !== null ? blockTypesOf(content) : []).map((t) => [t.blockId, t]));
  const ctx = contentCtx(s);
  const sources: SurfaceSource[] = [];
  for (const sc of scenes as SceneV4[]) {
    for (const e of sc.entities) {
      const comp = (e.components as { blockLayer?: BlockLayerComponent }).blockLayer;
      if (comp === undefined || comp.metadataOnly === true) continue;
      const grid = blockKitView(BlockGrid.from(comp, layerDataOf(sc as unknown as SceneDocument, e.id)), comp.kits, types);
      const rules = comp.rules !== undefined && comp.rules.length > 0 ? new SurfaceRuleSet(comp.rules) : undefined;
      sources.push({ kind: 'blocks', id: e.id, grid, types, origin: positionOf(e), topSubdivision: comp.topSubdivision ?? 1, wallPaint: comp.wallPaint === true, ...(rules !== undefined ? { rules } : {}), anchorOf: footprintAnchors(grid, types) });
    }
    for (const e of sc.entities) {
      const c = (e.components as { terrain?: TerrainComponent }).terrain;
      if (c === undefined) continue;
      const origin = positionOf(e);
      const size = terrainTileSize(c);
      const want = new Set(pts.map((p) => terrainTileKey(Math.floor((p.x - (origin[0] ?? 0)) / size), Math.floor((p.z - (origin[2] ?? 0)) / size))));
      const tiles = new Map<string, TerrainTile>();
      for (const ref of c.tiles) {
        const key = terrainTileKey(ref.x, ref.z);
        if (!want.has(key)) continue;
        if (ref.data === undefined) {
          tiles.set(key, flatTerrainTile(c.tileSamples, terrainFlatStep(c.heightRange)));
          continue;
        }
        const r = readSourceBlob(core, ctx, { digest: ref.data });
        if (!r.ok) return failure(projectId, r.error);
        try {
          tiles.set(key, terrainTileOfBlob(r.bytes));
        } catch (err) {
          return failure(projectId, fieldValueType('/args/points', points, 'readable terrain tiles', `terrain ${e.id} tile [${key}] cannot be read: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
      sources.push({ kind: 'terrain', id: e.id, field: new TerrainField(c, origin, tiles) });
    }
  }
  const out = pts.map((p) => {
    const at = surfaceAt(sources, p.x, p.y, p.z);
    const where = p.y === Infinity ? { x: p.x, z: p.z } : { x: p.x, y: p.y, z: p.z };
    return at === null ? { ...where, surface: null } : { ...where, surface: at };
  });
  return { ok: true, projectId, revision: state.revision, points: out } as unknown as QueryResult;
}
