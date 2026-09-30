/**
 * Shared script libraries (`content.scriptLibraries`, v4).
 *
 * `setScriptLibrary {libraryId, name?, files?}` creates a library or patches
 * one (files listed are added or replaced, `text: null` removes one, files
 * not mentioned are kept — so an edit sends only what changed and stays
 * under the request cap). `deleteScriptLibrary {libraryId}` removes one,
 * refused (`reference_in_use`) while a published behavior imports it.
 *
 * A library change republishes every published behavior that imports it
 * (its source record pins the library's digest) in the SAME command: the
 * preparation layer compiled each dependent against the library set this
 * command commits and filed the digest-bound facts under
 * `<sourceDigest>|<librarySetKey>`; the command builds the new records only
 * from those facts (never from caller input), so the change and its undo
 * move the library and its dependents together. A missing fact refuses the
 * command (`behavior_publication_unavailable`, `preparation_missing`); a
 * library digest a dependent now links must be acknowledged (trust per
 * digest, as for behavior sources).
 */
import {
  applyScriptLibraryPatch,
  canonicalScriptLibraries,
  scriptLibraryDependents,
  scriptLibraryDigest,
  scriptLibrarySetKey,
  validateScriptLibrary,
  type ModelErrorV2,
  type ScriptLibrary,
  type BehaviorRecord,
  type ScriptLibraryPatch,
} from '@thirdlight/project-model';

import { behaviorPublicationUnavailable, behaviorTrustUnacknowledged, fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SetScriptLibrariesChange, SetScriptLibraryChange } from './types';
import { withListRecord } from './record-lists';

type WithLibraries = ContentDocument & { scriptLibraries?: ScriptLibrary[] };

function modelError(e: ModelErrorV2, prefix: string): CommandError {
  return { code: e.code, cls: 'validation', path: `${prefix}${e.path ?? ''}`, message: e.message, ...(e.found !== undefined ? { found: e.found } : {}), ...(e.expected !== undefined ? { expected: e.expected } : {}) } as unknown as CommandError;
}

export const scriptLibrariesOf = (content: ContentDocument): ScriptLibrary[] => (content as WithLibraries).scriptLibraries ?? [];

/** The content with one library set (or removed when null); the list stays canonical and is absent when empty. */
export function withScriptLibrary(content: ContentDocument, libraryId: string, library: ScriptLibrary | null): ContentDocument {
  const c = { ...(content as WithLibraries) };
  const list = withListRecord(c.scriptLibraries, (l) => l.libraryId, libraryId, library === null ? null : canonicalScriptLibraries([deepClone(library)])[0]!);
  if (list.length > 0) c.scriptLibraries = list;
  else delete c.scriptLibraries;
  return c as ContentDocument;
}

/** The content with some behavior records replaced (by id, order kept). */
export function withBehaviorRecords(content: ContentDocument, records: readonly BehaviorRecord[]): ContentDocument {
  if (records.length === 0) return content;
  const byId = new Map(records.map((r) => [r.behaviorId, r] as const));
  return { ...content, behaviors: content.behaviors.map((b) => (byId.has(b.behaviorId) ? deepClone(byId.get(b.behaviorId) as BehaviorRecord) : b)) };
}

function commit(
  input: OpInput,
  next: ContentDocument,
  libraryId: string,
  previous: ScriptLibrary | null,
  behaviors: { behaviorId: string; previous: BehaviorRecord; next: BehaviorRecord }[],
): OpOutcome {
  const catalog = contentOf(input.content);
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  const stored = scriptLibrariesOf((gate.content ?? next) as ContentDocument).find((l) => l.libraryId === libraryId) ?? null;
  const change: SetScriptLibraryChange = {
    type: 'setScriptLibrary',
    libraryId,
    previous: previous === null ? null : deepClone(previous),
    next: stored === null ? null : deepClone(stored),
    behaviors: behaviors.map((b) => ({ behaviorId: b.behaviorId, previous: deepClone(b.previous), next: deepClone(b.next) })),
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change,
      inverse: { kind: 'setScriptLibrary', libraryId, restore: previous === null ? null : deepClone(previous), behaviors: behaviors.map((b) => ({ behaviorId: b.behaviorId, restore: deepClone(b.previous) })) },
    },
  };
}

/**
 * The dependents' records recompiled against `nextLibraries` (from the
 * prepared facts only). The scripts that import any of the
 * changed libraries, each once.
 */
