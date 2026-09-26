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
import {
  applyScriptLibraryPatch,
  scriptLibraryContainerText,
  scriptLibraryDependents,
  scriptLibraryDigest,
  scriptLibrarySetKey,
  validateScriptLibrary,
  type ModelErrorV2,
  type PropertyDeclaration,
  type ScriptLibrary,
  type ScriptLibraryPatch,
} from '@thirdlight/project-model';
import type { BehaviorCompileFailure, BehaviorCompiler, BehaviorCompileSuccess, PreparedBehaviorSource, ScriptLibraryInput } from '@thirdlight/behavior-build';

import { publishBlob, readSourceBlob, resolveStage, writeDerivedPrepared, type BlobPublishResult } from './content-store';
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
  // Phase 23.7: the project's script libraries (an `@lib/<id>` import links the one it names).
  const libraries = scriptLibrariesOfContent(s.content);
  let compiled;
  try {
    compiled = await compiler.compile({
      behaviorId: request.behaviorId,
      declaration: request.declaration,
      containerBytes: bytes,
      pinnedModules: compiler.pinnedModules,
      ...(libraries.length > 0 ? { libraries: libraryInputs(libraries) } : {}),
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
  // Phase 23.7: every library version the output links is acknowledged too (trust per digest).
  for (const pin of prepared.libraries ?? []) {
    if (!s.content.behaviorTrust.entries.some((e) => e.sourceDigest === pin.sourceDigest)) {
      return { ok: false, kind: 'error', error: behaviorTrustUnacknowledged(pin.sourceDigest) };
    }
  }
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
  // Phase 23.7: also filed under the library set it was compiled against.
  if (prepared.libraries !== undefined) s.preparedSources.set(`${sourceDigest}|${scriptLibrarySetKey(libraries)}`, prepared);
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
    ...(m.libraries !== undefined && m.libraries.length > 0 ? { libraries: m.libraries.map((p) => ({ ...p })) } : {}),
    declarationDigest: compiled.declarationDigest,
    recipeDigest: compiled.recipeDigest,
    compiler: { ...m.compiler },
  };
}

/** Phase 23.7: the script libraries of a content block (absent = none). */
export function scriptLibrariesOfContent(content: unknown): ScriptLibrary[] {
  return ((content as { scriptLibraries?: ScriptLibrary[] } | null)?.scriptLibraries ?? []) as ScriptLibrary[];
}

/** Phase 23.7: the compiler inputs of a library set (each library's canonical container bytes). */
export function libraryInputs(libraries: readonly ScriptLibrary[]): ScriptLibraryInput[] {
  return libraries.map((l) => ({ libraryId: l.libraryId, containerBytes: new TextEncoder().encode(scriptLibraryContainerText(l)) }));
}

export interface PrepareLibraryDependentsOk {
  ok: true;
  /** The library's digest after the patch (null when the patch is not a valid library: the command reports it). */
  libraryDigest: string | null;
  /** The dependents compiled against the patched library set (their facts are filed for the command). */
  dependents: { behaviorId: string; outputDigest: string }[];
}

export type PrepareLibraryDependentsResult =
  | PrepareLibraryDependentsOk
  | { ok: false; kind: 'error'; error: CommandError }
  | { ok: false; kind: 'compile'; behaviorId: string; failure: BehaviorCompileFailure };

/**
 * Phase 23.7: before a `setScriptLibrary` command, compile every published
 * behavior that imports the library against the library set the command
 * will commit, and file the digest-bound prepared facts under
 * `<sourceDigest>|<librarySetKey>` — the only facts the command builds the
 * dependents' new records from. The patched library's digest must be
 * acknowledged first when it has dependents (trust precedes the compile, as
 * for a behavior source). No authoritative state changes here.
 */
export async function prepareScriptLibraryDependents(
  core: Core,
  projectId: string,
  patch: ScriptLibraryPatch,
): Promise<PrepareLibraryDependentsResult> {
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) {
    return { ok: false, kind: 'error', error: projectNotFound(String(projectId)) };
  }
  const o = ensureSession(core, projectId);
  if (o.kind === 'not-found') return { ok: false, kind: 'error', error: projectNotFound(projectId) };
  if (o.kind === 'unavailable') return { ok: false, kind: 'error', error: projectUnavailable(o.reason, o.holder, o.errors ?? []) };
  if (o.kind === 'released') return { ok: false, kind: 'error', error: workspaceClosed() };
  const s = o.session;
  if (s.mode !== 'open' || s.scene === null || s.content === null) {
    return { ok: false, kind: 'error', error: projectUnavailable(s.blocked?.reason ?? 'envelope_invalid', null, s.blocked?.errors ?? []) };
  }
  const current = scriptLibrariesOfContent(s.content);
  const previous = current.find((l) => l.libraryId === patch.libraryId) ?? null;
  const patched = applyScriptLibraryPatch(previous, patch);
  if (!patched.ok) return { ok: true, libraryDigest: null, dependents: [] };
  const errors: ModelErrorV2[] = [];
  validateScriptLibrary(patched.library, '', errors);
  if (errors.length > 0) return { ok: true, libraryDigest: null, dependents: [] };
  const libraryDigest = scriptLibraryDigest(patched.library);
  const dependents = scriptLibraryDependents(s.content.behaviors, patch.libraryId);
  if (dependents.length === 0 || (previous !== null && scriptLibraryDigest(previous) === libraryDigest)) return { ok: true, libraryDigest, dependents: [] };
  if (!s.content.behaviorTrust.entries.some((e) => e.sourceDigest === libraryDigest)) {
    return { ok: false, kind: 'error', error: behaviorTrustUnacknowledged(libraryDigest) };
  }
  const compiler: BehaviorCompiler | undefined = core.content.behaviorCompiler;
  if (compiler === undefined) return { ok: false, kind: 'error', error: behaviorPublicationUnavailable(dependents[0] as string, 'source', 'preparer_unavailable') };
  const next = [...current.filter((l) => l.libraryId !== patch.libraryId), patched.library];
  const setKey = scriptLibrarySetKey(next);
  const inputs = libraryInputs(next);
  const out: { behaviorId: string; outputDigest: string }[] = [];
  for (const behaviorId of dependents) {
    const record = s.content.behaviors.find((b) => b.behaviorId === behaviorId);
    const source = record?.source;
    if (record === undefined || source === null || source === undefined) continue;
    const read = readSourceBlob(core, s as never, { digest: source.sourceDigest });
    if (!read.ok) return { ok: false, kind: 'error', error: read.error };
    let compiled;
    try {
      compiled = await compiler.compile({ behaviorId, declaration: record.declaration, containerBytes: read.bytes, pinnedModules: compiler.pinnedModules, libraries: inputs });
    } catch (e) {
      return { ok: false, kind: 'compile', behaviorId, failure: { ok: false, code: 'behavior_compile_failed', reason: 'the injected compiler threw', diagnostics: [{ code: 'behavior_compile_failed', reason: 'throw', message: (e instanceof Error ? e.message : String(e)).slice(0, 256) }] } };
    }
    if (!compiled.ok) return { ok: false, kind: 'compile', behaviorId, failure: compiled };
    const prepared = preparedSourceFromCompile(compiled);
    for (const pin of prepared.libraries ?? []) {
      if (pin.libraryId !== patch.libraryId && !s.content.behaviorTrust.entries.some((e) => e.sourceDigest === pin.sourceDigest)) {
        return { ok: false, kind: 'error', error: behaviorTrustUnacknowledged(pin.sourceDigest) };
      }
    }
    s.preparedSources.set(`${source.sourceDigest}|${setKey}`, prepared);
    out.push({ behaviorId, outputDigest: prepared.outputDigest });
  }
  return { ok: true, libraryDigest, dependents: out };
}

