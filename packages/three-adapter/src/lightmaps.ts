/**
 * Phase 9.6: lightmaps at runtime (Play, export and the editor view).
 *
 * - `addBoxLightmapUv`: boxes get a UV1 lightmap layout (the six faces in a
 *   3 × 2 grid with a margin) — the same one the bakers use.
 * - `applyLightmap`: an entity's meshes that have UV1 get a material clone
 *   with the atlas as `lightMap` (channel 1, the entry's scale/offset as the
 *   texture transform, intensity = the bake's `range`). When the bake holds
 *   the ambient/hemisphere lights, the clone ignores them (no double light).
 * - `createLightmapSet`: the bakes of a project — which entity has which
 *   atlas rectangle, which lights are baked, the atlas textures (loaded once).
 *
 * Phase 17.4: the copy is always a node material (every view draws with
 * `WebGPURenderer`) and the no-ambient hook is `withoutAmbientLight`; the
 * `onBeforeCompile` version is archived (`archive/webgl-renderer-17/`).
 *
 * Pure three.js (textures come from the caller).
 */
import * as THREE from 'three';
import { materialLightMap, uniform } from 'three/tsl';
import { IrradianceNode } from 'three/webgpu';

import { copyMaterialKeepingHooks, isNodeMaterial, toNodeMaterial, withoutAmbientLight } from './node-materials';

/** A bake as the manifest carries it (project-model `LightingBake`, structurally). */
export interface LightingBakeLike {
  readonly range: number;
  readonly atlases: readonly string[];
  readonly entries: readonly { readonly entityId: string; readonly chunk?: readonly number[]; readonly layout?: string; readonly atlas: number; readonly scaleOffset: readonly [number, number, number, number] | readonly number[] }[];
  readonly bakedLights: readonly string[];
}

const BOX_MARGIN = 0.04;

/**
 * UV1 for a `THREE.BoxGeometry` (one segment per side: 6 faces × 4 vertices
 * in the order +x, −x, +y, −y, +z, −z): face i fills the cell (i % 3, i / 3)
 * of a 3 × 2 grid, inset by a margin so faces never bleed into each other.
 */
export function addBoxLightmapUv(geometry: THREE.BufferGeometry): void {
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (uv === undefined) return;
  const count = uv.count;
  const out = new Float32Array(count * 2);
  const perFace = count / 6;
  for (let i = 0; i < count; i++) {
    const face = Math.min(5, Math.floor(i / perFace));
    const col = face % 3;
    const row = Math.floor(face / 3);
    out[i * 2] = (col + BOX_MARGIN + uv.getX(i) * (1 - 2 * BOX_MARGIN)) / 3;
    out[i * 2 + 1] = (row + BOX_MARGIN + uv.getY(i) * (1 - 2 * BOX_MARGIN)) / 2;
  }
  geometry.setAttribute('uv1', new THREE.BufferAttribute(out, 2));
}

/** Lightmap texels per meter → the texel size of a box's lightmap (its faces share a 3 × 2 grid). */
export function boxLightmapSize(size: readonly [number, number, number] | readonly number[], scale: readonly number[], texelsPerMeter: number): { width: number; height: number } {
  const sx = Math.abs((size[0] ?? 1) * (scale[0] ?? 1));
  const sy = Math.abs((size[1] ?? 1) * (scale[1] ?? 1));
  const sz = Math.abs((size[2] ?? 1) * (scale[2] ?? 1));
  const cell = Math.max(sx, sy, sz) * texelsPerMeter;
  return { width: Math.ceil(cell * 3), height: Math.ceil(cell * 2) };
}