function republishDependents(
  input: OpInput,
  catalog: ContentDocument,
  libraryIds: string | readonly string[],
  nextLibraries: readonly ScriptLibrary[],
): { ok: true; behaviors: { behaviorId: string; previous: BehaviorRecord; next: BehaviorRecord }[] } | { ok: false; error: CommandError } {
  const ids = typeof libraryIds === 'string' ? [libraryIds] : libraryIds;
  const dependents = [...new Set(ids.flatMap((id) => scriptLibraryDependents(catalog.behaviors, id)))].sort();
  const libraryId = ids.join(', @lib/');
  if (dependents.length === 0) return { ok: true, behaviors: [] };
  const setKey = scriptLibrarySetKey(nextLibraries);
  const out: { behaviorId: string; previous: BehaviorRecord; next: BehaviorRecord }[] = [];
  for (const behaviorId of dependents) {
    const record = catalog.behaviors.find((b) => b.behaviorId === behaviorId) as BehaviorRecord;
    const source = record.source as NonNullable<BehaviorRecord['source']>;
    const fact = input.preparedBehaviorSources?.get(`${source.sourceDigest}|${setKey}`);
    if (fact === undefined || fact.behaviorId !== behaviorId || fact.sourceDigest !== source.sourceDigest) {
      const e = behaviorPublicationUnavailable(behaviorId, 'source', 'preparation_missing');
      return { ok: false, error: { ...e, message: `script ${behaviorId} imports @lib/${libraryId} and was not recompiled against the changed library (publish through the script library route, which recompiles it)`.slice(0, 256) } };
    }
    for (const pin of fact.libraries ?? []) {
      if (!catalog.behaviorTrust.entries.some((t) => t.sourceDigest === pin.sourceDigest)) return { ok: false, error: behaviorTrustUnacknowledged(pin.sourceDigest) };
    }
    const nextSource: NonNullable<BehaviorRecord['source']> = {
      sourceDigest: source.sourceDigest,
      sourceByteLength: source.sourceByteLength,
      entryPath: source.entryPath,
      fileCount: source.fileCount,
      manifestDigest: fact.manifestDigest,
      outputDigest: fact.outputDigest,
      outputByteLength: fact.outputByteLength,
      requiredModules: [...source.requiredModules],
      ...(source.ownedTransforms !== undefined ? { ownedTransforms: [...source.ownedTransforms] } : {}),
      ...(source.declaredInCode === true ? { declaredInCode: true as const } : {}),
      ...(source.kind === 'graph' ? { kind: 'graph' as const } : {}),
      ...(fact.libraries !== undefined && fact.libraries.length > 0 ? { libraries: fact.libraries.map((p) => ({ ...p })) } : {}),
      publishedRevision: input.revision,
    };
    out.push({ behaviorId, previous: deepClone(record), next: { ...deepClone(record), source: nextSource, publishedRevision: input.revision } });
  }
  return { ok: true, behaviors: out };
}

/** `setScriptLibrary`: create a library or patch one (and republish its dependents). */
export function applySetScriptLibrary(input: OpInput, args: ScriptLibraryPatch): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = scriptLibrariesOf(catalog).find((l) => l.libraryId === args.libraryId) ?? null;
  const patched = applyScriptLibraryPatch(previous, args);
  if (!patched.ok) return { ok: false, error: fieldValue(patched.path, args, 'a valid script library patch', patched.message) };
  const errors: ModelErrorV2[] = [];
  validateScriptLibrary(patched.library, '', errors);
  if (errors.length > 0) return { ok: false, error: modelError(errors[0]!, '/args') };
  const next = withScriptLibrary(catalog, args.libraryId, patched.library);
  // Only a changed digest (the files) needs the dependents recompiled; a rename does not.
  const changed = previous === null || scriptLibraryDigest(previous) !== scriptLibraryDigest(patched.library);
  const deps = changed ? republishDependents(input, catalog, args.libraryId, scriptLibrariesOf(next)) : { ok: true as const, behaviors: [] };
  if (!deps.ok) return deps;
  return commit(input, withBehaviorRecords(next, deps.behaviors.map((b) => b.next)), args.libraryId, previous, deps.behaviors);
}

