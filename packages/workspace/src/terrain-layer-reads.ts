/**
 * The host's part of a terrain's edit layers (`terrain-layers.ts`): reading
 * a stamp's shape and an erosion layer's stored differences for the
 * planners, and `editTerrain` erode.
 *
 * - A stamp's shape is its texture asset's image (the current version's
 *   PNG, or the PNG a KTX2 was made from), first channel at 16 bits. A
 *   texture asset changed after a stamp was placed reaches the ground at the
 *   next combine there (a layer change or an edit under it). A few
 *   decoded shapes stay on the session by the image's digest: a stroke
 *   beside a stamp combines it again without decoding the file again.
 * - An erosion difference is a blob of its own (gzip of "TLTE" steps),
 *   never shipped.
 * - An erode reads the ground below its layer (`erosionInput`), takes the
 *   eroded grid the backend's worker made for the same input when it is
 *   there (`preparedErosion`, matched by a digest of the input), else erodes
 *   in process, stores its layer's new differences and combines the
 *   rectangle again (heights, rules, scatter) — one `setComponent terrain`,
 *   one undo.
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';

import { erosionInput, planErosion, planTerrainSplineRebake, terrainTilesAfter, validateEditTerrainArgs, type CommandError, type ContentDocument, type ErodeArgs, type ErosionInput, type PreparedTerrainEdit, type SceneDocument, type TerrainLayerReads } from '@thirdlight/commands';
import { decodeHeightmap, decodeTerrainDelta, encodeTerrainDelta, scatterBlobOf, terrainFlatStep, terrainTileKey, type Heightmap, type TerrainComponent, type TerrainErosionLayer, type TerrainLayer } from '@thirdlight/project-model';

import { readBlob, readSourceBlob } from './content-store';
import { sha256Hex } from './digest';
import { contentCtx } from './service-content';
import type { Core, ProjectSession } from './session';
import { readScatter, readTile, terrainBlobOf, type TerrainBlob } from './terrain-edits';

/** Decoded stamp shapes kept per session. */
const STAMP_SHAPES_KEPT = 8;

/** One erode's figures. */
export interface ErosionReport {
  /** Samples of the rectangle and tiles combined again. */
  samples: number;
  tiles: number;
  /** Reading the ground below, eroding (0 when the worker's result was taken), storing and combining again (ms). */
  readMs: number;
  erodeMs: number;
  combineMs: number;
  /** The worker's result was used. */
  worker: boolean;
}

function unread(digest: string, what: string, message: string): CommandError {
  return { code: 'field_value', cls: 'validation', path: '/args', message: `${what} ${digest.slice(0, 12)}…: ${message}`.slice(0, 256), expected: what } as CommandError;
}

/** An erosion difference's stored blob (gzip). */
export function deltaBlobOf(samples: number, delta: Int16Array): TerrainBlob {
  const bytes = new Uint8Array(gzipSync(encodeTerrainDelta(samples, delta)));
  return { digest: sha256Hex(bytes), bytes };
}

/** An erosion blob's steps (throws a short message when it is not one). */
export function deltaOfBlob(bytes: Uint8Array): { samples: number; delta: Int16Array } {
  return decodeTerrainDelta(new Uint8Array(gunzipSync(bytes)));
}

/** A texture asset's current version: its number and the digests of its bytes and (a KTX2's) original. */
function textureVersion(content: ContentDocument | null | undefined, assetId: string): { version: number; digest: string; original: string | null } | null {
  const assets = ((content as { assets?: unknown[] } | null | undefined)?.assets ?? []) as { assetId?: string; kind?: string; currentVersion?: number; versions?: { version: number; sourceDigest?: string; convertedFrom?: { sourceDigest?: string } }[] }[];
  const a = assets.find((x) => x.assetId === assetId && x.kind === 'texture');
  const v = a?.versions?.find((x) => x.version === a.currentVersion);
  if (v === undefined || typeof v.sourceDigest !== 'string') return null;
  return { version: v.version, digest: v.sourceDigest, original: v.convertedFrom?.sourceDigest ?? null };
}

