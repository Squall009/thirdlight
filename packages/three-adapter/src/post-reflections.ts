/**
 * Reflections on glossy surfaces (WebGPU, with the look's post effects).
 *
 * Each frame, after the scene pass (`post-reflections-pass.ts`):
 *
 * 1. **Screen-space rays**, at `REFLECTION_RESOLUTION_SCALE` of the render
 *    scale: a glossy pixel (roughness up to `REFLECTION_ROUGHNESS_MAX`)
 *    casts one ray, turned at random within its roughness's lobe (GGX),
 *    marched a fixed number of steps through the frame's depth; a hit takes
 *    the frame's own lit colour there (emissive surfaces and their bloom's
 *    source included).
 * 2. **Where the screen has no answer** (the ray left it, went behind
 *    something or faded at an edge), one pixel in every square of the trace
 *    casts its ray through the static world on the GPU instead
 *    (`surface-reflection-pass.ts`): the hit's light is the surface cache's
 *    (direct light with its soft shadows, the probes' bounce, the surface's
 *    colour), so a reflection shows the lit world off screen too. The
 *    squares' size follows the GPU time the rays took (`traceSpacing`),
 *    within the quality's budget; the traced pixel moves through its square
 *    frame by frame, and its light is spread over the square's pixels that
 *    share its depth and facing.
 * 3. **A temporal resolve** blends each frame's rays into the last frames'
 *    (the history reprojected through the camera's motion, kept only where
 *    its depth matches), which turns the scattered rays of a glossy surface
 *    into its blur. The rays turn only while the view moves (and
 *    `REFLECTION_STILL_FRAMES` after): a still view of a still scene settles
 *    to one picture.
 *
 * How it reaches the materials: as `ReflectionsLight`, a light of the scene
 * whose node (built last, after the environment and the probes) blends the
 * last frame's resolved reflection, reprojected, into a physical material's
 * environment radiance, by its confidence and by the pixel's roughness
 * (none past `REFLECTION_ROUGHNESS_MAX`: rough surfaces keep the
 * environment's light as the probes darken it). So Fresnel, metalness,
 * roughness and ambient occlusion apply to it as to any reflection. A
 * scene without the light builds the programs it built before.
 *
 * WebGL 2 draws none (it keeps the environment and probes); neither does a
 * frame drawn without the look's post effects (the same rule as contact
 * shadows: a frame through the stack for another reason looks the same).
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import { ScreenHistoryLight, takesScreenHistory, HISTORY_DEPTH_TOLERANCE } from './screen-history';
import { untransformedTexture } from './texel-texture-node';

const TSL: N = TSLTyped;
const { If, abs, float, Fn, mix, positionView, roughness, select, smoothstep, vec2, vec4 } = TSL;

/** The reflection passes' resolution relative to the scene pass (a quarter of its pixels). */
export const REFLECTION_RESOLUTION_SCALE = 0.5;
/** Past this roughness a surface reflects only its environment (as the probes darken it): its lobe is too wide for one ray a pixel. */
export const REFLECTION_ROUGHNESS_MAX = 0.5;
/** From this roughness the traced reflection fades into the environment's light, gone by `REFLECTION_ROUGHNESS_MAX`. */
export const REFLECTION_ROUGHNESS_FADE = 0.35;
/** How far (m) a screen-space ray marches. */
export const REFLECTION_SCREEN_METRES = 24;
/** How far (m) a traced ray goes; past it the environment's light stands in. */
export const REFLECTION_TRACE_METRES = 32;
/** A new frame's share of the resolved reflection (the history keeps the rest). */
export const REFLECTION_HISTORY_BLEND = 0.15;
/** The pixel spacings of traced rays (one ray a k × k square of the trace), finest first. */
export const REFLECTION_TRACE_SPACINGS: readonly number[] = [2, 3, 4, 6, 8, 12, 16];
/** The spacing before any traced frame's cost is known. */
export const REFLECTION_START_SPACING = 8;
/**
 * Frames a still view keeps turning its rays after it stopped (the history
 * averages them meanwhile); then the rays hold still, and a still scene
 * settles to one picture while a moving object's reflection still follows it.
 */
