/**
 * The resident voxel chunks' keyed faces (`surface-cache-voxels.ts`) in one
 * hash, kept as chunks come, go and move on the cache's pages: what the
 * materials' lookup (`surface-cache-lookup.ts`, a pixel's cell and face) and
 * the resolve table (`surface-resolve.ts`, a traced hit's) read. A change
 * writes only the slots of the faces of the chunks that came, went or moved
 * (and the few entries a deletion shifts back), so a page streaming chunks
 * never packs every resident face again; the hash is made again whole only
 * when it outgrows its slots (or holds far fewer than it was made for).
 *
 * A slot is four words: the face's keys (`voxelSlotKeys`: x | z << 16 and
 * y | (face + 1) << 16, each coordinate + 32768; the second 0: free), its
 * chart's place on its page (page | interior corner x << 12 | y << 20 |
 * the cache level << 28; the interior's texels follow from the chart's
 * columns and level, `voxelAreaTexels`), and its column in the chart u | v
 * << 8 with the chart's columns w << 16 | h << 24. Linear probing, deletion
 * by backward shift (a search stops at the first free slot).
 *
 * A face two chunks key (their margins) is the one whose chunk's own box
 * holds the face's cell, else the first chunk by key: the same whichever
 * came first, so the table read after any order of changes equals one made
 * from the resident chunks at once.
 *
 * Pure (no three.js, no device).
 */
import { VOXEL_SIZE_M } from '@thirdlight/voxel';

import { SURFACE_CHART_BORDER, SURFACE_PAGE_TEXELS, SURFACE_TEXEL_METRES, type AtlasBlock, type SurfaceChart, type TilePacking } from './surface-cache-atlas';
import { VOXEL_FRAME_WORDS, VOXEL_KEY_BEHIND, VOXEL_KEY_MARGIN, type VoxelChunkCharts, type VoxelTile } from './surface-cache-voxels';

/** Words of a slot. */
export const VOXEL_FACE_SLOT_WORDS = 4;

/** A voxel face's slot keys: x | z << 16 and y | (face + 1) << 16, each coordinate + 32768. */
export function voxelSlotKeys(x: number, y: number, z: number, face: number): [number, number] {
  return [(((x + 32768) & 0xffff) | (((z + 32768) & 0xffff) << 16)) >>> 0, (((y + 32768) & 0xffff) | ((face + 1) << 16)) >>> 0];
}

