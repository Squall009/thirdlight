/**
 * The environment on three's `WebGPURenderer` (its WebGPU and
 * WebGL 2 backends) — the TSL twins of the WebGL-only pieces of
 * `environment.ts`:
 *
 * - `createSkyMesh`: the physical sky as three's `SkyMesh` (the TSL port of
 *   `Sky.js`), clouds held still like the archived (WebGL) sky (its `time` never moves);
 * - `gradientSkyMaterial`: the gradient dome, the archived (WebGL) shader line by line;
 * - `buildPostPipeline`: the post stack as a `RenderPipeline` (three's node
 *   post-processing, renamed from `PostProcessing` in r183) in the archived WebGL
 *   pass order: scene (its lit materials taking the last frame's ambient
 *   occlusion into their indirect light, `post-ao.ts`) → fog volumes → depth of
 *   field → bloom → output (tone mapping + sRGB) → grading / LUT / vignette →
 *   SMAA / FXAA → upscale (render scale below 1, `post-upscale.ts`). The fog
 *   volume and grading passes mirror the archived (WebGL) GLSL line by line;
 *   AO, DOF, bloom, SMAA, FXAA and FSR 1 are three's TSL display nodes.
 *
 * Pure three.js (`three/webgpu`, `three/tsl`, examples); nothing here needs a
 * GPU until a renderer builds the nodes.
 */
