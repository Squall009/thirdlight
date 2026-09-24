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
 * Browser-only (WebGL textures); pure three.js otherwise.
 */
import * as THREE from 'three';

/** A bake as the manifest carries it (project-model `LightingBake`, structurally). */
export interface LightingBakeLike {
  readonly range: number;
  readonly atlases: readonly string[];
  readonly entries: readonly { readonly entityId: string; readonly atlas: number; readonly scaleOffset: readonly [number, number, number, number] | readonly number[] }[];
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

const NO_AMBIENT_KEY = 'tl-lightmap-no-ambient';

function withoutAmbient(material: THREE.Material): void {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_begin>',
      THREE.ShaderChunk.lights_fragment_begin
        .replace('vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );', 'vec3 irradiance = vec3( 0.0 );')
        .replace('irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );', ''),
    );
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}|${NO_AMBIENT_KEY}`;
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
 * A copy of `material` with the lightmap. `Material.clone()` drops an
 * instance's shader hooks (the project shaders live there), so they are
 * carried over. Null when the material has no lightmap support.
 */
export function lightmappedMaterial(material: THREE.Material, map: THREE.Texture, range: number, ignoreAmbient: boolean): THREE.Material | null {
  if (!('lightMap' in material)) return null;
  const c = material.clone() as LightmapCapable;
  c.onBeforeCompile = material.onBeforeCompile;
  c.customProgramCacheKey = material.customProgramCacheKey;
  c.lightMap = map;
  c.lightMapIntensity = range;
  if (ignoreAmbient) withoutAmbient(c);
  c.needsUpdate = true;
  return c;
}

/** Bring a lightmapped copy up to date with its source (colours edited in place). */
export function refreshLightmappedMaterial(copy: THREE.Material, source: THREE.Material): void {
  const c = copy as LightmapCapable;
  const map = c.lightMap ?? null;
  const intensity = c.lightMapIntensity ?? 1;
  const hook = c.onBeforeCompile;
  const key = c.customProgramCacheKey;
  c.copy(source);
  c.lightMap = map;
  c.lightMapIntensity = intensity;
  c.onBeforeCompile = hook;
  c.customProgramCacheKey = key;
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
  const map = lightmapTexture(atlas, scaleOffset);
  const restores: (() => void)[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh !== true || mesh.geometry.getAttribute('uv1') === undefined) return;
    const original = mesh.material;
    const list = Array.isArray(original) ? original : [original];
    const copies = list.map((m) => lightmappedMaterial(m, map, range, options.ignoreAmbient === true));
    if (copies.every((c) => c === null)) return;
    const next = copies.map((c, i) => c ?? list[i]!);
    mesh.material = Array.isArray(original) ? next : next[0]!;
    restores.push(() => {
      mesh.material = original;
      for (const c of copies) c?.dispose();
    });
  });
  return () => {
    for (const r of restores) r();
    map.dispose();
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
  const entries = new Map<string, { bake: LightingBakeLike; atlas: string; scaleOffset: readonly number[] }>();
  const bakedLights = new Set<string>();
  for (const bake of Object.values(bakes)) {
    for (const id of bake.bakedLights) bakedLights.add(id);
    for (const e of bake.entries) {
      const atlas = bake.atlases[e.atlas];
      if (atlas !== undefined) entries.set(e.entityId, { bake, atlas, scaleOffset: e.scaleOffset });
    }
  }
  const textures = new Map<string, Promise<THREE.Texture | null>>();
  const undo = new Map<string, () => void>();
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
  };
  return {
    isBakedLight: (id) => bakedLights.has(id),
    has: (id) => entries.has(id),
    apply(entityId, root) {
      const entry = entries.get(entityId);
      if (entry === undefined || disposed) return;
      release(entityId);
      const ticket = ++generation;
      pending.set(entityId, ticket);
      void texture(entry.atlas).then((tex) => {
        if (disposed || tex === null || pending.get(entityId) !== ticket) return;
        pending.delete(entityId);
        undo.set(entityId, applyLightmap(root, tex, entry.scaleOffset, entry.bake.range, { ignoreAmbient: ambientBaked(entry.bake.bakedLights) }));
      });
    },
    release,
    dispose() {
      disposed = true;
      for (const id of [...undo.keys()]) release(id);
      for (const t of textures.values()) void t.then((x) => x?.dispose());
      textures.clear();
    },
  };
}
