/**
 * The host's follow-ups of a command: what splines change elsewhere,
 * planned after the command's own change and written in its transaction
 * (`applyFollows`: one revision, one undo step).
 *
 * - Terrains: where a spline that shapes terrain or keeps scatter clear was
 *   added, moved, changed or removed, each terrain it reached or reaches is
 *   shaped again over the band round the curve before and after; where a
 *   terrain's edit layers changed (a stamp placed, a layer switched,
 *   weighed or moved), over what they reach (`planTerrainSplineRebake`):
 *   new tile blobs (the drawn form and the hand-made one beside it) and
 *   scatter blobs.
 * - What a spline makes: when its curve, mesh or pieces changed (or it has
 *   none made yet), its mesh is swept and its pieces' copies placed again
 *   (`makeSpline`), each mesh piece given its coarser levels by the injected
 *   simplifier (borders kept, so pieces meet at every level), stored as one
 *   blob its `data` names. Moving the object needs nothing made: what is
 *   made is relative to it.
 *
 * The blobs go with the command's own: checked with the change, published
 * once it passed. Each re-bake's milliseconds are kept on the session
 * (`lastSplineRebake`) for diagnostics and the perf tools.
 */
import { applyFollows, blocksUvOrigin, planTerrainSplineRebake, splineRebakeRects, terrainTilesAfter, type CommandError, type CommandState, type ComponentFollow, type ContentDocument, type MutationSuccess, type SceneDocument } from '@thirdlight/commands';
import { MESH_LOD_RATIOS_DEFAULT, decodeSplineMade, encodeSplineMade, makeSpline, scatterBlobOf, scatterCellOfBlob, splineMakesData, terrainFlatStep, terrainTileKey, type ScatterCell, type SplineComponent, type SplineMade, type TerrainComponent, type TerrainTile } from '@thirdlight/project-model';

import { readSourceBlob } from './content-store';
import { sha256Hex } from './digest';
import { contentCtx } from './service-content';
import type { Core, ProjectSession } from './session';
import { terrainBlobOf, terrainTileOfBlob, type TerrainBlob } from './terrain-edits';
import { terrainLayerReads } from './terrain-layer-reads';

/** One re-bake's figures: terrains and tiles shaped, scatter tiles, milliseconds. */
export interface SplineRebakeReport {
  terrains: number;
  tiles: number;
  scatter: number;
  ms: number;
}

function readTile(core: Core, s: ProjectSession, digest: string): { ok: true; tile: TerrainTile } | { ok: false; error: CommandError } {
  const r = readSourceBlob(core, contentCtx(s), { digest });
  if (!r.ok) return r;
  try {
    return { ok: true, tile: terrainTileOfBlob(r.bytes) };
  } catch (e) {
    return { ok: false, error: { code: 'field_value', cls: 'validation', path: '/args', message: `terrain tile ${digest.slice(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`.slice(0, 256), expected: 'a terrain tile blob' } as CommandError };
  }
}

function readScatter(core: Core, s: ProjectSession, digest: string): { ok: true; cell: ScatterCell } | { ok: false; error: CommandError } {
  const r = readSourceBlob(core, contentCtx(s), { digest });
  if (!r.ok) return r;
  try {
    return { ok: true, cell: scatterCellOfBlob(r.bytes) };
  } catch (e) {
    return { ok: false, error: { code: 'field_value', cls: 'validation', path: '/args', message: `terrain scatter ${digest.slice(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`.slice(0, 256), expected: 'a terrain scatter blob' } as CommandError };
  }
}

/**
 * The terrain follow-ups of a change from `before` to `after` (the edited
 * scene), with the blobs they name; `content` the project's after the change
 * (the block types a blocks layer reads).
 */
