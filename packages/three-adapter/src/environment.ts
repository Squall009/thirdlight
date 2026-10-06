/**
 * The environment renderer — sky, image-based lighting, fog, fog
 * volumes, tone mapping and the post stack — shared by the editor's Scene
 * view and Play/export. It replaces `renderer.render(scene, camera)`.
 *
 * Pass order (each only when enabled and allowed by the quality level):
 * render (ambient occlusion — SSAO or GTAO, `setRender` — darkening the
 * lit materials' indirect light) → fog volumes (from the scene pass's
 * depth) → depth of field → bloom → output (tone mapping + sRGB) → grading
 * (brightness/contrast/saturation/tint, LUT strip, vignette) → anti-aliasing
 * (SMAA/FXAA) → upscale (FSR 1, when the render scale is below 1 or dynamic
 * resolution may lower it). With nothing enabled it renders directly (the
 * renderer's own tone mapping).
 *
 * Capability fallback: if the post pipeline cannot be built, rendering falls
 * back to the direct path and `diagnostics().fallback` says why; gameplay
 * never depends on it.
 *
 * three's WebGPURenderer (WebGPU or its WebGL 2 backend)
 * draws every part from TSL (`environment-nodes.ts`): the physical sky is
 * three's `SkyMesh`, the gradient dome a node material, PMREM is
 * `three/webgpu`'s generator, and the post stack a `RenderPipeline` (TSL
 * display nodes for GTAO, depth of field, bloom, SMAA and FXAA; the fog
 * volume and grading passes ported line by line from the archived GLSL). The
 * low quality level also draws without MSAA (its profile has no
 * anti-aliasing), through a plain scene pass. The WebGLRenderer version
 * (EffectComposer, `Sky.js`, GLSL passes) is archived
 * (`archive/webgl-renderer-17/`).
 *
 * Pure three.js + examples; textures come from the injected loader.
 */
import * as THREE from 'three';
import { PMREMGenerator as NodePMREMGenerator, type WebGPURenderer } from 'three/webgpu';

import { ScreenSpaceOcclusion } from './post-ao';
import type { UpscaleFilter } from './post-upscale';
import { buildPostPipeline, compileIntoTarget, createSkyMesh, SETTLED_PRECOMPILE as settledPrecompile, type Precompile, gradientSkyMaterial, gradientSkyUniforms, imageSkyMaterial, MAX_FOG_VOLUMES, type FogVolumeBox, type PostPipeline, type PostPlan } from './environment-nodes';

/** Structural copies of the project-model environment types. */
export interface SkyLike {
  readonly mode: 'procedural' | 'gradient' | 'texture' | 'color';
  readonly turbidity?: number;
  readonly rayleigh?: number;
  readonly mieCoefficient?: number;
  readonly mieDirectionalG?: number;
  readonly sunFromLight?: boolean;
  readonly sunElevation?: number;
  readonly sunAzimuth?: number;
  readonly topColor?: string;
  readonly horizonColor?: string;
  readonly bottomColor?: string;
  readonly color?: string;
  readonly texture?: string;
  readonly cube?: readonly string[];
  readonly intensity?: number;
  readonly environmentIntensity?: number;
}
export interface FogLike {
  readonly mode: 'none' | 'linear' | 'exp2';
  readonly color: string;
  readonly near?: number;
  readonly far?: number;
  readonly density?: number;
}
export interface PostLike {
  readonly toneMapping?: 'none' | 'aces' | 'agx' | 'neutral';
  readonly exposure?: number;
  readonly bloom?: { readonly enabled: boolean; readonly strength?: number; readonly radius?: number; readonly threshold?: number };
  readonly grading?: { readonly contrast?: number; readonly saturation?: number; readonly brightness?: number; readonly tint?: string; readonly lut?: string; readonly lift?: number; readonly gamma?: number; readonly gain?: number };
  readonly vignette?: { readonly enabled: boolean; readonly darkness?: number; readonly offset?: number };
  readonly ssao?: { readonly enabled: boolean; readonly radius?: number; readonly intensity?: number };
  readonly dof?: { readonly enabled: boolean; readonly focus?: number; readonly aperture?: number; readonly maxBlur?: number };
  readonly antialias?: 'none' | 'fxaa' | 'smaa';
}
export interface EnvironmentLike {
  readonly sky?: SkyLike;
  readonly fog?: FogLike;
  readonly post?: PostLike;
  readonly quality?: 'low' | 'medium' | 'high';
  /** The environment presets (the renderer draws a blend of them through `setBlend`). */
  readonly presets?: readonly { readonly presetId: string; readonly [field: string]: unknown }[];
}

/**
 * A blended look (runtime `blendEnvironment`): one sky, or
 * several different skies cross-fading (`skyLayers`, null = the background),
 * the blended fog and post.
 */
export interface EnvironmentBlendLike extends EnvironmentLike {
  readonly skyLayers?: readonly { readonly sky: SkyLike | null; readonly weight: number }[];
}

/** A scene's look (`SceneV4.environment`), laid over the project environment (its quality and presets). */
export interface EnvironmentLayerLike {
  readonly sky?: SkyLike;
  readonly fog?: FogLike;
  readonly post?: PostLike;
  readonly wind?: unknown;
}

/**
 * The project environment with a scene's look laid over it: each part
 * the look gives — `sky`, `fog` and `wind` replace the project's part whole
 * (a sky mode's fields only make sense together), `post` merges per effect
 * (a layer may change only its bloom or its grading). No layer: the base
 * unchanged.
 */
export function layerEnvironment<T extends EnvironmentLike & { readonly wind?: unknown }>(base: T | null, layer: EnvironmentLayerLike | null | undefined): (T & { readonly wind?: unknown }) | null {
  if (layer === null || layer === undefined) return base;
  const out: Record<string, unknown> = { ...(base ?? {}) };
  if (layer.sky !== undefined) out['sky'] = layer.sky;
  if (layer.fog !== undefined) out['fog'] = layer.fog;
  if (layer.wind !== undefined) out['wind'] = layer.wind;
  if (layer.post !== undefined) out['post'] = { ...(base?.post ?? {}), ...layer.post };
  return out as T;
}