export const REFLECTION_STILL_FRAMES = 8;
/** A new frame's share once the rays hold still (each frame then casts the same rays: a change shows sooner). */
export const REFLECTION_STILL_BLEND = 0.5;
/** The most frames between two traced runs when one run costs more than the budget. */
export const REFLECTION_TRACE_INTERVAL_MAX = 8;
/** Frames between two traced runs while the view stands still (its rays are the same; a light's change still shows). */
export const REFLECTION_STILL_TRACE_FRAMES = 8;
/** Frames between two choices of the spacing (each change moves every traced pixel). */
export const REFLECTION_SPACING_FRAMES = 30;

/** What a quality level's reflections do: the screen-space march's steps and refinements, and the traced rays' GPU budget and finest spacing. */
export interface ReflectionLevel {
  readonly steps: number;
  readonly refine: number;
  readonly traceMs: number;
  readonly minSpacing: number;
}
export const REFLECTION_LEVELS: Readonly<Record<'medium' | 'high', ReflectionLevel>> = Object.freeze({
  medium: Object.freeze({ steps: 16, refine: 3, traceMs: 0.5, minSpacing: 4 }),
  high: Object.freeze({ steps: 32, refine: 4, traceMs: 1, minSpacing: 2 }),
});

/** `?reflections=0` (none at any level), `?reflections=screen` (no traced rays): comparisons of what each costs and shows; `?reflections=view` draws the resolved reflections alone. */
export const REFLECTIONS_URL_PARAM = 'reflections';
export type ReflectionsFlag = 'off' | 'screen' | 'view' | null;
export function reflectionsFlag(search: string): ReflectionsFlag {
  const v = new URLSearchParams(search).get(REFLECTIONS_URL_PARAM);
  return v === '0' || v === 'off' ? 'off' : v === 'screen' || v === 'view' ? v : null;
}

/** The traced pixels of a `width` × `height` trace at spacing `k` with the square's place `ox`, `oy`: the squares across and down, and the rays. */
export function traceTiles(width: number, height: number, k: number, ox: number, oy: number): { x: number; y: number; count: number } {
  const x = width > ox ? Math.floor((width - 1 - ox) / k) + 1 : 0;
  const y = height > oy ? Math.floor((height - 1 - oy) / k) + 1 : 0;
  return { x, y, count: x * y };
}

/** Steps through a square's k² places, coprime with every spacing's k², so consecutive frames' places lie apart. */
const PLACE_STEP = 7;
/** Frame `frame`'s traced place in a k × k square: every place once in k² frames. */
export function traceOffset(frame: number, k: number): [number, number] {
  const i = (frame * PLACE_STEP) % (k * k);
  return [i % k, Math.floor(i / k)];
}

/**
 * The finest spacing (not under `minSpacing`) whose rays fit `budgetMs` at
 * `msPerRay` over a `width` × `height` trace; before any cost is known,
 * `REFLECTION_START_SPACING`; the coarsest when none fits.
 */
export function traceSpacing(width: number, height: number, msPerRay: number | null, budgetMs: number, minSpacing: number): number {
  const spacings = REFLECTION_TRACE_SPACINGS.filter((k) => k >= minSpacing);
  if (msPerRay === null || !(msPerRay > 0)) return Math.max(minSpacing, REFLECTION_START_SPACING);
  for (const k of spacings) if (traceTiles(width, height, k, 0, 0).count * msPerRay <= budgetMs) return k;
  return spacings[spacings.length - 1]!;
}

/** `scene.userData[REFLECTION_TRACER_KEY]`: the live surface light's tracer for reflection rays (absent: none, screen-space only). */
export const REFLECTION_TRACER_KEY = '__tlReflectionTracer';
/** What the reflections ask of the surface light: trace rays on its device into a buffer of their light. */
export interface ReflectionTracer {
  /** Trace `count` rays (`RAY_FLOATS` each in `rays`) and write each one's light into `out` (rgb; 1 hit, 0 none, -1 not cast). False: nothing traced yet. */
  trace(rays: unknown, out: unknown, count: number): boolean;
  /** GPU ms a traced ray cost lately (null: not measured). */
  msPerRay(): number | null;
  /** The last timed frame's GPU ms and rays (diagnostics). */
  last(): { ms: number | null; rays: number };
}

