/**
 * The architecture generator: an `architecture` component's parameters in,
 * one chunk's meshes out — per material slot one set of flat typed arrays
 * (positions, normals, trim UVs, COLOR_0 with the baked AO) with the near
 * and far levels' indices, the kit models' copies the chunk places, and what could
 * not be made. The same function runs on the page, in the generator
 * workers and on the backend (an export that ships meshes), and gives the
 * same bytes in each (`arch-math.ts`).
 *
 * Chunks: a square grid of `chunkSize` metres in the object's frame. A
 * chunk holds the sweep cells whose middles lie in it, the fills whose
 * outline's centre lies in it, the copies standing in it and the openings
 * whose middle lies in it, so every piece is made by exactly one chunk and
 * a chunk depends only on the elements whose bounds reach it — the key a
 * chunk's meshes are cached under hashes only those (`architectureChunkKeys`).
 *
 * The far level is an index list over the same vertices that leaves out
 * detail elements, opening frames and coffer beams; walls, floors, vaults
 * and roofs stay.
 *
 * Also here: the colliders (boxes per wall segment, cut round openings;
 * meshes for floors and, when asked, roofs and vaults) and the kit copies
 * the simulation gives their models' colliders.
 *
 * Pure.
 */
import { len3, DEG, detSinCos, hashString, hashText64, quatFromBasis, seededRandom, yawQuat } from './arch-math';
import { ArchChunkWriters, type ArchMeshArrays, ArchMeshWriter, triangulatePolygon } from './arch-mesh';
import { type PathSamples, pathPointAt, samplePath } from './arch-path';
import { fillBaseY, fillOutline, writeFill } from './arch-fill';
import { openingSpan, writeFrame, writeReveals } from './arch-opening';
import { profileBounds, resolveProfile, type SweepCut, sweepFrames, sweepProfile } from './arch-sweep';
import {
  ARCHITECTURE_AO_DEFAULTS,
  ARCHITECTURE_CHUNK_DEFAULT,
  ARCHITECTURE_MATERIAL_SLOT,
  ARCHITECTURE_STEP_DEFAULT,
  type ArchitectureComponent,
  type ArchitectureElement,
  type ArchitectureFill,
  type ArchitectureModelRef,
  type ArchitectureProfile,
  type ArchitectureRepeat,
  type ArchitectureSweep,
  architectureMaterialSlots,
} from './architecture';
import { canonicalJsonText, sha256HexOfText } from './sha256';
import { defaultTrimSheet, type TrimRow, type TrimSheet, trimRowOf } from './trim-sheet';

/** Bumped whenever the generator's output for the same parameters changes: part of every cache key. */
export const ARCHITECTURE_GENERATOR_VERSION = 1;
/** The most metres between a sweep's cross-sections (its vertex density for AO and paint). */
export const ARCHITECTURE_SWEEP_CELL = 1;
/** Floats per kit copy: position, rotation quaternion, scale (an instance set's layout). */
export const ARCHITECTURE_COPY_FLOATS = 10;

/** The trim sheets per material slot (`*`: any slot without its own). */
export type ArchitectureSheets = Record<string, TrimSheet>;

/** One material's mesh in a chunk: its vertices and the near and far levels' triangles. */
export interface ArchitectureChunkMesh {
  material: string;
  mesh: ArchMeshArrays;
}

/** Copies of one kit model. */
export interface ArchitectureCopySet {
  model: ArchitectureModelRef;
  collide: boolean;
  /** Stable ids: element id and the copy's place (`wall:seg2`, `columns:7`). */
  ids: string[];
  transforms: Float32Array;
}

/** What one chunk is made of. */
export interface ArchitectureChunk {
  cx: number;
  cz: number;
  meshes: ArchitectureChunkMesh[];
  copies: ArchitectureCopySet[];
  problems: string[];
}

const chunkSizeOf = (c: ArchitectureComponent): number => c.chunkSize ?? ARCHITECTURE_CHUNK_DEFAULT;
const chunkOf = (v: number, size: number): number => Math.floor(v / size);
const keyOf = (cx: number, cz: number): string => `${cx},${cz}`;

/**
 * Metres an element's geometry may reach past its path's samples (level): a
 * profile's across extent times the sharpest mitre (a level path's up
 * stays up; a sloped one tilts it, so then the up extent counts too), a
 * frame round an opening, a roof's overhang, a repeat's offset and piece.
 */
