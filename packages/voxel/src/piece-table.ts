/**
 * The piece table: what a derive job needs from a world's voxel kits to
 * choose each detail piece, and nothing else. It is built on the main
 * thread from the kits (project-model's records, read here through the few
 * fields that decide a piece), the rule set's case catalogue and the
 * project's piece seed, and crosses to the workers as a few hundred bytes a
 * kit.
 *
 * - **Material → kit.** A voxel material names its kit through the kit's
 *   test binding (`materials`). A material no kit binds draws no pieces: its
 *   edges are plain voxel faces.
 * - **Slots.** Every case of the catalogue is a slot of every kit (the case
 *   id is the slot's stable name). A kit fills a slot with one or more
 *   meshes, each with a cube rotation and a weight, or leaves it empty: an
 *   empty slot draws nothing, with no stand-in and no fallback. A kit's
 *   pieces are its filled slots in catalogue order ({@link kitPieceList}),
 *   numbered from 0; an instance's piece is such an index, its kit its
 *   cell's material's (read from the shader data). So a kit's change moves
 *   no other kit's numbers, and only the cells of its own materials derive
 *   again.
 * - **Mesh picks.** Which of a slot's meshes a piece draws (its variant) is
 *   a hash of the world cell (at its level), the project's seed and which of
 *   the cell's pieces it is, placed among the meshes by their weights: an
 *   edit elsewhere, a load order or a kit's revision never reshuffles it,
 *   and a scene draws the same on every load and machine. A project that
 *   wants another arrangement changes its seed.
 * - **Jitter.** Each kit carries its jitter (piece-placement.ts): how far
 *   its pieces move into the solid and twist. It is drawing only, but it is
 *   in the table so a change re-derives the kit's cells and their draws are
 *   built again with it.
 * - **Damage stages.** Each kit carries its integrity ranges for the three
 *   damage stages and the pieces a face toward a hole carries
 *   (damage-stages.ts); a material without a kit takes the engine's.
 *
 * The table is versioned ({@link PIECE_TABLE_FORMAT}) and names the rule set
 * whose catalogue numbered its cases; a derive refuses a table of another
 * rule set. Its bytes are canonical: equal kits and seed give equal bytes
 * and hash.
 */
import { crc32, latticeHash4, utf8Decode, utf8Encode } from '@thirdlight/shared';
import type { AssemblyRuleSet } from './assembly';
import { CUBE_ROTATION_COUNT } from './cube-rotations';
import type { CaseCatalogueDef } from './kit-cases';
import { DAMAGE_PIECES_MAX, DAMAGE_STAGES, resolveDamageStages, type DamageStages, type DamageStageSpan, type DamageStagesSource } from './damage-stages';
import { PIECE_JITTER_DEFAULT, PIECE_JITTER_MAX } from './piece-placement';
import { damagedIntegrity, MATERIAL_ID_MAX, SHAPE_FULL, swapFrom, swapTo } from './record';

/** The table's byte layout version; a reader refuses any other (3: slots, the project's seed and each kit's jitter; 4: each kit's damage stages). */
export const PIECE_TABLE_FORMAT = 4;

/** No piece (an empty slot), and no kit (a material). */
export const NO_PIECE = 0xffff;
export const NO_KIT = 0xffff;

/** An instance's variant word: bit 15 the mirror of its case transform, bits 0–14 which of its slot's meshes it draws. */
export const PIECE_VARIANT_MIRROR = 0x8000;
export const PIECE_VARIANT_MASK = 0x7fff;

/** One mesh of a slot as the table reads it: its cube rotation (absent: 0) and weight (absent: 1). */
export interface PieceSlotMeshSource {
  readonly rotation?: number;
  readonly weight?: number;
}

/** What a piece table reads of a kit (project-model's voxel kit record fits it). */
export interface PieceKitSource {
  readonly voxelKitId: string;
  /** The voxel material ids the kit applies to (its test binding). */
  readonly materials?: readonly number[];
  /** Case id → the meshes its slot holds (a case the kit leaves out is an empty slot). */
  readonly slots: Readonly<Record<string, { readonly meshes: readonly PieceSlotMeshSource[] }>>;
  /** How far its pieces move into the solid and twist, a scale of the engine's stagger (absent: {@link PIECE_JITTER_DEFAULT}). */
  readonly jitter?: number;
  /** Its damage stages (absent: the engine's, damage-stages.ts). */
  readonly damage?: DamageStagesSource;
}

