/**
 * A mutation on a v4 project, after the service resolved the project,
 * deduplicated the request and checked the pause: the pure command on the
 * scene it touches, the commit-time checks of the bytes it references, the
 * cross-scene rules over the resulting project, the write of the files that
 * changed, and the publish of the new state.
 */

import { applyMutation, contentInUse, FILE_MOVE_OPS } from '@thirdlight/commands';
import type { AdoptedScene, CommandError, CommandState, ContentDocument, HistoryEntry, HistoryState, MoveResourcesChange, MutationResult, MutationSuccess, SceneDocument } from '@thirdlight/commands';
import type { ModelErrorV3, SceneEnvironment, SceneV4 } from '@thirdlight/project-model';
import { composeV4, INSTANCE_FLOATS, RESOURCE_CREATING_OPS } from '@thirdlight/project-model';

import type { RetryRecord } from './envelope';
import { readSourceBlob, verifyConvertedOriginal, verifyImported, verifyReferencedBlob } from './content-store';
import { checkAssetFolder, planPlacement, syncAssetFiles, type ConvertedLike } from './asset-files';
import { mintImportItems } from './folder-import';
import { applyFileMoves, checkReplayedMoves, movedFileKeys, prepareFileMoves } from './file-moves';
import { contentCtx } from './service-content';
import { libraryStageFacts, preparedFactsOf } from './behavior';
import { externalChangeUnreadable, externalChangeUnresolved, pathRejected, writeFailed } from './errors';
import { withUntrackedSidecars, writeTransaction, type KnownFile, type V4State } from './store-v4';
import { changedFiles, detectExternalChangeV4, gameRootOf, publishV4, setPendingUnreadableV4, type Placement } from './session-v4';
import { pendingInfo, type Core, type ProjectSession } from './session';
import { envelopeRequestId, failRequest } from './request-envelope';
import { scriptsNaming } from './script-names';
import { prepareInstanceStroke, publishStrokeBuffer, type StrokeBuffer } from './instance-strokes';
import { catalogV4Of, commandContentOf, crossSceneEntities, projectRuleError, sceneMissing, sceneNotEmpty, sceneV4Of } from './content-shapes';

/**
 * The bytes a successful publication references (the new version's
 * digest/length and where they are), or null for a non-publication or a
 * history op. Commit-time verification uses it. Undo and redo restore a
 * version recorded (and verified) earlier: the workspace puts back the file
 * bytes it holds, a file changed since is reported by the file check, and
 * reads refuse it, but it never blocks the undo.
 */
function publishedBlobRefs(
  result: MutationSuccess,
): { digest: string; byteLength: number; sourcePath?: string; convertedFrom?: ConvertedLike }[] {
  const ch = result.change;
  if (ch.type === 'publishBehavior') {
    // A source publication references the immutable container blob
    // exactly like an asset version does.
    const src = ch.next === null ? null : ch.next.source;
    if (src === null) return [];
    return [{ digest: src.sourceDigest, byteLength: src.sourceByteLength }];
  }
  if (result.op === 'undo' || result.op === 'redo') return [];
  const records = ch.type === 'publishAsset' ? (ch.next === null ? [] : [ch.next]) : ch.type === 'importAssets' ? ch.added : [];
  const out: { digest: string; byteLength: number; sourcePath?: string; convertedFrom?: ConvertedLike }[] = [];
  for (const record of records) {
    const last = record.versions[record.versions.length - 1];
    if (last === undefined) continue;
    const sourcePath = (last as { sourcePath?: string }).sourcePath;
    const convertedFrom = (last as { convertedFrom?: ConvertedLike }).convertedFrom;
    out.push({
      digest: last.sourceDigest,
      byteLength: last.sourceByteLength,
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      ...(convertedFrom !== undefined ? { convertedFrom } : {}),
    });
  }
  return out;
}

