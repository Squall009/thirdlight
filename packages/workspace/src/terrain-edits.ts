/**
 * The host's part of `editTerrain` and of every change that names terrain
 * tiles.
 *
 * An edit: read the tiles it reaches (verified blobs, gunzipped and decoded),
 * read and decode an import's staged heightmap, plan the edit with the
 * command package's pure planner, then encode each tile it wrote into a
 * gzip blob and hand the new digests to the command. The blobs are published
 * only once the command passed its checks, since nothing collects an unused
 * blob. A tile that is flat at 0 m and bare again is stored without data.
 *
 * Tiles are stored gzip-compressed, the form a game's page inflates with the
 * browser's own DecompressionStream, so a build ships the project's blobs as
 * they are (one digest from edit to export).
 *
 * Any change that names tile digests (a `setComponent terrain` from MCP, an
 * undo) has them checked: each new one must be a stored tile blob of the
 * terrain's tile size, each new scatter digest a stored scatter blob.
 *
 * A tile's scatter (`terrain-scatter.ts`) is a blob of its own beside its
 * data, so a stroke on the copies writes only it.
 */
import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';

import { planTerrainEdit, terrainTilesAfter, validateEditTerrainArgs, type CommandError, type ContentDocument, type PreparedTerrainEdit, type SceneDocument } from '@thirdlight/commands';
import {
  decodeHeightmap,
  decodeTerrainTile,
  encodeTerrainTile,
  readTerrainTileBlob,
  scatterBlobOf,
  scatterCellOfBlob,
  terrainFlatStep,
  terrainTileKey,
  wrapTerrainTile,
  type Heightmap,
  type ScatterCell,
  type TerrainComponent,
  type TerrainTile,
} from '@thirdlight/project-model';

import { publishBlob, readSourceBlob, resolveStage, type ContentContext } from './content-store';
import { sha256Hex } from './digest';
import { contentCtx } from './service-content';
import type { Core, ProjectSession } from './session';

/** An edit's new tile blobs, held until the command is accepted. */
export interface TerrainBlob {
  readonly digest: string;
  readonly bytes: Uint8Array;
}

/** What a tile blob holds, read back (throws a short message when it is not a tile). */
export function terrainTileOfBlob(bytes: Uint8Array): TerrainTile {
  const h = readTerrainTileBlob(bytes);
  const raw = h.compression === 'gzip' ? new Uint8Array(gunzipSync(h.stored, { maxOutputLength: Math.max(1, h.rawLength) })) : h.compression === 'none' ? h.stored : null;
  if (raw === null) throw new Error('terrain tile binary: tiles are stored gzip or uncompressed');
  if (raw.length !== h.rawLength) throw new Error(`terrain tile binary: the header says ${h.rawLength} bytes, the blob holds ${raw.length}`);
  return decodeTerrainTile(raw);
}

/** A tile as its stored blob (gzip). */
export function terrainBlobOf(tile: TerrainTile): TerrainBlob {
  const encoded = encodeTerrainTile(tile);
  const bytes = wrapTerrainTile('gzip', encoded, new Uint8Array(gzipSync(encoded.payload)));
  return { digest: sha256Hex(bytes), bytes };
}

const isBare = (t: TerrainTile, flat: number): boolean => t.weights === null && t.holes === null && t.paint === null && t.heights.every((h) => h === flat);

function badTile(digest: string, message: string): CommandError {
  return { code: 'field_value', cls: 'validation', path: '/args', message: `terrain tile ${digest.slice(0, 12)}…: ${message}`.slice(0, 256), expected: 'a terrain tile blob' } as CommandError;
}

/** Read one tile's scatter blob by digest (verified), decoded. */
function readScatter(core: Core, ctx: ContentContext, digest: string): { ok: true; cell: ScatterCell } | { ok: false; error: CommandError } {
  const r = readSourceBlob(core, ctx, { digest });
  if (!r.ok) return r;
  try {
    return { ok: true, cell: scatterCellOfBlob(r.bytes) };
  } catch (e) {
    return { ok: false, error: badTile(digest, e instanceof Error ? e.message : String(e)) };
  }
}

/** Read one tile blob by digest (verified), decoded. */
function readTile(core: Core, ctx: ContentContext, digest: string): { ok: true; tile: TerrainTile } | { ok: false; error: CommandError } {
  const r = readSourceBlob(core, ctx, { digest });
  if (!r.ok) return r;
  try {
    return { ok: true, tile: terrainTileOfBlob(r.bytes) };
  } catch (e) {
    return { ok: false, error: badTile(digest, e instanceof Error ? e.message : String(e)) };
  }
}

