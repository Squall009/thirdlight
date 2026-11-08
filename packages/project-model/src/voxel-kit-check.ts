/**
 * The voxel kit check: one kit against the case catalogue whose cases are
 * its slots, its meshes' files and, for a kit that opts in, the trim layout
 * — as rows (ok / warn / err / info) the backend's Problems and the kit
 * report show.
 *
 * - **Slots.** Every slot is optional: an empty slot draws nothing by
 *   design (an author checks textures on plain voxels first and adds
 *   pieces one slot at a time), so empty slots are never a warning; the
 *   row says how many are filled (info). A slot the catalogue does not have
 *   never draws (err).
 * - **One texture set a kit.** Every piece uses the same one material (a
 *   trim sheet or one material: the same material name and the same
 *   images), for batching; a kit whose pieces use two is an error (a game
 *   that wants timber on stone makes two kits). No per-slot override.
 * - **One mesh a piece.** Pieces are drawn in the near ring only, so a slot
 *   mesh has one mesh (no level pairs to check).
 * - **Pivots and cell sizes.** A mesh is in metres, centred on its cell;
 *   turned by its slot rotation it is in the slot's case orientation. One
 *   that does not touch its cell draws beside it (err); one reaching past
 *   half a cell around it overlaps the neighbours' pieces (warn). A
 *   roof-edge piece's cell reaches a cell higher (the roof planes run up to
 *   a cell above its voxel).
 * - **Budgets** are reported, never capped: triangles and textures per
 *   piece, totals per kit.
 * - **Assets.** A mesh whose model the project lacks, or whose file cannot
 *   be read, draws nothing (err); a digest no version has ships the current
 *   version (warn), and one naming an older version holds only while
 *   nothing else uses the model (warn). Never refusals (the kit record
 *   validator accepts them, so deleting an asset is never refused for a
 *   kit).
 * - **Trim conformance** (T1–T7, T9, T10) only for a kit with a trim
 *   layout: one it names, labelled draft (the engine's example layout, not
 *   a standard), or its own sheet layout, labelled as the kit's (its
 *   numbers are the kit's to choose; voxel-trim-layout.ts).
 *
 * Pure: the kit, the catalogue and each mesh's facts in, rows out; facts
 * are read from GLB bytes by {@link voxelKitMeshFacts}.
 */
import { crc32, readGlb } from '@thirdlight/shared';
import { applyCubeRotation, meshRunAxis, resolveDamageStages, ROOF_EDGE_CASE_IDS, VOXEL_SIZE_M, WORLD_RULES, type CaseCatalogueDef, type DamageStageSpan } from '@thirdlight/voxel';
import type { KitCheckState } from './kit-checks';
import { readModelGeometry } from './model-collision';
import type { VoxelKit, VoxelKitMesh } from './voxel-kit';
import { kitTrimLayout, TRIM_LAYOUTS, trimRegionAt, type TrimLayout, type TrimRegion } from './voxel-trim-layout';

export interface VoxelKitCheckRow {
  /** Stable per rule (`required:wall-top`, `fit`, `trim:T4`, …). */
  id: string;
  state: KitCheckState;
  title: string;
  detail: string;
  /** The rule follows the engine's example trim layout (`detail-trim`, labelled draft: an example, not a standard). */
  draft?: true;
}

/** What the check reads of one mesh's file. */
export interface VoxelKitMeshFacts {
  /** Why the file could not be read (null: it was). */
  unreadable: string | null;
  /** The node the mesh names is in the file (true when it names none). */
  found: boolean;
  triangles: number;
  /** The render geometry's box, metres (null: none). */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Triangle soup: 9 floats a triangle (three positions). */
  positions: Float32Array;
  /** TEXCOORD_0 a triangle (6 floats), or null when a primitive has none. */
  uv: Float32Array | null;
  /** Embedded images: count, bytes, and each one's size where its header could be read. */
  textures: { count: number; bytes: number; sizes: [number, number][] };
  /**
   * The texture sets the drawn primitives use, each once: a material's name (`(unnamed)`, `(none)` for a primitive
   * with no material) and the CRC-32 of each image it samples, so two files embedding the same sheet agree.
   */
  textureSets: string[];
}

/** The project's model assets as the check reads them: kind, every version's source digest and the current version's. */
export type VoxelKitAssets = ReadonlyMap<string, { readonly kind: string; readonly digests: readonly string[]; readonly current?: string }>;

