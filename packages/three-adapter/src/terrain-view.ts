/**
 * The terrains of the loaded scenes, drawn (the same view in the editor's
 * Scene view, Play and an export).
 *
 * A terrain's tiles come from the page's tile store (`terrain-tile-store.ts`:
 * read by digest, decoded and packed into texels on a worker, one decoded
 * copy shared with collision and queries) into three texture arrays per page
 * of tiles (`terrain-texels.ts`): a tile is one layer of each. Up to
 * {@link TERRAIN_PAGE_LAYERS} tiles share a page (the layer count both
 * renderers guarantee); a page is one draw of the shared grid mesh,
 * instanced once per selected quadtree node (`terrain-quadtree.ts`), its
 * vertices placed in the vertex shader (`terrain-material.ts`). Nothing is
 * meshed on the CPU: a sculpt replaces a tile's digest, the new tile is
 * packed and its layers uploaded again (its border normals, and its
 * neighbours' along the shared edges, written on the page: a few thousand
 * samples), and the cached static shadow map is drawn again once.
 *
 * Arrived texels are copied into the pages and uploaded a layer texture at a
 * time, within a time and a byte budget per frame (at least one), so a large
 * tile is spread over a few frames; a tile is drawn once its three layers
 * are up.
 *
 * Each frame the nodes are selected for the view's camera (only when it or
 * the tiles changed) and those in view lead the draw: the view's pass draws
 * them; any other camera (a shadow map) draws every selected node.
 *
 * A terrain wears its `materials` component's material ("*"; a run-time
 * swap too): a graph material compiled for the terrain's surface (the
 * layered template reads its layer weights as paint, and its texture arrays
 * at each pixel's layers); with none, or one that is not a graph, it shows
 * its four weight channels as plain colours.
 *
 * Picking: a page's mesh answers a ray from its terrain's `TerrainField`
 * (the grid three would test is flat).
 *
 * An entity realized again (an edit in the editor) keeps its textures: a
 * removal waits until the next update, and a terrain set again before it
 * only reads the tiles whose digests changed.
 */
import * as THREE from 'three';
import { flatTerrainTile, TerrainField, terrainFlatStep, terrainHeightOf, terrainTileBytes, terrainTileKey, type TerrainComponent, type TerrainTile } from '@thirdlight/runtime';

import { disposeSharingGeometry } from './dispose';
import { applyEntityRenderFlags } from './entity-render-flags';
import { GRAPH_SURFACE_KEY, type MaterialLibrary, type MaterialOverridesLike } from './material-library';
import type { GraphSurface } from './material-graph';
import { STATIC_CASTER_KEY } from './shadow-casters';
import { defaultTerrainMaterial, TERRAIN_NODE_ATTRIBUTE, TERRAIN_SUB_ATTRIBUTE, terrainEye, terrainSurface, terrainUniforms, type TerrainUniforms } from './terrain-material';
import { PageNodes, selectTerrainNodes, terrainLodLayout, terrainLodRanges, TERRAIN_NODE_FLOATS, tileHeightBounds, type SelectStats, type SelectTile, type TerrainLodLayout, type TileHeightBounds } from './terrain-quadtree';
import { metresPerStep, packFlat, packHeightNormalBorder, TERRAIN_TEXEL_BYTES } from './terrain-texels';
import type { TerrainTexels } from './terrain-pack-worker';
import { terrainPackShape, type TerrainTileStore } from './terrain-tile-store';
import { SphereSide, type CullView } from './view-cull';

/** Tiles per texture page: the array layers WebGL 2 and WebGPU both guarantee (256). */
export const TERRAIN_PAGE_LAYERS = 256;

/** The page flag that draws no terrain (`?terrain=off`: what the terrain costs, by comparison). */
export const TERRAIN_URL_PARAM = 'terrain';

export function terrainFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(TERRAIN_URL_PARAM);
  return v !== 'off' && v !== '0' && v !== 'false';
}

/** Main-thread time per frame spent copying arrived texels into the pages (at least one layer texture a frame). */
export const TERRAIN_UPLOAD_BUDGET_MS = 2;

/** Texel bytes uploaded per frame at most (at least one layer texture: a 1,025² tile's is 4.2 MB). */
export const TERRAIN_UPLOAD_BUDGET_BYTES = 4 * 1024 * 1024;

/** Frames whose upload times the diagnostics' peak covers. */
const UPLOAD_PEAK_FRAMES = 240;

/** `mesh.userData[TERRAIN_ENTITY_KEY]`: the terrain entity a page's mesh draws (picking names it). */
export const TERRAIN_ENTITY_KEY = '__tlTerrainEntity';