/** True when an environment has anything the renderer draws (sky, fog, post or a quality level). */
export function environmentHasLook(env: { readonly sky?: unknown; readonly fog?: unknown; readonly post?: unknown; readonly quality?: unknown; readonly wind?: unknown } | null | undefined): boolean {
  return env !== null && env !== undefined && (env.sky !== undefined || env.fog !== undefined || env.post !== undefined || env.quality !== undefined);
}
/**
 * The texture assets an environment may name (a sky, its faces, the grading
 * LUT: any string there but a colour could be one), sorted — a host that replaces the
 * environment compares them to know when the textures it holds change.
 */
export function environmentTextureIds(value: { readonly sky?: unknown; readonly post?: unknown } | null): string[] {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    // A colour is never an asset id (a colour edit keeps the textures held).
    if (typeof v === 'string') {
      if (!v.startsWith('#')) out.add(v);
    }
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(value?.sky);
  walk((value?.post as { grading?: unknown } | undefined)?.grading);
  return [...out].sort();
}

export interface FogVolumeLike {
  /** World-space centre and full size. */
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly density: number;
  readonly color: string;
  readonly falloff?: number;
  /** Density fades with height above the box bottom (per metre; 0 = even). */
  readonly heightFalloff?: number;
}

export type QualityLevel = 'low' | 'medium' | 'high';

/** What each quality level allows. */
export const QUALITY_PROFILE: Readonly<Record<QualityLevel, { bloom: boolean; ssao: boolean; dof: boolean; fogVolumes: boolean; antialias: boolean }>> = {
  low: { bloom: false, ssao: false, dof: false, fogVolumes: true, antialias: false },
  medium: { bloom: true, ssao: false, dof: false, fogVolumes: true, antialias: true },
  high: { bloom: true, ssao: true, dof: true, fogVolumes: true, antialias: true },
};

/**
 * Most drawing-buffer pixels per CSS pixel a game view renders. A HiDPI or
 * scaled display (device pixel ratio 2) would otherwise draw four times the
 * pixels, every post pass included: an integrated GPU drops from a CPU-bound
 * ~40 fps to ~15 fps on a lit 3D scene. Anti-aliasing covers the edges.
 */
export const MAX_RENDER_PIXEL_RATIO = 1;

/** The pixel ratio a game view renders at on a display with `devicePixelRatio`. */
export function renderPixelRatio(devicePixelRatio: number | undefined): number {
  const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, MAX_RENDER_PIXEL_RATIO);
}

/**
 * The render settings the environment renderer draws with (the project's
 * `ambient_occlusion`, `render_scale` and `dynamic_resolution`, or a
 * player's): the kind of ambient occlusion where the look turns it on, the
 * render scale, and whether the scale may change from frame to frame (then
 * the upscaling stage is kept even at scale 1, so a change builds nothing).
 */
export interface RenderOptions {
  readonly ao: 'off' | 'ssao' | 'gtao';
  readonly scale: number;
  readonly dynamic: boolean;
  readonly upscale: UpscaleFilter;
}
export const RENDER_OPTIONS_DEFAULT: RenderOptions = Object.freeze({ ao: 'ssao', scale: 1, dynamic: false, upscale: 'fsr1' });

export interface EnvironmentRendererOptions {
  loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  /** A texture arrived or the sky was rebuilt: the host should draw a new frame. */
  onChange?: () => void;
}

export interface EnvironmentRenderer {
  /** The environment (null = none: the scene renders as before). */
  set(env: EnvironmentLike | null): void;
  /**
   * Draw a blended look over the environment (null: back to the
   * environment `set` gave). Called per frame while a blend runs: sky colours
   * and parameters, fog, exposure, grading, vignette and bloom numbers change
   * in place (uniforms: no rebuilt pass, no new program); a different sky
   * cross-fades as layers; image-based lighting follows at most every 30th frame.
   */
  setBlend(env: EnvironmentBlendLike | null): void;
  /** Where the sun is, from the scene's directional light (its `direction`, pointing away from the sun). */
  setKeyLightDirection(direction: readonly [number, number, number] | null): void;
  setFogVolumes(volumes: readonly FogVolumeLike[]): void;
  /** Override the level (a player setting); null = the environment's. */
  setQuality(level: QualityLevel | null): void;
  /** The render settings (unset parts keep their value). A scale change alone rebuilds nothing when `dynamic` is on. */
  setRender(options: Partial<RenderOptions>): void;
  /** Whether frames go through the post pipeline for the render scale alone (a host draws through this renderer then). */
  needsPipeline(): boolean;
  render(camera: THREE.Camera): void;
  /**
   * Build the node programs and pipelines the next `render`
   * draws the scene with (its post stack's scene pass, or the canvas), ahead
   * of it (`renderer.compileAsync`; the renderer must be initialised).
   */
  compileAsync(camera: THREE.Camera): Precompile;
  /** Canvas size in CSS pixels. */
  resize(width: number, height: number): void;
  /** `samples` = the MSAA samples the scene is drawn with (0: none — the low level, or a post stack with its own anti-aliasing). */
  diagnostics(): { post: boolean; passes: string[]; fallback: string | null; quality: QualityLevel; samples: number; iblRebakes: number; render: { ao: RenderOptions['ao']; scale: number; dynamic: boolean; upscale: UpscaleFilter | null; internal: [number, number] | null } };
  /** The MSAA samples of the last frame path (allocation-free, for a per-frame read). */
  samples(): number;
  dispose(): void;
}

/** A sky's structure (its mode and images): skies with the same one blend field by field. */
function skyStruct(sky: SkyLike): string {
  return sky.mode === 'texture' ? `texture|${sky.texture ?? ''}|${(sky.cube ?? []).join(',')}` : sky.mode;
}