export interface VoxelKitPieceReport {
  /** The slot (case id). */
  caseId: string;
  /** Which of the slot's meshes. */
  mesh: number;
  /** Triangles of the mesh (null: not read). */
  triangles: number | null;
  /** Embedded textures of the mesh's file. */
  textures: { count: number; bytes: number; sizes: [number, number][] };
}

export interface VoxelKitCheckReport {
  voxelKitId: string;
  name: string;
  rows: VoxelKitCheckRow[];
  pieces: VoxelKitPieceReport[];
  totals: { pieces: number; triangles: number; textures: number; textureBytes: number };
}

/** A cell's half side, metres: meshes are centred on the cell. */
const HALF = VOXEL_SIZE_M / 2;
/** How far past its cell a piece may reach before it overlaps the neighbours' pieces (half a cell). */
const REACH = HALF;
/**
 * A roof-edge piece follows the roof mesher's planes, which run up to a cell above its voxel's top: its envelope
 * reaches that much higher (up to 3 half cells over the centre, plus the reach).
 */
const ROOF_TOP = 3 * HALF;
const ROOF_CASES: ReadonlySet<string> = new Set(ROOF_EDGE_CASE_IDS);
const EPS = 1e-3;
/** Pieces a row names before it counts the rest. */
const NAMED = 6;

function named(list: readonly string[]): string {
  return list.length <= NAMED ? list.join(', ') : `${list.slice(0, NAMED).join(', ')} and ${list.length - NAMED} more`;
}

function worst(states: readonly KitCheckState[]): KitCheckState {
  return states.includes('err') ? 'err' : states.includes('warn') ? 'warn' : states.includes('info') ? 'info' : 'ok';
}

/** Reads a mesh's facts from its GLB (one node of it when `node` is given). `imageSize` reads an embedded image's header. Never throws. */
export function voxelKitMeshFacts(bytes: Uint8Array, node?: string, imageSize?: (bytes: Uint8Array, mime: string) => [number, number] | null): VoxelKitMeshFacts {
  const empty: VoxelKitMeshFacts = { unreadable: null, found: false, triangles: 0, bounds: null, positions: new Float32Array(0), uv: null, textures: { count: 0, bytes: 0, sizes: [] }, textureSets: [] };
  const read = readModelGeometry(bytes, { surface: true });
  if (!read.ok) return { ...empty, unreadable: read.message };
  const prims = read.geometry.primitives.filter((p) => !p.collision && !p.occluder && (node === undefined || p.node.split('/').includes(node)));
  const tris = prims.reduce((n, p) => n + p.triangles.length, 0);
  const positions = new Float32Array(tris * 9);
  let uv: Float32Array | null = new Float32Array(tris * 6);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let t = 0;
  for (const p of prims) {
    const pu = p.uv ?? null;
    if (pu === null) uv = null;
    for (const tri of p.triangles) {
      for (let k = 0; k < 3; k++) {
        const q = p.positions[tri[k]!]!;
        for (let a = 0; a < 3; a++) {
          positions[t * 9 + k * 3 + a] = q[a]!;
          if (q[a]! < min[a]!) min[a] = q[a]!;
          if (q[a]! > max[a]!) max[a] = q[a]!;
        }
        if (uv !== null && pu !== null) {
          uv[t * 6 + k * 2] = pu[tri[k]! * 2]!;
          uv[t * 6 + k * 2 + 1] = pu[tri[k]! * 2 + 1]!;
        }
      }
      t++;
    }
  }
  const textures = { count: 0, bytes: 0, sizes: [] as [number, number][] };
  const glb = readGlb(bytes);
  const sets = new Set<string>();
  if (typeof glb !== 'string') {
    for (const name of new Set(prims.map((p) => p.material ?? null))) sets.add(textureSetOf(glb.json, glb.bin, name));
    const views = Array.isArray(glb.json['bufferViews']) ? (glb.json['bufferViews'] as Record<string, unknown>[]) : [];
    for (const img of Array.isArray(glb.json['images']) ? (glb.json['images'] as Record<string, unknown>[]) : []) {
      textures.count++;
      const bv = typeof img['bufferView'] === 'number' ? views[img['bufferView']] : undefined;
      const len = typeof bv?.['byteLength'] === 'number' ? bv['byteLength'] : 0;
      textures.bytes += len;
      if (bv !== undefined && glb.bin !== null && imageSize !== undefined) {
        const off = typeof bv['byteOffset'] === 'number' ? bv['byteOffset'] : 0;
        const size = imageSize(glb.bin.subarray(off, off + len), typeof img['mimeType'] === 'string' ? img['mimeType'] : '');
        if (size !== null) textures.sizes.push(size);
      }
    }
  }
  return { unreadable: null, found: prims.length > 0, triangles: tris, bounds: tris > 0 ? { min, max } : null, positions, uv: tris > 0 ? uv : null, textures, textureSets: [...sets].sort() };
}

