/**
 * Packet 33 — the backend behavior-source publication facade
 * (project-model.md §22.6/§22.4.1, sessions.md §19/§10.5).
 *
 * This is the ONE publication facade for behavior source: it runs the
 * preparation layer (stage read + trust gate + injected compile + immutable
 * blob + derived prepared record) and then issues the ordinary
 * `publishBehavior{mode:"source"}` command through `workspace.runCommand` —
 * the sole command executor. There is no second commit path, no wire route of
 * its own and no code evaluation: the facade never imports, requires or runs
 * project source.
 *
 * A compile failure returns the bounded compile diagnostics and writes
 * nothing authoritative; a command failure leaves the previous publication
 * and revision untouched (`behavior_publication_unavailable` /
 * `behavior_declaration_mismatch` / `behavior_trust_unacknowledged`).
 *
 * The wire surface (an authoring route / MCP tool / UI panel) is not part of
 * packet 33 (sessions.md §19.1 lists no behavior-build route); packets 34/35
 * own the editor/MCP wiring. The facade is exposed on the `/services` surface
 * and exercised by `tests/integration/m2-builds/**`.
 */

import type { PropertyDeclaration } from '@thirdlight/project-model';
import type { BehaviorCompileFailure, PreparedBehaviorSource } from '@thirdlight/behavior-build';
import type { CommandError, MutationSuccess, WorkspaceService } from '@thirdlight/workspace';

export interface PublishBehaviorSourceRequest {
  projectId: string;
  /** The staged canonical container (workspace.md §13.3.1). */
  stageId?: string;
  /** Directly supplied canonical container bytes (harness/CLI path). */
  bytes?: Uint8Array;
  behaviorId: string;
  displayName: string;
  declaration: PropertyDeclaration;
  expectedRevision: number;
  requestId: string;
  origin: { kind: 'browser' | 'mcp' | 'admin'; clientId: string };
}

export type PublishBehaviorSourceOutcome =
  | { ok: true; prepared: PreparedBehaviorSource; result: MutationSuccess }
  | { ok: false; kind: 'compile'; failure: BehaviorCompileFailure }
  | { ok: false; kind: 'error'; error: CommandError };

/**
 * Prepare then publish (prepare → `runCommand`). `prepareBehaviorSource`
 * changes no authoritative state; only the command advances the revision.
 */
export async function publishBehaviorSource(
  service: WorkspaceService,
  request: PublishBehaviorSourceRequest,
): Promise<PublishBehaviorSourceOutcome> {
  const prepareRequest =
    request.stageId !== undefined
      ? { stageId: request.stageId, behaviorId: request.behaviorId, declaration: request.declaration }
      : { bytes: request.bytes, behaviorId: request.behaviorId, declaration: request.declaration };
  const prepared = await service.prepareBehaviorSource(request.projectId, prepareRequest);
  if (!prepared.ok) {
    return prepared.kind === 'compile'
      ? { ok: false, kind: 'compile', failure: prepared.failure }
      : { ok: false, kind: 'error', error: prepared.error };
  }
  const command = service.runCommand({
    op: 'publishBehavior',
    projectId: request.projectId,
    expectedRevision: request.expectedRevision,
    requestId: request.requestId,
    origin: request.origin,
    args: {
      behaviorId: request.behaviorId,
      displayName: request.displayName,
      mode: 'source',
      declaration: request.declaration,
      source: {
        sourceDigest: prepared.prepared.sourceDigest,
        sourceByteLength: prepared.prepared.sourceByteLength,
      },
    },
  });
  if (!command.ok) return { ok: false, kind: 'error', error: command.error };
  return { ok: true, prepared: prepared.prepared, result: command };
}

/** Acknowledge one prepared digest through the ordinary command path. */
export function acknowledgePreparedDigest(
  service: WorkspaceService,
  request: {
    projectId: string;
    sourceDigest: string;
    expectedRevision: number;
    requestId: string;
    origin: { kind: 'browser' | 'mcp' | 'admin'; clientId: string };
  },
): { ok: true; result: MutationSuccess } | { ok: false; error: CommandError } {
  const command = service.runCommand({
    op: 'acknowledgeBehaviorTrust',
    projectId: request.projectId,
    expectedRevision: request.expectedRevision,
    requestId: request.requestId,
    origin: request.origin,
    args: { sourceDigest: request.sourceDigest },
  });
  if (!command.ok) return { ok: false, error: command.error };
  return { ok: true, result: command };
}
