/**
 * The Scene view's vertex paint brush, as data: its settings, what a press
 * paints on (a placed model, the copy under the pointer, or the path and
 * side of a generated wall or spline it landed on), and the one
 * `paintVertices` a stroke is.
 *
 * - The brush is the shared one (`brush.ts`: size across in metres,
 *   strength, opacity, falloff, spacing, invert, the noise mask) with the
 *   channel the palette's tile paints (`vertex-paint-channels.ts`: what each
 *   means is the material's). The backend paints the stroke's dabs with
 *   project-model's `paint-brush.ts`; the page previews them with the same
 *   functions.
 * - Generated architecture keeps paint per path (an outline, a building,
 *   an element's sweep) and side (left or right of travel, or the faces
 *   looking up or down); a press paints the path nearest the point it landed
 *   on, on the side its face looks to.
 *
 * Pure: no DOM, no three.js.
 */
import type { CommandErrorCode } from '@thirdlight/commands';
import type { ArchitectureComponent, PathPaintSide, SplineComponent } from '@thirdlight/project-model';
import { VERTEX_PAINT_BRUSH_LIMITS, newPathPlace, pathPaintFrame, pathSideOf, type PaintVec3, type VertexPaintBrush } from '@thirdlight/runtime';

import { DEFAULT_BRUSH, brushRadius, brushStrokeExtras, type BrushBounds, type BrushSettings, type BrushUse } from './brush';
import type { PaintTarget as PaintChannelTarget } from './vertex-paint-channels';

/** The settings the vertex paint brush uses (the shared panel's rows, its keys, what a stroke sends). */
export const VERTEX_PAINT_USES: readonly BrushUse[] = ['size', 'strength', 'opacity', 'falloff', 'spacing', 'invert', 'mask'];

/** Sizes a stroke may carry (across: twice the command's radius bounds); paint has no height step (kept at the default). */
export const VERTEX_PAINT_BRUSH_BOUNDS: BrushBounds = Object.freeze({ size: [2 * VERTEX_PAINT_BRUSH_LIMITS.radius.min, 2 * VERTEX_PAINT_BRUSH_LIMITS.radius.max] as const, heightStep: [DEFAULT_BRUSH.heightStep, DEFAULT_BRUSH.heightStep] as const });

/** A prop-sized brush to start from (a metre across). */
export const VERTEX_PAINT_DEFAULT_BRUSH: BrushSettings = Object.freeze({ ...DEFAULT_BRUSH, size: 1 }) as BrushSettings;

/**
 * The brush a stroke sends: the shared settings (size across → the
 * command's radius), the palette tile's channels, and erase — the brush's
 * invert (X, or Ctrl held for one stroke), or always for a tile whose
 * strokes take paint off (a layered surface's base). Hardness, opacity and
 * the mask only when they change something.
 */
export function strokeBrush(b: BrushSettings, target: PaintChannelTarget, invert: boolean): VertexPaintBrush {
  return {
    radius: brushRadius(b),
    strength: b.strength,
    channel: target.channel,
    ...(target.channels !== undefined && target.channels.length > 0 ? { channels: [...target.channels] } : {}),
    ...(b.falloff !== 'smooth' ? { falloff: b.falloff } : {}),
    ...(invert || target.erases === true ? { erase: true } : {}),
    ...brushStrokeExtras(b, VERTEX_PAINT_USES),
  };
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

/** The backend's refusal of a stroke over paint made for a model's earlier vertices (it names the mesh as `found`). */
export const STALE_PAINT_CODE: CommandErrorCode = 'vertex_paint_stale';

/** A refused stroke's stale mesh paint, offered for removal (null: refused for another reason). */
export function stalePaintOf(entityId: string, refusal: { code?: string; message?: string; found?: unknown }): { entityId: string; mesh: string; message: string } | null {
  if (refusal.code !== STALE_PAINT_CODE || typeof refusal.found !== 'string') return null;
  return { entityId, mesh: refusal.found, message: refusal.message ?? refusal.code };
}
