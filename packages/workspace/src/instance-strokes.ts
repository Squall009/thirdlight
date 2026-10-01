/**
 * The host's part of an instance-brush stroke (`paintInstances`): read the
 * set's buffer, plan the stroke against the scene (the command package's
 * pure planner), publish the new buffer and hand its digest to the command,
 * which stores it in one undoable change. The planner runs in the backend
 * that owns the project, so the editor and MCP get the same copies from the
 * same stroke.
 */

import { INSTANCE_FLOATS } from '@thirdlight/project-model';
import { planInstanceStroke, validatePaintInstancesArgs, type CommandError, type ContentDocument, type PreparedInstanceStroke, type SceneDocument } from '@thirdlight/commands';

import { publishBlob, readSourceBlob } from './content-store';
import { sha256Hex } from './digest';
import { contentCtx } from './service-content';
import type { Core, ProjectSession } from './session';

export function prepareInstanceStroke(core: Core, s: ProjectSession, scene: SceneDocument, content: ContentDocument | undefined, args: Record<string, unknown>): { ok: true; prepared: PreparedInstanceStroke } | { ok: false; error: CommandError } {
  const v = validatePaintInstancesArgs(args);
  if (!v.ok) return v;
  const plan = planInstanceStroke(scene, content, v.args, (digest) => readSourceBlob(core, contentCtx(s), { digest }));
  if (!plan.ok) return plan;
  const bytes = new Uint8Array(plan.floats.buffer, plan.floats.byteOffset, plan.floats.byteLength);
  const digest = sha256Hex(bytes);
  const put = publishBlob(core, contentCtx(s), { digest, byteLength: bytes.byteLength, source: { kind: 'bytes', bytes } });
  if (!put.ok) return { ok: false, error: put.error };
  return { ok: true, prepared: { entityId: v.args.entityId, buffer: digest, count: plan.floats.length / INSTANCE_FLOATS } };
}