import { MAX_FOG_VOLUMES } from '@thirdlight/runtime';
import * as THREE from 'three';
import {
  abs,
  clamp,
  cubeTexture,
  dot,
  equirectUV,
  exp,
  float,
  Fn,
  getViewPosition,
  If,
  int,
  length,
  Loop,
  max,
  min,
  mix,
  modelViewProjection,
  mrt,
  normalize,
  normalView,
  output,
  pass,
  positionLocal,
  pow,
  renderOutput,
  rtt,
  select,
  smoothstep,
  texture,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { MeshBasicNodeMaterial, RenderPipeline, type WebGPURenderer } from 'three/webgpu';
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js';
import { dof } from 'three/examples/jsm/tsl/display/DepthOfFieldNode.js';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js';
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';
import { releaseMrtContexts } from './dispose';
import { buildAmbientOcclusion, type AmbientOcclusionStage, type AoKind, type ScreenSpaceOcclusion } from './post-ao';
import { atScale, buildUpscale, scaledTexture, type ScaledTexture, type UpscaleFilter, type UpscaleStage } from './post-upscale';

/** TSL nodes are loosely typed here (three's node typings are generic-heavy); values stay three objects. */
type N = any;

/** The fog volumes drawn: the model's per-scene cap. */
export { MAX_FOG_VOLUMES };

export { AO_RESOLUTION_SCALE } from './post-ao';

/** The physical sky's parameters (the project's `sky` fields). */
export interface SkyParams {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  sun: THREE.Vector3;
}

/** three's TSL sky with the project's parameters; its clouds stand still (the archived (WebGL) sky's `time` stays 0). */
export function createSkyMesh(p: SkyParams): THREE.Mesh {
  const s = new SkyMesh();
  s.scale.setScalar(4500);
  s.turbidity.value = p.turbidity;
  s.rayleigh.value = p.rayleigh;
  s.mieCoefficient.value = p.mieCoefficient;
  s.mieDirectionalG.value = p.mieDirectionalG;
  s.sunPosition.value.copy(p.sun);
  s.cloudSpeed.value = 0;
  return s;
}

/**
 * The gradient dome: above the horizon horizon→top (h^0.6), below it
 * horizon→bottom ((−h)^0.5), h = the direction's height. Unlit, no fog (the
 * archived (WebGL) ShaderMaterial drew no fog either).
 */
export function gradientSkyMaterial(top: THREE.Color, horizon: THREE.Color, bottom: THREE.Color): THREE.Material {
  const m = new MeshBasicNodeMaterial();
  const uTop = uniform(top);
  const uHorizon = uniform(horizon);
  const uBottom = uniform(bottom);
  m.colorNode = Fn(() => {
    const h = normalize(positionLocal).y;
    return select(h.greaterThan(0), mix(uHorizon, uTop, pow(h, 0.6)), mix(uHorizon, uBottom, pow(h.negate(), 0.5)));
  })();
  // On the far plane (z = w, like three's sky): never clipped by a nearer far plane.
  m.vertexNode = Fn(() => {
    const p: N = modelViewProjection;
    p.z.assign(p.w);
    return p;
  })();
  m.side = THREE.BackSide;
  m.depthWrite = false;
  m.fog = false;
  // The colours are uniforms — a blend changes them without a new program.
  m.userData['skyUniforms'] = { top: uTop, horizon: uHorizon, bottom: uBottom };
  return m;
}

/** The gradient dome's colour uniforms (null: not a gradient dome material). */
export function gradientSkyUniforms(m: THREE.Material): { top: { value: THREE.Color }; horizon: { value: THREE.Color }; bottom: { value: THREE.Color } } | null {
  return (m.userData['skyUniforms'] as { top: { value: THREE.Color }; horizon: { value: THREE.Color }; bottom: { value: THREE.Color } } | undefined) ?? null;
}

/**
 * A sky dome drawing a colour, an equirect image or a cube map
 * (a cross-fade layer; `opacity` is the layer's share — a material uniform, no
 * new program per frame). Drawn as a display colour (not tone mapped), like
 * the background these skies are when shown alone; on the far plane like the
 * gradient dome.
 */
export function imageSkyMaterial(source: { color: THREE.Color } | { equirect: THREE.Texture } | { cube: THREE.CubeTexture }): THREE.Material {
  const m = new MeshBasicNodeMaterial();
  if ('equirect' in source) m.colorNode = texture(source.equirect, equirectUV(normalize(positionLocal)));
  else if ('cube' in source) m.colorNode = cubeTexture(source.cube, normalize(positionLocal));
  else m.color.copy(source.color);
  m.vertexNode = Fn(() => {
    const p: N = modelViewProjection;
    p.z.assign(p.w);
    return p;
  })();
  m.side = THREE.BackSide;
  m.depthWrite = false;
  m.fog = false;
  m.toneMapped = false;
  m.transparent = true;
  return m;
}

/** What the post stack does (already reduced by the quality level). */
export interface PostPlan {
  /** Ambient occlusion on the lit materials' indirect light (`post-ao.ts`). */
  ao: { kind: AoKind; radius: number; intensity: number } | null;
  fogVolumes: boolean;
  dof: { focus: number; aperture: number; maxBlur: number } | null;
  bloom: { strength: number; radius: number; threshold: number } | null;
  grading: {
    brightness: number;
    contrast: number;
    saturation: number;
    tint: string;
    lift: number;
    gamma: number;
    gain: number;
    vignette: number;
    vignetteOffset: number;
  } | null;
  aa: 'none' | 'fxaa' | 'smaa';
  /**
   * The scene's background (a colour or an sRGB sky image) is shown as a
   * display colour, not tone mapped — what the WebGL renderer does when it
   * draws straight to the canvas (no post stack). WebGPURenderer tone maps
   * the whole frame, so the background is laid under the tone-mapped
   * picture: an image drawn in its own pass, a colour as a uniform (no pass,
   * so it also holds under a render scale). Null: drawn with the scene.
   */
  displayBackground: 'color' | 'image' | null;
  /** MSAA samples of the scene pass (0: none). */
  samples: number;
  /** Drawn at a share of the screen's resolution and upscaled (null: at the screen's; `scale` is the first frame's, `setScale` moves it). */
  upscale: { filter: UpscaleFilter; scale: number } | null;
}

/** A fog volume in world space (min/max corners). */
export interface FogVolumeBox {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  color: string;
  density: number;
  falloff: number;
  heightFalloff: number;
}

export interface PostPipeline {
  /** The pass names, in order (diagnostics). */
  readonly passes: readonly string[];
  /** Before a frame: the camera's matrices and the fog volumes. */
  update(camera: THREE.Camera, volumes: readonly FogVolumeBox[]): void;
  /** The LUT strip arrived (its height is the LUT size). */
  setLut(lut: THREE.Texture | null): void;
  /** The canvas size in CSS pixels (the depth of field's blur is in pixels). */
  setSize(width: number, height: number, pixelRatio: number): void;
  /** The render scale (a pipeline built with `upscale`; else ignored): every scaled target follows at the next frame. */
  setScale(scale: number): void;
  /** The scene pass's size in pixels as last drawn (null before the first frame). */
  internalSize(): [number, number] | null;
  /** New grading / vignette / bloom numbers for the built passes (uniforms: no rebuild, no new program). */
  setParams(params: Pick<PostPlan, 'grading' | 'bloom'>): void;
  render(): void;
  /**
   * Build the scene pass's node programs and pipelines ahead of
   * its first draw (`renderer.compileAsync` into the pass's own target and
   * outputs, so the programs are the ones the pass draws with).
   */
  compileAsync(camera: THREE.Camera): Precompile;
  dispose(): void;
}

/** 1 × 1 stand-in for a LUT that has not arrived (never sampled: the size uniform is 0). */
function blankLut(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  // The same sampler as the LUT that replaces it (on WebGPU the sampler stays the first texture's).
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** `aoLight`: the scene's occlusion light, which a plan with `ao` feeds (null: none in the scene). */
export function buildPostPipeline(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, plan: PostPlan, aoLight: ScreenSpaceOcclusion | null = null): PostPipeline {
  const disposables: { dispose(): void }[] = [];
  const passes: string[] = ['render'];
  const perspective = camera instanceof THREE.PerspectiveCamera;
  // Samples are always given: without them PassNode takes the renderer's MSAA, which multiplies the
  // scene pass's cost under a post stack that anti-aliases itself, and its multisampled depth is a
  // texture GTAO cannot sample on WebGPU (the AO pipeline fails to build).
  const scenePass: N = pass(scene, camera, { samples: plan.samples });
  disposables.push(scenePass);
  const upscaling = plan.upscale !== null;
  let scale = plan.upscale?.scale ?? 1;
  const scaled: ScaledTexture[] = [];
  /** `color` drawn into its own target at the scale (the input of a node that samples a texture). */
  const atRenderScale = (c: N): N => {
    const t = scaledTexture(c, scale);
    scaled.push(t);
    return t.node;
  };
  /**
   * `c` as a texture node a display node samples. Given anything else, three's display nodes (SMAA, FXAA, depth
   * of field) draw it into a target of their own (`convertToTexture`) that their `dispose` never frees, so each
   * rebuilt stack would keep the last one's: the pipeline makes that target here and frees it with itself.
   */
  const asTexture = (c: N): N => {
    if (c.isTextureNode === true || c.isSampleNode === true) return c;
    if (c.isPassNode === true) return c.getTextureNode();
    const t: N = rtt(c);
    disposables.push(t);
    return t;
  };
  const wantsAo = plan.ao !== null && perspective && aoLight !== null;
  // The MRT node is kept so the render contexts drawn with it can be released with the pipeline.
  const sceneMrt: unknown = wantsAo ? mrt({ output, normal: normalView }) : null;
  if (wantsAo) scenePass.setMRT(sceneMrt);
  const depth: N = scenePass.getTextureNode('depth');
  let color: N = scenePass.getTextureNode('output');

  // Camera matrices of the drawn camera (the pipeline's own quad has another camera).
  const invProjection = uniform(new THREE.Matrix4());
  const cameraWorld = uniform(new THREE.Matrix4());

  let aoStage: AmbientOcclusionStage | null = null;
  if (wantsAo) {
    aoStage = buildAmbientOcclusion(renderer, plan.ao!.kind, scenePass, camera, aoLight!, { radius: plan.ao!.radius, intensity: plan.ao!.intensity });
    disposables.push(aoStage);
    passes.push(plan.ao!.kind);
  }

  // ---- fog volumes (the archived (WebGL) TlFogVolumeShader, line by line) -----------------------
  const count = uniform(0, 'int');
  const vMin: N = uniformArray(Array.from({ length: MAX_FOG_VOLUMES }, () => new THREE.Vector3()), 'vec3');
  const vMax: N = uniformArray(Array.from({ length: MAX_FOG_VOLUMES }, () => new THREE.Vector3()), 'vec3');
  const vColor: N = uniformArray(Array.from({ length: MAX_FOG_VOLUMES }, () => new THREE.Color()), 'color');
  const vDensity: N = uniformArray(new Array<number>(MAX_FOG_VOLUMES).fill(0), 'float');
  const vFalloff: N = uniformArray(new Array<number>(MAX_FOG_VOLUMES).fill(0), 'float');
  const vHeight: N = uniformArray(new Array<number>(MAX_FOG_VOLUMES).fill(0), 'float');
  if (plan.fogVolumes) {
    const base = color;
    color = Fn(() => {
      const coord = uv();
      const src = base.toVar();
      const d = depth.sample(coord).x;
      const view = getViewPosition(coord, d, invProjection);
      const world = cameraWorld.mul(vec4(view, 1)).xyz;
      // The ray starts on the near plane: right for perspective and orthographic cameras.
      const nearView = getViewPosition(coord, float(0), invProjection);
      const origin = cameraWorld.mul(vec4(nearView, 1)).xyz.toVar();
      const ray = world.sub(origin);
      const dist = length(ray).toVar();
      const dir = ray.div(max(dist, 1e-5)).toVar();
      const optical = float(0).toVar();
      const fogColor = vec3(0).toVar();
      Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        const lo = vMin.element(i);
        const hi = vMax.element(i);
        const inv = vec3(1).div(dir.add(vec3(1e-6)));
        const t0 = lo.sub(origin).mul(inv);
        const t1 = hi.sub(origin).mul(inv);
        const tmin: N = min(t0, t1);
        const tmax: N = max(t0, t1);
        const tin = max(max(tmin.x, tmin.y), max(tmin.z, 0)).toVar();
        const tout = min(min(tmax.x, tmax.y), min(tmax.z, dist)).toVar();
        const len = max(tout.sub(tin), 0).toVar();
        If(len.greaterThan(0), () => {
          // Soft edges: less fog where the ray's middle is near the box edge.
          const mid = origin.add(dir.mul(tin.add(tout).mul(0.5)));
          const halfSize = hi.sub(lo).mul(0.5);
          const qv = abs(mid.sub(lo.add(hi).mul(0.5))).div(max(halfSize, vec3(1e-4)));
          const edge = float(1).sub(vFalloff.element(i).mul(smoothstep(0, 1, max(max(qv.x, qv.y), qv.z))));
          // Height falloff: density × e^(−k·(y − bottom)), integrated along the segment in closed form.
          const k = vHeight.element(i);
          const heightLen = len.toVar();
          If(k.greaterThan(0), () => {
            const yIn = origin.y.add(dir.y.mul(tin)).sub(lo.y);
            const kd = k.mul(dir.y);
            heightLen.assign(
              select(abs(kd.mul(len)).lessThan(1e-4), exp(k.negate().mul(yIn)).mul(len), exp(k.negate().mul(yIn)).mul(float(1).sub(exp(kd.negate().mul(len)))).div(kd)),
            );
          });
          const od = vDensity.element(i).mul(heightLen).mul(edge);
          optical.addAssign(od);
          fogColor.addAssign(vColor.element(i).mul(od));
        });
      });
      If(optical.greaterThan(0), () => {
        fogColor.divAssign(optical);
      });
      const f = float(1).sub(exp(optical.negate()));
      return vec4(mix(src.rgb, fogColor, f), src.a);
    })();
    passes.push('fogVolumes');
  }

  // ---- depth of field (three's DOF node; the archived (WebGL) Bokeh parameters mapped) ----------
  // Legacy: blur radius (UV) = clamp(|distance − focus| · aperture, 0, maxBlur), gathered at
  // up to 0.4 of it with the aspect folded into X: in pixels 0.4 · maxBlur · width at full blur.
  // Node DOF: CoC = smoothstep(0, focalLength, |distance − focus|), radius = CoC · bokehScale px.
  const bokehScale = uniform(1);
  let dofPlan: PostPlan['dof'] = null;
  if (plan.dof !== null && perspective) {
    dofPlan = plan.dof;
    const focalLength = dofPlan.maxBlur / Math.max(1e-6, dofPlan.aperture);
    const dofNode: N = dof(upscaling ? atRenderScale(color) : asTexture(color), scenePass.getViewZNode(), uniform(dofPlan.focus), uniform(focalLength), bokehScale);
    disposables.push(dofNode);
    color = dofNode;
    passes.push('dof');
  }

  let bloomNode: N = null;
  if (plan.bloom !== null) {
    // UnrealBloomPass scales its composite by 3 ("backwards compatibility with previous
    // alpha-based intensity"); BloomNode does not: the project's strength keeps its meaning.
    bloomNode = bloom(color, plan.bloom.strength * 3, plan.bloom.radius, plan.bloom.threshold);
    disposables.push(bloomNode);
    if (upscaling) bloomNode.setResolutionScale(BLOOM_RESOLUTION_SCALE * scale);
    // UnrealBloom adds its glow onto the picture (alpha unchanged).
    color = vec4(color.rgb.add(bloomNode.rgb), color.a);
    passes.push('bloom');
  }

  color = renderOutput(color);
  passes.push('output');

  // The background as a display colour under the picture (premultiplied "over").
  if (plan.displayBackground !== null) {
    // The scene pass draws on transparent black (its alpha says where the background shows). Set for its own
    // draw: a pass drawn inside another node's render (an RTT, as the render scale's chain has) finds the clear
    // colour three's RTT reset to opaque black, and the background would never show.
    const draw = scenePass.updateBefore.bind(scenePass) as (frame: unknown) => unknown;
    const clear = new THREE.Color();
    scenePass.updateBefore = (frame: unknown): unknown => {
      renderer.getClearColor(clear);
      const alpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      try {
        return draw(frame);
      } finally {
        renderer.setClearColor(clear, alpha);
      }
    };
  }
  const bgScene = plan.displayBackground === 'image' ? new THREE.Scene() : null;
  // A colour background: the scene's colour (working space, as three clears with it), set each frame.
  const bgColor: N = plan.displayBackground === 'color' ? uniform(new THREE.Color()) : null;
  let bgPass: N = null;
  if (plan.displayBackground !== null) {
    let source: N;
    if (bgScene !== null) {
      bgPass = pass(bgScene, camera, { depthBuffer: false });
      disposables.push(bgPass);
      source = bgPass.getTextureNode('output');
    } else source = vec4(bgColor, 1);
    const bg: N = renderOutput(source, THREE.NoToneMapping);
    const fg = color;
    color = vec4(fg.rgb.add(bg.rgb.mul(float(1).sub(fg.a))), fg.a.add(bg.a.mul(float(1).sub(fg.a))));
  }

  // ---- grading, LUT, vignette (the archived (WebGL) TlGradingShader, line by line) --------------
  const lutNode: N = texture(blankLut());
  const lutSize = uniform(0);
  let gradingUniforms: Record<string, N> | null = null;
  if (plan.grading !== null) {
    const g = plan.grading;
    const uBrightness = uniform(g.brightness);
    const uContrast = uniform(g.contrast);
    const uSaturation = uniform(g.saturation);
    const uTint = uniform(new THREE.Color(g.tint));
    const uLift = uniform(g.lift);
    const uGamma = uniform(g.gamma);
    const uGain = uniform(g.gain);
    const uVignette = uniform(g.vignette);
    const uVignetteOffset = uniform(g.vignetteOffset);
    gradingUniforms = { brightness: uBrightness, contrast: uContrast, saturation: uSaturation, tint: uTint, lift: uLift, gamma: uGamma, gain: uGain, vignette: uVignette, vignetteOffset: uVignetteOffset };
    const input = color;
    const lutLookup = Fn(([cIn]: [N]) => {
      // A horizontal strip: lutSize tiles of lutSize × lutSize (blue picks the tile).
      const n = lutSize;
      const b = clamp(cIn.b, 0, 1).mul(n.sub(1)).toVar();
      const b0 = b.floor();
      const b1 = min(b0.add(1), n.sub(1));
      const inTile = clamp(cIn.rg, 0, 1).mul(n.sub(1)).add(0.5).div(vec2(n.mul(n), n)).toVar();
      const c0 = lutNode.sample(inTile.add(vec2(b0.div(n), 0))).rgb;
      const c1 = lutNode.sample(inTile.add(vec2(b1.div(n), 0))).rgb;
      return mix(c0, c1, b.sub(b0));
    });
    color = Fn(() => {
      const texel = input.toVar();
      const c = texel.rgb.add(uBrightness).toVar();
      c.assign(c.sub(0.5).mul(uContrast.add(1)).add(0.5));
      const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c.assign(mix(vec3(l), c, uSaturation.add(1)));
      // Lift raises the blacks (whites stay), gain scales, gamma bends the mid-tones.
      c.assign(c.add(uLift.mul(vec3(1).sub(c))).mul(uGain));
      c.assign(pow(max(c, vec3(0)), vec3(float(1).div(uGamma))));
      c.mulAssign(uTint);
      If(lutSize.greaterThan(1), () => {
        c.assign(lutLookup(c));
      });
      const d = uv().sub(0.5).mul(uVignetteOffset);
      c.mulAssign(mix(float(1), float(1).sub(dot(d, d).mul(2)), uVignette));
      return vec4(clamp(c, 0, 1), texel.a);
    })();
    passes.push('grading');
  }

  // Under a render scale the picture is drawn at the scale up to here (anti-aliasing included: FSR 1 wants an
  // anti-aliased input), then upscaled.
  if (plan.aa === 'smaa') {
    const n: N = upscaling ? atScale(smaa(atRenderScale(color)), () => scale) : smaa(asTexture(color));
    disposables.push(n);
    color = upscaling ? n.getTextureNode() : n;
    passes.push('smaa');
  } else if (plan.aa === 'fxaa') {
    const n: N = fxaa(upscaling ? atRenderScale(color) : asTexture(color));
    disposables.push(n);
    color = upscaling ? atRenderScale(n) : n;
    passes.push('fxaa');
  } else if (upscaling) color = atRenderScale(color);

  let upscale: UpscaleStage | null = null;
  if (plan.upscale !== null) {
    upscale = buildUpscale(color, plan.upscale.filter, scale);
    disposables.push(upscale);
    color = upscale.output;
    passes.push(plan.upscale.filter);
  }
  for (const t of scaled) disposables.push(t);
  // The AO and its history run each frame after the scene pass: their node is built into the output (adding
  // nothing: × 0) so the pipeline updates it. A bare statement would do, but WGSL has no expression statements.
  if (aoStage !== null) {
    const c = color;
    color = vec4(c.rgb, c.a.add(aoStage.passes.x.mul(0)));
  }

  const applyScale = (): void => {
    scenePass.setResolutionScale(scale);
    bgPass?.setResolutionScale(scale);
    aoStage?.setScale(scale);
    for (const t of scaled) t.setScale(scale);
    bloomNode?.setResolutionScale(BLOOM_RESOLUTION_SCALE * scale);
    upscale?.setScale(scale);
    bokehScale.value = bokehBase * scale;
  };
  let bokehBase = 1;
  if (upscaling) applyScale();

  const pipeline = new RenderPipeline(renderer, color);
  // Tone mapping and sRGB happen at the output step above (grading and AA work on the display picture).
  pipeline.outputColorTransform = false;

  return {
    passes,
    update(cam, volumes) {
      invProjection.value.copy(cam.projectionMatrixInverse);
      cameraWorld.value.copy(cam.matrixWorld);
      const n = Math.min(MAX_FOG_VOLUMES, volumes.length);
      count.value = n;
      for (let i = 0; i < n; i++) {
        const v = volumes[i]!;
        (vMin.array[i] as THREE.Vector3).set(v.min[0], v.min[1], v.min[2]);
        (vMax.array[i] as THREE.Vector3).set(v.max[0], v.max[1], v.max[2]);
        (vColor.array[i] as THREE.Color).set(v.color);
        vDensity.array[i] = v.density;
        vFalloff.array[i] = v.falloff;
        vHeight.array[i] = v.heightFalloff;
      }
    },
    setLut(lut) {
      const old = lutNode.value as THREE.Texture;
      lutNode.value = lut ?? blankLut();
      old.dispose();
      lutSize.value = lut === null ? 0 : ((lut.image as { height?: number } | null)?.height ?? 0);
    },
    setParams(params) {
      const g = params.grading;
      if (g !== null && gradingUniforms !== null) {
        gradingUniforms['brightness'].value = g.brightness;
        gradingUniforms['contrast'].value = g.contrast;
        gradingUniforms['saturation'].value = g.saturation;
        (gradingUniforms['tint'].value as THREE.Color).set(g.tint);
        gradingUniforms['lift'].value = g.lift;
        gradingUniforms['gamma'].value = g.gamma;
        gradingUniforms['gain'].value = g.gain;
        gradingUniforms['vignette'].value = g.vignette;
        gradingUniforms['vignetteOffset'].value = g.vignetteOffset;
      }
      const b = params.bloom;
      if (b !== null && bloomNode !== null) {
        bloomNode.strength.value = b.strength * 3;
        bloomNode.radius.value = b.radius;
        bloomNode.threshold.value = b.threshold;
      }
    },
    setSize(width, height, pixelRatio) {
      void height;
      if (dofPlan !== null) {
        bokehBase = 0.4 * dofPlan.maxBlur * width * pixelRatio;
        bokehScale.value = bokehBase * scale;
      }
    },
    setScale(next) {
      if (!upscaling || next === scale) return;
      scale = next;
      applyScale();
    },
    internalSize() {
      const t = (scenePass as { renderTarget: THREE.RenderTarget }).renderTarget;
      return t.width > 1 || t.height > 1 ? [t.width, t.height] : null;
    },
    compileAsync(cam) {
      return compileIntoTarget(renderer, scene, cam, (scenePass as { renderTarget: THREE.RenderTarget }).renderTarget, (scenePass as { getMRT(): unknown }).getMRT());
    },
    render() {
      aoStage?.beforeFrame(camera);
      try {
        drawFrame();
      } finally {
        aoStage?.afterFrame(camera);
      }
    },
    dispose() {
      pipeline.dispose();
      (lutNode.value as THREE.Texture).dispose();
      for (const d of disposables) d.dispose();
      releaseMrtContexts(renderer, sceneMrt);
    },
  };

  function drawFrame(): void {
    if (plan.displayBackground === null) {
      pipeline.render();
      return;
    }
    // The scene pass draws on transparent black without the background; the background pass (or colour) is only it.
    const s = scene as THREE.Scene & { backgroundIntensity: number; backgroundBlurriness: number };
    const background = s.background;
    const b = bgScene as (THREE.Scene & { backgroundIntensity: number; backgroundBlurriness: number }) | null;
    if (b !== null) {
      b.background = background;
      b.backgroundIntensity = s.backgroundIntensity;
      b.backgroundBlurriness = s.backgroundBlurriness;
      b.backgroundRotation.copy(s.backgroundRotation);
    } else if ((background as THREE.Color | null)?.isColor === true) (bgColor.value as THREE.Color).copy(background as THREE.Color);
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    s.background = null;
    renderer.setClearColor(0x000000, 0);
    try {
      pipeline.render();
    } finally {
      s.background = background;
      if (b !== null) b.background = null;
      renderer.setClearColor(clear, alpha);
    }
  }
}

