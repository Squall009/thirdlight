/**
 * The host's part of an instance-brush stroke (`paintInstances`): read the
 * set's buffer, plan the stroke against the scene (the command package's
 * pure planner) and hand the new buffer's digest to the command, which
 * stores it in one undoable change; the buffer is published only once the
 * command passed its checks, since nothing collects an unused blob. The planner runs in the backend
 * that owns the project, so the editor and MCP get the same copies from the
 * same stroke.
 */

import { INSTANCE_FLOATS } from '@thirdlight/project-model';
import { planInstanceStroke, validatePaintInstancesArgs, type CommandError, type ContentDocument, type PreparedInstanceStroke, type SceneDocument } from '@thirdlight/commands';

import { publishBlob, readSourceBlob } from './content-store';
import { sha256Hex } from './digest';
import { contentCtx } from './service-content';
import type { Core, ProjectSession } from './session';

/** A stroke's new buffer, held until the command is accepted (a refused stroke leaves no blob behind). */
export interface StrokeBuffer {
  readonly digest: string;
  readonly bytes: Uint8Array;
}

export function prepareInstanceStroke(core: Core, s: ProjectSession, scene: SceneDocument, content: ContentDocument | undefined, args: Record<string, unknown>): { ok: true; prepared: PreparedInstanceStroke; buffer: StrokeBuffer } | { ok: false; error: CommandError } {
  const v = validatePaintInstancesArgs(args);
  if (!v.ok) return v;
  const plan = planInstanceStroke(scene, content, v.args, (digest) => readSourceBlob(core, contentCtx(s), { digest }));
  if (!plan.ok) return plan;
  const bytes = new Uint8Array(plan.floats.buffer, plan.floats.byteOffset, plan.floats.byteLength);
  const digest = sha256Hex(bytes);
  return { ok: true, prepared: { entityId: v.args.entityId, buffer: digest, count: plan.floats.length / INSTANCE_FLOATS }, buffer: { digest, bytes } };
}

/** Publish an accepted stroke's buffer (just before its change is written). */
export function publishStrokeBuffer(core: Core, s: ProjectSession, buffer: StrokeBuffer): CommandError | null {
  const put = publishBlob(core, contentCtx(s), { digest: buffer.digest, byteLength: buffer.bytes.byteLength, source: { kind: 'bytes', bytes: buffer.bytes } });
  return put.ok ? null : put.error;
}