/** One of a kit's pieces: a filled slot, with each of its meshes' weight and rotation. */
export interface KitPiece {
  readonly caseId: string;
  readonly caseIndex: number;
  /** Each mesh's weight (absent in the kit: 1), in the kit's order. */
  readonly weights: readonly number[];
  /** Each mesh's cube rotation (absent in the kit: 0), in the kit's order. */
  readonly rotations: readonly number[];
}

/**
 * A kit's pieces in their kit-local order (index = position): its filled
 * slots in catalogue case order. Slots the catalogue does not know are left
 * out and named in `problems` (the kit check reports them; they never draw).
 */
export function kitPieceList(kit: PieceKitSource, catalogue: CaseCatalogueDef): { pieces: KitPiece[]; problems: string[] } {
  const problems: string[] = [];
  const known = new Set(catalogue.cases.map((c) => c.id));
  for (const id of Object.keys(kit.slots)) if (!known.has(id)) problems.push(`kit ${kit.voxelKitId}: slot "${id}" is not a case of catalogue ${catalogue.id} v${catalogue.version}`);
  const pieces: KitPiece[] = [];
  catalogue.cases.forEach((c, caseIndex) => {
    const meshes = kit.slots[c.id]?.meshes;
    if (meshes === undefined || meshes.length === 0) return;
    pieces.push({ caseId: c.id, caseIndex, weights: meshes.map((m) => m.weight ?? 1), rotations: meshes.map((m) => m.rotation ?? 0) });
  });
  if (pieces.length >= NO_PIECE) throw new RangeError(`kit ${kit.voxelKitId}: ${pieces.length} pieces past the u16 piece index`);
  return { pieces, problems };
}

/** One kit's part of a table. */
export interface PieceTableKit {
  readonly id: string;
  /** Its jitter (a scale of the engine's stagger, piece-placement.ts). */
  readonly jitter: number;
  /** Its damage stages, resolved. */
  readonly damage: DamageStages;
  /** A hash of the kit's part of the table bytes and the table's seed (what decides its materials' pieces). */
  readonly hash: number;
  /** Per case index: the kit-local piece of its slot, or {@link NO_PIECE} for an empty slot. */
  readonly slots: Uint16Array;
  /** Per piece: where its mesh thresholds start in `thresholds` (one entry more than pieces). */
  readonly thresholdStart: Uint32Array;
  /** Per piece, one u16 threshold between consecutive meshes: a hash below the k-th picks mesh k. */
  readonly thresholds: Uint16Array;
}

export interface PieceTable {
  readonly rules: { readonly id: string; readonly version: number };
  readonly caseCount: number;
  /** The project's piece seed: every mesh pick and stagger hashes it. */
  readonly seed: number;
  /** Per voxel material id: its kit's index in `kits`, or {@link NO_KIT}. */
  readonly materialKit: Uint16Array;
  readonly kits: readonly PieceTableKit[];
  /** The canonical bytes (what a derive job carries). */
  readonly bytes: Uint8Array;
  /** CRC-32 of the bytes. */
  readonly hash: number;
}

class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private room(n: number): number {
    const at = this.length;
    if (at + n > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, at + n));
      next.set(this.buf.subarray(0, at));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    this.length = at + n;
    return at;
  }

  // Each write takes its room first: growing replaces the buffer and its view.
  u16(v: number): void {
    const at = this.room(2);
    this.view.setUint16(at, v, true);
  }

  u32(v: number): void {
    const at = this.room(4);
    this.view.setUint32(at, v >>> 0, true);
  }

  f32(v: number): void {
    const at = this.room(4);
    this.view.setFloat32(at, v, true);
  }

  text(s: string): void {
    const b = utf8Encode(s);
    this.u16(b.length);
    const at = this.room(b.length);
    this.buf.set(b, at);
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Thresholds for mesh weights: hash16 < t[k] picks mesh k; the last mesh takes the rest. */
function weightThresholds(weights: readonly number[]): number[] {
  const total = weights.reduce((a, w) => a + w, 0);
  const out: number[] = [];
  let sum = 0;
  for (let k = 0; k < weights.length - 1; k++) {
    sum += weights[k]!;
    out.push(Math.min(0xffff, Math.round((sum / total) * 0x10000)));
  }
  return out;
}

/** Whether a seed is one the table holds: a whole number 0 … 2³² − 1. */
function checkSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError(`piece seed ${seed} is not a whole number 0-${0xffffffff}`);
}