/** The glTF texture slots a material samples. */
const TEXTURE_REFS = ['baseColorTexture', 'metallicRoughnessTexture'] as const;
const MATERIAL_TEXTURES = ['normalTexture', 'occlusionTexture', 'emissiveTexture'] as const;

/** A material's texture set (by its name; null: a primitive without a named material): its name and the CRC-32 of each image it samples. */
function textureSetOf(json: Record<string, unknown>, bin: Uint8Array | null, name: string | null): string {
  const materials = Array.isArray(json['materials']) ? (json['materials'] as Record<string, unknown>[]) : [];
  const mat = name === null ? undefined : materials.find((m) => m['name'] === name);
  if (mat === undefined) return name === null ? '(none)' : name;
  const textures = Array.isArray(json['textures']) ? (json['textures'] as Record<string, unknown>[]) : [];
  const images = Array.isArray(json['images']) ? (json['images'] as Record<string, unknown>[]) : [];
  const views = Array.isArray(json['bufferViews']) ? (json['bufferViews'] as Record<string, unknown>[]) : [];
  const pbr = (mat['pbrMetallicRoughness'] ?? {}) as Record<string, unknown>;
  const refs = [...TEXTURE_REFS.map((k) => pbr[k]), ...MATERIAL_TEXTURES.map((k) => mat[k])];
  const crcs: string[] = [];
  for (const r of refs) {
    const t = typeof (r as { index?: unknown } | undefined)?.index === 'number' ? textures[(r as { index: number }).index] : undefined;
    const img = typeof t?.['source'] === 'number' ? images[t['source']] : undefined;
    if (img === undefined) continue;
    const bv = typeof img['bufferView'] === 'number' ? views[img['bufferView']] : undefined;
    if (bv !== undefined && bin !== null) {
      const off = typeof bv['byteOffset'] === 'number' ? bv['byteOffset'] : 0;
      const len = typeof bv['byteLength'] === 'number' ? bv['byteLength'] : 0;
      crcs.push((crc32(bin.subarray(off, off + len)) >>> 0).toString(16).padStart(8, '0'));
    } else crcs.push(typeof img['uri'] === 'string' ? img['uri'] : '?');
  }
  return crcs.length === 0 ? name! : `${name!} [${crcs.join(' ')}]`;
}

/** The key a mesh's facts are kept by: its file version and node. */
export function voxelKitMeshKey(m: VoxelKitMesh): string {
  return `${m.assetId}@${m.digest}${m.node !== undefined ? `#${m.node}` : ''}`;
}

interface Piece {
  caseId: string;
  /** Which of the slot's meshes. */
  index: number;
  mesh: VoxelKitMesh;
  /** Its cube rotation into the slot's case orientation. */
  rotation: number;
  facts: VoxelKitMeshFacts | null;
}

const label = (p: Pick<Piece, 'caseId' | 'index'>): string => `${p.caseId}${p.index > 0 ? ` mesh ${p.index + 1}` : ''}`;

/** The slots: unknown ones (err), how many the kit fills (info; an empty slot draws nothing by design, never a warning). */
function slotRows(kit: VoxelKit, cat: CaseCatalogueDef): VoxelKitCheckRow[] {
  const known = new Set(cat.cases.map((c) => c.id));
  const unknown = Object.keys(kit.slots).filter((id) => !known.has(id));
  const filled = cat.cases.filter((c) => (kit.slots[c.id]?.meshes.length ?? 0) > 0).map((c) => c.id);
  const rows: VoxelKitCheckRow[] = [];
  rows.push(unknown.length > 0 ? { id: 'catalogue', state: 'err', title: `${unknown.length} slots the catalogue does not have`, detail: `${named(unknown)}: never drawn (catalogue ${cat.id} v${cat.version}).` } : { id: 'catalogue', state: 'ok', title: 'Every slot is a case of the catalogue', detail: `Catalogue ${cat.id} v${cat.version}.` });
  const empty = cat.cases.length - filled.length;
  rows.push({ id: 'slots', state: 'info', title: `${filled.length} of ${cat.cases.length} slots filled`, detail: filled.length === 0 ? 'No slot has a mesh: every edge draws as a plain voxel edge.' : `${named(filled)}${empty > 0 ? `; the other ${empty} draw nothing (plain voxel edges)` : ''}.` });
  rows.push(damageRow(kit));
  return rows;
}

