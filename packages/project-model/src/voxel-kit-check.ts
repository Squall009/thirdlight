/**
 * The voxel kit check: one kit against the case catalogue it dresses, its
 * meshes' files and, for a kit that opts in, the trim layout — as rows
 * (ok / warn / err / info) the backend's Problems and the kit report show.
 *
 * - **Cases.** Every required case of the catalogue has a piece, or the row
 *   says what draws it instead (warn): the kit's fallback piece of the
 *   role (when it fills the same coarse shape), the base surface, or the
 *   engine's stand-in. Optional cases missing are info. Cases and sections
 *   the catalogue does not know never draw (err).
 * - **A fallback per role**: the role's fallback case has a piece, or the
 *   row says what a missing case of the role falls to.
 * - **One mesh a piece.** Pieces are drawn in the near ring only, so a
 *   variant has one mesh (no level pairs to check).
 * - **Pivots and cell sizes.** A mesh is in metres, centred on its cell, in
 *   its case's orientation: one that does not touch its cell draws beside
 *   it (err); one reaching past half a cell around it overlaps the
 *   neighbours' pieces (warn). A roof-edge piece's cell reaches a cell
 *   higher (the roof planes run up to a cell above its voxel).
 * - **Join profiles** at section ends that meet (start → body → body →
 *   end; corners and junctions between bodies): outlines that differ draw
 *   a step (warn); an end with no profile is not checked (info).
 * - **Budgets** are reported, never capped: triangles and textures per
 *   piece, totals per kit.
 * - **Assets.** A mesh whose model the project lacks, or whose file cannot
 *   be read, draws nothing of its own (err); a digest no version has ships
 *   the current version (warn), and one naming an older version holds only
 *   while nothing else uses the model (warn). Never refusals (the kit record validator
 *   accepts them, so deleting an asset is never refused for a kit).
 * - **Trim conformance** (T1–T10) only for a kit that names a trim layout,
 *   labelled draft: the layout is a draft the owner has not approved
 *   (voxel-trim-layout.ts).
 *
 * Pure: the kit, the catalogue and each mesh's facts in, rows out; facts
 * are read from GLB bytes by {@link voxelKitMeshFacts}.
 */
import { readGlb } from '@thirdlight/shared';
import { ROOF_EDGE_CASE_IDS, RUN_SECTION_IDS, VOXEL_SIZE_M, VOXEL_ROLE, WORLD_RULES, type CaseCatalogueDef, type CaseDef } from '@thirdlight/voxel';
import type { KitCheckState } from './kit-checks';
import { readModelGeometry } from './model-collision';
import type { VoxelKit, VoxelKitMesh, VoxelKitSection } from './voxel-kit';
import { TRIM_LAYOUTS, trimRegionAt, type TrimLayout, type TrimRegion } from './voxel-trim-layout';

export interface VoxelKitCheckRow {
  /** Stable per rule (`required:wall-top`, `fit`, `trim:T4`, …). */
  id: string;
  state: KitCheckState;
  title: string;
  detail: string;
  /** The rule follows a draft spec the owner has not approved (the trim layout). */
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
}

/** The project's model assets as the check reads them: kind, every version's source digest and the current version's. */
export type VoxelKitAssets = ReadonlyMap<string, { readonly kind: string; readonly digests: readonly string[]; readonly current?: string }>;

