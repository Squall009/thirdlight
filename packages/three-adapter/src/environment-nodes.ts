/**
 * Phase 17.3: the environment on three's `WebGPURenderer` (its WebGPU and
 * WebGL 2 backends) — the TSL twins of the WebGL-only pieces of
 * `environment.ts`:
 *
 * - `createSkyMesh`: the physical sky as three's `SkyMesh` (the TSL port of
 *   `Sky.js`), clouds held still like the archived (WebGL) sky (its `time` never moves);
 * - `gradientSkyMaterial`: the gradient dome, the archived (WebGL) shader line by line;
 * - `buildPostPipeline`: the post stack as a `RenderPipeline` (three's node
 *   post-processing, renamed from `PostProcessing` in r183) in the archived WebGL
 *   pass order: scene → ambient occlusion (GTAO) → fog volumes → depth of
 *   field → bloom → output (tone mapping + sRGB) → grading / LUT / vignette →
 *   SMAA / FXAA. The fog volume and grading passes mirror the archived (WebGL) GLSL line
 *   by line; AO, DOF, bloom, SMAA and FXAA are three's TSL display nodes.
 *
 * Pure three.js (`three/webgpu`, `three/tsl`, examples); nothing here needs a
 * GPU until a renderer builds the nodes.
 */
import * as THREE from 'three';
import {
  abs,
  clamp,
  dot,
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
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { dof } from 'three/examples/jsm/tsl/display/DepthOfFieldNode.js';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { smaa } from 'three/examples/jsm/tsl/display/SMAANode.js';
import { fxaa } from 'three/examples/jsm/tsl/display/FXAANode.js';

/** TSL nodes are loosely typed here (three's node typings are generic-heavy); values stay three objects. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** The fog volume cap (the same as the archived (WebGL) pass). */
export const MAX_FOG_VOLUMES = 16;

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
  return m;
}

/** What the post stack does (already reduced by the quality level). */
export interface PostPlan {
  ssao: { radius: number; intensity: number } | null;
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
  /** Resolution of the scene pass relative to the canvas (the quality level's pixel ratio over the device's). */
  resolutionScale: number;
  /**
   * The scene's background (a colour or an sRGB sky image) is shown as a
   * display colour, not tone mapped — what the WebGL renderer does when it
   * draws straight to the canvas (no post stack). WebGPURenderer tone maps
   * the whole frame, so the background is drawn in its own pass and laid
   * under the tone-mapped picture.
   */
  displayBackground: boolean;
  /** MSAA samples of the scene pass (0: none). */
  samples: number;
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
  render(): void;
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

export function buildPostPipeline(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, plan: PostPlan): PostPipeline {
  const disposables: { dispose(): void }[] = [];
  const passes: string[] = ['render'];
  const perspective = camera instanceof THREE.PerspectiveCamera;
  const scenePass: N = pass(scene, camera, plan.samples > 0 ? { samples: plan.samples } : {});
  disposables.push(scenePass);
  if (plan.resolutionScale !== 1) scenePass.setResolutionScale(plan.resolutionScale);
  const wantsAo = plan.ssao !== null && perspective;
  if (wantsAo) scenePass.setMRT(mrt({ output, normal: normalView }));
  const depth: N = scenePass.getTextureNode('depth');
  let color: N = scenePass.getTextureNode('output');

  // Camera matrices of the drawn camera (the pipeline's own quad has another camera).
  const invProjection = uniform(new THREE.Matrix4());
  const cameraWorld = uniform(new THREE.Matrix4());

  if (wantsAo) {
    const aoNode: N = ao(depth, scenePass.getTextureNode('normal'), camera);
    aoNode.radius.value = plan.ssao!.radius;
    disposables.push(aoNode);
    const intensity = uniform(plan.ssao!.intensity);
    const occlusion = aoNode.getTextureNode().r;
    // The archived GLSL blend: colour × mix(1, ao, intensity).
    color = vec4(color.rgb.mul(mix(float(1), occlusion, intensity)), color.a);
    passes.push('ssao');
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
    const dofNode: N = dof(color, scenePass.getViewZNode(), uniform(dofPlan.focus), uniform(focalLength), bokehScale);
    disposables.push(dofNode);
    color = dofNode;
    passes.push('dof');
  }

  if (plan.bloom !== null) {
    // UnrealBloomPass scales its composite by 3 ("backwards compatibility with previous
    // alpha-based intensity"); BloomNode does not: the project's strength keeps its meaning.
    const bloomNode: N = bloom(color, plan.bloom.strength * 3, plan.bloom.radius, plan.bloom.threshold);
    disposables.push(bloomNode);
    // UnrealBloom adds its glow onto the picture (alpha unchanged).
    color = vec4(color.rgb.add(bloomNode.rgb), color.a);
    passes.push('bloom');
  }

  color = renderOutput(color);
  passes.push('output');

  // The background as a display colour under the picture (premultiplied "over").
  const bgScene = plan.displayBackground ? new THREE.Scene() : null;
  if (bgScene !== null) {
    const bgPass: N = pass(bgScene, camera, { depthBuffer: false });
    disposables.push(bgPass);
    const bg: N = renderOutput(bgPass.getTextureNode('output'), THREE.NoToneMapping);
    const fg = color;
    color = vec4(fg.rgb.add(bg.rgb.mul(float(1).sub(fg.a))), fg.a.add(bg.a.mul(float(1).sub(fg.a))));
  }

  // ---- grading, LUT, vignette (the archived (WebGL) TlGradingShader, line by line) --------------
  const lutNode: N = texture(blankLut());
  const lutSize = uniform(0);
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

  if (plan.aa === 'smaa') {
    const n: N = smaa(color);
    disposables.push(n);
    color = n;
    passes.push('smaa');
  } else if (plan.aa === 'fxaa') {
    const n: N = fxaa(color);
    disposables.push(n);
    color = n;
    passes.push('fxaa');
  }

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
    setSize(width, height, pixelRatio) {
      void height;
      if (dofPlan !== null) bokehScale.value = 0.4 * dofPlan.maxBlur * width * pixelRatio * plan.resolutionScale;
    },
    render() {
      if (bgScene === null) {
        pipeline.render();
        return;
      }
      // The scene pass draws on transparent black without the background; the background pass draws only it.
      const s = scene as THREE.Scene & { backgroundIntensity: number; backgroundBlurriness: number };
      const b = bgScene as THREE.Scene & { backgroundIntensity: number; backgroundBlurriness: number };
      const background = s.background;
      b.background = background;
      b.backgroundIntensity = s.backgroundIntensity;
      b.backgroundBlurriness = s.backgroundBlurriness;
      b.backgroundRotation.copy(s.backgroundRotation);
      const clear = renderer.getClearColor(new THREE.Color());
      const alpha = renderer.getClearAlpha();
      s.background = null;
      renderer.setClearColor(0x000000, 0);
      try {
        pipeline.render();
      } finally {
        s.background = background;
        b.background = null;
        renderer.setClearColor(clear, alpha);
      }
    },
    dispose() {
      pipeline.dispose();
      (lutNode.value as THREE.Texture).dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