export function planSplineFollows(core: Core, s: ProjectSession, before: SceneDocument, after: SceneDocument, content?: ContentDocument | null): { ok: true; follows: ComponentFollow[]; blobs: TerrainBlob[] } | { ok: false; error: CommandError } {
  const started = performance.now();
  const rects = splineRebakeRects(before, after);
  const reads = terrainLayerReads(core, s, content);
  const follows: ComponentFollow[] = [];
  const blobs: TerrainBlob[] = [];
  let tiles = 0;
  let scattered = 0;
  for (const [terrainId, list] of rects) {
    const planned = planTerrainSplineRebake(after, terrainId, list, (d) => readTile(core, s, d), (d) => readScatter(core, s, d), reads);
    if (!planned.ok) return planned;
    const plan = planned.plan;
    if (plan === null) continue;
    const comp = plan.component;
    const digests = new Map<string, string | null>();
    const flat = terrainFlatStep(comp.heightRange);
    for (const [key, tile] of plan.tiles) {
      // A drawn tile flat at 0 m and bare is stored without data (as an edit stores it).
      if (tile.weights === null && tile.holes === null && tile.paint === null && tile.heights.every((h) => h === flat)) {
        digests.set(key, null);
        continue;
      }
      const blob = terrainBlobOf(tile);
      blobs.push(blob);
      digests.set(key, blob.digest);
    }
    const bases = new Map<string, string | null>();
    for (const [key, tile] of plan.bases) {
      if (tile === null) {
        bases.set(key, null);
        continue;
      }
      // The hand-made form is always a blob (flat or not): its absence means "the drawn tile is the hand-made one".
      const blob = terrainBlobOf(tile);
      blobs.push(blob);
      bases.set(key, blob.digest);
    }
    const scatterDigests = new Map<string, string | null>();
    for (const [key, cell] of plan.scatter) {
      const bytes = scatterBlobOf(cell);
      const digest = bytes === null ? null : sha256Hex(bytes);
      if (bytes !== null) blobs.push({ digest: digest!, bytes });
      scatterDigests.set(key, digest);
    }
    // A tile whose drawn form is flat and bare again and has no hand-made form beside it is stored without data.
    const value: TerrainComponent = withUvOrigin(after, { ...comp, tiles: terrainTilesAfter(comp, digests, scatterDigests, bases) });
    const old = new Map(comp.tiles.map((t) => [terrainTileKey(t.x, t.z), t]));
    const changed = value.tiles.some((t) => JSON.stringify(t) !== JSON.stringify(old.get(terrainTileKey(t.x, t.z))));
    if (!changed) continue;
    tiles += plan.tiles.size;
    scattered += plan.scatter.size;
    follows.push({ entityId: terrainId, component: 'terrain', restore: comp, next: value });
  }
  // A terrain meeting block layers counts its texture coordinates from the first one's origin (also with nothing to re-bake).
  for (const e of after.entities as unknown as Entity[]) {
    const comp = e.components['terrain'] as TerrainComponent | undefined;
    if (comp === undefined || follows.some((f) => f.entityId === e.id)) continue;
    const value = withUvOrigin(after, comp);
    if (value !== comp) follows.push({ entityId: e.id, component: 'terrain', restore: comp, next: value });
  }
  if (follows.length > 0) s.lastSplineRebake = { terrains: follows.length, tiles, scatter: scattered, ms: performance.now() - started };
  return { ok: true, follows, blobs };
}

/** The terrain with the texture origin its blocks layers ask for (the same object when it has it, or asks for none). */
function withUvOrigin(scene: SceneDocument, comp: TerrainComponent): TerrainComponent {
  const want = blocksUvOrigin(scene, comp);
  if (want === null || (comp.uvOrigin !== undefined && comp.uvOrigin[0] === want[0] && comp.uvOrigin[1] === want[1])) return comp;
  return { ...comp, uvOrigin: want };
}

type Entity = { id: string; components: Record<string, unknown> };

/** What a spline's made blob depends on (its object's place does not: what is made is relative to it). */
const madeKey = (c: SplineComponent): string => JSON.stringify([c.points, c.closed ?? false, c.width ?? null, c.mesh ?? null, c.pieces ?? null]);

/** One spline's mesh and pieces, made and given their levels of detail. */
export function splineMadeBlob(core: Core, c: SplineComponent): TerrainBlob {
  const made: SplineMade = makeSpline(c);
  const simplifier = core.content.meshSimplifier?.current ?? null;
  if (simplifier !== null) {
    for (const p of made.pieces) {
      const v = p.positions.length / 3;
      // Normals, texture coordinates and water's foam count against the error as a position's would: a seam stays
      // where it is, and water keeps the points across it where its foam fades in from the banks.
      const stride = 6;
      const attrs = new Float32Array(v * stride);
      for (let i = 0; i < v; i++) {
        attrs.set(p.normals.subarray(i * 3, i * 3 + 3), i * stride);
        attrs.set(p.uvs.subarray(i * 2, i * 2 + 2), i * stride + 3);
        attrs[i * stride + 5] = p.foam?.[i] ?? 0;
      }
      // The first and last cross-sections stay (where the piece meets its neighbours: no crack at any level); its open
      // sides may move along the curve, so a flat strip still loses rows on straight stretches.
      const rowLength = p.rowLength;
      const locked = new Uint8Array(v);
      locked.fill(1, 0, rowLength);
      locked.fill(1, v - rowLength, v);
      const levels = simplifier.levels({ positions: p.positions, indices: p.levels[0]!.indices, attributes: { data: attrs, stride, weights: [0.5, 0.5, 0.5, 0.25, 0.25, 4] }, locked }, MESH_LOD_RATIOS_DEFAULT);
      for (const l of levels) p.levels.push({ error: l.errorAbsolute, indices: l.indices });
    }
  }
  const bytes = encodeSplineMade(made);
  return { digest: sha256Hex(bytes), bytes };
}