const inflate = (data: Uint8Array, maxOut: number): Uint8Array => new Uint8Array(inflateSync(data, { maxOutputLength: Math.max(1, maxOut) }));

/** What the planners read for a terrain's layers, through this session's store. */
export function terrainLayerReads(core: Core, s: ProjectSession, content?: ContentDocument | null): TerrainLayerReads {
  const ctx = contentCtx(s);
  return {
    heightmap: (asset) => {
      const v = textureVersion(content ?? (s.content as unknown as ContentDocument | null), asset);
      if (v === null) return null;
      const kept = s.stampShapes?.get(v.digest);
      if (kept !== undefined) return kept;
      // The version's file (a PNG), else the PNG a KTX2 was made from (its stored original).
      const files: Uint8Array[] = [];
      const r = readBlob(core, ctx, { assetId: asset, version: v.version });
      if (r.ok) files.push(r.bytes);
      if (v.original !== null) {
        const o = readSourceBlob(core, ctx, { digest: v.original });
        if (o.ok) files.push(o.bytes);
      }
      for (const bytes of files) {
        const map = decodeHeightmap(bytes, { format: 'png16', inflate });
        if (!map.ok) continue;
        const shapes = (s.stampShapes ??= new Map<string, Heightmap>());
        if (shapes.size >= STAMP_SHAPES_KEPT) shapes.delete(shapes.keys().next().value!);
        shapes.set(v.digest, map.map);
        return map.map;
      }
      return null;
    },
    delta: (digest) => {
      const r = readSourceBlob(core, ctx, { digest });
      if (!r.ok) return r;
      try {
        return { ok: true, delta: deltaOfBlob(r.bytes).delta };
      } catch (e) {
        return { ok: false, error: unread(digest, 'terrain erosion blob', e instanceof Error ? e.message : String(e)) };
      }
    },
  };
}

/** What an erode's input is, as a digest (its ground, its settings): the worker's result is taken only for the same. */
export function erosionKey(input: ErosionInput): string {
  const h = createHash('sha256');
  h.update(JSON.stringify([input.grid.cols, input.grid.rows, input.grid.spacing, input.grid.region, input.settings]));
  h.update(new Uint8Array(input.grid.heights.buffer, input.grid.heights.byteOffset, input.grid.heights.byteLength));
  return h.digest('hex');
}

/** The input of an erode as the backend's worker takes it (null: the command refuses it; the command says why). */
export function erodeWorkInput(core: Core, s: ProjectSession, scene: SceneDocument, args: Record<string, unknown>): { key: string; input: ErosionInput } | null {
  const v = validateEditTerrainArgs(args);
  if (!v.ok || v.args.kind !== 'erode') return null;
  const ctx = contentCtx(s);
  const got = erosionInput(scene, v.args as ErodeArgs, (d) => readTile(core, ctx, d), terrainLayerReads(core, s));
  if (!got.ok) return null;
  return { key: erosionKey(got.input), input: got.input };
}