/** The prepared facts as the command layer consumes them (structurally identical). */
export function preparedFactsOf(
  prepared: ReadonlyMap<string, PreparedBehaviorSource>,
): ReadonlyMap<string, PreparedBehaviorSourceFact> {
  return prepared as unknown as ReadonlyMap<string, PreparedBehaviorSourceFact>;
}

/** Phase 23.7: the compiler inputs of a project's script libraries as stored now (empty for a v3 project). */
export function projectScriptLibraryInputs(core: Core, projectId: string): ScriptLibraryInput[] {
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) return [];
  const o = ensureSession(core, projectId);
  if (o.kind !== 'open' || o.session.content === null) return [];
  return libraryInputs(scriptLibrariesOfContent(o.session.content));
}

export type ScriptLibraryDraftCheckResult =
  | { ok: true; compiled: true; libraryId: string; sourceDigest: string; imports: string[]; outputByteLength: number; dependents: string[]; diagnostics: [] }
  | { ok: true; compiled: false; libraryId: string; code: string; reason: string; dependents: string[]; diagnostics: readonly import('@thirdlight/behavior-build').CompileDiagnostic[] }
  | { ok: false; error: CommandError };

/**
 * Phase 23.7: compile one script library draft on its own (the script
 * editor's check): its files replace the stored library of that id (or add
 * one) among the project's libraries. Nothing is written, no code runs.
 * Also names the published scripts that import it (recompiled on save).
 */
