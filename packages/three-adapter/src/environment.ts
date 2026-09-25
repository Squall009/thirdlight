/**
 * Phase 9.5: the environment renderer — sky, image-based lighting, fog, fog
 * volumes, tone mapping and the post stack — shared by the editor's Scene
 * view and Play/export. It replaces `renderer.render(scene, camera)`.
 *
 * Pass order (each only when enabled and allowed by the quality level):
 * render → ambient occlusion (GTAO) → fog volumes (from a depth pre-pass) →
 * depth of field (Bokeh) → bloom (UnrealBloom) → output (tone mapping + sRGB)
 * → grading (brightness/contrast/saturation/tint, LUT strip, vignette) →
 * anti-aliasing (SMAA/FXAA). With nothing enabled it renders directly (the
 * renderer's own tone mapping).
 *
 * Capability fallback: if the composer cannot be built (no float targets,
 * lost context), rendering falls back to the direct path and
 * `diagnostics().fallback` says why; gameplay never depends on it.
 *
 * Phase 17.1: on three's WebGPURenderer (the `webgpu`/`webgl2` backends, not
 * yet the default) the scene, colour and texture skies, fog and tone mapping
 * draw; the post stack, the gradient and procedural skies and fog volumes are
 * WebGL-only shaders until phase 17.3 ports them to TSL — they are left out
 * and `diagnostics().fallback` names what is missing.
 *
 * Pure three.js + examples; textures come from the injected loader.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { PMREMGenerator as NodePMREMGenerator, type WebGPURenderer } from 'three/webgpu';

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
  diagnostics(): { post: boolean; passes: string[]; fallback: string | null; quality: QualityLevel };
  dispose(): void;
}

const TONE: Record<string, THREE.ToneMapping> = {
  none: THREE.NoToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

const GRADING_SHADER = {
  name: 'TlGradingShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uBrightness: { value: 0 },
    uContrast: { value: 0 },
    uSaturation: { value: 0 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uLift: { value: 0 },
    uGamma: { value: 1 },
    uGain: { value: 1 },
    uVignette: { value: 0 },
    uVignetteOffset: { value: 1 },
    tLut: { value: null as THREE.Texture | null },
    uLutSize: { value: 0 },
  },
  vertexShader: /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uTint;
uniform float uLift;
uniform float uGamma;
uniform float uGain;
uniform float uVignette;
uniform float uVignetteOffset;
uniform sampler2D tLut;
uniform float uLutSize;
varying vec2 vUv;
vec3 lutLookup(vec3 c) {
  // A horizontal strip: uLutSize tiles of uLutSize x uLutSize (blue picks the tile).
  float n = uLutSize;
  float b = clamp(c.b, 0.0, 1.0) * (n - 1.0);
  float b0 = floor(b);
  float b1 = min(b0 + 1.0, n - 1.0);
  vec2 inTile = (clamp(c.rg, 0.0, 1.0) * (n - 1.0) + 0.5) / vec2(n * n, n);
  vec3 c0 = texture2D(tLut, inTile + vec2(b0 / n, 0.0)).rgb;
  vec3 c1 = texture2D(tLut, inTile + vec2(b1 / n, 0.0)).rgb;
  return mix(c0, c1, b - b0);
}
void main() {
  vec4 texel = texture2D(tDiffuse, vUv);
  vec3 c = texel.rgb + uBrightness;
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.0 + uSaturation);
  // Lift raises the blacks (whites stay), gain scales, gamma bends the mid-tones.
  c = (c + uLift * (1.0 - c)) * uGain;
  c = pow(max(c, vec3(0.0)), vec3(1.0 / uGamma));
  c *= uTint;
  if (uLutSize > 1.0) c = lutLookup(c);
  vec2 d = (vUv - 0.5) * uVignetteOffset;
  c *= mix(1.0, 1.0 - dot(d, d) * 2.0, uVignette);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), texel.a);
}`,
};

const MAX_VOLUMES = 16;
const FOG_VOLUME_SHADER = {
  name: 'TlFogVolumeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uInvProjection: { value: new THREE.Matrix4() },
    uCameraWorld: { value: new THREE.Matrix4() },
    uCount: { value: 0 },
    uMin: { value: Array.from({ length: MAX_VOLUMES }, () => new THREE.Vector3()) },
    uMax: { value: Array.from({ length: MAX_VOLUMES }, () => new THREE.Vector3()) },
    uColor: { value: Array.from({ length: MAX_VOLUMES }, () => new THREE.Color()) },
    uDensity: { value: new Array<number>(MAX_VOLUMES).fill(0) },
    uFalloff: { value: new Array<number>(MAX_VOLUMES).fill(0) },
    uHeightFalloff: { value: new Array<number>(MAX_VOLUMES).fill(0) },
  },
  vertexShader: GRADING_SHADER.vertexShader,
  fragmentShader: /* glsl */ `
#define MAX_VOLUMES ${MAX_VOLUMES}
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4 uInvProjection;
uniform mat4 uCameraWorld;
uniform int uCount;
uniform vec3 uMin[MAX_VOLUMES];
uniform vec3 uMax[MAX_VOLUMES];
uniform vec3 uColor[MAX_VOLUMES];
uniform float uDensity[MAX_VOLUMES];
uniform float uFalloff[MAX_VOLUMES];
uniform float uHeightFalloff[MAX_VOLUMES];
varying vec2 vUv;
void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float depth = texture2D(tDepth, vUv).x;
  vec4 clip = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = uInvProjection * clip;
  view /= view.w;
  vec3 world = (uCameraWorld * vec4(view.xyz, 1.0)).xyz;
  // The ray starts on the near plane: right for perspective and orthographic cameras.
  vec4 nearView = uInvProjection * vec4(clip.xy, -1.0, 1.0);
  nearView /= nearView.w;
  vec3 origin = (uCameraWorld * vec4(nearView.xyz, 1.0)).xyz;
  vec3 ray = world - origin;
  float dist = length(ray);
  vec3 dir = ray / max(dist, 1e-5);
  float optical = 0.0;
  vec3 fogColor = vec3(0.0);
  for (int i = 0; i < MAX_VOLUMES; i++) {
    if (i >= uCount) break;
    vec3 inv = 1.0 / (dir + vec3(1e-6));
    vec3 t0 = (uMin[i] - origin) * inv;
    vec3 t1 = (uMax[i] - origin) * inv;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    float tin = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
    float tout = min(min(tmax.x, tmax.y), min(tmax.z, dist));
    float len = max(tout - tin, 0.0);
    if (len <= 0.0) continue;
    // Soft edges: less fog where the ray's middle is near the box edge.
    vec3 mid = origin + dir * (tin + tout) * 0.5;
    vec3 halfSize = (uMax[i] - uMin[i]) * 0.5;
    vec3 q = abs(mid - (uMin[i] + uMax[i]) * 0.5) / max(halfSize, vec3(1e-4));
    float edge = 1.0 - uFalloff[i] * smoothstep(0.0, 1.0, max(max(q.x, q.y), q.z));
    // Height falloff: density × e^(−k·(y − bottom)), integrated along the
    // segment in closed form: e^(−k·(y_in − bottom)) · (1 − e^(−k·dy·len)) / (k·dy).
    float k = uHeightFalloff[i];
    float heightLen = len;
    if (k > 0.0) {
      float yIn = origin.y + dir.y * tin - uMin[i].y;
      float kd = k * dir.y;
      heightLen = abs(kd * len) < 1e-4 ? exp(-k * yIn) * len : exp(-k * yIn) * (1.0 - exp(-kd * len)) / kd;
    }
    float od = uDensity[i] * heightLen * edge;
    optical += od;
    fogColor += uColor[i] * od;
  }
  if (optical > 0.0) fogColor /= optical;
  float f = 1.0 - exp(-optical);
  gl_FragColor = vec4(mix(base.rgb, fogColor, f), base.a);
}`,
};

