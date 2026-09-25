/**
 * Behavior-source preparation — project-model.md §22.4.1, workspace.md
 * §13.3.1 "Behavior-source preparation profile".
 *
 * The workspace's preparation layer for the `behavior-source` staging profile:
 * it resolves the stage (or accepts supplied bytes), hashes **the bytes on
 * disk**, applies the trust gate, runs the INJECTED compiler
 * (`behavior-build` is a types-only edge — no hidden global service), publishes
 * the canonical container bytes as an immutable blob and stores the
 * digest-bound prepared record as a **derived cache** entry. No authoritative
 * state changes here: no revision, no envelope write, no mutation lock.
 *
 * The prepared record is the only source the `publishBehavior{mode:"source"}`
 * command may build a `BehaviorSourceRecord` from (project-model.md §22.2
 * rule 2); this module never accepts a caller-supplied record field.
 */

import type { CommandError, PreparedBehaviorSourceFact } from '@thirdlight/commands';
import type { PropertyDeclaration } from '@thirdlight/project-model';
import type { BehaviorCompileFailure, BehaviorCompiler, BehaviorCompileSuccess, PreparedBehaviorSource } from '@thirdlight/behavior-build';

import { publishBlob, resolveStage, writeDerivedPrepared, type BlobPublishResult } from './content-store';
import { sha256Hex } from './digest';
import {
  behaviorPublicationUnavailable,
  behaviorTrustUnacknowledged,
  fieldValueType,
  pathRejected,
  projectNotFound,
  projectUnavailable,
  workspaceClosed,
} from './errors';
import { ensureSession, type Core } from './session';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface PrepareBehaviorSourceRequest {
  /** The staged canonical container to prepare (workspace.md §13.3.1). */
  stageId?: string;
  /** Directly supplied canonical container bytes (harness/CLI path). */
  bytes?: Uint8Array;
  /** The behavior the publication will bind. */
  behaviorId: string;
  /** The declaration the publication will assert (must equal the compiled one). */
  declaration: PropertyDeclaration;
}

export interface PrepareBehaviorSourceOk {
  ok: true;
  /** The digest-bound fact set the publication consumes (derived cache). */
  prepared: PreparedBehaviorSource;
  sourceBlob: { digest: string; byteLength: number; published: boolean; alreadyPresent: boolean };
  derivedPath: string;
}

export type PrepareBehaviorSourceResult =
  | PrepareBehaviorSourceOk
  | { ok: false; kind: 'error'; error: CommandError }
  | { ok: false; kind: 'compile'; failure: BehaviorCompileFailure };

/**
 * `prepareBehaviorSource(projectId, request)` (workspace.md §13.3.1,
 * project-model.md §22.4.1): read the bytes, apply the trust gate, run the
 * injected compiler, publish the immutable container blob and store the
 * digest-bound prepared record. On any failure nothing authoritative is
 * written; a compile failure produces no bytes and no artifact.
 */