/** Plan an erode (the host's part of `editTerrain` erode). */
export function prepareErodeEdit(core: Core, s: ProjectSession, scene: SceneDocument, content: ContentDocument | undefined, args: Record<string, unknown>): { ok: true; prepared: PreparedTerrainEdit; blobs: TerrainBlob[] } | { ok: false; error: CommandError } {
  const v = validateEditTerrainArgs(args);
  if (!v.ok) return v;
  const ctx = contentCtx(s);
  const reads = terrainLayerReads(core, s, content);
  const t0 = performance.now();
  const got = erosionInput(scene, v.args as ErodeArgs, (d) => readTile(core, ctx, d), reads);
  if (!got.ok) return got;
  const input = got.input;
  const t1 = performance.now();
  const prepared = s.preparedErosion;
  s.preparedErosion = undefined;
  const worker = prepared !== undefined && prepared.key === erosionKey(input) ? prepared.heights : null;
  const planned = planErosion(input, worker, reads.delta);
  if (!planned.ok) return planned;
  const t2 = performance.now();
  const plan = planned.plan;
  const comp = input.component;
  // The layer's new differences: a blob a tile (none where nothing is left).
  const blobs: TerrainBlob[] = [];
  const inHand = new Map<string, Int16Array>();
  const layer = plan.layers.find((l) => l.id === plan.layerId) as TerrainErosionLayer;
  const refs = new Map((layer.tiles ?? []).map((t) => [terrainTileKey(t.x, t.z), t]));
  for (const [key, d] of plan.deltas) {
    const [x, z] = key.split(',').map(Number) as [number, number];
    if (d === null) {
      refs.delete(key);
      continue;
    }
    const blob = deltaBlobOf(comp.tileSamples, d);
    blobs.push(blob);
    inHand.set(blob.digest, d);
    refs.set(key, { x, z, data: blob.digest });
  }
  const tiles = [...refs.values()].sort((a, b) => a.z - b.z || a.x - b.x);
  const written: TerrainErosionLayer = { ...layer };
  if (tiles.length > 0) written.tiles = tiles;
  else delete written.tiles;
  const layers: TerrainLayer[] = plan.layers.map((l) => (l.id === plan.layerId ? written : l));
  // The rectangle combined again with the new layer: heights, rules, scatter.
  const nextComp: TerrainComponent = { ...comp, layers };
  const after = { ...scene, entities: (scene.entities as unknown as { id: string; components: Record<string, unknown> }[]).map((e) => (e.id === input.entityId ? { ...e, components: { ...e.components, terrain: nextComp } } : e)) } as unknown as SceneDocument;
  const rebake = planTerrainSplineRebake(after, input.entityId, [plan.rect], (d) => readTile(core, ctx, d), (d) => readScatter(core, ctx, d), reads, inHand);
  if (!rebake.ok) return rebake;
  const r = rebake.plan;
  const flat = terrainFlatStep(comp.heightRange);
  const digests = new Map<string, string | null>();
  const bases = new Map<string, string | null>();
  const scatter = new Map<string, string | null>();
  const touched: [number, number][] = [];
  if (r !== null) {
    for (const [key, tile] of r.tiles) {
      const bare = tile.weights === null && tile.holes === null && tile.paint === null && tile.heights.every((h) => h === flat);
      if (bare) digests.set(key, null);
      else {
        const blob = terrainBlobOf(tile);
        blobs.push(blob);
        digests.set(key, blob.digest);
      }
      touched.push(key.split(',').map(Number) as [number, number]);
    }
    for (const [key, tile] of r.bases) {
      if (tile === null) bases.set(key, null);
      else {
        const blob = terrainBlobOf(tile);
        blobs.push(blob);
        bases.set(key, blob.digest);
      }
    }
    for (const [key, cell] of r.scatter) {
      const bytes = scatterBlobOf(cell);
      const digest = bytes === null ? null : sha256Hex(bytes);
      if (bytes !== null) blobs.push({ digest: digest!, bytes });
      scatter.set(key, digest);
    }
  }
  touched.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const value: TerrainComponent = { ...nextComp, tiles: terrainTilesAfter(comp, digests, scatter, bases) };
  const t3 = performance.now();
  const [sx0, sz0, sx1, sz1] = input.samples;
  s.lastErosion = { samples: (sx1 - sx0 + 1) * (sz1 - sz0 + 1), tiles: touched.length, readMs: t1 - t0, erodeMs: worker !== null ? 0 : t2 - t1, combineMs: t3 - t2, worker: worker !== null };
  return {
    ok: true,
    prepared: { entityId: input.entityId, value, touched, added: [], changed: plan.changed, ...(r !== null && r.scatter.size > 0 ? { scatter: [...r.scatter.keys()].map((k) => k.split(',').map(Number) as [number, number]) } : {}) },
    blobs,
  };
}
