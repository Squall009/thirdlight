/**
 * Stored copies as rows of the culled-instance table (`occlusion-instances.ts`): what the table keeps of each
 * set of copies the GPU draws (`copies-gpu.ts` on WebGPU), and the frame's selection data the copies' compute
 * pass reads (`copy-rows-select.ts`; the rule: `copy-rows-rule.ts`).
 *
 * - **A set** keeps its copies once in the table's pools (a place per copy, its floats written only when a
 *   copy changes) and its per-copy state (level, fade) beside them, a place per copy and LOD group.
 * - **A list** (an output) is what one or more draws draw: a level of a LOD group, the meshes outside every
 *   group, or the near-shadow draws. Each has a range of its own in the pools for its order (the copies the
 *   pass appended: those in view from the front, the rest from the back), its visibility and its two passes'
 *   lists, as any culled draw has.
 * - **A row** is one draw (a mesh of a list): the list's first mesh compacts the list on the pyramid's path
 *   and writes the arguments of the meshes that share it; near-shadow rows are drawn by shadow cameras only.
 *
 * Sets are listed every frame they are shown, whatever the occlusion path: on WebGPU every stored copy is
 * picked in compute, and the pyramid's tests only come on top.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { ReadbackBuffer, StorageBufferAttribute, type WebGPURenderer } from 'three/webgpu';

import type { CulledCopies, CulledDepth } from './attribute-instancing';
import { COPY_ROW_FLOATS, copyFadeStep } from './copy-rows-rule';
import { copySelectKernels, NO_OUTPUT, SELECT_DISPATCH_ROW, SELECT_THINS, SELECT_CULLS, SELECT_WORKGROUP, SELECTION_F32, SELECTION_U32, type SelectTableLayout } from './copy-rows-select';
import { releaseStorage } from './dispose';
import type { N } from './effects-tsl';
import type { LodTuning } from './lod-switch';
import { maxScaleOf, type CullView } from './view-cull';

const TSL: N = TSLTyped;

/** Frames between read-backs of the lists' counts (diagnostics and the frame probe's count). */
const READBACK_FRAMES = 30;
/** Seconds a frame's fade may run at most (a page that drew nothing for a while finishes its fades, no more). */
const MAX_FADE_DT_S = 0.25;
/** A sphere radius no frustum or pyramid test leaves out (vertices with no known bound). */
const UNBOUNDED_REACH_M = 1e9;

/** One draw of a set as the table reads it. */
export interface CopyRowsMesh {
  readonly mesh: THREE.Mesh;
  /** Its LOD group and level (group -1: drawn at every level but the cull). */
  readonly group: number;
  readonly level: number;
  /** A shadow-only draw of the copies near the eye (most detailed level). */
  readonly near: boolean;
  /** A cached static shadow map draws every copy through it. */
  readonly staticAll: boolean;
}

/** A set of stored copies the table draws (copies-gpu.ts's, on WebGPU). */
export interface CopyRowsSource {
  readonly count: number;
  readonly groups: readonly { readonly distances: readonly number[]; readonly culls: boolean }[];
  readonly meshes: readonly CopyRowsMesh[];
  /** Changes whenever a copy does (its floats are written again). */
  readonly copiesVersion: number;
  /** Every copy's {@link COPY_ROW_FLOATS} floats into `target` from copy `at`. */
  writeCopies(target: Float32Array, at: number): void;
  /** The set's world matrix (the copies' places are in its frame). */
  readonly world: THREE.Matrix4;
  /** The model's farthest point from its origin at scale 1. */
  readonly modelReach: number;
  /** The falloff by distance (level units at scale 1), null: none. */
  readonly density: { readonly from: number; readonly to: number; readonly min: number } | null;
  /** The near-shadow draws' reach (m; null: none). */
  readonly nearReach: number | null;
  readonly tuning: LodTuning;
  /** How far the draws' vertices move past their copies' spheres now (m; null: no known bound). */
  vertexReach(): number | null;
  /** Some draw of it is in the scene and shown. */
  shown(): boolean;
  /** The table let go of it (disposed): its draws draw as they would without one. */
  released(): void;
}

/** One list of a set: the draws of one level of one group, the ungrouped draws, or the near-shadow draws. */
interface Output {
  readonly key: string;
  readonly cap: number;
  base: number;
  /** This frame's index (its counts' place), -1 when not listed. */
  index: number;
  readonly rows: CopyRow[];
  /** Copies in view and copies listed, from the last read-back. */
  front: number;
  back: number;
}