/** The atlas as one entity's lightmap (UV1 → its rectangle; sRGB; channel 1). */
export function lightmapTexture(atlas: THREE.Texture, scaleOffset: readonly number[]): THREE.Texture {
  const map = atlas.clone();
  map.channel = 1;
  map.colorSpace = THREE.SRGBColorSpace;
  map.flipY = false;
  map.repeat.set(scaleOffset[0] ?? 1, scaleOffset[1] ?? 1);
  map.offset.set(scaleOffset[2] ?? 0, scaleOffset[3] ?? 0);
  // Side-view cameras see the ground at a shallow angle: without anisotropic
  // filtering the mipmaps average shadows away (three clamps to the GPU's maximum).
  map.anisotropy = 16;
  map.needsUpdate = true;
  return map;
}

type LightmapCapable = THREE.Material & { lightMap?: THREE.Texture | null; lightMapIntensity?: number };

/**
 * Phase 23.18: a tint on the baked light (a colour uniform shared by a set's
 * copies: an environment preset changes it per frame without new programs).
 * The hook replaces the material's lightmap term with lightMap × intensity × tint.
 */
function withLightmapTint(material: THREE.Material, tint: { value: THREE.Color }): void {
  const m = material as THREE.Material & { setupLightMap: (builder: unknown) => unknown };
  const baseKey = m.customProgramCacheKey;
  m.setupLightMap = function setupTintedLightMap(builder: unknown) {
    return (builder as { material: LightmapCapable }).material.lightMap ? new IrradianceNode((materialLightMap as any).mul(tint)) : null;
  };
  m.customProgramCacheKey = function cacheKeyTintedLightmap() {
    return `${baseKey.call(this)}|tl-lightmap-tint`;
  };
}

/**
 * A node-material copy of `material` with the lightmap (a plain source is
 * converted; a node source is copied with its own hooks). Null when the
 * material has no lightmap support.
 */
export function lightmappedMaterial(material: THREE.Material, map: THREE.Texture, range: number, ignoreAmbient: boolean, tint?: { value: THREE.Color }): THREE.Material | null {
  if (!('lightMap' in material)) return null;
  const converted = toNodeMaterial(material);
  if (converted === null || !isNodeMaterial(converted)) return null;
  const c = converted as LightmapCapable;
  c.lightMap = map;
  c.lightMapIntensity = range;
  // Phase 23.18: the bake's range, which an environment preset's lightmap intensity multiplies.
  c.userData['lightmapRange'] = range;
  if (tint !== undefined) withLightmapTint(c, tint);
  if (ignoreAmbient) withoutAmbientLight(c);
  c.needsUpdate = true;
  return c;
}

/** Bring a lightmapped copy up to date with its source (colours edited in place). */
export function refreshLightmappedMaterial(copy: THREE.Material, source: THREE.Material): void {
  const c = copy as LightmapCapable;
  const map = c.lightMap ?? null;
  const intensity = c.lightMapIntensity ?? 1;
  const bakeRange = c.userData['lightmapRange'] as unknown;
  // NodeMaterial.copy copies INTO an object-valued property it already holds
  // (`this.map.copy(source.map)`): that throws for a texture the source lacks
  // (the lightmap) and would overwrite a texture shared with other materials.
  // Emptied first, every texture is taken over by reference.
  const slots = c as unknown as Record<string, unknown>;
  for (const k of Object.keys(slots)) if ((slots[k] as { isTexture?: boolean } | null)?.isTexture === true) slots[k] = null;
  copyMaterialKeepingHooks(c, source);
  c.lightMap = map;
  c.lightMapIntensity = intensity;
  if (bakeRange !== undefined) c.userData['lightmapRange'] = bakeRange;
}

/**
 * Put a lightmap on every mesh under `root` that has UV1. Returns the undo
 * (restores the original materials and frees the copies).
 */
export function applyLightmap(
  root: THREE.Object3D,
  atlas: THREE.Texture,
  scaleOffset: readonly number[],
  range: number,
  options: { ignoreAmbient?: boolean } = {},
): () => void {
  return applyLightmapTracked(root, atlas, scaleOffset, range, options).undo;
}