/** One cross-fade sky layer (null mesh: the background, or an image still loading). */
interface SkyLayer {
  mesh: THREE.Mesh | null;
  material: THREE.Material | null;
  env: { texture: THREE.Texture; dispose(): void } | null;
  image: THREE.Texture | null;
}

const TONE: Record<string, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

/** The PMREM calls used here (`three/webgpu`'s generator). */
interface PmremLike {
  fromScene(scene: THREE.Scene, sigma?: number, near?: number, far?: number, options?: { renderTarget?: unknown }): { texture: THREE.Texture; dispose(): void };
  fromEquirectangular(texture: THREE.Texture): { texture: THREE.Texture; dispose(): void };
  fromCubemap(texture: THREE.CubeTexture): { texture: THREE.Texture; dispose(): void };
  dispose(): void;
}

/**
 * How far a blended sky's inputs must move from the ones the
 * image-based lighting was last baked from before it is baked again: a
 * colour channel (0–1, sRGB) by more than `color`, a procedural sky number
 * by more than `relative` of itself, the sun by more than `sunDegrees`.
 * Smaller changes are not visible in diffuse and blurred reflections, and a
 * bake (a cube render and blur passes) is the only costly part of a blend.
 */
export const SKY_REBAKE_THRESHOLD = Object.freeze({ color: 0.01, relative: 0.01, sunDegrees: 0.5 });

/** "#rrggbb" → sRGB 0–1 channels into `out` at `at` (an invalid colour counts as white). */
function srgbInto(hex: string, out: number[], at: number): void {
  const v = /^#[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex.slice(1), 16) : 0xffffff;
  out[at] = ((v >> 16) & 255) / 255;
  out[at + 1] = ((v >> 8) & 255) / 255;
  out[at + 2] = (v & 255) / 255;
}

/**
 * Whether two skies' bake inputs differ past `SKY_REBAKE_THRESHOLD`
 * (gradient: the three colours as sRGB channels; procedural: turbidity,
 * rayleigh, Mie coefficient and direction, then the unit sun direction).
 */
export function skyInputsDiffer(mode: 'gradient' | 'procedural', a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return true;
  if (mode === 'gradient') {
    for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i]! - b[i]!) > SKY_REBAKE_THRESHOLD.color) return true;
    return false;
  }
  for (let i = 0; i < 4; i += 1) {
    const scale = Math.max(Math.abs(a[i]!), Math.abs(b[i]!), 1e-6);
    if (Math.abs(a[i]! - b[i]!) > SKY_REBAKE_THRESHOLD.relative * scale) return true;
  }
  const dot = a[4]! * b[4]! + a[5]! * b[5]! + a[6]! * b[6]!;
  return dot < Math.cos(THREE.MathUtils.degToRad(SKY_REBAKE_THRESHOLD.sunDegrees));
}