/** A set's entry. */
interface CopySet {
  readonly src: CopyRowsSource;
  /** Its copies' first place, and its places (copies × groups, for the state). */
  copies: number;
  readonly places: number;
  copied: number;
  readonly outputs: Output[];
  /** Per group (at least one): its level outputs, the ungrouped output (group 0) and its near output. */
  readonly selections: { readonly group: number; readonly levels: (Output | null)[]; readonly ungrouped: Output | null; readonly near: Output | null }[];
  listed: boolean;
}

/** One row of the table that draws a set's list (a mesh). */
export interface CopyRow extends CulledCopies {
  readonly copy: true;
  readonly whole?: undefined;
  readonly mesh: THREE.Mesh;
  readonly output: Output;
  /** The list's first row compacts it and writes the arguments of the others (its sharers). */
  owner: boolean;
  sharers: number;
  /** Drawn by shadow cameras only (a near-shadow draw). */
  readonly otherOnly: boolean;
  readonly staticAll: boolean;
  /** The set's copies' first place (its spheres, its floats). */
  copies: number;
  /** Its state's first place (the group's). */
  stateAt: number;
  /** The level it draws (-1: no fade: ungrouped or near). */
  readonly level: number;
  row: number;
  firstPass: boolean;
  fresh: boolean;
  list: number;
  depth: CulledDepth | null;
  /** Triangles one copy draws (diagnostics). */
  readonly triangles: number;
}

/** The pools and the allocator the table lends its copy sets. */
export interface CopyRowsHost {
  alloc(n: number): number;
  release(base: number, n: number): void;
  readonly matrices: StorageBufferAttribute;
  readonly spheres: StorageBufferAttribute;
  readonly visible: StorageBufferAttribute;
  readonly slots: StorageBufferAttribute;
  readonly lists: StorageBufferAttribute;
  /** A range of the matrices written (uploaded with the frame's pools). */
  dirtyMatrices(start: number, end: number): void;
  /** A range of the GPU-only state zeroed (a place newly given). */
  zeroVisible(start: number, end: number): void;
}

/** What the copy sets report (diagnostics and the profiler's counters). */
export interface CopyRowsDiagnostics {
  readonly sets: number;
  readonly copies: number;
  /** Rows and lists in the last frame's table. */
  readonly rows: number;
  readonly lists: number;
  /** From the last read-back: copies the view's lists held (in view) and all lists held (shadow cameras too). */
  readonly inView: number;
  readonly listed: number;
  /** Triangles the view's lists hold (before the pyramid's tests). */
  readonly triangles: number;
  /** GPU memory of the selection data and the counters (the copies' places are the pools'). */
  readonly bytes: number;
  /** Selections run (frames) since made. */
  readonly runs: number;
}

const grown = (have: number, need: number): number => Math.max(need, have * 2, 16);