/**
 * Steps 4–9 for a v4 project. The command runs on the one
 * scene it touches (found from its entity ids, or `args.sceneId` for a
 * create), with the other scenes' ids reserved; the resulting whole project
 * is checked against the cross-scene rules; only the changed files are
 * written (one `W`, or a journaled transaction for several).
 */
export function runCommandV4(core: Core, s: ProjectSession, sent: unknown, D: string): MutationResult {
  const state = s.v4 as V4State;
  // A publish the host prepared runs with its prepared args and revision (`D` stays the sent request's).
  let request = sent;
  const rid = (sent as { requestId?: unknown }).requestId;
  const prepared = (sent as { op?: unknown }).op === 'publishAsset' && typeof rid === 'string' ? s.preparedPublishes?.get(rid) : undefined;
  if (prepared !== undefined) {
    s.preparedPublishes!.delete(rid as string);
    request = { ...(sent as object), expectedRevision: prepared.expectedRevision, args: prepared.args };
  }
  const req = request as { op?: unknown; args?: unknown };
  const op = typeof req.op === 'string' ? req.op : '';
  const args = (req.args !== null && typeof req.args === 'object' && !Array.isArray(req.args) ? req.args : {}) as Record<string, unknown>;
  const target = targetSceneV4(state, s.history, op, args);
  if (!target.ok) return failRequest(request, target.error);
  // `sceneId` on a create names the scene; the pure layer never sees it.
  let pureRequest = request;
  if ((op === 'createEntity' || op === 'instantiatePrefab' || op === 'pasteEntities' || op === 'createEntities') && 'sceneId' in args) {
    const { sceneId: _s, ...rest } = args;
    pureRequest = { ...(request as object), args: rest };
  }
  const carrierId = target.sceneId ?? primarySceneIdV4(state);
  const carrier = state.scenes.get(carrierId);
  if (carrier === undefined) return failRequest(request, sceneMissing(carrierId));
  if (op === 'deleteScene') {
    const doomed = state.scenes.get(String(args['sceneId']));
    if (doomed !== undefined && doomed.entities.length > 0) {
      return failRequest(request, sceneNotEmpty(args['sceneId'], doomed.entities.length));
    }
  }
  // An asset or prefab a script names as a string literal (`ctx.spawn("crate")`) is in use too.
  if ((op === 'deleteAsset' || op === 'deletePrefab') && typeof args[op === 'deleteAsset' ? 'assetId' : 'prefabId'] === 'string') {
    const id = args[op === 'deleteAsset' ? 'assetId' : 'prefabId'] as string;
    const named = scriptsNaming((digest) => {
      const r = readSourceBlob(core, contentCtx(s), { digest });
      return r.ok ? r.bytes : null;
    }, commandContentOf(state.content), id);
    if (named.length > 0) return failRequest(request, contentInUse(op === 'deleteAsset' ? 'asset' : 'prefab', id, named));
  }
  const reserved = new Set<string>();
  for (const [id, sc] of state.scenes) if (id !== carrierId) for (const e of sc.entities) reserved.add(e.id);
  const commandState: CommandState<SceneDocument> = {
    scene: { ...carrier, revision: state.revision },
    content: commandContentOf(state.content),
    history: s.history,
    reservedIds: reserved,
  };
  if (core.content.behaviorCompiler !== undefined) commandState.behaviorPreparerRegistered = true;
  if (s.preparedSources.size > 0) commandState.preparedBehaviorSources = preparedFactsOf(s.preparedSources);
  // The look of a scene a scene-index op names besides the edited one: the scene a new one copies, a deleted scene.
  const named = op === 'createScene' ? args['environmentFrom'] : op === 'deleteScene' ? args['sceneId'] : undefined;
  const namedLook = typeof named === 'string' ? state.scenes.get(named)?.environment : undefined;
  if (namedLook !== undefined) commandState.sceneEnvironments = new Map([[named as string, namedLook]]);
  // The staged library edit sets (a commit reads only these).
  const stages = libraryStageFacts(s);
  if (stages !== undefined) commandState.scriptLibraryStages = stages;
  // Bytes uploaded to the backend name no file yet: the workspace chooses
  // where in the game folder they go (`folder`: where the user dropped them),
  // and the command records that path.
  let folder: string | undefined;
  if (op === 'publishAsset' && 'folder' in args) {
    const { folder: f, ...rest } = args;
    if (typeof f !== 'string') return failRequest(request, pathRejected(String(f), 'folder names a folder of the game folder, e.g. assets/props'));
    const vetted = checkAssetFolder(contentCtx(s), f);
    if (!vetted.ok) return failRequest(request, vetted.error);
    folder = f;
    pureRequest = { ...(pureRequest as object), args: rest };
  }
  const placement = op === 'publishAsset' ? planPlacement(core, contentCtx(s), (pureRequest as { args: Record<string, unknown> }).args, state.content, (digest) => {
    const r = readSourceBlob(core, contentCtx(s), { digest });
    return r.ok ? r.bytes : null;
  }, folder) : null;
  if (folder !== undefined && placement === null) return failRequest(request, pathRejected(folder, 'folder places uploaded bytes; this asset names its file already'));
  if (placement !== null) pureRequest = { ...(pureRequest as object), args: placement.args };
  // A create names the folder of the game folder its resource or scene goes into (the pure layer never sees it).
  let place: Placement = {};
  if (RESOURCE_CREATING_OPS.includes(op) && 'folder' in args) {
    const { folder: f, ...rest } = args;
    if (typeof f !== 'string') return failRequest(request, pathRejected(String(f), 'folder names a folder of the game folder, e.g. assets/levels'));
    const vetted = checkAssetFolder(contentCtx(s), f);
    if (!vetted.ok) return failRequest(request, vetted.error);
    place = { folder: f };
    pureRequest = { ...(pureRequest as object), args: rest };
  }
  // Resource and scene files the file check read (once): adopted where they are.
  if (op === 'importResources') {
    const prepared = s.preparedResources;
    s.preparedResources = undefined;
    if (prepared !== undefined) {
      commandState.preparedResourceImport = prepared.prepared;
      place = { at: prepared.at, disk: prepared.disk };
    }
  }
  // A folder import reads the files the backend inspected for it (once), each given its id now.
  if (op === 'importAssets' && typeof args['folder'] === 'string') {
    const files = s.preparedImports?.get(args['folder']);
    s.preparedImports?.delete(args['folder']);
    if (files !== undefined) commandState.preparedAssetImport = { folder: args['folder'], items: mintImportItems(state.content, files) };
  }
  // A move names items and folders; the files they are and where they go are found here.
  if (FILE_MOVE_OPS.includes(op)) {
    const prepared = prepareFileMoves(contentCtx(s), state, s.index, op, args);
    if (prepared !== null && !prepared.ok) return failRequest(request, prepared.error);
    if (prepared !== null) commandState.preparedMoves = prepared.prepared;
  }
  // A brush stroke: its copies planned here from the set's buffer and the scene; the new buffer is published once the command passed.
  let strokeBuffer: StrokeBuffer | null = null;
  if (op === 'paintInstances') {
    const prepared = prepareInstanceStroke(core, s, carrier, commandState.content, args);
    if (!prepared.ok) return failRequest(request, prepared.error);
    commandState.preparedInstanceStroke = prepared.prepared;
    strokeBuffer = prepared.buffer;
  }
  const outcome = applyMutation(commandState, pureRequest);
  if (!outcome.ok) return outcome.result;
  // A move (or its undo or redo) puts resource and scene files elsewhere; an undo or redo first checks its targets are free.
  const moveChange = outcome.result.change.type === 'moveResources' ? (outcome.result.change as MoveResourcesChange) : null;
  if (moveChange !== null) {
    if (op === 'undo' || op === 'redo') {
      const taken = checkReplayedMoves(contentCtx(s), moveChange);
      if (taken !== null) return failRequest(request, taken);
    }
    place = { ...place, moved: movedFileKeys(moveChange) };
  }
  // Remember which scene the new history entry edited (undo/redo route by it).
  const entries = outcome.state.history.entries;
  if (op !== 'undo' && op !== 'redo' && entries.length > 0) {
    const last = entries[entries.length - 1] as HistoryEntry;
    if (target.sceneId !== null) (last as { sceneId?: string }).sceneId = target.sceneId;
  }

  // Commit-time blob checks: a published asset version; an instance buffer.
  // Uploaded bytes are filed into the game folder now that the command's own checks passed.
  const refuse = (error: CommandError): MutationResult => {
    placement?.rollback();
    return failRequest(request, error);
  };
  if (placement !== null) {
    const placed = placement.write();
    if (placed !== null) return refuse(placed);
  }
  for (const ref of publishedBlobRefs(outcome.result)) {
    // A converted version: its file first (the original), then what the importer made from it.
    if (ref.convertedFrom !== undefined) {
      const o = verifyConvertedOriginal(contentCtx(s), ref.convertedFrom);
      if (!o.ok) return refuse(o.error);
    }
    const v = ref.convertedFrom !== undefined ? verifyImported(contentCtx(s), ref.convertedFrom, ref.digest) : verifyReferencedBlob(contentCtx(s), ref.digest, ref.byteLength, ref.sourcePath);
    if (!v.ok) return refuse(v.error);
  }
  const resultScene = sceneV4Of(outcome.state.scene);
  for (const e of resultScene.entities) {
    const inst = e.components.instances;
    if (inst === undefined) continue;
    const before = carrier.entities.find((x) => x.id === e.id)?.components.instances;
    if (before !== undefined && before.buffer === inst.buffer && before.count === inst.count) continue;
    // The stroke's own buffer is in hand (published below), its size the planner's.
    if (strokeBuffer !== null && inst.buffer === strokeBuffer.digest && strokeBuffer.bytes.byteLength === inst.count * INSTANCE_FLOATS * 4) continue;
    const v = verifyReferencedBlob(contentCtx(s), inst.buffer, inst.count * INSTANCE_FLOATS * 4);
    if (!v.ok) return refuse(v.error);
  }

  // The whole resulting project: scenes (the index may have changed) and content.
  const newRevision = outcome.result.revision;
  const nextContent = outcome.state.content !== undefined ? catalogV4Of(outcome.state.content) : state.content;
  const nextScenes = new Map<string, SceneV4>();
  // Scene files the command adopts (and their redo) bring their documents.
  const adopted = new Map<string, SceneV4>();
  const change = outcome.result.change as { type: string; scenesAdded?: AdoptedScene[]; environments?: Record<string, SceneEnvironment> };
  if (change.type === 'importResources') for (const a of change.scenesAdded ?? []) adopted.set(a.sceneId, a.scene as SceneV4);
  for (const entry of nextContent.scenes) {
    if (entry.sceneId === carrierId) nextScenes.set(entry.sceneId, { ...resultScene, sceneId: carrierId });
    else {
      // A scene the index gains gets a new file, with the look the change carries (a copied look, an undone delete's).
      const look = change.type === 'setSceneIndex' ? change.environments?.[entry.sceneId] : undefined;
      nextScenes.set(entry.sceneId, state.scenes.get(entry.sceneId) ?? adopted.get(entry.sceneId) ?? { schemaVersion: 4, sceneId: entry.sceneId, revision: newRevision, ...(look !== undefined ? { environment: look } : {}), entities: [] });
    }
  }
  const errors: ModelErrorV3[] = [];
  composeV4([...nextScenes.values()], nextContent, errors, newRevision);
  if (errors.length > 0 && (op === 'deleteAsset' || op === 'deletePrefab')) {
    // What no longer resolves in the other scenes names it.
    return refuse(contentInUse(op === 'deleteAsset' ? 'asset' : 'prefab', String(args[op === 'deleteAsset' ? 'assetId' : 'prefabId']), errors));
  }
  if (errors.length > 0) return refuse(projectRuleError(errors));
  if (strokeBuffer !== null) {
    const unpublished = publishStrokeBuffer(core, s, strokeBuffer);
    if (unpublished !== null) return refuse(unpublished);
  }
  // The acknowledgement names the edited scene (the editor
  // files new entities under it); a scene-index change names none.
  // The record stores that acknowledgement, so a replay carries it.
  let ack: MutationSuccess = outcome.result.change.type !== 'setSceneIndex' ? { ...outcome.result, sceneId: carrierId } : outcome.result;
  // Adopted scenes are in their own files: the acknowledgement (and so every retry record) names them without their documents.
  if (change.type === 'importResources') ack = { ...ack, change: { ...ack.change, scenesAdded: (change.scenesAdded ?? []).map((a) => ({ sceneId: a.sceneId, name: a.name })) } as MutationSuccess['change'] };
  const record: RetryRecord = { requestId: envelopeRequestId(request)!, digest: D, appliedRevision: newRevision, result: ack };
  const plan = changedFiles(s.projectId, state, { content: nextContent, scenes: nextScenes, revision: newRevision }, record, place);
  // Files adopted where they are: what the file check read is the baseline their write is checked against.
  const base = withUntrackedSidecars(core.ops, s.dir, gameRootOf(s), state.files, plan.writes);
  const disk = place.disk;
  const known = disk === undefined ? base : { get: (rel: string): KnownFile | undefined => (disk.has(rel) ? (disk.get(rel) ?? undefined) : base.get(rel)) };
  const res = writeTransaction(core.ops, s.dir, s.thirdlightDir, s.projectId, known, plan.writes, gameRootOf(s));
  // The state after the write (its known files are brought up to date only once the write is done).
  const nextState = (): V4State => ({ manifest: state.manifest, content: nextContent, scenes: nextScenes, revision: newRevision, files: plan.commitFiles(), fileRecords: plan.fileRecords, resourcePaths: plan.resourcePaths, scenePaths: plan.scenePaths, formerPaths: plan.formerPaths });
  if (!res.ok) {
    if ('unreadable' in res) {
      setPendingUnreadableV4(s, res.unreadable.rel);
      placement?.rollback();
      return failRequest(request, externalChangeUnreadable(s.projectId));
    }
    if ('external' in res) {
      const pc = detectExternalChangeV4(core, s, res.external);
      placement?.rollback();
      return failRequest(request, externalChangeUnresolved(pendingInfo(pc)));
    }
    if (res.failed.onDiskState === 'previous') return refuse(writeFailed('previous', res.failed.errno));
    publishV4(s, nextState());
    s.history = outcome.state.history;
    return failRequest(request, writeFailed('new-undurable', res.failed.errno));
  }
  publishV4(s, nextState());
  s.history = outcome.state.history;
  // A committed stage is done (committing it again is refused).
  if (op === 'commitScriptLibraryStage' && typeof args['stageId'] === 'string') s.libraryStages?.delete(args['stageId']);
  // The game folder follows what the command did to an asset: its sidecar, a delete, a move, an undone replace.
  const fileProblems = moveChange !== null ? applyFileMoves(contentCtx(s), moveChange) : syncAssetFiles(core, contentCtx(s), outcome.result.change, nextContent);
  if (fileProblems.length > 0) s.fileProblems = [...(s.fileProblems ?? []), ...fileProblems].slice(-32);
  return ack;
}