/** What the reflections did lately (the renderer's diagnostics). */
export interface ReflectionStats {
  /** The trace's size in pixels. */
  width: number;
  height: number;
  /** The traced rays' pixel spacing and count a run (0: none traced), and the frames between runs. */
  spacing: number;
  rays: number;
  every: number;
  /** GPU ms of the last timed frame's traced rays (null: not timed or none). */
  traceMs: number | null;
}

/**
 * The reflections as a light of the scene: its history (`historyTarget`:
 * the last frame's resolved reflection, rgb and confidence) and that
 * frame's view depth beside it (`depthTarget`), both at the trace's size.
 */
export class ReflectionsLight extends ScreenHistoryLight {
  readonly isReflections = true;
  readonly depthTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  readonly depth: N = untransformedTexture(this.depthTarget.texture);
  stats: ReflectionStats = { width: 0, height: 0, spacing: 0, rays: 0, every: 1, traceMs: null };

  constructor() {
    super('reflections');
  }

  override dispose(): void {
    this.depthTarget.dispose();
    super.dispose();
  }
}

/** Whether `light` is the reflections light. */
export function isReflectionsLight(light: unknown): light is ReflectionsLight {
  return (light as Partial<ReflectionsLight> | null)?.isReflections === true;
}

const HISTORY_DEPTH_SLACK_M = 0.05;

/** The last frame's resolved reflection where this pixel's surface was: rgb, and its confidence (0 where none holds). */
export function reflectionAt(l: ReflectionsLight): N {
  return Fn(() => {
    const p = vec4(positionView, 1);
    const view = l.toLastView.mul(p).xyz.toVar();
    const clip = l.toLastClip.mul(p).toVar();
    const at = clip.xy.div(clip.w).mul(vec2(0.5, -0.5)).add(0.5).toVar();
    const h = l.history.sample(at).toVar();
    const z = l.depth.sample(at).x;
    const onScreen = at.x.greaterThanEqual(0).and(at.x.lessThanEqual(1)).and(at.y.greaterThanEqual(0)).and(at.y.lessThanEqual(1));
    const same = abs(z.sub(view.z)).lessThan(abs(view.z).mul(HISTORY_DEPTH_TOLERANCE).add(HISTORY_DEPTH_SLACK_M));
    return vec4(h.rgb, select(onScreen.and(same).and(l.active.greaterThan(0.5)), h.a, float(0)));
  })();
}

/** How much of the traced reflection a surface of roughness `r` takes (the rest is its environment's). */
export function roughnessShare(r: N): N {
  return float(1).sub(smoothstep(REFLECTION_ROUGHNESS_FADE, REFLECTION_ROUGHNESS_MAX, r));
}

/** The light's node: blends the reflection into a physical material's environment radiance (opaque materials and mesh decals only). */
class ReflectionsNode extends (THREE.LightingNode as unknown as new () => { [k: string]: unknown }) {
  static get type(): string {
    return 'ReflectionsNode';
  }
  readonly isReflectionsNode = true;

  constructor(readonly light: ReflectionsLight) {
    super();
  }

  setup(builder: N): void {
    if (!takesScreenHistory(builder) || !(builder.context?.lightingModel instanceof THREE.PhysicalLightingModel)) return;
    const ctx = builder.context;
    // A rough pixel reads nothing (the history's two samples cost every lit pixel otherwise).
    If(roughness.lessThan(REFLECTION_ROUGHNESS_MAX), () => {
      const r = reflectionAt(this.light).toVar();
      ctx.radiance.assign(mix(ctx.radiance, r.rgb, r.a.mul(roughnessShare(roughness))));
    });
  }
}

/** Whether a light node is the reflections' (the lights node builds it last: it replaces what the environment and probes put in). */
export function isReflectionsNode(node: unknown): boolean {
  return (node as { isReflectionsNode?: boolean } | null)?.isReflectionsNode === true;
}

/** Teach a renderer the reflections light. */
export function registerReflections(renderer: { library: { addLight(node: unknown, light: unknown): void } }): void {
  renderer.library.addLight(ReflectionsNode, ReflectionsLight);
}