export interface TerrainViewDeps {
  /** The page's decoded tiles (shared with collision and queries). */
  readonly tiles: TerrainTileStore;
  readonly materials: MaterialLibrary | null;
  /** List a drawable in the scene, or take it out. */
  place(mesh: THREE.Mesh, shown: boolean): void;
  /** The terrain's shape changed (tiles arrived or were sculpted): the cached static shadow is drawn again. */
  shapeChanged(): void;
  /** Something arrived (a host drawing on demand draws again). */
  changed(): void;
  /** The LOD bias in force (the project's and the quality level's). */
  lodBias(): number;
}

/** What `setTerrain` dresses the terrain with: its entity's components (materials, render flags). */
export interface TerrainLook {
  readonly components: unknown;
  readonly materials: Readonly<Record<string, string>> | null;
  readonly overrides: MaterialOverridesLike | null;
}

export interface TerrainViewDiagnostics {
  terrains: number;
  /** Tiles drawn (read and uploaded) and listed. */
  tilesDrawn: number;
  tilesListed: number;
  /** Bytes the tile textures take on the GPU. */
  gpuBytes: number;
  /** Nodes selected, those in view, per level (leaf first), and draws (pages with nodes). */
  nodes: number;
  inView: number;
  perLevel: number[];
  draws: number;
  /** Main-thread milliseconds of the last frame's selection and uploads; the most a frame's uploads took and uploaded (bytes) over the last few seconds. */
  selectMs: number;
  uploadMs: number;
  uploadMsPeak: number;
  uploadBytesPeak: number;
  /** Tiles uploaded whole since the view began (a sculpted tile again: a test waits for its upload by it). */
  tilesUploaded: number;
  /** The last tile's decode and packing (on the worker), milliseconds. */
  decodeMs: number;
  packMs: number;
  /** Bytes the decoded tiles take on the page (`TerrainField.memory()`: one copy, shared with collision and queries). */
  cpuBytes: number;
  /** Tiles that failed to read (digest, message). */
  errors: string[];
}

interface TileRec {
  readonly x: number;
  readonly z: number;
  /** The digest drawn (null: flat) and the one being read. */
  digest: string | null;
  reading: string | null;
  tile: TerrainTile | null;
  page: number;
  layer: number;
  bounds: TileHeightBounds | null;
  /** Texels arrived and not yet copied into the page (each part null once it is). */
  pending: { heights: Uint8Array | null; layers: Uint8Array | null; indices: Uint8Array | null } | null;
  /** Its three layers uploaded at least once (drawn). */
  ready: boolean;
}

/** The page textures, in upload order. */
const PARTS = ['heights', 'layers', 'indices'] as const;
type Part = (typeof PARTS)[number];

interface Page {
  heights: THREE.DataArrayTexture;
  layers: THREE.DataArrayTexture;
  indices: THREE.DataArrayTexture;
  capacity: number;
  used: Set<number>;
  surface: GraphSurface;
  fallback: THREE.Material;
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  buffer: THREE.InstancedInterleavedBuffer;
  /** The geometry's own attributes (the grid's are shared). */
  own: THREE.InterleavedBufferAttribute[];
  nodes: PageNodes;
  /** In the scene's list. */
  listed: boolean;
  undoMaterial: (() => void) | null;
  /** The view and stamp its leading nodes were selected for. */
  view: CullView | null;
  stamp: number;
}

interface TerrainRec {
  readonly id: string;
  component: TerrainComponent;
  origin: [number, number, number];
  look: TerrainLook;
  layout: TerrainLodLayout;
  uniforms: TerrainUniforms;
  tiles: Map<string, TileRec>;
  pages: Page[];
  hidden: boolean;
  /** Removed: dropped at the next update unless set again. */
  leaving: boolean;
  /** Selection inputs changed (tiles drawn, ranges, origin): select again. */
  dirty: boolean;
  /** Tiles with texels to copy into their page, in arrival order. */
  uploads: Set<TileRec>;
  /** Uploaded tiles whose heights layer is to go up again (a neighbour's arrival changed its border normals). */
  reheights: Set<TileRec>;
  serial: number;
  /** The field over its decoded tiles (picking), made again when tiles arrive. */
  field: TerrainField | null;
  /** Its last selection's totals. */
  readonly stats: SelectStats;
  /** The finest level's reach the nodes were last selected with (the LOD bias or `lodDistance` changed it: select again). */
  reach: number;
}