export function createEnvironmentRenderer(renderer: WebGPURenderer, scene: THREE.Scene, options: EnvironmentRendererOptions): EnvironmentRenderer {
  /** The post stack (a RenderPipeline). */
  let pipeline: PostPipeline | null = null;
  let env: EnvironmentLike | null = null;
  /** The environment `set` gave (a blend draws over it; `setBlend(null)` goes back). */
  let baseEnv: EnvironmentLike | null = null;
  let blending = false;
  /** The built sky's structure (mode and images): a sky with the same one changes in place. */
  let builtStruct = '';
  /** The gradient dome's material (its colour uniforms; the image-based lighting is re-baked from it). */
  let gradientMat: THREE.Material | null = null;
  /** Image-based lighting to re-bake (a blend moved the sky past the threshold); frames since the last bake. */
  let iblDirty = false;
  /**
   * The scene the image-based lighting of a gradient or procedural
   * sky is baked from, kept while the sky is: a re-bake renders the same
   * objects (their uniforms updated) into the same target, so the scene's
   * environment texture stays the same object (a new one would rebuild every
   * lit material's nodes) and nothing is allocated or compiled per bake.
   */
  let bake: { scene: THREE.Scene; mesh: THREE.Mesh; mode: 'gradient' | 'procedural' } | null = null;
  /** The sky inputs of the last bake, and the sky's inputs now (`skyInputsDiffer`). */
  let bakedInputs: number[] = [];
  const inputsNow: number[] = [];
  let framesSinceBake = 0;
  /** Image-based lighting re-bakes of a sky changed in place (a blend, a moved sun light; diagnostics). */
  let iblRebakes = 0;
  /** The cross-fade layers by sky structure (a mesh per sky; null: the background). */
  const layers = new Map<string, SkyLayer>();
  let qualityOverride: QualityLevel | null = null;
  let render: RenderOptions = RENDER_OPTIONS_DEFAULT;
  /**
   * The scene's occlusion light (post-ao.ts): added with the first stack that
   * draws AO and kept (taking it out again would rebuild every lit program; a
   * stack without AO leaves it inactive).
   */
  let aoLight: ScreenSpaceOcclusion | null = null;
  let keyLight: [number, number, number] | null = null;
  let volumes: readonly FogVolumeLike[] = [];
  let width = 1;
  let height = 1;
  let composerKey = '';
  let fallback: string | null = null;
  let passNames: string[] = [];
  /** The MSAA samples of the last built frame path. */
  let samplesNow = renderer.samples;
  const pmrem: PmremLike = new NodePMREMGenerator(renderer) as unknown as PmremLike;
  let skyMesh: THREE.Mesh | null = null;
  let skyDome: THREE.Mesh | null = null;
  let envMap: { texture: THREE.Texture; dispose(): void } | null = null;
  /** The cube/equirect background built from a sky texture (freed with the sky). */
  let skyTexture: THREE.Texture | null = null;
  let skyKey = '';
  const textures = new Map<string, Promise<THREE.Texture | null>>();
  let disposed = false;
  /** The scene's own background, put back when a sky goes (a look without a sky after one with a colour sky). */
  const baseBackground = scene.background;

  const texture = (id: string): Promise<THREE.Texture | null> => {
    let p = textures.get(id);
    if (p === undefined) {
      p = options.loadTexture(id).catch(() => null);
      textures.set(id, p);
    }
    return p;
  };
  const quality = (): QualityLevel => qualityOverride ?? env?.quality ?? 'high';

  // ---- sky ---------------------------------------------------------------------
  const sunDirection = (sky: SkyLike): THREE.Vector3 => {
    if (sky.sunFromLight !== false && keyLight !== null) {
      return new THREE.Vector3(-keyLight[0], -keyLight[1], -keyLight[2]).normalize();
    }
    const phi = THREE.MathUtils.degToRad(90 - (sky.sunElevation ?? 35));
    const theta = THREE.MathUtils.degToRad(sky.sunAzimuth ?? 160);
    return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  };
  const clearSky = (): void => {
    if (skyMesh !== null) {
      scene.remove(skyMesh);
      skyMesh.geometry.dispose();
      (skyMesh.material as THREE.Material).dispose();
      skyMesh = null;
    }
    if (skyDome !== null) {
      scene.remove(skyDome);
      skyDome.geometry.dispose();
      (skyDome.material as THREE.Material).dispose();
      skyDome = null;
    }
    envMap?.dispose();
    envMap = null;
    if (bake !== null) {
      bake.mesh.geometry.dispose();
      // The gradient probe shares the dome's material (disposed with the dome); the procedural bake has its own sky.
      if (bake.mode === 'procedural') (bake.mesh.material as THREE.Material).dispose();
      bake = null;
    }
    bakedInputs = [];
    if (skyTexture !== null) {
      if (scene.background === skyTexture) scene.background = null;
      skyTexture.dispose();
      skyTexture = null;
    }
    scene.environment = null;
    scene.background = baseBackground;
    const s = scene as THREE.Scene & { environmentIntensity?: number; backgroundIntensity?: number };
    s.environmentIntensity = 1;
    s.backgroundIntensity = 1;
    gradientMat = null;
    builtStruct = '';
    iblDirty = false;
  };
  const applyEnvIntensity = (sky: SkyLike): void => {
    const s = scene as THREE.Scene & { environmentIntensity?: number; backgroundIntensity?: number };
    s.environmentIntensity = sky.environmentIntensity ?? 1;
    s.backgroundIntensity = sky.intensity ?? 1;
  };
  const buildSky = (): void => {
    const sky = env?.sky;
    const key = JSON.stringify(sky ?? null) + (sky?.sunFromLight !== false ? JSON.stringify(keyLight) : '');
    if (key === skyKey) return;
    skyKey = key;
    clearSky();
    if (sky === undefined) {
      return;
    }
    builtStruct = skyStruct(sky);
    applyEnvIntensity(sky);
    if (sky.mode === 'color') {
      scene.background = new THREE.Color(sky.color ?? '#7ec8ff');
      return;
    }
    if (sky.mode === 'procedural') {
      // three's TSL sky, and image-based lighting from a copy of it.
      const params = { turbidity: sky.turbidity ?? 6, rayleigh: sky.rayleigh ?? 1.5, mieCoefficient: sky.mieCoefficient ?? 0.005, mieDirectionalG: sky.mieDirectionalG ?? 0.8, sun: sunDirection(sky) };
      skyMesh = createSkyMesh(params);
      scene.background = null;
      scene.add(skyMesh);
      const tmp = new THREE.Scene();
      const clone = createSkyMesh(params);
      tmp.add(clone);
      bake = { scene: tmp, mesh: clone, mode: 'procedural' };
      bakeIbl(sky);
      return;
    }
    if (sky.mode === 'gradient') {
      const top = new THREE.Color(sky.topColor ?? '#3d7cd6');
      const horizon = new THREE.Color(sky.horizonColor ?? '#bfe3ff');
      const bottom = new THREE.Color(sky.bottomColor ?? '#757575'); // neutral grey below the horizon: no ground colour is assumed
      // On the far plane: a camera whose far plane is nearer than the dome still sees the sky.
      const mat = gradientSkyMaterial(top, horizon, bottom);
      gradientMat = mat;
      skyDome = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), mat);
      skyDome.frustumCulled = false;
      scene.background = null;
      scene.add(skyDome);
      const tmp = new THREE.Scene();
      const probe = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat);
      tmp.add(probe);
      bake = { scene: tmp, mesh: probe, mode: 'gradient' };
      bakeIbl(sky);
      return;
    }
    // texture: an equirect image or six faces.
    if (sky.cube !== undefined && sky.cube.length === 6) {
      void Promise.all(sky.cube.map((id) => texture(id))).then((faces) => {
        if (disposed || key !== skyKey || faces.some((f) => f === null)) return;
        const cube = new THREE.CubeTexture(faces.map((f) => (f as THREE.Texture).image));
        cube.colorSpace = THREE.SRGBColorSpace;
        cube.needsUpdate = true;
        skyTexture = cube;
        scene.background = cube;
        envMap = pmrem.fromCubemap(cube);
        scene.environment = envMap.texture;
        options.onChange?.();
      });
    } else if (sky.texture !== undefined) {
      void texture(sky.texture).then((t) => {
        if (t === null || disposed || key !== skyKey) return;
        // The sky image goes through a canvas: WebGL ignores flipY for an
        // ImageBitmap but applies it to a canvas, and the equirect lookup
        // wants the image flipped (v = 1 at the top row) like any three
        // texture (tests/e2e/sky-texture.e2e.ts pins it in Play).
        let image: unknown = t.image;
        const src = image as { width?: number; height?: number };
        if (typeof document !== 'undefined' && src.width !== undefined && src.height !== undefined && typeof HTMLCanvasElement !== 'undefined' && !(image instanceof HTMLCanvasElement)) {
          const c = document.createElement('canvas');
          c.width = src.width;
          c.height = src.height;
          const g = c.getContext('2d');
          if (g !== null) {
            g.drawImage(image as CanvasImageSource, 0, 0);
            image = c;
          }
        }
        const eq = new THREE.Texture(image as HTMLImageElement);
        eq.mapping = THREE.EquirectangularReflectionMapping;
        eq.colorSpace = THREE.SRGBColorSpace;
        eq.flipY = true;
        eq.needsUpdate = true;
        skyTexture = eq;
        scene.background = eq;
        envMap = pmrem.fromEquirectangular(eq);
        scene.environment = envMap.texture;
        options.onChange?.();
      });
    }
  };

  // ---- Blends (the sky in place, cross-fade layers) ----------------------------
  const procParams = (sky: SkyLike): Parameters<typeof createSkyMesh>[0] => ({ turbidity: sky.turbidity ?? 6, rayleigh: sky.rayleigh ?? 1.5, mieCoefficient: sky.mieCoefficient ?? 0.005, mieDirectionalG: sky.mieDirectionalG ?? 0.8, sun: sunDirection(sky) });
  /** A gradient or procedural sky's bake inputs into `out` (see `skyInputsDiffer`). */
  const skyInputs = (sky: SkyLike, out: number[], params?: ReturnType<typeof procParams>): void => {
    out.length = 0;
    if (sky.mode === 'gradient') {
      srgbInto(sky.topColor ?? '#3d7cd6', out, 0);
      srgbInto(sky.horizonColor ?? '#bfe3ff', out, 3);
      srgbInto(sky.bottomColor ?? '#757575', out, 6);
    } else if (sky.mode === 'procedural') {
      const p = params ?? procParams(sky);
      out.push(p.turbidity, p.rayleigh, p.mieCoefficient, p.mieDirectionalG, p.sun.x, p.sun.y, p.sun.z);
    }
  };
  /**
   * Bake the image-based lighting from the bake scene (its sky as `sky` is
   * now): into the target of the last bake when there is one.
   */
  const bakeIbl = (sky: SkyLike): void => {
    if (bake === null) return;
    const params = bake.mode === 'procedural' ? procParams(sky) : undefined;
    if (params !== undefined) setSkyUniforms(bake.mesh, params);
    envMap = pmrem.fromScene(bake.scene, 0, 0.1, bake.mode === 'procedural' ? 10000 : 100, envMap !== null ? { renderTarget: envMap } : {});
    scene.environment = envMap.texture;
    skyInputs(sky, bakedInputs, params);
  };
  /** Re-bake the image-based lighting from the sky as it is now (a blend moved it past the threshold). */
  const rebakeIbl = (): void => {
    iblDirty = false;
    framesSinceBake = 0;
    const sky = env?.sky;
    if (sky === undefined || layers.size > 0 || bake === null || bake.mode !== sky.mode) return;
    iblRebakes += 1;
    bakeIbl(sky);
  };
  /** The procedural sky's uniforms (three's SkyMesh). */
  const setSkyUniforms = (mesh: THREE.Mesh, p: ReturnType<typeof procParams>): void => {
    const m = mesh as THREE.Mesh & { turbidity: { value: number }; rayleigh: { value: number }; mieCoefficient: { value: number }; mieDirectionalG: { value: number }; sunPosition: { value: THREE.Vector3 } };
    m.turbidity.value = p.turbidity;
    m.rayleigh.value = p.rayleigh;
    m.mieCoefficient.value = p.mieCoefficient;
    m.mieDirectionalG.value = p.mieDirectionalG;
    m.sunPosition.value.copy(p.sun);
  };
  /** The built sky takes this sky's numbers (same structure): uniforms, a background colour, intensities. */
  const updateSkyInPlace = (sky: SkyLike): void => {
    applyEnvIntensity(sky);
    if (sky.mode === 'gradient' && gradientMat !== null) {
      const u = gradientSkyUniforms(gradientMat);
      u?.top.value.set(sky.topColor ?? '#3d7cd6');
      u?.horizon.value.set(sky.horizonColor ?? '#bfe3ff');
      u?.bottom.value.set(sky.bottomColor ?? '#757575');
      skyInputs(sky, inputsNow);
      iblDirty = skyInputsDiffer('gradient', inputsNow, bakedInputs);
    } else if (sky.mode === 'procedural' && skyMesh !== null) {
      const p = procParams(sky);
      setSkyUniforms(skyMesh, p);
      skyInputs(sky, inputsNow, p);
      iblDirty = skyInputsDiffer('procedural', inputsNow, bakedInputs);
    } else if (sky.mode === 'color' && (scene.background as THREE.Color | null)?.isColor === true) {
      (scene.background as THREE.Color).set(sky.color ?? '#7ec8ff');
    }
    // The static path's key follows (a later `set` with this sky changes nothing).
    skyKey = JSON.stringify(sky) + (sky.sunFromLight !== false ? JSON.stringify(keyLight) : '');
  };
  const disposeLayer = (l: SkyLayer): void => {
    if (l.mesh !== null) {
      scene.remove(l.mesh);
      l.mesh.geometry.dispose();
    }
    l.material?.dispose();
    l.env?.dispose();
    l.image?.dispose();
  };
  const disposeLayers = (): void => {
    for (const l of layers.values()) disposeLayer(l);
    layers.clear();
  };
  /** One cross-fade layer's mesh (built once per sky structure; its numbers updated per frame). */
  const layerFor = (key: string, sky: SkyLike | null): SkyLayer => {
    const had = layers.get(key);
    if (had !== undefined) return had;
    const rec: SkyLayer = { mesh: null, material: null, env: null, image: null };
    layers.set(key, rec);
    if (sky === null) return rec;
    const addDome = (material: THREE.Material): void => {
      material.transparent = true;
      material.opacity = 0;
      rec.material = material;
      rec.mesh = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), material);
      rec.mesh.frustumCulled = false;
      scene.add(rec.mesh);
    };
    if (sky.mode === 'gradient') {
      const mat = gradientSkyMaterial(new THREE.Color(sky.topColor ?? '#3d7cd6'), new THREE.Color(sky.horizonColor ?? '#bfe3ff'), new THREE.Color(sky.bottomColor ?? '#757575'));
      addDome(mat);
      const tmp = new THREE.Scene();
      const probe = new THREE.SphereGeometry(10, 32, 16);
      tmp.add(new THREE.Mesh(probe, mat));
      rec.env = pmrem.fromScene(tmp, 0, 0.1, 100);
      probe.dispose();
    } else if (sky.mode === 'color') {
      addDome(imageSkyMaterial({ color: new THREE.Color(sky.color ?? '#7ec8ff') }));
    } else if (sky.mode === 'procedural') {
      const params = procParams(sky);
      const mesh = createSkyMesh(params);
      const material = mesh.material as THREE.Material;
      material.transparent = true;
      material.opacity = 0;
      rec.material = material;
      rec.mesh = mesh;
      scene.add(mesh);
      const tmp = new THREE.Scene();
      const clone = createSkyMesh(params);
      tmp.add(clone);
      rec.env = pmrem.fromScene(tmp, 0, 0.1, 10000);
      clone.geometry.dispose();
      (clone.material as THREE.Material).dispose();
    } else if (sky.cube !== undefined && sky.cube.length === 6) {
      void Promise.all(sky.cube.map((id) => texture(id))).then((faces) => {
        if (disposed || layers.get(key) !== rec || faces.some((f) => f === null)) return;
        const cube = new THREE.CubeTexture(faces.map((f) => (f as THREE.Texture).image));
        cube.colorSpace = THREE.SRGBColorSpace;
        cube.needsUpdate = true;
        rec.image = cube;
        addDome(imageSkyMaterial({ cube }));
        rec.env = pmrem.fromCubemap(cube);
        options.onChange?.();
      });
    } else if (sky.texture !== undefined) {
      void texture(sky.texture).then((t) => {
        if (t === null || disposed || layers.get(key) !== rec) return;
        const eq = new THREE.Texture(t.image as HTMLImageElement);
        eq.colorSpace = THREE.SRGBColorSpace;
        eq.flipY = true;
        eq.needsUpdate = true;
        rec.image = eq;
        addDome(imageSkyMaterial({ equirect: eq }));
        const refl = eq.clone();
        refl.mapping = THREE.EquirectangularReflectionMapping;
        refl.needsUpdate = true;
        rec.env = pmrem.fromEquirectangular(refl);
        options.onChange?.();
      });
    }
    return rec;
  };
  /**
   * Cross-fade: every sky a dome over the background, drawn in order with
   * opacity = its weight over the weights drawn so far (so the picture is the
   * weighted mix); the image-based lighting is the heaviest sky's.
   */
  const applyLayers = (list: readonly { readonly sky: SkyLike | null; readonly weight: number }[]): void => {
    if (builtStruct !== '' || skyMesh !== null || skyDome !== null || envMap !== null || skyTexture !== null) {
      clearSky();
      skyKey = '';
    }
    const wantedKeys = new Set<string>();
    let drawn = 0;
    let heaviest: { key: string; weight: number; sky: SkyLike | null } = { key: '-', weight: -1, sky: null };
    list.forEach((entry, i) => {
      const key = entry.sky === null ? '-' : skyStruct(entry.sky);
      wantedKeys.add(key);
      const l = layerFor(key, entry.sky);
      if (entry.weight > heaviest.weight) heaviest = { key, weight: entry.weight, sky: entry.sky };
      drawn += entry.weight;
      if (entry.sky === null) return;
      const opacity = drawn <= 0 ? 0 : entry.weight / drawn;
      if (l.material !== null) {
        l.material.opacity = opacity;
        if (entry.sky.mode === 'gradient') {
          const u = gradientSkyUniforms(l.material);
          u?.top.value.set(entry.sky.topColor ?? '#3d7cd6');
          u?.horizon.value.set(entry.sky.horizonColor ?? '#bfe3ff');
          u?.bottom.value.set(entry.sky.bottomColor ?? '#757575');
        } else if (entry.sky.mode === 'color') (l.material as THREE.Material & { color: THREE.Color }).color.set(entry.sky.color ?? '#7ec8ff');
      }
      if (l.mesh !== null) {
        l.mesh.renderOrder = -1000 + i;
        l.mesh.visible = opacity > 0;
      }
    });
    for (const [key, l] of [...layers.entries()]) {
      if (wantedKeys.has(key)) continue;
      disposeLayer(l);
      layers.delete(key);
    }
    scene.environment = layers.get(heaviest.key)?.env?.texture ?? null;
    const s = scene as THREE.Scene & { environmentIntensity?: number };
    s.environmentIntensity = heaviest.sky?.environmentIntensity ?? 1;
    scene.background = baseBackground;
  };

  // ---- fog -----------------------------------------------------------------------
  const applyFog = (): void => {
    const f = env?.fog;
    if (f === undefined || f.mode === 'none') {
      scene.fog = null;
      return;
    }
    // The same kind of fog changes in place (a new fog object would mean new programs).
    const cur = scene.fog as THREE.Fog | THREE.FogExp2 | null;
    if (f.mode === 'linear' && cur instanceof THREE.Fog) {
      cur.color.set(f.color);
      cur.near = f.near ?? 10;
      cur.far = f.far ?? 120;
      return;
    }
    if (f.mode === 'exp2' && cur instanceof THREE.FogExp2) {
      cur.color.set(f.color);
      cur.density = f.density ?? 0.01;
      return;
    }
    scene.fog = f.mode === 'linear' ? new THREE.Fog(f.color, f.near ?? 10, f.far ?? 120) : new THREE.FogExp2(f.color, f.density ?? 0.01);
  };

  // ---- post ----------------------------------------------------------------------
  const wanted = (): { bloom: boolean; ssao: boolean; dof: boolean; fogVolumes: boolean; grading: boolean; aa: 'none' | 'fxaa' | 'smaa' } => {
    const p = env?.post;
    const q = QUALITY_PROFILE[quality()];
    const g = p?.grading;
    return {
      bloom: q.bloom && p?.bloom?.enabled === true,
      ssao: q.ssao && p?.ssao?.enabled === true && render.ao !== 'off',
      dof: q.dof && p?.dof?.enabled === true,
      fogVolumes: q.fogVolumes && volumes.length > 0,
      grading: (g !== undefined && (g.brightness !== undefined || g.contrast !== undefined || g.saturation !== undefined || g.tint !== undefined || g.lut !== undefined || g.lift !== undefined || g.gamma !== undefined || g.gain !== undefined)) || p?.vignette?.enabled === true,
      aa: q.antialias ? (p?.antialias ?? 'none') : 'none',
    };
  };

  const anyPost = (w: ReturnType<typeof wanted>): boolean => w.bloom || w.ssao || w.dof || w.fogVolumes || w.grading || w.aa !== 'none';

  // ---- The post stack (a RenderPipeline) ----------------------------------
  const disposePipeline = (): void => {
    pipeline?.dispose();
    pipeline = null;
    passNames = [];
  };
  const buildPipeline = (camera: THREE.Camera): void => {
    const w = wanted();
    // The low level has no anti-aliasing: on WebGPURenderer that includes MSAA, so it draws
    // through a plain scene pass (no samples) even without post effects.
    const noMsaa = !QUALITY_PROFILE[quality()].antialias;
    const isPost = anyPost(w);
    // A render scale below 1 (or one dynamic resolution may lower) draws through the pipeline's upscale.
    const upscaling = render.scale < 1 || render.dynamic;
    // Without a post stack a colour or sRGB image background is shown as it is (not tone mapped,
    // as the archived WebGL renderer drew it); WebGPURenderer tone maps the whole frame, so the
    // background gets its own pass.
    const bg = scene.background as (THREE.Color | THREE.Texture | null) & { isColor?: boolean; isTexture?: boolean };
    const displayBackground = !isPost && renderer.toneMapping !== THREE.NoToneMapping && bg !== null && (bg.isColor === true || (bg.isTexture === true && (bg as THREE.Texture).colorSpace === THREE.SRGBColorSpace));
    const post = env?.post;
    // The numbers the passes take as uniforms (grading, vignette, bloom) are not part of
    // the key (nor the exposure, a renderer setting): a blend or an edit of them updates the built stack
    // (postParams) instead of rebuilding it.
    const structure = [post?.toneMapping ?? null, post?.grading?.lut ?? null, post?.ssao ?? null, post?.dof ?? null, post?.antialias ?? null];
    // The scale itself is not in the key: the built stack follows it in place.
    const key = JSON.stringify({ w, structure, q: quality(), cam: camera.uuid, noMsaa, displayBackground, ao: w.ssao ? render.ao : null, upscale: upscaling ? render.upscale : null });
    if (key === composerKey) return;
    composerKey = key;
    disposePipeline();
    samplesNow = renderer.samples;
    if (!isPost && !noMsaa && !displayBackground && !upscaling) return;
    const g = post?.grading;
    const perspective = camera instanceof THREE.PerspectiveCamera;
    const plan: PostPlan = {
      ao: w.ssao && perspective && render.ao !== 'off' ? { kind: render.ao, radius: post?.ssao?.radius ?? 0.5, intensity: post?.ssao?.intensity ?? 1 } : null,
      fogVolumes: w.fogVolumes,
      dof: w.dof && perspective ? { focus: post?.dof?.focus ?? 10, aperture: post?.dof?.aperture ?? 0.002, maxBlur: post?.dof?.maxBlur ?? 0.01 } : null,
      bloom: w.bloom ? { strength: post?.bloom?.strength ?? 0.6, radius: post?.bloom?.radius ?? 0.4, threshold: post?.bloom?.threshold ?? 0.85 } : null,
      grading: w.grading
        ? {
            brightness: g?.brightness ?? 0,
            contrast: g?.contrast ?? 0,
            saturation: g?.saturation ?? 0,
            tint: g?.tint ?? '#ffffff',
            lift: g?.lift ?? 0,
            gamma: g?.gamma ?? 1,
            gain: g?.gain ?? 1,
            vignette: post?.vignette?.enabled === true ? (post.vignette.darkness ?? 0.5) : 0,
            vignetteOffset: post?.vignette?.offset ?? 1,
          }
        : null,
      aa: w.aa,
      displayBackground,
      // The post stack renders without MSAA (as the archived EffectComposer did); a plain frame keeps the renderer's.
      samples: isPost || noMsaa ? 0 : renderer.samples,
      upscale: upscaling ? { filter: render.upscale, scale: render.scale } : null,
    };
    if (plan.ao !== null && aoLight === null) {
      aoLight = new ScreenSpaceOcclusion();
      scene.add(aoLight);
    }
    try {
      const p = buildPostPipeline(renderer, scene, camera, plan, aoLight);
      p.setSize(width, height, renderer.getPixelRatio());
      pipeline = p;
      samplesNow = plan.samples;
      // A plain frame (the background pass, no MSAA at low quality, or only the upscale) is not post-processing.
      passNames = isPost ? [...p.passes] : [];
      fallback = null;
      if (plan.grading !== null && g?.lut !== undefined) {
        void texture(g.lut).then((t) => {
          if (t === null || disposed || pipeline !== p) return;
          const lut = t.clone();
          lut.colorSpace = THREE.NoColorSpace;
          lut.flipY = false;
          lut.generateMipmaps = false;
          lut.minFilter = THREE.LinearFilter;
          lut.needsUpdate = true;
          p.setLut(lut);
          options.onChange?.();
        });
      }
    } catch (e) {
      disposePipeline();
      fallback = `post-processing is off: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    }
  };
  /** The uniform numbers of the post stack from the drawn environment. */
  const postParams = (): Pick<PostPlan, 'grading' | 'bloom'> => {
    const post = env?.post;
    const g = post?.grading;
    const w = wanted();
    return {
      grading: w.grading
        ? {
            brightness: g?.brightness ?? 0,
            contrast: g?.contrast ?? 0,
            saturation: g?.saturation ?? 0,
            tint: g?.tint ?? '#ffffff',
            lift: g?.lift ?? 0,
            gamma: g?.gamma ?? 1,
            gain: g?.gain ?? 1,
            vignette: post?.vignette?.enabled === true ? (post.vignette.darkness ?? 0.5) : 0,
            vignetteOffset: post?.vignette?.offset ?? 1,
          }
        : null,
      bloom: w.bloom ? { strength: post?.bloom?.strength ?? 0.6, radius: post?.bloom?.radius ?? 0.4, threshold: post?.bloom?.threshold ?? 0.85 } : null,
    };
  };
  const volumeBoxes = (): FogVolumeBox[] =>
    volumes.map((v) => ({
      min: [v.center[0] - v.size[0] / 2, v.center[1] - v.size[1] / 2, v.center[2] - v.size[2] / 2],
      max: [v.center[0] + v.size[0] / 2, v.center[1] + v.size[1] / 2, v.center[2] + v.size[2] / 2],
      color: v.color,
      density: v.density,
      falloff: v.falloff ?? 0.5,
      heightFalloff: v.heightFalloff ?? 0,
    }));

  const self: EnvironmentRenderer = {
    setBlend(next) {
      if (next === null) {
        if (!blending) return;
        blending = false;
        disposeLayers();
        clearSky();
        skyKey = '';
        self.set(baseEnv);
        return;
      }
      blending = true;
      env = next;
      const p = next.post;
      const tone = TONE[p?.toneMapping ?? 'agx'] ?? THREE.NoToneMapping;
      if (renderer.toneMapping !== tone) renderer.toneMapping = tone;
      renderer.toneMappingExposure = p?.exposure ?? 1;
      applyFog();
      if (next.skyLayers !== undefined && next.skyLayers.length > 1) applyLayers(next.skyLayers);
      else {
        if (layers.size > 0) disposeLayers();
        const sky = next.sky;
        if (sky !== undefined && builtStruct !== '' && builtStruct === skyStruct(sky)) updateSkyInPlace(sky);
        else buildSky();
      }
      options.onChange?.();
    },
    set(next) {
      baseEnv = next;
      if (blending) return; // a blend draws over it; `setBlend(null)` goes back to it
      env = next;
      const p = next?.post;
      renderer.toneMapping = TONE[p?.toneMapping ?? (next === null ? 'none' : 'agx')] ?? THREE.NoToneMapping;
      renderer.toneMappingExposure = p?.exposure ?? 1;
      buildSky();
      applyFog();
      // The pipeline's key holds everything it is built from (a sky colour edit
      // does not rebuild and recompile it).
      options.onChange?.();
    },
    setKeyLightDirection(direction) {
      const same = JSON.stringify(direction) === JSON.stringify(keyLight);
      keyLight = direction === null ? null : [direction[0], direction[1], direction[2]];
      if (same) return;
      // A sun that follows the light moves in place (no new sky; the lighting is re-baked a little later).
      const sky = env?.sky;
      if (sky !== undefined && sky.mode === 'procedural' && sky.sunFromLight !== false && skyMesh !== null && layers.size === 0) updateSkyInPlace(sky);
      else if (layers.size === 0) buildSky();
    },
    setFogVolumes(list) {
      const changedCount = (list.length > 0) !== (volumes.length > 0);
      volumes = list.slice(0, MAX_FOG_VOLUMES);
      if (changedCount) composerKey = '';
    },
    setQuality(level) {
      qualityOverride = level;
      composerKey = '';
    },
    setRender(next) {
      const was = render;
      render = { ...render, ...next };
      // What the stack is built with: the AO kind, the upscale stage (present below scale 1 or under dynamic resolution).
      const upscaled = (o: RenderOptions): boolean => o.scale < 1 || o.dynamic;
      if (render.ao !== was.ao || upscaled(render) !== upscaled(was) || render.upscale !== was.upscale) composerKey = '';
      else if (render.scale !== was.scale) pipeline?.setScale(render.scale);
    },
    needsPipeline: () => render.scale < 1 || render.dynamic,
    render(camera) {
      if (disposed) return;
      // The lighting of a sky a blend changed, at most every 30th frame (a PMREM bake is not free: a cube render and blur passes);
      // Only once the sky moved past SKY_REBAKE_THRESHOLD from the last bake.
      framesSinceBake += 1;
      if (iblDirty && framesSinceBake >= 30) rebakeIbl();
      buildPipeline(camera);
      pipeline?.setParams(postParams());
      if (pipeline === null) {
        renderer.render(scene, camera);
        return;
      }
      pipeline.update(camera, volumeBoxes());
      pipeline.render();
    },
    compileAsync(camera) {
      if (disposed) return settledPrecompile;
      buildPipeline(camera);
      pipeline?.setParams(postParams());
      if (pipeline === null) return compileIntoTarget(renderer, scene, camera, renderer.getRenderTarget(), renderer.getMRT());
      pipeline.update(camera, volumeBoxes());
      return pipeline.compileAsync(camera);
    },
    resize(w, h) {
      const nw = Math.max(1, Math.floor(w));
      const nh = Math.max(1, Math.floor(h));
      if (nw === width && nh === height) return; // a same-size resize must not rebuild the post stack
      width = nw;
      height = nh;
      // The node passes follow the canvas size themselves (only the depth of field's pixel blur needs it).
      pipeline?.setSize(width, height, renderer.getPixelRatio());
    },
    samples: () => samplesNow,
    diagnostics() {
      const upscaled = pipeline !== null && (render.scale < 1 || render.dynamic);
      return {
        post: passNames.length > 0,
        passes: [...passNames],
        fallback,
        quality: quality(),
        samples: samplesNow,
        iblRebakes,
        render: { ao: render.ao, scale: render.scale, dynamic: render.dynamic, upscale: upscaled ? render.upscale : null, internal: pipeline?.internalSize() ?? null },
      };
    },
    dispose() {
      disposed = true;
      disposePipeline();
      if (aoLight !== null) {
        scene.remove(aoLight);
        aoLight.dispose();
        aoLight = null;
      }
      disposeLayers();
      clearSky();
      pmrem.dispose();
    },
  };
  return self;
}
