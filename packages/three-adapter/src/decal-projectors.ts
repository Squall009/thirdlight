/**
 * The projected decals of a scene adapter: each loaded decal entity in
 * `projected` mode and each decal a script spawned (`ctx.decals.spawn`), its
 * world box, and its material's images and factors, kept as the table and
 * the world-grid index the receiving materials read (decal-index.ts,
 * projected-decals.ts), attached to the scene only while a decal can mark
 * something.
 *
 * Images come from the decal material as the material library built it: in
 * Play and the export a layer of the build's decal pages (each set one
 * texture array), in a view without pages (the editor's Scene view) the
 * material's own textures, which `decal-view-pages.ts` draws into arrays of
 * its own. A decal whose albedo image has not arrived marks nothing yet (as a
 * mesh decal draws nothing then). A decal naming an array other than the one
 * its set binds (a build whose set was split past what one array takes) is
 * not drawn and counted (`unplaced`).
 *
 * Changes are applied in place: a decal that moved (its entity, or the
 * object a spawned decal sticks to), a decal added or removed, a spawned one
 * fading, rewrites its own table row and the index cells it left and
 * entered, and the objects it can reach are found again only near it; a still
 * frame compares the decals' world matrices and their sources, nothing more.
 * The table and the index are built whole when the images or the materials
 * change (a new page array, an image arriving, a material edited), when a
 * decal of a material not placed yet comes, and when the index's layout
 * cannot take a change (decal-index.ts).
 *
 * Spawned decals are presentation: they never reach the simulation. Past the
 * transient budget (project-model `DECAL_TRANSIENT_BUDGET`) the oldest fade
 * out over `DECAL_TRANSIENT_FADE_SECONDS`, as one does at the end of its
 * lifetime or when a script removes it; a run restart clears them. A decal a
 * spawn sticks to an object with follows the object and goes with it.
 */
import * as THREE from 'three/webgpu';
import { DECAL_CELL_BUDGET, DECAL_DEFAULTS, DECAL_FADE, DECAL_LAYERS_ALL, DECAL_TRANSIENT_BUDGET, DECAL_TRANSIENT_FADE_SECONDS, decalEdgeFade, decalLayersOf, decalNormalFade } from '@thirdlight/runtime';

import { DecalGrid, DECAL_ROW_TEXELS, DECAL_TEXTURE_WIDTH, packDecalRow, type DecalRow } from './decal-index';
import { createDecalViewPages, DECAL_VIEW_PAGE_SIZE, type DecalViewPages } from './decal-view-pages';
import { decalSourceOf, type DecalSource } from './material-library';
import { attachProjectedDecals, DECAL_LAYER_TEST_BIT, DECAL_PAGE_BITS, decalDataTexture, ProjectedDecals, type DecalPageSetName } from './projected-decals';

/** The decal component as the renderer reads it (project-model `DecalComponent`). */
export interface ProjectedDecalLike {
  readonly size: readonly number[];
  readonly mode?: string;
  readonly material: string;
  readonly opacity?: Readonly<Partial<Record<'albedo' | 'normal' | 'roughness' | 'metalness' | 'occlusion' | 'emission', number>>>;
  readonly normalFade?: number;
  readonly edgeFade?: readonly number[];
  readonly fadeDistance?: number;
  readonly sortOrder?: number;
  readonly layers?: number;
}

/** A script's decal request (runtime `DecalRequest`). */
export interface DecalRequestLike {
  readonly op: 'spawn' | 'remove' | 'clear';
  readonly handle: number;
  readonly entityId: string | null;
  readonly decal: ProjectedDecalLike | null;
  readonly position: readonly number[];
  readonly rotation: readonly number[];
  readonly lifetime: number;
}