/** The id of a v4 project's first start scene. */
function primarySceneIdV4(state: V4State): string {
  return state.content.startScenes[0] ?? state.content.scenes[0]?.sceneId ?? '';
}

/**
 * The scene a v4 command edits — from the entity ids it names
 * (ids are unique across scenes), `args.sceneId` or the parent for a create,
 * the history entry for undo/redo; null for a content-only command. A command
 * spanning two scenes is refused (one transaction touches one scene).
 */
function targetSceneV4(
  state: V4State,
  history: HistoryState,
  op: string,
  args: Record<string, unknown>,
): { ok: true; sceneId: string | null } | { ok: false; error: CommandError } {
  const sceneOf = (id: unknown): string | null => {
    if (typeof id !== 'string') return null;
    for (const [sid, sc] of state.scenes) if (sc.entities.some((e) => e.id === id)) return sid;
    return null;
  };
  const cross = (path: string): { ok: false; error: CommandError } => ({ ok: false, error: crossSceneEntities(path) });
  if (op === 'undo' || op === 'redo') {
    const entry = op === 'undo' ? history.entries[history.cursor - 1] : history.entries[history.cursor];
    return { ok: true, sceneId: (entry as { sceneId?: string } | undefined)?.sceneId ?? null };
  }
  if (op === 'createEntity' || op === 'instantiatePrefab' || op === 'pasteEntities') {
    const explicit = args['sceneId'];
    if (explicit !== undefined) {
      if (typeof explicit !== 'string' || !state.scenes.has(explicit)) {
        return { ok: false, error: sceneMissing(explicit) };
      }
      const parentScene = sceneOf(args['parentId']);
      if (typeof args['parentId'] === 'string' && parentScene !== null && parentScene !== explicit) return cross('/args/parentId');
      return { ok: true, sceneId: explicit };
    }
    return { ok: true, sceneId: sceneOf(args['parentId']) ?? primarySceneIdV4(state) };
  }
  if (op === 'createEntities') {
    // Every item lands in one scene: `sceneId`, else the scene of the items' existing parents, else the primary one.
    const items = Array.isArray(args['entities']) ? (args['entities'] as unknown[]) : [];
    const parents = new Set(items.map((it) => sceneOf((it as { parentId?: unknown } | null)?.parentId)).filter((x): x is string => x !== null));
    const explicit = args['sceneId'];
    if (explicit !== undefined) {
      if (typeof explicit !== 'string' || !state.scenes.has(explicit)) {
        return { ok: false, error: sceneMissing(explicit) };
      }
      if ([...parents].some((p) => p !== explicit)) return cross('/args/entities');
      return { ok: true, sceneId: explicit };
    }
    if (parents.size > 1) return cross('/args/entities');
    return { ok: true, sceneId: [...parents][0] ?? primarySceneIdV4(state) };
  }
  if (op === 'moveEntities') {
    const ids = Array.isArray(args['entityIds']) ? (args['entityIds'] as unknown[]) : [];
    const scenes = new Set(ids.map(sceneOf).filter((x): x is string => x !== null));
    const parent = sceneOf(args['parentId']);
    if (parent !== null) scenes.add(parent);
    const before = sceneOf(args['beforeId']);
    if (before !== null) scenes.add(before);
    if (scenes.size > 1) return cross('/args/entityIds');
    return { ok: true, sceneId: [...scenes][0] ?? primarySceneIdV4(state) };
  }
  if (op === 'updateEntity') {
    const own = sceneOf(args['entityId']);
    const parent = sceneOf(args['parentId']);
    if (own !== null && parent !== null && own !== parent) return cross('/args/parentId');
    return { ok: true, sceneId: own ?? primarySceneIdV4(state) };
  }
  if (op === 'createPrefab') return { ok: true, sceneId: sceneOf(args['sourceEntityId']) ?? primarySceneIdV4(state) };
  // A scene's look is that scene's edit.
  if (op === 'setEnvironment' && args['sceneId'] !== undefined) {
    const explicit = args['sceneId'];
    if (typeof explicit !== 'string' || !state.scenes.has(explicit)) return { ok: false, error: sceneMissing(explicit) };
    return { ok: true, sceneId: explicit };
  }
  if (op === 'publishAsset') {
    const anim = args['animation'] as { entityId?: unknown } | undefined;
    return { ok: true, sceneId: anim !== undefined ? sceneOf(anim.entityId) : null };
  }
  if ('entityId' in args) return { ok: true, sceneId: sceneOf(args['entityId']) ?? primarySceneIdV4(state) };
  return { ok: true, sceneId: null };
}
