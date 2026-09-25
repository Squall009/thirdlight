/**
 * Phase 9.4: project materials at runtime (editor view, Play and export).
 *
 * A material definition is a shader type plus overrides. On a model it
 * starts from the file's own material (a copy keeps its textures) and
 * changes only what it sets; on a box it starts from the shader defaults.
 * The shader types extend three's standard node material with TSL nodes
 * (phase 17.2), so lighting, shadows and fog stay three's own:
 *
 * - foliage: COLOR_0 drives wind (R bend weight root→tip, G phase, B flutter,
 *   A thinness → a small translucency term). The vertex colour is read as data
 *   (`vertexColors` stays off). Double-sided without back-face normal flip.
 * - kit: UV0 is shifted by the object's world X / uvPeriod (per piece or
 *   instance, so the detail atlas flows across joins); a macro normal on UV1 is
 *   blended over the detail normal (whiteout). AO stays on its own UV set.
 * - water: a scrolling normal map and a fresnel mix of two colours.
 * - unlit: MeshBasicMaterial.
 *
 * Wind and time are one shared uniform block updated by `tick()`.
 *
 * Phase 18.3: a material with a `graph` is a graph material: its node graph
 * compiles to TSL (`material-graph.ts`) into one shared node material per
 * canonical digest (graph, parameters, the functions it calls — moving a
 * node never recompiles); the file's material is not used. Objects override
 * public parameters per drawn object (uniforms read `mesh.userData`), a
 * texture override gets its own compiled variant; shared materials never
 * change for one object (phase 9.4 rule).
 *
 * Phase 17.4: node materials only (every view draws with `WebGPURenderer`);
 * the `onBeforeCompile` twins of phases 9.4–17.3 are archived in
 * `archive/webgl-renderer-17/`. The pixel-parity e2e compares the node
 * materials with the reference images those twins drew.
 *
 * Pure three.js: textures come from an injected loader (the host resolves
 * bytes; nothing here fetches).
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { MeshBasicNodeMaterial, type MeshStandardNodeMaterial, type NodeBuilder } from 'three/webgpu';

import {
  applyGraphNodes,
  buildGraphMaterial,
  compileMaterialGraph,
  digestOf,
  materialGraphCanonical,
  OVERRIDES_KEY,
  type CompiledMaterialGraph,
  type GraphProblem,
  type MaterialFunctionLike,
  type MaterialGraphLike,
  type MaterialParameterLike,
  type SamplerLike,
} from './material-graph';
import { instanceOrigin, standardNodeMaterialFrom } from './node-materials';

export type MaterialShaderName = 'standard' | 'foliage' | 'kit' | 'unlit' | 'water';

/** The adapter's structural copy of a project material (project-model `MaterialDef`). */
export interface MaterialDefLike {
  readonly materialId: string;
  readonly name: string;
  readonly shader: MaterialShaderName;
  readonly params: Readonly<Record<string, number | boolean | string | readonly [number, number]>>;
  readonly textures: Readonly<Record<string, string>>;
  /** Phase 18.3: the exposed parameters of a graph material. */
  readonly parameters?: readonly MaterialParameterLike[];
  /** Phase 18.3: a node graph (a graph material; `shader`/`params`/`textures` are then unused). */
  readonly graph?: MaterialGraphLike;
}

/** Phase 18.3: an object's values for public parameters, by materialId then parameter key. */
export type MaterialOverridesLike = Readonly<Record<string, Readonly<Record<string, number | readonly number[] | string>>>>;

/** Phase 18.3: marks a mesh whose graph material does not cast shadows (the shadow flags respect it). */
export const MATERIAL_NO_SHADOW_KEY = '__tlMaterialNoShadow';

export interface WindLike {
  readonly direction: readonly [number, number];
  readonly strength: number;
  readonly gust: number;
  readonly gustFrequency: number;
  readonly turbulence: number;
}

export interface MaterialLibraryOptions {
  /** A texture asset's texture (the host decodes the bytes); null when unavailable. */
  loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  /** Something changed that needs a new frame (a texture arrived, a material was rebuilt). */
  onChange?: () => void;
}