/** What the decals cost and hold (diagnostics `renderer.projectedDecals`). */
export interface DecalProjectorsObservation {
  /** Projected decals loaded (spawned ones included), and of them those drawn (their images here, their arrays bound). */
  readonly decals: number;
  readonly drawn: number;
  /** Not drawn: an image on an array other than its set's. */
  readonly unplaced: number;
  /** The index: cells, entries, entries dropped over the overlap budget; whole builds and how long the last took (ms). */
  readonly cells: number;
  readonly entries: number;
  readonly dropped: number;
  readonly builds: number;
  readonly buildMs: number;
  /** Decals changed in place (moved, added, removed, fading) since the page loaded, and the main-thread time of the last frame with any (ms). */
  readonly updates: number;
  readonly updateMs: number;
  /** Decals scripts spawned that are alive, and of them fading out. */
  readonly spawned: number;
  readonly fading: number;
  /** The table and index texture's bytes, and the view pages' (a view without the build's pages). */
  readonly dataBytes: number;
  readonly viewPageBytes: number;
  /** Draws in the last frame that blended decals (every pass; the rest kept their own programs). */
  readonly receiverDraws: number;
}

/** `scene.userData[PROJECTED_DECALS_KEY]`: the scene's projected decals (a measurement reads their diagnostics). */
export const PROJECTED_DECALS_KEY = 'tlProjectedDecals';

export interface DecalProjectors {
  /** A decal entity's node and component (null: it has no projected decal). */
  set(entityId: string, node: THREE.Object3D, decal: ProjectedDecalLike | null): void;
  /** An entity gone: its decal, and the decals spawned on it. */
  remove(entityId: string): void;
  /** The materials changed: every decal takes its material again. */
  refresh(): void;
  /**
   * Before a frame: take scripts' requests (`objectOf` finds the object a
   * spawn sticks to), age the spawned decals (not while `paused`), apply what
   * changed, draw view pages, attach the decals to the scene or detach them.
   */
  beforeFrame(renderer: THREE.Renderer, requests?: readonly DecalRequestLike[], objectOf?: (entityId: string) => THREE.Object3D | null, paused?: boolean): void;
  observe(): DecalProjectorsObservation;
  dispose(): void;
}

/** A decal a script spawned: where it sticks, its age and its fade. */
interface Spawn {
  readonly handle: number;
  /** The object it sticks to and its id (null: world space), and its box in that object's (or the world's) space. */
  readonly parent: THREE.Object3D | null;
  readonly parentId: string | null;
  readonly local: THREE.Matrix4;
  age: number;
  readonly lifetime: number;
  /** Seconds into its fade, and the fade's length (null: not fading). */
  fading: number | null;
  fadeLength: number;
}

interface Entry {
  readonly id: string;
  node: THREE.Object3D;
  decal: ProjectedDecalLike;
  material: THREE.Material | null;
  /** The world matrix the table holds. */
  readonly seen: Float64Array;
  /** Its table row (−1: not in the table) and the opacity the row was written with. */
  row: number;
  alpha: number;
  /** Ties in sort order are drawn in the order decals came (a newer mark over an older one). */
  readonly seq: number;
  readonly spawn: Spawn | null;
}

/** Where a source's images are: each set's layer, the rectangle, the read's longest footprint (null: not placed). */
interface Place {
  readonly layers: readonly [number, number, number];
  readonly rect: readonly [number, number, number, number];
  readonly footprint: number;
}

const SETS: readonly DecalPageSetName[] = ['albedo', 'normal', 'orm'];
const RAD = Math.PI / 180;
/** Table rows a build leaves room for beyond its decals (spawns and new decals go in without a build). */
const ROWS_MIN = 64;
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const pow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));
/** The longest frame step a spawned decal ages by (a tab in the background comes back without its marks gone at once). */
const AGE_STEP_MAX = 0.25;

/** A material colour's linear components (three keeps colours linear). */
const rgb = (c: unknown): [number, number, number] => {
  const col = c as THREE.Color | undefined;
  return col?.isColor === true ? [col.r, col.g, col.b] : [1, 1, 1];
};