/**
 * `applyLightmap` that also returns `refresh`: bring every copy up to date
 * with its source material (phase 17.3: a project material's texture that
 * arrives after the copy was made — the copy is a clone and would stay
 * without it).
 */
export function applyLightmapTracked(
  root: THREE.Object3D,
  atlas: THREE.Texture,
  scaleOffset: readonly number[],
  range: number,
  options: { ignoreAmbient?: boolean; tint?: { value: THREE.Color }; intensity?: number } = {},
): { undo: () => void; refresh: () => void; copies: readonly THREE.Material[] } {
  const map = lightmapTexture(atlas, scaleOffset);
  const restores: (() => void)[] = [];
  const pairs: [THREE.Material, THREE.Material][] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh !== true || mesh.geometry.getAttribute('uv1') === undefined) return;
    const original = mesh.material;
    const list = Array.isArray(original) ? original : [original];
    const copies = list.map((m) => lightmappedMaterial(m, map, range, options.ignoreAmbient === true, options.tint));
    if (options.intensity !== undefined) for (const c of copies) if (c !== null) (c as LightmapCapable).lightMapIntensity = range * options.intensity;
    if (copies.every((c) => c === null)) return;
    copies.forEach((c, i) => {
      if (c !== null) pairs.push([c, list[i]!]);
    });
    const next = copies.map((c, i) => c ?? list[i]!);
    mesh.material = Array.isArray(original) ? next : next[0]!;
    restores.push(() => {
      mesh.material = original;
      for (const c of copies) c?.dispose();
    });
  });
  return {
    copies: pairs.map(([c]) => c),
    undo: () => {
      for (const r of restores) r();
      map.dispose();
    },
    refresh: () => {
      for (const [copy, source] of pairs) {
        refreshLightmappedMaterial(copy, source);
        copy.needsUpdate = true;
      }
    },
  };
}

export interface LightmapSet {
  /** True when a bake holds this light in full (it is not realtime). */
  isBakedLight(entityId: string): boolean;
  /** True when some bake has a lightmap for this entity. */
  has(entityId: string): boolean;
  /** Apply the entity's lightmap to `root` once its atlas is loaded (replaces an earlier one). */
  apply(entityId: string, root: THREE.Object3D): void;
  /** Take the entity's lightmap off again. */
  release(entityId: string): void;
  /** Whether some bake has lightmaps for chunks of this block layer (its chunks then need lightmap UVs). */
  hasChunks(entityId: string): boolean;
  /** Apply a block-layer chunk's lightmap to `root` when the bake has one for this chunk made with this layout. */
  applyChunk(entityId: string, cx: number, cz: number, layout: string, root: THREE.Object3D): void;
  /** Take a chunk's lightmap off again. */
  releaseChunk(entityId: string, cx: number, cz: number): void;
  /**
   * Phase 23.18: multiply the baked light by `intensity` and tint it (an
   * environment preset's `lightmap`; 1 and white leave the bake as it is).
   * A bake holds the light of the moment it was baked: without this, a preset
   * that darkens the realtime lights leaves baked surfaces as bright as before.
   */
  setLook(intensity: number, tint: string): void;
  /**
   * Phase 17.3: bring the lightmapped copies up to date with their source
   * materials (call when a project material changed in place, e.g. its
   * texture arrived after the copy was made).
   */
  refresh(): void;
  dispose(): void;
}

/**
 * The project's bakes. `ambientBaked(lightIds)` answers whether a bake's
 * baked lights include an ambient or hemisphere light (the caller knows the
 * light types).
 */