export interface VoxelKitPieceReport {
  caseId: string;
  sectionId: string;
  variant: number;
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

/** Run sections a kit names pieces for. */
const SECTIONS = RUN_SECTION_IDS;
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
/**
 * A banister post always stands under a rail (its case's rule): its piece runs up through the rail's cell to the
 * rail, so its envelope reaches to that cell's top.
 */
const POST_TOP = 3 * HALF;
const EPS = 1e-3;
/** Pieces a row names before it counts the rest. */
const NAMED = 6;

const ROLE_NAMES = new Map<number, string>(Object.entries(VOXEL_ROLE).map(([k, v]) => [v, k]));
const roleName = (r: number): string => ROLE_NAMES.get(r) ?? `role ${r}`;

function named(list: readonly string[]): string {
  return list.length <= NAMED ? list.join(', ') : `${list.slice(0, NAMED).join(', ')} and ${list.length - NAMED} more`;
}

function worst(states: readonly KitCheckState[]): KitCheckState {
  return states.includes('err') ? 'err' : states.includes('warn') ? 'warn' : states.includes('info') ? 'info' : 'ok';
}

/** Reads a mesh's facts from its GLB (one node of it when `node` is given). `imageSize` reads an embedded image's header. Never throws. */
export function voxelKitMeshFacts(bytes: Uint8Array, node?: string, imageSize?: (bytes: Uint8Array, mime: string) => [number, number] | null): VoxelKitMeshFacts {
  const empty: VoxelKitMeshFacts = { unreadable: null, found: false, triangles: 0, bounds: null, positions: new Float32Array(0), uv: null, textures: { count: 0, bytes: 0, sizes: [] } };
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
  if (typeof glb !== 'string') {
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
  return { unreadable: null, found: prims.length > 0, triangles: tris, bounds: tris > 0 ? { min, max } : null, positions, uv: tris > 0 ? uv : null, textures };
}

/** The key a mesh's facts are kept by: its file version and node. */
export function voxelKitMeshKey(m: VoxelKitMesh): string {
  return `${m.assetId}@${m.digest}${m.node !== undefined ? `#${m.node}` : ''}`;
}

interface Piece {
  caseId: string;
  sectionId: string;
  variant: number;
  mesh: VoxelKitMesh;
  facts: VoxelKitMeshFacts | null;
}

const label = (p: Pick<Piece, 'caseId' | 'sectionId' | 'variant'>): string => `${p.caseId}/${p.sectionId}${p.variant > 0 ? ` v${p.variant + 1}` : ''}`;

/** The sections of a case the kit has pieces for, by known section id: its own, or its alias's (drawn turned). */
function sectionsOf(kit: VoxelKit, caseId: string): Map<string, VoxelKitSection> {
  const out = new Map<string, VoxelKitSection>();
  const c = kit.cases[caseId];
  const secs = c?.sections ?? (c?.alias !== undefined ? kit.cases[c.alias.case]?.sections : undefined);
  for (const [sid, s] of Object.entries(secs ?? {})) if (SECTIONS.includes(sid) && s.variants.length > 0) out.set(sid, s);
  return out;
}

/** The kit's aliases: which cases draw another case's meshes turned (info), and any that name no meshes (err). */
function aliasRows(kit: VoxelKit): VoxelKitCheckRow[] {
  const all = Object.entries(kit.cases).flatMap(([cid, c]) => (c.alias === undefined ? [] : [{ cid, ...c.alias }]));
  if (all.length === 0) return [];
  const broken = all.filter((a) => kit.cases[a.case]?.sections === undefined || a.case === a.cid);
  if (broken.length > 0) return [{ id: 'aliases', state: 'err', title: `${broken.length} aliases name no meshes`, detail: `${named(broken.map((a) => `${a.cid} → ${a.case}`))}: an alias names a case of this kit with sections of its own.` }];
  return [{ id: 'aliases', state: 'info', title: `${all.length} cases drawn by another case's meshes`, detail: `${all.map((a) => `${a.cid} = ${a.case} turned (rotation ${a.rotation})`).join('; ')}.` }];
}

/** Pairs of sections whose ends meet in a run: [the section whose end meets, the one whose start it meets]. */
function meetingPairs(have: ReadonlySet<string>): [string, string][] {
  const out: [string, string][] = [];
  const body = have.has('body');
  if (body) out.push(['body', 'body']);
  if (have.has('start')) out.push(['start', body ? 'body' : have.has('end') ? 'end' : 'start']);
  if (have.has('end') && body) out.push(['body', 'end']);
  for (const s of ['corner', 'junction']) if (have.has(s) && body) out.push(['body', s], [s, 'body']);
  return out.filter(([a, b]) => a !== b || a === 'body');
}

function caseRows(kit: VoxelKit, cat: CaseCatalogueDef): VoxelKitCheckRow[] {
  const rows: VoxelKitCheckRow[] = [];
  const known = new Map(cat.cases.map((c) => [c.id, c]));
  const unknown: string[] = [];
  for (const [cid, c] of Object.entries(kit.cases)) {
    if (!known.has(cid)) unknown.push(`case ${cid}`);
    else for (const sid of Object.keys(c.sections ?? {})) if (!SECTIONS.includes(sid)) unknown.push(`${cid} section ${sid}`);
  }
  rows.push(unknown.length > 0 ? { id: 'catalogue', state: 'err', title: 'Names cases or sections the catalogue does not have', detail: `${named(unknown)}: never drawn (catalogue ${cat.id} v${cat.version}; sections are ${SECTIONS.join(', ')}).` } : { id: 'catalogue', state: 'ok', title: 'Every case and section is in the catalogue', detail: `Catalogue ${cat.id} v${cat.version}.` });
  const has = (id: string): boolean => sectionsOf(kit, id).size > 0;
  const instead = (c: CaseDef): string => {
    const standIn = c.standIn === undefined ? undefined : known.get(c.standIn);
    if (standIn !== undefined && has(standIn.id)) return `the kit's ${standIn.id} piece stands in`;
    const fb = known.get(cat.fallback[c.roles[0]!] ?? '');
    if (fb !== undefined && fb.id !== c.id && fb.base === c.base && fb.shape === c.shape && has(fb.id)) return `the kit's ${fb.id} piece stands in`;
    if (c.base !== 'suppress') return 'the base surface draws it with no piece';
    return `the engine's stand-in ${c.shape} draws it`;
  };
  const required = cat.cases.filter((c) => c.required);
  const missing = required.filter((c) => !has(c.id));
  for (const c of missing) rows.push({ id: `required:${c.id}`, state: 'warn', title: `Required case ${c.id} has no piece`, detail: `${c.note}: ${instead(c)}.` });
  if (missing.length === 0) rows.push({ id: 'required', state: 'ok', title: 'Every required case has a piece', detail: `${required.length} required cases.` });
  const optional = cat.cases.filter((c) => !c.required && !has(c.id));
  rows.push(optional.length > 0 ? { id: 'optional', state: 'info', title: `${optional.length} optional cases have no piece`, detail: optional.map((c) => `${c.id} (${instead(c)})`).join('; ') + '.' } : { id: 'optional', state: 'ok', title: 'Every optional case has a piece', detail: `${cat.cases.length - required.length} optional cases.` });
  for (const [role, fid] of Object.entries(cat.fallback)) {
    if (fid === null) continue;
    const fb = known.get(fid);
    if (fb === undefined) continue;
    const name = roleName(Number(role));
    rows.push(has(fid) ? { id: `fallback:${name}`, state: 'ok', title: `${name}: fallback ${fid} has a piece`, detail: `A ${name} case the kit lacks that fills the same shape draws the kit's ${fid} piece.` } : { id: `fallback:${name}`, state: 'warn', title: `${name}: no fallback piece (${fid})`, detail: `A ${name} case the kit lacks draws ${fb.base === 'suppress' ? 'the engine\'s stand-in' : 'the base surface with no piece'} instead of the kit's own.` });
  }
  return rows;
}

function joinRows(kit: VoxelKit): VoxelKitCheckRow[] {
  const steps: string[] = [];
  const unchecked: string[] = [];
  let pairs = 0;
  const outline = (id: string | undefined): string | null => (id === undefined ? null : JSON.stringify(kit.joinProfiles?.[id]?.outline ?? null));
  for (const cid of Object.keys(kit.cases)) {
    const secs = sectionsOf(kit, cid);
    for (const [a, b] of meetingPairs(new Set(secs.keys()))) {
      const ea = secs.get(a)!.ends?.end;
      const sb = secs.get(b)!.ends?.start;
      if (ea === undefined || sb === undefined) {
        unchecked.push(`${cid} ${a}→${b}`);
        continue;
      }
      pairs++;
      if (ea !== sb && outline(ea) !== outline(sb)) steps.push(`${cid} ${a} end (${ea}) → ${b} start (${sb})`);
    }
  }
  const rows: VoxelKitCheckRow[] = [];
  if (steps.length > 0) rows.push({ id: 'joins', state: 'warn', title: `${steps.length} section joins have different profiles`, detail: `${named(steps)}: the run steps where they meet. Give both ends the same outline.` });
  else rows.push({ id: 'joins', state: 'ok', title: 'Section ends meet by the same profile', detail: `${pairs} joins checked.` });
  if (unchecked.length > 0) rows.push({ id: 'joins-unchecked', state: 'info', title: `${unchecked.length} joins not checked`, detail: `${named(unchecked)}: an end names no join profile.` });
  return rows;
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
    const b = f.bounds;
    if (b === null) continue;
    const top = ROOF_CASES.has(p.caseId) ? ROOF_TOP : p.caseId === 'banister-post' ? POST_TOP : HALF;
    if ([0, 1, 2].some((k) => b.max[k]! < -HALF - EPS || b.min[k]! > (k === 1 ? top : HALF) + EPS)) detached.push(what);
    else if ([0, 1, 2].some((k) => b.min[k]! < -HALF - REACH - EPS || b.max[k]! > (k === 1 ? top : HALF) + REACH + EPS)) over.push(`${what} ${b.min.map((v) => v.toFixed(2)).join(' ')} … ${b.max.map((v) => v.toFixed(2)).join(' ')}`);
  }
  const rows: VoxelKitCheckRow[] = [];
  const bad = [...missing, ...notModel, ...unreadable, ...noNode];
  if (bad.length > 0) {
    const parts = [missing.length > 0 ? `no such model: ${named(missing)}` : '', notModel.length > 0 ? `not a model: ${named(notModel)}` : '', unreadable.length > 0 ? `unreadable: ${named(unreadable)}` : '', noNode.length > 0 ? `no such node: ${named(noNode)}` : ''].filter((x) => x !== '');
    rows.push({ id: 'assets', state: 'err', title: `${bad.length} meshes cannot be drawn`, detail: `${parts.join('; ')}. The fallback draws those cases instead.` });
  } else rows.push({ id: 'assets', state: 'ok', title: 'Every mesh is a readable model', detail: `${pieces.length} meshes.` });
  if (stale.length > 0) rows.push({ id: 'digests', state: 'warn', title: `${stale.length} meshes name a file version the model does not have`, detail: `${named(stale)}: the model's current version ships instead of the one the piece was made from.` });
  // A build ships one version of a model: the pin holds only while the kit alone uses it (capture.ts).
  if (older.length > 0) rows.push({ id: 'pinned', state: 'warn', title: `${older.length} meshes name an older version of their model`, detail: `${named(older)}: a build ships that version only while nothing else uses the model (a scene, a prefab, a loadable asset, another mesh naming another version); otherwise the current version draws. Point the piece at the current version, or keep the kit's model to the kit.` });
  if (detached.length > 0) rows.push({ id: 'pivot', state: 'err', title: `${detached.length} pieces do not touch their cell`, detail: `${named(detached)}: a piece is in metres centred on its cell (±${HALF} m); these draw beside it. Move the geometry to the cell's centre.` });
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

function normalX(pos: Float32Array, t: number): number {
  const o = t * 9;
  const e1 = [pos[o + 3]! - pos[o]!, pos[o + 4]! - pos[o + 1]!, pos[o + 5]! - pos[o + 2]!];
  const e2 = [pos[o + 6]! - pos[o]!, pos[o + 7]! - pos[o + 1]!, pos[o + 8]! - pos[o + 2]!];
  const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
  const len = Math.hypot(n[0]!, n[1]!, n[2]!);
  return len === 0 ? 1 : Math.abs(n[0]!) / len;
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
  /** Per run axis, the regions of the triangles touching the section's start (−) and end (+) planes. */
  ends: Record<'x' | 'y', { start: Set<string>; end: Set<string> }>;
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

function trimFacts(f: VoxelKitMeshFacts, layout: TrimLayout): TrimFacts | null {
  if (f.uv === null) return null;
  const out: TrimFacts = { regions: new Map(), straddle: 0, gutter: 0, texel: 0, density: 0, start: 0, profiled: [], caps: [], ends: { x: { start: new Set(), end: new Set() }, y: { start: new Set(), end: new Set() } } };
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
    if (r.kind !== 'cap' && normalX(f.positions, t) < 0.05) {
      const gu = gradient(f.positions, t, u0, u1, u2);
      if (gu !== null && Math.abs(gu[0] / perM - 1) > 0.02) out.density++;
      for (let k = 0; k < 3; k++) if (Math.abs(uv[t * 6 + k * 2]! - perM * (f.positions[t * 9 + k * 3]! + HALF)) > 0.002) {
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
    for (let k = 0; k < 3; k++) {
      for (const [axis, a] of [['x', 0], ['y', 1]] as const) {
        const c = f.positions[t * 9 + k * 3 + a]!;
        if (c <= -HALF + EPS) out.ends[axis].start.add(r.id);
        if (c >= HALF - EPS) out.ends[axis].end.add(r.id);
      }
    }
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

function trimRows(kit: VoxelKit, pieces: readonly Piece[], cat: CaseCatalogueDef): VoxelKitCheckRow[] {
  if (kit.trimLayout === undefined) return [];
  const layout = TRIM_LAYOUTS.get(kit.trimLayout);
  const d = (id: string, state: KitCheckState, title: string, detail: string): VoxelKitCheckRow => ({ id: `trim:${id}`, state, title: `${id} (draft layout): ${title}`, detail, draft: true });
  if (layout === undefined) return [d('layout', 'err', `unknown trim layout ${kit.trimLayout}`, `The layouts are ${[...TRIM_LAYOUTS.keys()].join(', ')} (a DRAFT the owner has not approved).`)];
  const per = new Map<Piece, TrimFacts | null>();
  for (const p of pieces) if (p.facts !== null && p.facts.unreadable === null && p.facts.found) per.set(p, trimFacts(p.facts, layout));
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
  rule('T3', list((t) => (t.texel > 0 ? `${t.texel} triangles not at 1024 px/m in V` : null)), 'warn', 'square texels (V at the sheet density)', 'texels not square');
  rule('T4', list((t) => (t.density > 0 || t.start > 0 ? `${t.density} run faces off 0.25 U a metre, ${t.start} not starting at U 0` : null)), 'err', 'U follows the run at 0.25 a metre from 0', 'U off the run density');
  rule('T5', list((t) => (t.profiled.length > 0 ? t.profiled.join(', ') : null)), 'warn', 'profiled strips on faces of their height', 'profiled strips on faces of another height');
  rule('T6', list((t) => (t.caps.length > 0 ? t.caps.join(', ') : null)), 'warn', 'end faces in the right cap cell', 'caps of the wrong size or cell');
  // T7: every variant of a section uses the same regions.
  const bySection = new Map<string, Set<string>[]>();
  for (const [p, t] of per) if (t !== null) bySection.set(`${p.caseId}/${p.sectionId}`, [...(bySection.get(`${p.caseId}/${p.sectionId}`) ?? []), new Set(t.regions.keys())]);
  const t7 = [...bySection].filter(([, sets]) => sets.some((s) => [...s].sort().join() !== [...sets[0]!].sort().join())).map(([k, sets]) => `${k}: ${sets.map((s) => [...s].sort().join('+') || 'none').join(' | ')}`);
  rule('T7', t7, 'warn', 'variants use the same regions', 'variants use different regions');
  // T8: faces meeting at a section join use the same regions on both sides.
  const t8: string[] = [];
  for (const cid of Object.keys(kit.cases)) {
    // Sections meet along their case's run (x, or y up a corner or a post); a case without a run never joins.
    const axis = cat.cases.find((c) => c.id === cid)?.run;
    if (axis !== 'x' && axis !== 'y') continue;
    const secs = sectionsOf(kit, cid);
    for (const [a, b] of meetingPairs(new Set(secs.keys()))) {
      const ta = [...per].find(([p]) => p.caseId === cid && p.sectionId === a && p.variant === 0)?.[1];
      const tb = [...per].find(([p]) => p.caseId === cid && p.sectionId === b && p.variant === 0)?.[1];
      if (ta == null || tb == null) continue;
      const ea = [...ta.ends[axis].end].sort().join('+');
      const sb = [...tb.ends[axis].start].sort().join('+');
      if (ea !== sb) t8.push(`${cid} ${a} end ${ea || 'none'} → ${b} start ${sb || 'none'}`);
    }
  }
  rule('T8', t8, 'warn', 'joined faces use the same regions on both sides', 'joined faces change region');
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
  for (const [cid, c] of Object.entries(kit.cases)) {
    for (const [sid, s] of Object.entries(c.sections ?? {})) {
      s.variants.forEach((v, k) => {
        const hf = facts(v.high);
        pieces.push({ caseId: cid, sectionId: sid, variant: k, mesh: v.high, facts: hf });
        reports.push({ caseId: cid, sectionId: sid, variant: k, triangles: hf !== null && hf.unreadable === null && hf.found ? hf.triangles : null, textures: hf?.textures ?? { count: 0, bytes: 0, sizes: [] } });
      });
    }
  }
  const rows = [...caseRows(kit, catalogue), ...aliasRows(kit), ...meshRows(pieces, assets), ...joinRows(kit)];
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
    title: `${totals.pieces} pieces: ${totals.triangles} triangles`,
    detail: `A piece: ${tris.length > 0 ? `min ${tris[0]}, median ${tris[tris.length >> 1]}, max ${tris[tris.length - 1]}` : 'none read'}. Textures: ${totals.textures} (${totals.textureBytes} bytes${sizes.length > 0 ? `; ${sizes.join(', ')}` : ''}). Reported, never capped.`,
  });
  rows.push(...trimRows(kit, pieces, catalogue));
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
