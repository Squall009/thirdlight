/**
 * The projected decals of a scene adapter: each loaded decal entity in
 * `projected` mode, its world box, and its material's images and factors,
 * kept as the table and the world-grid index the receiving materials read
 * (decal-index.ts, projected-decals.ts), attached to the scene only while
 * a decal can mark something.
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
 * The table and the index are built again when a decal is added, removed,
 * changed or moved, or its images arrive; a still frame compares the decals'
 * world matrices and their sources, nothing more.
 */
import * as THREE from 'three/webgpu';
import { DECAL_CELL_BUDGET, DECAL_DEFAULTS, DECAL_LAYERS_ALL, DECAL_LIMITS, decalLayersOf } from '@thirdlight/runtime';

import { buildDecalIndex, DECAL_TEXTURE_WIDTH, EMPTY_DECAL_INDEX, packDecalTable, type DecalIndex, type DecalRow } from './decal-index';
import { createDecalViewPages, DECAL_VIEW_PAGE_SIZE, type DecalViewLayers, type DecalViewPages } from './decal-view-pages';
import { decalSourceOf, type DecalSource } from './material-library';
import { attachProjectedDecals, DECAL_LAYER_TEST_BIT, decalDataTexture, ProjectedDecals, type DecalPageSetName } from './projected-decals';

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

/** What the decals cost and hold (diagnostics `renderer.projectedDecals`). */
export interface DecalProjectorsObservation {
  /** Projected decals loaded, and of them those drawn (their images here, their arrays bound). */
  readonly decals: number;
  readonly drawn: number;
  /** Not drawn: an image on an array other than its set's. */
  readonly unplaced: number;
  /** The index: cells, entries, entries dropped over the overlap budget; when it was last built and how long that took (ms). */
  readonly cells: number;
  readonly entries: number;
  readonly dropped: number;
  readonly builds: number;
  readonly buildMs: number;
  /** The table and index textures' bytes, and the view pages' (a view without the build's pages). */
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
  remove(entityId: string): void;
  /** The materials changed: every decal takes its material again. */
  refresh(): void;
  /** Before a frame: rebuild what changed, draw view pages, attach the decals to the scene or detach them. */
  beforeFrame(renderer: THREE.Renderer): void;
  observe(): DecalProjectorsObservation;
  dispose(): void;
}

interface Entry {
  node: THREE.Object3D;
  decal: ProjectedDecalLike;
  material: THREE.Material | null;
  /** The world matrix the table holds. */
  seen: Float64Array;
}

const SETS: readonly DecalPageSetName[] = ['albedo', 'normal', 'orm'];
const RAD = Math.PI / 180;
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** A material colour's linear components (three keeps colours linear). */
const rgb = (c: unknown): [number, number, number] => {
  const col = c as THREE.Color | undefined;
  return col?.isColor === true ? [col.r, col.g, col.b] : [1, 1, 1];
};