/** Bloom's own share of the picture's resolution (three's default; under a render scale, of the scaled picture). */
const BLOOM_RESOLUTION_SCALE = 0.5;

/**
 * A precompile running: `done` settles once every collected object's
 * pipeline is built; `lastProgressAt` is when the last object finished (the
 * start before the first), so a holder can tell a slow compile from one that
 * stopped moving.
 */
export interface Precompile {
  readonly done: Promise<void>;
  lastProgressAt(): number;
  /** A synchronous draw while the compile still holds the renderer's target and outputs: drawn with the renderer's own. */
  aside<T>(draw: () => T): T;
  /** Give the renderer its own target and outputs back now (the holder stopped waiting; what is left builds at its first draw). */
  release(): void;
}

/** Nothing to compile (a disposed renderer). */
export const SETTLED_PRECOMPILE: Precompile = {
  done: Promise.resolve(),
  lastProgressAt: () => performance.now(),
  aside: (draw) => draw(),
  release: () => undefined,
};

/**
 * `renderer.compileAsync(scene, camera)` for a pass that draws
 * into `target` with `mrt`. compileAsync collects the objects synchronously
 * but builds each one's nodes and pipeline later, one per yield to the main
 * thread, and a material reads its outputs from the renderer's MRT at that
 * build: the target and outputs stay the pass's until the compile settles
 * (or `release`), else a material is built with one output for a target with
 * two and its pipeline fails, which leaves compileAsync unsettled.
 */