/** What the splines of `after` make, where it changed from `before` (a spline's `data` written, or dropped when it makes nothing). */
export function planSplineMade(core: Core, before: SceneDocument, after: SceneDocument): { follows: ComponentFollow[]; blobs: TerrainBlob[]; ms: number } {
  const started = performance.now();
  const was = new Map((before.entities as unknown as Entity[]).map((e) => [e.id, e.components['spline'] as SplineComponent | undefined]));
  const follows: ComponentFollow[] = [];
  const blobs: TerrainBlob[] = [];
  for (const e of after.entities as unknown as Entity[]) {
    const c = e.components['spline'] as SplineComponent | undefined;
    if (c === undefined) continue;
    if (!splineMakesData(c)) {
      if (c.data !== undefined) {
        const { data: _drop, ...rest } = c;
        follows.push({ entityId: e.id, component: 'spline', restore: c, next: rest });
      }
      continue;
    }
    const prev = was.get(e.id);
    if (prev !== undefined && c.data !== undefined && prev.data === c.data && madeKey(prev) === madeKey(c)) continue;
    const blob = splineMadeBlob(core, c);
    blobs.push(blob);
    if (blob.digest !== c.data) follows.push({ entityId: e.id, component: 'spline', restore: c, next: { ...c, data: blob.digest } });
  }
  return { follows, blobs, ms: performance.now() - started };
}

/** Plan and apply a command's follow-ups to its outcome (nothing to do: the same outcome). */
export function withSplineFollows(core: Core, s: ProjectSession, before: SceneDocument, state: CommandState<SceneDocument>, result: MutationSuccess): { ok: true; state: CommandState<SceneDocument>; result: MutationSuccess; blobs: TerrainBlob[] } | { ok: false; error: CommandError } {
  const planned = planSplineFollows(core, s, before, state.scene, state.content);
  if (!planned.ok) return planned;
  const made = planSplineMade(core, before, state.scene);
  if (made.follows.length > 0) s.lastSplineMade = { splines: made.follows.length, ms: made.ms };
  const follows = [...planned.follows, ...made.follows];
  if (follows.length === 0) return { ok: true, state, result, blobs: [] };
  const applied = applyFollows(state, result, follows);
  if (!applied.ok) return applied;
  return { ok: true, state: applied.state, result: applied.result, blobs: [...planned.blobs, ...made.blobs] };
}

/**
 * Check the made blobs a change names that the scene did not name before
 * (a setComponent from MCP, an undo): each is a stored spline blob that
 * reads back. `inHand` are the command's own (published after this check).
 */
export function verifySplineData(core: Core, s: ProjectSession, before: readonly Entity[], after: readonly Entity[], inHand: readonly TerrainBlob[]): CommandError | null {
  const own = new Set(inHand.map((b) => b.digest));
  const known = new Set(before.map((e) => (e.components['spline'] as SplineComponent | undefined)?.data).filter((d): d is string => d !== undefined));
  for (const e of after) {
    const d = (e.components['spline'] as SplineComponent | undefined)?.data;
    if (d === undefined || known.has(d) || own.has(d)) continue;
    const r = readSourceBlob(core, contentCtx(s), { digest: d });
    if (!r.ok) return r.error;
    try {
      decodeSplineMade(r.bytes);
    } catch (err) {
      return { code: 'field_value', cls: 'validation', path: '/args', message: `spline data ${d.slice(0, 12)}…: ${err instanceof Error ? err.message : String(err)}`.slice(0, 256), expected: 'a spline blob' } as CommandError;
    }
  }
  return null;
}