/** The PMREM calls used here (three's WebGL generator and the node renderer's have the same shape). */
interface PmremLike {
  fromScene(scene: THREE.Scene, sigma?: number, near?: number, far?: number): { texture: THREE.Texture; dispose(): void };
  fromEquirectangular(texture: THREE.Texture): { texture: THREE.Texture; dispose(): void };
  fromCubemap(texture: THREE.CubeTexture): { texture: THREE.Texture; dispose(): void };
  dispose(): void;
}

export function createEnvironmentRenderer(renderer: THREE.WebGLRenderer | WebGPURenderer, scene: THREE.Scene, options: EnvironmentRendererOptions): EnvironmentRenderer {
  /** Phase 17.1: three's WebGPURenderer (either backend): no EffectComposer, no ShaderMaterial. */
  const nodeRenderer = (renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true;
  const glRenderer = renderer as THREE.WebGLRenderer;
  /** Phase 17.1: what the node renderer leaves out of the current environment (null: nothing). */
  let nodeGap: string | null = null;
  let env: EnvironmentLike | null = null;
  let qualityOverride: QualityLevel | null = null;
  let keyLight: [number, number, number] | null = null;
  let volumes: readonly FogVolumeLike[] = [];
  let width = 1;
  let height = 1;
  let composer: EffectComposer | null = null;
  let composerKey = '';
  let fallback: string | null = null;
  let passNames: string[] = [];
  let fogPass: ShaderPass | null = null;
  let gradingPass: ShaderPass | null = null;
  let depthTarget: THREE.WebGLRenderTarget | null = null;
  const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false });
  const pmrem: PmremLike = nodeRenderer ? (new NodePMREMGenerator(renderer as WebGPURenderer) as unknown as PmremLike) : (new THREE.PMREMGenerator(glRenderer) as unknown as PmremLike);
  let skyMesh: Sky | null = null;
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
    if (nodeRenderer && (sky.mode === 'procedural' || sky.mode === 'gradient')) {
      // Phase 17.1: these skies are GLSL ShaderMaterials the node renderer
      // cannot draw (phase 17.3 ports them): the gradient's horizon colour
      // stands in as a plain background, the procedural sky draws nothing.
      if (sky.mode === 'gradient') scene.background = new THREE.Color(sky.horizonColor ?? '#bfe3ff');
      return;
    }
    if (sky.mode === 'procedural') {
      const s = new Sky();
      s.scale.setScalar(4500);
      const u = s.material.uniforms as Record<string, { value: unknown }>;
      (u['turbidity']!).value = sky.turbidity ?? 6;
      (u['rayleigh']!).value = sky.rayleigh ?? 1.5;
      (u['mieCoefficient']!).value = sky.mieCoefficient ?? 0.005;
      (u['mieDirectionalG']!).value = sky.mieDirectionalG ?? 0.8;
      ((u['sunPosition']!).value as THREE.Vector3).copy(sunDirection(sky));
      skyMesh = s;
      scene.background = null;
      scene.add(s);
      // Image-based lighting from the same sky.
      const tmp = new THREE.Scene();
      const clone = new Sky();
      clone.scale.setScalar(4500);
      const cu = clone.material.uniforms as Record<string, { value: unknown }>;
      for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) (cu[k]!).value = (u[k]!).value;
      ((cu['sunPosition']!).value as THREE.Vector3).copy((u['sunPosition']!).value as THREE.Vector3);
      tmp.add(clone);
      envMap = pmrem.fromScene(tmp, 0, 0.1, 10000);
      scene.environment = envMap.texture;
      clone.geometry.dispose();
      clone.material.dispose();
      return;
    }
    if (sky.mode === 'gradient') {
      const mat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: new THREE.Color(sky.topColor ?? '#3d7cd6') },
          horizon: { value: new THREE.Color(sky.horizonColor ?? '#bfe3ff') },
          bottom: { value: new THREE.Color(sky.bottomColor ?? '#757575') }, // phase 15.5: neutral grey below the horizon (was a grass olive)
        },
        vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying vec3 vDir; void main() { float h = vDir.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, bottom, pow(-h, 0.5)); gl_FragColor = vec4(c, 1.0); }',
      });
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

  // EffectComposer.dispose() frees only its own targets and copy pass: every
  // added pass (bloom, GTAO, bokeh, SMAA, shader passes) and the grading LUT
  // clone are freed here, or each rebuild leaks their targets and programs.
  const disposeComposer = (): void => {
    if (composer !== null) {
      const lut = (gradingPass?.uniforms as Record<string, { value: unknown }> | undefined)?.['tLut']?.value;
      if (lut instanceof THREE.Texture) lut.dispose();
      for (const pass of composer.passes) pass.dispose();
      composer.dispose();
    }
    composer = null;
    fogPass = null;
    gradingPass = null;
    passNames = [];
  };

  const buildComposer = (camera: THREE.Camera): void => {
    const w = wanted();
    const post = env?.post;
    if (nodeRenderer) {
      // Phase 17.1: EffectComposer and its passes are WebGL-only (phase 17.3 moves post to TSL).
      const skyMode = env?.sky?.mode;
      const gaps = [
        ...(anyPost(w) ? ['post-processing'] : []),
        ...(skyMode === 'procedural' || skyMode === 'gradient' ? [`the ${skyMode} sky`] : []),
        ...(w.fogVolumes ? ['fog volumes'] : []),
      ];
      nodeGap = gaps.length > 0 ? `not drawn on the WebGPU renderer yet (phase 17.3): ${gaps.join(', ')}` : null;
      return;
    }
    const key = JSON.stringify({ w, post, q: quality(), size: [width, height], cam: camera.uuid });
    if (key === composerKey && (composer !== null || !anyPost(w))) return;
    composerKey = key;
    disposeComposer();
    if (!anyPost(w)) return;
    try {
      const c = new EffectComposer(glRenderer);
      c.setPixelRatio(Math.min(QUALITY_PROFILE[quality()].pixelRatio, globalThis.devicePixelRatio ?? 1));
      c.setSize(width, height);
      c.addPass(new RenderPass(scene, camera));
      passNames = ['render'];
      if (w.ssao && camera instanceof THREE.PerspectiveCamera) {
        const ao = new GTAOPass(scene, camera, width, height);
        ao.updateGtaoMaterial({ radius: post?.ssao?.radius ?? 0.5 });
        (ao as unknown as { blendIntensity: number }).blendIntensity = post?.ssao?.intensity ?? 1;
        c.addPass(ao);
        passNames.push('ssao');
      }
      if (w.fogVolumes) {
        fogPass = new ShaderPass(FOG_VOLUME_SHADER);
        c.addPass(fogPass);
        passNames.push('fogVolumes');
      }
      if (w.dof && camera instanceof THREE.PerspectiveCamera) {
        c.addPass(new BokehPass(scene, camera, { focus: post?.dof?.focus ?? 10, aperture: post?.dof?.aperture ?? 0.002, maxblur: post?.dof?.maxBlur ?? 0.01 }));
        passNames.push('dof');
      }
      if (w.bloom) {
        c.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), post?.bloom?.strength ?? 0.6, post?.bloom?.radius ?? 0.4, post?.bloom?.threshold ?? 0.85));
        passNames.push('bloom');
      }
      c.addPass(new OutputPass());
      passNames.push('output');
      if (w.grading) {
        gradingPass = new ShaderPass(GRADING_SHADER);
        const g = post?.grading;
        const u = gradingPass.uniforms as Record<string, { value: unknown }>;
        (u['uBrightness']!).value = g?.brightness ?? 0;
        (u['uContrast']!).value = g?.contrast ?? 0;
        (u['uSaturation']!).value = g?.saturation ?? 0;
        (u['uTint']!).value = new THREE.Color(g?.tint ?? '#ffffff');
        (u['uLift']!).value = g?.lift ?? 0;
        (u['uGamma']!).value = g?.gamma ?? 1;
        (u['uGain']!).value = g?.gain ?? 1;
        (u['uVignette']!).value = post?.vignette?.enabled === true ? (post.vignette.darkness ?? 0.5) : 0;
        (u['uVignetteOffset']!).value = post?.vignette?.offset ?? 1;
        if (g?.lut !== undefined) {
          const pass = gradingPass;
          void texture(g.lut).then((t) => {
            if (t === null || disposed || pass !== gradingPass) return;
            const lut = t.clone();
            lut.colorSpace = THREE.NoColorSpace;
            lut.flipY = false;
            lut.generateMipmaps = false;
            lut.minFilter = THREE.LinearFilter;
            lut.needsUpdate = true;
            const img = lut.image as { width?: number; height?: number };
            (u['tLut']!).value = lut;
            (u['uLutSize']!).value = img.height ?? 0;
            options.onChange?.();
          });
        }
        c.addPass(gradingPass);
        passNames.push('grading');
      }
      if (w.aa === 'smaa') {
        c.addPass(new SMAAPass());
        passNames.push('smaa');
      } else if (w.aa === 'fxaa') {
        const fx = new ShaderPass(FXAAShader);
        const pr = c.renderer.getPixelRatio();
        ((fx.material.uniforms as Record<string, { value: THREE.Vector2 }>)['resolution']!).value.set(1 / (width * pr), 1 / (height * pr));
        c.addPass(fx);
        passNames.push('fxaa');
      }
      composer = c;
      fallback = null;
    } catch (e) {
      disposeComposer();
      fallback = `post-processing is off: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    }
  };

  const anyPost = (w: ReturnType<typeof wanted>): boolean => w.bloom || w.ssao || w.dof || w.fogVolumes || w.grading || w.aa !== 'none';

  const renderDepth = (camera: THREE.Camera): void => {
    const pr = renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * pr));
    const h = Math.max(1, Math.floor(height * pr));
    if (depthTarget === null || depthTarget.width !== w || depthTarget.height !== h) {
      depthTarget?.dispose();
      depthTarget = new THREE.WebGLRenderTarget(w, h, { depthTexture: new THREE.DepthTexture(w, h) });
    }
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    scene.overrideMaterial = depthOnly;
    scene.background = null;
    glRenderer.setRenderTarget(depthTarget);
    glRenderer.clear();
    glRenderer.render(scene, camera);
    glRenderer.setRenderTarget(null);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
  };

  return {
    set(next) {
      env = next;
      const p = next?.post;
      renderer.toneMapping = TONE[p?.toneMapping ?? (next === null ? 'none' : 'agx')] ?? THREE.NoToneMapping;
      renderer.toneMappingExposure = p?.exposure ?? 1;
      buildSky();
      applyFog();
      composerKey = '';
      options.onChange?.();
    },
    setKeyLightDirection(direction) {
      const same = JSON.stringify(direction) === JSON.stringify(keyLight);
      keyLight = direction === null ? null : [direction[0], direction[1], direction[2]];
      if (!same) buildSky();
    },
    setFogVolumes(list) {
      const changedCount = (list.length > 0) !== (volumes.length > 0);
      volumes = list.slice(0, MAX_VOLUMES);
      if (changedCount) composerKey = '';
    },
    setQuality(level) {
      qualityOverride = level;
      composerKey = '';
    },
    render(camera) {
      if (disposed) return;
      buildComposer(camera);
      if (composer === null) {
        renderer.render(scene, camera);
        return;
      }
      if (fogPass !== null) {
        renderDepth(camera);
        const u = fogPass.uniforms as Record<string, { value: unknown }>;
        (u['tDepth']!).value = depthTarget!.depthTexture;
        ((u['uInvProjection']!).value as THREE.Matrix4).copy((camera as THREE.PerspectiveCamera).projectionMatrixInverse);
        ((u['uCameraWorld']!).value as THREE.Matrix4).copy(camera.matrixWorld);
        (u['uCount']!).value = volumes.length;
        volumes.forEach((v, i) => {
          ((u['uMin']!).value as THREE.Vector3[])[i]!.set(v.center[0] - v.size[0] / 2, v.center[1] - v.size[1] / 2, v.center[2] - v.size[2] / 2);
          ((u['uMax']!).value as THREE.Vector3[])[i]!.set(v.center[0] + v.size[0] / 2, v.center[1] + v.size[1] / 2, v.center[2] + v.size[2] / 2);
          ((u['uColor']!).value as THREE.Color[])[i]!.set(v.color);
          ((u['uDensity']!).value as number[])[i] = v.density;
          ((u['uFalloff']!).value as number[])[i] = v.falloff ?? 0.5;
          ((u['uHeightFalloff']!).value as number[])[i] = v.heightFalloff ?? 0;
        });
      }
      composer.render();
    },
    resize(w, h) {
      const nw = Math.max(1, Math.floor(w));
      const nh = Math.max(1, Math.floor(h));
      if (nw === width && nh === height) return; // a same-size resize must not rebuild the post stack
      width = nw;
      height = nh;
      composerKey = '';
    },
    diagnostics() {
      return { post: composer !== null, passes: [...passNames], fallback: nodeRenderer ? nodeGap : fallback, quality: quality() };
    },
    dispose() {
      disposed = true;
      disposeComposer();
      clearSky();
      depthTarget?.dispose();
      depthOnly.dispose();
      pmrem.dispose();
    },
  };
}
