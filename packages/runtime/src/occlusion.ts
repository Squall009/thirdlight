/**
 * Occlusion culling's rules, shared by every renderer path: which path a
 * frame culls on, and which draws are worth testing at all.
 *
 * Paths: `hiz` tests bounds against a depth pyramid built from the frame's
 * own depth, on the GPU (WebGPU only: it needs compute and indirect draws);
 * `queries` asks the GPU whether a draw's box has any visible pixel, an
 * answer that arrives a frame or more later (both renderers); `off` draws
 * everything in view. The project's `occlusion_culling` (or its quality
 * level's) says auto or off; auto takes the renderer's best path. A page flag
 * may pin a path for a comparison.
 *
 * Occludees are what can be culled: one draw (or one copy of an instanced
 * draw). Whether testing it pays is decided here, once, from what it is, how
 * large it is on screen and how many triangles it draws: the thresholds live
 * in this module and nowhere else.
 *
 * Presentation only: the simulation never sees any of it. Pure: no I/O.
 */
import type { OcclusionCulling } from '@thirdlight/project-model';

export const OCCLUSION_PATHS = ['off', 'queries', 'hiz'] as const;
export type OcclusionPath = (typeof OCCLUSION_PATHS)[number];

/** The renderer a frame is drawn with (null: not known yet). */
export type OcclusionRenderer = 'webgpu' | 'webgl2' | null;

/** Which path a frame culls on, and what decided it. */
export interface OcclusionPathChoice {
  readonly path: OcclusionPath;
  /** `page`: the page flag pinned it; `setting`: the project's or the quality level's setting. */
  readonly source: 'page' | 'setting';
}

/** Whether `renderer` has `path` (the depth pyramid needs WebGPU's compute and indirect draws). */
export function occlusionPathAvailable(path: OcclusionPath, renderer: OcclusionRenderer): boolean {
  if (path === 'off') return true;
  if (renderer === null) return false;
  return path === 'queries' || renderer === 'webgpu';
}

/**
 * The path a frame culls on. A pinned path the renderer does not have draws
 * with none: a comparison never measures another path than the one it named.
 */
export function occlusionPathOf(setting: OcclusionCulling, renderer: OcclusionRenderer, pinned: OcclusionPath | null = null): OcclusionPathChoice {
  if (pinned !== null) return { path: occlusionPathAvailable(pinned, renderer) ? pinned : 'off', source: 'page' };
  if (setting === 'off' || renderer === null) return { path: 'off', source: 'setting' };
  return { path: renderer === 'webgpu' ? 'hiz' : 'queries', source: 'setting' };
}

/** A path from a page flag's value (null: not a path). */
export function occlusionPathFrom(v: unknown): OcclusionPath | null {
  return (OCCLUSION_PATHS as readonly unknown[]).includes(v) ? (v as OcclusionPath) : null;
}

/**
 * What an occludee is. `instanced`: copies of one mesh in one draw (instance
 * sets, scatter, ground cover, automatic batches); `merged`: a static cell's
 * merged meshes; `terrain`: a terrain page's nodes; `blocks` and
 * `architecture`: a block layer's or generated architecture's chunk;
 * `single`: a model or box drawn alone; `transparent`: anything blended
 * (decals among them), which hides nothing but can be hidden.
 */
export const OCCLUDEE_KINDS = ['instanced', 'merged', 'terrain', 'blocks', 'architecture', 'single', 'transparent'] as const;
export type OccludeeKind = (typeof OCCLUDEE_KINDS)[number];

/** The kinds tested copy by copy (or node by node) rather than as one draw. */
const ITEM_KINDS: ReadonlySet<OccludeeKind> = new Set(['instanced', 'terrain']);

/**
 * The fewest triangles a draw (all of its items together) must draw for a
 * test to pay: a WebGL 2 query draws a 12-triangle box in a draw call of its
 * own, so a draw below this costs about what its test does.
 */
export const OCCLUSION_MIN_TRIANGLES = 64;

/**
 * The largest share of the view's height a draw tested whole may cover (its
 * bounding sphere's projected radius over half the view's height). Something
 * that large is almost never hidden whole, and the eye is often inside its
 * box; per-item draws are tested by their items, so this does not apply to them.
 */
export const OCCLUSION_MAX_SCREEN_SHARE = 0.5;

/** What decides whether an occludee is tested. */
export interface OccludeeFacts {
  readonly kind: OccludeeKind;
  /** Triangles one item draws. */
  readonly triangles: number;
  /** Items in the draw: copies, terrain nodes, or 1. */
  readonly items: number;
  /** The draw's bounding sphere's projected radius over half the view's height (`occludeeScreenShare`). */
  readonly screenShare: number;
}

/** `never`: always drawn; `whole`: the draw is tested as one; `items`: each copy or node is tested. */
export type OccludeeClass = 'never' | 'whole' | 'items';

/** How an occludee is tested (see the thresholds above). */
export function occludeeClassOf(f: OccludeeFacts): OccludeeClass {
  const items = Math.max(1, f.items);
  if (!(f.screenShare >= 0)) return 'never';
  if (Math.max(0, f.triangles) * items < OCCLUSION_MIN_TRIANGLES) return 'never';
  if (items > 1 && ITEM_KINDS.has(f.kind)) return 'items';
  if (f.screenShare > OCCLUSION_MAX_SCREEN_SHARE) return 'never';
  return 'whole';
}

/**
 * A bounding sphere's size on screen: its projected radius over half the
 * view's height, for a perspective view whose vertical half-angle has tangent
 * `tanHalfFovY`; Infinity when the eye is inside the sphere (never hidden).
 */
export function occludeeScreenShare(radius: number, distance: number, tanHalfFovY: number): number {
  if (!(distance > radius)) return Number.POSITIVE_INFINITY;
  return radius / (distance * Math.max(1e-6, tanHalfFovY));
}
