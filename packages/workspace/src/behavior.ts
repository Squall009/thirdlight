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
import { ID_RE } from '@thirdlight/project-model';

import type { CommandError, PreparedBehaviorSourceFact } from '@thirdlight/commands';
import {
  BEHAVIOR_ENTRY_PATH,
  MAX_BEHAVIOR_DIAGNOSTICS,
  SCRIPT_LIBRARY_LIMITS,
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
import { ensureSession, type Core, type LibraryStage } from './session';

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
    entryPath: BEHAVIOR_ENTRY_PATH,
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
    return { ok: true, compiled: false, libraryId: draft.libraryId, code: errors[0]!.code, reason: 'library', dependents, diagnostics: errors.slice(0, MAX_BEHAVIOR_DIAGNOSTICS).map((e) => ({ code: e.code, reason: 'library', library: draft.libraryId, message: e.message.slice(0, 256) })) };
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
  return { ok: true, compiled: false, libraryId: draft.libraryId, code: r.code, reason: String(r.reason).slice(0, 256), dependents, diagnostics: r.diagnostics.slice(0, MAX_BEHAVIOR_DIAGNOSTICS) };
}

// ---------------------------------------------------------------------------
// Phase 25.9: staged library edits (several patches, one commit)
// ---------------------------------------------------------------------------

/** At most this many open stages per project (the oldest goes first). */
export const LIBRARY_STAGES_PER_PROJECT = 8;
/** A stage holds at most this much staged library text (twice the project's 1 MiB library budget). */
export const LIBRARY_STAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Phase 25.9: a stage patch — `setScriptLibrary`'s patch, and a file may be
 * sent in pieces: `append: true` adds the text to the file as staged so far
 * (a file larger than one request).
 */
export interface StagedLibraryPatch {
  libraryId: string;
  name?: string;
  files?: { path: string; text: string | null; append?: boolean }[];
}

export interface LibraryStageSummary {
  stageId: string;
  patches: number;
  libraries: { libraryId: string; name: string; sourceDigest: string; files: number; bytes: number; isNew: boolean; changed: boolean }[];
}

export type LibraryStageResult = { ok: true; stage: LibraryStageSummary } | { ok: false; error: CommandError };

type OpenSession = Extract<ReturnType<typeof ensureSession>, { kind: 'open' }>['session'];

function openSession(core: Core, projectId: string): { ok: true; s: OpenSession } | { ok: false; error: CommandError } {
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) return { ok: false, error: projectNotFound(String(projectId)) };
  const o = ensureSession(core, projectId);
  if (o.kind === 'not-found') return { ok: false, error: projectNotFound(projectId) };
  if (o.kind === 'unavailable') return { ok: false, error: projectUnavailable(o.reason, o.holder, o.errors ?? []) };
  if (o.kind === 'released') return { ok: false, error: workspaceClosed() };
  const s = o.session;
  if (s.mode !== 'open' || s.scene === null || s.content === null) return { ok: false, error: projectUnavailable(s.blocked?.reason ?? 'envelope_invalid', null, s.blocked?.errors ?? []) };
  return { ok: true, s };
}

const textBytes = (l: ScriptLibrary): number => l.files.reduce((n, f) => n + new TextEncoder().encode(f.text).length, 0);

function stageSummary(stage: { stageId: string; patches: number; libraries: Map<string, { base: string | null; library: ScriptLibrary }> }): LibraryStageSummary {
  return {
    stageId: stage.stageId,
    patches: stage.patches,
    libraries: [...stage.libraries.values()]
      .map(({ base, library }) => {
        const sourceDigest = scriptLibraryDigest(library);
        return { libraryId: library.libraryId, name: library.name, sourceDigest, files: library.files.length, bytes: textBytes(library), isNew: base === null, changed: base !== sourceDigest };
      })
      .sort((a, b) => (a.libraryId < b.libraryId ? -1 : 1)),
  };
}

/**
 * Phase 25.9: add one patch (`setScriptLibrary`'s shape: files added or
 * replaced, `text: null` removes one, `name`) to a stage, opening one when no
 * stageId is given. The patch applies to the stage's value of that library
 * (the stored library when the stage first touches it). Nothing
 * authoritative changes; the stage is committed by `commitScriptLibraryStage`
 * (one revision, one undo) or dropped with `discardScriptLibraryStage`.
 */
