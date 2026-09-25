/**
 * Phase 9.5: the environment renderer — sky, image-based lighting, fog, fog
 * volumes, tone mapping and the post stack — shared by the editor's Scene
 * view and Play/export. It replaces `renderer.render(scene, camera)`.
 *
 * Pass order (each only when enabled and allowed by the quality level):
 * render → ambient occlusion (GTAO) → fog volumes (from the scene pass's
 * depth) → depth of field → bloom → output (tone mapping + sRGB) → grading
 * (brightness/contrast/saturation/tint, LUT strip, vignette) → anti-aliasing
 * (SMAA/FXAA). With nothing enabled it renders directly (the renderer's own
 * tone mapping).
 *
 * Capability fallback: if the post pipeline cannot be built, rendering falls
 * back to the direct path and `diagnostics().fallback` says why; gameplay
 * never depends on it.
 *
 * Phase 17.3/17.4: three's WebGPURenderer (WebGPU or its WebGL 2 backend)
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

import { buildPostPipeline, createSkyMesh, gradientSkyMaterial, MAX_FOG_VOLUMES, type FogVolumeBox, type PostPipeline, type PostPlan } from './environment-nodes';

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
}

/** Phase 14.4: a level's look (`flow.levels[].environment`), laid over the project environment. */
export interface EnvironmentLayerLike {
  readonly sky?: SkyLike;
  readonly fog?: FogLike;
  readonly post?: PostLike;
  readonly wind?: unknown;
}

/**
 * Phase 14.4: the environment a level plays with — the project's, with each
 * part the level gives laid over it: `sky`, `fog` and `wind` replace the
 * project's part whole (a sky mode's fields only make sense together), `post`
 * merges per effect (a level may change only its bloom or its grading). No
 * layer: the base unchanged.
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
export interface FogVolumeLike {
  /** World-space centre and full size. */
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly density: number;
  readonly color: string;
  readonly falloff?: number;
  /** Phase 14.4: density fades with height above the box bottom (per metre; 0 = even). */
  readonly heightFalloff?: number;
}

export type QualityLevel = 'low' | 'medium' | 'high';

/** What each quality level allows. */
export const QUALITY_PROFILE: Readonly<Record<QualityLevel, { pixelRatio: number; bloom: boolean; ssao: boolean; dof: boolean; fogVolumes: boolean; antialias: boolean }>> = {
  low: { pixelRatio: 1, bloom: false, ssao: false, dof: false, fogVolumes: true, antialias: false },
  medium: { pixelRatio: 1.5, bloom: true, ssao: false, dof: false, fogVolumes: true, antialias: true },
  high: { pixelRatio: 2, bloom: true, ssao: true, dof: true, fogVolumes: true, antialias: true },
};

export interface EnvironmentRendererOptions {
  loadTexture: (assetId: string) => Promise<THREE.Texture | null>;
  /** A texture arrived or the sky was rebuilt: the host should draw a new frame. */
  onChange?: () => void;
}

export interface EnvironmentRenderer {
  /** The environment (null = none: the scene renders as before). */
  set(env: EnvironmentLike | null): void;
  /** Where the sun is, from the scene's directional light (its `direction`, pointing away from the sun). */
  setKeyLightDirection(direction: readonly [number, number, number] | null): void;
  setFogVolumes(volumes: readonly FogVolumeLike[]): void;
  /** Override the level (a player setting); null = the environment's. */
  setQuality(level: QualityLevel | null): void;
  render(camera: THREE.Camera): void;
  /** Canvas size in CSS pixels. */
  resize(width: number, height: number): void;
  /** Phase 21.3: `samples` = the MSAA samples the scene is drawn with (0: none — the low level, or a post stack with its own anti-aliasing). */
  diagnostics(): { post: boolean; passes: string[]; fallback: string | null; quality: QualityLevel; samples: number };
  /** Phase 21.3: the MSAA samples of the last frame path (allocation-free, for a per-frame read). */
  samples(): number;
  dispose(): void;
}