/** The kit's damage stages as drawn (info): which integrities crack, which are holes and how many pieces a face carries. */
function damageRow(kit: VoxelKit): VoxelKitCheckRow {
  const { stages } = resolveDamageStages(kit.damage);
  const [s1, s2, s3] = stages.spans;
  const span = (s: DamageStageSpan | null | undefined): string => (s === null || s === undefined ? 'not used' : `integrity ${s.min}-${s.max}`);
  const parts = [`stage 1 cracks: ${span(s1)}`, `stage 2 hole: ${span(s2)}${s2 ? `, ${stages.pieces[2]} pieces a face` : ''}`, `stage 3 hole: ${span(s3)}${s3 ? `, ${stages.pieces[3]} pieces a face` : ''}`];
  const crack = kit.damage?.crackTexture !== undefined ? `the kit's crack texture ${kit.damage.crackTexture.assetId}` : "the engine's crack texture";
  return { id: 'damage', state: 'info', title: kit.damage === undefined ? "The engine's damage stages" : 'The kit sets its damage stages', detail: `${parts.join('; ')}; ${crack}. An integrity in no stage draws intact.` };
}

/** One texture set for the whole kit (one trim sheet or one material), for batching. */
function textureSetRows(pieces: readonly Piece[]): VoxelKitCheckRow[] {
  const bySet = new Map<string, string[]>();
  for (const p of pieces) {
    const f = p.facts;
    if (f === null || f.unreadable !== null || !f.found) continue;
    for (const t of f.textureSets) bySet.set(t, [...(bySet.get(t) ?? []), label(p)]);
  }
  if (bySet.size <= 1) return [{ id: 'texture-set', state: 'ok', title: 'One texture set for every piece', detail: bySet.size === 0 ? 'No mesh read.' : `${[...bySet.keys()][0]!}.` }];
  return [{ id: 'texture-set', state: 'err', title: `Pieces use ${bySet.size} texture sets`, detail: `${[...bySet].map(([t, ps]) => `${t}: ${named(ps)}`).join('; ')}. A kit draws every piece with one trim sheet or one material (make two kits for mixed detail).` }];
}

/** A mesh's box turned by a cube rotation (exact: a rotation of an axis-aligned box is one). */
function rotatedBounds(b: { min: [number, number, number]; max: [number, number, number] }, rotation: number): { min: [number, number, number]; max: [number, number, number] } {
  if (rotation === 0) return b;
  const a = applyCubeRotation(rotation, b.min);
  const c = applyCubeRotation(rotation, b.max);
  return { min: [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2])], max: [Math.max(a[0], c[0]), Math.max(a[1], c[1]), Math.max(a[2], c[2])] };
}