export function stageScriptLibraryPatch(core: Core, projectId: string, request: { stageId?: string; patch: StagedLibraryPatch }): LibraryStageResult {
  const opened = openSession(core, projectId);
  if (!opened.ok) return opened;
  const s = opened.s;
  const stages: Map<string, LibraryStage> = (s.libraryStages ??= new Map<string, LibraryStage>());
  let stage = request.stageId !== undefined ? stages.get(request.stageId) : undefined;
  if (request.stageId !== undefined && stage === undefined) {
    return { ok: false, error: { ...fieldValueType('/stageId', request.stageId, 'an open library stage of this project', 'no open library stage with this id (it was committed, discarded, or the backend restarted)'), code: 'reference_missing' } };
  }
  const current = scriptLibrariesOfContent(s.content);
  const held = stage?.libraries.get(request.patch.libraryId);
  const stored = current.find((l) => l.libraryId === request.patch.libraryId) ?? null;
  // A file sent in pieces: `append: true` adds its text to the file the stage already holds.
  const startingFrom = held?.library ?? stored;
  const pieces: { path: string; text: string | null }[] = [];
  for (const f of request.patch.files ?? []) {
    if (f.append !== true) {
      pieces.push({ path: f.path, text: f.text });
      continue;
    }
    const prior = pieces.find((x) => x.path === f.path)?.text ?? startingFrom?.files.find((x) => x.path === f.path)?.text;
    if (typeof prior !== 'string' || typeof f.text !== 'string') {
      return { ok: false, error: fieldValueType('/patch/files', f.path, 'an append to a file the stage holds', `nothing to append to: the stage holds no file ${f.path} (send its first piece without append)`) };
    }
    const at = pieces.findIndex((x) => x.path === f.path);
    if (at >= 0) pieces[at] = { path: f.path, text: prior + f.text };
    else pieces.push({ path: f.path, text: prior + f.text });
  }
  const plain: ScriptLibraryPatch = { libraryId: request.patch.libraryId, ...(request.patch.name !== undefined ? { name: request.patch.name } : {}), ...(request.patch.files !== undefined ? { files: pieces } : {}) };
  const patched = applyScriptLibraryPatch(startingFrom, plain);
  if (!patched.ok) return { ok: false, error: fieldValueType(`/patch${patched.path}`, request.patch.libraryId, 'a valid script library patch', patched.message) };
  if (stage === undefined) {
    if (stages.size >= LIBRARY_STAGES_PER_PROJECT) stages.delete(stages.keys().next().value as string);
    s.libraryStageSeq = (s.libraryStageSeq ?? 0) + 1;
    stage = { stageId: `lstage-${s.libraryStageSeq}`, libraries: new Map(), patches: 0 };
    stages.set(stage.stageId, stage);
  }
  const libraries = new Map<string, { base: string | null; library: ScriptLibrary }>(stage.libraries);
  libraries.set(request.patch.libraryId, { base: held?.base ?? (stored === null ? null : scriptLibraryDigest(stored)), library: patched.library });
  if (libraries.size > SCRIPT_LIBRARY_LIMITS.libraries) return { ok: false, error: fieldValueType('/patch/libraryId', request.patch.libraryId, `at most ${SCRIPT_LIBRARY_LIMITS.libraries} libraries in a stage`, `a stage holds at most ${SCRIPT_LIBRARY_LIMITS.libraries} libraries (a project has at most ${SCRIPT_LIBRARY_LIMITS.libraries})`) };
  const bytes = [...libraries.values()].reduce((n, e) => n + textBytes(e.library), 0);
  if (bytes > LIBRARY_STAGE_MAX_BYTES) return { ok: false, error: fieldValueType('/patch/files', bytes, `at most ${LIBRARY_STAGE_MAX_BYTES} bytes of staged library text`, 'the stage would hold more library text than a project may') };
  stage.libraries.clear();
  for (const [k, v] of libraries) stage.libraries.set(k, v);
  stage.patches += 1;
  return { ok: true, stage: stageSummary(stage) };
}

/** Phase 25.9: drop a stage (nothing else changes). */
export function discardScriptLibraryStage(core: Core, projectId: string, stageId: string): { ok: true } | { ok: false; error: CommandError } {
  const opened = openSession(core, projectId);
  if (!opened.ok) return opened;
  if (opened.s.libraryStages?.delete(stageId) !== true) {
    return { ok: false, error: { ...fieldValueType('/stageId', stageId, 'an open library stage of this project', 'no open library stage with this id'), code: 'reference_missing' } };
  }
  return { ok: true };
}

/** Phase 25.9: the stages as the command layer reads them (whole staged values and their bases). */
export function libraryStageFacts(s: { libraryStages?: Map<string, { libraries: Map<string, { base: string | null; library: ScriptLibrary }> }> }): ReadonlyMap<string, import('@thirdlight/commands').ScriptLibraryStageFact> | undefined {
  if (s.libraryStages === undefined || s.libraryStages.size === 0) return undefined;
  const out = new Map<string, import('@thirdlight/commands').ScriptLibraryStageFact>();
  for (const [id, stage] of s.libraryStages) {
    out.set(id, { libraries: [...stage.libraries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([libraryId, e]) => ({ libraryId, base: e.base, library: e.library })) });
  }
  return out;
}