/**
 * Builds the piece table of `kits` for a rule set with a case catalogue,
 * with the project's piece seed. A material two kits bind goes to the first
 * by kit id; that, the kits' unknown slots and a jitter or rotation out of
 * range are `problems` (the kit check's rows), never refusals.
 */
export function buildPieceTable(kits: readonly PieceKitSource[], rules: AssemblyRuleSet, seed: number): { table: PieceTable; problems: string[] } {
  const catalogue = rules.catalogue;
  if (catalogue === undefined) throw new RangeError(`rule set ${rules.id} has no case catalogue: no kit pieces`);
  checkSeed(seed);
  const problems: string[] = [];
  const sorted = [...kits].sort((a, b) => (a.voxelKitId < b.voxelKitId ? -1 : a.voxelKitId > b.voxelKitId ? 1 : 0));
  const w = new Writer();
  w.u16(PIECE_TABLE_FORMAT);
  w.text(rules.id);
  w.u16(rules.version);
  w.u16(catalogue.cases.length);
  w.u32(seed);
  w.u16(sorted.length);
  const bound = new Map<number, number>();
  sorted.forEach((kit, slot) => {
    const { pieces, problems: p } = kitPieceList(kit, catalogue);
    problems.push(...p);
    let jitter = kit.jitter ?? PIECE_JITTER_DEFAULT;
    if (!Number.isFinite(jitter) || jitter < 0 || jitter > PIECE_JITTER_MAX) {
      problems.push(`kit ${kit.voxelKitId}: jitter ${jitter} is outside 0-${PIECE_JITTER_MAX}; ${PIECE_JITTER_DEFAULT} drawn`);
      jitter = PIECE_JITTER_DEFAULT;
    }
    const byCase = new Map(pieces.map((pc, k) => [pc.caseIndex, k]));
    const damage = resolveDamageStages(kit.damage);
    for (const d of damage.problems) problems.push(`kit ${kit.voxelKitId}: ${d}; the engine's damage stages drawn`);
    w.text(kit.voxelKitId);
    w.f32(jitter);
    // Each stage: whether the kit uses it, its integrity range and its pieces a face.
    damage.stages.spans.forEach((sp, k) => {
      w.u16(sp === null ? 0 : 1);
      w.u16(sp?.min ?? 0);
      w.u16(sp?.max ?? 0);
      w.u16(damage.stages.pieces[k + 1]!);
    });
    w.u16(pieces.length);
    for (let c = 0; c < catalogue.cases.length; c++) w.u16(byCase.get(c) ?? NO_PIECE);
    for (const pc of pieces) {
      for (const r of pc.rotations) if (!Number.isInteger(r) || r < 0 || r >= CUBE_ROTATION_COUNT) problems.push(`kit ${kit.voxelKitId}: slot "${pc.caseId}" rotation ${r} is not a cube rotation`);
      const t = weightThresholds(pc.weights);
      w.u16(t.length);
      for (const v of t) w.u16(v);
    }
    for (const m of kit.materials ?? []) {
      if (!Number.isInteger(m) || m < 1 || m > MATERIAL_ID_MAX) problems.push(`kit ${kit.voxelKitId}: material ${m} is not a voxel material id`);
      else if (bound.has(m)) problems.push(`material ${m}: bound by kits ${sorted[bound.get(m)!]!.voxelKitId} and ${kit.voxelKitId}; ${sorted[bound.get(m)!]!.voxelKitId} draws it`);
      else bound.set(m, slot);
    }
  });
  const pairs = [...bound].sort((a, b) => a[0] - b[0]);
  w.u32(pairs.length);
  for (const [m, slot] of pairs) {
    w.u16(m);
    w.u16(slot);
  }
  return { table: readPieceTable(w.done()), problems };
}