function meshRows(pieces: readonly Piece[], assets: VoxelKitAssets): VoxelKitCheckRow[] {
  const missing: string[] = [];
  const notModel: string[] = [];
  const unreadable: string[] = [];
  const noNode: string[] = [];
  const stale: string[] = [];
  const older: string[] = [];
  const detached: string[] = [];
  const over: string[] = [];
  for (const p of pieces) {
    const a = assets.get(p.mesh.assetId);
    const what = `${label(p)} (${p.mesh.assetId})`;
    if (a === undefined) {
      missing.push(what);
      continue;
    }
    if (a.kind !== 'model') {
      notModel.push(what);
      continue;
    }
    if (!a.digests.includes(p.mesh.digest)) stale.push(what);
    else if (a.current !== undefined && a.current !== p.mesh.digest) older.push(what);
    const f = p.facts;
    if (f === null) continue;
    if (f.unreadable !== null) {
      unreadable.push(`${what}: ${f.unreadable}`);
      continue;
    }
    if (!f.found) {
      noNode.push(p.mesh.node !== undefined ? `${what} node ${p.mesh.node}` : what);
      continue;
    }
    if (f.bounds === null) continue;
    const b = rotatedBounds(f.bounds, p.rotation);
    const top = ROOF_CASES.has(p.caseId) ? ROOF_TOP : HALF;
    if ([0, 1, 2].some((k) => b.max[k]! < -HALF - EPS || b.min[k]! > (k === 1 ? top : HALF) + EPS)) detached.push(what);
    else if ([0, 1, 2].some((k) => b.min[k]! < -HALF - REACH - EPS || b.max[k]! > (k === 1 ? top : HALF) + REACH + EPS)) over.push(`${what} ${b.min.map((v) => v.toFixed(2)).join(' ')} … ${b.max.map((v) => v.toFixed(2)).join(' ')}`);
  }
  const rows: VoxelKitCheckRow[] = [];
  const bad = [...missing, ...notModel, ...unreadable, ...noNode];
  if (bad.length > 0) {
    const parts = [missing.length > 0 ? `no such model: ${named(missing)}` : '', notModel.length > 0 ? `not a model: ${named(notModel)}` : '', unreadable.length > 0 ? `unreadable: ${named(unreadable)}` : '', noNode.length > 0 ? `no such node: ${named(noNode)}` : ''].filter((x) => x !== '');
    rows.push({ id: 'assets', state: 'err', title: `${bad.length} meshes cannot be drawn`, detail: `${parts.join('; ')}. Their slots draw nothing.` });
  } else rows.push({ id: 'assets', state: 'ok', title: 'Every mesh is a readable model', detail: `${pieces.length} meshes.` });
  if (stale.length > 0) rows.push({ id: 'digests', state: 'warn', title: `${stale.length} meshes name a file version the model does not have`, detail: `${named(stale)}: the model's current version ships instead of the one the piece was made from.` });
  // A build ships one version of a model: the pin holds only while the kit alone uses it (capture.ts).
  if (older.length > 0) rows.push({ id: 'pinned', state: 'warn', title: `${older.length} meshes name an older version of their model`, detail: `${named(older)}: a build ships that version only while nothing else uses the model (a scene, a prefab, a loadable asset, another mesh naming another version); otherwise the current version draws. Point the piece at the current version, or keep the kit's model to the kit.` });
  if (detached.length > 0) rows.push({ id: 'pivot', state: 'err', title: `${detached.length} pieces do not touch their cell`, detail: `${named(detached)}: a piece is in metres centred on its cell (±${HALF} m), turned by its slot rotation; these draw beside it. Move the geometry to the cell's centre.` });
  else rows.push({ id: 'pivot', state: 'ok', title: 'Every piece sits on its cell', detail: `Centred on the cell, ±${HALF} m.` });
  if (over.length > 0) rows.push({ id: 'fit', state: 'warn', title: `${over.length} pieces reach past half a cell around theirs`, detail: `${named(over)}: they overlap the neighbours' pieces (allowed: ±${HALF + REACH} m).` });
  else rows.push({ id: 'fit', state: 'ok', title: 'Every piece fits its cell envelope', detail: `Within ±${HALF + REACH} m of the cell's centre.` });
  return rows;
}

/** A triangle's gradient of a per-vertex scalar along its plane (per metre), or null when degenerate. */
function gradient(pos: Float32Array, t: number, s0: number, s1: number, s2: number): [number, number, number] | null {
  const o = t * 9;
  const e1 = [pos[o + 3]! - pos[o]!, pos[o + 4]! - pos[o + 1]!, pos[o + 5]! - pos[o + 2]!];
  const e2 = [pos[o + 6]! - pos[o]!, pos[o + 7]! - pos[o + 1]!, pos[o + 8]! - pos[o + 2]!];
  const a11 = e1[0]! * e1[0]! + e1[1]! * e1[1]! + e1[2]! * e1[2]!;
  const a12 = e1[0]! * e2[0]! + e1[1]! * e2[1]! + e1[2]! * e2[2]!;
  const a22 = e2[0]! * e2[0]! + e2[1]! * e2[1]! + e2[2]! * e2[2]!;
  const det = a11 * a22 - a12 * a12;
  if (det < 1e-12) return null;
  const d1 = s1 - s0;
  const d2 = s2 - s0;
  const a = (d1 * a22 - d2 * a12) / det;
  const b = (d2 * a11 - d1 * a12) / det;
  return [a * e1[0]! + b * e2[0]!, a * e1[1]! + b * e2[1]!, a * e1[2]! + b * e2[2]!];
}

