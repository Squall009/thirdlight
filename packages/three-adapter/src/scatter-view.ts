/**
 * Rule scatter drawn — the stored copies of terrains' and block layers'
 * scatter rules (`project-model/scatter.ts`) as instance sets (ground cover,
 * made near the camera, is `cover-view.ts`'s).
 *
 * The block view and the terrain view hand each source over as they get it
 * (a block layer's chunks carry their scatter as text, a terrain's tiles
 * name a scatter blob, read here), so the editor's Scene view, Play and an
 * export draw the same copies from the same data.
 *
 * Copies are drawn per rule in groups of cells {@link SCATTER_GROUP_METRES}
 * wide: one instance set per rule and group, its chunks the rule's chunk
 * size, culled per copy inside each draw (view-cull), each copy at its own
 * level of detail by default. Large groups keep the draws few; a cell that
 * changes (an edit baked again) rebuilds only its group, and rebuilds are
 * spread over frames within {@link SCATTER_BUILD_MS} a frame so a re-bake
 * never stalls one.
 */
import * as THREE from 'three';

import { SCATTER_BLOB_DISTANCE, SCATTER_CHUNK_METERS_DEFAULT, SCATTER_COPY_FLOATS, decodeChunkScatter, instanceDensityOf, scatterCellBytes, scatterCellOfBlob, storedScatterRules, type BlockChunk, type BlockLayerComponent, type BlockType, type ScatterCell, type ScatterRule, type TerrainComponent } from '@thirdlight/runtime';

import { COVER_FADE_START } from './cover-view';
import { buildInstanceSet, type BuiltInstanceSet, type InstanceSetStats } from './instancing';
import { blobCopies, blobShadowTemplate, copiesBySquare, distanceToSquare, pickCopies, shadowOnly, SHADOW_RING_METRES } from './scatter-shadows';
import type { CullView } from './view-cull';
import type { LodTuning } from './lod-switch';
import { STATIC_CASTER_KEY } from './shadow-casters';
import type { ModelInstance } from './visual';

/** The width (m) of the squares a rule's copies are drawn together in: a few draws for a landscape, a bounded rebuild per edit. */
export const SCATTER_GROUP_METRES = 2048;
/** Main-thread time (ms) a frame may spend building groups again (at least one group a frame). */
export const SCATTER_BUILD_MS = 4;
/** Copies per instance chunk the count grid aims at: the chunks follow the rule's chunk size instead. */
const SCATTER_COPIES_PER_CHUNK = 1 << 20;

/** The page query that leaves the scatter out (`?scatter=off`: a diagnostic comparison). */
export const SCATTER_URL_PARAM = 'scatter';

/** Whether a page draws scatter (`?scatter=off|0|false`: no). */
export function scatterFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(SCATTER_URL_PARAM);
  return v !== 'off' && v !== '0' && v !== 'false';
}

/** What the view needs from its host. */
export interface ScatterViewDeps {
  /** A model instance to draw a rule's copies with (one per asset and piece, kept by the host); null while it loads (`onReady` then). */
  template(assetId: string, piece: string | undefined, onReady: () => void): ModelInstance | null;
  /** Dress a built set's meshes with the asset's materials; returns what takes them off again (before the set is dropped). */
  dress?(root: THREE.Object3D, assetId: string): (() => void) | null;
  /** A blob's bytes by digest (a terrain tile's scatter). */
  read: ((digest: string) => Promise<ArrayBuffer>) | null;
  /** A drawn group enters or leaves the scene (the render graph lists what it draws). */
  place(root: THREE.Object3D, shown: boolean): void;
  /** Copies that cast into the static shadow map appeared, moved or left. */
  shapeChanged?(): void;
  /** The project's LOD tuning (bias, hysteresis). */
  tuning?: LodTuning;
  /** Something was built (a frame should be drawn). */
  changed?(): void;
}

/** What the block and terrain views tell the scatter view (their sources as they get them). */
export type ScatterSink = Pick<ScatterView, 'setBlockLayer' | 'replaceBlockChunks' | 'setTerrain' | 'setOrigin' | 'setHidden' | 'remove'> & {
  /** The block types (ground cover reads a block layer's tops by them). */
  setTypes?(types: readonly BlockType[]): void;
};

/** What the view holds (diagnostics). */
export interface ScatterViewDiagnostics {
  sources: number;
  cells: number;
  groups: number;
  sets: number;
  copies: number;
  /** Decoded copies' bytes. */
  bytes: number;
  /** Groups waiting to be built (their cells reading, their models loading, or the frame's time spent). */
  pending: number;
  /** The last frame's build time (ms) and the longest so far. */
  buildMs: number;
  buildMsMax: number;
  instances: InstanceSetStats;
}