/** A voxel face's home slot in a hash of `cap` slots (the shaders hash alike, in u32). */
export function voxelSlotHash(k0: number, k1: number, cap: number): number {
  let h = (Math.imul(k0, 0x9e3779b1) ^ Math.imul(k1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) & (cap - 1);
}

/** Texels at level 0 across a voxel cell (a chart of w cells holds ⌈w × this ÷ 2^level⌉ texels across: `areaTexels`). */
export const VOXEL_CELL_TEXELS = Math.round(VOXEL_SIZE_M / SURFACE_TEXEL_METRES);
if (Math.abs(VOXEL_CELL_TEXELS * SURFACE_TEXEL_METRES - VOXEL_SIZE_M) > 1e-9) throw new Error('surface cache: a voxel cell is not a whole number of texels');

/** The interior texels across `cells` columns of a voxel chart at `level`, in whole numbers (`areaTexels` of its metres). */
export function voxelAreaTexels(cells: number, level: number): number {
  return Math.min(SURFACE_PAGE_TEXELS - 2 * SURFACE_CHART_BORDER, Math.max(1, (cells * VOXEL_CELL_TEXELS + (1 << level) - 1) >> level));
}

/** What the cache holds of a resident tile. */
export interface VoxelFaceResident {
  readonly level: number;
  readonly blocks: readonly AtlasBlock[];
  readonly packing: TilePacking;
  readonly charts: readonly SurfaceChart[];
}

/** A chart's place on its page, as a slot holds it. */
export function voxelChartPlace(r: VoxelFaceResident, c: number): number {
  const pl = r.packing.places[c]!;
  const b = r.blocks[pl.block]!;
  return (b.page | ((b.x + pl.x + SURFACE_CHART_BORDER) << 12) | ((b.y + pl.y + SURFACE_CHART_BORDER) << 20) | (r.level << 28)) >>> 0;
}

/** A chunk's keyed faces as slot entries: keys, chart, the slot's last word; and whether each face's cell lies in the chunk's own box. */
interface FaceEntries {
  readonly words: Uint32Array;
  readonly own: Uint8Array;
}

const entriesWith = new WeakMap<VoxelChunkCharts, FaceEntries>();
const entriesWithout = new WeakMap<VoxelChunkCharts, FaceEntries>();

/** A chunk's keyed faces (`behind`: also the cells behind its surfaces, where a walk's hit stops), made once with its charts. */
export function voxelFaceEntries(m: VoxelChunkCharts, behind: boolean): FaceEntries {
  const memo = behind ? entriesWith : entriesWithout;
  const had = memo.get(m);
  if (had !== undefined) return had;
  const s = m.edge + 2 * VOXEL_KEY_MARGIN;
  const words: number[] = [];
  const own: number[] = [];
  for (let i = 0; i < m.keys.length; i += 1) {
    const o = m.offsets[i]!;
    if (!behind && (o & VOXEL_KEY_BEHIND) !== 0) continue;
    const key = m.keys[i]!;
    const lc = Math.floor(key / 6);
    const lx = (lc % s) - VOXEL_KEY_MARGIN;
    const ly = Math.floor(lc / (s * s)) - VOXEL_KEY_MARGIN;
    const lz = (Math.floor(lc / s) % s) - VOXEL_KEY_MARGIN;
    const [k0, k1] = voxelSlotKeys(lx + m.cell0[0], ly + m.cell0[1], lz + m.cell0[2], key % 6);
    const c = m.chartOf[i]!;
    const f = c * VOXEL_FRAME_WORDS;
    words.push(k0, k1, c, ((o & 0x7fff) | (m.frames[f + 3]! << 16) | (m.frames[f + 4]! << 24)) >>> 0);
    own.push(lx >= 0 && ly >= 0 && lz >= 0 && lx < m.edge && ly < m.edge && lz < m.edge ? 1 : 0);
  }
  const out = { words: Uint32Array.from(words), own: Uint8Array.from(own) };
  memo.set(m, out);
  return out;
}

interface Held {
  readonly id: number;
  readonly key: string;
  readonly made: VoxelChunkCharts;
  readonly entries: FaceEntries;
  places: Uint32Array;
}

/** What one `sync` did: slots written (the changed chunks' faces, shifts and promotions), whether the hash was made again whole, and the chunks and faces that changed. */
export interface VoxelFaceSync {
  readonly touched: number;
  readonly rebuilt: boolean;
  readonly tiles: number;
  readonly faces: number;
}

/** A face's keys as one number (k1 holds 19 bits). */
const keyOf = (k0: number, k1: number): number => k0 * 524288 + k1;

export class VoxelFaceTable {
  /** `VOXEL_FACE_SLOT_WORDS` a slot. */
  words = new Uint32Array(0);
  cap = 0;
  count = 0;
  /** The longest probe any face took from its home slot since the hash was made (a reader looks at most that far). */
  probe = 0;
  private owner = new Int32Array(0);
  private entryOf = new Int32Array(0);
  private readonly held = new Map<string, Held>();
  private readonly byId = new Map<number, Held>();
  private nextId = 1;
  /** Faces another chunk's entry holds the slot of, by key: [chunk id, entry, …]. */
  private readonly shadowed = new Map<number, number[]>();
  private dirty = new Set<number>();
  private whole = true;
  private touched = 0;

  /** `behind`: also key the cells behind surfaces (the resolve's walk hits); `maxLoad`: the share of slots held before it grows. */
  constructor(readonly behind: boolean, readonly maxLoad: number) {}

  /** Bytes on the page: the slots, their owners and the chunks' entries. */
  get bytes(): number {
    let n = this.words.byteLength + this.owner.byteLength + this.entryOf.byteLength;
    for (const h of this.held.values()) n += h.entries.words.byteLength + h.entries.own.byteLength + h.places.byteLength;
    return n;
  }

  /** The resident chunks now (`resident`: what the cache holds of a tile; none: not resident): those that came, went or moved are written. */
  sync(tiles: readonly VoxelTile[], resident: (key: string) => VoxelFaceResident | undefined): VoxelFaceSync {
    const t0 = this.touched;
    const live: { tile: VoxelTile; r: VoxelFaceResident }[] = [];
    const liveKeys = new Map<string, VoxelTile>();
    for (const tile of tiles) {
      if (tile.made === null) continue;
      const r = resident(tile.key);
      if (r === undefined) continue;
      live.push({ tile, r });
      liveKeys.set(tile.key, tile);
    }
    let tilesChanged = 0;
    let faces = 0;
    for (const h of [...this.held.values()]) {
      const t = liveKeys.get(h.key);
      if (t !== undefined && t.made === h.made) continue;
      tilesChanged += 1;
      faces += h.entries.own.length;
      this.removeTile(h);
    }
    let need = this.count;
    for (const { tile } of live) if (!this.held.has(tile.key)) need += voxelFaceEntries(tile.made!, this.behind).own.length;
    const shrink = this.cap > 1024 && need < this.cap * this.maxLoad * 0.125;
    if (this.cap === 0 ? need > 0 : need > this.cap * this.maxLoad || shrink) {
      this.rebuild(live, need);
      return { touched: this.touched - t0, rebuilt: true, tiles: live.length, faces: this.count };
    }
    for (const { tile, r } of live) {
      const h = this.held.get(tile.key);
      if (h === undefined) {
        const e = voxelFaceEntries(tile.made!, this.behind);
        tilesChanged += 1;
        faces += e.own.length;
        this.addTile(tile, r);
        continue;
      }
      const n = this.movePlaces(h, r);
      if (n > 0) {
        tilesChanged += 1;
        faces += n;
      }
    }
    return { touched: this.touched - t0, rebuilt: false, tiles: tilesChanged, faces };
  }

  /** The slots written since last taken (`whole`: the hash was made again: all of it). */
  takeDirty(): { readonly whole: boolean; readonly slots: number[] } {
    const out = { whole: this.whole, slots: this.whole ? [] : [...this.dirty].sort((a, b) => a - b) };
    this.whole = false;
    this.dirty = new Set();
    return out;
  }

  /** A face's last two slot words (null: not keyed). */
  get(k0: number, k1: number): [number, number] | null {
    const s = this.find(k0, k1);
    return s < 0 ? null : [this.words[s * 4 + 2]!, this.words[s * 4 + 3]!];
  }

  /** Every keyed face: k0, k1 and its two words. */
  *faces(): Generator<[number, number, number, number]> {
    for (let s = 0; s < this.cap; s += 1) if (this.words[s * 4 + 1] !== 0) yield [this.words[s * 4]!, this.words[s * 4 + 1]!, this.words[s * 4 + 2]!, this.words[s * 4 + 3]!];
  }

  private rebuild(live: readonly { tile: VoxelTile; r: VoxelFaceResident }[], need: number): void {
    let cap = 2;
    // Room for a third more than it holds now at the least, so it is made again only after the faces grew by that.
    while (cap * this.maxLoad * 0.75 < need) cap *= 2;
    this.cap = need === 0 ? 0 : cap;
    this.words = new Uint32Array(this.cap * VOXEL_FACE_SLOT_WORDS);
    this.owner = new Int32Array(this.cap).fill(-1);
    this.entryOf = new Int32Array(this.cap);
    this.held.clear();
    this.byId.clear();
    this.shadowed.clear();
    this.count = 0;
    this.probe = 0;
    for (const { tile, r } of live) this.addTile(tile, r);
    this.whole = true;
    this.dirty = new Set();
  }

  private placesOf(made: VoxelChunkCharts, r: VoxelFaceResident): Uint32Array {
    const out = new Uint32Array(made.charts.length);
    for (let c = 0; c < out.length; c += 1) out[c] = voxelChartPlace(r, c);
    return out;
  }

  private addTile(tile: VoxelTile, r: VoxelFaceResident): void {
    const h: Held = { id: this.nextId++, key: tile.key, made: tile.made!, entries: voxelFaceEntries(tile.made!, this.behind), places: this.placesOf(tile.made!, r) };
    this.held.set(h.key, h);
    this.byId.set(h.id, h);
    for (let i = 0; i < h.entries.own.length; i += 1) this.insert(h, i);
  }

  /** A held chunk's charts moved on the pages (another level, packed again): its slots take the new places. Returns the faces rewritten. */
  private movePlaces(h: Held, r: VoxelFaceResident): number {
    const next = this.placesOf(h.made, r);
    let moved = false;
    for (let c = 0; c < next.length; c += 1) if (next[c] !== h.places[c]) moved = true;
    if (!moved) return 0;
    const was = h.places;
    h.places = next;
    const e = h.entries.words;
    let n = 0;
    for (let i = 0; i < h.entries.own.length; i += 1) {
      const c = e[i * 4 + 2]!;
      if (next[c] === was[c]) continue;
      n += 1;
      const s = this.find(e[i * 4]!, e[i * 4 + 1]!);
      if (s < 0 || this.owner[s] !== h.id || this.entryOf[s] !== i) continue;
      this.words[s * 4 + 2] = next[c]!;
      this.dirty.add(s);
      this.touched += 1;
    }
    return n;
  }

  private removeTile(h: Held): void {
    for (let i = 0; i < h.entries.own.length; i += 1) this.remove(h, i);
    this.held.delete(h.key);
    this.byId.delete(h.id);
  }

  private find(k0: number, k1: number): number {
    if (this.cap === 0) return -1;
    const mask = this.cap - 1;
    let s = voxelSlotHash(k0, k1, this.cap);
    for (let p = 0; p <= mask; p += 1) {
      const w1 = this.words[s * 4 + 1]!;
      if (w1 === 0) return -1 - s;
      if (w1 === k1 && this.words[s * 4] === k0) return s;
      s = (s + 1) & mask;
    }
    return -1 - s;
  }

  /** Whether entry `ai` of `a` takes a face's slot from entry `bi` of `b`. */
  private wins(a: Held, ai: number, b: Held, bi: number): boolean {
    const oa = a.entries.own[ai]!;
    const ob = b.entries.own[bi]!;
    return oa !== ob ? oa > ob : a.key < b.key;
  }

  private write(s: number, h: Held, i: number): void {
    const e = h.entries.words;
    this.words[s * 4] = e[i * 4]!;
    this.words[s * 4 + 1] = e[i * 4 + 1]!;
    this.words[s * 4 + 2] = h.places[e[i * 4 + 2]!]!;
    this.words[s * 4 + 3] = e[i * 4 + 3]!;
    this.owner[s] = h.id;
    this.entryOf[s] = i;
    this.dirty.add(s);
    this.touched += 1;
  }

  private insert(h: Held, i: number): void {
    const e = h.entries.words;
    const k0 = e[i * 4]!;
    const k1 = e[i * 4 + 1]!;
    const s = this.find(k0, k1);
    if (s < 0) {
      const at = -1 - s;
      this.write(at, h, i);
      this.count += 1;
      this.probe = Math.max(this.probe, (at - voxelSlotHash(k0, k1, this.cap)) & (this.cap - 1));
      return;
    }
    const o = this.byId.get(this.owner[s]!)!;
    const oi = this.entryOf[s]!;
    if (this.wins(h, i, o, oi)) {
      this.shadow(keyOf(k0, k1), o.id, oi);
      this.write(s, h, i);
    } else this.shadow(keyOf(k0, k1), h.id, i);
  }

  private shadow(key: number, id: number, i: number): void {
    const list = this.shadowed.get(key);
    if (list === undefined) this.shadowed.set(key, [id, i]);
    else list.push(id, i);
  }

  private remove(h: Held, i: number): void {
    const e = h.entries.words;
    const k0 = e[i * 4]!;
    const k1 = e[i * 4 + 1]!;
    const key = keyOf(k0, k1);
    const s = this.find(k0, k1);
    if (s >= 0 && this.owner[s] === h.id && this.entryOf[s] === i) {
      this.deleteAt(s);
      this.count -= 1;
      this.promote(key);
      return;
    }
    const list = this.shadowed.get(key);
    if (list === undefined) return;
    for (let k = 0; k < list.length; k += 2) {
      if (list[k] !== h.id || list[k + 1] !== i) continue;
      list.splice(k, 2);
      break;
    }
    if (list.length === 0) this.shadowed.delete(key);
  }

  /** The best entry another chunk keys a freed face by takes its slot. */
  private promote(key: number): void {
    const list = this.shadowed.get(key);
    if (list === undefined) return;
    let best = -1;
    for (let k = 0; k < list.length; k += 2) {
      if (best < 0 || this.wins(this.byId.get(list[k]!)!, list[k + 1]!, this.byId.get(list[best]!)!, list[best + 1]!)) best = k;
    }
    const h = this.byId.get(list[best]!)!;
    const i = list[best + 1]!;
    list.splice(best, 2);
    if (list.length === 0) this.shadowed.delete(key);
    this.insert(h, i);
  }

  /** Backward shift: each later entry of the run moves into the hole when its home slot does not lie past the hole. */
  private deleteAt(at: number): void {
    const mask = this.cap - 1;
    let i = at;
    let j = at;
    for (;;) {
      j = (j + 1) & mask;
      const w1 = this.words[j * 4 + 1]!;
      if (w1 === 0) break;
      const home = voxelSlotHash(this.words[j * 4]!, w1, this.cap);
      if (((j - home) & mask) >= ((j - i) & mask)) {
        this.words.copyWithin(i * 4, j * 4, j * 4 + 4);
        this.owner[i] = this.owner[j]!;
        this.entryOf[i] = this.entryOf[j]!;
        this.dirty.add(i);
        this.touched += 1;
        i = j;
      }
    }
    this.words.fill(0, i * 4, i * 4 + 4);
    this.owner[i] = -1;
    this.dirty.add(i);
    this.touched += 1;
  }
}

/** Slots this close together are written as one run (a write call costs more than the words between). */
const SLOT_RUN_GAP = 64;

/** The dirty `slots` (sorted) as runs of words of `words` (`slotWords` a slot), each handed to `write` (word range [from, to)); returns the bytes written. */
export function writeSlotRuns(slots: readonly number[], words: Uint32Array, slotWords: number, write: (from: number, to: number) => void): number {
  let bytes = 0;
  for (let k = 0; k < slots.length; ) {
    const first = slots[k]!;
    let last = first;
    k += 1;
    while (k < slots.length && slots[k]! - last <= SLOT_RUN_GAP) last = slots[k++]!;
    const from = first * slotWords;
    const to = Math.min(words.length, (last + 1) * slotWords);
    write(from, to);
    bytes += (to - from) * 4;
  }
  return bytes;
}