function normalAlong(pos: Float32Array, t: number, axis: number): number {
  const o = t * 9;
  const e1 = [pos[o + 3]! - pos[o]!, pos[o + 4]! - pos[o + 1]!, pos[o + 5]! - pos[o + 2]!];
  const e2 = [pos[o + 6]! - pos[o]!, pos[o + 7]! - pos[o + 1]!, pos[o + 8]! - pos[o + 2]!];
  const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
  const len = Math.hypot(n[0]!, n[1]!, n[2]!);
  return len === 0 ? 1 : Math.abs(n[axis]!) / len;
}

/** One mesh's triangles against a layout: each triangle's region (null: none) and what the rules found. */
interface TrimFacts {
  regions: Map<string, number>;
  straddle: number;
  gutter: number;
  texel: number;
  density: number;
  start: number;
  profiled: string[];
  caps: string[];
}

/** The largest side of each end face among triangles `tris`: triangles sharing a corner make one face. */
function capFaceExtents(pos: Float32Array, tris: readonly number[]): number[] {
  const parent = tris.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const corner = new Map<string, number>();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const key = `${Math.round(pos[o]! * 1e5)},${Math.round(pos[o + 1]! * 1e5)},${Math.round(pos[o + 2]! * 1e5)}`;
      const at = corner.get(key);
      if (at === undefined) corner.set(key, i);
      else parent[find(i)] = find(at);
    }
  });
  const boxes = new Map<number, number[]>();
  tris.forEach((t, i) => {
    const root = find(i);
    const box = boxes.get(root) ?? [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 9; k++) {
      const a = k % 3;
      box[a] = Math.min(box[a]!, pos[t * 9 + k]!);
      box[a + 3] = Math.max(box[a + 3]!, pos[t * 9 + k]!);
    }
    boxes.set(root, box);
  });
  return [...boxes.values()].map((b) => Math.max(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!));
}

/** A mesh's facts against a layout, its run along mesh axis `run` (where U grows: the slot's run through its rotation). */
function trimFacts(f: VoxelKitMeshFacts, layout: TrimLayout, run: number): TrimFacts | null {
  if (f.uv === null) return null;
  const out: TrimFacts = { regions: new Map(), straddle: 0, gutter: 0, texel: 0, density: 0, start: 0, profiled: [], caps: [] };
  const perM = layout.pxPerMetre / layout.size;
  const spans = new Map<string, [number, number]>();
  const capTris = new Map<string, number[]>();
  const tris = f.triangles;
  for (let t = 0; t < tris; t++) {
    const uv = f.uv;
    const rs = [0, 1, 2].map((k) => trimRegionAt(layout, uv[t * 6 + k * 2]!, uv[t * 6 + k * 2 + 1]!));
    if (rs.every((r) => r === null)) {
      out.gutter++;
      continue;
    }
    const r: TrimRegion | null = rs[0] != null && rs.every((x) => x === rs[0]) ? rs[0] : null;
    if (r === null) {
      out.straddle++;
      continue;
    }
    // UV area in square metres of the sheet.
    const [u0, v0, u1, v1, u2, v2] = [0, 1, 2, 3, 4, 5].map((k) => uv[t * 6 + k]!) as [number, number, number, number, number, number];
    out.regions.set(r.id, (out.regions.get(r.id) ?? 0) + (Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2) / (perM * perM));
    const gv = gradient(f.positions, t, v0, v1, v2);
    if (gv !== null && Math.abs(Math.hypot(...gv) / perM - 1) > 0.02) out.texel++;
    if (r.kind !== 'cap' && normalAlong(f.positions, t, run) < 0.05) {
      const gu = gradient(f.positions, t, u0, u1, u2);
      if (gu !== null && Math.abs(gu[run]! / perM - 1) > 0.02) out.density++;
      for (let k = 0; k < 3; k++) if (Math.abs(uv[t * 6 + k * 2]! - perM * (f.positions[t * 9 + k * 3 + run]! + HALF)) > 0.002) {
        out.start++;
        break;
      }
    }
    const span = spans.get(r.id) ?? [Infinity, -Infinity];
    for (const v of [v0, v1, v2]) {
      span[0] = Math.min(span[0], v);
      span[1] = Math.max(span[1], v);
    }
    spans.set(r.id, span);
    if (r.kind === 'cap') capTris.set(r.id, [...(capTris.get(r.id) ?? []), t]);
  }
  for (const r of layout.regions) {
    const span = spans.get(r.id);
    if (span === undefined) continue;
    if (r.kind === 'profiled' && Math.abs(((span[1] - span[0]) * layout.size) / (r.y[1] - r.y[0]) - 1) > 0.02) out.profiled.push(`${r.id} spans ${((span[1] - span[0]) / perM).toFixed(3)} m of ${r.metres} m`);
    if (r.kind === 'cap') {
      const sizes = layout.regions.filter((x) => x.kind === 'cap').map((x) => x.metres);
      const smaller = Math.max(0, ...sizes.filter((m) => m < r.metres));
      if (!r.id.endsWith('a')) out.caps.push(`${r.id} (author caps on cell a)`);
      // Each end face on its own: a mesh may close several ends (both ends of a beam, two poles of a rail) in one cell.
      else for (const extent of capFaceExtents(f.positions, capTris.get(r.id)!)) if (extent > r.metres * 1.02 || extent <= smaller) out.caps.push(`${r.id} for an end ${extent.toFixed(3)} m across`);
    }
  }
  return out;
}

