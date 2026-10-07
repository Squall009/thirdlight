/**
 * `queryTerrain` — a project's terrains for editors, MCP and tools.
 * `{sceneId?}` lists them (component, tiles, stored and in-memory bytes);
 * `{entityId}` one terrain with each tile's digest and bytes; `points:
 * [[x, z], …]` (world) adds the surface there (height, normal, slope, hole,
 * layers) from the stored tiles, read the way a game reads them.
 *
 * Memory is what the tiles take decoded (a game holds them so for its
 * renderer and colliders): a terrain has no tile cap, so this is what bounds
 * it.
 */
import { TerrainField, flatTerrainTile, terrainFlatStep, terrainTileBlobBytes, terrainTileBytes, terrainTileKey, type SceneV4, type TerrainComponent, type TerrainTile } from '@thirdlight/project-model';

import { readSourceBlob } from './content-store';
import { entityNotFound, fieldTypeError, fieldUnexpected, fieldValueType, pointerSegment } from './errors';
import { contentCtx } from './service-content';
import type { Core, ProjectSession } from './session';
import { terrainTileOfBlob } from './terrain-edits';
import type { QueryResult } from './types';

/** The most points one query asks about. */
export const TERRAIN_QUERY_POINTS_MAX = 1024;

function failure(projectId: string, error: import('@thirdlight/commands').CommandError): QueryResult {
  return { ok: false, op: 'queryTerrain', projectId, error } as unknown as QueryResult;
}

export function serveQueryTerrain(core: Core, s: ProjectSession, projectId: string, a: Record<string, unknown>): QueryResult {
  const state = s.v4!;
  for (const k of Object.keys(a)) if (!['sceneId', 'entityId', 'points'].includes(k)) return failure(projectId, fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'sceneId, entityId, points'));
  const ctx = contentCtx(s);
  const terrainsOf = (sc: SceneV4): { entityId: string; sceneId: string; component: TerrainComponent; origin: number[] }[] =>
    sc.entities
      .filter((e) => (e.components as { terrain?: unknown }).terrain !== undefined)
      .map((e) => ({ entityId: e.id, sceneId: sc.sceneId, component: (e.components as { terrain: TerrainComponent }).terrain, origin: (e.components as { transform?: { position?: number[] } }).transform?.position ?? [0, 0, 0] }));
  /** Each tile's stored and decoded bytes (a tile without data: the flat heights a game makes for it). */
  const sizes = (c: TerrainComponent): { x: number; z: number; data: string | null; storedBytes: number; memoryBytes: number }[] | { error: import('@thirdlight/commands').CommandError } => {
    const out: { x: number; z: number; data: string | null; storedBytes: number; memoryBytes: number }[] = [];
    for (const t of c.tiles) {
      if (t.data === undefined) {
        out.push({ x: t.x, z: t.z, data: null, storedBytes: 0, memoryBytes: c.tileSamples * c.tileSamples * 2 });
        continue;
      }
      const r = readSourceBlob(core, ctx, { digest: t.data });
      if (!r.ok) return { error: r.error };
      let memoryBytes = 0;
      try {
        memoryBytes = terrainTileBlobBytes(r.bytes);
      } catch {
        memoryBytes = 0;
      }
      out.push({ x: t.x, z: t.z, data: t.data, storedBytes: r.byteLength, memoryBytes });
    }
    return out;
  };
  const summary = (t: { entityId: string; sceneId: string; component: TerrainComponent }): Record<string, unknown> | { error: import('@thirdlight/commands').CommandError } => {
    const z = sizes(t.component);
    if ('error' in z) return z;
    const { tiles: _tiles, ...fields } = t.component;
    return { entityId: t.entityId, sceneId: t.sceneId, ...fields, tiles: z.length, tilesWithData: z.filter((x) => x.data !== null).length, storedBytes: z.reduce((n, x) => n + x.storedBytes, 0), memoryBytes: z.reduce((n, x) => n + x.memoryBytes, 0) };
  };
  if (a['entityId'] === undefined) {
    if (a['points'] !== undefined) return failure(projectId, fieldValueType('/args/points', a['points'], 'with entityId', 'points are asked of one terrain: give its entityId'));
    const sceneId = a['sceneId'];
    if (sceneId !== undefined && (typeof sceneId !== 'string' || !state.scenes.has(sceneId))) return failure(projectId, fieldValueType('/args/sceneId', sceneId, 'a scene id of the project', 'no such scene'));
    const scenes = sceneId !== undefined ? [state.scenes.get(sceneId as string)!] : [...state.scenes.values()];
    const terrains: Record<string, unknown>[] = [];
    for (const t of scenes.flatMap(terrainsOf)) {
      const row = summary(t);
      if ('error' in row) return failure(projectId, row.error as import('@thirdlight/commands').CommandError);
      terrains.push(row);
    }
    return { ok: true, projectId, revision: state.revision, terrains } as unknown as QueryResult;
  }
  const entityId = a['entityId'];
  if (typeof entityId !== 'string') return failure(projectId, fieldTypeError('/args/entityId', entityId, 'string'));
  const t = [...state.scenes.values()].flatMap(terrainsOf).find((x) => x.entityId === entityId);
  if (t === undefined) return failure(projectId, entityNotFound(entityId));
  const row = summary(t);
  if ('error' in row) return failure(projectId, row.error as import('@thirdlight/commands').CommandError);
  const tiles = sizes(t.component) as Exclude<ReturnType<typeof sizes>, { error: unknown }>;
  const out: Record<string, unknown> = { ok: true, projectId, revision: state.revision, ...row, component: t.component, tileRows: tiles };
  const points = a['points'];
  if (points !== undefined) {
    if (!Array.isArray(points) || points.length > TERRAIN_QUERY_POINTS_MAX || !points.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)))) {
      return failure(projectId, fieldValueType('/args/points', points, `up to ${TERRAIN_QUERY_POINTS_MAX} [x, z] world points`, 'points is a list of [x, z]'));
    }
    // Only the tiles under the points are read.
    const c = t.component;
    const size = (c.tileSamples - 1) * c.spacing;
    const want = new Set((points as number[][]).map(([x, z]) => terrainTileKey(Math.floor((x! - (t.origin[0] ?? 0)) / size), Math.floor((z! - (t.origin[2] ?? 0)) / size))));
    const loaded = new Map<string, TerrainTile>();
    for (const ref of c.tiles) {
      const key = terrainTileKey(ref.x, ref.z);
      if (!want.has(key)) continue;
      if (ref.data === undefined) {
        loaded.set(key, flatTerrainTile(c.tileSamples, terrainFlatStep(c.heightRange)));
        continue;
      }
      const r = readSourceBlob(core, ctx, { digest: ref.data });
      if (!r.ok) return failure(projectId, r.error);
      try {
        loaded.set(key, terrainTileOfBlob(r.bytes));
      } catch (e) {
        return failure(projectId, fieldValueType('/args/entityId', entityId, 'readable tiles', `tile [${key}] cannot be read: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    const field = new TerrainField(c, t.origin, loaded);
    out['points'] = (points as number[][]).map(([x, z]) => {
      const smp = field.sample(x!, z!);
      return smp === null ? { x, z, height: null, hole: field.holeAt(x!, z!) } : { x, z, ...smp, hole: false };
    });
    out['loadedBytes'] = [...loaded.values()].reduce((n, tile) => n + terrainTileBytes(tile), 0);
  }
  return out as unknown as QueryResult;
}
