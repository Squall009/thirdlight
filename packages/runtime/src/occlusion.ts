/**
 * Occlusion culling's rules, shared by every renderer path: which path a
 * frame culls on, and which draws are worth testing at all.
 *
 * Paths: `hiz` tests bounds against a depth pyramid built from the frame's
 * own depth, on the GPU (WebGPU only: it needs compute and indirect draws);
 * `queries` asks the GPU whether a draw's box has any visible pixel, an
 * answer that arrives a frame or more later (WebGL 2 only: WebGPU has the
 * pyramid, which answers in the same frame); `off` draws everything in view. The project's `occlusion_culling` (or its quality
 * level's) says auto or off; auto takes the depth pyramid on WebGPU and
 * culls nothing on WebGL 2: its queries' answers come two frames late at
 * 60 Hz and dozens of frames late on a frame-bound GPU, more than the one
 * frame a draw may come late from behind a wall. A page flag may pin a path
 * for a comparison (`queries` on WebGL 2).
 *
 * Occludees are what can be culled: one draw (or one copy of an instanced
 * draw). Whether testing it pays is decided here, once, from what it is, how
 * large it is on screen and how many triangles it draws: the thresholds live
 * in this module and nowhere else.
 *
 * Occluders are what hides them: the depth the view's draws leave before the
 * test (a depth pyramid's source, or the depth occlusion queries are drawn
 * against). What counts is decided here too (`occluderRoleOf`): level
 * geometry first, then opaque solid surfaces, then `_OCC` stand-ins; never
 * what is see-through or thin, nor what its object opts out.
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
  return path === 'queries' ? renderer === 'webgl2' : renderer === 'webgpu';
}

/**
 * The path a frame culls on. A pinned path the renderer does not have draws
 * with none: a comparison never measures another path than the one it named.
 */
export function occlusionPathOf(setting: OcclusionCulling, renderer: OcclusionRenderer, pinned: OcclusionPath | null = null): OcclusionPathChoice {
  if (pinned !== null) return { path: occlusionPathAvailable(pinned, renderer) ? pinned : 'off', source: 'page' };
  if (setting === 'off' || renderer === null) return { path: 'off', source: 'setting' };
  return { path: renderer === 'webgpu' ? 'hiz' : 'off', source: 'setting' };
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
 * The fewest triangles a draw culled on the GPU must draw in view: an
 * instanced draw's copies together (else it is drawn whole that frame), or a
 * draw culled whole (a chunk, a merged cell, a model alone). A culled draw is
 * a row of the GPU's tests and an indirect draw, kept up to date on the main
 * thread, which the GPU time a draw of fewer triangles saves does not win
 * back. Measured on the village class (Iris Xe), whose automatic batches of a
 * few small props, and models alone, cost more culled than drawn.
 */
export const OCCLUSION_MIN_COPIES_TRIANGLES = 2048;

/**
 * The largest share of the view's height a draw tested whole may cover (its
 * bounding sphere's projected radius over half the view's height). Something
 * that large is almost never hidden whole, and the eye is often inside its
 * box; per-item draws are tested by their items, so this does not apply to them.
 */
export const OCCLUSION_MAX_SCREEN_SHARE = 0.5;

/**
 * Occlusion queries (WebGL 2): a draw seen at its last answer is asked again
 * at least every this many frames (its box's query is a draw of its own); a
 * draw hidden, or hidden at its last answer, is asked every frame, so it is
 * shown at its first answer that sees it.
 */
export const OCCLUSION_QUERY_SPREAD_FRAMES = 4;

/**
 * The oldest answer (in frames since its query was drawn) a draw is hidden
 * by. An answer arrives a frame or more after its query; an older one is
 * not trusted and the draw is drawn. The boxes queried grow by the camera's
 * motion over this many frames and one more.
 */
export const OCCLUSION_QUERY_MAX_AGE_FRAMES = 2;

/**
 * How much a queried box grows past the draw's bounds: a fixed margin and a
 * share of its distance from the eye, so its faces lie in front of the
 * draw's own surfaces in the depth buffer (a box face on a wall's face would
 * fail the depth test against the wall itself), however coarse the depth is
 * far away.
 */
export const OCCLUSION_QUERY_MARGIN_M = 0.05;
export const OCCLUSION_QUERY_MARGIN_SHARE = 0.01;

/**
 * A camera cut: the eye moved more than this many metres further in a frame
 * than in the frame before (a teleport or a cut, not a steady flight, which
 * the boxes' growth covers), or turned more than this many radians. The
 * answers drawn from the old view are forgotten and everything is drawn.
 */
export const OCCLUSION_CUT_JUMP_M = 1;
export const OCCLUSION_CUT_TURN_RAD = 0.35;

/** How far a queried box grows (metres) at `distance` from the eye, while the eye moves `step` metres a frame. */
export function occlusionQueryMargin(distance: number, step: number): number {
  return OCCLUSION_QUERY_MARGIN_M + Math.max(0, distance) * OCCLUSION_QUERY_MARGIN_SHARE + Math.max(0, step) * (OCCLUSION_QUERY_MAX_AGE_FRAMES + 1);
}

/**
 * Whether the view jumped between two frames: the eye moved `step` metres
 * (`lastStep` in the frame before) and its forward direction turned by an
 * angle whose cosine is `turnCos`.
 */
export function occlusionCameraCut(step: number, lastStep: number, turnCos: number): boolean {
  return step > Math.max(0, lastStep) + OCCLUSION_CUT_JUMP_M || turnCos < Math.cos(OCCLUSION_CUT_TURN_RAD);
}

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
 * What a draw is among the occluders. `early`: level geometry (terrain
 * pages, block and architecture chunks, merged static cells), drawn before
 * everything else so the depth is filled by what hides the most;
 * `surface`: an opaque draw whose own depth counts; `standin`: a model's
 * `_OCC` node, drawn into the view's depth only, after the opaque surfaces
 * (so this frame's colour is what it is without it); `none`: hides nothing.
 */
export const OCCLUDER_ROLES = ['early', 'surface', 'standin', 'none'] as const;
export type OccluderRole = (typeof OCCLUDER_ROLES)[number];

/** What decides a draw's occluder role. */
export interface OccluderFacts {
  /** Its occludee kind (null: not an occludee, e.g. a draw three never culls). */
  readonly kind: OccludeeKind | null;
  /** A model's `_OCC` stand-in. */
  readonly standin: boolean;
  /** Its object's `occluder` is false. */
  readonly optedOut: boolean;
  /** Its model's stand-ins (or its `occluder` import setting) speak for its surfaces. */
  readonly surfacesStandDown: boolean;
  readonly transparent: boolean;
  /** Its material discards pixels (alpha test, alpha to coverage): its depth has holes. */
  readonly alphaTested: boolean;
  /** Its material draws both faces: a card or a thin sheet, whose depth hides little and is often cut out. */
  readonly doubleSided: boolean;
}

/** A draw's occluder role (see {@link OCCLUDER_ROLES}). */
export function occluderRoleOf(f: OccluderFacts): OccluderRole {
  if (f.optedOut) return 'none';
  if (f.standin) return 'standin';
  if (f.transparent || f.kind === 'transparent') return 'none';
  // Level geometry counts by kind: its cut-outs (a grate, a leaf block) still write the depth of what they draw.
  if (f.kind === 'terrain' || f.kind === 'blocks' || f.kind === 'architecture') return 'early';
  if (f.surfacesStandDown || f.alphaTested || f.doubleSided) return 'none';
  return f.kind === 'merged' ? 'early' : 'surface';
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