const TONE: Record<string, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

/** The PMREM calls used here (`three/webgpu`'s generator). */
interface PmremLike {
  fromScene(scene: THREE.Scene, sigma?: number, near?: number, far?: number): { texture: THREE.Texture; dispose(): void };
  fromEquirectangular(texture: THREE.Texture): { texture: THREE.Texture; dispose(): void };
  fromCubemap(texture: THREE.CubeTexture): { texture: THREE.Texture; dispose(): void };
  dispose(): void;
}

export function createEnvironmentRenderer(renderer: WebGPURenderer, scene: THREE.Scene, options: EnvironmentRendererOptions): EnvironmentRenderer {
  /** Phase 17.3: the post stack (a RenderPipeline). */
  let pipeline: PostPipeline | null = null;
  let env: EnvironmentLike | null = null;
  let qualityOverride: QualityLevel | null = null;
  let keyLight: [number, number, number] | null = null;
  let volumes: readonly FogVolumeLike[] = [];
  let width = 1;
  let height = 1;
  let composerKey = '';
  let fallback: string | null = null;
  let passNames: string[] = [];
  /** Phase 21.3: the MSAA samples of the last built frame path. */
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
  /** The scene's own background, put back when a sky goes (a level without a sky after one with a colour sky). */
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
    applyEnvIntensity(sky);
    if (sky.mode === 'color') {
      scene.background = new THREE.Color(sky.color ?? '#7ec8ff');
      return;
    }
    if (sky.mode === 'procedural') {
      // Phase 17.3: three's TSL sky, and image-based lighting from a copy of it.
      const params = { turbidity: sky.turbidity ?? 6, rayleigh: sky.rayleigh ?? 1.5, mieCoefficient: sky.mieCoefficient ?? 0.005, mieDirectionalG: sky.mieDirectionalG ?? 0.8, sun: sunDirection(sky) };
      skyMesh = createSkyMesh(params);
      scene.background = null;
      scene.add(skyMesh);
      const tmp = new THREE.Scene();
      const clone = createSkyMesh(params);
      tmp.add(clone);
      envMap = pmrem.fromScene(tmp, 0, 0.1, 10000);
      scene.environment = envMap.texture;
      clone.geometry.dispose();
      (clone.material as THREE.Material).dispose();
      return;
    }
    if (sky.mode === 'gradient') {
      const top = new THREE.Color(sky.topColor ?? '#3d7cd6');
      const horizon = new THREE.Color(sky.horizonColor ?? '#bfe3ff');
      const bottom = new THREE.Color(sky.bottomColor ?? '#757575'); // phase 15.5: neutral grey below the horizon (was a grass olive)
      // On the far plane (phase 17.3): a camera whose far plane is nearer than the dome still sees the sky.
      const mat = gradientSkyMaterial(top, horizon, bottom);
      skyDome = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), mat);
      skyDome.frustumCulled = false;
      scene.background = null;
      scene.add(skyDome);
      const tmp = new THREE.Scene();
      const probe = new THREE.SphereGeometry(10, 32, 16);
      tmp.add(new THREE.Mesh(probe, mat));
      envMap = pmrem.fromScene(tmp, 0, 0.1, 100);
      scene.environment = envMap.texture;
      probe.dispose();
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

  // ---- fog -----------------------------------------------------------------------
  const applyFog = (): void => {
    const f = env?.fog;
    if (f === undefined || f.mode === 'none') {
      scene.fog = null;
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
      ssao: q.ssao && p?.ssao?.enabled === true,
      dof: q.dof && p?.dof?.enabled === true,
      fogVolumes: q.fogVolumes && volumes.length > 0,
      grading: (g !== undefined && (g.brightness !== undefined || g.contrast !== undefined || g.saturation !== undefined || g.tint !== undefined || g.lut !== undefined || g.lift !== undefined || g.gamma !== undefined || g.gain !== undefined)) || p?.vignette?.enabled === true,
      aa: q.antialias ? (p?.antialias ?? 'none') : 'none',
    };
  };

  const anyPost = (w: ReturnType<typeof wanted>): boolean => w.bloom || w.ssao || w.dof || w.fogVolumes || w.grading || w.aa !== 'none';

  // ---- Phase 17.3: the post stack (a RenderPipeline) ----------------------------------
  const disposePipeline = (): void => {
    pipeline?.dispose();
    pipeline = null;
    passNames = [];
  };
  /** A pixel ratio for the post passes (the quality level's, never above the device's), relative to the renderer's. */
  const postScale = (): number => {
    const target = Math.min(QUALITY_PROFILE[quality()].pixelRatio, globalThis.devicePixelRatio ?? 1);
    return target / Math.max(1e-6, renderer.getPixelRatio());
  };
  const buildPipeline = (camera: THREE.Camera): void => {
    const w = wanted();
    // The low level has no anti-aliasing: on WebGPURenderer that includes MSAA, so it draws
    // through a plain scene pass (no samples) even without post effects.
    const noMsaa = !QUALITY_PROFILE[quality()].antialias;
    const isPost = anyPost(w);
    // Without a post stack a colour or sRGB image background is shown as it is (not tone mapped,
    // as the archived WebGL renderer drew it); WebGPURenderer tone maps the whole frame, so the
    // background gets its own pass.
    const bg = scene.background as (THREE.Color | THREE.Texture | null) & { isColor?: boolean; isTexture?: boolean };
    const displayBackground = !isPost && renderer.toneMapping !== THREE.NoToneMapping && bg !== null && (bg.isColor === true || (bg.isTexture === true && (bg as THREE.Texture).colorSpace === THREE.SRGBColorSpace));
    const post = env?.post;
    const key = JSON.stringify({ w, post, q: quality(), cam: camera.uuid, scale: postScale(), noMsaa, displayBackground });
    if (key === composerKey) return;
    composerKey = key;
    disposePipeline();
    samplesNow = renderer.samples;
    if (!isPost && !noMsaa && !displayBackground) return;
    const g = post?.grading;
    const perspective = camera instanceof THREE.PerspectiveCamera;
    const plan: PostPlan = {
      ssao: w.ssao && perspective ? { radius: post?.ssao?.radius ?? 0.5, intensity: post?.ssao?.intensity ?? 1 } : null,
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
      resolutionScale: isPost ? postScale() : 1,
      displayBackground,
      // The post stack renders without MSAA (as the archived EffectComposer did); a plain frame keeps the renderer's.
      samples: isPost || noMsaa ? 0 : renderer.samples,
    };
    try {
      const p = buildPostPipeline(renderer, scene, camera, plan);
      p.setSize(width, height, renderer.getPixelRatio());
      pipeline = p;
      samplesNow = plan.samples;
      // A plain frame (the background pass, or no MSAA at low quality) is not post-processing.
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
  const volumeBoxes = (): FogVolumeBox[] =>
    volumes.map((v) => ({
      min: [v.center[0] - v.size[0] / 2, v.center[1] - v.size[1] / 2, v.center[2] - v.size[2] / 2],
      max: [v.center[0] + v.size[0] / 2, v.center[1] + v.size[1] / 2, v.center[2] + v.size[2] / 2],
      color: v.color,
      density: v.density,
      falloff: v.falloff ?? 0.5,
      heightFalloff: v.heightFalloff ?? 0,
    }));

  return {
    set(next) {
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
      if (!same) buildSky();
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
    render(camera) {
      if (disposed) return;
      buildPipeline(camera);
      if (pipeline === null) {
        renderer.render(scene, camera);
        return;
      }
      pipeline.update(camera, volumeBoxes());
      pipeline.render();
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
      return { post: passNames.length > 0, passes: [...passNames], fallback, quality: quality(), samples: samplesNow };
    },
    dispose() {
      disposed = true;
      disposePipeline();
      clearSky();
      pmrem.dispose();
    },
  };
}
