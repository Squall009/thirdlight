/**
 * `paintInstances`: one instance-brush stroke on an instance set, one
 * command and one undo.
 *
 * The stroke's copies are made from the set's current copies, the stroke
 * and the scene (`planInstanceStroke`, pure): where the set is in the world,
 * and — when the stroke brings no surface of its own — the scene's block
 * layers to drop onto. The host reads the set's buffer, plans, publishes the
 * new buffer (content-addressed: the old one stays, so undo just points back
 * to it) and hands its digest to the command (`PreparedInstanceStroke`),
 * which stores it as a `setComponent instances` change. So the editor's
 * strokes and MCP's are the same op, and the backend that owns the state
 * decides the copies.
 */

import {
  BlockGrid,
  INSTANCE_FLOATS,
  applyInstanceStroke,
  dropOntoBlockLayers,
  instanceStrokeError,
  type BlockLayerComponent,
  type BrushBlockLayer,
  type InstanceStroke,
  type InstanceStrokeResult,
} from '@thirdlight/project-model';

import { layerDataOf, blockTypesOf } from './block-ops';
import { applySetComponent, type OpInput } from './content-ops';
import { componentMissing, entityNotFound, fieldMissing, fieldValue, noChangeContent, type CommandError } from './errors';
import type { OpOutcome } from './ops';
import type { ContentDocument, SceneDocument } from './types';
import { decompose, invert, worldMatrix, type HierarchyNode } from './world-transform';

/** `paintInstances` args: the instance set and one stroke. */
export interface PaintInstancesArgs extends InstanceStroke {
  entityId: string;
}

/** The host's stroke result: the set's new buffer (published) and its copies. */
export interface PreparedInstanceStroke {
  entityId: string;
  buffer: string;
  count: number;
}

export function validatePaintInstancesArgs(args: Record<string, unknown>): { ok: true; args: PaintInstancesArgs } | { ok: false; error: CommandError } {
  if (args['entityId'] === undefined) return { ok: false, error: fieldMissing('/args/entityId', 'entityId') };
  if (typeof args['entityId'] !== 'string') return { ok: false, error: fieldValue('/args/entityId', args['entityId'], 'an entity id', 'entityId names the instance set') };
  const bad = instanceStrokeError(args);
  if (bad !== null) return { ok: false, error: fieldValue(`/args${bad.path}`, undefined, 'a stroke (see the paintInstances op)', bad.message) };
  return { ok: true, args: args as unknown as PaintInstancesArgs };
}

type SceneEntity = { id: string; parentId?: string; components: Record<string, unknown> };

/**
 * The set's copies after the stroke (`read` gives the bytes of its current
 * buffer). An error is a refusal; `no_change` when the stroke adds or
 * removes nothing.
 */
export function planInstanceStroke(
  scene: SceneDocument,
  content: ContentDocument | undefined,
  args: PaintInstancesArgs,
  read: (digest: string) => { ok: true; bytes: Uint8Array } | { ok: false; error: CommandError },
): { ok: true; floats: Float32Array; added: number; removed: number } | { ok: false; error: CommandError } {
  const entities = scene.entities as unknown as SceneEntity[];
  const byId = new Map(entities.map((e) => [e.id, e]));
  const entity = byId.get(args.entityId);
  if (entity === undefined) return { ok: false, error: entityNotFound(args.entityId) };
  const buffer = (entity.components['instances'] as { buffer?: unknown } | undefined)?.buffer;
  if (typeof buffer !== 'string') return { ok: false, error: componentMissing(args.entityId, 'instances') };
  const bytes = read(buffer);
  if (!bytes.ok) return bytes;
  const floats = instanceFloatsOf(bytes.bytes);
  const toWorld = worldMatrix(byId as unknown as ReadonlyMap<string, HierarchyNode>, args.entityId);
  const toLocal = invert(toWorld);
  if (toLocal === null) return { ok: false, error: fieldValue('/args/entityId', args.entityId, 'a set with a non-zero scale', 'the instance set is scaled to nothing: copies cannot be placed in it') };
  const t = decompose(toWorld);
  const scale = (Math.abs(t.scale[0]) + Math.abs(t.scale[1]) + Math.abs(t.scale[2])) / 3;
  const space = { toWorld, toLocal, rotation: t.rotation as [number, number, number, number], scale };
  // Without a surface of its own the stroke drops onto the scene's block layers (their colliders' shape).
  const drop = args.mode === 'paint' && args.surface === undefined ? dropOntoBlockLayers(blockLayersOf(scene, content)) : undefined;
  const r: InstanceStrokeResult = applyInstanceStroke(floats, args, space, drop);
  if (r.ok) return r;
  if (r.code === 'no_change') return { ok: false, error: { ...noChangeContent(), message: r.message } };
  return { ok: false, error: fieldValue(r.code === 'surface_mismatch' ? '/args/surface' : r.code === 'stroke_too_large' ? '/args/dabs' : '/args/entityId', undefined, 'a stroke the set can take', r.message) };
}

function blockLayersOf(scene: SceneDocument, content: ContentDocument | undefined): BrushBlockLayer[] {
  const types = new Map(content !== undefined ? blockTypesOf(content).map((b) => [b.blockId, b]) : []);
  const out: BrushBlockLayer[] = [];
  for (const e of scene.entities as unknown as SceneEntity[]) {
    const comp = e.components['blockLayer'] as BlockLayerComponent | undefined;
    if (comp === undefined || comp.metadataOnly === true) continue;
    const p = (e.components['transform'] as { position?: number[] } | undefined)?.position ?? [0, 0, 0];
    out.push({ grid: BlockGrid.from(comp, layerDataOf(scene, e.id)), types, origin: p });
  }
  return out;
}

/** Store the host's planned buffer on the set (a `setComponent instances` change: one undo restores the old buffer). */
export function applyPaintInstances(input: OpInput, args: PaintInstancesArgs, prepared: PreparedInstanceStroke | undefined): OpOutcome {
  if (prepared === undefined || prepared.entityId !== args.entityId) {
    return { ok: false, error: fieldValue('/args', undefined, 'a stroke the host prepared', 'paintInstances runs through the project host, which reads and writes the set\'s copies') };
  }
  if (!Number.isInteger(prepared.count) || prepared.count < 1) return { ok: false, error: fieldValue('/args', prepared.count, 'copies', 'the stroke left no copies') };
  return applySetComponent(input, { entityId: args.entityId, component: 'instances', value: { buffer: prepared.buffer, count: prepared.count } });
}

/** The bytes of a buffer as copies (a copy, aligned, of whole copies only). */
export function instanceFloatsOf(bytes: Uint8Array): Float32Array {
  const n = Math.floor(bytes.byteLength / (INSTANCE_FLOATS * 4)) * INSTANCE_FLOATS;
  const out = new Float32Array(n);
  new Uint8Array(out.buffer).set(bytes.subarray(0, n * 4));
  return out;
}