export type PrepareLibraryStageResult =
  | { ok: true; stage: LibraryStageSummary; dependents: { behaviorId: string; outputDigest: string }[]; compiled: number }
  | { ok: false; kind: 'error'; error: CommandError }
  | { ok: false; kind: 'compile'; behaviorId: string; failure: BehaviorCompileFailure };

/**
 * Phase 25.9: before `commitScriptLibraryStage`, compile each published
 * script that imports any changed library of the stage — once, against the
 * whole committed set — and file the facts the command reads (as
 * `prepareScriptLibraryDependents` does for one patch). The changed
 * libraries' digests a dependent will link must be acknowledged first.
 */
export async function prepareScriptLibraryStage(core: Core, projectId: string, stageId: string): Promise<PrepareLibraryStageResult> {
  const opened = openSession(core, projectId);
  if (!opened.ok) return { ok: false, kind: 'error', error: opened.error };
  const s = opened.s;
  const stage = s.libraryStages?.get(stageId);
  if (stage === undefined) return { ok: false, kind: 'error', error: { ...fieldValueType('/args/stageId', stageId, 'an open library stage of this project', 'no open library stage with this id'), code: 'reference_missing' } };
  const content = s.content!;
  const current = scriptLibrariesOfContent(content);
  const staged = [...stage.libraries.values()].map((e) => e.library);
  const next = [...current.filter((l) => !stage.libraries.has(l.libraryId)), ...staged];
  // Invalid staged values and stale bases are the command's refusals; nothing to compile for them.
  for (const l of staged) {
    const errors: ModelErrorV2[] = [];
    validateScriptLibrary(l, '', errors);
    if (errors.length > 0) return { ok: true, stage: stageSummary(stage), dependents: [], compiled: 0 };
  }
  const changed = staged.filter((l) => {
    const stored = current.find((c) => c.libraryId === l.libraryId);
    return stored === undefined || scriptLibraryDigest(stored) !== scriptLibraryDigest(l);
  });
  const dependents = [...new Set(changed.flatMap((l) => scriptLibraryDependents(content.behaviors, l.libraryId)))].sort();
  if (dependents.length === 0) return { ok: true, stage: stageSummary(stage), dependents: [], compiled: 0 };
  const trusted = (digest: string): boolean => content.behaviorTrust.entries.some((e) => e.sourceDigest === digest);
  for (const l of changed) {
    const digest = scriptLibraryDigest(l);
    if (scriptLibraryDependents(content.behaviors, l.libraryId).length > 0 && !trusted(digest)) return { ok: false, kind: 'error', error: behaviorTrustUnacknowledged(digest) };
  }
  const compiler: BehaviorCompiler | undefined = core.content.behaviorCompiler;
  if (compiler === undefined) return { ok: false, kind: 'error', error: behaviorPublicationUnavailable(dependents[0] as string, 'source', 'preparer_unavailable') };
  const setKey = scriptLibrarySetKey(next);
  const inputs = libraryInputs(next);
  const out: { behaviorId: string; outputDigest: string }[] = [];
  let compiled = 0;
  for (const behaviorId of dependents) {
    const record = content.behaviors.find((b) => b.behaviorId === behaviorId);
    const source = record?.source;
    if (record === undefined || source === null || source === undefined) continue;
    const read = readSourceBlob(core, s as never, { digest: source.sourceDigest });
    if (!read.ok) return { ok: false, kind: 'error', error: read.error };
    let result;
    try {
      compiled += 1;
      result = await compiler.compile({ behaviorId, declaration: record.declaration, containerBytes: read.bytes, pinnedModules: compiler.pinnedModules, libraries: inputs });
    } catch (e) {
      return { ok: false, kind: 'compile', behaviorId, failure: { ok: false, code: 'behavior_compile_failed', reason: 'the injected compiler threw', diagnostics: [{ code: 'behavior_compile_failed', reason: 'throw', message: (e instanceof Error ? e.message : String(e)).slice(0, 256) }] } };
    }
    if (!result.ok) return { ok: false, kind: 'compile', behaviorId, failure: result };
    const prepared = preparedSourceFromCompile(result);
    for (const pin of prepared.libraries ?? []) {
      if (!trusted(pin.sourceDigest)) return { ok: false, kind: 'error', error: behaviorTrustUnacknowledged(pin.sourceDigest) };
    }
    s.preparedSources.set(`${source.sourceDigest}|${setKey}`, prepared);
    out.push({ behaviorId, outputDigest: prepared.outputDigest });
  }
  return { ok: true, stage: stageSummary(stage), dependents: out, compiled };
}