export interface MaterialLibrary {
  /** The project materials and (phase 18.3) the material functions graph materials call. */
  setMaterials(defs: readonly MaterialDefLike[], functions?: readonly MaterialFunctionLike[]): void;
  setWind(wind: WindLike | null): void;
  /** Advance the shared clock (seconds since start). */
  tick(seconds: number): void;
  /** Whether any applied material animates (the host keeps rendering). */
  animated(): boolean;
  /**
   * Use project materials on every mesh under `root`: a mesh material named
   * `n` takes `mapping[n]`, else `mapping["*"]`. Returns a function that
   * restores the file's materials and stops tracking `root`. Phase 18.3:
   * `overrides` are the object's values for its graph materials' public
   * parameters (the `materialParams` component).
   */
  apply(root: THREE.Object3D, mapping: Readonly<Record<string, string>> | null, overrides?: MaterialOverridesLike | null): () => void;
  /** Phase 18.3: a graph material's compile problems (null: no such graph material, or not built yet). */
  graphProblems(materialId: string): readonly GraphProblem[] | null;
  dispose(): void;
}

/** Default wind when the project sets none (a light breeze). */
export const DEFAULT_WIND_LIKE: WindLike = { direction: [1, 0], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 };

const SOURCE = '__tlSourceMaterial';

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function vec2(v: unknown, d: [number, number]): [number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : d;
}