export function createDecalProjectors(o: {
  readonly scene: THREE.Scene;
  /** The library's projected-decal hold (`MaterialLibrary.projectedDecal`). */
  readonly materialOf: (holder: string, materialId: string | null) => THREE.Material | null;
  /** Hold the page arrays of a spawned decal's material (null: let go); entities hold theirs through the adapter. */
  readonly holdPages?: (holder: string, materialId: string | null) => void;
  /** Problems for the author: `decal_overlap` when a cell first has more decals than the overlap budget. */
  readonly onProblem?: (code: string, message: string) => void;
  readonly onChange?: () => void;
  /** The clock spawned decals age by (ms; absent: the page's). */
  readonly now?: () => number;
}): DecalProjectors {
  const now = o.now ?? (() => performance.now());
  const entries = new Map<string, Entry>();
  /** Spawned decals not fading, oldest first (the budget fades them in this order), and every spawned decal alive. */
  const spawnOrder: Entry[] = [];
  const spawns = new Set<Entry>();
  let decals: ProjectedDecals | null = null;
  let view: DecalViewPages | null = null;
  let dirty = true;
  const grid = new DecalGrid(DECAL_CELL_BUDGET);
  /** The table's rows (capacity), lines, the rows free for new decals, the next never used. */
  let rowCap = 0;
  let tableLines = 0;
  const freeRows: number[] = [];
  let nextRow = 0;
  /** What the last build placed: each source's place (null: unplaced), the bound arrays, the pages' side. */
  let places = new Map<DecalSource, Place | null>();
  let uses = 0;
  let drawn = 0;
  let unplaced = 0;
  let builds = 0;
  let buildMs = 0;
  let updates = 0;
  let updateMs = 0;
  let receiverDraws = 0;
  let seq = 0;
  let lastNow: number | null = null;
  let overlapReported = false;
  /** What each decal's sources looked like at the last build (an image arriving changes it). */
  let sourcesSeen = '';
  const materialsNow = new Set<THREE.Material>();
  /** Entries whose row is to be written again this frame (moved, fading, new); a row let go since the last upload. */
  const touched = new Set<Entry>();
  let pending = false;
  const holder = (id: string): string => `projected:${id}`;
  const m4 = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  const corner = new THREE.Vector3();

  const sourceKey = (s: DecalSource | null): string => {
    if (s === null) return '-';
    const i = s.images;
    const img = (x: { texture: THREE.Texture; layer: number | null } | null): string => (x === null ? '0' : `${x.texture.uuid}/${x.layer ?? 'v'}`);
    return `${img(i.albedo)},${img(i.normal)},${img(i.orm)},${img(i.emissive)},${i.albedoComing ? 1 : 0},${s.place.rect.join(':')},${s.place.mip ?? 'n'},${s.place.size[0]}`;
  };

  /** The source a decal draws from now (null: none yet, or its albedo image on its way). */
  const liveSource = (e: Entry): DecalSource | null => {
    const s = decalSourceOf(e.material);
    return s === null || (s.images.albedo === null && s.images.albedoComing) ? null : s;
  };

  const rowOf = (e: Entry, s: DecalSource, place: Place): DecalRow => {
    const d = e.decal;
    const size = [Math.max(1e-6, num(d.size[0], 1)), Math.max(1e-6, num(d.size[1], 1)), Math.max(1e-6, num(d.size[2], 1))];
    m4.copy(e.node.matrixWorld);
    inv.copy(m4).invert();
    const el = inv.elements;
    const worldToBox: number[] = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) worldToBox.push(el[c * 4 + r]! / size[r]!);
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 8; k++) {
      corner.set(((k & 1) - 0.5) * size[0]!, (((k >> 1) & 1) - 0.5) * size[1]!, (((k >> 2) & 1) - 0.5) * size[2]!).applyMatrix4(m4);
      min[0] = Math.min(min[0], corner.x);
      min[1] = Math.min(min[1], corner.y);
      min[2] = Math.min(min[2], corner.z);
      max[0] = Math.max(max[0], corner.x);
      max[1] = Math.max(max[1], corner.y);
      max[2] = Math.max(max[2], corner.z);
    }
    const op = d.opacity ?? {};
    const fade = decalNormalFade(d.normalFade);
    const m = e.material as (THREE.Material & { color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number; roughness?: number; metalness?: number; normalScale?: THREE.Vector2 }) | null;
    const glow = rgb(m?.emissive);
    const gi = num(m?.emissiveIntensity, 0);
    const scale = Math.abs(num(m?.normalScale?.x, 1));
    const hasAlbedo = place.layers[0] >= 0 || s.params['color'] !== undefined;
    const hasNormal = place.layers[1] >= 0;
    // The ORM set may carry only an emissive mask: roughness, metalness and occlusion then come from values or not at all.
    const hasOrm = place.layers[2] >= 0;
    const hasOrmImage = hasOrm && s.ormImage;
    return {
      worldToBox,
      min,
      max,
      rect: place.rect,
      layers: [place.layers[0], place.layers[1], place.layers[2]],
      footprint: place.footprint,
      opacity: [
        // A channel the decal has no image (or set value) for is left alone: a stain does not flatten the normal map or
        // the ORM under it, and a wet patch (roughness only) or a crack (normal only) does not paint its tint.
        hasAlbedo ? num(op.albedo, 1) : 0,
        hasNormal ? num(op.normal, 1) : 0,
        hasOrmImage || s.params['roughness'] !== undefined ? num(op.roughness, 1) : 0,
        hasOrmImage || s.params['metalness'] !== undefined ? num(op.metalness, 1) : 0,
        hasOrmImage ? num(op.occlusion, 1) : 0,
        hasOrm && gi > 0 && Math.max(...glow) > 0 ? num(op.emission, 1) : 0,
      ],
      // At the largest angle every facing is marked, back faces too (as the clipper keeps them): below any cosine.
      normalFadeCos: fade.all ? [-3, -2] : [Math.cos(fade.degrees * RAD), Math.cos(fade.degrees * DECAL_FADE.fullMarkShare * RAD)],
      edgeFade: decalEdgeFade(d.edgeFade),
      fadeDistance: Math.max(0, num(d.fadeDistance, 0)),
      layerMask: decalLayersOf(d.layers) || DECAL_LAYERS_ALL,
      // A spawned decal fading out fades its whole mark (every channel goes with the material's opacity).
      tint: [...rgb(m?.color), num(m?.opacity, 1) * e.alpha],
      emissive: [glow[0] * gi, glow[1] * gi, glow[2] * gi],
      aoIntensity: num(s.params['aoIntensity'], 1),
      roughness: num(m?.roughness, 1),
      metalness: num(m?.metalness, 0),
      normalScale: [scale, scale],
      sortOrder: Math.round(num(d.sortOrder, DECAL_DEFAULTS.sortOrder)),
    };
  };

  /** The channels and page sets a row reads, and its layer test (decal programs build only what some decal uses). */
  const usesOf = (r: DecalRow): number => {
    let u = 0;
    r.opacity.forEach((v, k) => (u |= v > 0 ? 1 << k : 0));
    if (r.layerMask !== DECAL_LAYERS_ALL) u |= DECAL_LAYER_TEST_BIT;
    if (r.layers[0] >= 0) u |= DECAL_PAGE_BITS.albedo;
    if (r.layers[1] >= 0) u |= DECAL_PAGE_BITS.normal;
    if (r.layers[2] >= 0) u |= DECAL_PAGE_BITS.orm;
    return u;
  };

  /** Write `e`'s row (its place known) into the data and the index; false: a whole build is needed. */
  const writeRow = (e: Entry, s: DecalSource, place: Place): boolean => {
    if (decals === null) return false;
    const r = rowOf(e, s, place);
    packDecalRow(decals.data.image.data as Float32Array, e.row, r);
    if (!grid.set(e.row, r, e.seq)) return false;
    decals.setBox(e.row, r);
    // Channels only ever join until the next build: a decal that comes and goes does not make programs again each time.
    uses |= usesOf(r);
    return true;
  };

  const releaseRow = (e: Entry): void => {
    if (e.row < 0) return;
    if (decals !== null && !dirty) {
      // A removal can leave the cells sized for decals that are gone: then the grid is built again.
      if (!grid.set(e.row, undefined)) dirty = true;
      decals.setBox(e.row, undefined);
      pending = true;
    }
    freeRows.push(e.row);
    e.row = -1;
  };

  /** Copy what the index wrote into the data texture's index lines; mark the texture for upload. */
  const flush = (): void => {
    if (decals === null) return;
    const out = decals.data.image.data as Float32Array;
    const at = tableLines * DECAL_TEXTURE_WIDTH;
    const d = grid.takeDirty();
    if (d !== null) out.set(grid.data.subarray(d.from * 4, d.to * 4), (at + d.from) * 4);
    decals.data.needsUpdate = true;
    decals.invCell.w = grid.probes;
  };

  /**
   * The decals on the scene while one is drawn. The same decals come back
   * after a time without any (a lull between shots): their variants' programs
   * are keyed by them, so nothing is built again.
   */
  let attached = false;
  const attach = (on: boolean): void => {
    if (decals === null || on === attached) return;
    attached = on;
    attachProjectedDecals(o.scene, on ? decals : null);
  };

  const rebuild = (renderer: THREE.Renderer): void => {
    const t0 = performance.now();
    const live: { e: Entry; s: DecalSource }[] = [];
    for (const e of entries.values()) {
      e.row = -1;
      const s = liveSource(e);
      if (s !== null) live.push({ e, s });
    }
    freeRows.length = 0;
    // Pages: the build's (an image with a layer is on a page array) or this view's own.
    const paged = live.filter(({ s }) => [s.images.albedo, s.images.normal, s.images.orm].some((i) => i !== null && i.layer !== null));
    const arrays: Record<DecalPageSetName, THREE.Texture | null> = { albedo: null, normal: null, orm: null };
    let side = 1;
    places = new Map();
    if (paged.length > 0 || live.every(({ s }) => s.images.albedo === null && s.images.normal === null && s.images.orm === null && s.images.emissive === null)) {
      for (const { s } of live) {
        if (places.has(s)) continue;
        const imgs = [s.images.albedo, s.images.normal, s.images.orm] as const;
        let ok = true;
        const layers = imgs.map((img, k) => {
          if (img === null) return -1;
          const set = SETS[k]!;
          if (img.layer === null) ok = false;
          else if (arrays[set] === null) arrays[set] = img.texture;
          else if (arrays[set] !== img.texture) ok = false;
          return img.layer ?? -1;
        }) as [number, number, number];
        places.set(s, ok ? { layers, rect: s.place.rect, footprint: s.place.mip === null ? 1e9 : 2 ** s.place.mip } : null);
        if (ok) side = Math.max(side, s.place.size[0]);
      }
      view?.dispose();
      view = null;
    } else {
      view ??= createDecalViewPages();
      const layersOf = view.update(renderer, new Set(live.map(({ s }) => s)));
      const h = 0.5 / DECAL_VIEW_PAGE_SIZE;
      for (const { s } of live) places.set(s, { layers: layersOf.get(s) ?? [-1, -1, -1], rect: [h, h, 1 - h, 1 - h], footprint: 1e9 });
      for (const set of SETS) arrays[set] = view.arrays[set];
      side = DECAL_VIEW_PAGE_SIZE;
    }
    const placed = live.filter(({ s }) => places.get(s) !== null);
    unplaced = live.length - placed.length;
    drawn = placed.length;
    if (placed.length === 0) {
      attach(false);
      grid.build([]);
      rowCap = 0;
      nextRow = 0;
    } else {
      decals ??= new ProjectedDecals();
      attach(true);
      // Rows for every decal and as many again (spawns and new decals go in without a build).
      rowCap = Math.max(ROWS_MIN, pow2(placed.length * 2));
      const rows: DecalRow[] = [];
      placed.forEach(({ e, s }, i) => {
        e.row = i;
        rows.push(rowOf(e, s, places.get(s)!));
      });
      nextRow = placed.length;
      grid.build(rows, placed.map(({ e }) => e.seq));
      grid.takeDirty();
      tableLines = Math.ceil((rowCap * DECAL_ROW_TEXELS) / DECAL_TEXTURE_WIDTH);
      const lines = tableLines + grid.height;
      // Made again only when it must grow (three sizes a texture once); else its data is written over.
      let tex = decals.data;
      if (tex.image.height < lines) tex = decalDataTexture(new Float32Array(lines * DECAL_TEXTURE_WIDTH * 4), lines);
      const data = tex.image.data as Float32Array;
      data.fill(0);
      rows.forEach((r, i) => packDecalRow(data, i, r));
      data.set(grid.data, tableLines * DECAL_TEXTURE_WIDTH * 4);
      tex.needsUpdate = true;
      if (tex !== decals.data) {
        const old = decals.data;
        decals.setData(tex);
        old.dispose();
      }
      for (const set of SETS) decals.setPages(set, arrays[set]);
      decals.setBoxes(rows);
      uses = 0;
      for (const r of rows) uses |= usesOf(r);
      decals.setUses(uses);
      decals.origin.set(grid.origin[0], grid.origin[1], grid.origin[2], grid.mask);
      decals.invCell.set(1 / grid.cell[0], 1 / grid.cell[1], 1 / grid.cell[2], grid.probes);
      decals.layout.set(tableLines * DECAL_TEXTURE_WIDTH, side, 0, 0);
    }
    touched.clear();
    pending = false;
    builds += 1;
    buildMs = performance.now() - t0;
  };

  /** Apply the decals touched since the last frame in place; false: a whole build is needed. */
  const applyTouched = (): boolean => {
    if (decals === null) return touched.size === 0 || [...touched].every((e) => !entries.has(e.id) || liveSource(e) === null);
    for (const e of touched) {
      if (!entries.has(e.id)) continue;
      const s = liveSource(e);
      if (s === null) {
        if (e.row >= 0) drawn -= 1;
        releaseRow(e);
        continue;
      }
      const place = places.get(s);
      // A material not placed by the last build (or one it could not place): build again.
      if (place === undefined || place === null) return false;
      if (e.row < 0) {
        const row = freeRows.pop() ?? (nextRow < rowCap ? nextRow++ : -1);
        if (row < 0) return false;
        e.row = row;
        drawn += 1;
      }
      if (!writeRow(e, s, place)) return false;
    }
    // A removal above asked for a build.
    if (dirty) return false;
    decals.setUses(uses);
    return true;
  };

  /** Take a spawned or entity decal out at once (no fade). */
  const drop = (e: Entry): void => {
    if (!entries.delete(e.id)) return;
    if (e.row >= 0) drawn -= 1;
    releaseRow(e);
    touched.delete(e);
    o.materialOf(holder(e.id), null);
    if (e.spawn !== null) {
      o.holdPages?.(holder(e.id), null);
      spawns.delete(e);
      const at = spawnOrder.indexOf(e);
      if (at >= 0) spawnOrder.splice(at, 1);
    }
  };

  const startFade = (e: Entry, length: number): void => {
    const s = e.spawn;
    if (s === null || s.fading !== null) return;
    s.fading = 0;
    s.fadeLength = Math.max(1e-3, length);
    const at = spawnOrder.indexOf(e);
    if (at >= 0) spawnOrder.splice(at, 1);
  };

  const spawn = (req: DecalRequestLike, objectOf: ((id: string) => THREE.Object3D | null) | undefined): void => {
    if (req.decal === null || (req.decal.mode !== undefined && req.decal.mode !== 'projected')) return;
    const parent = req.entityId === null ? null : (objectOf?.(req.entityId) ?? null);
    // On an object that is not here (unloaded, never loaded): nothing to stick to.
    if (req.entityId !== null && parent === null) return;
    const id = `#${req.handle}`;
    const p = req.position;
    const q = req.rotation;
    const local = new THREE.Matrix4().compose(new THREE.Vector3(num(p[0], 0), num(p[1], 0), num(p[2], 0)), new THREE.Quaternion(num(q[0], 0), num(q[1], 0), num(q[2], 0), num(q[3], 1)).normalize(), new THREE.Vector3(1, 1, 1));
    const node = new THREE.Object3D();
    node.matrixAutoUpdate = false;
    node.matrixWorldAutoUpdate = false;
    const e: Entry = {
      id,
      node,
      decal: req.decal,
      material: o.materialOf(holder(id), req.decal.material),
      seen: new Float64Array(16).fill(NaN),
      row: -1,
      alpha: 1,
      seq: seq++,
      spawn: { handle: req.handle, parent, parentId: req.entityId, local, age: 0, lifetime: Math.max(0, num(req.lifetime, 0)), fading: null, fadeLength: DECAL_TRANSIENT_FADE_SECONDS },
    };
    // In world space it stays where it was left: placed once (one on an object follows it as the frames age it).
    if (parent === null) node.matrixWorld.copy(local);
    o.holdPages?.(holder(id), req.decal.material);
    entries.set(id, e);
    spawns.add(e);
    spawnOrder.push(e);
    touched.add(e);
    // Past the budget the oldest give way, fading out.
    while (spawnOrder.length > DECAL_TRANSIENT_BUDGET) startFade(spawnOrder[0]!, DECAL_TRANSIENT_FADE_SECONDS);
  };

  const request = (req: DecalRequestLike, objectOf: ((id: string) => THREE.Object3D | null) | undefined): void => {
    if (req.op === 'spawn') spawn(req, objectOf);
    else if (req.op === 'clear') {
      for (const e of spawns) drop(e);
    } else {
      for (const e of spawns) {
        const s = e.spawn!;
        if (req.handle > 0 ? s.handle === req.handle : s.parentId === req.entityId) startFade(e, DECAL_TRANSIENT_FADE_SECONDS);
      }
    }
  };

  /** Age the spawned decals by `dt` seconds: their lifetimes, their fades, the objects they stick to. */
  const age = (dt: number, objectOf: ((id: string) => THREE.Object3D | null) | undefined): void => {
    for (const e of spawns) {
      const s = e.spawn!;
      // The object it sticks to left the scene: it goes with it.
      if (s.parentId !== null && objectOf !== undefined && objectOf(s.parentId) !== s.parent) {
        drop(e);
        continue;
      }
      s.age += dt;
      if (s.lifetime > 0 && s.fading === null && s.age >= s.lifetime - Math.min(DECAL_TRANSIENT_FADE_SECONDS, s.lifetime)) startFade(e, Math.min(DECAL_TRANSIENT_FADE_SECONDS, s.lifetime));
      if (s.fading !== null) {
        s.fading += dt;
        const alpha = Math.max(0, 1 - s.fading / s.fadeLength);
        if (alpha <= 0) {
          drop(e);
          continue;
        }
        if (alpha !== e.alpha) {
          e.alpha = alpha;
          touched.add(e);
        }
      }
      if (s.parent !== null) {
        s.parent.updateWorldMatrix(true, false);
        e.node.matrixWorld.multiplyMatrices(s.parent.matrixWorld, s.local);
      }
    }
  };

  const api: DecalProjectors = {
    set(entityId, node, decal) {
      if (decal === null || (decal.mode !== undefined && decal.mode !== 'projected')) {
        api.remove(entityId);
        return;
      }
      const known = entries.get(entityId);
      if (known !== undefined && known.node === node && known.decal === decal) return;
      const material = o.materialOf(holder(entityId), decal.material);
      if (known !== undefined) {
        // The same decal changed (a field, its node): its row is written again in place.
        known.node = node;
        known.decal = decal;
        known.material = material;
        known.seen.fill(NaN);
        touched.add(known);
      } else {
        const e: Entry = { id: entityId, node, decal, material, seen: new Float64Array(16).fill(NaN), row: -1, alpha: 1, seq: seq++, spawn: null };
        entries.set(entityId, e);
        touched.add(e);
      }
      o.onChange?.();
    },
    remove(entityId) {
      const e = entries.get(entityId);
      // The decals spawned on it go with it.
      for (const s of spawns) if (s.spawn!.parentId === entityId) drop(s);
      if (e === undefined) return;
      drop(e);
      o.onChange?.();
    },
    refresh() {
      for (const [id, e] of entries) e.material = o.materialOf(holder(id), e.decal.material);
      dirty = true;
    },
    beforeFrame(renderer, requests, objectOf, paused) {
      const t0 = performance.now();
      const clock = now();
      if (decals !== null) {
        receiverDraws = decals.draws;
        decals.draws = 0;
      }
      for (const r of requests ?? []) request(r, objectOf);
      const dt = lastNow === null || paused === true ? 0 : Math.min(AGE_STEP_MAX, (clock - lastNow) / 1000);
      lastNow = clock;
      if (spawns.size > 0) age(dt, objectOf);
      if (entries.size === 0 && decals === null) return;
      // A moved decal, or a source whose images arrived or changed.
      materialsNow.clear();
      for (const e of entries.values()) {
        // Before the draw updates the scene's matrices: a decal moved this frame is indexed where it is drawn.
        if (e.spawn === null) e.node.updateWorldMatrix(true, false);
        const w = e.node.matrixWorld.elements;
        for (let k = 0; k < 16; k++) {
          if (e.seen[k] !== w[k]) {
            e.seen.set(w);
            touched.add(e);
            break;
          }
        }
        if (e.material !== null) materialsNow.add(e.material);
      }
      // The few materials in use, not each decal: their images arrive or change.
      let sources = '';
      for (const m of materialsNow) sources += sourceKey(decalSourceOf(m));
      if (sources !== sourcesSeen) {
        sourcesSeen = sources;
        dirty = true;
      }
      if (!dirty && touched.size === 0 && !pending) return;
      if (!dirty && applyTouched()) {
        flush();
        attach(drawn > 0);
        touched.clear();
        pending = false;
        updates += 1;
        updateMs = performance.now() - t0;
      } else {
        dirty = false;
        rebuild(renderer);
      }
      if (!overlapReported && grid.dropped > 0) {
        overlapReported = true;
        o.onProblem?.('decal_overlap', `${grid.droppedDecals} projected decal(s) left out where more than ${DECAL_CELL_BUDGET} overlap (the overlap budget): the lowest sort orders are not drawn there; spread them out or raise the sort order of the ones that matter`);
      }
    },
    observe() {
      const dataBytes = decals === null ? 0 : decals.data.image.data!.byteLength;
      let fading = 0;
      for (const e of spawns) if (e.spawn!.fading !== null) fading += 1;
      const spawned = spawns.size;
      return { decals: entries.size, drawn, unplaced, cells: grid.cellCount, entries: grid.entries, dropped: grid.dropped, builds, buildMs, updates, updateMs, spawned, fading, dataBytes, viewPageBytes: view?.bytes() ?? 0, receiverDraws };
    },
    dispose() {
      for (const e of [...entries.values()]) drop(e);
      entries.clear();
      attach(false);
      decals?.dispose();
      decals = null;
      view?.dispose();
      view = null;
      delete o.scene.userData[PROJECTED_DECALS_KEY];
    },
  };
  o.scene.userData[PROJECTED_DECALS_KEY] = { diagnostics: () => api.observe() };
  return api;
}