export function createDecalProjectors(o: {
  readonly scene: THREE.Scene;
  /** The library's projected-decal hold (`MaterialLibrary.projectedDecal`). */
  readonly materialOf: (holder: string, materialId: string | null) => THREE.Material | null;
  readonly onChange?: () => void;
}): DecalProjectors {
  const entries = new Map<string, Entry>();
  let decals: ProjectedDecals | null = null;
  let view: DecalViewPages | null = null;
  let dirty = true;
  let index: DecalIndex = EMPTY_DECAL_INDEX;
  let drawn = 0;
  let unplaced = 0;
  let builds = 0;
  let buildMs = 0;
  let receiverDraws = 0;
  /** What each decal's sources looked like at the last build (an image arriving changes it). */
  let sourcesSeen = '';
  const materialsNow = new Set<THREE.Material>();
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

  const rowOf = (e: Entry, s: DecalSource, place: { layers: DecalViewLayers | readonly [number, number, number]; rect: readonly [number, number, number, number]; footprint: number }): DecalRow => {
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
    const fade = Math.min(DECAL_LIMITS.normalFadeMax, Math.max(DECAL_LIMITS.normalFadeMin, num(d.normalFade, DECAL_DEFAULTS.normalFade)));
    const m = e.material as (THREE.Material & { color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number; roughness?: number; metalness?: number; normalScale?: THREE.Vector2 }) | null;
    const glow = rgb(m?.emissive);
    const gi = num(m?.emissiveIntensity, 0);
    const scale = Math.abs(num(m?.normalScale?.x, 1));
    const hasNormal = place.layers[1] >= 0;
    const hasOrm = place.layers[2] >= 0;
    return {
      worldToBox,
      min,
      max,
      rect: place.rect,
      layers: [place.layers[0], place.layers[1], place.layers[2]],
      footprint: place.footprint,
      opacity: [
        num(op.albedo, 1),
        // A channel the decal has no image (or set value) for is left alone (a stain does not flatten the normal map or the ORM under it).
        hasNormal ? num(op.normal, 1) : 0,
        hasOrm || s.params['roughness'] !== undefined ? num(op.roughness, 1) : 0,
        hasOrm || s.params['metalness'] !== undefined ? num(op.metalness, 1) : 0,
        hasOrm ? num(op.occlusion, 1) : 0,
        hasOrm && gi > 0 && Math.max(...glow) > 0 ? num(op.emission, 1) : 0,
      ],
      normalFadeCos: [Math.cos(fade * RAD), Math.cos(fade * 0.8 * RAD)],
      edgeFade: [num(d.edgeFade?.[0], DECAL_DEFAULTS.edgeFade[0]), num(d.edgeFade?.[1], DECAL_DEFAULTS.edgeFade[1])],
      fadeDistance: Math.max(0, num(d.fadeDistance, 0)),
      layerMask: decalLayersOf(d.layers) || DECAL_LAYERS_ALL,
      tint: [...rgb(m?.color), num(m?.opacity, 1)],
      emissive: [glow[0] * gi, glow[1] * gi, glow[2] * gi],
      aoIntensity: num(s.params['aoIntensity'], 1),
      roughness: num(m?.roughness, 1),
      metalness: num(m?.metalness, 0),
      normalScale: [scale, scale],
      sortOrder: Math.round(num(d.sortOrder, DECAL_DEFAULTS.sortOrder)),
    };
  };

  const rebuild = (renderer: THREE.Renderer): void => {
    const t0 = performance.now();
    const live: { e: Entry; s: DecalSource }[] = [];
    for (const e of entries.values()) {
      const s = decalSourceOf(e.material);
      // An albedo image on its way: nothing yet (not a rectangle of its tint).
      if (s === null || (s.images.albedo === null && s.images.albedoComing)) continue;
      live.push({ e, s });
    }
    // Pages: the build's (an image with a layer is on a page array) or this view's own.
    const paged = live.filter(({ s }) => [s.images.albedo, s.images.normal, s.images.orm].some((i) => i !== null && i.layer !== null));
    const rows: DecalRow[] = [];
    const arrays: Record<DecalPageSetName, THREE.Texture | null> = { albedo: null, normal: null, orm: null };
    let side = 1;
    unplaced = 0;
    if (paged.length > 0 || live.every(({ s }) => s.images.albedo === null && s.images.normal === null && s.images.orm === null && s.images.emissive === null)) {
      for (const { e, s } of live) {
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
        if (!ok) {
          unplaced += 1;
          continue;
        }
        side = Math.max(side, s.place.size[0]);
        rows.push(rowOf(e, s, { layers, rect: s.place.rect, footprint: s.place.mip === null ? 1e9 : 2 ** s.place.mip }));
      }
      view?.dispose();
      view = null;
    } else {
      view ??= createDecalViewPages();
      const layersOf = view.update(renderer, new Set(live.map(({ s }) => s)));
      const h = 0.5 / DECAL_VIEW_PAGE_SIZE;
      for (const { e, s } of live) rows.push(rowOf(e, s, { layers: layersOf.get(s) ?? [-1, -1, -1], rect: [h, h, 1 - h, 1 - h], footprint: 1e9 }));
      for (const set of SETS) arrays[set] = view.arrays[set];
      side = DECAL_VIEW_PAGE_SIZE;
    }
    drawn = rows.length;
    index = buildDecalIndex(rows, DECAL_CELL_BUDGET);
    if (rows.length === 0) {
      if (decals !== null) {
        attachProjectedDecals(o.scene, null);
        decals.dispose();
        decals = null;
      }
    } else {
      if (decals === null) {
        decals = new ProjectedDecals();
        attachProjectedDecals(o.scene, decals);
      }
      const table = packDecalTable(rows);
      // Data textures are made again when they grow (three sizes a texture once); else their data is replaced.
      const fit = (t: THREE.DataTexture, data: Float32Array, height: number): THREE.DataTexture => {
        if (t.image.height >= height) {
          const own = t.image.data as Float32Array;
          own.set(data.subarray(0, Math.min(data.length, own.length)));
          own.fill(0, data.length);
          t.needsUpdate = true;
          return t;
        }
        const grown = new Float32Array(2 ** Math.ceil(Math.log2(height)) * DECAL_TEXTURE_WIDTH * 4);
        grown.set(data);
        return decalDataTexture(grown, grown.length / (DECAL_TEXTURE_WIDTH * 4));
      };
      const oldTable = decals.table;
      const oldIndex = decals.index;
      const nextTable = fit(decals.table, table.data, table.height);
      const nextIndex = fit(decals.index, index.data, index.height);
      if (nextTable !== oldTable || nextIndex !== oldIndex) {
        decals.setData(nextTable, nextIndex);
        if (nextTable !== oldTable) oldTable.dispose();
        if (nextIndex !== oldIndex) oldIndex.dispose();
      }
      for (const set of SETS) decals.setPages(set, arrays[set]);
      decals.setBoxes(rows);
      // The channels any decal changes: the receivers' programs blend only those.
      let uses = 0;
      for (const r of rows) {
        r.opacity.forEach((v, k) => (uses |= v > 0 ? 1 << k : 0));
        if (r.layerMask !== DECAL_LAYERS_ALL) uses |= DECAL_LAYER_TEST_BIT;
      }
      decals.setUses(uses);
      decals.origin.set(index.origin[0], index.origin[1], index.origin[2], 0);
      decals.invCell.set(index.invCell[0], index.invCell[1], index.invCell[2], index.probes);
      decals.dims.set(index.dims[0], index.dims[1], index.dims[2], index.mask);
      decals.setPageSize(side);
    }
    builds += 1;
    buildMs = performance.now() - t0;
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
      entries.set(entityId, { node, decal, material, seen: new Float64Array(16).fill(NaN) });
      dirty = true;
      o.onChange?.();
    },
    remove(entityId) {
      if (!entries.delete(entityId)) return;
      o.materialOf(holder(entityId), null);
      dirty = true;
      o.onChange?.();
    },
    refresh() {
      for (const [id, e] of entries) e.material = o.materialOf(holder(id), e.decal.material);
      dirty = true;
    },
    beforeFrame(renderer) {
      if (decals !== null) {
        receiverDraws = decals.draws;
        decals.draws = 0;
      }
      if (entries.size === 0 && decals === null) return;
      // A moved decal, or a source whose images arrived or changed.
      materialsNow.clear();
      for (const e of entries.values()) {
        // Before the draw updates the scene's matrices: a decal moved this frame is indexed where it is drawn.
        e.node.updateWorldMatrix(true, false);
        const w = e.node.matrixWorld.elements;
        for (let k = 0; k < 16; k++) {
          if (e.seen[k] !== w[k]) {
            e.seen.set(w);
            dirty = true;
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
      if (!dirty) return;
      dirty = false;
      rebuild(renderer);
    },
    observe() {
      const dataBytes = decals === null ? 0 : decals.table.image.data!.byteLength + decals.index.image.data!.byteLength;
      return { decals: entries.size, drawn, unplaced, cells: index.cells, entries: index.entries, dropped: index.dropped, builds, buildMs, dataBytes, viewPageBytes: view?.bytes() ?? 0, receiverDraws };
    },
    dispose() {
      for (const id of [...entries.keys()]) o.materialOf(holder(id), null);
      entries.clear();
      if (decals !== null) {
        attachProjectedDecals(o.scene, null);
        decals.dispose();
        decals = null;
      }
      view?.dispose();
      view = null;
      delete o.scene.userData[PROJECTED_DECALS_KEY];
    },
  };
  o.scene.userData[PROJECTED_DECALS_KEY] = { diagnostics: () => api.observe() };
  return api;
}
