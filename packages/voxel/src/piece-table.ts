/**
 * The piece table: what a derive job needs from a world's voxel kits to
 * choose each detail cell's piece, and nothing else. It is built on the main
 * thread from the kits (project-model's records, read here through the few
 * fields that decide a piece) and the rule set's case catalogue, and crosses
 * to the workers as a few hundred bytes a kit.
 *
 * - **Material → kit.** A voxel material names its kit through the kit's
 *   test binding (`materials`). A material no kit binds draws the engine's
 *   default pieces.
 * - **Kit-local pieces.** Each kit numbers its own pieces: the engine's
 *   default fallback pieces first (below {@link KIT_PIECE_BASE}: a
 *   procedural shape a run section, the same in every kit), then the kit's
 *   own (case, section) pairs in catalogue case order, then section order
 *   ({@link kitPieceList}). An instance's piece is such an index; the kit is
 *   its cell's material's, read from the shader data. So a kit's change
 *   moves no other kit's numbers, and only the cells of its own materials
 *   derive again.
 * - **Missing pieces.** A (case, section) the kit lacks takes, in order: the
 *   case's body section, then its single section; then the same in the
 *   case's stand-in (a later debris stage drawn by the first stage's piece);
 *   then the same in the
 *   fallback case of the case's role, when that case declares the same base
 *   and shape (a fallback must fill the same coarse shape the consumers
 *   read: a wall piece never stands in for a beam); then the engine's
 *   default piece where the base is left to a piece, and no piece where the
 *   base surface draws the cell.
 * - **Variants.** A piece's variant is drawn from a hash of the world cell
 *   (at its level) and the kit's seed, weighted by the variants' weights: an
 *   edit elsewhere, a load order or a neighbour outside the case never
 *   reshuffles it. The seed is a hash of the kit's id, so a new kit
 *   revision keeps every variant where it was.
 *
 * - **The default kit.** A table may name one kit (the engine's procedural
 *   fallback kit, default-kit.ts) that every material no kit binds draws
 *   with, so a world without game kits still shows pieces; it is a kit like
 *   any other in the table, numbered and hashed the same way.
 *
 * The table is versioned ({@link PIECE_TABLE_FORMAT}) and names the rule set
 * whose catalogue numbered its cases; a derive refuses a table of another
 * rule set. Its bytes are canonical: equal kits give equal bytes and hash.
 */
import { crc32, latticeHash4, utf8Decode, utf8Encode } from '@thirdlight/shared';
import type { AssemblyRuleSet } from './assembly';
import type { CaseCatalogueDef, CaseDef } from './kit-cases';
import { RUN_SECTION } from './kit-runs';
import { MATERIAL_ID_MAX, swapFrom, swapTo } from './record';

/** The table's byte layout version; a reader refuses any other (2: the default kit's slot after the kit count). */
export const PIECE_TABLE_FORMAT = 2;

/** Run section ids as kits name them, by section index ({@link RUN_SECTION}). */
export const RUN_SECTION_IDS: readonly string[] = Object.freeze(
  Object.entries(RUN_SECTION)
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k),
);

/** Sections a case can have pieces for. */
export const RUN_SECTIONS = RUN_SECTION_IDS.length;

/** No piece (a kit slot), and no kit (a material). */
export const NO_PIECE = 0xffff;
export const NO_KIT = 0xffff;

/** Kit-local piece indices below this are the engine's default pieces: family << 3 | run section. */
export const KIT_PIECE_BASE = 32;

/** An instance's variant word: bit 15 the mirror of its case transform, bits 0–14 the variant. */
export const PIECE_VARIANT_MIRROR = 0x8000;
export const PIECE_VARIANT_MASK = 0x7fff;

/** The engine's default piece of a stand-in family (derived-mesh.ts PIECE_FAMILY) and run section. */
export function defaultPiece(family: number, section: number): number {
  return (family << 3) | section;
}

/** The stand-in family of a default piece, or 0 for a kit's own piece. */
export function defaultPieceFamily(piece: number): number {
  return piece < KIT_PIECE_BASE ? piece >> 3 : 0;
}

/** The run section of a default piece. */
export function defaultPieceSection(piece: number): number {
  return piece & 7;
}

/**
 * A case drawn by another case's mesh (a kit's alias): `case` names the kit's case whose sections it draws,
 * `rotation` which of the 24 cube rotations (cube-rotations.ts) turns that mesh first, in the case's own orientation.
 */