interface Cell {
  /** The stored form it was read from (a digest or the chunk's text); null: none. */
  ref: string | null;
  cell: ScatterCell | null;
  reading: string | null;
  group: string;
}

/** A rule's copies near the camera cast from shadow-only squares (its `shadowDistance`). */
interface NearShadows {
  readonly rule: ScatterRule;
  readonly floats: Float32Array;
  readonly count: number;
  /** The copies by square (made on the first frame that needs them). */
  index: Map<string, number[]> | null;
  readonly squares: Map<string, { root: THREE.Group; built: BuiltInstanceSet; undress: (() => void) | null }>;
}

interface Group {
  readonly key: string;
  readonly root: THREE.Group;
  dirty: boolean;
  /** The rules still to build in a rebuild under way (one a step, so no frame builds them all; null: none begun). */
  queue: string[] | null;
  shown: boolean;
  sets: { rule: string; built: BuiltInstanceSet; casts: boolean; undress: (() => void) | null }[];
  near: NearShadows[];
}

interface Source {
  readonly id: string;
  rules: readonly ScatterRule[];
  rulesKey: string;
  origin: [number, number, number];
  hidden: boolean;
  readonly cells: Map<string, Cell>;
  readonly groups: Map<string, Group>;
  /** The world box of a cell key ("x,z"). */
  cellSize: number;
}

const groupKeyOf = (src: Source, key: string): string => {
  const [x, z] = key.split(',').map(Number) as [number, number];
  const per = Math.max(1, Math.floor(SCATTER_GROUP_METRES / src.cellSize));
  return `${Math.floor(x / per)},${Math.floor(z / per)}`;
};

export class ScatterView {
  private readonly sources = new Map<string, Source>();
  private buildMs = 0;
  private buildMsMax = 0;
  private disposed = false;

  constructor(private readonly deps: ScatterViewDeps) {}

  /** A block layer's scatter: its rules and every chunk's stored copies. */
  setBlockLayer(id: string, component: BlockLayerComponent, origin: readonly number[], chunks: Iterable<BlockChunk>): void {
    const src = this.source(id, storedScatterRules(component.scatter), origin, 16 * component.cellSize[0]);
    if (src === null) return;
    const seen = new Set<string>();
    for (const c of chunks) {
      const key = `${c.cx},${c.cz}`;
      seen.add(key);
      this.setText(src, key, c.scatter ?? null);
    }
    for (const key of [...src.cells.keys()]) if (!seen.has(key)) this.setText(src, key, null);
  }

  /** Some chunks of a block layer changed (an edit, the simulation): their stored copies. */
  replaceBlockChunks(id: string, chunks: readonly { cx: number; cz: number; chunk: BlockChunk | null }[]): void {
    const src = this.sources.get(id);
    if (src === undefined) return;
    for (const c of chunks) this.setText(src, `${c.cx},${c.cz}`, c.chunk?.scatter ?? null);
  }

  /** A terrain's scatter: its rules and every tile's scatter blob. */
  setTerrain(id: string, component: TerrainComponent, origin: readonly number[]): void {
    const src = this.source(id, storedScatterRules(component.scatter), origin, (component.tileSamples - 1) * component.spacing);
    if (src === null) return;
    const seen = new Set<string>();
    for (const t of component.tiles) {
      const key = `${t.x},${t.z}`;
      seen.add(key);
      this.setDigest(src, key, t.scatter ?? null);
    }
    for (const key of [...src.cells.keys()]) if (!seen.has(key)) this.setDigest(src, key, null);
  }

  setOrigin(id: string, origin: readonly number[]): void {
    const src = this.sources.get(id);
    if (src === undefined) return;
    const at: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    if (at.every((v, i) => v === src.origin[i])) return;
    src.origin = at;
    for (const g of src.groups.values()) {
      this.show(g, false);
      g.root.position.set(...at);
      g.root.updateMatrixWorld(true);
      this.show(g, !src.hidden);
      // The near shadows' squares are where the copies stood: made again where they stand now.
      for (const n of g.near) {
        this.dropNear(n);
        n.index = null;
      }
    }
    if (this.casts(src)) this.deps.shapeChanged?.();
  }

  setHidden(id: string, hidden: boolean): void {
    const src = this.sources.get(id);
    if (src === undefined || src.hidden === hidden) return;
    src.hidden = hidden;
    for (const g of src.groups.values()) this.show(g, !hidden);
    if (this.casts(src)) this.deps.shapeChanged?.();
  }