/** Reads a table from its bytes (a worker's copy), checking every bound; throws a RangeError on a damaged or newer table. */
export function readPieceTable(bytes: Uint8Array): PieceTable {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n: number): void => {
    if (o + n > bytes.length) throw new RangeError(`piece table: ${bytes.length} bytes end inside a field at ${o}`);
  };
  const u16 = (): number => {
    need(2);
    const v = view.getUint16(o, true);
    o += 2;
    return v;
  };
  const u32 = (): number => {
    need(4);
    const v = view.getUint32(o, true);
    o += 4;
    return v;
  };
  const f32 = (): number => {
    need(4);
    const v = view.getFloat32(o, true);
    o += 4;
    return v;
  };
  const text = (): string => {
    const n = u16();
    need(n);
    const s = utf8Decode(bytes.subarray(o, o + n));
    o += n;
    return s;
  };
  const format = u16();
  if (format !== PIECE_TABLE_FORMAT) throw new RangeError(`piece table format ${format}, this engine reads ${PIECE_TABLE_FORMAT}`);
  const rules = { id: text(), version: u16() };
  const caseCount = u16();
  const seed = u32();
  const kitCount = u16();
  const kits: PieceTableKit[] = [];
  for (let k = 0; k < kitCount; k++) {
    const start = o;
    const id = text();
    const jitter = f32();
    if (!(jitter >= 0 && jitter <= PIECE_JITTER_MAX)) throw new RangeError(`piece table: kit ${id} jitter ${jitter}`);
    const spans: (DamageStageSpan | null)[] = [];
    for (let st = 1; st <= 3; st++) {
      const used = u16();
      const min = u16();
      const max = u16();
      const n = u16();
      if (used > 1 || (used === 1 && (min < 1 || max >= SHAPE_FULL || min > max || n > DAMAGE_PIECES_MAX || (st === 1) !== (n === 0)))) throw new RangeError(`piece table: kit ${id} damage stage ${st}`);
      spans.push(used === 0 ? null : n === 0 ? { min, max } : { min, max, pieces: n });
    }
    const damage = resolveDamageStages({ stage1: spans[0]!, stage2: spans[1]!, stage3: spans[2]! });
    if (damage.problems.length > 0) throw new RangeError(`piece table: kit ${id} damage stages: ${damage.problems.join('; ')}`);
    const pieces = u16();
    const slots = new Uint16Array(caseCount);
    for (let i = 0; i < caseCount; i++) {
      const p = u16();
      if (p !== NO_PIECE && p >= pieces) throw new RangeError(`piece table: kit ${id} slot ${i} names piece ${p} of ${pieces}`);
      slots[i] = p;
    }
    const thresholdStart = new Uint32Array(pieces + 1);
    const thresholds: number[] = [];
    for (let p = 0; p < pieces; p++) {
      thresholdStart[p] = thresholds.length;
      const n = u16();
      for (let t = 0; t < n; t++) thresholds.push(u16());
    }
    thresholdStart[pieces] = thresholds.length;
    // The seed decides every pick of the kit, so it is part of what a material's pieces depend on.
    const hash = (crc32(bytes.subarray(start, o)) ^ Math.imul(seed, 0x9e3779b1)) >>> 0 || 1;
    kits.push({ id, jitter, damage: damage.stages, hash, slots, thresholdStart, thresholds: Uint16Array.from(thresholds) });
  }
  const materialKit = new Uint16Array(MATERIAL_ID_MAX + 1).fill(NO_KIT);
  const pairs = u32();
  for (let i = 0; i < pairs; i++) {
    const m = u16();
    const slot = u16();
    if (m < 1 || m > MATERIAL_ID_MAX || slot >= kitCount) throw new RangeError(`piece table: material ${m} → kit ${slot} of ${kitCount}`);
    materialKit[m] = slot;
  }
  if (o !== bytes.length) throw new RangeError(`piece table: ${bytes.length - o} bytes past its end`);
  return { rules, caseCount, seed, materialKit, kits, bytes, hash: crc32(bytes) };
}

/** Whether a table binds any material to a kit (else no cell draws a piece, as without a table). */
export function pieceTableBindsKits(t: PieceTable | null): boolean {
  if (t === null) return false;
  for (let m = 1; m < t.materialKit.length; m++) if (t.materialKit[m] !== NO_KIT) return true;
  return false;
}

/**
 * Whether any of an edit's material changes ({@link materialSwap}s) moves
 * cells to another kit's pieces: the material it left and the one it took
 * are bound to different kits (no kit counts as one). A change within one
 * kit (oak to maple of the same timber kit) keeps every piece and mesh
 * pick: a cell's piece reads its material only through its kit, and its
 * pick hashes the cell and the seed, never the material.
 */