export interface PieceAlias {
  readonly case: string;
  readonly rotation: number;
}

/** What a piece table reads of a kit (project-model's voxel kit record fits it). */
export interface PieceKitSource {
  readonly voxelKitId: string;
  /** The voxel material ids the kit applies to (its test binding). */
  readonly materials?: readonly number[];
  readonly cases: Readonly<Record<string, { readonly sections?: Readonly<Record<string, { readonly variants: readonly { readonly weight?: number }[] }>>; readonly alias?: PieceAlias }>>;
}

/** One of a kit's own pieces: a case's section, with its variants' weights. */
export interface KitPiece {
  readonly caseId: string;
  readonly caseIndex: number;
  readonly sectionId: string;
  readonly section: number;
  /** Each variant's weight (absent in the kit: 1), in the kit's order. */
  readonly weights: readonly number[];
  /** The kit case whose meshes draw it: its own, or its alias's. */
  readonly meshCaseId: string;
  /** The cube rotation its meshes are turned by first (0: an own case's). */
  readonly rotation: number;
}

/**
 * A kit's own pieces in their kit-local order (index {@link KIT_PIECE_BASE}
 * + position): catalogue case order, then section order. Cases and sections
 * the catalogue does not know are left out and named in `problems` (the kit
 * check reports them; they never draw).
 */
export function kitPieceList(kit: PieceKitSource, catalogue: CaseCatalogueDef): { pieces: KitPiece[]; problems: string[] } {
  const problems: string[] = [];
  const known = new Set(catalogue.cases.map((c) => c.id));
  for (const id of Object.keys(kit.cases)) if (!known.has(id)) problems.push(`kit ${kit.voxelKitId}: case "${id}" is not in catalogue ${catalogue.id} v${catalogue.version}`);
  const pieces: KitPiece[] = [];
  catalogue.cases.forEach((c, caseIndex) => {
    const own = kit.cases[c.id];
    const alias = own?.sections === undefined ? own?.alias : undefined;
    // An alias draws its target's sections turned; a target that is itself an alias draws nothing (the format refuses it).
    const target = alias === undefined ? own : kit.cases[alias.case];
    if (alias !== undefined && (target?.sections === undefined || alias.case === c.id)) {
      problems.push(`kit ${kit.voxelKitId}: case "${c.id}" is an alias of "${alias.case}", which has no pieces of its own`);
      return;
    }
    const secs = target?.sections;
    if (secs === undefined) return;
    if (alias === undefined) for (const sid of Object.keys(secs)) if (!RUN_SECTION_IDS.includes(sid)) problems.push(`kit ${kit.voxelKitId}: case "${c.id}" section "${sid}" is not a run section (${RUN_SECTION_IDS.join(', ')})`);
    RUN_SECTION_IDS.forEach((sid, section) => {
      const s = secs[sid];
      if (s === undefined || s.variants.length === 0) return;
      pieces.push({ caseId: c.id, caseIndex, sectionId: sid, section, weights: s.variants.map((v) => v.weight ?? 1), meshCaseId: alias?.case ?? c.id, rotation: alias?.rotation ?? 0 });
    });
  });
  if (pieces.length > NO_PIECE - KIT_PIECE_BASE) throw new RangeError(`kit ${kit.voxelKitId}: ${pieces.length} pieces past the u16 piece index`);
  return { pieces, problems };
}

/** One kit's part of a table. */
export interface PieceTableKit {
  readonly id: string;
  /** Hash of the kit's id: the variant seed. */
  readonly seed: number;
  /** CRC-32 of the kit's part of the table bytes (what decides its materials' pieces). */
  readonly hash: number;
  /** Per case index × {@link RUN_SECTIONS} + section: the kit-local piece the fallback order gives, or {@link NO_PIECE}. */
  readonly slots: Uint16Array;
  /** Per own piece (kit-local index − {@link KIT_PIECE_BASE}): where its variant thresholds start in `thresholds` (one entry more than pieces). */
  readonly thresholdStart: Uint32Array;
  /** Per piece, one u16 threshold between consecutive variants: a hash below the k-th picks variant k. */
  readonly thresholds: Uint16Array;
}