  remove(id: string): void {
    const src = this.sources.get(id);
    if (src === undefined) return;
    for (const g of src.groups.values()) this.dropGroup(g);
    if (this.casts(src)) this.deps.shapeChanged?.();
    this.sources.delete(id);
  }

  ids(): string[] {
    return [...this.sources.keys()];
  }

  /**
   * Build the groups that changed, and the near shadows around the view's eye
   * (the last frame's), within the frame's time (call once a frame). Returns
   * whether anything was built.
   */
  update(view: CullView | null = null): boolean {
    if (this.disposed) return false;
    const start = performance.now();
    let built = false;
    let casts = false;
    for (const src of this.sources.values()) {
      for (const g of src.groups.values()) {
        while (g.dirty) {
          if (built && performance.now() - start > SCATTER_BUILD_MS) break;
          if (g.queue === null) {
            if (!this.ready(src, g.key)) break;
            // Sets of rules no longer listed go now; the listed ones are built one a step.
            const ids = new Set(src.rules.map((r) => r.id));
            if (g.sets.some((x) => !ids.has(x.rule))) {
              casts ||= this.buildRule(src, g, null);
              built = true;
            }
            g.queue = src.rules.map((r) => r.id);
          }
          const next = g.queue.shift();
          if (next === undefined) {
            g.dirty = false;
            g.queue = null;
            break;
          }
          casts ||= this.buildRule(src, g, next);
          built = true;
        }
      }
    }
    if (view !== null && view.camera !== null) {
      for (const src of this.sources.values()) for (const g of src.groups.values()) for (const n of g.near) built = this.nearShadows(src, n, view.eye[0]!, view.eye[2]!, start, built) || built;
    }
    this.buildMs = performance.now() - start;
    if (built) {
      this.buildMsMax = Math.max(this.buildMsMax, this.buildMs);
      if (casts) this.deps.shapeChanged?.();
      this.deps.changed?.();
    }
    return built;
  }

  diagnostics(): ScatterViewDiagnostics {
    let cells = 0;
    let groups = 0;
    let sets = 0;
    let copies = 0;
    let bytes = 0;
    let pending = 0;
    const instances: InstanceSetStats = { copies: 0, inView: 0, byLevel: [], culled: 0, thinned: 0 };
    const byLevel: number[] = [];
    let inView = 0;
    let culled = 0;
    let thinned = 0;
    for (const src of this.sources.values()) {
      for (const c of src.cells.values()) {
        if (c.cell !== null) cells += 1;
        bytes += scatterCellBytes(c.cell);
      }
      for (const g of src.groups.values()) {
        groups += 1;
        if (g.dirty) pending += 1;
        for (const s of g.sets) {
          sets += 1;
          const st = s.built.stats();
          copies += st.copies;
          inView += st.inView;
          culled += st.culled;
          thinned += st.thinned;
          st.byLevel.forEach((v, l) => (byLevel[l] = (byLevel[l] ?? 0) + v));
        }
      }
    }
    return { sources: this.sources.size, cells, groups, sets, copies, bytes, pending, buildMs: Math.round(this.buildMs * 100) / 100, buildMsMax: Math.round(this.buildMsMax * 100) / 100, instances: { ...instances, copies, inView, byLevel, culled, thinned } };
  }