export function pieceTableKitChanges(t: PieceTable | null, swaps: readonly number[]): boolean {
  if (t === null) return false;
  for (const sw of swaps) if (t.materialKit[swapFrom(sw)] !== t.materialKit[swapTo(sw)]) return true;
  return false;
}

/** What decides a material's pieces in a table: its kit's hash, or 0 when it has none. */
function materialPrint(t: PieceTable | null, m: number): number {
  if (t === null) return 0;
  const k = t.materialKit[m]!;
  return k === NO_KIT ? 0 : t.kits[k]!.hash;
}

/**
 * The materials whose pieces differ between two tables (bound, unbound,
 * moved to another kit, their kit changed, or the seed changed), or null
 * when the tables number cases for different rule sets (everything differs).
 */
export function pieceTableChanges(a: PieceTable | null, b: PieceTable | null): Set<number> | null {
  if (a !== null && b !== null && (a.rules.id !== b.rules.id || a.rules.version !== b.rules.version)) return null;
  const out = new Set<number>();
  for (let m = 1; m <= MATERIAL_ID_MAX; m++) if (materialPrint(a, m) !== materialPrint(b, m)) out.add(m);
  return out;
}

/** The kit-local piece of a cell of `material` with case index `caseIndex`: its kit's filled slot, or {@link NO_PIECE} (no kit, or an empty slot: nothing drawn). */
export function tablePiece(t: PieceTable, material: number, caseIndex: number): number {
  const k = t.materialKit[material]!;
  if (k === NO_KIT) return NO_PIECE;
  return t.kits[k]!.slots[caseIndex]!;
}

/**
 * The mesh of a kit's piece at world cell (x, y, z) of chunk-tree level
 * `level`: a hash of the cell, the level, the table's seed and `slot`
 * (which of the cell's pieces it is: its case, yaw and placement, so the
 * edges of one cell vary independently), placed among the slot's meshes by
 * their weights. 0 for a slot with one mesh.
 */
export function pieceVariant(t: PieceTable, material: number, piece: number, level: number, x: number, y: number, z: number, slot = 0): number {
  const kit = t.kits[t.materialKit[material]!]!;
  const start = kit.thresholdStart[piece]!;
  const end = kit.thresholdStart[piece + 1]!;
  if (end === start) return 0;
  const h = latticeHash4(x, y, z, (t.seed + Math.imul(level, 0x9e3779b9) + Math.imul(slot, 0x85ebca6b)) | 0) >>> 16;
  let v = 0;
  while (start + v < end && h >= kit.thresholds[start + v]!) v++;
  return v;
}

/** The damage stages a cell of value `v` is shown by: its material's kit's, or the engine's (no kit, no table). */
export function cellDamageStages(t: PieceTable | null, v: number): DamageStages {
  if (t === null) return DAMAGE_STAGES;
  const k = t.materialKit[v & MATERIAL_ID_MAX]!;
  return k === NO_KIT ? DAMAGE_STAGES : t.kits[k]!.damage;
}

/** The damage stage (damage-stages.ts DAMAGE_STAGE) a cell of value `v` is shown at: 0 for an intact one, any role but construction, air. */
export function damageStageOf(t: PieceTable | null, v: number): number {
  const i = damagedIntegrity(v);
  return i === 0 ? 0 : cellDamageStages(t, v).stage[i]!;
}

/** The crack overlay's strength (0 … 255) of a cell of value `v`: non-zero only in stage 1. */
export function crackStrengthOf(t: PieceTable | null, v: number): number {
  const i = damagedIntegrity(v);
  return i === 0 ? 0 : cellDamageStages(t, v).crack[i]!;
}

/** Tables a thread keeps decoded, by hash: the last few (a table changes only when a kit or the seed does). */
const decoded = new Map<number, PieceTable>();
const DECODED_KEPT = 4;

/** A job's table bytes, decoded once a thread and kept by hash. */
export function pieceTableOf(bytes: Uint8Array): PieceTable {
  const h = crc32(bytes);
  const known = decoded.get(h);
  if (known !== undefined && known.bytes.length === bytes.length) return known;
  const t = readPieceTable(bytes);
  if (decoded.size >= DECODED_KEPT) decoded.delete(decoded.keys().next().value!);
  decoded.set(h, t);
  return t;
}
