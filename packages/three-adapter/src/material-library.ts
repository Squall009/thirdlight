/**
 * Phase 9.4: project materials at runtime (editor view, Play and export).
 *
 * A material definition is a shader type plus overrides. On a model it
 * starts from the file's own material (a clone keeps its textures) and
 * changes only what it sets; on a box it starts from the shader defaults.
 * The shader types extend three's standard material through
 * `onBeforeCompile`, so lighting, shadows and fog stay three's own:
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
 * Phase 17.2: the same shader types as node materials (TSL) for three's
 * `WebGPURenderer` (`nodeMaterials: true`, or `setNodeMaterials(true)` when
 * a view switches renderer), which ignores `onBeforeCompile`. Both paths take
 * the same parameters and draw the same picture (the pixel-parity e2e
 * compares them); the `onBeforeCompile` path stays until the switch-over
 * (17.4).
 *
 * Pure three.js: textures come from an injected loader (the host resolves
 * bytes; nothing here fetches).
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { MeshBasicNodeMaterial, type MeshStandardNodeMaterial, type NodeBuilder } from 'three/webgpu';

import { instanceOrigin, standardNodeMaterialFrom } from './node-materials';

export type MaterialShaderName = 'standard' | 'foliage' | 'kit' | 'unlit' | 'water';

/** The adapter's structural copy of a project material (project-model `MaterialDef`). */
export interface MaterialDefLike {
  readonly materialId: string;
  readonly name: string;
  readonly shader: MaterialShaderName;
  readonly params: Readonly<Record<string, number | boolean | string | readonly [number, number]>>;
  readonly textures: Readonly<Record<string, string>>;
}

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
  /** Phase 17.2: build node materials (the renderer is `WebGPURenderer`); default false (the WebGL renderer). */
  nodeMaterials?: boolean;
}

export interface MaterialLibrary {
  setMaterials(defs: readonly MaterialDefLike[]): void;
  setWind(wind: WindLike | null): void;
  /** Advance the shared clock (seconds since start). */
  tick(seconds: number): void;
  /** Whether any applied material animates (the host keeps rendering). */
  animated(): boolean;
  /**
   * Use project materials on every mesh under `root`: a mesh material named
   * `n` takes `mapping[n]`, else `mapping["*"]`. Returns a function that
   * restores the file's materials and stops tracking `root`.
   */
  apply(root: THREE.Object3D, mapping: Readonly<Record<string, string>> | null): () => void;
  /**
   * Phase 17.2: switch between node materials (`WebGPURenderer`) and the
   * WebGL renderer's materials; every applied material is rebuilt.
   */
  setNodeMaterials(on: boolean): void;
  /** Whether the library builds node materials. */
  nodeMaterials(): boolean;
  dispose(): void;
}

/** Default wind when the project sets none (a light breeze). */
export const DEFAULT_WIND_LIKE: WindLike = { direction: [1, 0], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 };

const SOURCE = '__tlSourceMaterial';

const COMMON_VERTEX_PARS = /* glsl */ `
uniform float uTlTime;
uniform vec2 uTlWindDir;
uniform float uTlWindStrength;
uniform float uTlWindGust;
uniform float uTlWindGustFreq;
uniform float uTlWindTurb;
`;

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function vec2(v: unknown, d: [number, number]): [number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : d;
}