export function prepareTerrainEdit(core: Core, s: ProjectSession, scene: SceneDocument, content: ContentDocument | undefined, args: Record<string, unknown>): { ok: true; prepared: PreparedTerrainEdit; blobs: TerrainBlob[] } | { ok: false; error: CommandError } {
  const v = validateEditTerrainArgs(args);
  if (!v.ok) return v;
  const ctx = contentCtx(s);
  let heightmap: Heightmap | undefined;
  if (v.args.kind === 'import') {
    const stage = resolveStage(core, ctx, v.args.stageId);
    if (!stage.ok) return stage;
    const size = v.args.size;
    const map = decodeHeightmap(stage.stage.bytes, {
      format: v.args.format!,
      ...(size !== undefined ? { width: size[0], height: size[1] } : {}),
      ...(v.args.byteOrder !== undefined ? { byteOrder: v.args.byteOrder } : {}),
      inflate: (data, maxOut) => new Uint8Array(inflateSync(data, { maxOutputLength: Math.max(1, maxOut) })),
    });
    if (!map.ok) return { ok: false, error: { code: 'field_value', cls: 'validation', path: '/args/stageId', message: `the heightmap cannot be read: ${map.message}`.slice(0, 256), expected: `a ${v.args.format} heightmap` } as CommandError };
    heightmap = map.map;
  }
  const plan = planTerrainEdit(scene, content, v.args, (digest) => readTile(core, ctx, digest), heightmap, (digest) => readScatter(core, ctx, digest));
  if (!plan.ok) return plan;
  const comp = plan.plan.component;
  const flat = terrainFlatStep(comp.heightRange);
  const digests = new Map<string, string | null>();
  const blobs: TerrainBlob[] = [];
  const old = new Map(comp.tiles.map((t) => [terrainTileKey(t.x, t.z), t.data ?? null]));
  const touched: [number, number][] = [];
  for (const [key, tile] of plan.plan.tiles) {
    let digest: string | null = null;
    if (!isBare(tile, flat)) {
      const blob = terrainBlobOf(tile);
      digest = blob.digest;
      blobs.push(blob);
    }
    digests.set(key, digest);
    if (old.get(key) !== digest || !old.has(key)) touched.push(key.split(',').map(Number) as [number, number]);
  }
  touched.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  // Each tile's scatter the edit changed: a blob of its own (null: none left on it).
  const scatterDigests = new Map<string, string | null>();
  const oldScatter = new Map(comp.tiles.map((t) => [terrainTileKey(t.x, t.z), t.scatter ?? null]));
  const scattered: [number, number][] = [];
  for (const [key, cell] of plan.plan.scatter) {
    const bytes = scatterBlobOf(cell);
    const digest = bytes === null ? null : sha256Hex(bytes);
    if (bytes !== null) blobs.push({ digest: digest!, bytes });
    if ((oldScatter.get(key) ?? null) === digest) continue;
    scatterDigests.set(key, digest);
    scattered.push(key.split(',').map(Number) as [number, number]);
  }
  scattered.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  // Beside splines, each tile's hand-made form the edit changed: always a blob (null: no spline reaches it any more).
  const baseDigests = new Map<string, string | null>();
  for (const [key, tile] of plan.plan.bases) {
    if (tile === null) {
      baseDigests.set(key, null);
      continue;
    }
    const blob = terrainBlobOf(tile);
    blobs.push(blob);
    baseDigests.set(key, blob.digest);
  }
  const value: TerrainComponent = {
    ...comp,
    tiles: terrainTilesAfter(comp, digests, scatterDigests, baseDigests),
    ...(plan.plan.rules !== undefined ? { rules: plan.plan.rules } : {}),
    ...(plan.plan.scatterRules !== undefined ? { scatter: plan.plan.scatterRules } : {}),
  };
  return {
    ok: true,
    prepared: { entityId: v.args.entityId, value, touched, added: plan.plan.added, changed: plan.plan.changed, ...(plan.plan.clamped !== undefined ? { clamped: plan.plan.clamped } : {}), ...(scattered.length > 0 ? { scatter: scattered } : {}) },
    blobs,
  };
}

/** Publish an accepted edit's tiles (just before its change is written). */
export function publishTerrainBlobs(core: Core, s: ProjectSession, blobs: readonly TerrainBlob[]): CommandError | null {
  for (const b of blobs) {
    const put = publishBlob(core, contentCtx(s), { digest: b.digest, byteLength: b.bytes.byteLength, source: { kind: 'bytes', bytes: b.bytes } });
    if (!put.ok) return put.error;
  }
  return null;
}

type Entity = { id: string; components: { terrain?: TerrainComponent } };

/**
 * Check the tiles a change names that the scene did not name before (at that
 * tile size): each is a stored tile blob of the terrain's size. `inHand` are
 * the edit's own blobs (published after this check).
 */
export function verifyTerrainTiles(core: Core, s: ProjectSession, before: readonly Entity[], after: readonly Entity[], inHand: readonly TerrainBlob[]): CommandError | null {
  const ctx = contentCtx(s);
  const own = new Set(inHand.map((b) => b.digest));
  const prior = new Map(before.map((e) => [e.id, e.components.terrain]));
  for (const e of after) {
    const t = e.components.terrain;
    if (t === undefined) continue;
    const was = prior.get(e.id);
    const known = new Set(was !== undefined && was.tileSamples === t.tileSamples ? was.tiles.flatMap((x) => [x.data, x.base]).filter((d) => d !== undefined) : []);
    const knownScatter = new Set(was !== undefined ? was.tiles.map((x) => x.scatter).filter((d) => d !== undefined) : []);
    for (const tile of t.tiles) {
      if (tile.scatter !== undefined && !knownScatter.has(tile.scatter) && !own.has(tile.scatter)) {
        const r = readSourceBlob(core, ctx, { digest: tile.scatter });
        if (!r.ok) return r.error;
        try {
          scatterCellOfBlob(r.bytes);
        } catch (err) {
          return badTile(tile.scatter, err instanceof Error ? err.message : String(err));
        }
      }
      for (const digest of [tile.data, tile.base]) {
        if (digest === undefined || known.has(digest) || own.has(digest)) continue;
        const r = readSourceBlob(core, ctx, { digest });
        if (!r.ok) return r.error;
        try {
          const h = readTerrainTileBlob(r.bytes);
          if (h.samples !== t.tileSamples) return badTile(digest, `holds ${h.samples} samples a side, the terrain ${t.tileSamples}`);
        } catch (err) {
          return badTile(digest, err instanceof Error ? err.message : String(err));
        }
      }
    }
  }
  return null;
}