function reachOf(e: ArchitectureElement, c: ArchitectureComponent, s: PathSamples): number {
  if (e.kind === 'sweep') {
    const p = c.profiles?.[e.profile];
    let across = 0;
    let up = 0;
    for (const q of p?.points ?? []) {
      across = Math.max(across, Math.abs(q[0]));
      up = Math.max(up, Math.abs(q[1]));
    }
    let frame = 0;
    for (const o of e.openings ?? []) {
      const f = o.frame !== undefined ? c.profiles?.[o.frame] : undefined;
      for (const q of f?.points ?? []) frame = Math.max(frame, Math.abs(q[0]) + Math.abs(q[1]));
    }
    return mitreOf(s) * (across + (levelPath(s) ? 0 : up)) + frame + 0.01;
  }
  if (e.kind === 'fill') return (e.overhang ?? 0) + (e.depth ?? 0) + 0.01;
  let r = Math.abs(e.offset?.[0] ?? 0) + Math.abs(e.offset?.[1] ?? 0) + (e.jitter?.along ?? 0);
  if ('elements' in e.piece) for (const x of e.piece.elements) r += pieceRadius(x, c);
  return r + 0.01;
}

/** Whether a path's samples all lie at one height. */
function levelPath(s: PathSamples): boolean {
  for (let i = 1; i < s.n; i++) if (Math.abs(s.pos[i * 3 + 1]! - s.pos[1]!) > 1e-6) return false;
  return true;
}

/** The most a profile is stretched at a sample's mitre (1 / cos of half the turn; the sweep caps it at 4). */
function mitreOf(s: PathSamples): number {
  let worst = 1;
  const segs = s.closed ? s.n : s.n - 1;
  for (let i = 0; i < s.n; i++) {
    const ja = i > 0 ? i - 1 : s.closed ? segs - 1 : -1;
    if (ja < 0 || i >= segs) continue;
    const a0 = ja;
    const a1 = (ja + 1) % s.n;
    const b1 = (i + 1) % s.n;
    const ax = s.pos[a1 * 3]! - s.pos[a0 * 3]!;
    const ay = s.pos[a1 * 3 + 1]! - s.pos[a0 * 3 + 1]!;
    const az = s.pos[a1 * 3 + 2]! - s.pos[a0 * 3 + 2]!;
    const bx = s.pos[b1 * 3]! - s.pos[i * 3]!;
    const by = s.pos[b1 * 3 + 1]! - s.pos[i * 3 + 1]!;
    const bz = s.pos[b1 * 3 + 2]! - s.pos[i * 3 + 2]!;
    const la = len3(ax, ay, az);
    const lb = len3(bx, by, bz);
    if (la < 1e-12 || lb < 1e-12) continue;
    const d = (ax * bx + ay * by + az * bz) / (la * lb);
    const half = Math.sqrt(Math.max(0, (1 + d) / 2));
    worst = Math.max(worst, half > 0.25 ? 1 / half : 4);
  }
  return worst;
}

function pieceRadius(e: ArchitectureSweep | ArchitectureFill, c: ArchitectureComponent): number {
  let r = 0;
  for (const q of e.path.points) r = Math.max(r, Math.abs(q[0]), Math.abs(q[2]));
  return r + reachOf(e, c, samplePath(e.path)) + Math.abs(e.path.offset ?? 0);
}

/** An element's XZ bounds (object frame): its path's samples widened by what it reaches past them. */
export function elementBounds(e: ArchitectureElement, c: ArchitectureComponent, samples?: PathSamples): [number, number, number, number] {
  const s = samples ?? samplePath(e.path);
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < s.n; i++) {
    x0 = Math.min(x0, s.pos[i * 3]!);
    x1 = Math.max(x1, s.pos[i * 3]!);
    z0 = Math.min(z0, s.pos[i * 3 + 2]!);
    z1 = Math.max(z1, s.pos[i * 3 + 2]!);
  }
  const r = reachOf(e, c, s);
  return [x0 - r, z0 - r, x1 + r, z1 + r];
}

/** The chunks an element's bounds reach. */
function chunksOf(b: readonly number[], size: number): [number, number][] {
  const out: [number, number][] = [];
  for (let cx = chunkOf(b[0]!, size); cx <= chunkOf(b[2]!, size); cx++) for (let cz = chunkOf(b[1]!, size); cz <= chunkOf(b[3]!, size); cz++) out.push([cx, cz]);
  return out;
}