export function createMaterialLibrary(options: MaterialLibraryOptions): MaterialLibrary {
  const globals = {
    uTlTime: { value: 0 },
    uTlWindDir: { value: new THREE.Vector2(1, 0) },
    uTlWindStrength: { value: DEFAULT_WIND_LIKE.strength },
    uTlWindGust: { value: DEFAULT_WIND_LIKE.gust },
    uTlWindGustFreq: { value: DEFAULT_WIND_LIKE.gustFrequency },
    uTlWindTurb: { value: DEFAULT_WIND_LIKE.turbulence },
  };
  /** The same shared block as TSL uniforms (node materials). */
  const nodeGlobals = {
    time: TSL.uniform(0),
    windDir: TSL.uniform(globals.uTlWindDir.value),
    strength: TSL.uniform(DEFAULT_WIND_LIKE.strength),
    gust: TSL.uniform(DEFAULT_WIND_LIKE.gust),
    gustFreq: TSL.uniform(DEFAULT_WIND_LIKE.gustFrequency),
    turb: TSL.uniform(DEFAULT_WIND_LIKE.turbulence),
  };
  let defs = new Map<string, MaterialDefLike>();
  /** Built materials by `${materialId}|${source uuid or "none"}`. */
  const built = new Map<string, { material: THREE.Material; defKey: string }>();
  const textures = new Map<string, Promise<THREE.Texture | null>>();
  const applied = new Map<THREE.Object3D, Readonly<Record<string, string>> | null>();
  let animatedCount = 0;
  let disposed = false;
  let nodeMode = options.nodeMaterials === true;
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
      const m = nodeMode ? (new MeshBasicNodeMaterial(colour) as unknown as THREE.MeshBasicMaterial) : new THREE.MeshBasicMaterial(colour);
      if (src?.map) m.map = src.map;
      m.vertexColors = p['vertexTint'] === true;
      applyAlpha(m, p);
      m.side = p['doubleSided'] === true ? THREE.DoubleSide : THREE.FrontSide;
      m.name = def.name;
      loadSlot(def, m, 'map', 'map', true);
      return m;
    }
    const base = nodeMode
      ? (standardNodeMaterialFrom(source instanceof THREE.MeshStandardMaterial ? source : null) as unknown as THREE.MeshStandardMaterial)
      : source instanceof THREE.MeshStandardMaterial
        ? (source.clone() as THREE.MeshStandardMaterial)
        : new THREE.MeshStandardMaterial();
    const m = base;
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
        if (t !== null && t.channel === 0) m[slot] = prepared(t, slot === 'map' || slot === 'emissiveMap', def, 0);
      }
    }
    loadSlot(def, m, 'map', 'map', true);
    loadSlot(def, m, 'normalMap', 'normalMap', false);
    loadSlot(def, m, 'emissiveMap', 'emissiveMap', true);
    if (def.textures['ormMap'] !== undefined) {
      void texture(def.textures['ormMap']).then((t) => {
        if (t === null || disposed) return;
        const orm = prepared(t, false, def, 0);
        m.roughnessMap = orm;
        m.metalnessMap = orm;
        m.aoMap = orm;
        refreshNodes(m);
        m.needsUpdate = true;
        options.onChange?.();
      });
    }
    if (nodeMode) {
      if (def.shader === 'foliage') installFoliageNodes(m, p);
      else if (def.shader === 'kit') installKitNodes(m, def);
      else if (def.shader === 'water') installWaterNodes(m, p);
      return m;
    }
    if (def.shader === 'foliage') installFoliage(m, p);
    else if (def.shader === 'kit') installKit(m, def);
    else if (def.shader === 'water') installWater(m, p);
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
      if (t === null || disposed) return;
      (m as unknown as Record<string, THREE.Texture | null>)[key] = prepared(t, colour, def, 0);
      refreshNodes(m);
      m.needsUpdate = true;
      options.onChange?.();
    });
  }

  function installFoliage(m: THREE.MeshStandardMaterial, p: MaterialDefLike['params']): void {
    animatedCount += 1;
    const local = {
      uTlBend: { value: num(p['windBend'], 1) },
      uTlFlutter: { value: num(p['windFlutter'], 1) },
      uTlFlutterFreq: { value: num(p['flutterFrequency'], 6) },
      uTlSubsurface: { value: num(p['subsurface'], 0.3) },
    };
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, globals, local);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
${COMMON_VERTEX_PARS}
uniform float uTlBend;
uniform float uTlFlutter;
uniform float uTlFlutterFreq;
#if !defined(USE_COLOR) && !defined(USE_COLOR_ALPHA)
attribute vec4 color;
#endif
varying float vTlThin;`,
        )
        // Phase 15.5: the sway is in absolute metres (about 0.1 m at the tip in the
        // default breeze) — plant-sized for grass and shrubs; taller foliage raises
        // its material's windBend / windFlutter (0–4×). Kept (changing it would move
        // every existing project's foliage); a size-relative sway is a material-graph
        // (phase 18) candidate.
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
{
  mat4 tlModel = modelMatrix;
  #ifdef USE_INSTANCING
  tlModel = modelMatrix * instanceMatrix;
  #endif
  vec4 tlWorld = tlModel * vec4(transformed, 1.0);
  float tlBend = color.r * color.r * uTlBend;
  float tlPhase = color.g * 6.2831853;
  float tlGust = 0.5 + 0.5 * sin(uTlTime * uTlWindGustFreq * 6.2831853 - tlWorld.x * 0.08 * (1.0 + uTlWindTurb * 3.0));
  float tlSway = sin(uTlTime * 1.7 + tlPhase + tlWorld.x * 0.4 * uTlWindTurb) * 0.35;
  float tlStrength = uTlWindStrength + uTlWindGust * tlGust;
  vec2 tlDir = length(uTlWindDir) > 0.0 ? normalize(uTlWindDir) : vec2(1.0, 0.0);
  vec3 tlOffset = vec3(tlDir.x, 0.0, tlDir.y) * tlStrength * (0.65 + tlSway) * tlBend * 0.12;
  tlOffset.y -= length(tlOffset) * 0.35;
  tlOffset += normalize(mat3(tlModel) * objectNormal) * sin(uTlTime * uTlFlutterFreq + tlPhase * 3.0 + tlWorld.x * 2.3) * color.b * uTlFlutter * 0.015 * (0.5 + tlStrength);
  transformed += inverse(mat3(tlModel)) * tlOffset;
  vTlThin = color.a;
}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uTlSubsurface;
varying float vTlThin;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * uTlSubsurface * vTlThin * 0.25;`);
    };
    m.customProgramCacheKey = () => 'tl-foliage';
  }

  function installKit(m: THREE.MeshStandardMaterial, def: MaterialDefLike): void {
    const p = def.params;
    const local = {
      uTlUvPeriod: { value: num(p['uvPeriod'], 4) },
      uTlMacroNormal: { value: null as THREE.Texture | null },
      uTlMacroNormalScale: { value: num(p['macroNormalScale'], 1) },
    };
    const macroId = def.textures['macroNormalMap'];
    if (macroId !== undefined) {
      m.defines = { ...(m.defines ?? {}), TL_KIT_MACRO: '' };
      void texture(macroId).then((t) => {
        if (t === null || disposed) return;
        const c = t.clone();
        c.colorSpace = THREE.NoColorSpace;
        c.flipY = false;
        c.needsUpdate = true;
        local.uTlMacroNormal.value = c;
        options.onChange?.();
      });
    }
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, local);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
uniform float uTlUvPeriod;
#if defined(TL_KIT_MACRO) && !defined(USE_UV1)
attribute vec2 uv1;
#endif
varying vec2 vTlUv1;`)
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
{
  vec4 tlOrigin = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  #ifdef USE_INSTANCING
  tlOrigin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  #endif
  float tlShift = tlOrigin.x / uTlUvPeriod;
  #ifdef USE_MAP
  vMapUv.x += tlShift;
  #endif
  #ifdef USE_NORMALMAP
  vNormalMapUv.x += tlShift;
  #endif
  #ifdef USE_ROUGHNESSMAP
  vRoughnessMapUv.x += tlShift;
  #endif
  #ifdef USE_METALNESSMAP
  vMetalnessMapUv.x += tlShift;
  #endif
  #ifdef TL_KIT_MACRO
  vTlUv1 = uv1;
  #endif
}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D uTlMacroNormal;
uniform float uTlMacroNormalScale;
varying vec2 vTlUv1;`)
        // Phase 17.2: the blend goes into the expanded chunk — onBeforeCompile sees
        // `#include <normal_fragment_maps>`, not its lines, so replacing the line
        // itself (as before) silently never applied the macro normal.
        .replace(
          '#include <normal_fragment_maps>',
          THREE.ShaderChunk.normal_fragment_maps.replace(
            'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
            `vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
	#ifdef TL_KIT_MACRO
	vec3 tlMacro = texture2D( uTlMacroNormal, vTlUv1 ).xyz * 2.0 - 1.0;
	tlMacro.xy *= uTlMacroNormalScale;
	mapN = normalize( vec3( mapN.xy + tlMacro.xy, mapN.z * tlMacro.z ) );
	#endif`,
          ),
        );
    };
    m.customProgramCacheKey = () => `tl-kit${macroId !== undefined ? '-macro' : ''}`;
  }

  function installWater(m: THREE.MeshStandardMaterial, p: MaterialDefLike['params']): void {
    animatedCount += 1;
    m.transparent = true;
    m.opacity = num(p['opacity'], 0.8);
    m.roughness = num(p['roughness'], 0.1);
    m.color.set(typeof p['color'] === 'string' ? p['color'] : '#1d5f8a');
    const [fx, fy] = vec2(p['flow'], [0.05, 0.02]);
    const local = {
      uTlFlow: { value: new THREE.Vector2(fx, fy) },
      uTlWaveScale: { value: num(p['waveScale'], 2) },
      uTlShallow: { value: new THREE.Color(typeof p['shallowColor'] === 'string' ? p['shallowColor'] : '#4fb3c9') },
      uTlFresnel: { value: num(p['fresnel'], 3) },
    };
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, globals, local);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
uniform float uTlTime;
uniform vec2 uTlFlow;
uniform float uTlWaveScale;`)
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
#ifdef USE_NORMALMAP
vNormalMapUv = vNormalMapUv * uTlWaveScale + uTlFlow * uTlTime;
#endif`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform vec3 uTlShallow;
uniform float uTlFresnel;`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
{
  float tlF = pow(1.0 - clamp(abs(dot(normalize(vViewPosition), normalize(vNormal))), 0.0, 1.0), uTlFresnel);
  diffuseColor.rgb = mix(uTlShallow, diffuseColor.rgb, clamp(tlF * 1.5, 0.0, 1.0));
}`,
        );
    };
    m.customProgramCacheKey = () => 'tl-water';
  }

  // ---- Phase 17.2: the shader types as node materials (TSL) --------------------------
  // Each mirrors its onBeforeCompile twin above line by line (same constants,
  // same order of operations), so both renderers draw the same picture.

  /** COLOR_0 as data (a missing attribute reads (0, 0, 0, 1), as WebGL's default vertex attribute does). */
  const vertexData = TSL.Fn((builder: NodeBuilder) => ((builder as unknown as { geometry: THREE.BufferGeometry }).geometry.hasAttribute('color') ? TSL.attribute('color', 'vec4') : TSL.vec4(0, 0, 0, 1)));

  function installFoliageNodes(m: THREE.MeshStandardMaterial, p: MaterialDefLike['params']): void {
    animatedCount += 1;
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
    // legacy path adds it to vMapUv): shift / (the transform's x scale) before it. Not the lightmap.
    nm.contextNode = TSL.context({
      getUV: (tn: { value: THREE.Texture }, builder: { material?: { lightMap?: THREE.Texture | null } }) =>
        tn.value === builder.material?.lightMap ? null : TSL.uv(tn.value.channel).add(TSL.vec2(shift.div(uvScaleX(tn.value)), 0)),
    }) as unknown as MeshStandardNodeMaterial['contextNode'];
    const refresh = (): void => {
      // AO and emission keep their own UVs (the legacy path shifts only map, normal, roughness and metalness).
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
        if (t === null || disposed) return;
        const c = t.clone();
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

  const materialFor = (materialId: string, source: THREE.Material | null): THREE.Material | null => {
    const def = defs.get(materialId);
    if (def === undefined) return null;
    const key = `${materialId}|${source?.uuid ?? 'none'}`;
    const dk = defKeyOf(def);
    const have = built.get(key);
    if (have !== undefined && have.defKey === dk) return have.material;
    if (have !== undefined) have.material.dispose();
    const m = build(def, source);
    built.set(key, { material: m, defKey: dk });
    return m;
  };

  const assign = (root: THREE.Object3D, mapping: Readonly<Record<string, string>> | null): void => {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const data = mesh.userData as Record<string, unknown>;
      const original = (data[SOURCE] as THREE.Material | THREE.Material[] | undefined) ?? mesh.material;
      const list = Array.isArray(original) ? original : [original];
      let changed = false;
      const next = list.map((src) => {
        const id = mapping === null ? undefined : (mapping[src.name] ?? mapping['*']);
        const m = id === undefined ? null : materialFor(id, src);
        if (m !== null) changed = true;
        return m ?? src;
      });
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
    setMaterials(list) {
      defs = new Map(list.map((d) => [d.materialId, d]));
      // Rebuild lazily: drop materials whose definition changed or vanished.
      animatedCount = 0;
      for (const [key, b] of [...built]) {
        const def = defs.get(key.split('|')[0] as string);
        if (def === undefined || defKeyOf(def) !== b.defKey) {
          b.material.dispose();
          built.delete(key);
        } else if (def.shader === 'foliage' || def.shader === 'water') animatedCount += 1;
      }
      for (const [root, mapping] of applied) assign(root, mapping);
      options.onChange?.();
    },
    setWind(wind) {
      const w = wind ?? DEFAULT_WIND_LIKE;
      globals.uTlWindDir.value.set(w.direction[0], w.direction[1]);
      globals.uTlWindStrength.value = w.strength;
      globals.uTlWindGust.value = w.gust;
      globals.uTlWindGustFreq.value = w.gustFrequency;
      globals.uTlWindTurb.value = w.turbulence;
      nodeGlobals.strength.value = w.strength;
      nodeGlobals.gust.value = w.gust;
      nodeGlobals.gustFreq.value = w.gustFrequency;
      nodeGlobals.turb.value = w.turbulence;
    },
    tick(seconds) {
      globals.uTlTime.value = seconds;
      nodeGlobals.time.value = seconds;
    },
    animated() {
      return animatedCount > 0 && applied.size > 0;
    },
    apply(root, mapping) {
      applied.set(root, mapping);
      assign(root, mapping);
      return () => {
        applied.delete(root);
        assign(root, null);
      };
    },
    setNodeMaterials(on) {
      if (on === nodeMode || disposed) return;
      nodeMode = on;
      for (const b of built.values()) b.material.dispose();
      built.clear();
      animatedCount = 0;
      for (const [root, mapping] of applied) assign(root, mapping);
      options.onChange?.();
    },
    nodeMaterials() {
      return nodeMode;
    },
    dispose() {
      disposed = true;
      for (const b of built.values()) b.material.dispose();
      built.clear();
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
