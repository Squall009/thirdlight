/**
 * The Scene view's vertex paint brush, as data: its settings, what a press
 * paints on (a placed model, the copy under the pointer, or the path and
 * side of a generated wall or spline it landed on), and the one
 * `paintVertices` a stroke is.
 *
 * - The brush is the shared one (project-model `paint-brush.ts`): radius in
 *   metres, strength, falloff, the channel (R, G, B, A: what each means is
 *   the material's), erase. The backend paints the stroke's dabs with it;
 *   the page previews them with the same functions.
 * - Generated architecture keeps paint per path (an outline, a building,
 *   an element's sweep) and side (left or right of travel, or the faces
 *   looking up or down); a press paints the path nearest the point it landed
 *   on, on the side its face looks to.
 *
 * Pure: no DOM, no three.js.
 */
import type { ArchitectureComponent, PathPaintSide, SplineComponent } from '@thirdlight/project-model';
import { BRUSH_FALLOFFS, VERTEX_PAINT_BRUSH_LIMITS, VERTEX_PAINT_BYTES, newPathPlace, pathPaintFrame, pathSideOf, type BrushFalloff, type PaintVec3, type VertexPaintBrush } from '@thirdlight/runtime';

export interface VertexPaintSettings {
  /** Metres. */
  radius: number;
  /** How far one dab moves a vertex at the brush's middle toward full (or, erasing, toward nothing), (0, 1]. */
  strength: number;
  falloff: BrushFalloff;
  /** 0–3: R, G, B, A. */
  channel: number;
  erase: boolean;
  /** The channel the view shows as grey while the tool is open (null: the materials). */
  view: number | null;
}

export const VERTEX_PAINT_DEFAULTS: VertexPaintSettings = { radius: 0.5, strength: 0.5, falloff: 'smooth', channel: 0, erase: false, view: null };

/** The channels' names, in byte order. */
export const PAINT_CHANNEL_NAMES = ['R', 'G', 'B', 'A'] as const;

/** Why settings cannot paint (null: they can). */
export function vertexPaintSettingsError(s: VertexPaintSettings): string | null {
  const L = VERTEX_PAINT_BRUSH_LIMITS;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!finite(s.radius) || s.radius < L.radius.min || s.radius > L.radius.max) return `the radius is ${L.radius.min}–${L.radius.max} m`;
  if (!finite(s.strength) || s.strength <= 0 || s.strength > L.strengthMax) return `the strength is above 0, at most ${L.strengthMax}`;
  if (!BRUSH_FALLOFFS.includes(s.falloff)) return `the falloff is ${BRUSH_FALLOFFS.join(', ')}`;
  if (!Number.isInteger(s.channel) || s.channel < 0 || s.channel >= VERTEX_PAINT_BYTES) return 'the channel is R, G, B or A';
  if (s.view !== null && (!Number.isInteger(s.view) || s.view < 0 || s.view >= VERTEX_PAINT_BYTES)) return 'the channel view is off, R, G, B or A';
  return null;
}

/** The brush a stroke sends (the falloff only when not the default). */
export function strokeBrush(s: VertexPaintSettings): VertexPaintBrush {
  return { radius: s.radius, strength: s.strength, channel: s.channel, ...(s.falloff !== 'smooth' ? { falloff: s.falloff } : {}), ...(s.erase ? { erase: true } : {}) };
}

/** What a stroke paints on its object. */
export type PaintTarget = { kind: 'model' } | { kind: 'copy'; copy: number } | { kind: 'path'; path: string; side: PathPaintSide };

/** The `paintVertices` args of a stroke. */
export function paintVerticesArgs(entityId: string, target: PaintTarget, dabs: readonly PaintVec3[], brush: VertexPaintBrush): Record<string, unknown> {
  return {
    entityId,
    dabs: dabs.map((d) => [d[0], d[1], d[2]]),
    brush,
    ...(target.kind === 'copy' ? { copy: target.copy } : {}),
    ...(target.kind === 'path' ? { path: target.path, side: target.side } : {}),
  };
}

/** Dabs are sent in millimetres (a stroke stays small; the brush is far coarser). */
export const roundDab = (p: readonly number[]): PaintVec3 => [Math.round(p[0]! * 1000) / 1000, Math.round(p[1]! * 1000) / 1000, Math.round(p[2]! * 1000) / 1000];

/** A new dab once the pointer moved this many radii from the last one. */
export const DAB_STEP = 0.25;

/** The paths a generated object keeps paint for: its outlines', buildings' and swept elements'; a spline's own. */
export function pathKeysOf(c: { architecture?: Pick<ArchitectureComponent, 'outlines' | 'buildings' | 'elements'>; spline?: SplineComponent }): string[] {
  if (c.spline !== undefined) return ['spline'];
  const a = c.architecture;
  if (a === undefined) return [];
  return [
    ...(a.outlines ?? []).map((o) => `outline:${o.id}`),
    ...(a.buildings ?? []).map((b) => `building:${b.id}`),
    ...a.elements.filter((e) => (e as { path?: unknown }).path !== undefined).map((e) => `element:${e.id}`),
  ];
}

/**
 * The path and side a press on a generated object paints: of its paths, the
 * one nearest the point (in the object's frame; across a wall face, the
 * nearest by distance across; on a face looking up or down, by distance
 * along the ground), the side by the face's normal. Null: it keeps no paths.
 */
export function pathTargetAt(c: { architecture?: Pick<ArchitectureComponent, 'outlines' | 'buildings' | 'elements'>; spline?: SplineComponent }, local: readonly number[], normal: readonly number[]): { path: string; side: PathPaintSide } | null {
  let best: { path: string; side: PathPaintSide; d: number } | null = null;
  const place = newPathPlace();
  for (const key of pathKeysOf(c)) {
    const frame = pathPaintFrame(c, key);
    if (frame === null) continue;
    frame.locate(local[0]!, local[1]!, local[2]!, place);
    const side = pathSideOf(normal[0]!, normal[1]!, normal[2]!, place);
    const d = Math.abs(place.across);
    if (best === null || d < best.d) best = { path: key, side, d };
  }
  return best === null ? null : { path: best.path, side: best.side };
}

/**
 * The `setComponent` that takes one mesh's stale paint off an object (a model's
 * `vertexPaint`, a set's `instances.paint`): a merge of the fields left, a
 * field null when nothing of it is left, the component null when nothing is.
 * Null: the object holds no paint for that mesh.
 */
export function withoutMeshPaint(components: Record<string, unknown>, mesh: string): { component: 'vertexPaint' | 'instances'; value: Record<string, unknown> | null } | null {
  const vp = components['vertexPaint'] as { meshes?: { mesh: string }[]; paths?: unknown[] } | undefined;
  if (vp?.meshes?.some((m) => m.mesh === mesh) === true) {
    const meshes = vp.meshes.filter((m) => m.mesh !== mesh);
    if (meshes.length === 0 && vp.paths === undefined) return { component: 'vertexPaint', value: null };
    return { component: 'vertexPaint', value: { meshes: meshes.length > 0 ? meshes : null } };
  }
  const inst = components['instances'] as { paint?: { meshes: { mesh: string }[] } } | undefined;
  if (inst?.paint?.meshes.some((m) => m.mesh === mesh) === true) {
    const meshes = inst.paint.meshes.filter((m) => m.mesh !== mesh);
    return { component: 'instances', value: { paint: meshes.length > 0 ? { ...inst.paint, meshes } : null } };
  }
  return null;
}