export function createLightmapSet(
  bakes: Readonly<Record<string, LightingBakeLike>>,
  loadTexture: (assetId: string) => Promise<THREE.Texture | null>,
  ambientBaked: (lightIds: readonly string[]) => boolean,
): LightmapSet {
  // Entities by id; block-layer chunks by `<layer>#<cx>,<cz>` (never a valid entity id).
  const entries = new Map<string, { bake: LightingBakeLike; atlas: string; scaleOffset: readonly number[]; layout?: string }>();
  const chunkLayers = new Set<string>();
  const chunkKey = (entityId: string, cx: number, cz: number): string => `${entityId}#${cx},${cz}`;
  const bakedLights = new Set<string>();
  for (const bake of Object.values(bakes)) {
    for (const id of bake.bakedLights) bakedLights.add(id);
    for (const e of bake.entries) {
      const atlas = bake.atlases[e.atlas];
      if (atlas === undefined) continue;
      if (e.chunk !== undefined && e.layout !== undefined) {
        chunkLayers.add(e.entityId);
        entries.set(chunkKey(e.entityId, e.chunk[0]!, e.chunk[1]!), { bake, atlas, scaleOffset: e.scaleOffset, layout: e.layout });
      } else entries.set(e.entityId, { bake, atlas, scaleOffset: e.scaleOffset });
    }
  }
  const textures = new Map<string, Promise<THREE.Texture | null>>();
  const undo = new Map<string, () => void>();
  const refreshers = new Map<string, () => void>();
  /** Phase 23.18: the lightmapped copies per entity, the look multiplier and its shared tint uniform. */
  const copiesOf = new Map<string, readonly THREE.Material[]>();
  let lookIntensity = 1;
  const tint = uniform(new THREE.Color(1, 1, 1)) as unknown as { value: THREE.Color };
  const pending = new Map<string, number>();
  let generation = 0;
  let disposed = false;
  const texture = (assetId: string): Promise<THREE.Texture | null> => {
    let t = textures.get(assetId);
    if (t === undefined) {
      t = loadTexture(assetId).catch(() => null);
      textures.set(assetId, t);
    }
    return t;
  };
  const release = (entityId: string): void => {
    pending.delete(entityId);
    undo.get(entityId)?.();
    undo.delete(entityId);
    refreshers.delete(entityId);
    copiesOf.delete(entityId);
  };
  const set: LightmapSet = {
    isBakedLight: (id) => bakedLights.has(id),
    has: (id) => entries.has(id),
    hasChunks: (id) => chunkLayers.has(id),
    applyChunk(entityId, cx, cz, layout, root) {
      const key = chunkKey(entityId, cx, cz);
      if (entries.get(key)?.layout !== layout) {
        release(key);
        return;
      }
      set.apply(key, root);
    },
    releaseChunk: (entityId, cx, cz) => release(chunkKey(entityId, cx, cz)),
    apply(entityId, root) {
      const entry = entries.get(entityId);
      if (entry === undefined || disposed) return;
      release(entityId);
      const ticket = ++generation;
      pending.set(entityId, ticket);
      void texture(entry.atlas).then((tex) => {
        if (disposed || tex === null || pending.get(entityId) !== ticket) return;
        pending.delete(entityId);
        const applied = applyLightmapTracked(root, tex, entry.scaleOffset, entry.bake.range, { ignoreAmbient: ambientBaked(entry.bake.bakedLights), tint, intensity: lookIntensity });
        undo.set(entityId, applied.undo);
        refreshers.set(entityId, applied.refresh);
        copiesOf.set(entityId, applied.copies);
      });
    },
    release,
    setLook(intensity, tintColor) {
      tint.value.set(tintColor);
      if (intensity === lookIntensity) return;
      lookIntensity = intensity;
      for (const list of copiesOf.values()) for (const c of list) (c as LightmapCapable).lightMapIntensity = ((c.userData['lightmapRange'] as number | undefined) ?? 1) * intensity;
    },
    refresh() {
      for (const r of refreshers.values()) r();
    },
    dispose() {
      disposed = true;
      for (const id of [...undo.keys()]) release(id);
      for (const t of textures.values()) void t.then((x) => x?.dispose());
      textures.clear();
    },
  };
  return set;
}