/** The copy sets of one table. */
export class CopyRowsTable {
  private readonly sets = new Map<CopyRowsSource, CopySet>();
  private readonly frameSets: CopySet[] = [];
  private readonly frameOutputs: Output[] = [];
  private data: StorageBufferAttribute;
  private floats: StorageBufferAttribute;
  private tally: StorageBufferAttribute;
  private counts: StorageBufferAttribute;
  /** Their generation: a kernel is built again when a buffer is made anew. */
  private generation = 0;
  private kernels: { select: N; outputs: N; rows: N } | null = null;
  private kernelKey = '';
  private readonly uniforms = {
    eye: TSL.uniform(new THREE.Vector3()),
    planes: TSL.uniformArray(Array.from({ length: 6 }, () => new THREE.Vector4())),
    fadeStep: TSL.uniform(0, 'uint'),
    rowCount: TSL.uniform(0, 'uint'),
    chunkCount: TSL.uniform(0, 'uint'),
    headersAt: TSL.uniform(0, 'uint'),
    outsAt: TSL.uniform(0, 'uint'),
    outputCount: TSL.uniform(0, 'uint'),
  };
  private dataKey = '';
  private lastRun = Number.NaN;
  /** This frame's selection ran (the rows' lists and arguments are this frame's). */
  ran = false;
  private runs = 0;
  private frames = 0;
  private reading = false;
  private readback: ReadbackBuffer | null = null;
  private read = { inView: 0, listed: 0, triangles: 0 };

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly host: CopyRowsHost,
    private readonly layout: SelectTableLayout,
  ) {
    this.data = this.make('uint', 64, 'data');
    this.floats = this.make('float', 64, 'floats');
    this.tally = this.make('uint', 16, 'tally');
    this.counts = this.make('uint', 16, 'counts');
  }

  /** A set's draws become table rows (false: it cannot: nothing to draw). */
  adopt(src: CopyRowsSource): boolean {
    if (this.sets.has(src)) return true;
    if (src.count <= 0 || src.meshes.length === 0) return false;
    const groups = Math.max(1, src.groups.length);
    const set: CopySet = { src, copies: -1, places: src.count * groups, copied: Number.NaN, outputs: [], selections: [], listed: false };
    const outputOf = (key: string): Output => {
      let o = set.outputs.find((x) => x.key === key);
      if (o === undefined) set.outputs.push((o = { key, cap: src.count, base: -1, index: -1, rows: [], front: 0, back: 0 }));
      return o;
    };
    for (let g = 0; g < groups; g += 1) set.selections.push({ group: g, levels: Array.from({ length: src.groups[g]?.distances.length ?? 1 }, () => null), ungrouped: null, near: null });
    const self = this;
    for (const m of src.meshes) {
      // A model without levels draws its meshes as the one level of a group of one.
      const group = src.groups.length === 0 ? 0 : m.group;
      const sel = set.selections[Math.max(0, group)]!;
      const key = m.near ? `near:${Math.max(0, group)}` : group < 0 ? 'ungrouped' : `${group}:${m.level}`;
      const out = outputOf(key);
      if (m.near) (sel as { near: Output | null }).near = out;
      else if (group < 0) (sel as { ungrouped: Output | null }).ungrouped = out;
      else sel.levels[m.level] = out;
      const g = m.mesh.geometry;
      const index = g.index;
      const tris = (index !== null ? index.count : (g.getAttribute('position')?.count ?? 0)) / 3;
      const row: CopyRow = {
        copy: true,
        mesh: m.mesh,
        output: out,
        owner: false,
        sharers: 0,
        otherOnly: m.near,
        staticAll: m.staticAll,
        copies: -1,
        stateAt: -1,
        level: m.near || group < 0 ? -1 : m.level,
        row: -1,
        firstPass: false,
        fresh: true,
        list: 0,
        depth: null,
        triangles: Math.floor(tris),
        get base() {
          return out.base;
        },
        get cap() {
          return out.cap;
        },
        get matrices() {
          return self.host.matrices;
        },
        get slots() {
          return self.host.slots;
        },
        get lists() {
          return self.host.lists;
        },
      };
      out.rows.push(row);
    }
    for (const o of set.outputs) o.rows.forEach((r, i) => (r.owner = i === 0));
    this.sets.set(src, set);
    return true;
  }

  /** A set's rows go (its places given back). */
  forget(src: CopyRowsSource): void {
    const set = this.sets.get(src);
    if (set === undefined) return;
    this.sets.delete(src);
    this.unplace(set);
  }

  /** The row that draws `mesh` of `src` (null: none). */
  rowOf(src: CopyRowsSource, mesh: THREE.Mesh): CopyRow | null {
    const set = this.sets.get(src);
    if (set === undefined) return null;
    for (const o of set.outputs) for (const r of o.rows) if (r.mesh === mesh) return r;
    return null;
  }

  /** Copies in view of `src`'s view lists (from the last read-back; diagnostics). */
  inViewOf(src: CopyRowsSource): number {
    const set = this.sets.get(src);
    let n = 0;
    for (const o of set?.outputs ?? []) if (!o.key.startsWith('near')) n += o.front;
    return n;
  }

  get size(): number {
    return this.sets.size;
  }

  /**
   * The frame's rows (appended to `rows`, list by list, the list's first row first): every set shown in the
   * scene is placed (its copies written when they changed) and its lists listed. Returns whether a set's places
   * moved the pools (the table then copies them again).
   */
  list(rows: unknown[], firstPass: (o: THREE.Object3D) => boolean): void {
    this.frameSets.length = 0;
    this.frameOutputs.length = 0;
    for (const set of this.sets.values()) {
      set.listed = set.src.shown();
      for (const o of set.outputs) {
        o.index = -1;
        for (const r of o.rows) r.row = -1;
      }
      if (!set.listed) {
        this.unplace(set);
        continue;
      }
      this.place(set);
      this.frameSets.push(set);
      for (const o of set.outputs) {
        o.index = this.frameOutputs.length;
        this.frameOutputs.push(o);
        o.rows.forEach((r, i) => {
          r.copies = set.copies;
          r.owner = i === 0;
          r.sharers = i === 0 && !r.otherOnly ? o.rows.length - 1 : 0;
          r.firstPass = firstPass(r.mesh);
          r.row = rows.length;
          rows.push(r);
        });
      }
    }
  }

  /** A set's places in the pools (its copies, its lists), its copies written when they changed. */
  private place(set: CopySet): void {
    const h = this.host;
    if (set.copies < 0) {
      set.copies = h.alloc(set.places);
      h.zeroVisible(set.copies, set.copies + set.places);
      set.copied = Number.NaN;
    }
    for (const o of set.outputs) {
      if (o.base >= 0) continue;
      o.base = h.alloc(o.cap);
      for (const r of o.rows) r.fresh = true;
    }
    for (const [i, sel] of set.selections.entries()) for (const r of [...sel.levels, sel.ungrouped, sel.near]) if (r !== null) for (const row of r.rows) row.stateAt = set.copies + i * set.src.count;
  }

  /** The pools grew (made anew): every set's copies are written again, every list starts fresh. */
  regrown(): void {
    for (const set of this.sets.values()) {
      set.copied = Number.NaN;
      for (const o of set.outputs) for (const r of o.rows) r.fresh = true;
      if (set.copies >= 0) this.host.zeroVisible(set.copies, set.copies + set.places);
    }
  }

  /** Write the listed sets' copies where they changed (after any growth of the pools this frame). */
  writeCopies(): void {
    const m = this.host.matrices.array as Float32Array;
    for (const set of this.frameSets) {
      if (set.copied === set.src.copiesVersion) continue;
      set.src.writeCopies(m, set.copies);
      this.host.dirtyMatrices(set.copies * COPY_ROW_FLOATS, (set.copies + set.src.count) * COPY_ROW_FLOATS);
      set.copied = set.src.copiesVersion;
    }
  }

  private unplace(set: CopySet): void {
    if (set.copies >= 0) this.host.release(set.copies, set.places);
    set.copies = -1;
    for (const o of set.outputs) {
      if (o.base >= 0) this.host.release(o.base, o.cap);
      o.base = -1;
      o.index = -1;
      for (const r of o.rows) r.row = -1;
    }
  }

  /**
   * After the table is written: the selection data for this frame's sets (written when what is listed changed),
   * their parameters, and the three dispatches. `view` is the frame's view (its eye and frustum).
   */
  run(view: CullView, rowCount: number, buffers: { table: StorageBufferAttribute; args: StorageBufferAttribute }, tableGeneration: number): void {
    this.ran = false;
    if (this.frameSets.length === 0 || view.camera === null) return;
    const now = performance.now();
    const dt = Number.isFinite(this.lastRun) ? Math.min(MAX_FADE_DT_S, (now - this.lastRun) / 1000) : 0;
    this.lastRun = now;
    const chunks = this.writeData();
    this.writeFloats(view);
    const u = this.uniforms;
    u.eye.value.set(view.eye[0]!, view.eye[1]!, view.eye[2]!);
    const planes = view.planes;
    (u.planes.array as THREE.Vector4[]).forEach((p, i) => p.set(planes[i * 4]!, planes[i * 4 + 1]!, planes[i * 4 + 2]!, planes[i * 4 + 3]!));
    u.fadeStep.value = copyFadeStep(dt);
    u.rowCount.value = rowCount;
    u.chunkCount.value = chunks;
    u.outputCount.value = this.frameOutputs.length;
    this.ensureCounters(this.frameOutputs.length * 2);
    const h = this.host;
    const key = `${this.generation}|${tableGeneration}|${h.matrices.id}|${h.slots.id}|${h.visible.id}|${h.spheres.id}`;
    if (this.kernels === null || key !== this.kernelKey) {
      this.dropKernels();
      this.kernels = copySelectKernels({ matrices: h.matrices, spheres: h.spheres, visible: h.visible, slots: h.slots, data: this.data, floats: this.floats, tally: this.tally, counts: this.counts, table: buffers.table, args: buffers.args }, u, this.layout);
      this.kernelKey = key;
    }
    const k = this.kernels;
    k.select.dispatchSize = [Math.min(chunks, SELECT_DISPATCH_ROW), Math.ceil(chunks / SELECT_DISPATCH_ROW), 1];
    k.outputs.dispatchSize = [Math.max(1, Math.ceil((this.frameOutputs.length * 2) / SELECT_WORKGROUP)), 1, 1];
    k.rows.dispatchSize = [Math.max(1, Math.ceil(rowCount / SELECT_WORKGROUP)), 1, 1];
    void this.renderer.compute([k.select, k.outputs, k.rows]);
    this.ran = true;
    this.runs += 1;
    this.frames += 1;
    if (!this.reading && this.frames % READBACK_FRAMES === 0) queueMicrotask(() => this.readBack());
  }

  /** The chunks, the selections' headers, their level outputs and the outputs' lists; returns the chunk count. */
  private writeData(): number {
    const parts: number[] = [];
    let chunks = 0;
    for (const set of this.frameSets) chunks += set.selections.length * Math.ceil(set.src.count / SELECT_WORKGROUP);
    const selections = this.frameSets.reduce((n, s) => n + s.selections.length, 0);
    const headersAt = chunks * 2;
    const levelsAt = headersAt + selections * SELECTION_U32;
    let levelCount = 0;
    for (const set of this.frameSets) for (const sel of set.selections) levelCount += sel.levels.length;
    const outsAt = levelsAt + levelCount;
    const need = outsAt + this.frameOutputs.length * 2;
    // Chunks, then headers, then level outputs, then the outputs' lists.
    let si = 0;
    for (const set of this.frameSets) for (let g = 0; g < set.selections.length; g += 1, si += 1) for (let c = 0; c < set.src.count; c += SELECT_WORKGROUP) parts.push(si, c);
    let li = levelsAt;
    let fi = 0;
    for (const set of this.frameSets) {
      const d = set.src.density;
      for (const [g, sel] of set.selections.entries()) {
        const grp = set.src.groups[g];
        const flags = (grp?.culls === true ? SELECT_CULLS : 0) | (d !== null ? SELECT_THINS : 0);
        parts.push(set.copies, set.src.count, set.copies + g * set.src.count, sel.levels.length, flags, fi, li, sel.ungrouped?.index ?? NO_OUTPUT, sel.near?.index ?? NO_OUTPUT);
        li += sel.levels.length;
        fi += SELECTION_F32 + sel.levels.length;
      }
    }
    for (const set of this.frameSets) for (const sel of set.selections) for (const o of sel.levels) parts.push(o?.index ?? NO_OUTPUT);
    for (const o of this.frameOutputs) parts.push(o.base, o.cap);
    if (parts.length !== need) throw new Error(`copy rows: selection data ${parts.length} != ${need}`);
    const key = parts.join(',');
    if (key !== this.dataKey) {
      if (need > this.data.count) {
        releaseStorage(this.renderer, [this.data]);
        this.data = this.make('uint', grown(this.data.count, need), 'data');
        this.generation += 1;
      }
      (this.data.array as Uint32Array).set(parts);
      this.data.addUpdateRange(0, need);
      this.data.needsUpdate = true;
      this.dataKey = key;
    }
    this.uniforms.headersAt.value = headersAt;
    this.uniforms.outsAt.value = outsAt;
    return chunks;
  }

  /** Each selection's parameters (written where they changed: the world, the zoom, the wind's reach). */
  private writeFloats(view: CullView): void {
    let need = 0;
    for (const set of this.frameSets) for (const sel of set.selections) need += SELECTION_F32 + sel.levels.length;
    if (need > this.floats.count) {
      releaseStorage(this.renderer, [this.floats]);
      this.floats = this.make('float', grown(this.floats.count, need), 'floats');
      this.generation += 1;
    }
    const f = this.floats.array as Float32Array;
    let at = 0;
    let changed = false;
    const put = (v: number): void => {
      const x = Math.fround(v);
      if (f[at] !== x) {
        f[at] = x;
        changed = true;
      }
      at += 1;
    };
    for (const set of this.frameSets) {
      const src = set.src;
      const w = src.world.elements;
      const ws = maxScaleOf(w);
      const toDistance = 1 / (view.zoom * src.tuning.bias);
      const reach = src.vertexReach();
      const d = src.density;
      for (const [g, sel] of set.selections.entries()) {
        for (let i = 0; i < 16; i += 1) put(w[i]!);
        put(ws);
        put(toDistance);
        put(src.tuning.hysteresis);
        put(src.modelReach);
        put(reach ?? UNBOUNDED_REACH_M);
        put(src.nearReach ?? -1);
        put(d?.from ?? 0);
        put(d?.to ?? 0);
        put(d?.min ?? 1);
        const dist = src.groups[g]?.distances ?? [0];
        for (let k = 0; k < sel.levels.length; k += 1) put(dist[k] ?? 0);
      }
    }
    if (changed) {
      this.floats.addUpdateRange(0, at);
      this.floats.needsUpdate = true;
    }
  }

  private ensureCounters(n: number): void {
    if (n <= this.tally.count) return;
    releaseStorage(this.renderer, [this.tally, this.counts]);
    const size = grown(this.tally.count, n);
    this.tally = this.make('uint', size, 'tally');
    this.counts = this.make('uint', size, 'counts');
    this.dropReadback();
    this.generation += 1;
  }

  /** The counts the draws read (the front count of an output, for a shadow camera's place → order). */
  get countsBuffer(): StorageBufferAttribute {
    return this.counts;
  }

  diagnostics(): CopyRowsDiagnostics {
    let rows = 0;
    let copies = 0;
    for (const set of this.sets.values()) copies += set.src.count;
    for (const o of this.frameOutputs) rows += o.rows.length;
    const bytes = (this.data.count + this.floats.count + this.tally.count + this.counts.count) * 4 + (this.readback?.maxByteLength ?? 0);
    return { sets: this.sets.size, copies, rows, lists: this.frameOutputs.length, inView: this.read.inView, listed: this.read.listed, triangles: this.read.triangles, bytes, runs: this.runs };
  }

  /** The lists' counts, read back now and then (one read at a time). */
  private readBack(): void {
    const outputs = [...this.frameOutputs];
    if (outputs.length === 0) return;
    const bytes = outputs.length * 2 * 4;
    this.readback ??= new ReadbackBuffer(this.counts.count * 4);
    const target = this.readback;
    this.reading = true;
    void this.renderer
      .getArrayBufferAsync(this.counts as never, target as never, 0, bytes)
      .then(() => {
        if (target.buffer === null) return;
        const a = new Uint32Array(target.buffer, 0, outputs.length * 2);
        let inView = 0;
        let listed = 0;
        let triangles = 0;
        outputs.forEach((o, i) => {
          o.front = a[i * 2]!;
          o.back = a[i * 2 + 1]!;
          if (!o.key.startsWith('near')) {
            inView += o.front;
            for (const r of o.rows) triangles += o.front * r.triangles;
          }
          listed += o.front + o.back;
        });
        this.read = { inView, listed, triangles };
      })
      .catch(() => undefined)
      .finally(() => {
        this.reading = false;
        try {
          target.release();
          if (target !== this.readback) target.dispose();
        } catch {
          // The renderer was disposed while the read was in flight: nothing is left to free.
        }
      });
  }

  private dropReadback(): void {
    const r = this.readback;
    this.readback = null;
    if (r !== null && !this.reading) r.dispose();
  }

  private dropKernels(): void {
    const k = this.kernels;
    this.kernels = null;
    if (k === null) return;
    for (const n of [k.select, k.outputs, k.rows]) (n as { dispose?: () => void }).dispose?.();
  }

  private make(type: 'uint' | 'float', n: number, name: string): StorageBufferAttribute {
    const a = new StorageBufferAttribute(type === 'uint' ? new Uint32Array(n) : new Float32Array(n), 1);
    a.name = `tl-copy-rows-${name}`;
    return a;
  }

  /** Every set let go (each draws as without the table from now on). */
  clear(): void {
    for (const set of [...this.sets.values()]) {
      this.sets.delete(set.src);
      this.unplace(set);
      set.src.released();
    }
  }

  dispose(): void {
    this.clear();
    this.dropKernels();
    releaseStorage(this.renderer, [this.data, this.floats, this.tally, this.counts]);
    this.dropReadback();
  }
}