  /** The built sets' chunk meshes (picking, tests). */
  meshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const src of this.sources.values()) for (const g of src.groups.values()) for (const s of g.sets) out.push(...s.built.meshes);
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.sources.keys()]) this.remove(id);
  }

  // ---- internals ------------------------------------------------------------------------

  /** The source of `id`, made or updated (its rules changed: every group is built again). Null: it has no rules and none was drawn. */
  private source(id: string, rules: readonly ScatterRule[], origin: readonly number[], cellSize: number): Source | null {
    let src = this.sources.get(id);
    if (src === undefined && rules.length === 0) return null;
    if (src === undefined) {
      src = { id, rules, rulesKey: JSON.stringify(rules), origin: [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0], hidden: false, cells: new Map(), groups: new Map(), cellSize };
      this.sources.set(id, src);
      return src;
    }
    const key = JSON.stringify(rules);
    if (key !== src.rulesKey || cellSize !== src.cellSize) {
      src.rules = rules;
      src.rulesKey = key;
      src.cellSize = cellSize;
      for (const g of src.groups.values()) {
        g.dirty = true;
        g.queue = null;
      }
    }
    this.setOrigin(id, origin);
    return src;
  }

  private cellOf(src: Source, key: string): Cell {
    let c = src.cells.get(key);
    if (c === undefined) {
      c = { ref: null, cell: null, reading: null, group: groupKeyOf(src, key) };
      src.cells.set(key, c);
    }
    return c;
  }

  private touch(src: Source, c: Cell): void {
    let g = src.groups.get(c.group);
    if (g === undefined) {
      const root = new THREE.Group();
      root.name = `scatter:${src.id}:${c.group}`;
      root.position.set(...src.origin);
      root.updateMatrixWorld(true);
      g = { key: c.group, root, dirty: true, queue: null, shown: false, sets: [], near: [] };
      src.groups.set(c.group, g);
    }
    g.dirty = true;
    g.queue = null;
  }

  private setText(src: Source, key: string, text: string | null): void {
    const c = this.cellOf(src, key);
    if (c.ref === text) return;
    c.ref = text;
    c.cell = text === null ? null : decodeChunkScatter(text);
    this.touch(src, c);
  }

  private setDigest(src: Source, key: string, digest: string | null): void {
    const c = this.cellOf(src, key);
    if (c.ref === digest && c.reading === null) return;
    if (digest === null) {
      c.ref = null;
      c.reading = null;
      c.cell = null;
      this.touch(src, c);
      return;
    }
    if (c.reading === digest || this.deps.read === null) return;
    c.reading = digest;
    this.touch(src, c);
    void this.deps.read(digest).then(
      (bytes) => {
        if (this.disposed || c.reading !== digest) return;
        c.reading = null;
        c.ref = digest;
        try {
          c.cell = scatterCellOfBlob(new Uint8Array(bytes));
        } catch (e) {
          console.warn(`scatter ${digest.slice(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`);
          c.cell = null;
        }
        this.touch(src, c);
        this.deps.changed?.();
      },
      () => {
        if (c.reading === digest) c.reading = null;
      },
    );
  }

  /** Whether a group can be built: its cells read and every rule's model ready. */
  private ready(src: Source, group: string): boolean {
    for (const c of src.cells.values()) if (c.group === group && c.reading !== null) return false;
    for (const r of src.rules) if (this.deps.template(r.asset.assetId, r.asset.piece, () => this.modelReady(src)) === null) return false;
    return true;
  }

  /** A model a rule waited for is ready: the source's groups are built (again) with it. */
  private modelReady(src: Source): void {
    for (const g of src.groups.values()) {
      g.dirty = true;
      g.queue = null;
    }
    this.deps.changed?.();
  }

  private casts(src: Source): boolean {
    return src.rules.some((r) => r.castShadow === true);
  }

  /**
   * Build one rule's sets of a group again from its cells (null: only drop the sets of rules no longer listed);
   * returns whether what casts into the static shadow map changed.
   */
  private buildRule(src: Source, g: Group, id: string | null): boolean {
    const ids = new Set(src.rules.map((r) => r.id));
    const goes = (rule: string): boolean => (id === null ? !ids.has(rule) : rule === id);
    const castBefore = g.sets.some((x) => goes(x.rule) && x.casts);
    this.show(g, false);
    for (const x of g.sets) if (goes(x.rule)) this.dropSet(x);
    g.sets = g.sets.filter((x) => !goes(x.rule));
    for (const n of g.near) if (goes(n.rule.id)) this.dropNear(n);
    g.near = g.near.filter((n) => !goes(n.rule.id));
    const rule = id === null ? undefined : src.rules.find((r) => r.id === id);
    let castAfter = false;
    if (rule !== undefined) castAfter = this.buildSets(src, g, rule);
    g.root.updateMatrixWorld(true);
    this.show(g, !src.hidden && g.sets.length > 0);
    return castBefore || castAfter;
  }

  /** A rule's copies in a group as its sets (the model's, and the blobs'); returns whether they cast into the static shadow map. */
  private buildSets(src: Source, g: Group, rule: ScatterRule): boolean {
    const cells = [...src.cells.values()].filter((c) => c.group === g.key && c.cell !== null);
    let n = 0;
    for (const c of cells) n += (c.cell!.get(rule.id)?.cells.length ?? 0) / 2;
    if (n === 0) return false;
    const floats = new Float32Array(n * SCATTER_COPY_FLOATS);
    let o = 0;
    for (const c of cells) {
      const copies = c.cell!.get(rule.id)?.copies;
      if (copies === undefined) continue;
      floats.set(copies, o);
      o += copies.length;
    }
    const template = this.deps.template(rule.asset.assetId, rule.asset.piece, () => this.modelReady(src));
    if (template === null) return false;
    const built = buildInstanceSet(template, floats, n, `scatter:${src.id}:${rule.id}`, {
      chunkSize: rule.chunkSize ?? SCATTER_CHUNK_METERS_DEFAULT,
      copiesPerChunk: SCATTER_COPIES_PER_CHUNK,
      density: instanceDensityOf(rule),
      lodPerCopy: rule.lodPerCopy ?? true,
      ...(this.deps.tuning !== undefined ? { tuning: this.deps.tuning } : {}),
    });
    // A rule that casts near the camera only: its copies there cast from shadow-only squares, the rest never.
    const casts = rule.castShadow === true && rule.shadowDistance === undefined;
    if (rule.castShadow === true && rule.shadowDistance !== undefined) g.near.push({ rule, floats, count: n, index: null, squares: new Map() });
    for (const m of built.meshes) {
      m.castShadow = casts;
      m.receiveShadow = true;
      if (casts) m.userData[STATIC_CASTER_KEY] = true;
    }
    const undress = this.deps.dress?.(built.group, rule.asset.assetId) ?? null;
    g.root.add(built.group);
    g.sets.push({ rule: rule.id, built, casts, undress });
    if (rule.blobShadow !== undefined) {
      // A disc under each copy near the camera, thinning out by distance; it neither casts nor takes shadows.
      const blobs = buildInstanceSet(blobShadowTemplate(), blobCopies(floats, n, rule.blobShadow), n, `scatter-blob:${src.id}:${rule.id}`, {
        chunkSize: rule.chunkSize ?? SCATTER_CHUNK_METERS_DEFAULT,
        copiesPerChunk: SCATTER_COPIES_PER_CHUNK,
        densityDistance: { start: SCATTER_BLOB_DISTANCE * COVER_FADE_START, end: SCATTER_BLOB_DISTANCE, min: 0 },
        ...(this.deps.tuning !== undefined ? { tuning: this.deps.tuning } : {}),
      });
      for (const m of blobs.meshes) {
        m.castShadow = false;
        m.receiveShadow = false;
      }
      g.root.add(blobs.group);
      g.sets.push({ rule: rule.id, built: blobs, casts: false, undress: null });
    }
    return casts;
  }

  private show(g: Group, on: boolean): void {
    if (g.shown === on) return;
    g.shown = on;
    this.deps.place(g.root, on);
  }

  private dropGroup(g: Group): void {
    this.show(g, false);
    for (const s of g.sets) this.dropSet(s);
    g.sets = [];
    for (const n of g.near) this.dropNear(n);
    g.near = [];
  }

  /** Keep a rule's near-shadow squares around the eye: drop the far ones, build the near ones (within the frame's time). */
  private nearShadows(src: Source, n: NearShadows, ex: number, ez: number, start: number, builtAlready: boolean): boolean {
    const d = n.rule.shadowDistance!;
    let built = false;
    for (const [key, sq] of [...n.squares]) {
      if (!src.hidden && distanceToSquare(ex, ez, key) <= d + SHADOW_RING_METRES / 2) continue;
      this.deps.place(sq.root, false);
      sq.built.dispose();
      sq.undress?.();
      n.squares.delete(key);
    }
    if (src.hidden) return false;
    n.index ??= copiesBySquare(n.floats, n.count, src.origin);
    for (const [key, indices] of n.index) {
      if (n.squares.has(key) || distanceToSquare(ex, ez, key) > d) continue;
      if ((builtAlready || built) && performance.now() - start > SCATTER_BUILD_MS) break;
      const template = this.deps.template(n.rule.asset.assetId, n.rule.asset.piece, () => this.modelReady(src));
      if (template === null) break;
      const set = buildInstanceSet(template, pickCopies(n.floats, indices), indices.length, `scatter-shadow:${src.id}:${n.rule.id}`, { chunkSize: SHADOW_RING_METRES, copiesPerChunk: SCATTER_COPIES_PER_CHUNK, ...(this.deps.tuning !== undefined ? { tuning: this.deps.tuning } : {}) });
      shadowOnly(set.meshes);
      const undress = this.deps.dress?.(set.group, n.rule.asset.assetId) ?? null;
      const root = new THREE.Group();
      root.name = `scatter-shadow:${src.id}:${key}`;
      root.position.set(...src.origin);
      root.add(set.group);
      root.updateMatrixWorld(true);
      this.deps.place(root, true);
      n.squares.set(key, { root, built: set, undress });
      built = true;
    }
    return built;
  }

  private dropNear(n: NearShadows): void {
    for (const sq of n.squares.values()) {
      this.deps.place(sq.root, false);
      sq.built.dispose();
      sq.undress?.();
    }
    n.squares.clear();
  }

  /** A set's chunks go before its materials may (a material released with its last user takes the chunks' render objects). */
  private dropSet(s: Group['sets'][number]): void {
    s.built.dispose();
    s.undress?.();
  }
}