function trimRows(kit: VoxelKit, pieces: readonly Piece[]): VoxelKitCheckRow[] {
  if (kit.trimLayout === undefined && kit.sheetLayout === undefined) return [];
  const layout = kitTrimLayout(kit);
  // A named layout is the engine's draft; a declared one is the kit's own (its numbers are the kit's to choose).
  const draft = layout?.draft ?? true;
  const d = (id: string, state: KitCheckState, title: string, detail: string): VoxelKitCheckRow => ({ id: `trim:${id}`, state, title: `${id} (${draft ? 'draft layout' : "the kit's layout"}): ${title}`, detail, ...(draft ? { draft: true as const } : {}) });
  if (layout === undefined) return [d('layout', 'err', `unknown trim layout ${kit.trimLayout}`, `The layouts are ${[...TRIM_LAYOUTS.keys()].join(', ')} (a DRAFT the owner has not approved).`)];
  const per = new Map<Piece, TrimFacts | null>();
  for (const p of pieces) if (p.facts !== null && p.facts.unreadable === null && p.facts.found) per.set(p, trimFacts(p.facts, layout, meshRunAxis(p.caseId, p.rotation)));
  const list = (pick: (t: TrimFacts, p: Piece) => string | null): string[] => [...per].flatMap(([p, t]) => {
    if (t === null) return [];
    const s = pick(t, p);
    return s === null ? [] : [`${label(p)}: ${s}`];
  });
  const noUv = [...per].filter(([, t]) => t === null).map(([p]) => label(p));
  const rows: VoxelKitCheckRow[] = [];
  const rule = (id: string, bad: string[], state: KitCheckState, ok: string, fail: string): void => {
    rows.push(bad.length === 0 ? d(id, 'ok', ok, `${per.size} meshes read.`) : d(id, state, fail, `${named(bad)}.`));
  };
  if (noUv.length > 0) rows.push(d('uv', 'err', `${noUv.length} meshes have no UV0`, `${named(noUv)}: they draw one texel of the sheet.`));
  rule('T1', list((t) => (t.straddle > 0 ? `${t.straddle} triangles straddle regions` : null)), 'err', 'every triangle inside one region', 'triangles straddle two regions');
  rule('T2', list((t) => (t.gutter > 0 ? `${t.gutter} triangles in a gutter or reserved space` : null)), 'err', 'no UV in gutters or reserved space', 'UVs in gutters or reserved space');
  const uPerM = layout.pxPerMetre / layout.size;
  rule('T3', list((t) => (t.texel > 0 ? `${t.texel} triangles not at ${layout.pxPerMetre} px/m in V` : null)), 'warn', 'square texels (V at the sheet density)', 'texels not square');
  rule('T4', list((t) => (t.density > 0 || t.start > 0 ? `${t.density} run faces off ${uPerM} U a metre, ${t.start} not starting at U 0` : null)), 'err', `U follows the run at ${uPerM} a metre from 0`, 'U off the run density');
  rule('T5', list((t) => (t.profiled.length > 0 ? t.profiled.join(', ') : null)), 'warn', 'profiled strips on faces of their height', 'profiled strips on faces of another height');
  rule('T6', list((t) => (t.caps.length > 0 ? t.caps.join(', ') : null)), 'warn', 'end faces in the right cap cell', 'caps of the wrong size or cell');
  // T7: every mesh of a slot uses the same regions (a pick never changes the look of the trim).
  const bySlot = new Map<string, Set<string>[]>();
  for (const [p, t] of per) if (t !== null) bySlot.set(p.caseId, [...(bySlot.get(p.caseId) ?? []), new Set(t.regions.keys())]);
  const t7 = [...bySlot].filter(([, sets]) => sets.some((s) => [...s].sort().join() !== [...sets[0]!].sort().join())).map(([k, sets]) => `${k}: ${sets.map((s) => [...s].sort().join('+') || 'none').join(' | ')}`);
  rule('T7', t7, 'warn', 'the meshes of a slot use the same regions', 'the meshes of a slot use different regions');
  rows.push(d('T9', 'info', 'the texture set is not checked', 'The kit format names no texture set for its layout yet: size, maps, gutters and normal convention are checked when it does.'));
  const used = new Map<string, { pieces: number; area: number }>();
  for (const t of per.values()) if (t !== null) for (const [id, a] of t.regions) used.set(id, { pieces: (used.get(id)?.pieces ?? 0) + 1, area: (used.get(id)?.area ?? 0) + a });
  rows.push(d('T10', 'info', `${used.size} regions used`, [...used].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([id, u]) => `${id}: ${u.pieces} meshes, ${u.area.toFixed(3)} m² of sheet`).join('; ') || 'No UVs read.'));
  return rows;
}