export async function prepareBehaviorSource(
  core: Core,
  projectId: string,
  request: PrepareBehaviorSourceRequest,
): Promise<PrepareBehaviorSourceResult> {
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) {
    return { ok: false, kind: 'error', error: projectNotFound(String(projectId)) };
  }
  const o = ensureSession(core, projectId);
  if (o.kind === 'not-found') return { ok: false, kind: 'error', error: projectNotFound(projectId) };
  if (o.kind === 'unavailable') {
    return { ok: false, kind: 'error', error: projectUnavailable(o.reason, o.holder, o.errors ?? []) };
  }
  if (o.kind === 'released') return { ok: false, kind: 'error', error: workspaceClosed() };
  const s = o.session;
  if (s.mode !== 'open' || s.scene === null || s.content === null) {
    return {
      ok: false,
      kind: 'error',
      error: projectUnavailable(s.blocked?.reason ?? 'envelope_invalid', null, s.blocked?.errors ?? []),
    };
  }
  if (!ID_RE.test(request.behaviorId)) {
    return {
      ok: false,
      kind: 'error',
      error: fieldValueType(
        '/request/behaviorId',
        request.behaviorId,
        'behavior ID',
        'behaviorId must use the project-model ID syntax',
      ),
    };
  }
  // Bytes: a stage (resolved with the accepted refusal/cap/traversal checks)
  // or supplied bytes. Either way the digest is recomputed from the bytes.
  let bytes: Uint8Array;
  if (request.stageId !== undefined) {
    const r = resolveStage(core, s, request.stageId);
    if (!r.ok) return { ok: false, kind: 'error', error: r.error };
    bytes = r.stage.bytes;
  } else if (request.bytes instanceof Uint8Array) {
    bytes = request.bytes;
  } else {
    return {
      ok: false,
      kind: 'error',
      error: pathRejected('', 'prepareBehaviorSource requires a stageId or bytes'),
    };
  }
  const sourceDigest = sha256Hex(bytes);
  // §22.4.1 step 6: the trust acknowledgment must precede the first compile.
  if (!s.content.behaviorTrust.entries.some((e) => e.sourceDigest === sourceDigest)) {
    return { ok: false, kind: 'error', error: behaviorTrustUnacknowledged(sourceDigest) };
  }
  const compiler: BehaviorCompiler | undefined = core.content.behaviorCompiler;
  if (compiler === undefined) {
    return {
      ok: false,
      kind: 'error',
      error: behaviorPublicationUnavailable(request.behaviorId, 'source', 'preparer_unavailable'),
    };
  }
  let compiled;
  try {
    compiled = await compiler.compile({
      behaviorId: request.behaviorId,
      declaration: request.declaration,
      containerBytes: bytes,
      pinnedModules: compiler.pinnedModules,
    });
  } catch (e) {
    // A throwing injected compiler is a compiler failure, never a state change.
    return {
      ok: false,
      kind: 'compile',
      failure: {
        ok: false,
        code: 'behavior_compile_failed',
        reason: 'the injected compiler threw',
        diagnostics: [
          {
            code: 'behavior_compile_failed',
            reason: 'throw',
            message: (e instanceof Error ? e.message : String(e)).slice(0, 256),
          },
        ],
      },
    };
  }
  if (!compiled.ok) return { ok: false, kind: 'compile', failure: compiled };
  const prepared = preparedSourceFromCompile(compiled);
  // Immutable container blob (write-once, verified) — no authoritative change.
  const blob: BlobPublishResult = publishBlob(core, s, {
    digest: sourceDigest,
    byteLength: bytes.length,
    source: { kind: 'bytes', bytes },
  });
  if (!blob.ok) return { ok: false, kind: 'error', error: blob.error };
  const w = writeDerivedPrepared(core, s, sourceDigest, prepared.recipeDigest, prepared);
  if (!w.ok) return { ok: false, kind: 'error', error: w.error };
  s.preparedSources.set(sourceDigest, prepared);
  return {
    ok: true,
    prepared,
    sourceBlob: {
      digest: blob.digest,
      byteLength: blob.byteLength,
      published: blob.published,
      alreadyPresent: blob.alreadyPresent,
    },
    derivedPath: w.path,
  };
}

/**
 * Map a successful compile into the workspace's prepared fact set. Deliberately
 * mirrors `behavior-build`'s `preparedSourceFrom` (that unit is a types-only
 * edge here, so its value helper cannot be called); the two are kept in sync by
 * the packet-33 integration test, which compares every field of both.
 */
function preparedSourceFromCompile(compiled: BehaviorCompileSuccess): PreparedBehaviorSource {
  const m = compiled.manifest;
  return {
    behaviorId: m.behaviorId,
    sourceDigest: m.sourceDigest,
    sourceByteLength: m.sourceByteLength,
    entryPath: 'src/index.ts',
    fileCount: m.files.length,
    manifestDigest: compiled.manifestDigest,
    outputDigest: m.outputDigest,
    outputByteLength: m.outputByteLength,
    requiredModules: [...m.requiredModules],
    ownedTransforms: [...m.ownedTransforms],
    declaration: { properties: m.declaration.properties.map((p) => ({ ...p })) },
    ...(m.declaredInCode === true ? { declaredInCode: true as const } : {}),
    ...(m.sourceKind === 'graph' ? { sourceKind: 'graph' as const } : {}),
    declarationDigest: compiled.declarationDigest,
    recipeDigest: compiled.recipeDigest,
    compiler: { ...m.compiler },
  };
}

/** The prepared facts as the command layer consumes them (structurally identical). */
export function preparedFactsOf(
  prepared: ReadonlyMap<string, PreparedBehaviorSource>,
): ReadonlyMap<string, PreparedBehaviorSourceFact> {
  return prepared as unknown as ReadonlyMap<string, PreparedBehaviorSourceFact>;
}