export function compileIntoTarget(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.RenderTarget | null, mrt: unknown): Precompile {
  const r = renderer as unknown as {
    getRenderTarget(): THREE.RenderTarget | null;
    setRenderTarget(t: THREE.RenderTarget | null): void;
    getMRT(): unknown;
    setMRT(m: unknown): void;
    compileAsync(s: THREE.Object3D, c: THREE.Camera, target?: THREE.Object3D | null, onProgress?: (() => void) | null): Promise<void>;
  };
  const target0 = r.getRenderTarget();
  const mrt0 = r.getMRT();
  let held = true;
  let last = performance.now();
  const release = (): void => {
    if (!held) return;
    held = false;
    r.setRenderTarget(target0);
    r.setMRT(mrt0);
  };
  r.setRenderTarget(target);
  r.setMRT(mrt);
  let job: Promise<void>;
  try {
    job = r.compileAsync(scene, camera, null, () => {
      last = performance.now();
    });
  } catch (e) {
    release();
    throw e;
  }
  return {
    done: job.finally(release),
    lastProgressAt: () => last,
    aside<T>(draw: () => T): T {
      if (!held) return draw();
      r.setRenderTarget(target0);
      r.setMRT(mrt0);
      try {
        return draw();
      } finally {
        r.setRenderTarget(target);
        r.setMRT(mrt);
      }
    },
    release,
  };
}