export async function checkScriptLibraryDraft(core: Core, projectId: string, draft: { libraryId: string; files: { path: string; text: string }[] }): Promise<ScriptLibraryDraftCheckResult> {
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) return { ok: false, error: projectNotFound(String(projectId)) };
  const o = ensureSession(core, projectId);
  if (o.kind === 'not-found') return { ok: false, error: projectNotFound(projectId) };
  if (o.kind === 'unavailable') return { ok: false, error: projectUnavailable(o.reason, o.holder, o.errors ?? []) };
  if (o.kind === 'released') return { ok: false, error: workspaceClosed() };
  const s = o.session;
  if (s.mode !== 'open' || s.content === null) return { ok: false, error: projectUnavailable(s.blocked?.reason ?? 'envelope_invalid', null, s.blocked?.errors ?? []) };
  const stored = scriptLibrariesOfContent(s.content);
  const dependents = scriptLibraryDependents(s.content.behaviors, draft.libraryId);
  const library: ScriptLibrary = { libraryId: draft.libraryId, name: stored.find((l) => l.libraryId === draft.libraryId)?.name ?? draft.libraryId, files: draft.files.map((f) => ({ path: f.path, text: f.text })) };
  const errors: ModelErrorV2[] = [];
  validateScriptLibrary(library, '', errors);
  if (errors.length > 0) {
    return { ok: true, compiled: false, libraryId: draft.libraryId, code: errors[0]!.code, reason: 'library', dependents, diagnostics: errors.slice(0, 32).map((e) => ({ code: e.code, reason: 'library', library: draft.libraryId, message: e.message.slice(0, 256) })) };
  }
  const compiler: BehaviorCompiler | undefined = core.content.behaviorCompiler;
  if (compiler === undefined || compiler.checkLibrary === undefined) return { ok: false, error: behaviorPublicationUnavailable(draft.libraryId, 'source', 'preparer_unavailable') };
  const set = [...stored.filter((l) => l.libraryId !== draft.libraryId), library];
  let r;
  try {
    r = await compiler.checkLibrary({ libraryId: draft.libraryId, libraries: libraryInputs(set) });
  } catch (e) {
    r = { ok: false as const, code: 'behavior_compile_failed', reason: 'the compiler threw', diagnostics: [{ code: 'behavior_compile_failed', reason: 'throw', message: (e instanceof Error ? e.message : String(e)).slice(0, 256) }] };
  }
  if (r.ok) return { ok: true, compiled: true, libraryId: draft.libraryId, sourceDigest: r.sourceDigest, imports: r.imports, outputByteLength: r.outputByteLength, dependents, diagnostics: [] };
  return { ok: true, compiled: false, libraryId: draft.libraryId, code: r.code, reason: String(r.reason).slice(0, 256), dependents, diagnostics: r.diagnostics.slice(0, 32) };
}