export interface PieceTable {
  readonly rules: { readonly id: string; readonly version: number };
  readonly caseCount: number;
  /** The kit every unbound material draws with (its index in `kits`), or {@link NO_KIT}. */
  readonly defaultKit: number;
  /** Per voxel material id: its kit's index in `kits`, or {@link NO_KIT}. */
  readonly materialKit: Uint16Array;
  readonly kits: readonly PieceTableKit[];
  /** The canonical bytes (what a derive job carries). */
  readonly bytes: Uint8Array;
  /** CRC-32 of the bytes. */
  readonly hash: number;
}

/** A case's base and shape agree with another's (a fallback piece fills the same coarse shape). */
function sameForm(a: CaseDef, b: CaseDef): boolean {
  return a.base === b.base && a.shape === b.shape;
}

/** Fallback sections of a section, in order: itself, the body, the single. */
function sectionChain(section: number): number[] {
  return [...new Set([section, RUN_SECTION.body, RUN_SECTION.single])];
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

/** Thresholds for variant weights: hash16 < t[k] picks variant k; the last variant takes the rest. */
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

/**
 * Builds the piece table of `kits` for a rule set with a case pass (its
 * catalogue numbers the cases). A material two kits bind goes to the first
 * by kit id; that and the kits' unknown cases and sections are `problems`
 * (the kit check's rows), never refusals. `defaultKit`: the kit every
 * material no kit binds draws with (its own binding is not read); it takes
 * the slot after the sorted kits.
 */
export function buildPieceTable(kits: readonly PieceKitSource[], rules: AssemblyRuleSet, defaultKit?: PieceKitSource): { table: PieceTable; problems: string[] } {
  const catalogue = rules.catalogue;
  if (catalogue === undefined) throw new RangeError(`rule set ${rules.id} has no case catalogue: no kit pieces`);
  const problems: string[] = [];
  const own = [...kits].sort((a, b) => (a.voxelKitId < b.voxelKitId ? -1 : a.voxelKitId > b.voxelKitId ? 1 : 0));
  if (defaultKit !== undefined && own.some((k) => k.voxelKitId === defaultKit.voxelKitId)) throw new RangeError(`kit ${defaultKit.voxelKitId}: a project kit has the default kit's id`);
  const sorted = defaultKit === undefined ? own : [...own, { ...defaultKit, materials: [] }];
  const caseIndex = new Map(catalogue.cases.map((c, k) => [c.id, k]));
  const w = new Writer();
  w.u16(PIECE_TABLE_FORMAT);
  w.text(rules.id);
  w.u16(rules.version);
  w.u16(catalogue.cases.length);
  w.u16(sorted.length);
  w.u16(defaultKit === undefined ? NO_KIT : own.length);
  const bound = new Map<number, number>();
  sorted.forEach((kit, slot) => {
    const { pieces, problems: p } = kitPieceList(kit, catalogue);
    problems.push(...p);
    const own = new Map<number, number>();
    pieces.forEach((pc, k) => own.set(pc.caseIndex * RUN_SECTIONS + pc.section, KIT_PIECE_BASE + k));
    const inCase = (c: number, section: number): number => {
      for (const s of sectionChain(section)) {
        const p = own.get(c * RUN_SECTIONS + s);
        if (p !== undefined) return p;
      }
      return NO_PIECE;
    };
    w.text(kit.voxelKitId);
    w.u32(crc32(utf8Encode(kit.voxelKitId)));
    w.u16(pieces.length);
    catalogue.cases.forEach((c, k) => {
      const standIn = c.standIn === undefined ? undefined : caseIndex.get(c.standIn);
      const fb = caseIndex.get(catalogue.fallback[c.roles[0]!] ?? '');
      for (let s = 0; s < RUN_SECTIONS; s++) {
        let p = inCase(k, s);
        if (p === NO_PIECE && standIn !== undefined && sameForm(c, catalogue.cases[standIn]!)) p = inCase(standIn, s);
        if (p === NO_PIECE && fb !== undefined && fb !== k && sameForm(c, catalogue.cases[fb]!)) p = inCase(fb, s);
        w.u16(p);
      }
    });
    for (const pc of pieces) {
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
  const kitCount = u16();
  const defaultKit = u16();
  if (defaultKit !== NO_KIT && defaultKit >= kitCount) throw new RangeError(`piece table: default kit ${defaultKit} of ${kitCount}`);
  const kits: PieceTableKit[] = [];
  for (let k = 0; k < kitCount; k++) {
    const start = o;
    const id = text();
    const seed = u32();
    const pieces = u16();
    const slots = new Uint16Array(caseCount * RUN_SECTIONS);
    for (let i = 0; i < slots.length; i++) {
      const p = u16();
      if (p !== NO_PIECE && (p < KIT_PIECE_BASE || p >= KIT_PIECE_BASE + pieces)) throw new RangeError(`piece table: kit ${id} slot ${i} names piece ${p} of ${pieces}`);
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
    kits.push({ id, seed, hash: crc32(bytes.subarray(start, o)), slots, thresholdStart, thresholds: Uint16Array.from(thresholds) });
  }
  // Air (0) never draws a piece; every other material no pair names takes the default kit.
  const materialKit = new Uint16Array(MATERIAL_ID_MAX + 1).fill(defaultKit);
  materialKit[0] = NO_KIT;
  const pairs = u32();
  for (let i = 0; i < pairs; i++) {
    const m = u16();
    const slot = u16();
    if (m < 1 || m > MATERIAL_ID_MAX || slot >= kitCount) throw new RangeError(`piece table: material ${m} → kit ${slot} of ${kitCount}`);
    materialKit[m] = slot;
  }
  if (o !== bytes.length) throw new RangeError(`piece table: ${bytes.length - o} bytes past its end`);
  return { rules, caseCount, defaultKit, materialKit, kits, bytes, hash: crc32(bytes) };
}

/** Whether a table binds any material to a kit (else every cell draws the default pieces, as without a table). */
export function pieceTableBindsKits(t: PieceTable | null): boolean {
  if (t === null) return false;
  for (let m = 1; m < t.materialKit.length; m++) if (t.materialKit[m] !== NO_KIT) return true;
  return false;
}

/**
 * Whether any of an edit's material changes ({@link materialSwap}s) moves
 * cells to another kit's pieces: the material it left and the one it took
 * are bound to different kits (no kit counts as one). A change within one
 * kit (oak to maple of the same timber kit) keeps every piece and variant:
 * a cell's piece reads its material only through its kit, and its variant
 * hashes the cell and the kit's seed, never the material.
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
  return k === NO_KIT ? 0 : t.kits[k]!.hash || 1;
}

/**
 * The materials whose pieces differ between two tables (bound, unbound,
 * moved to another kit, or their kit changed), or null when the tables
 * number cases for different rule sets (everything differs).
 */
export function pieceTableChanges(a: PieceTable | null, b: PieceTable | null): Set<number> | null {
  if (a !== null && b !== null && (a.rules.id !== b.rules.id || a.rules.version !== b.rules.version)) return null;
  const out = new Set<number>();
  for (let m = 1; m <= MATERIAL_ID_MAX; m++) if (materialPrint(a, m) !== materialPrint(b, m)) out.add(m);
  return out;
}

/**
 * The kit-local piece of a cell of `material` with case index `caseIndex`
 * and run section `section` from the table: its kit's own piece by the
 * fallback order, or {@link NO_PIECE} (the engine's default, or nothing,
 * is the caller's choice by the cell's base).
 */
export function tablePiece(t: PieceTable, material: number, caseIndex: number, section: number): number {
  const k = t.materialKit[material]!;
  if (k === NO_KIT) return NO_PIECE;
  return t.kits[k]!.slots[caseIndex * RUN_SECTIONS + section]!;
}

/**
 * The variant of a kit's own piece at world cell (x, y, z) of chunk-tree
 * level `level`: a hash of the cell, the level, the kit's seed and `slot`
 * (which of the cell's pieces it is: its case, yaw and placement, so the
 * edges of one cell vary independently), placed among the variants by their
 * weights. 0 for a default piece or a piece with one variant.
 */
export function pieceVariant(t: PieceTable, material: number, piece: number, level: number, x: number, y: number, z: number, slot = 0): number {
  if (piece < KIT_PIECE_BASE) return 0;
  const kit = t.kits[t.materialKit[material]!]!;
  const p = piece - KIT_PIECE_BASE;
  const start = kit.thresholdStart[p]!;
  const end = kit.thresholdStart[p + 1]!;
  if (end === start) return 0;
  const h = latticeHash4(x, y, z, (kit.seed + Math.imul(level, 0x9e3779b9) + Math.imul(slot, 0x85ebca6b)) | 0) >>> 16;
  let v = 0;
  while (start + v < end && h >= kit.thresholds[start + v]!) v++;
  return v;
}

/** Tables a thread keeps decoded, by hash: the last few (a table changes only when a kit does). */
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