/** The shared grid mesh: `grid`² quads over [0, 1]² in x and z, facing up (normal and tangent the vertex shader replaces). */
function gridGeometry(grid: number): THREE.BufferGeometry {
  const n = grid + 1;
  const pos = new Float32Array(n * n * 3);
  const nor = new Float32Array(n * n * 3);
  const tan = new Float32Array(n * n * 4);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      pos[i * 3] = x / grid;
      pos[i * 3 + 2] = z / grid;
      nor[i * 3 + 1] = 1;
      tan[i * 4] = 1;
      tan[i * 4 + 3] = 1;
    }
  }
  const idx = new Uint16Array(grid * grid * 6);
  let o = 0;
  for (let z = 0; z < grid; z++) {
    for (let x = 0; x < grid; x++) {
      const a = z * n + x;
      // Counter-clockwise seen from above (+y).
      idx[o++] = a;
      idx[o++] = a + n;
      idx[o++] = a + 1;
      idx[o++] = a + 1;
      idx[o++] = a + n;
      idx[o++] = a + n + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('tangent', new THREE.BufferAttribute(tan, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function arrayTexture(samples: number, capacity: number, filter: THREE.MagnificationTextureFilter): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(new Uint8Array(samples * samples * TERRAIN_TEXEL_BYTES * capacity), samples, samples, capacity);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = filter;
  t.minFilter = filter;
  t.generateMipmaps = false;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** `mesh.userData[PLACED_KEY]`: the page's mesh has its world matrix (it was placed once). */
const PLACED_KEY = '__tlTerrainPlaced';

const pow2AtLeast = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

export class TerrainView {
  private readonly deps: TerrainViewDeps;
  private readonly terrains = new Map<string, TerrainRec>();
  /** Grid meshes by quad count (shared by every terrain with that tile layout). */
  private readonly grids = new Map<number, THREE.BufferGeometry>();
  private serials = 0;
  private disposed = false;
  private lastSelectMs = 0;
  private lastUploadMs = 0;
  /** The last frames' upload times and bytes (a ring; their peak is in the diagnostics). */
  private readonly uploadMsRing = new Float32Array(UPLOAD_PEAK_FRAMES);
  private readonly uploadBytesRing = new Float64Array(UPLOAD_PEAK_FRAMES);
  private ringAt = 0;
  private lastDecodeMs = 0;
  private lastPackMs = 0;
  private tilesUploaded = 0;
  /** How many tiles of all terrains draw each digest (a tile no terrain draws is let go by the store). */
  private readonly digestUse = new Map<string, number>();
  private readonly errors: string[] = [];

  constructor(deps: TerrainViewDeps) {
    this.deps = deps;
  }

  /** The terrain of entity `id` (its component, its object's position, its look). */
  setTerrain(id: string, component: TerrainComponent, origin: readonly number[], look: TerrainLook): void {
    const at: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
    let rec = this.terrains.get(id);
    if (rec !== undefined && (rec.component.tileSamples !== component.tileSamples || rec.component.spacing !== component.spacing)) {
      // Another tile layout: built again from nothing.
      this.drop(rec);
      rec = undefined;
    }
    if (rec === undefined) {
      const layout = terrainLodLayout(component.tileSamples, component.spacing);
      rec = { id, component, origin: at, look, layout, uniforms: terrainUniforms(), tiles: new Map(), pages: [], hidden: false, leaving: false, dirty: true, uploads: new Set(), reheights: new Set(), serial: ++this.serials, reach: Number.NaN, field: null, stats: { nodes: 0, inView: 0, perLevel: [] } };
      this.terrains.set(id, rec);
    }
    rec.leaving = false;
    const rangeChanged = rec.component.heightRange[0] !== component.heightRange[0] || rec.component.heightRange[1] !== component.heightRange[1];
    rec.component = component;
    rec.look = look;
    rec.dirty = true;
    rec.field = null;
    const u = rec.uniforms;
    u.samples.value = component.tileSamples;
    u.spacing.value = component.spacing;
    u.low.value = terrainHeightOf(component.heightRange, 0);
    u.step.value = metresPerStep(component.heightRange);
    u.grid.value = rec.layout.grid;
    // The tiles: gone ones free their layers, new ones take one, changed ones are read again.
    const listed = new Set<string>();
    for (const ref of component.tiles) {
      const key = terrainTileKey(ref.x, ref.z);
      listed.add(key);
      let t = rec.tiles.get(key);
      if (t === undefined) {
        t = { x: ref.x, z: ref.z, digest: null, reading: null, tile: null, page: -1, layer: -1, bounds: null, pending: null, ready: false };
        rec.tiles.set(key, t);
        this.allocate(rec, t);
        if (ref.data === undefined) this.arriveFlat(rec, t);
      }
      const want = ref.data ?? null;
      if (want === t.digest && t.tile !== null && !rangeChanged) continue;
      if (want === null) {
        t.reading = null;
        this.arriveFlat(rec, t);
      } else if (t.reading !== want || rangeChanged) this.read(rec, t, want);
    }
    for (const [key, t] of [...rec.tiles]) {
      if (listed.has(key)) continue;
      rec.tiles.delete(key);
      this.release(rec, t);
      this.useDigest(t.digest, null);
      this.neighboursBorder(rec, t);
    }
    this.placeAll(rec, at);
    this.dress(rec);
  }

  /** The terrain of entity `id` goes (at the next update, unless it is set again first). */
  removeTerrain(id: string): void {
    const rec = this.terrains.get(id);
    if (rec !== undefined) rec.leaving = true;
  }

  /** Hide or show a terrain (its object is inactive or hidden). */
  setHidden(id: string, hidden: boolean): void {
    const rec = this.terrains.get(id);
    if (rec === undefined || rec.hidden === hidden) return;
    rec.hidden = hidden;
    for (const p of rec.pages) this.list(p, !hidden);
  }

  private list(p: Page, on: boolean): void {
    if (p.listed === on) return;
    p.listed = on;
    this.deps.place(p.mesh, on);
  }

  ids(): string[] {
    return [...this.terrains.keys()];
  }

  /** A run-time material swap on a terrain (its look's materials). */
  restyle(id: string, materials: Readonly<Record<string, string>> | null, overrides: MaterialOverridesLike | null): void {
    const rec = this.terrains.get(id);
    if (rec === undefined) return;
    rec.look = { ...rec.look, materials, overrides };
    this.dress(rec);
  }

  /** The field over a terrain's decoded tiles (heights, holes, layers at a point), or null for no such terrain. */
  field(id: string): TerrainField | null {
    const rec = this.terrains.get(id);
    return rec === undefined ? null : this.fieldOf(rec);
  }

  /**
   * Before the frame is drawn, after `view` was set to the frame's camera:
   * drop removed terrains, copy arrived texels into their pages and upload
   * them (within the frame's budget), and select the nodes drawn when the
   * view or the tiles changed.
   */
  update(view: CullView): void {
    if (this.disposed) return;
    for (const rec of [...this.terrains.values()]) if (rec.leaving) this.drop(rec);
    if (this.terrains.size === 0) {
      this.lastSelectMs = 0;
      this.lastUploadMs = 0;
      return;
    }
    const t0 = performance.now();
    let bytes = 0;
    let parts = 0;
    // Room for one more layer texture of `next` bytes this frame (the first always fits).
    const room = (next: number): boolean => parts === 0 || (performance.now() - t0 < TERRAIN_UPLOAD_BUDGET_MS && bytes + next <= TERRAIN_UPLOAD_BUDGET_BYTES);
    for (const rec of this.terrains.values()) {
      // Border normals changed under tiles already up: their heights layer again.
      for (const t of [...rec.reheights]) {
        if (!room(t.tile!.samples * t.tile!.samples * TERRAIN_TEXEL_BYTES)) break;
        rec.reheights.delete(t);
        if (t.layer < 0 || (t.pending?.heights ?? null) !== null) continue;
        bytes += this.markLayer(rec.pages[t.page]!, 'heights', t.layer, t.tile!.samples);
        parts += 1;
      }
      for (const t of [...rec.uploads]) {
        const pend = t.pending;
        if (pend === null || t.layer < 0 || t.tile === null) {
          rec.uploads.delete(t);
          continue;
        }
        const size = t.tile.samples * t.tile.samples * TERRAIN_TEXEL_BYTES;
        if (!room(size)) break;
        // One layer texture at a time: a large tile goes up over a few frames.
        for (const part of PARTS) {
          const src = pend[part];
          if (src === null) continue;
          if (!room(size)) break;
          const p = rec.pages[t.page]!;
          (p[part].image.data as Uint8Array).set(src, t.layer * size);
          bytes += this.markLayer(p, part, t.layer, t.tile.samples);
          parts += 1;
          pend[part] = null;
        }
        if (pend.heights === null && pend.layers === null && pend.indices === null) {
          t.pending = null;
          rec.uploads.delete(t);
          this.tilesUploaded += 1;
          if (!t.ready) {
            t.ready = true;
            rec.dirty = true;
          }
        }
      }
      if (rec.uploads.size > 0 || rec.reheights.size > 0) this.deps.changed();
    }
    const t1 = performance.now();
    this.lastUploadMs = t1 - t0;
    this.uploadMsRing[this.ringAt] = this.lastUploadMs;
    this.uploadBytesRing[this.ringAt] = bytes;
    this.ringAt = (this.ringAt + 1) % UPLOAD_PEAK_FRAMES;
    if (parts > 0) this.deps.shapeChanged();
    // The morph reads the view's camera in every pass.
    (terrainEye.value as THREE.Vector3).set(view.eye[0]!, view.eye[1]!, view.eye[2]!);
    for (const rec of this.terrains.values()) this.select(rec, view);
    this.lastSelectMs = performance.now() - t1;
  }

  diagnostics(): TerrainViewDiagnostics {
    let tilesDrawn = 0;
    let tilesListed = 0;
    let gpuBytes = 0;
    let draws = 0;
    const held = new Set<TerrainTile>();
    for (const rec of this.terrains.values()) {
      tilesListed += rec.tiles.size;
      for (const t of rec.tiles.values()) {
        if (t.ready) tilesDrawn += 1;
        if (t.tile !== null && t.digest !== null) held.add(t.tile);
      }
      for (const p of rec.pages) {
        gpuBytes += p.heights.image.data!.byteLength + p.layers.image.data!.byteLength + p.indices.image.data!.byteLength;
        if (p.nodes.count > 0) draws += 1;
      }
    }
    // Every terrain's last selection, level by level (leaf first).
    let nodes = 0;
    let inView = 0;
    const perLevel: number[] = [];
    for (const rec of this.terrains.values()) {
      nodes += rec.stats.nodes;
      inView += rec.stats.inView;
      rec.stats.perLevel.forEach((n, l) => (perLevel[l] = (perLevel[l] ?? 0) + n));
    }
    let cpuBytes = 0;
    for (const t of held) cpuBytes += terrainTileBytes(t);
    const r3 = (v: number): number => Math.round(v * 1000) / 1000;
    let peakMs = 0;
    let peakBytes = 0;
    for (let i = 0; i < UPLOAD_PEAK_FRAMES; i++) {
      peakMs = Math.max(peakMs, this.uploadMsRing[i]!);
      peakBytes = Math.max(peakBytes, this.uploadBytesRing[i]!);
    }
    return { terrains: this.terrains.size, tilesDrawn, tilesListed, gpuBytes, nodes, inView, perLevel, draws, selectMs: r3(this.lastSelectMs), uploadMs: r3(this.lastUploadMs), uploadMsPeak: r3(peakMs), uploadBytesPeak: peakBytes, tilesUploaded: this.tilesUploaded, decodeMs: r3(this.lastDecodeMs), packMs: r3(this.lastPackMs), cpuBytes, errors: this.errors.slice(-8) };
  }

  dispose(): void {
    this.disposed = true;
    for (const rec of [...this.terrains.values()]) this.drop(rec);
    for (const g of this.grids.values()) g.dispose();
    this.grids.clear();
  }

  // ---- tiles -----------------------------------------------------------------------------

  private read(rec: TerrainRec, t: TileRec, digest: string): void {
    t.reading = digest;
    if (!this.deps.tiles.reads) {
      this.error(`terrain ${rec.id}: tile [${t.x}, ${t.z}] has data but nothing reads buffers here`);
      return;
    }
    const shape = terrainPackShape(rec.component);
    void this.deps.tiles.packed(digest, shape).then(
      (packed) => {
        // Still wanted: the same terrain, tile and shape, not read again since.
        if (this.disposed || this.terrains.get(rec.id) !== rec || rec.tiles.get(terrainTileKey(t.x, t.z)) !== t || t.reading !== digest) return;
        if (metresPerStep(rec.component.heightRange) !== shape.metresPerStep || rec.component.spacing !== shape.spacing) return;
        t.reading = null;
        if (packed.tile.samples !== rec.component.tileSamples) {
          this.error(`terrain ${rec.id}: tile [${t.x}, ${t.z}] holds ${packed.tile.samples} samples a side, the terrain ${rec.component.tileSamples}`);
          return;
        }
        this.lastDecodeMs = packed.decodeMs;
        this.lastPackMs = packed.packMs;
        this.arrive(rec, t, digest, packed.tile, packed.texels);
        this.deps.changed();
      },
      (e: unknown) => {
        if (t.reading === digest) t.reading = null;
        this.error(`terrain ${rec.id}: tile [${t.x}, ${t.z}] (${digest.slice(0, 12)}…) could not be read: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  }

  /** A tile without data: flat at the terrain's flat step (texels filled on the page, cheap). */
  private arriveFlat(rec: TerrainRec, t: TileRec): void {
    const s = rec.component.tileSamples;
    const step = terrainFlatStep(rec.component.heightRange);
    const tile = flatTerrainTile(s, step);
    const bytes = s * s * TERRAIN_TEXEL_BYTES;
    const texels = { heights: new Uint8Array(bytes), layers: new Uint8Array(bytes), indices: new Uint8Array(bytes), bounds: tileHeightBounds(tile.heights, rec.layout) };
    packFlat(texels.heights, texels.layers, texels.indices, step);
    this.arrive(rec, t, null, tile, texels);
  }

  private arrive(rec: TerrainRec, t: TileRec, digest: string | null, tile: TerrainTile, texels: TerrainTexels): void {
    this.useDigest(t.digest, digest);
    t.digest = digest;
    t.tile = tile;
    t.bounds = texels.bounds;
    t.pending = { heights: texels.heights, layers: texels.layers, indices: texels.indices };
    rec.uploads.delete(t);
    rec.uploads.add(t);
    rec.reheights.delete(t);
    rec.dirty = true;
    rec.field = null;
    // Packed alone: its border normals read the neighbours here; theirs read it.
    packHeightNormalBorder(t.pending.heights!, tile, this.neighbourOf(rec, t), metresPerStep(rec.component.heightRange), rec.component.spacing);
    this.neighboursBorder(rec, t);
  }

  private neighbourOf(rec: TerrainRec, t: TileRec): (dx: number, dz: number) => TerrainTile | undefined {
    return (dx, dz) => rec.tiles.get(terrainTileKey(t.x + dx, t.z + dz))?.tile ?? undefined;
  }

  /** The neighbours' border normals again (a tile came, changed or went): in their pending texels, or in their page and uploaded again. */
  private neighboursBorder(rec: TerrainRec, t: TileRec): void {
    const mps = metresPerStep(rec.component.heightRange);
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const n = rec.tiles.get(terrainTileKey(t.x + dx, t.z + dz));
      if (n === undefined || n.tile === null || n.layer < 0) continue;
      const pend = n.pending?.heights ?? null;
      if (pend !== null) packHeightNormalBorder(pend, n.tile, this.neighbourOf(rec, n), mps, rec.component.spacing);
      else if (n.ready) {
        const size = n.tile.samples * n.tile.samples * TERRAIN_TEXEL_BYTES;
        const p = rec.pages[n.page]!;
        packHeightNormalBorder((p.heights.image.data as Uint8Array).subarray(n.layer * size, (n.layer + 1) * size), n.tile, this.neighbourOf(rec, n), mps, rec.component.spacing);
        rec.reheights.add(n);
      }
    }
  }

  /** Mark one layer of a page texture for upload; its bytes. */
  private markLayer(p: Page, part: Part, layer: number, samples: number): number {
    p[part].addLayerUpdate(layer);
    p[part].needsUpdate = true;
    return samples * samples * TERRAIN_TEXEL_BYTES;
  }

  /** Count a tile's digest in and the one it had out; the store lets go of a tile no terrain draws. */
  private useDigest(was: string | null, now: string | null): void {
    if (was === now) return;
    if (now !== null) this.digestUse.set(now, (this.digestUse.get(now) ?? 0) + 1);
    if (was !== null) {
      const n = (this.digestUse.get(was) ?? 1) - 1;
      if (n > 0) this.digestUse.set(was, n);
      else {
        this.digestUse.delete(was);
        this.deps.tiles.release(was);
      }
    }
  }

  private fieldOf(rec: TerrainRec): TerrainField {
    if (rec.field === null) {
      const loaded = new Map<string, TerrainTile>();
      for (const [k, t] of rec.tiles) if (t.tile !== null) loaded.set(k, t.tile);
      rec.field = new TerrainField(rec.component, rec.origin, loaded);
    }
    return rec.field;
  }

  private error(message: string): void {
    this.errors.push(message);
    if (this.errors.length > 32) this.errors.shift();
  }

  // ---- pages -----------------------------------------------------------------------------

  /** A texture layer for a tile: a page with room, a page grown, or a new page. */
  private allocate(rec: TerrainRec, t: TileRec): void {
    for (let i = 0; i < rec.pages.length; i++) {
      const p = rec.pages[i]!;
      if (p.used.size >= p.capacity && p.capacity < TERRAIN_PAGE_LAYERS) this.grow(rec, i, Math.min(TERRAIN_PAGE_LAYERS, p.capacity * 2));
      if (p.used.size < rec.pages[i]!.capacity) {
        const page = rec.pages[i]!;
        let layer = 0;
        while (page.used.has(layer)) layer++;
        page.used.add(layer);
        t.page = i;
        t.layer = layer;
        return;
      }
    }
    const want = Math.min(TERRAIN_PAGE_LAYERS, pow2AtLeast(rec.component.tiles.length - rec.pages.length * TERRAIN_PAGE_LAYERS));
    rec.pages.push(this.makePage(rec, want));
    const page = rec.pages[rec.pages.length - 1]!;
    page.used.add(0);
    t.page = rec.pages.length - 1;
    t.layer = 0;
  }

  private release(rec: TerrainRec, t: TileRec): void {
    rec.uploads.delete(t);
    rec.reheights.delete(t);
    rec.field = null;
    rec.pages[t.page]?.used.delete(t.layer);
    t.page = -1;
    t.layer = -1;
    rec.dirty = true;
  }

  private makePage(rec: TerrainRec, capacity: number): Page {
    const s = rec.component.tileSamples;
    const heights = arrayTexture(s, capacity, THREE.NearestFilter);
    const layers = arrayTexture(s, capacity, THREE.LinearFilter);
    const indices = arrayTexture(s, capacity, THREE.NearestFilter);
    const surface = terrainSurface(`terrain:${rec.serial}:${++this.serials}`, heights, layers, indices, rec.uniforms);
    const fallback = defaultTerrainMaterial(surface);
    let grid = this.grids.get(rec.layout.grid);
    if (grid === undefined) this.grids.set(rec.layout.grid, (grid = gridGeometry(rec.layout.grid)));
    const { geometry, buffer, own } = nodeGeometry(grid, 64);
    const mesh = new THREE.Mesh(geometry, fallback);
    mesh.name = `terrain:${rec.id}`;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.userData[STATIC_CASTER_KEY] = true;
    mesh.userData[GRAPH_SURFACE_KEY] = surface;
    mesh.userData[TERRAIN_ENTITY_KEY] = rec.id;
    const page: Page = { heights, layers, indices, capacity, used: new Set(), surface, fallback, mesh, geometry, buffer, own, nodes: new PageNodes(), listed: false, undoMaterial: null, view: null, stamp: -1 };
    // Picking reads the terrain's heights (the grid three would test is flat); its first page answers for it.
    mesh.raycast = (raycaster, hits) => {
      if (rec.pages[0] !== page || this.terrains.get(rec.id) !== rec) return;
      const r = raycaster.ray;
      const hit = this.fieldOf(rec).raycast([r.origin.x, r.origin.y, r.origin.z], [r.direction.x, r.direction.y, r.direction.z], raycaster.far);
      if (hit !== null && hit.distance >= raycaster.near) hits.push({ distance: hit.distance, point: new THREE.Vector3(...hit.point), object: mesh });
    };
    // Per pass: the view draws the nodes in view (they lead), any other camera all of them.
    mesh.onBeforeRender = (_r, _s, camera) => {
      page.geometry.instanceCount = page.view !== null && page.stamp === page.view.stamp && page.view.is(camera) ? page.nodes.inView : page.nodes.count;
    };
    geometry.instanceCount = 0;
    return page;
  }

  /** Grow page `i` to `capacity` layers: new textures holding the old layers, a new surface (a new compile). */
  private grow(rec: TerrainRec, i: number, capacity: number): void {
    const old = rec.pages[i]!;
    const s = rec.component.tileSamples;
    const heights = arrayTexture(s, capacity, THREE.NearestFilter);
    const layers = arrayTexture(s, capacity, THREE.LinearFilter);
    const indices = arrayTexture(s, capacity, THREE.NearestFilter);
    (heights.image.data as Uint8Array).set(old.heights.image.data as Uint8Array);
    (layers.image.data as Uint8Array).set(old.layers.image.data as Uint8Array);
    (indices.image.data as Uint8Array).set(old.indices.image.data as Uint8Array);
    const surface = terrainSurface(`terrain:${rec.serial}:${++this.serials}`, heights, layers, indices, rec.uniforms);
    const fallback = defaultTerrainMaterial(surface);
    old.undoMaterial?.();
    old.undoMaterial = null;
    old.heights.dispose();
    old.layers.dispose();
    old.indices.dispose();
    old.fallback.dispose();
    old.heights = heights;
    old.layers = layers;
    old.indices = indices;
    old.capacity = capacity;
    old.surface = surface;
    old.fallback = fallback;
    old.mesh.material = fallback;
    old.mesh.userData[GRAPH_SURFACE_KEY] = surface;
    this.dressPage(rec, old);
  }

  /** Put each page's mesh where the terrain is (listed in the scene unless hidden). */
  private placeAll(rec: TerrainRec, at: [number, number, number]): void {
    const moved = at[0] !== rec.origin[0] || at[1] !== rec.origin[1] || at[2] !== rec.origin[2];
    rec.origin = at;
    for (const p of rec.pages) {
      const m = p.mesh;
      const placed = m.userData[PLACED_KEY] === true;
      if (placed && !moved) {
        if (!rec.hidden) this.list(p, true);
        continue;
      }
      // A listed drawable's world matrix is taken as it is when listed: listed again where it is now.
      this.list(p, false);
      m.position.set(at[0], at[1], at[2]);
      m.updateMatrix();
      m.matrixWorld.copy(m.matrix);
      m.userData[PLACED_KEY] = true;
      if (!rec.hidden) this.list(p, true);
    }
    if (moved) {
      rec.dirty = true;
      rec.field = null;
    }
  }

  /** The terrain's material and render flags on every page. */
  private dress(rec: TerrainRec): void {
    for (const p of rec.pages) this.dressPage(rec, p);
  }

  private dressPage(rec: TerrainRec, p: Page): void {
    applyEntityRenderFlags(p.mesh, rec.look.components);
    p.undoMaterial?.();
    p.undoMaterial = null;
    const lib = this.deps.materials;
    if (lib !== null && rec.look.materials !== null) p.undoMaterial = lib.apply(p.mesh, rec.look.materials, rec.look.overrides);
  }

  private drop(rec: TerrainRec): void {
    for (const p of rec.pages) {
      this.list(p, false);
      p.undoMaterial?.();
      (p.mesh as unknown as { dispose?: () => void }).dispose?.();
      disposeSharingGeometry(p.geometry, p.own);
      p.heights.dispose();
      p.layers.dispose();
      p.indices.dispose();
      p.fallback.dispose();
    }
    rec.pages = [];
    for (const t of rec.tiles.values()) this.useDigest(t.digest, null);
    this.terrains.delete(rec.id);
  }

  // ---- selection -------------------------------------------------------------------------

  private select(rec: TerrainRec, view: CullView): void {
    if (rec.hidden || rec.pages.length === 0) return;
    const ranges = terrainLodRanges(rec.layout, rec.component.lodDistance, this.deps.lodBias());
    const fresh = rec.pages.every((p) => p.view === view && p.stamp === view.stamp);
    if (fresh && !rec.dirty && ranges[0] === rec.reach) return;
    rec.dirty = false;
    rec.reach = ranges[0]!;
    const [ox, oy, oz] = rec.origin;
    const tiles: SelectTile[] = [];
    for (const t of rec.tiles.values()) if (t.ready && t.bounds !== null && t.page >= 0) tiles.push({ x: t.x, z: t.z, page: t.page, layer: t.layer, bounds: t.bounds });
    const range = rec.component.heightRange;
    selectTerrainNodes(
      tiles,
      {
        layout: rec.layout,
        ranges,
        eye: [view.eye[0]! - ox, view.eye[1]! - oy, view.eye[2]! - oz],
        heightOf: (step) => terrainHeightOf(range, step),
        inView: view.camera === null ? null : (x, y, z, r) => view.side(x + ox, y + oy, z + oz, r) !== SphereSide.Outside,
      },
      rec.pages.map((p) => p.nodes),
      rec.stats,
    );
    for (const p of rec.pages) {
      const need = p.nodes.count * TERRAIN_NODE_FLOATS;
      if (need > p.buffer.array.length) {
        const old = p.geometry;
        const oldOwn = p.own;
        const grid = this.grids.get(rec.layout.grid)!;
        const made = nodeGeometry(grid, pow2AtLeast(p.nodes.count));
        p.geometry = made.geometry;
        p.buffer = made.buffer;
        p.own = made.own;
        p.mesh.geometry = made.geometry;
        disposeSharingGeometry(old, oldOwn);
      }
      (p.buffer.array as Float32Array).set(p.nodes.data.subarray(0, need));
      p.buffer.clearUpdateRanges();
      p.buffer.addUpdateRange(0, need);
      p.buffer.needsUpdate = true;
      p.geometry.instanceCount = p.nodes.count;
      p.view = view;
      p.stamp = view.stamp;
    }
  }
}

/** The grid drawn instanced: its attributes shared, plus the nodes' two vec4 per instance. */
function nodeGeometry(grid: THREE.BufferGeometry, capacity: number): { geometry: THREE.InstancedBufferGeometry; buffer: THREE.InstancedInterleavedBuffer; own: THREE.InterleavedBufferAttribute[] } {
  const g = new THREE.InstancedBufferGeometry();
  g.index = grid.index;
  for (const name of ['position', 'normal', 'tangent']) g.setAttribute(name, grid.getAttribute(name));
  // Static usage, uploaded when the selection changes (three's WebGPU renderer uploads a dynamic-usage buffer every draw).
  const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * TERRAIN_NODE_FLOATS), TERRAIN_NODE_FLOATS, 1);
  const own = [new THREE.InterleavedBufferAttribute(buffer, 4, 0), new THREE.InterleavedBufferAttribute(buffer, 4, 4)];
  g.setAttribute(TERRAIN_NODE_ATTRIBUTE, own[0]!);
  g.setAttribute(TERRAIN_SUB_ATTRIBUTE, own[1]!);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return { geometry: g, buffer, own };
}