export function createMaterialLibrary(options: MaterialLibraryOptions): MaterialLibrary {
  /** The shared wind and clock block (TSL uniforms). */
  const nodeGlobals = {
    time: TSL.uniform(0),
    windDir: TSL.uniform(new THREE.Vector2(1, 0)),
    strength: TSL.uniform(DEFAULT_WIND_LIKE.strength),
    gust: TSL.uniform(DEFAULT_WIND_LIKE.gust),
    gustFreq: TSL.uniform(DEFAULT_WIND_LIKE.gustFrequency),
    turb: TSL.uniform(DEFAULT_WIND_LIKE.turbulence),
  };
  let defs = new Map<string, MaterialDefLike>();
  /** Built materials by `${materialId}|${source uuid or "none"}`. */
  const built = new Map<string, { material: THREE.Material; defKey: string; animated: boolean }>();
  /**
   * Phase 21.5: meshes wearing each built material (by key) and the keys each
   * mesh wears — a built material and its texture copies are released with
   * its last mesh. A source material that is recreated (a shared box material
   * freed with its last box and made again, a model reloaded) has a new uuid,
   * so without this every spawn or scene load left a built material behind.
   */
  const builtRefs = new Map<string, number>();
  const heldKeys = new WeakMap<THREE.Object3D, readonly string[]>();
  /** Phase 21.5: the texture copies each built material owns (released with it). */
  const ownTextures = new WeakMap<THREE.Material, THREE.Texture[]>();
  /** Phase 21.5: built materials already released (a texture arriving later is not put on them). */
  const retired = new WeakSet<THREE.Material>();
  const ownTexture = (m: THREE.Material, t: THREE.Texture): THREE.Texture => {
    const list = ownTextures.get(m);
    if (list === undefined) ownTextures.set(m, [t]);
    else list.push(t);
    return t;
  };
  const disposeBuilt = (m: THREE.Material): void => {
    retired.add(m);
    m.dispose();
    for (const t of ownTextures.get(m) ?? []) t.dispose();
    ownTextures.delete(m);
  };
  const releaseKey = (key: string): void => {
    const n = (builtRefs.get(key) ?? 0) - 1;
    if (n > 0) {
      builtRefs.set(key, n);
      return;
    }
    builtRefs.delete(key);
    const b = built.get(key);
    if (b === undefined) return;
    built.delete(key);
    if (b.animated) animatedCount = Math.max(0, animatedCount - 1);
    disposeBuilt(b.material);
  };
  const textures = new Map<string, Promise<THREE.Texture | null>>();
  const applied = new Map<THREE.Object3D, { mapping: Readonly<Record<string, string>> | null; overrides: MaterialOverridesLike | null }>();
  let functions = new Map<string, MaterialFunctionLike>();
  let animatedCount = 0;
  let disposed = false;
  /** Node materials whose nodes depend on textures that arrive later (rebuilt on arrival). */
  const nodeRefresh = new WeakMap<THREE.Material, () => void>();
  const refreshNodes = (m: THREE.Material): void => {
    nodeRefresh.get(m)?.();
  };

  const defKeyOf = (d: MaterialDefLike): string => JSON.stringify(d);

  const texture = (assetId: string): Promise<THREE.Texture | null> => {
    let p = textures.get(assetId);
    if (p === undefined) {
      p = options.loadTexture(assetId).catch(() => null);
      textures.set(assetId, p);
    }
    return p;
  };

  /** Give a (loaded) texture its role: colour space, wrapping, the material's tiling. */
  const prepared = (t: THREE.Texture, colour: boolean, def: MaterialDefLike, channel = 0): THREE.Texture => {
    const c = t.clone();
    c.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    c.wrapS = THREE.RepeatWrapping;
    c.wrapT = THREE.RepeatWrapping;
    c.flipY = false;
    c.channel = channel;
    const [rx, ry] = vec2(def.params['tiling'], [1, 1]);
    const [ox, oy] = vec2(def.params['offset'], [0, 0]);
    if (channel === 0) {
      c.repeat.set(rx, ry);
      c.offset.set(ox, oy);
    }
    c.needsUpdate = true;
    return c;
  };

  const build = (def: MaterialDefLike, source: THREE.Material | null): THREE.Material => {
    const p = def.params;
    if (def.shader === 'unlit') {
      const src = source as THREE.MeshStandardMaterial | null;
      const colour = { color: new THREE.Color(typeof p['color'] === 'string' ? p['color'] : '#ffffff') };
      const m = new MeshBasicNodeMaterial(colour) as unknown as THREE.MeshBasicMaterial;
      if (src?.map) m.map = src.map;
      m.vertexColors = p['vertexTint'] === true;
      applyAlpha(m, p);
      m.side = p['doubleSided'] === true ? THREE.DoubleSide : THREE.FrontSide;
      m.name = def.name;
      loadSlot(def, m, 'map', 'map', true);
      return m;
    }
    const m = standardNodeMaterialFrom(source instanceof THREE.MeshStandardMaterial ? source : null) as unknown as THREE.MeshStandardMaterial;
    m.name = def.name;
    m.vertexColors = false; // COLOR_0 is data for every project material
    if (typeof p['color'] === 'string') m.color.set(p['color']);
    if (p['roughness'] !== undefined) m.roughness = num(p['roughness'], m.roughness);
    if (p['metalness'] !== undefined) m.metalness = num(p['metalness'], m.metalness);
    if (typeof p['emissive'] === 'string') m.emissive.set(p['emissive']);
    if (p['emissiveIntensity'] !== undefined) m.emissiveIntensity = num(p['emissiveIntensity'], m.emissiveIntensity);
    if (p['aoIntensity'] !== undefined) m.aoMapIntensity = num(p['aoIntensity'], 1);
    if (p['normalScale'] !== undefined) {
      const s = num(p['normalScale'], 1);
      m.normalScale.set(s, Math.sign(m.normalScale.y || 1) * s);
    }
    if (p['doubleSided'] !== undefined || def.shader === 'foliage') m.side = p['doubleSided'] === false ? THREE.FrontSide : p['doubleSided'] === true || def.shader === 'foliage' ? THREE.DoubleSide : m.side;
    applyAlpha(m, p);
    // The file's textures take the material's tiling too (clones: the file's stay as they are).
    if (p['tiling'] !== undefined || p['offset'] !== undefined) {
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'] as const) {
        const t = m[slot];
        if (t !== null && t.channel === 0) m[slot] = ownTexture(m, prepared(t, slot === 'map' || slot === 'emissiveMap', def, 0));
      }
    }
    loadSlot(def, m, 'map', 'map', true);
    loadSlot(def, m, 'normalMap', 'normalMap', false);
    loadSlot(def, m, 'emissiveMap', 'emissiveMap', true);
    if (def.textures['ormMap'] !== undefined) {
      void texture(def.textures['ormMap']).then((t) => {
        if (t === null || disposed || retired.has(m)) return;
        const orm = ownTexture(m, prepared(t, false, def, 0));
        m.roughnessMap = orm;
        m.metalnessMap = orm;
        m.aoMap = orm;
        refreshNodes(m);
        m.needsUpdate = true;
        options.onChange?.();
      });
    }
    if (def.shader === 'foliage') installFoliageNodes(m, p);
    else if (def.shader === 'kit') installKitNodes(m, def);
    else if (def.shader === 'water') installWaterNodes(m, p);
    return m;
  };

  function applyAlpha(m: THREE.Material, p: MaterialDefLike['params']): void {
    const mode = p['alphaMode'];
    if (p['opacity'] !== undefined) m.opacity = num(p['opacity'], 1);
    if (mode === 'blend') {
      m.transparent = true;
      m.alphaTest = 0;
    } else if (mode === 'cutout') {
      m.transparent = false;
      m.alphaTest = num(p['alphaCutoff'], 0.5);
    } else if (mode === 'opaque') {
      m.transparent = false;
      m.alphaTest = 0;
    }
  }

  function loadSlot(def: MaterialDefLike, m: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial, slot: string, key: 'map' | 'normalMap' | 'emissiveMap', colour: boolean): void {
    const id = def.textures[slot];
    if (id === undefined) return;
    void texture(id).then((t) => {
      if (t === null || disposed || retired.has(m)) return;
      (m as unknown as Record<string, THREE.Texture | null>)[key] = ownTexture(m, prepared(t, colour, def, 0));
      refreshNodes(m);
      m.needsUpdate = true;
      options.onChange?.();
    });
  }

  // ---- Phase 17.2: the shader types as node materials (TSL) --------------------------
  // Each mirrors its archived onBeforeCompile twin line by line (same constants,
  // same order of operations), so the picture matches the parity references.

  /** COLOR_0 as data (a missing attribute reads (0, 0, 0, 1), as WebGL's default vertex attribute does). */
  const vertexData = TSL.Fn((builder: NodeBuilder) => ((builder as unknown as { geometry: THREE.BufferGeometry }).geometry.hasAttribute('color') ? TSL.attribute('color', 'vec4') : TSL.vec4(0, 0, 0, 1)));

  function installFoliageNodes(m: THREE.MeshStandardMaterial, p: MaterialDefLike['params']): void {
    animatedCount += 1;
    // Phase 15.5: the sway is in absolute metres (about 0.1 m at the tip in the
    // default breeze) — plant-sized for grass and shrubs; taller foliage raises
    // its material's windBend / windFlutter (0–4×). Kept (changing it would move
    // every existing project's foliage); a size-relative sway is a material-graph
    // (phase 18) candidate.
    const bend = TSL.uniform(num(p['windBend'], 1));
    const flutter = TSL.uniform(num(p['windFlutter'], 1));
    const flutterFreq = TSL.uniform(num(p['flutterFrequency'], 6));
    const subsurface = TSL.uniform(num(p['subsurface'], 0.3));
    const g = nodeGlobals;
    const colour = vertexData();
    const nm = m as unknown as MeshStandardNodeMaterial;
    // Instancing is applied before positionNode: positionLocal is already the
    // instance's, so modelWorldMatrix alone takes it to the world.
    nm.positionNode = TSL.Fn(() => {
      const local = TSL.positionLocal;
      const world = TSL.modelWorldMatrix.mul(TSL.vec4(local, 1)).xyz;
      const tlBend = colour.r.mul(colour.r).mul(bend);
      const phase = colour.g.mul(6.2831853);
      const gust = TSL.sin(g.time.mul(g.gustFreq).mul(6.2831853).sub(world.x.mul(0.08).mul(g.turb.mul(3).add(1)))).mul(0.5).add(0.5);
      const sway = TSL.sin(g.time.mul(1.7).add(phase).add(world.x.mul(0.4).mul(g.turb))).mul(0.35);
      const strength = g.strength.add(g.gust.mul(gust));
      const dir = TSL.length(g.windDir).greaterThan(0).select(TSL.normalize(g.windDir), TSL.vec2(1, 0));
      const bent = TSL.vec3(dir.x, 0, dir.y).mul(strength).mul(sway.add(0.65)).mul(tlBend).mul(0.12);
      const sagged = bent.sub(TSL.vec3(0, TSL.length(bent).mul(0.35), 0));
      const normalWorld = TSL.normalize(TSL.modelWorldMatrix.mul(TSL.vec4(TSL.normalLocal, 0)).xyz);
      const flutterAmount = TSL.sin(g.time.mul(flutterFreq).add(phase.mul(3)).add(world.x.mul(2.3))).mul(colour.b).mul(flutter).mul(0.015).mul(strength.add(0.5));
      const offset = sagged.add(normalWorld.mul(flutterAmount));
      return local.add(TSL.modelWorldMatrixInverse.mul(TSL.vec4(offset, 0)).xyz);
    })();
    const thin = TSL.varying(colour.a);
    nm.emissiveNode = TSL.materialEmissive.add(TSL.diffuseColor.rgb.mul(subsurface).mul(thin).mul(0.25));
  }

  /** The x scale of a texture's UV transform (a shift added before the transform lands after it once divided by this). */
  const uvScaleX = (t: THREE.Texture): number => {
    if (t.matrixAutoUpdate) t.updateMatrix();
    const a = t.matrix.elements[0] ?? 1;
    return Math.abs(a) > 1e-6 ? a : 1;
  };

  function installKitNodes(m: THREE.MeshStandardMaterial, def: MaterialDefLike): void {
    const p = def.params;
    const period = TSL.uniform(num(p['uvPeriod'], 4));
    const macroScale = TSL.uniform(num(p['macroNormalScale'], 1));
    let macro: THREE.Texture | null = null;
    const nm = m as unknown as MeshStandardNodeMaterial;
    // The object's (or instance's) world X over the period, per vertex.
    const shift = TSL.varying(TSL.modelWorldMatrix.mul(TSL.vec4(instanceOrigin(), 1)).x.div(period));
    // Colour, roughness and metalness maps sample at uv + shift, after their own transform (as the
    // archived GLSL added it to vMapUv): shift / (the transform's x scale) before it. Not the lightmap.
    nm.contextNode = TSL.context({
      getUV: (tn: { value: THREE.Texture }, builder: { material?: { lightMap?: THREE.Texture | null } }) =>
        tn.value === builder.material?.lightMap ? null : TSL.uv(tn.value.channel).add(TSL.vec2(shift.div(uvScaleX(tn.value)), 0)),
    }) as unknown as MeshStandardNodeMaterial['contextNode'];
    const refresh = (): void => {
      // AO and emission keep their own UVs (only map, normal, roughness and metalness shift).
      nm.aoNode = m.aoMap !== null ? TSL.materialAO.context({ getUV: undefined }) : null;
      nm.emissiveNode = TSL.materialEmissive.context({ getUV: undefined });
      const t = m.normalMap;
      if (t === null) {
        nm.normalNode = null;
        return;
      }
      // three builds the normal without the material's getUV context, so the
      // shifted UV is explicit here: the map's transform, then + shift.
      if (t.matrixAutoUpdate) t.updateMatrix();
      const at = TSL.uniform(t.matrix).mul(TSL.vec3(TSL.uv(t.channel), 1)).xy.add(TSL.vec2(shift, 0));
      let encoded = TSL.texture(t, at).xyz;
      if (macro !== null && m.normalMapType === THREE.TangentSpaceNormalMap) {
        // Whiteout blend of the macro normal (UV1) over the detail normal, before normalScale.
        const detail = encoded.mul(2).sub(1);
        const big = TSL.texture(macro, TSL.uv(1)).xyz.mul(2).sub(1);
        const blended = TSL.normalize(TSL.vec3(detail.xy.add(big.xy.mul(macroScale)), detail.z.mul(big.z)));
        encoded = blended.mul(0.5).add(0.5);
      }
      const n = TSL.normalMap(encoded, TSL.materialReference('normalScale', 'vec2'));
      (n as unknown as { normalMapType: THREE.NormalMapTypes }).normalMapType = m.normalMapType;
      nm.normalNode = n;
    };
    refresh();
    nodeRefresh.set(m, refresh);
    const macroId = def.textures['macroNormalMap'];
    if (macroId !== undefined) {
      void texture(macroId).then((t) => {
        if (t === null || disposed || retired.has(m)) return;
        const c = ownTexture(m, t.clone());
        c.colorSpace = THREE.NoColorSpace;
        c.flipY = false;
        c.needsUpdate = true;
        macro = c;
        refresh();
        m.needsUpdate = true;
        options.onChange?.();
      });
    }
  }

  function installWaterNodes(m: THREE.MeshStandardMaterial, p: MaterialDefLike['params']): void {
    animatedCount += 1;
    m.transparent = true;
    m.opacity = num(p['opacity'], 0.8);
    m.roughness = num(p['roughness'], 0.1);
    m.color.set(typeof p['color'] === 'string' ? p['color'] : '#1d5f8a');
    const [fx, fy] = vec2(p['flow'], [0.05, 0.02]);
    const flow = TSL.uniform(new THREE.Vector2(fx, fy));
    const waveScale = TSL.uniform(num(p['waveScale'], 2));
    const shallow = TSL.uniform(new THREE.Color(typeof p['shallowColor'] === 'string' ? p['shallowColor'] : '#4fb3c9'));
    const fresnel = TSL.uniform(num(p['fresnel'], 3));
    const nm = m as unknown as MeshStandardNodeMaterial;
    const refresh = (): void => {
      const t = m.normalMap;
      if (t === null) {
        nm.normalNode = null;
        return;
      }
      // The normal map's own transform, then the wave scale and the flow over time.
      if (t.matrixAutoUpdate) t.updateMatrix();
      const base = TSL.uniform(t.matrix).mul(TSL.vec3(TSL.uv(t.channel), 1)).xy;
      const waves = base.mul(waveScale).add(flow.mul(nodeGlobals.time));
      nm.normalNode = TSL.normalMap(TSL.texture(t, waves), TSL.materialReference('normalScale', 'vec2'));
    };
    refresh();
    nodeRefresh.set(m, refresh);
    // Fresnel from the unmapped view-space normal: shallow colour face-on, the water colour at grazing angles.
    const c = TSL.vec4(TSL.materialColor as unknown as ReturnType<typeof TSL.vec4>);
    const f = TSL.pow(TSL.float(1).sub(TSL.clamp(TSL.abs(TSL.dot(TSL.normalize(TSL.positionView.negate()), TSL.normalViewGeometry)), 0, 1)), fresnel);
    nm.colorNode = TSL.vec4(TSL.mix(shallow, c.rgb, TSL.clamp(f.mul(1.5), 0, 1)), c.a);
  }

  // ---- Phase 18.3: graph materials ---------------------------------------------------

  interface GraphEntry {
    readonly canonical: string;
    readonly digest: string;
    readonly def: MaterialDefLike;
    readonly material: THREE.Material;
    compiled: CompiledMaterialGraph;
  }
  /** Compiled graph materials by digest (shared by every material and object with the same compile input). */
  const graphEntries = new Map<string, GraphEntry>();
  /** Texture assets as loaded (null: unavailable); absent = not asked yet or loading. */
  const loadedTextures = new Map<string, THREE.Texture | null>();
  /** Textures prepared for a sampler (colour space, wrapping, filter). */
  const samplerTextures = new Map<string, THREE.Texture>();
  const fnOf = (id: string): MaterialFunctionLike | null => functions.get(id) ?? null;

  const samplerTexture = (assetId: string, sampler: SamplerLike): THREE.Texture | 'loading' | null => {
    if (!loadedTextures.has(assetId)) {
      void texture(assetId).then((t) => {
        if (disposed || loadedTextures.has(assetId)) return;
        loadedTextures.set(assetId, t);
        // Recompile the graphs that drew a fallback while it was on its way.
        let changed = false;
        for (const e of graphEntries.values()) {
          if (!e.compiled.pending.includes(assetId)) continue;
          recompile(e);
          changed = true;
        }
        if (changed) options.onChange?.();
      });
      return 'loading';
    }
    const base = loadedTextures.get(assetId) ?? null;
    if (base === null) return null;
    const key = `${assetId}|${sampler.colorSpace}|${sampler.wrap}|${sampler.filter}`;
    let t = samplerTextures.get(key);
    if (t === undefined) {
      t = base.clone();
      t.colorSpace = sampler.colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      const wrap = sampler.wrap === 'clamp' ? THREE.ClampToEdgeWrapping : sampler.wrap === 'mirror' ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
      t.wrapS = wrap;
      t.wrapT = wrap;
      t.flipY = false;
      t.channel = 0;
      // Linear keeps the texture's own filtering (mipmaps when it has them).
      if (sampler.filter === 'nearest') {
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
      }
      t.needsUpdate = true;
      samplerTextures.set(key, t);
    }
    return t;
  };

  const compileEntry = (def: MaterialDefLike, digest: string): CompiledMaterialGraph =>
    compileMaterialGraph({ graph: def.graph!, ...(def.parameters !== undefined ? { parameters: def.parameters } : {}) }, { globals: nodeGlobals, texture: samplerTexture, fn: fnOf, overrideKey: digest });
  function recompile(e: GraphEntry): void {
    e.compiled = compileEntry(e.def, e.digest);
    applyGraphNodes(e.material as unknown as MeshStandardNodeMaterial, e.compiled);
  }

  /** The shared compiled material of a graph material (a texture override makes a variant). */
  const graphMaterial = (def: MaterialDefLike): GraphEntry => {
    const canonical = materialGraphCanonical({ graph: def.graph!, ...(def.parameters !== undefined ? { parameters: def.parameters } : {}) }, fnOf);
    const digest = digestOf(canonical);
    const have = graphEntries.get(digest);
    if (have !== undefined && have.canonical === canonical) return have;
    if (have !== undefined) have.material.dispose();
    const compiled = compileEntry(def, digest);
    const material = buildGraphMaterial(compiled, def.name);
    const e: GraphEntry = { canonical, digest, def, material, compiled };
    graphEntries.set(digest, e);
    return e;
  };

  /** A graph material's definition with an object's texture overrides as its defaults (null: none apply). */
  const textureVariant = (def: MaterialDefLike, values: Readonly<Record<string, unknown>> | undefined): MaterialDefLike | null => {
    if (values === undefined || def.parameters === undefined) return null;
    let changed = false;
    const parameters = def.parameters.map((p) => {
      const v = values[p.key];
      if (p.type !== 'texture' || p.visibility === 'private' || typeof v !== 'string' || v === p.default) return p;
      changed = true;
      return { ...p, default: v };
    });
    return changed ? { ...def, parameters } : null;
  };

  const materialFor = (materialId: string, source: THREE.Material | null): THREE.Material | null => {
    const def = defs.get(materialId);
    if (def === undefined) return null;
    const key = `${materialId}|${source?.uuid ?? 'none'}`;
    const dk = defKeyOf(def);
    const have = built.get(key);
    if (have !== undefined && have.defKey === dk) return have.material;
    if (have !== undefined) {
      if (have.animated) animatedCount = Math.max(0, animatedCount - 1);
      disposeBuilt(have.material);
    }
    const m = build(def, source);
    built.set(key, { material: m, defKey: dk, animated: def.shader === 'foliage' || def.shader === 'water' });
    return m;
  };

  /** Digests in use by applied meshes (the rest are dropped after a material change). */
  let usedDigests = new Set<string>();

  const assign = (root: THREE.Object3D, mapping: Readonly<Record<string, string>> | null, overrides: MaterialOverridesLike | null = null): void => {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const data = mesh.userData as Record<string, unknown>;
      const original = (data[SOURCE] as THREE.Material | THREE.Material[] | undefined) ?? mesh.material;
      const list = Array.isArray(original) ? original : [original];
      let changed = false;
      /** Phase 18.3: this mesh's parameter values by compiled digest; whether a graph material casts no shadow. */
      const values: Record<string, Readonly<Record<string, unknown>>> = {};
      let noShadow = false;
      const keys: string[] = [];
      const next = list.map((src) => {
        const id = mapping === null ? undefined : (mapping[src.name] ?? mapping['*']);
        const def = id === undefined ? undefined : defs.get(id);
        if (def?.graph !== undefined) {
          const own = overrides?.[def.materialId];
          const e = graphMaterial(textureVariant(def, own) ?? def);
          usedDigests.add(e.digest);
          if (own !== undefined) values[e.digest] = own;
          if (!e.compiled.flags.castShadows) noShadow = true;
          changed = true;
          return e.material;
        }
        const m = id === undefined ? null : materialFor(id, src);
        if (m !== null) {
          changed = true;
          keys.push(`${id}|${src.uuid}`);
        }
        return m ?? src;
      });
      // Phase 21.5: count the new holds before releasing the old ones (a material kept stays built).
      for (const k of keys) builtRefs.set(k, (builtRefs.get(k) ?? 0) + 1);
      for (const k of heldKeys.get(mesh) ?? []) releaseKey(k);
      if (keys.length > 0) heldKeys.set(mesh, keys);
      else heldKeys.delete(mesh);
      if (Object.keys(values).length > 0) data[OVERRIDES_KEY] = values;
      else delete data[OVERRIDES_KEY];
      // The graph's "casts shadows" flag (the object's own flag is kept to restore).
      if (noShadow && data[MATERIAL_NO_SHADOW_KEY] === undefined) {
        data[MATERIAL_NO_SHADOW_KEY] = mesh.castShadow;
        mesh.castShadow = false;
      } else if (!noShadow && data[MATERIAL_NO_SHADOW_KEY] !== undefined) {
        mesh.castShadow = data[MATERIAL_NO_SHADOW_KEY] === true;
        delete data[MATERIAL_NO_SHADOW_KEY];
      }
      if (changed) {
        data[SOURCE] = original;
        mesh.material = Array.isArray(original) ? next : (next[0] as THREE.Material);
      } else if (data[SOURCE] !== undefined) {
        mesh.material = original;
        delete data[SOURCE];
      }
    });
  };

  return {
    setMaterials(list, fns) {
      defs = new Map(list.map((d) => [d.materialId, d]));
      if (fns !== undefined) functions = new Map(fns.filter((f) => f.kind === 'material-function').map((f) => [f.graphId, f]));
      // Rebuild lazily: drop materials whose definition changed or vanished.
      animatedCount = 0;
      for (const [key, b] of [...built]) {
        const def = defs.get(key.split('|')[0] as string);
        if (def === undefined || defKeyOf(def) !== b.defKey) {
          disposeBuilt(b.material);
          built.delete(key);
        } else if (def.shader === 'foliage' || def.shader === 'water') animatedCount += 1;
      }
      usedDigests = new Set();
      for (const [root, a] of applied) assign(root, a.mapping, a.overrides);
      // Phase 18.3: compiled graphs no applied mesh uses any more (a later apply recompiles).
      for (const [digest, e] of [...graphEntries]) {
        if (usedDigests.has(digest)) continue;
        e.material.dispose();
        graphEntries.delete(digest);
      }
      options.onChange?.();
    },
    setWind(wind) {
      const w = wind ?? DEFAULT_WIND_LIKE;
      (nodeGlobals.windDir.value as THREE.Vector2).set(w.direction[0], w.direction[1]);
      nodeGlobals.strength.value = w.strength;
      nodeGlobals.gust.value = w.gust;
      nodeGlobals.gustFreq.value = w.gustFrequency;
      nodeGlobals.turb.value = w.turbulence;
    },
    tick(seconds) {
      nodeGlobals.time.value = seconds;
    },
    animated() {
      if (applied.size === 0) return false;
      if (animatedCount > 0) return true;
      for (const e of graphEntries.values()) if (e.compiled.animated) return true;
      return false;
    },
    apply(root, mapping, overrides = null) {
      const record = { mapping, overrides: overrides ?? null };
      applied.set(root, record);
      assign(root, mapping, record.overrides);
      return () => {
        // Only the latest apply of a root restores it (an older undo after a re-apply does nothing).
        if (applied.get(root) !== record) return;
        applied.delete(root);
        assign(root, null);
      };
    },
    graphProblems(materialId) {
      const def = defs.get(materialId);
      if (def?.graph === undefined) return null;
      const canonical = materialGraphCanonical({ graph: def.graph, ...(def.parameters !== undefined ? { parameters: def.parameters } : {}) }, fnOf);
      return graphEntries.get(digestOf(canonical))?.compiled.problems ?? null;
    },
    dispose() {
      disposed = true;
      for (const b of built.values()) disposeBuilt(b.material);
      built.clear();
      builtRefs.clear();
      for (const e of graphEntries.values()) e.material.dispose();
      graphEntries.clear();
      // Phase 21.5: the sampler copies are the library's (the loaded textures belong to the loader).
      for (const t of samplerTextures.values()) t.dispose();
      samplerTextures.clear();
      applied.clear();
    },
  };
}

/** Decode a texture asset's verified bytes (PNG/JPEG/WebP) into a texture (browser only). */
export async function decodeTexture(bytes: ArrayBuffer | Uint8Array): Promise<THREE.Texture> {
  const blob = new Blob([bytes as BlobPart]);
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const t = new THREE.Texture(bitmap as unknown as HTMLImageElement);
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}
