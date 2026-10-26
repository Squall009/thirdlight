/**
 * The traced scene kept packed on a page: each kind's section lies at a
 * fixed place in one word buffer with room to grow, and a scene packed
 * again re-writes only the sections whose inputs changed (a block layer's
 * new chunk re-writes the block layers, not the terrain's rings), copying
 * the items it packed before (`placeItem`). What changed comes back as
 * word ranges, so the GPU copy is written only there.
 *
 * The buffer is bound whole as one storage binding, so its size is held
 * within the device's `maxStorageBufferBindingSize` (the default 128 MiB
 * unless the device was asked for more): a memory budget, not a count of
 * anything. Room to grow is given up first; a scene that still does not
 * fit is not packed (`fits: false`, the last one stays) and said so.
 *
 * Pure (no three.js, no device).
 */
import {
  HEADER,
  LAYER_WORDS,
  SCENE_HEADER_WORDS,
  TERRAIN_WORDS,
  itemDataWords,
  packBlockLayerItem,
  packObjectSections,
  packTerrainItem,
  placeItem,
  type PackedItem,
  type PackedTraceScene,
  type TraceBlockLayer,
  type TraceSceneSource,
  type TraceTerrain,
} from './tracer-scene';
import type { BrickAtlas } from './tracer-objects';
import { Words } from './tracer-words';

/** A storage binding's size when the device was asked for no more (WebGPU's default limit). */
export const DEFAULT_STORAGE_BINDING_BYTES = 128 * 1024 * 1024;
/** Room a section is given to grow past what it holds (a share of it, at least `MIN_ROOM_WORDS`). */
const ROOM_SHARE = 0.25;
const MIN_ROOM_WORDS = 1024;

type SectionKind = 'blocks' | 'terrain' | 'objects';
const ORDER: readonly SectionKind[] = ['blocks', 'terrain', 'objects'];

interface Section {
  base: number;
  cap: number;
  len: number;
  /** The inputs it was packed from (compared by identity). */
  inputs: readonly unknown[] | null;
}

/** What a pack gave: the words (the buffer's whole size), the ranges written, and the models' atlas when it changed. */
export interface ScenePack extends PackedTraceScene {
  /** Word ranges [from, to) written since the last pack (the whole buffer when it was laid out again). */
  readonly dirty: readonly (readonly [number, number])[];
  /** The buffer was made again (a new size): upload it whole. */
  readonly resized: boolean;
  /** The models' atlas changed. */
  readonly atlasChanged: boolean;
  /** The scene fits the binding (false: nothing was packed, the last scene stands). */
  readonly fits: boolean;
  /** Words the scene needs (its sections without room to grow). */
  readonly neededWords: number;
}

const sameList = (a: readonly unknown[] | null, b: readonly unknown[]): boolean => a !== null && a.length === b.length && a.every((x, i) => x === b[i]);

export class TraceScenePacker {
  private buf = new Uint32Array(0);
  private readonly sections = new Map<SectionKind, Section>(ORDER.map((k) => [k, { base: 0, cap: 0, len: 0, inputs: null }]));
  private readonly items = new WeakMap<object, PackedItem>();
  private atlas: BrickAtlas = { size: [1, 1, 1], data: new Uint8Array(1), blocksPerAxis: 1 };
  private readonly bytes = { blocks: 0, terrain: 0, arch: 0, bricks: 0 };
  private readonly limitWords: number;

  constructor(limitBytes = DEFAULT_STORAGE_BINDING_BYTES) {
    this.limitWords = Math.floor(limitBytes / 4);
  }

  /** An item's packed words: made once per item (the same words serve any light layers: `placeItem` writes them). */
  private item<T extends object>(x: T, pack: (x: T) => PackedItem): PackedItem {
    let p = this.items.get(x);
    if (p === undefined) this.items.set(x, (p = pack(x)));
    return p;
  }