/**
 * The kit check: rows in rule order and every piece's budget. `facts`
 * gives a mesh's facts, or null when its file was not read (no such
 * model, or not a model: the asset rows say so).
 */
export function voxelKitCheck(kit: VoxelKit, catalogue: CaseCatalogueDef, assets: VoxelKitAssets, facts: (m: VoxelKitMesh) => VoxelKitMeshFacts | null): VoxelKitCheckReport {
  const pieces: Piece[] = [];
  const reports: VoxelKitPieceReport[] = [];
  for (const [cid, c] of Object.entries(kit.slots)) {
    c.meshes.forEach((m, k) => {
      const f = facts(m.mesh);
      pieces.push({ caseId: cid, index: k, mesh: m.mesh, rotation: m.rotation ?? 0, facts: f });
      reports.push({ caseId: cid, mesh: k, triangles: f !== null && f.unreadable === null && f.found ? f.triangles : null, textures: f?.textures ?? { count: 0, bytes: 0, sizes: [] } });
    });
  }
  const rows = [...slotRows(kit, catalogue), ...meshRows(pieces, assets), ...textureSetRows(pieces)];
  const totals = {
    pieces: reports.length,
    triangles: reports.reduce((n, r) => n + (r.triangles ?? 0), 0),
    textures: reports.reduce((n, r) => n + r.textures.count, 0),
    textureBytes: reports.reduce((n, r) => n + r.textures.bytes, 0),
  };
  const tris = reports.flatMap((r) => (r.triangles !== null ? [r.triangles] : [])).sort((a, b) => a - b);
  const sizes = [...new Set(reports.flatMap((r) => r.textures.sizes.map(([w, h]) => `${w}×${h}`)))];
  rows.push({
    id: 'budget',
    state: 'info',
    title: `${totals.pieces} slot meshes: ${totals.triangles} triangles`,
    detail: `A mesh: ${tris.length > 0 ? `min ${tris[0]}, median ${tris[tris.length >> 1]}, max ${tris[tris.length - 1]}` : 'none read'}. Textures: ${totals.textures} (${totals.textureBytes} bytes${sizes.length > 0 ? `; ${sizes.join(', ')}` : ''}). Reported, never capped.`,
  });
  rows.push(...trimRows(kit, pieces));
  return { voxelKitId: kit.voxelKitId, name: kit.name, rows, pieces: reports, totals };
}

/** The kit check against the world rules' catalogue (the cases a world's derive gives). */
export function worldVoxelKitCheck(kit: VoxelKit, assets: VoxelKitAssets, facts: (m: VoxelKitMesh) => VoxelKitMeshFacts | null): VoxelKitCheckReport {
  return voxelKitCheck(kit, WORLD_RULES.catalogue!, assets, facts);
}

/** The worst state of a report's rows. */
export function voxelKitCheckState(r: Pick<VoxelKitCheckReport, 'rows'>): KitCheckState {
  return worst(r.rows.map((x) => x.state));
}