/** The chunks a component's elements reach, in a stable order (by x, then z). */
export function architectureChunks(c: ArchitectureComponent): [number, number][] {
  const size = chunkSizeOf(c);
  const seen = new Map<string, [number, number]>();
  for (const e of c.elements) for (const k of chunksOf(elementBounds(e, c), size)) seen.set(keyOf(k[0], k[1]), k);
  return [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** The sheets the component's elements wear: the slot's own, else `*`'s, else the engine's starter sheet. */
export function sheetFor(sheets: ArchitectureSheets, material: string): TrimSheet {
  return sheets[material] ?? sheets['*'] ?? STARTER_SHEET;
}
const STARTER_SHEET = defaultTrimSheet();

/**
 * The sheets a component's slots wear: per material slot, the row table of
 * the trim material the object's `materials` maps it to (the slot's own
 * entry, else `*`). A slot dressed with no trim material has none here (the
 * generator then lays it out on the starter sheet).
 */
export function architectureSheets(c: Pick<ArchitectureComponent, 'elements'>, mapping: Readonly<Record<string, string>> | null | undefined, trimOf: (materialId: string) => TrimSheet | null): ArchitectureSheets {
  const out: ArchitectureSheets = {};
  for (const slot of architectureMaterialSlots(c)) {
    const id = mapping?.[slot] ?? mapping?.['*'];
    const sheet = id !== undefined ? trimOf(id) : null;
    if (sheet !== null) out[slot] = sheet;
  }
  return out;
}

/** A material's row table through its instance chain (an instance draws with its root's), or null when it is no trim material. */
export function trimSheetOfMaterial(defs: readonly { materialId: string; shader?: string; instanceOf?: string; trim?: TrimSheet }[], materialId: string): TrimSheet | null {
  let cur = defs.find((d) => d.materialId === materialId);
  for (let guard = 0; cur?.instanceOf !== undefined && guard < 64; guard++) {
    const parent: string = cur.instanceOf;
    cur = defs.find((d) => d.materialId === parent);
  }
  return cur?.shader === 'trim' && cur.trim !== undefined ? cur.trim : null;
}

/**
 * Each chunk's cache key: SHA-256 of the generator version, the chunk, the
 * settings that shape geometry, the sheets, and the elements (with the
 * profiles they sweep and their overrides) whose bounds reach the chunk — so changing one room
 * re-makes only that room's chunks.
 */
export function architectureChunkKeys(c: ArchitectureComponent, sheets: ArchitectureSheets): Map<string, ArchitectureChunkKey> {
  const size = chunkSizeOf(c);
  // The profiles go with the elements that use them: a profile changed (a slider) re-keys only those elements' chunks.
  const common = canonicalJsonText({ v: ARCHITECTURE_GENERATOR_VERSION, size, seed: c.seed ?? 0, ao: c.ao ?? null, sheets });
  const commonHash = sha256HexOfText(common);
  const per = new Map<string, { hashes: string[]; elements: number[] }>();
  const overrides = new Map<string, unknown[]>();
  for (const o of c.overrides ?? []) overrides.set(o.element, [...(overrides.get(o.element) ?? []), o]);
  c.elements.forEach((e, index) => {
    const profiles: Record<string, unknown> = {};
    for (const name of elementProfiles(e)) profiles[name] = c.profiles?.[name] ?? null;
    const h = hashText64(canonicalJsonText({ e, own: overrides.get(e.id) ?? [], profiles }));
    for (const [cx, cz] of chunksOf(elementBounds(e, c), size)) {
      const k = keyOf(cx, cz);
      const list = per.get(k);
      if (list === undefined) per.set(k, { hashes: [h], elements: [index] });
      else {
        list.hashes.push(h);
        list.elements.push(index);
      }
    }
  });
  const out = new Map<string, ArchitectureChunkKey>();
  for (const [k, { hashes, elements }] of per) {
    const [cx, cz] = k.split(',').map(Number) as [number, number];
    out.set(k, { cx, cz, key: sha256HexOfText(`${commonHash}|${k}|${hashes.join(',')}`), elements });
  }
  return out;
}

/** The profiles an element sweeps (its own, its openings' frames, its piece's), sorted. */
function elementProfiles(e: ArchitectureElement): string[] {
  const out = new Set<string>();
  const visit = (x: ArchitectureElement): void => {
    if (x.kind === 'sweep') {
      out.add(x.profile);
      for (const o of x.openings ?? []) if (o.frame !== undefined) out.add(o.frame);
    } else if (x.kind === 'repeat' && 'elements' in x.piece) for (const y of x.piece.elements) visit(y);
  };
  visit(e);
  return [...out].sort();
}

/** A chunk's place, cache key and the elements (indices into `elements`) whose bounds reach it. */
export interface ArchitectureChunkKey {
  cx: number;
  cz: number;
  key: string;
  elements: number[];
}

/** The component with only the elements that reach a chunk: what a chunk's job needs (it makes the same chunk). */
export function architectureChunkInput(c: ArchitectureComponent, k: Pick<ArchitectureChunkKey, 'elements'>): ArchitectureComponent {
  const elements = k.elements.map((i) => c.elements[i]!);
  if (c.profiles === undefined) return { ...c, elements };
  // Only the profiles these elements sweep travel with the job.
  const profiles: Record<string, ArchitectureProfile> = {};
  for (const e of elements) for (const name of elementProfiles(e)) if (c.profiles[name] !== undefined) profiles[name] = c.profiles[name]!;
  return { ...c, elements, profiles };
}

/** Copies being gathered for one chunk (or the whole component). */
class Copies {
  private readonly sets = new Map<string, { model: ArchitectureModelRef; collide: boolean; ids: string[]; t: number[] }>();
  add(model: ArchitectureModelRef, collide: boolean, id: string, p: readonly number[], q: readonly number[], sx = 1): void {
    const k = `${model.assetId}|${model.piece ?? ''}|${collide ? 1 : 0}`;
    let s = this.sets.get(k);
    if (s === undefined) {
      s = { model: { assetId: model.assetId, ...(model.piece !== undefined ? { piece: model.piece } : {}) }, collide, ids: [], t: [] };
      this.sets.set(k, s);
    }
    s.ids.push(id);
    s.t.push(p[0]!, p[1]!, p[2]!, q[0]!, q[1]!, q[2]!, q[3]!, sx, 1, 1);
  }
  finish(): ArchitectureCopySet[] {
    return [...this.sets.values()].map((s) => ({ model: s.model, collide: s.collide, ids: s.ids, transforms: Float32Array.from(s.t) }));
  }
}

/** A frame's quaternion from a path's tangent and the reference up: +X along, +Y up, +Z right of travel. */
function frameQuat(t: readonly number[]): number[] {
  const r = [-t[2]!, 0, t[0]!];
  const rl = len3(r[0]!, r[1]!, r[2]!);
  if (rl < 1e-9) return [0, 0, 0, 1];
  r[0]! /= rl;
  r[2]! /= rl;
  // up' = r × t
  const u = [r[1]! * t[2]! - r[2]! * t[1]!, r[2]! * t[0]! - r[0]! * t[2]!, r[0]! * t[1]! - r[1]! * t[0]!];
  return quatFromBasis(t, u, r);
}

/** The model copies an element places: overridden segments and corners, openings' models, a repeat's model copies. */
function elementCopies(e: ArchitectureElement, c: ArchitectureComponent, s: PathSamples, keep: (x: number, z: number) => boolean, out: Copies): void {
  const collide = e.collide ?? e.detail !== true;
  const p = [0, 0, 0];
  const t = [0, 0, 0];
  for (const o of c.overrides ?? []) {
    if (o.element !== e.id || e.kind === 'fill') continue;
    if (o.segment !== undefined) {
      const segs = s.closed ? s.pointDist.length : s.pointDist.length - 1;
      if (o.segment >= segs) continue;
      const d0 = s.pointDist[o.segment]!;
      const d1 = o.segment + 1 < s.pointDist.length ? s.pointDist[o.segment + 1]! : s.length;
      pathPointAt(s, d0, p, t);
      if (!keep(p[0]!, p[2]!)) continue;
      out.add(o.model, collide, `${e.id}:seg${o.segment}`, p, frameQuat(t), o.stretch === false ? 1 : d1 - d0);
    } else if (o.corner !== undefined && o.corner < s.pointDist.length) {
      pathPointAt(s, s.pointDist[o.corner]!, p, t);
      if (!keep(p[0]!, p[2]!)) continue;
      out.add(o.model, collide, `${e.id}:corner${o.corner}`, p, frameQuat(t));
    }
  }
  if (e.kind === 'sweep') {
    for (const o of e.openings ?? []) {
      if (o.model === undefined) continue;
      pathPointAt(s, o.at, p, t);
      p[1] = p[1]! + o.bottom;
      if (!keep(p[0]!, p[2]!)) continue;
      out.add(o.model, collide, `${e.id}:${o.id}`, p, frameQuat(t));
    }
  }
  if (e.kind === 'repeat' && 'model' in e.piece) {
    for (const k of repeatPlaces(e, c, s)) {
      if (!keep(k.x, k.z)) continue;
      out.add(e.piece.model, collide, `${e.id}:${k.index}`, [k.x, k.y, k.z], yawQuat(k.cos, k.sin));
    }
  }
}

/** Where a repeat's copies stand: position, heading (cos, sin of +X toward +Z... as a unit XZ vector) and index. */
export interface RepeatPlace {
  index: number;
  x: number;
  y: number;
  z: number;
  cos: number;
  sin: number;
}

/** A repeat's copies along its path (spacing from `start`, corners when asked; seeded jitter). */
export function repeatPlaces(e: ArchitectureRepeat, c: ArchitectureComponent, s: PathSamples): RepeatPlace[] {
  const L = s.length;
  const start = e.start ?? 0;
  const end = Math.min(e.end ?? L, L);
  const ds: number[] = [];
  for (let k = 0; ; k++) {
    const d = start + k * e.spacing;
    if (s.closed ? d >= L - 1e-9 : d > end + 1e-9) break;
    if (d > end + 1e-9) break;
    ds.push(d);
  }
  if (e.corners === true) {
    for (let i = 0; i < s.n; i++) {
      if (s.sharp[i] !== 1) continue;
      const d = s.dist[i]!;
      if (d < start - 1e-9 || d > end + 1e-9) continue;
      if (!ds.some((x) => Math.abs(x - d) < 1e-6)) ds.push(d);
    }
    ds.sort((a, b) => a - b);
  }
  const out: RepeatPlace[] = [];
  const p = [0, 0, 0];
  const t = [0, 0, 0];
  const sc: [number, number] = [0, 0];
  const seed = c.seed ?? 0;
  ds.forEach((d0, index) => {
    const rng = seededRandom(hashString(`${e.id}:${index}`, seed ^ 0x811c9dc5));
    const along = e.jitter?.along !== undefined ? (rng() * 2 - 1) * e.jitter.along : 0;
    const jyaw = e.jitter?.yaw !== undefined ? (rng() * 2 - 1) * e.jitter.yaw : 0;
    pathPointAt(s, d0 + along, p, t);
    let hx = 1;
    let hz = 0;
    if (e.align !== false) {
      const l = Math.sqrt(t[0]! * t[0]! + t[2]! * t[2]!);
      if (l > 1e-9) {
        hx = t[0]! / l;
        hz = t[2]! / l;
      }
    }
    // Right of travel (level) for the offset.
    const ox = e.offset?.[0] ?? 0;
    const oy = e.offset?.[1] ?? 0;
    const yaw = (e.yaw ?? 0) + jyaw;
    let cos = hx;
    let sin = hz;
    if (yaw !== 0) {
      detSinCos(yaw * DEG, sc);
      // Turned about +Y (counter-clockwise seen from above): x' = x·cos + z·sin, z' = −x·sin + z·cos.
      cos = hx * sc[1] + hz * sc[0];
      sin = -hx * sc[0] + hz * sc[1];
    }
    out.push({ index, x: p[0]! - hz * ox, y: p[1]! + oy, z: p[2]! + hx * ox, cos, sin });
  });
  return out;
}

/** Per-job state: path samples and stamped pieces made once per job. */
interface JobState {
  c: ArchitectureComponent;
  sheets: ArchitectureSheets;
  ao: { strength: number; radius: number };
  problems: Set<string>;
  samples: Map<ArchitectureElement, PathSamples>;
  pieces: Map<ArchitectureRepeat, ArchChunkWriters>;
}

function samplesOf(st: JobState, e: ArchitectureElement): PathSamples {
  let s = st.samples.get(e);
  if (s === undefined) {
    s = samplePath(e.path);
    st.samples.set(e, s);
  }
  return s;
}

function rowFinder(st: JobState, material: string): { sheet: TrimSheet; rowOf(slot: string): TrimRow | null } {
  const sheet = sheetFor(st.sheets, material);
  return {
    sheet,
    rowOf(slot: string): TrimRow | null {
      const r = trimRowOf(sheet, slot);
      if (r === null) st.problems.add(`material "${material}": its sheet has no row "${slot}"`);
      return r;
    },
  };
}

/** Write one element (its share of the chunk) into `w`. `own`: the chunk's test (absent: all of it, a piece). */
function writeElement(st: JobState, e: ArchitectureSweep | ArchitectureFill | ArchitectureRepeat, w: ArchChunkWriters, own: ((x: number, z: number) => boolean) | undefined): void {
  const c = st.c;
  const material = e.material ?? ARCHITECTURE_MATERIAL_SLOT;
  const { sheet, rowOf } = rowFinder(st, material);
  const s = samplesOf(st, e);
  const wasDetail = w.detail;
  // A detail element is in the near level only (and everything a detail repeat stamps).
  if (e.detail === true) w.detail = true;
  try {
    if (e.kind === 'sweep') writeSweep(st, e, w, own, material, sheet, rowOf, s);
    else if (e.kind === 'fill') {
      if (own !== undefined) {
        const outline = fillOutline(s);
        let mx = 0;
        let mz = 0;
        for (let i = 0; i < outline.length; i += 2) {
          mx += outline[i]!;
          mz += outline[i + 1]!;
        }
        const n = outline.length / 2;
        if (!own(mx / n, mz / n)) return;
      }
      const target = w.get(material);
      const problem = writeFill(target, target, e, s, { sheet, rowOf, aoStrength: st.ao.strength, aoRadius: st.ao.radius, step: e.path.step ?? ARCHITECTURE_STEP_DEFAULT });
      if (problem !== null) st.problems.add(problem);
    } else if ('elements' in e.piece) {
      let piece = st.pieces.get(e);
      if (piece === undefined) {
        piece = new ArchChunkWriters();
        for (const x of e.piece.elements) writeElement(st, { ...x, material: x.material ?? material }, piece, undefined);
        st.pieces.set(e, piece);
      }
      for (const k of repeatPlaces(e, c, s)) {
        if (own !== undefined && !own(k.x, k.z)) continue;
        for (const [mat, src] of piece.map) w.get(mat).stamp(src, k.cos, k.sin, k.x, k.y, k.z);
      }
    }
  } finally {
    w.detail = wasDetail;
  }
}

/** A sweep's share of the chunk: its strips (openings and overridden spans cut), the openings' reveals and frames. */
function writeSweep(st: JobState, e: ArchitectureSweep, w: ArchChunkWriters, own: ((x: number, z: number) => boolean) | undefined, material: string, sheet: TrimSheet, rowOf: (slot: string) => TrimRow | null, s: PathSamples): void {
  const c = st.c;
  const def = c.profiles?.[e.profile];
  if (def === undefined) {
    st.problems.add(`sweep "${e.id}": no profile "${e.profile}"`);
    return;
  }
  const cuts: SweepCut[] = [];
  const wallPts = resolveProfile(def, false).pts;
  for (const o of e.openings ?? []) {
    const sp = openingSpan(o, s, wallPts);
    if (sp.b > sp.a && sp.top > sp.bottom) cuts.push(sp);
  }
  for (const o of c.overrides ?? []) {
    if (o.element !== e.id) continue;
    if (o.segment !== undefined) {
      const segs = s.closed ? s.pointDist.length : s.pointDist.length - 1;
      if (o.segment < segs) cuts.push({ a: s.pointDist[o.segment]!, b: o.segment + 1 < s.pointDist.length ? s.pointDist[o.segment + 1]! : s.length });
    } else if (o.corner !== undefined && o.corner < s.pointDist.length) {
      const d = s.pointDist[o.corner]!;
      const r = o.reach ?? 0.5;
      cuts.push({ a: d - r, b: d + r });
      if (s.closed && d - r < 0) cuts.push({ a: s.length + d - r, b: s.length });
      if (s.closed && d + r > s.length) cuts.push({ a: 0, b: d + r - s.length });
    }
  }
  const fr = sweepFrames(s);
  sweepProfile(w.get(material), s, resolveProfile(def, true), { sheet, rowOf, cuts, ...(own !== undefined ? { own } : {}), aoStrength: st.ao.strength, aoRadius: st.ao.radius, cell: ARCHITECTURE_SWEEP_CELL });
  const p = [0, 0, 0];
  const t = [0, 0, 0];
  for (const o of e.openings ?? []) {
    if (o.model !== undefined) continue;
    pathPointAt(s, o.at, p, t);
    if (own !== undefined && !own(p[0]!, p[2]!)) continue;
    const sp = openingSpan(o, s, wallPts);
    if (!(sp.b > sp.a && sp.top > sp.bottom)) continue;
    const revealSlot = o.reveal ?? 'frame';
    if (revealSlot !== '') {
      const row = rowOf(revealSlot);
      if (row !== null) writeReveals(w.get(material), s, fr, wallPts, sp, sheet, row);
    }
    const frame = o.frame !== undefined ? c.profiles?.[o.frame] : undefined;
    if (frame !== undefined) {
      // Frames are trims: the far level keeps the hole and its reveals.
      const was = w.detail;
      w.detail = true;
      const sides: ('outer' | 'inner')[] = o.frameSides === 'both' ? ['outer', 'inner'] : [o.frameSides ?? 'outer'];
      for (const side of sides) writeFrame(w.get(material), s, fr, wallPts, sp, frame, side, sheet, rowOf);
      w.detail = was;
    }
  }
}

function jobState(c: ArchitectureComponent, sheets: ArchitectureSheets): JobState {
  const strength = c.ao?.strength ?? ARCHITECTURE_AO_DEFAULTS.strength;
  const radius = c.ao?.radius ?? ARCHITECTURE_AO_DEFAULTS.radius;
  return { c, sheets, ao: { strength, radius }, problems: new Set(), samples: new Map(), pieces: new Map() };
}

/** Make one chunk: the elements whose bounds reach it, their share of it. */
export function generateArchitectureChunk(c: ArchitectureComponent, sheets: ArchitectureSheets, cx: number, cz: number): ArchitectureChunk {
  const st = jobState(c, sheets);
  const size = chunkSizeOf(c);
  const own = (x: number, z: number): boolean => chunkOf(x, size) === cx && chunkOf(z, size) === cz;
  const w = new ArchChunkWriters();
  const copies = new Copies();
  const x0 = cx * size;
  const z0 = cz * size;
  for (const e of c.elements) {
    const s = samplesOf(st, e);
    const b = elementBounds(e, c, s);
    if (b[2] < x0 || b[0] > x0 + size || b[3] < z0 || b[1] > z0 + size) continue;
    writeElement(st, e, w, own);
    elementCopies(e, c, s, own, copies);
  }
  const meshes: ArchitectureChunkMesh[] = [];
  for (const [material, writer] of [...w.map].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (writer.indexCount === 0) continue;
    meshes.push({ material, mesh: writer.finish() });
  }
  return { cx, cz, meshes, copies: copies.finish(), problems: [...st.problems].sort() };
}

/** Every chunk of a component (an export that ships meshes; tests). */
export function generateArchitecture(c: ArchitectureComponent, sheets: ArchitectureSheets): ArchitectureChunk[] {
  return architectureChunks(c).map(([cx, cz]) => generateArchitectureChunk(c, sheets, cx, cz));
}

// ---- colliders --------------------------------------------------------------------------------

export type ArchitectureCollider =
  | { id: string; kind: 'box'; center: [number, number, number]; half: [number, number, number]; rotation: [number, number, number, number] }
  | { id: string; kind: 'mesh'; vertices: Float32Array; indices: Uint32Array }
  | { id: string; kind: 'model'; model: ArchitectureModelRef; position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] };

/** The most vertices and triangles one mesh collider takes (the physics port's bound per shape). */
export interface ArchitectureMeshBounds {
  vertices: number;
  triangles: number;
}

function boxCollider(id: string, p: readonly number[], t: readonly number[], len: number, x0: number, x1: number, y0: number, y1: number): ArchitectureCollider | null {
  if (len < 1e-4 || x1 - x0 < 1e-4 || y1 - y0 < 1e-4) return null;
  const r = [-t[2]!, 0, t[0]!];
  let rl = len3(r[0]!, r[1]!, r[2]!);
  if (rl < 1e-9) {
    r.splice(0, 3, 0, 0, 1);
    rl = 1;
  }
  r[0]! /= rl;
  r[2]! /= rl;
  const u = [r[1]! * t[2]! - r[2]! * t[1]!, r[2]! * t[0]! - r[0]! * t[2]!, r[0]! * t[1]! - r[1]! * t[0]!];
  const xc = (x0 + x1) / 2;
  const yc = (y0 + y1) / 2;
  const q = quatFromBasis(t, u, r);
  return {
    id,
    kind: 'box',
    center: [p[0]! + t[0]! * (len / 2) + r[0]! * xc + u[0]! * yc, p[1]! + t[1]! * (len / 2) + r[1]! * xc + u[1]! * yc, p[2]! + t[2]! * (len / 2) + r[2]! * xc + u[2]! * yc],
    half: [len / 2, (y1 - y0) / 2, (x1 - x0) / 2],
    rotation: [q[0]!, q[1]!, q[2]!, q[3]!],
  };
}

/** Split a triangle list into meshes within the bounds. */
function meshColliders(id: string, pos: ArrayLike<number>, idx: ArrayLike<number>, bounds: ArchitectureMeshBounds, out: ArchitectureCollider[]): void {
  let k = 0;
  let part = 0;
  while (k < idx.length) {
    const map = new Map<number, number>();
    const v: number[] = [];
    const ix: number[] = [];
    while (k < idx.length && ix.length / 3 < bounds.triangles) {
      const need = [idx[k]!, idx[k + 1]!, idx[k + 2]!].filter((i) => !map.has(i)).length;
      if (map.size + need > bounds.vertices) break;
      for (let j = 0; j < 3; j++) {
        const i = idx[k + j]!;
        let m = map.get(i);
        if (m === undefined) {
          m = map.size;
          map.set(i, m);
          v.push(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
        }
        ix.push(m);
      }
      k += 3;
    }
    if (ix.length === 0) break;
    out.push({ id: `${id}:${part++}`, kind: 'mesh', vertices: Float32Array.from(v), indices: Uint32Array.from(ix) });
  }
}

/**
 * Every collider of a component (object frame): boxes along each wall
 * segment (its profile's bounds; cut round openings and overridden spans;
 * stretched over sharp corners so outer corners close), meshes for flat
 * floors (and roofs and vaults that ask), a box per stamped piece copy, and
 * the kit copies whose models carry their own colliders.
 */
export function architectureColliders(c: ArchitectureComponent, sheets: ArchitectureSheets, bounds: ArchitectureMeshBounds): ArchitectureCollider[] {
  const st = jobState(c, sheets);
  const out: ArchitectureCollider[] = [];
  const all = (): boolean => true;
  for (const e of c.elements) {
    const s = samplesOf(st, e);
    const collide = e.collide ?? e.detail !== true;
    if (e.kind === 'sweep' && collide) {
      const def = c.profiles?.[e.profile];
      if (def === undefined) continue;
      const wall = resolveProfile(def, false).pts;
      const [x0, x1, y0, y1] = profileBounds(wall);
      const reach = Math.max(Math.abs(x0), Math.abs(x1));
      const holes = (e.openings ?? []).map((o) => openingSpan(o, s, wall)).filter((h) => h.b > h.a && h.top > h.bottom);
      const skips: [number, number][] = [];
      for (const o of c.overrides ?? []) {
        if (o.element !== e.id || o.segment === undefined) continue;
        const segs = s.closed ? s.pointDist.length : s.pointDist.length - 1;
        if (o.segment < segs) skips.push([s.pointDist[o.segment]!, o.segment + 1 < s.pointDist.length ? s.pointDist[o.segment + 1]! : s.length]);
      }
      const segs = s.closed ? s.n : s.n - 1;
      let n = 0;
      for (let j = 0; j < segs; j++) {
        const a = j;
        const b = (j + 1) % s.n;
        const t = [s.pos[b * 3]! - s.pos[a * 3]!, s.pos[b * 3 + 1]! - s.pos[a * 3 + 1]!, s.pos[b * 3 + 2]! - s.pos[a * 3 + 2]!];
        const len = len3(t[0]!, t[1]!, t[2]!);
        if (len < 1e-6) continue;
        for (let k = 0; k < 3; k++) t[k]! /= len;
        const d0 = s.dist[j]!;
        const d1 = s.dist[j + 1]!;
        // Cut points along the segment: openings and skipped spans.
        const marks = new Set<number>([d0, d1]);
        for (const h of holes) for (const x of [h.a, h.b]) if (x > d0 && x < d1) marks.add(x);
        for (const [sa, sb] of skips) for (const x of [sa, sb]) if (x > d0 && x < d1) marks.add(x);
        const ms = [...marks].sort((p, q) => p - q);
        for (let m = 0; m + 1 < ms.length; m++) {
          let da = ms[m]!;
          let db = ms[m + 1]!;
          const mid = (da + db) / 2;
          if (skips.some(([sa, sb]) => mid > sa && mid < sb)) continue;
          // Close outer corners: reach past a sharp sample by the wall's half thickness.
          if (da === d0 && s.sharp[a] === 1 && (s.closed || a > 0)) da -= reach;
          if (db === d1 && s.sharp[b] === 1 && (s.closed || j + 1 < s.n - 1)) db += reach;
          const p = [s.pos[a * 3]! + t[0]! * (da - d0), s.pos[a * 3 + 1]! + t[1]! * (da - d0), s.pos[a * 3 + 2]! + t[2]! * (da - d0)];
          const hole = holes.find((h) => mid > h.a && mid < h.b);
          const ranges: [number, number][] = hole === undefined ? [[y0, y1]] : [
            [y0, hole.bottom],
            [hole.top, y1],
          ];
          for (const [ya, yb] of ranges) {
            const box = boxCollider(`${e.id}:${n}`, p, t, db - da, x0, x1, ya, yb);
            if (box !== null) {
              out.push(box);
              n++;
            }
          }
        }
      }
    } else if (e.kind === 'fill' && (e.collide ?? (e.shape === 'flat' && (e.face ?? 'up') === 'up'))) {
      if (e.shape === 'flat' || e.shape === 'coffered') {
        const outline = fillOutline(s);
        const y = fillBaseY(s) + (e.height ?? 0);
        const tri = triangulatePolygon(outline);
        const pos: number[] = [];
        for (let i = 0; i < outline.length; i += 2) pos.push(outline[i]!, y, outline[i + 1]!);
        meshColliders(e.id, pos, tri, bounds, out);
      } else {
        // Vaults and roofs: their far level's surface.
        const w = new ArchMeshWriter();
        const { sheet, rowOf } = rowFinder(st, e.material ?? ARCHITECTURE_MATERIAL_SLOT);
        writeFill(w, w, e, s, { sheet, rowOf, aoStrength: 0, aoRadius: 1, step: Math.max(1, e.path.step ?? ARCHITECTURE_STEP_DEFAULT) });
        const m = w.finish();
        meshColliders(e.id, m.positions, m.farIndices, bounds, out);
      }
    } else if (e.kind === 'repeat' && 'elements' in e.piece && collide) {
      // A box round the piece per copy (made once: the piece's own bounds).
      const piece = new ArchChunkWriters();
      for (const x of e.piece.elements) writeElement(st, { ...x, detail: false }, piece, undefined);
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const [, near] of piece.map) for (let k = 0; k < 3; k++) {
        b[k] = Math.min(b[k]!, near.bounds[k]!);
        b[k + 3] = Math.max(b[k + 3]!, near.bounds[k + 3]!);
      }
      if (!(b[3]! > b[0]!)) continue;
      for (const k of repeatPlaces(e, c, s)) {
        const t = [k.cos, 0, k.sin];
        const p = [k.x + k.cos * b[0]!, k.y, k.z + k.sin * b[0]!];
        // In the copy's frame +Z is right of travel: the box's across range is the piece's z range.
        const box = boxCollider(`${e.id}:${k.index}`, p, t, b[3]! - b[0]!, b[2]!, b[5]!, b[1]!, b[4]!);
        if (box !== null) out.push(box);
      }
    }
    const copies = new Copies();
    elementCopies(e, c, s, all, copies);
    for (const set of copies.finish()) {
      if (!set.collide) continue;
      set.ids.forEach((id, i) => {
        const f = set.transforms.subarray(i * ARCHITECTURE_COPY_FLOATS, (i + 1) * ARCHITECTURE_COPY_FLOATS);
        out.push({ id, kind: 'model', model: set.model, position: [f[0]!, f[1]!, f[2]!], rotation: [f[3]!, f[4]!, f[5]!, f[6]!], scale: [f[7]!, f[8]!, f[9]!] });
      });
    }
  }
  return out;
}

/** Every kit copy of a component (all chunks): the page draws them as instance sets. */
export function architectureCopies(c: ArchitectureComponent): ArchitectureCopySet[] {
  const st = jobState(c, {});
  const copies = new Copies();
  for (const e of c.elements) elementCopies(e, c, samplesOf(st, e), () => true, copies);
  return copies.finish();
}