  /** Pack `src`, re-writing only the sections whose inputs changed. */
  pack(src: TraceSceneSource): ScenePack {
    const blocks = (src.blocks ?? []).map((l) => this.item<TraceBlockLayer>(l, packBlockLayerItem));
    const terrain = (src.terrain ?? []).map((t) => this.item<TraceTerrain>(t, packTerrainItem));
    const inputs: Record<SectionKind, readonly unknown[]> = { blocks: src.blocks ?? [], terrain: src.terrain ?? [], objects: [src.arch, src.bricks] };
    const itemWords = (kind: 'blocks' | 'terrain', list: readonly PackedItem[]): number => list.reduce((n, it) => n + itemDataWords(kind, it), list.length * (kind === 'blocks' ? LAYER_WORDS : TERRAIN_WORDS));
    // The objects' section is packed where it lies; its size is known only once packed.
    const objects = (base: number): { words: Uint32Array; header: Uint32Array; atlas: BrickAtlas; bytes: { arch: number; bricks: number } } => {
      const header = new Uint32Array(SCENE_HEADER_WORDS);
      const w = new Words(base, header);
      const bytes = { arch: 0, bricks: 0 };
      const atlas = packObjectSections(w, src, bytes);
      return { words: w.done(), header, atlas, bytes };
    };
    const changed = new Set(ORDER.filter((k) => !sameList(this.sections.get(k)!.inputs, inputs[k])));
    const need: Record<SectionKind, number> = {
      blocks: changed.has('blocks') ? itemWords('blocks', blocks) : this.sections.get('blocks')!.len,
      terrain: changed.has('terrain') ? itemWords('terrain', terrain) : this.sections.get('terrain')!.len,
      objects: 0,
    };
    let packedObjects = changed.has('objects') ? objects(this.sections.get('objects')!.base) : null;
    need.objects = packedObjects !== null ? packedObjects.words.length : this.sections.get('objects')!.len;
    const neededWords = SCENE_HEADER_WORDS + need.blocks + need.terrain + need.objects;
    const base = { words: this.buf, brickAtlas: this.atlas, bytes: { ...this.bytes }, dirty: [] as [number, number][], resized: false, atlasChanged: false, neededWords };
    if (neededWords > this.limitWords) return { ...base, fits: false };
    const relayout = this.buf.length === 0 || ORDER.some((k) => need[k] > this.sections.get(k)!.cap);
    let resized = false;
    if (relayout) {
      // Every section again, each with room to grow (none when that would not fit the binding).
      const room = (n: number): number => Math.max(MIN_ROOM_WORDS, Math.ceil(n * ROOM_SHARE));
      const roomy = ORDER.reduce((n, k) => n + need[k] + room(need[k]), SCENE_HEADER_WORDS) <= this.limitWords;
      let at = SCENE_HEADER_WORDS;
      for (const k of ORDER) {
        const s = this.sections.get(k)!;
        s.base = at;
        s.cap = need[k] + (roomy ? room(need[k]) : 0);
        s.inputs = null;
        at += s.cap;
      }
      if (at !== this.buf.length) {
        this.buf = new Uint32Array(at);
        resized = true;
      } else this.buf.fill(0);
      for (const k of ORDER) changed.add(k);
      packedObjects = objects(this.sections.get('objects')!.base);
    }
    const dirty: [number, number][] = [[0, SCENE_HEADER_WORDS]];
    const put = (kind: 'blocks' | 'terrain', slot: number, list: readonly PackedItem[], from: readonly { layers?: number }[]): void => {
      const s = this.sections.get(kind)!;
      const rw = kind === 'blocks' ? LAYER_WORDS : TERRAIN_WORDS;
      this.buf[slot] = list.length;
      this.buf[slot + 1] = s.base;
      let data = s.base + list.length * rw;
      list.forEach((item, i) => {
        placeItem(this.buf, kind, item, s.base + i * rw, data, from[i]!.layers);
        data += itemDataWords(kind, item);
      });
      s.len = data - s.base;
      this.bytes[kind] = s.len * 4;
      dirty.push([s.base, data]);
    };
    if (changed.has('blocks')) put('blocks', HEADER.blocks, blocks, src.blocks ?? []);
    if (changed.has('terrain')) put('terrain', HEADER.terrain, terrain, src.terrain ?? []);
    let atlasChanged = false;
    if (changed.has('objects') && packedObjects !== null) {
      const s = this.sections.get('objects')!;
      this.buf.set(packedObjects.words, s.base);
      for (const slot of [HEADER.arch, HEADER.arch + 1, HEADER.bricks, HEADER.bricks + 1]) this.buf[slot] = packedObjects.header[slot]!;
      s.len = packedObjects.words.length;
      this.bytes.arch = packedObjects.bytes.arch;
      this.bytes.bricks = packedObjects.bytes.bricks;
      atlasChanged = this.atlas !== packedObjects.atlas;
      this.atlas = packedObjects.atlas;
      dirty.push([s.base, s.base + s.len]);
    }
    for (const k of ORDER) this.sections.get(k)!.inputs = inputs[k];
    return { words: this.buf, brickAtlas: this.atlas, bytes: { ...this.bytes }, dirty: relayout ? [[0, this.buf.length]] : dirty, resized, atlasChanged: atlasChanged || relayout, fits: true, neededWords };
  }
}