/** `deleteScriptLibrary`: remove one (refused while a published behavior imports it). */
export function applyDeleteScriptLibrary(input: OpInput, args: { libraryId: string }): OpOutcome {
  const catalog = contentOf(input.content);
  const previous = scriptLibrariesOf(catalog).find((l) => l.libraryId === args.libraryId) ?? null;
  if (previous === null) return { ok: false, error: { ...fieldValue('/args/libraryId', args.libraryId, 'an existing libraryId', 'no script library with this id'), code: 'reference_missing' } };
  const users = scriptLibraryDependents(catalog.behaviors, args.libraryId);
  if (users.length > 0) {
    return { ok: false, error: { ...fieldValue('/args/libraryId', args.libraryId, 'a library no published script imports', `the script library is imported by ${users.slice(0, 8).join(', ')}${users.length > 8 ? ', …' : ''} (remove the import and republish first)`), code: 'reference_in_use' } };
  }
  return commit(input, withScriptLibrary(catalog, args.libraryId, null), args.libraryId, previous, []);
}

/**
 * `commitScriptLibraryStage {stageId}` — the libraries a host
 * staged over several patches (each under the request cap), committed as one
 * change: every staged library replaced at once, the published scripts that
 * import any of them republished once from the facts compiled against the
 * committed set, one revision and one undo. A library changed since it was
 * staged (its digest no longer the stage's base) refuses the commit.
 */
export function applyCommitScriptLibraryStage(input: OpInput, args: { stageId: string }): OpOutcome {
  const stage = input.scriptLibraryStages?.get(args.stageId);
  if (stage === undefined) {
    return { ok: false, error: { ...fieldValue('/args/stageId', args.stageId, 'a staged library edit set of this project', 'no staged library edits with this id (stages are kept while the backend runs; commit or discard it once)'), code: 'reference_missing' } };
  }
  if (stage.libraries.length === 0) {
    return { ok: false, error: fieldValue('/args/stageId', args.stageId, 'a stage holding at least one library', 'the stage holds no library edits') };
  }
  const catalog = contentOf(input.content);
  const current = scriptLibrariesOf(catalog);
  const entries: { libraryId: string; previous: ScriptLibrary | null; next: ScriptLibrary }[] = [];
  for (const staged of stage.libraries) {
    const previous = current.find((l) => l.libraryId === staged.libraryId) ?? null;
    const base = previous === null ? null : scriptLibraryDigest(previous);
    if (base !== staged.base) {
      return { ok: false, error: fieldValue('/args/stageId', args.stageId, 'a stage made on the current libraries', `the script library @lib/${staged.libraryId} changed since it was staged (stage it again on the current library)`) };
    }
    const errors: ModelErrorV2[] = [];
    validateScriptLibrary(staged.library, '', errors);
    if (errors.length > 0) {
      const e = modelError(errors[0]!, `/stage/${staged.libraryId}`);
      return { ok: false, error: { ...e, message: `@lib/${staged.libraryId}: ${e.message}`.slice(0, 256) } as CommandError };
    }
    entries.push({ libraryId: staged.libraryId, previous, next: staged.library });
  }
  let next = catalog;
  for (const e of entries) next = withScriptLibrary(next, e.libraryId, e.next);
  // Only libraries whose files changed need their dependents recompiled (a rename does not).
  const changed = entries.filter((e) => e.previous === null || scriptLibraryDigest(e.previous) !== scriptLibraryDigest(e.next)).map((e) => e.libraryId);
  const deps = changed.length > 0 ? republishDependents(input, catalog, changed, scriptLibrariesOf(next)) : { ok: true as const, behaviors: [] };
  if (!deps.ok) return deps;
  const withDeps = withBehaviorRecords(next, deps.behaviors.map((b) => b.next));
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, withDeps);
  if (!gate.ok) return gate;
  const stored = scriptLibrariesOf((gate.content ?? withDeps) as ContentDocument);
  const change: SetScriptLibrariesChange = {
    type: 'setScriptLibraries',
    libraries: entries.map((e) => ({ libraryId: e.libraryId, previous: e.previous === null ? null : deepClone(e.previous), next: deepClone(stored.find((l) => l.libraryId === e.libraryId) ?? e.next) })),
    behaviors: deps.behaviors.map((b) => ({ behaviorId: b.behaviorId, previous: deepClone(b.previous), next: deepClone(b.next) })),
  };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      content: gate.content,
      change,
      inverse: {
        kind: 'setScriptLibraries',
        libraries: entries.map((e) => ({ libraryId: e.libraryId, restore: e.previous === null ? null : deepClone(e.previous) })),
        behaviors: deps.behaviors.map((b) => ({ behaviorId: b.behaviorId, restore: deepClone(b.previous) })),
      },
    },
  };
}
