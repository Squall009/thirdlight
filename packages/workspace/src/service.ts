/**
 * The workspace service — the sole command executor.
 *
 * `openWorkspaceService(config)` builds a service bound to one configured
 * data root (`<root>/projects/<projectId>` — arbitrary absolute paths are
 * never accepted). `runCommand` runs the full command pipeline per
 * mutation: project resolution (1), deduplication before any
 * revision check (2), pause check (3), `applyMutation` (4–6, the pure
 * layer), the durable write (7), publish (8), acknowledge (9). The
 * pipeline is synchronous: the per-project mutation lock is the whole
 * synchronous sequence (one mutation at a time).
 *
 * Acknowledgement timing: a success ack is returned
 * only after the durable write completed including the directory flush AND
 * the verification read, and the in-memory state is published at the same
 * point — a success ack implies the durable state already contains the
 * command's record.
 */

import {
  DEFAULT_PROJECT_SUBDIR,
  MARKER_FILE,
  PROJECT_GITIGNORE,
  findMarkerFolder,
  isWithin,
  loadRegistry,
  markerBytes,
  readMarker,
  resolveEntry,
  saveRegistry,
  writeSmallFileAtomic,
  type EnginePin,
  type ProjectMarker,
} from './registry';
import { mkdirSync, chmodSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';

import { applyMutation, contentInUse } from '@thirdlight/commands';
import type {
  CommandError,
  CommandState,
  ContentDocument,
  HistoryEntry,
  HistoryState,
  MutationResult,
  MutationSuccess,
  SceneDocument,
} from '@thirdlight/commands';
import type {
  Manifest,
  SceneV3,
  SceneV4,
  ContentCatalogV3,
  ContentCatalogV4,
  ModelErrorV3,
} from '@thirdlight/project-model';
import {
  composeV4,
  INSTANCE_FLOATS,
  normalizeManifest,
  parseDocumentBytes,
  PROJECT_SCHEMA_VERSION,
  isUpgradedProjectSchemaVersion,
  validateProjectV3,
} from '@thirdlight/project-model';

import { ID_RE, validateEnvelope, type RetryRecord } from './envelope';
import {
  authoritativeBytes,
  DEFAULT_DEVICE_SPACE_RESERVE_BYTES,
  DEFAULT_MAX_SOURCE_BYTES_PER_PROJECT,
  defaultFreeSpace,
  publishBlob,
  readSourceBlob,
  verifyConvertedOriginal,
  verifyImported,
  verifyReferencedBlob,
  type ContentContext,
} from './content-store';
import { planPlacement, syncAssetFiles, type ConvertedLike } from './asset-files';
import { upgradeAssetsToFiles } from './upgrade-assets';
import { contentCtx, contentOps } from './service-content';
import { checkScriptLibraryDraft, discardScriptLibraryStage, libraryStageFacts, prepareBehaviorSource, prepareScriptLibraryDependents, prepareScriptLibraryStage, preparedFactsOf, projectScriptLibraryInputs, stageScriptLibraryPatch, type PrepareBehaviorSourceRequest } from './behavior';
import {
  externalChangeUnreadable,
  externalChangeUnresolved,
  fieldTypeError,
  fieldValueType,
  contentQuotaExceeded,
  blobMissing,
  invalidRequest,
  projectExistsInvalid,
  projectNotFound,
  projectUnavailable,
  pointerSegment,
  requestIdReused,
  workspaceClosed as workspaceClosedError,
  writeFailed,
  type LoadDetail,
} from './errors';
import { requestDigest, sha256Hex } from './digest';
import {
  defaultOps,
  listLeftoverTemps,
  writeAtomic,
  type WriteOps,
} from './write';
import { deepFreeze } from './isolate';
import {
  defaultProjectFilesV4,
  isV4Layout,
  listLeftoverTempsV4,
  loadV4,
  projectFilesFromV3,
  writeTransaction,
  type ProjectFilesV4,
  type V4State,
} from './store-v4';
import { changedFiles, checkExternalV4, detectExternalChangeV4, publishV4, setPendingUnreadableV4 } from './session-v4';
import {
  DEFAULT_PROCESS_MARKER,
  DEFAULT_PROC_ROOT,
  evaluateLiveness,
  newSelfIdentity,
  readOwnershipRecord,
  utcSecond,
  utcStamp,
} from './ownership';
import {
  acceptExternal,
  discardExternal,
  ensureSession,
  ENGINE_VERSION,
  loadEnvelopeV3,
  pendingInfo,
  releaseProject,
  releaseOnShutdown,
  loadManifest,
  projectBaseDir,
  refreshRegistration,
  resolveContained,
  serveQuery,
  takeover,
  validateAnyManifest,
  type Core,
  type ProjectSession,
  verifyChildDir,
} from './session';
import type {
  AcceptResult,
  CreateProjectResult,
  DiscardResult,
  QueryResult,
  ReleaseResult,
  ScanEntry,
  ScanReport,
  TakeoverResult,
  ProjectSource,
  WorkspaceService,
  WorkspaceServiceConfig,
} from './types';

/** The envelope of a storage v3 project (read and upgraded on open). */
const SCENE_REL = join('scenes', 'main.json');
/** A migration-copy marker an earlier version may have left (reported by the scan, never completed). */
const MIGRATION_MARKER_REL = join('.thirdlight', 'migration.json');

/**
 * The scripts whose source names `id` as a string literal
 * (`'crate'`, `"crate"`, `` `crate` ``): each published behavior's source
 * container (a visual script's generated source too) and each script
 * library's files. A reference only code can hold, so a delete is refused
 * while it is there. An unreadable source is skipped (the delete then rests on
 * the model's references alone).
 */
function scriptsNaming(read: (digest: string) => Uint8Array | null, content: ContentDocument, id: string): { path: string; document: string }[] {
  const escaped = id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  // The quote may be escaped inside the container's JSON text (`\"crate\"`).
  const literal = new RegExp(`['"\`]${escaped}\\\\?['"\`]`);
  const out: { path: string; document: string }[] = [];
  const decoder = new TextDecoder();
  content.behaviors.forEach((b, i) => {
    const digest = b.source?.sourceDigest;
    if (digest === undefined) return;
    const bytes = read(digest);
    if (bytes !== null && literal.test(decoder.decode(bytes))) out.push({ document: 'content', path: `/behaviors/${i} (script ${b.behaviorId})` });
  });
  const libraries = (content as { scriptLibraries?: { libraryId: string; files: { path: string; text: string }[] }[] }).scriptLibraries ?? [];
  libraries.forEach((lib, i) => {
    lib.files.forEach((f, j) => {
      if (literal.test(f.text)) out.push({ document: 'content', path: `/scriptLibraries/${i}/files/${j} (library ${lib.libraryId}, ${f.path})` });
    });
  });
  return out;
}

/**
 * The bytes a successful publication references (the new version's
 * digest/length and where they are), or null for a non-publication or a
 * history op. Commit-time verification uses it. Undo and redo restore a
 * version recorded (and verified) earlier: the workspace puts back the file
 * bytes it holds, a file changed since is reported by the file check, and
 * reads refuse it, but it never blocks the undo.
 */
function publishedBlobRef(
  result: MutationSuccess,
): { digest: string; byteLength: number; sourcePath?: string; convertedFrom?: ConvertedLike } | null {
  const ch = result.change;
  if (ch.type === 'publishBehavior') {
    // A source publication references the immutable container blob
    // exactly like an asset version does.
    const src = ch.next === null ? null : ch.next.source;
    if (src === null) return null;
    return { digest: src.sourceDigest, byteLength: src.sourceByteLength };
  }
  if (ch.type !== 'publishAsset' || ch.next === null) return null;
  if (result.op === 'undo' || result.op === 'redo') return null;
  const last = ch.next.versions[ch.next.versions.length - 1];
  if (last === undefined) return null;
  const sourcePath = (last as { sourcePath?: string }).sourcePath;
  const convertedFrom = (last as { convertedFrom?: ConvertedLike }).convertedFrom;
  return {
    digest: last.sourceDigest,
    byteLength: last.sourceByteLength,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
    ...(convertedFrom !== undefined ? { convertedFrom } : {}),
  };
}

export function openWorkspaceService(config: WorkspaceServiceConfig): WorkspaceService {
  const root = config.root;
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('workspace config: root must be a non-empty string (the configured data root)');
  }
  // A configured identity must be well-formed (the record format is
  // strict: tb- + 32 hex). A malformed identity would otherwise emit
  // records the service itself cannot parse (self-verify failure).
  if (
    config.backendId !== undefined &&
    !/^tb-[0-9a-f]{32}$/.test(config.backendId)
  ) {
    throw new Error(
      'workspace config: backendId must be tb- + 32 lowercase hex characters (the record format is strict)',
    );
  }
  // The service owns its root layout (best effort at open; a read-only
  // mount with an existing layout is fine).
  try {
    mkdirSync(join(root, 'projects'), { recursive: true, mode: 0o755 });
  } catch {
    // a pre-existing layout (or a read-only root) is not an open failure
  }
  const core: Core = {
    root,
    projectsRoot: join(root, 'projects'),
    registry: loadRegistry(root),
    self: newSelfIdentity(config.pid ?? process.pid, config.backendId),
    processMarker: config.processMarker ?? DEFAULT_PROCESS_MARKER,
    procRoot: config.procRoot ?? DEFAULT_PROC_ROOT,
    stamp: config.stamp ?? utcStamp,
    utcNow: config.utcNow ?? (() => utcSecond()),
    ops: config.ops ?? defaultOps,
    sessions: new Map(),
    content: {
      maxSourceBytesPerProject: config.maxSourceBytesPerProject ?? DEFAULT_MAX_SOURCE_BYTES_PER_PROJECT,
      deviceSpaceReserveBytes: config.deviceSpaceReserveBytes ?? DEFAULT_DEVICE_SPACE_RESERVE_BYTES,
      freeSpaceBytes: config.freeSpaceBytes ?? (() => defaultFreeSpace(root)),
      now: config.now ?? (() => Date.now()),
      ...(config.assetInspector !== undefined ? { assetInspector: config.assetInspector } : {}),
      ...(config.inspectTimeoutMs !== undefined ? { inspectTimeoutMs: config.inspectTimeoutMs } : {}),
      // The injected behavior-source compiler (dependencies.md
      // `backend` constructs it; the workspace holds only its type).
      ...(config.behaviorCompiler !== undefined ? { behaviorCompiler: config.behaviorCompiler } : {}),
    },
  };
  return buildService(core);
}

function buildService(core: Core): WorkspaceService {
  const self = core.self;
  // The startup scan (run once at open, before serving)
  // with its deterministic completion; its report is `lastScan`.
  const lastScanRef: [ScanReport] = [runScan(core)];

  // ---- mutation pipeline ------------------------------

  /**
   * Public `runCommand`: the result may alias
   * authoritative state — the fresh ack shares its `change`/`history`
   * containers with the durable record and the history entries, and a
   * replayed ack shares the persisted record's nested objects — so the
   * returned value is deep-frozen at the boundary. The single mutation
   * path stays `runCommand` itself; the freeze only removes every OTHER
   * path a caller could take through a returned reference.
   */
  function runCommand(request: unknown): MutationResult {
    return deepFreeze(runCommandImpl(request));
  }

  function runCommandImpl(request: unknown): MutationResult {
    // Step 0 — canonicalizability gate: the request
    // must be a JSON value under the digest's canonical rules (the same
    // canonical-bytes semantics the model's serialization
    // relies on: plain objects/arrays, finite numbers, strings, booleans,
    // null; no undefined/BigInt/Symbol/function, no exotic objects such as
    // Date, no cycles). Non-canonicalizable requests fail here with a
    // structured validation error BEFORE project resolution, deduplication
    // and any record construction or write: a `null` digest in a record
    // would poison the envelope (its own loader rejects it with
    // `retry_records_invalid` at reopen).
    const issue = canonicalIssue(request);
    if (issue !== null) {
      return failRequest(
        request,
        invalidRequest(
          issue.path,
          issue.value,
          issue.expected,
          issue.message,
          'request values must be JSON values: the digest\'s canonical bytes must exist (drop the offending field or replace it with a JSON value)',
        ),
      );
    }
    // Step 1 — resolve the project. The request envelope's projectId is the
    // only addressing; a syntactically invalid ID cannot exist
    // inside the root, so it is an envelope-level schema failure.
    const pid = envelopeProjectId(request);
    if (pid === null) return failRequest(request, invalidRequestFor(request));
    const o = ensureSession(core, pid);
    if (o.kind === 'not-found') return failRequest(request, projectNotFound(pid));
    if (o.kind === 'unavailable') {
      return failRequest(request, projectUnavailable(o.reason, o.holder, o.errors ?? []));
    }
    if (o.kind === 'released') return failRequest(request, workspaceClosedError());
    const s = o.session;

    // Step 2 — deduplication BEFORE any revision check (a retried request carries its ORIGINAL expectedRevision, which is
    // stale by definition after the original application).
    const rid = envelopeRequestId(request);
    const D = requestDigest(request);
    // Step 0's gate guarantees the canonical bytes exist, so the
    // digest is non-null. A null here would mean the gate was bypassed:
    // fail closed — a null digest must never reach a record.
    if (D === null) {
      return failRequest(
        request,
        invalidRequest(
          '',
          undefined,
          'SHA-256 hex digest of the canonical request bytes',
          'the request digest must be computable: the request must be a JSON value (the canonicalizability gate)',
        ),
      );
    }
    if (rid !== null && s.recordMap.has(rid)) {
      const rec = s.recordMap.get(rid)!;
      if (rec.digest === D) {
        // Identical retry: replay the recorded result (a pure read of the
        // record map — served even while writes are paused).
        // No revision is consumed, no state changes, no write.
        return { ...(rec.result as object), duplicated: true } as MutationResult;
      }
      // Same requestId, different content (or a non-canonicalizable value).
      return failRequest(request, requestIdReused(s.revision));
    }

    // Step 3 — pause check.
    if (s.pendingChange !== null) {
      if (s.pendingChange.snapshotState === 'unreadable') {
        // The on-disk bytes are unknown (a non-ENOENT read failure
        // paused the project): the same error stands for every
        // mutation while the state is unreadable.
        return failRequest(request, externalChangeUnreadable(pid));
      }
      // A readable pending state (a durable or failed snapshot): the
      // payload carries the real `snapshotState` (the snapshot failure is
      // reported, not swallowed).
      return failRequest(request, externalChangeUnresolved({
        ...pendingInfo(s.pendingChange),
        snapshotState: s.pendingChange.snapshotState,
      }));
    }

    // Steps 4–9 — a v4 project (one file per scene).
    if (s.v4 === null || s.v4 === undefined) {
      return failRequest(request, projectUnavailable(s.blocked?.reason ?? 'envelope_invalid', null, s.blocked?.errors ?? []));
    }
    return runCommandV4(s, request, D);
  }

  /**
   * Steps 4–9 for a v4 project. The command runs on the one
   * scene it touches (found from its entity ids, or `args.sceneId` for a
   * create), with the other scenes' ids reserved; the resulting whole project
   * is checked against the cross-scene rules; only the changed files are
   * written (one `W`, or a journaled transaction for several).
   */
  function runCommandV4(s: ProjectSession, request: unknown, D: string): MutationResult {
    const state = s.v4 as V4State;
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
    const carrier = state.scenes.get(carrierId) as SceneV4;
    if (op === 'deleteScene') {
      const doomed = state.scenes.get(String(args['sceneId']));
      if (doomed !== undefined && doomed.entities.length > 0) {
        return failRequest(request, {
          code: 'field_value',
          cls: 'validation',
          path: '/args/sceneId',
          found: args['sceneId'],
          expected: 'an empty scene',
          message: `scene "${String(args['sceneId'])}" still holds ${doomed.entities.length} entities; delete them (or move them out) first`,
        } as unknown as CommandError);
      }
    }
    // An asset or prefab a script names as a string literal (`ctx.spawn("crate")`) is in use too.
    if ((op === 'deleteAsset' || op === 'deletePrefab') && typeof args[op === 'deleteAsset' ? 'assetId' : 'prefabId'] === 'string') {
      const id = args[op === 'deleteAsset' ? 'assetId' : 'prefabId'] as string;
      const named = scriptsNaming((digest) => {
        const r = readSourceBlob(core, contentCtx(s), { digest });
        return r.ok ? r.bytes : null;
      }, state.content as unknown as ContentDocument, id);
      if (named.length > 0) return failRequest(request, contentInUse(op === 'deleteAsset' ? 'asset' : 'prefab', id, named));
    }
    const reserved = new Set<string>();
    for (const [id, sc] of state.scenes) if (id !== carrierId) for (const e of sc.entities) reserved.add(e.id);
    const commandState: CommandState<SceneDocument> = {
      scene: { ...carrier, revision: state.revision } as SceneDocument,
      content: state.content as unknown as ContentDocument,
      history: s.history,
      reservedIds: reserved,
    };
    if (core.content.behaviorCompiler !== undefined) commandState.behaviorPreparerRegistered = true;
    if (s.preparedSources.size > 0) commandState.preparedBehaviorSources = preparedFactsOf(s.preparedSources);
    // The staged library edit sets (a commit reads only these).
    const stages = libraryStageFacts(s);
    if (stages !== undefined) commandState.scriptLibraryStages = stages;
    // Bytes uploaded to the backend name no file yet: the workspace chooses
    // where in the game folder they go, and the command records that path.
    const placement = op === 'publishAsset' ? planPlacement(core, contentCtx(s), args, state.content, (digest) => {
      const r = readSourceBlob(core, contentCtx(s), { digest });
      return r.ok ? r.bytes : null;
    }) : null;
    if (placement !== null) pureRequest = { ...(pureRequest as object), args: placement.args };
    const outcome = applyMutation(commandState, pureRequest);
    if (!outcome.ok) return outcome.result;
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
    const ref = publishedBlobRef(outcome.result);
    if (ref !== null) {
      // A converted version: its file first (the original), then what the importer made from it.
      if (ref.convertedFrom !== undefined) {
        const o = verifyConvertedOriginal(contentCtx(s), ref.convertedFrom);
        if (!o.ok) return refuse(o.error);
      }
      const v = ref.convertedFrom !== undefined ? verifyImported(contentCtx(s), ref.convertedFrom, ref.digest) : verifyReferencedBlob(contentCtx(s), ref.digest, ref.byteLength, ref.sourcePath);
      if (!v.ok) return refuse(v.error);
      const used = authoritativeBytes(s.dir);
      if (used > core.content.maxSourceBytesPerProject) {
        return refuse(contentQuotaExceeded('project_quota', used, core.content.maxSourceBytesPerProject, 0));
      }
    }
    const resultScene = outcome.state.scene as unknown as SceneV4;
    for (const e of resultScene.entities) {
      const inst = e.components.instances;
      if (inst === undefined) continue;
      const before = carrier.entities.find((x) => x.id === e.id)?.components.instances;
      if (before !== undefined && before.buffer === inst.buffer && before.count === inst.count) continue;
      const v = verifyReferencedBlob(contentCtx(s), inst.buffer, inst.count * INSTANCE_FLOATS * 4);
      if (!v.ok) return refuse(v.error);
    }

    // The whole resulting project: scenes (the index may have changed) and content.
    const newRevision = outcome.result.revision;
    const nextContent = (outcome.state.content ?? state.content) as unknown as ContentCatalogV4;
    const nextScenes = new Map<string, SceneV4>();
    for (const entry of nextContent.scenes) {
      if (entry.sceneId === carrierId) nextScenes.set(entry.sceneId, { ...resultScene, sceneId: carrierId });
      else nextScenes.set(entry.sceneId, state.scenes.get(entry.sceneId) ?? { schemaVersion: 4, sceneId: entry.sceneId, revision: newRevision, entities: [] });
    }
    const errors: ModelErrorV3[] = [];
    composeV4([...nextScenes.values()], nextContent, errors, newRevision);
    if (errors.length > 0 && (op === 'deleteAsset' || op === 'deletePrefab')) {
      // What no longer resolves in the other scenes names it.
      return refuse(contentInUse(op === 'deleteAsset' ? 'asset' : 'prefab', String(args[op === 'deleteAsset' ? 'assetId' : 'prefabId']), errors as unknown as { path?: string; document?: string; sceneId?: string }[]));
    }
    if (errors.length > 0) {
      const first = errors[0] as ModelErrorV3;
      return refuse({
        code: first.code,
        cls: 'validation',
        detailDocument: 'project',
        details: errors.slice(0, 10),
        detailCount: errors.length,
        message: `the resulting project fails a rule across scenes: ${first.message}`,
        hint: 'fix the request (ids are unique across scenes; the start scenes hold the camera and the player)',
      } as unknown as CommandError);
    }
    // The acknowledgement names the edited scene (the editor
    // files new entities under it); a scene-index change names none.
    // The record stores that acknowledgement, so a replay carries it.
    const ack: MutationSuccess = outcome.result.change.type !== 'setSceneIndex' ? { ...outcome.result, sceneId: carrierId } : outcome.result;
    const record: RetryRecord = { requestId: envelopeRequestId(request)!, digest: D, appliedRevision: newRevision, result: ack };
    const plan = changedFiles(s.projectId, state, { content: nextContent, scenes: nextScenes, revision: newRevision }, record);
    const res = writeTransaction(core.ops, s.dir, s.thirdlightDir, s.projectId, state.files, plan.writes);
    const nextState: V4State = { manifest: state.manifest, content: nextContent, scenes: nextScenes, revision: newRevision, files: plan.files, fileRecords: plan.fileRecords };
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
      publishV4(s, nextState);
      s.history = outcome.state.history;
      return failRequest(request, writeFailed('new-undurable', res.failed.errno));
    }
    publishV4(s, nextState);
    s.history = outcome.state.history;
    // A committed stage is done (committing it again is refused).
    if (op === 'commitScriptLibraryStage' && typeof args['stageId'] === 'string') s.libraryStages?.delete(args['stageId']);
    // The game folder follows what the command did to an asset: its sidecar, a delete, a move, an undone replace.
    const fileProblems = syncAssetFiles(core, contentCtx(s), outcome.result.change, nextContent);
    if (fileProblems.length > 0) s.fileProblems = [...(s.fileProblems ?? []), ...fileProblems].slice(-32);
    return ack;
  }

  // ---- queries --------------------------------------------------------------

  /** Public `query`: results expose the published scene entities,
   * the manifest, the pause state's error details and the error payload
   * by reference — deep-freeze at the boundary. */
  function query(request: unknown): QueryResult {
    return deepFreeze(queryImpl(request));
  }

  function queryImpl(request: unknown): QueryResult {
    const env = validateQueryRequest(request);
    if (!env.ok) {
      return {
        ok: false,
        op: echoOp(request),
        projectId: echoProjectId(request),
        error: env.error,
      };
    }
    return serveQuery(core, env.op, env.projectId, env.args);
  }

  // ---- operator operations --------------------------------

  /** Public `createProject`: operator results carry error payloads
   * (and `details`) that may alias loaded/validation data. */
  function createProject(projectId: string, name: string): CreateProjectResult {
    return deepFreeze(createProjectImpl(projectId, name));
  }

  function createProjectImpl(projectId: string, name: string): CreateProjectResult {
    if (typeof projectId !== 'string' || projectId.length === 0) {
      return { ok: false, error: fieldTypeError('/projectId', projectId, 'string') };
    }
    if (!ID_RE.test(projectId)) {
      return {
        ok: false,
        error: fieldValueType('/projectId', projectId, 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}', 'projectId must use the project-model ID syntax'),
      };
    }
    if (typeof name !== 'string' || !validName(name)) {
      return {
        ok: false,
        error: fieldValueType('/name', typeof name === 'string' ? name : name, '1-128 chars, no control characters', 'name must be 1-128 characters without control characters'),
      };
    }
    const dir = projectBaseDir(core, projectId);
    if (core.ops.dirExists(dir)) {
      // The containment gate BEFORE any read or
      // converge (a symlinked or unresolvable directory is not a project
      // of this backend — no writes anywhere).
      if (!resolveContained(core, projectId).ok) {
        return {
          ok: false,
          error: projectExistsInvalid([
            {
              code: 'manifest_invalid',
              path: '',
              message:
                'the project directory is a symlink escape or an unresolvable path — not a project of this backend',
            },
          ]),
        };
      }
      // Existing directory: loadable ⇒ idempotent no-op; otherwise
      // project_exists_invalid with the load errors. Nothing is written.
      return convergeExisting(projectId);
    }
    // Creation write sequence (two files — explicitly not "atomic";
    // deterministic crash completion by the startup scan).
    const partial = createDirectories(dir, core.ops);
    if (partial === 'error') {
      return { ok: false, error: writeFailed('previous', undefined) };
    }
    // 'failed' = the directory (partially) exists concurrently: converge.
    if (partial !== 'failed') {
      // The v4 project files (creation write sequence):
      // project.json, the scene file, then content.json — its presence makes
      // the directory a v4 project; a crash before it leaves an interrupted
      // creation the startup scan completes deterministically.
      const built = defaultProjectFilesV4(projectId, name, core.utcNow(), ENGINE_VERSION);
      if (!built.ok) return { ok: false, error: projectExistsInvalid([]) };
      const w = writeNewProjectFiles(core, dir, built.files);
      if (w.kind === 'external') return convergeExisting(projectId);
      if (w.kind === 'failed') return { ok: false, error: writeFailed(w.onDiskState, w.errno) };
      // Claim ownership and load in memory.
      const o = ensureSession(core, projectId);
      if (o.kind === 'open') return { ok: true, created: true, revision: 0 };
      if (o.kind === 'unavailable') {
        return {
          ok: false,
          error: projectExistsInvalid(
            o.holder !== null
              ? [
                  {
                    code: o.reason,
                    path: '',
                    message: `ownership ${o.reason} during creation (holder pid ${o.holder.pid})`,
                  },
                ]
              : [],
          ),
        };
      }
      return { ok: false, error: projectExistsInvalid([]) };
    }
    return convergeExisting(projectId);
  }

  /**
   * Create a NEW project from a template/sample: the source scene and content
   * (validated as a v3 project, revision reset to 0, converted to v4 exactly
   * like the automatic upgrade) plus the bytes of every blob the content
   * references. Blobs are written first, then project.json, the scene file
   * and content.json, so a crash leaves at most an incomplete project the
   * startup scan completes or reports. An existing project id is refused.
   */
  function createProjectFrom(projectId: string, name: string, source: ProjectSource): CreateProjectResult {
    if (typeof projectId !== 'string' || !ID_RE.test(projectId)) {
      return {
        ok: false,
        error: fieldValueType('/projectId', projectId, 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}', 'projectId must use the project-model ID syntax'),
      };
    }
    if (typeof name !== 'string' || !validName(name)) {
      return { ok: false, error: fieldValueType('/name', name, '1-128 chars, no control characters', 'name must be 1-128 characters without control characters') };
    }
    const dir = projectBaseDir(core, projectId);
    if (core.ops.dirExists(dir)) {
      return { ok: false, error: invalidRequest('/projectId', projectId, 'a new project id', `project "${projectId}" already exists`) };
    }
    const manifestDoc = {
      schemaVersion: 1 as const,
      engineVersion: ENGINE_VERSION,
      id: projectId,
      name,
      createdAt: core.utcNow(),
      scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
    };
    const man = normalizeManifest(manifestDoc);
    if (!man.ok) return { ok: false, error: invalidRequest('/name', name, 'a valid manifest', 'the project manifest is invalid') };
    const scene = { ...(source.scene as Record<string, unknown>), sceneId: 'scene-main', revision: 0 };
    // A new project starts at revision 0: publication revisions reset with it.
    const sourceContent = JSON.parse(JSON.stringify(source.content ?? null)) as {
      assets?: { versions?: { publishedRevision?: number }[] }[];
      behaviors?: { publishedRevision?: number; source?: { publishedRevision?: number } | null }[];
    } | null;
    for (const a of sourceContent?.assets ?? []) for (const v of a.versions ?? []) v.publishedRevision = 0;
    for (const b of sourceContent?.behaviors ?? []) {
      b.publishedRevision = 0;
      if (b.source) b.source.publishedRevision = 0;
    }
    const project = validateProjectV3(man.normalized, scene, sourceContent);
    if (!project.ok) {
      const first = project.errors[0];
      return { ok: false, error: invalidRequest(first?.path ?? '', undefined, 'a valid v3 scene + content', `the template is not a valid project: ${first?.message ?? 'invalid'}`) };
    }
    const content = project.normalized.content as unknown as { assets: { assetId: string; versions: { version: number; sourceDigest: string; convertedFrom?: { sourceDigest: string } }[] }[]; behaviors: { source: { sourceDigest: string } | null }[] };
    const needed = new Set<string>();
    for (const a of content.assets) for (const v of a.versions) needed.add(v.convertedFrom?.sourceDigest ?? v.sourceDigest);
    for (const b of content.behaviors) if (b.source !== null) needed.add(b.source.sourceDigest);
    for (const digest of needed) {
      const bytes = source.blobs.get(digest);
      if (bytes === undefined || sha256Hex(bytes) !== digest) return { ok: false, error: blobMissing(digest, `sources/sha256/${digest}`) };
    }
    if (createDirectories(dir, core.ops) !== 'ok') return { ok: false, error: writeFailed('previous', undefined) };
    const ctx: ContentContext = { projectId, dir, thirdlightDir: join(dir, '.thirdlight'), storageVersion: 4, revision: 0, scene: null, content: null, gameFolder: core.registry.get(projectId)?.folder ?? null };
    // Behavior containers go to the blob store; the template's asset files into the game folder, each with its sidecar.
    for (const b of content.behaviors) {
      if (b.source === null) continue;
      const bytes = source.blobs.get(b.source.sourceDigest)!;
      const put = publishBlob(core, ctx, { digest: b.source.sourceDigest, byteLength: bytes.length, source: { kind: 'bytes', bytes } });
      if (!put.ok) return { ok: false, error: put.error };
    }
    const filed = upgradeAssetsToFiles(core, ctx, project.normalized.content as unknown as ContentCatalogV4, [], { readStored: (digest) => source.blobs.get(digest) ?? null, report: false });
    if (filed.report.notMoved.length > 0) {
      const first = filed.report.notMoved[0]!;
      return { ok: false, error: invalidRequest('', undefined, 'template assets written into the project folder', `asset ${first.assetId}: ${first.reason}`) };
    }
    const built = projectFilesFromV3(projectId, project.normalized.manifest, project.normalized.scene as SceneV3, filed.content as unknown as ContentCatalogV3);
    if (!built.ok) {
      return { ok: false, error: invalidRequest('', undefined, 'a valid v4 project', `the template is not a valid project: ${built.message}`) };
    }
    const w = writeNewProjectFiles(core, dir, built.files);
    if (w.kind !== 'ok') return { ok: false, error: writeFailed(w.kind === 'failed' ? w.onDiskState : 'previous', w.kind === 'failed' ? w.errno : undefined) };
    const o = ensureSession(core, projectId);
    if (o.kind !== 'open') return { ok: false, error: projectExistsInvalid([]) };
    return { ok: true, created: true, revision: 0 };
  }

  /** The existing-directory outcome of createProject (idempotency).
   * READ-ONLY: a strict manifest + envelope load
   * via the same loaders the query path uses — MINUS session creation,
   * ownership evaluation/claim, and liveness side effects. Loadable ⇒ the
   * idempotent no-op; unloadable ⇒ `project_exists_invalid` with the load
   * errors; neither outcome writes anything (no ownership/claim file is
   * created or rewritten, envelope bytes are untouched). */
  function convergeExisting(projectId: string): CreateProjectResult {
    const dir = projectBaseDir(core, projectId);
    // An existing v4 project is loadable when its files validate.
    if (isV4Layout(core.ops, dir)) {
      const l = loadV4(core.ops, dir, projectId);
      if (l.kind === 'loaded') return { ok: true, created: false, revision: l.state.revision };
      return { ok: false, error: projectExistsInvalid([...l.errors]) };
    }

    // Manifest loadability — report the actual manifest load details (a
    // garbage manifest is still an existing-invalid directory). Nothing is
    // written.
    let manifest: Manifest | null = null;
    const details: LoadDetail[] = [];
    const manPath = join(dir, 'project.json');
    if (!core.ops.fileExists(manPath)) {
      details.push({
        code: 'manifest_invalid',
        path: '/project.json',
        message: 'the manifest is missing (a concurrent creation or deletion is in flight)',
      });
    } else {
      try {
        const parsed = parseDocumentBytes(core.ops.readFile(manPath));
        if (!parsed.ok) {
          details.push({ code: parsed.error.code, path: parsed.error.path, message: parsed.error.message });
        } else {
          const v = validateAnyManifest(parsed.value);
          if (!v.ok) {
            for (const e of v.errors.slice(0, 10)) {
              details.push({ code: e.code, path: e.path, message: e.message });
            }
          } else {
            manifest = v.manifest;
          }
        }
      } catch {
        details.push({ code: 'manifest_invalid', path: '/project.json', message: 'the manifest is unreadable' });
      }
    }
    if (manifest === null) {
      if (details.length === 0) {
        details.push({
          code: 'manifest_invalid',
          path: '/project.json',
          message: 'the existing project directory is not loadable',
        });
      }
      return { ok: false, error: projectExistsInvalid(details) };
    }

    // A storage v3 project (upgraded to v4 when opened): the
    // envelope load — the same loader as the open path, without the
    // session/ownership acquisition around it (and without the upgrade).
    // Read-only probe; the caller's containment gate verified the
    // project directory (the scenes child is read here, never written).
    const l = loadEnvelopeV3(core, join(dir, 'scenes'), projectId, manifest);
    if (l.kind === 'loaded') return { ok: true, created: false, revision: l.scene.revision };
    const envDetails: LoadDetail[] =
      l.kind === 'envelope-missing'
        ? [
            {
              code: 'envelope_invalid',
              path: '',
              message:
                'the project has no content.json (an interrupted creation is completed by the startup scan, workspace.md §8.3/§10)',
              expected: 'a loadable project (content.json and its scene files)',
            },
          ]
        : [...l.errors];
    if (envDetails.length === 0) {
      envDetails.push({
        code: 'manifest_invalid',
        path: '',
        message: 'the project directory exists but is not a loadable project',
        expected: 'a loadable manifest + authoring-state envelope',
      });
    }
    return { ok: false, error: projectExistsInvalid(envDetails) };
  }

  /** Public `releaseWorkspace` (deep-frozen at the boundary). */
  function releaseWorkspace(projectId: string): ReleaseResult {
    return deepFreeze(releaseWorkspaceImpl(projectId));
  }

  function releaseWorkspaceImpl(projectId: string): ReleaseResult {
    const o = ensureSession(core, projectId, 'query');
    if (o.kind === 'not-found') return { ok: false, error: projectNotFound(projectId) };
    if (o.kind === 'released') {
      return { ok: false, error: projectUnavailable('workspace_closed', null, []) };
    }
    if (o.kind === 'unavailable') {
      return { ok: false, error: projectUnavailable(o.reason, o.holder, o.errors ?? []) };
    }
    return releaseProject(core, o.session);
  }

  /** Public `takeoverWorkspace` (deep-frozen at the boundary). */
  function takeoverWorkspace(projectId: string): TakeoverResult {
    return deepFreeze(takeover(core, projectId));
  }

  /** Public `acceptExternalState` (deep-frozen at the boundary). */
  function acceptExternalState(projectId: string): AcceptResult {
    return deepFreeze(acceptExternalStateImpl(projectId));
  }

  function acceptExternalStateImpl(projectId: string): AcceptResult {
    const o = ensureSession(core, projectId, 'query');
    if (o.kind === 'not-found') return { ok: false, error: projectNotFound(projectId) };
    if (o.kind === 'unavailable') {
      return { ok: false, error: projectUnavailable(o.reason, o.holder, o.errors ?? []) };
    }
    if (o.kind === 'released') {
      return { ok: false, error: projectUnavailable('workspace_closed', null, []) };
    }
    const s = o.session;
    if (s.mode !== 'open') {
      return {
        ok: false,
        error: projectUnavailable(
          s.blocked?.reason ?? 'envelope_invalid',
          null,
          s.blocked?.errors ?? [],
        ),
      };
    }
    return acceptExternal(core, s);
  }

  /** Public `discardExternalState` (deep-frozen at the boundary). */
  function discardExternalState(projectId: string): DiscardResult {
    return deepFreeze(discardExternalStateImpl(projectId));
  }

  function discardExternalStateImpl(projectId: string): DiscardResult {
    const o = ensureSession(core, projectId, 'query');
    if (o.kind === 'not-found') return { ok: false, error: projectNotFound(projectId) };
    if (o.kind === 'unavailable') {
      return { ok: false, error: projectUnavailable(o.reason, o.holder, o.errors ?? []) };
    }
    if (o.kind === 'released') {
      return { ok: false, error: projectUnavailable('workspace_closed', null, []) };
    }
    const s = o.session;
    if (s.mode !== 'open') {
      return {
        ok: false,
        error: projectUnavailable(
          s.blocked?.reason ?? 'envelope_invalid',
          null,
          s.blocked?.errors ?? [],
        ),
      };
    }
    return discardExternal(core, s);
  }

  // ---- content storage operations (service-content.ts) ---------------------

  const content = contentOps(core);

  /**
   * Compare an open project's files on disk with the last bytes this backend
   * wrote. A difference is an external change: it is snapshotted, validated
   * and writes pause until it is accepted or discarded — the same handling
   * the write path applies, but without waiting for a write.
   */
  function checkExternal(projectId: string): { ok: true; pending: boolean } | { ok: false } {
    const s = core.sessions.get(projectId);
    if (s === undefined || s.mode !== 'open') return { ok: false };
    if (s.pendingChange !== null) return { ok: true, pending: true };
    return checkExternalV4(core, s);
  }

  function scan(): ScanReport {
    const report = runScan(core);
    lastScanRef[0] = report;
    return report;
  }

  function dispose(): void {
    // Process-exit semantics: discard all in-memory
    // state without writing. The ownership records persist; the next
    // backend reclaims them once this process is dead.
    core.sessions.clear();
  }

  function close(): void {
    // Graceful shutdown: mark every held project released (retry records
    // kept) so the next backend claims it immediately.
    for (const s of core.sessions.values()) {
      try {
        releaseOnShutdown(core, s);
      } catch {
        // best effort — see above
      }
    }
    core.sessions.clear();
  }

  // ---- projects stored in other folders (the registry) --------------------

  const realOrNull = (p: string): string | null => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };

  /** A folder the registry may use: absolute, not overlapping the data root or another registered project. */
  function checkFolder(folder: unknown, mustExist: boolean, exceptId?: string): { ok: true; folder: string; real: string } | { ok: false; error: CommandError } {
    const bad = (message: string): { ok: false; error: CommandError } => ({ ok: false, error: invalidRequest('/folder', folder, 'an absolute folder path on the server', message) });
    if (typeof folder !== 'string' || folder.length === 0 || folder.length > 1024) return bad('folder must be an absolute path on the server');
    if (!isAbsolute(folder)) return bad('folder must be an absolute path on the server (it is resolved by the backend, not the browser)');
    const norm = normalize(folder).replace(/[/\\]+$/, '') || '/';
    if (norm.split(sep).includes('..')) return bad('folder must not contain ".."');
    let real: string | null = realOrNull(norm);
    if (real === null) {
      if (mustExist) return bad(`the folder ${norm} does not exist on the server`);
      const parent = realOrNull(dirname(norm));
      if (parent === null) return bad(`the parent folder ${dirname(norm)} does not exist on the server`);
      real = join(parent, basename(norm));
    } else {
      try {
        if (!statSync(real).isDirectory()) return bad(`${norm} is not a folder`);
      } catch {
        return bad(`${norm} is not readable`);
      }
    }
    const dataReal = realOrNull(core.root) ?? core.root;
    if (isWithin(dataReal, real) || isWithin(real, dataReal)) return bad('the folder overlaps the Thirdlight data root; projects there are managed as in-tree projects');
    for (const [id, reg] of core.registry) {
      if (id === exceptId) continue;
      const other = realOrNull(reg.folder) ?? reg.folder;
      if (isWithin(other, real) || isWithin(real, other)) return bad(`the folder overlaps the folder of project "${id}" (${reg.folder})`);
    }
    return { ok: true, folder: norm, real };
  }

  function idTaken(projectId: string): boolean {
    return core.registry.has(projectId) || core.ops.dirExists(join(core.projectsRoot, projectId));
  }

  /** Register an existing project folder (one holding `thirdlight.json`). Idempotent for the same folder. */
  function registerProject(folder: unknown): { ok: true; projectId: string; name: string; created: boolean } | { ok: false; error: CommandError } {
    const f = checkFolder(folder, true);
    if (!f.ok) {
      // Re-registering the same folder is a no-op even though it "overlaps" itself.
      if (typeof folder === 'string') {
        const real = realOrNull(normalize(folder));
        for (const [id, reg] of core.registry) {
          if (real !== null && realOrNull(reg.folder) === real) return { ok: true, projectId: id, name: id, created: false };
        }
      }
      return f;
    }
    const mk = readMarker(f.folder);
    if (!mk.ok) return { ok: false, error: invalidRequest('/folder', f.folder, `a folder holding ${MARKER_FILE}`, mk.message) };
    const id = mk.marker.projectId;
    if (idTaken(id)) return { ok: false, error: invalidRequest('/folder', id, 'an unused project id', `a project with id "${id}" already exists on this backend`) };
    const entry = resolveEntry(f.folder, id);
    if (entry.unavailable !== undefined) return { ok: false, error: invalidRequest('/folder', f.folder, 'a readable project folder', entry.unavailable) };
    const man = loadManifest(core, entry.projectDir);
    if (!man.ok) return { ok: false, error: invalidRequest('/folder', f.folder, 'a loadable project.json', `${join(entry.projectDir, 'project.json')} is missing or invalid`) };
    if (man.manifest.id !== id) return { ok: false, error: invalidRequest('/folder', man.manifest.id, id, `project.json names project "${man.manifest.id}" but ${MARKER_FILE} names "${id}"`) };
    core.registry.set(id, entry);
    try {
      saveRegistry(core.root, core.registry);
    } catch {
      core.registry.delete(id);
      return { ok: false, error: writeFailed('previous', undefined) };
    }
    return { ok: true, projectId: id, name: mk.marker.name, created: true };
  }

  /**
   * Create a new project in a folder: `<folder>/thirdlight.json` (the marker)
   * and `<folder>/thirdlight/` (the project files + a .gitignore for
   * `.thirdlight/`), then register it. Empty, or from a template source.
   */
  function createProjectInFolder(
    folder: unknown,
    projectId: string,
    name: string,
    opts: { engine?: EnginePin; source?: ProjectSource } = {},
  ): CreateProjectResult {
    if (typeof projectId !== 'string' || !ID_RE.test(projectId)) {
      return { ok: false, error: fieldValueType('/projectId', projectId, 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}', 'projectId must use the project-model ID syntax') };
    }
    if (idTaken(projectId)) return { ok: false, error: invalidRequest('/projectId', projectId, 'a new project id', `project "${projectId}" already exists`) };
    const f = checkFolder(folder, false);
    if (!f.ok) return f;
    if (core.ops.fileExists(join(f.folder, MARKER_FILE))) {
      return { ok: false, error: invalidRequest('/folder', f.folder, `a folder without ${MARKER_FILE}`, `${f.folder} already holds a Thirdlight project; open it instead`) };
    }
    const projectDir = join(f.folder, DEFAULT_PROJECT_SUBDIR);
    if (core.ops.dirExists(projectDir)) {
      return { ok: false, error: invalidRequest('/folder', projectDir, 'no existing thirdlight/ subfolder', `${projectDir} already exists`) };
    }
    try {
      mkdirSync(f.folder, { recursive: true, mode: 0o755 });
    } catch {
      return { ok: false, error: writeFailed('previous', undefined) };
    }
    const realFolder = realOrNull(f.folder) ?? f.real;
    core.registry.set(projectId, { folder: f.folder, projectDir, realDir: join(realFolder, DEFAULT_PROJECT_SUBDIR) });
    const created = opts.source !== undefined ? createProjectFrom(projectId, name, opts.source) : createProjectImpl(projectId, name);
    if (!created.ok) {
      core.registry.delete(projectId);
      return created;
    }
    try {
      writeSmallFileAtomic(join(projectDir, '.gitignore'), new TextEncoder().encode(PROJECT_GITIGNORE));
      const marker: ProjectMarker = { thirdlightProject: 1, projectId, name, projectDir: DEFAULT_PROJECT_SUBDIR, ...(opts.engine !== undefined ? { engine: opts.engine } : {}) };
      writeSmallFileAtomic(join(f.folder, MARKER_FILE), markerBytes(marker));
      saveRegistry(core.root, core.registry);
    } catch {
      core.registry.delete(projectId);
      return { ok: false, error: writeFailed('previous', undefined) };
    }
    return deepFreeze(created);
  }

  /** Forget a registered project (its files are never touched). */
  function unregisterProject(projectId: string): { ok: true; folder: string } | { ok: false; error: CommandError } {
    const reg = core.registry.get(projectId);
    if (reg === undefined) {
      return { ok: false, error: invalidRequest('/projectId', projectId, 'a registered (out-of-tree) project', `project "${projectId}" is not a registered folder project`) };
    }
    const s = core.sessions.get(projectId);
    if (s !== undefined) {
      try {
        releaseOnShutdown(core, s);
      } catch {
        // best effort: the ownership record is released by the next claim anyway
      }
      core.sessions.delete(projectId);
    }
    core.registry.delete(projectId);
    try {
      saveRegistry(core.root, core.registry);
    } catch {
      core.registry.set(projectId, reg);
      return { ok: false, error: writeFailed('previous', undefined) };
    }
    return { ok: true, folder: reg.folder };
  }

  /** Which registered project a folder (or anything inside it) belongs to. */
  function resolveFolder(path: unknown):
    | { ok: true; projectId: string; folder: string }
    | { ok: false; reason: 'invalid' | 'no_marker' | 'not_registered'; message: string; markerProjectId?: string; folder?: string } {
    if (typeof path !== 'string' || !isAbsolute(path)) return { ok: false, reason: 'invalid', message: 'path must be an absolute path on the server' };
    const folder = findMarkerFolder(path);
    if (folder === null) return { ok: false, reason: 'no_marker', message: `no ${MARKER_FILE} in ${path} or any parent folder` };
    const real = realOrNull(folder);
    for (const [id, reg] of core.registry) {
      if (real !== null && realOrNull(reg.folder) === real) return { ok: true, projectId: id, folder: reg.folder };
    }
    const mk = readMarker(folder);
    return {
      ok: false,
      reason: 'not_registered',
      folder,
      ...(mk.ok ? { markerProjectId: mk.marker.projectId } : {}),
      message: `${join(folder, MARKER_FILE)} is not registered with this backend`,
    };
  }

  function registeredProjects(): Array<{ projectId: string; folder: string; projectDir: string; unavailable?: string }> {
    return [...core.registry].map(([projectId, r]) => ({ projectId, folder: r.folder, projectDir: r.projectDir, ...(r.unavailable !== undefined ? { unavailable: r.unavailable } : {}) }));
  }

  const prepareBehaviorSourceOp = (projectId: string, request: PrepareBehaviorSourceRequest) =>
    prepareBehaviorSource(core, projectId, request);
  // Compile a library's dependents for the set a setScriptLibrary will commit.
  const prepareScriptLibraryDependentsOp = (projectId: string, patch: import('@thirdlight/project-model').ScriptLibraryPatch) =>
    prepareScriptLibraryDependents(core, projectId, patch);

  return {
    backendId: self.backendId,
    runCommand,
    query,
    createProject,
    releaseWorkspace,
    takeoverWorkspace,
    acceptExternalState,
    discardExternalState,
    ...content,
    prepareBehaviorSource: prepareBehaviorSourceOp,
    prepareScriptLibraryDependents: prepareScriptLibraryDependentsOp,
    checkScriptLibraryDraft: (projectId: string, draft: { libraryId: string; files: { path: string; text: string }[] }) => checkScriptLibraryDraft(core, projectId, draft),
    // Staged library edits.
    stageScriptLibraryPatch: (projectId: string, request: { stageId?: string; patch: import('./behavior').StagedLibraryPatch }) => stageScriptLibraryPatch(core, projectId, request),
    discardScriptLibraryStage: (projectId: string, stageId: string) => discardScriptLibraryStage(core, projectId, stageId),
    prepareScriptLibraryStage: (projectId: string, stageId: string) => prepareScriptLibraryStage(core, projectId, stageId),
    scriptLibraryInputs: (projectId: string) => projectScriptLibraryInputs(core, projectId),
    scan,
    dispose,
    close,
    checkExternal,
    createProjectFrom,
    registerProject,
    createProjectInFolder,
    unregisterProject,
    resolveFolder,
    registeredProjects,
    get lastScan() {
      return lastScanRef[0];
    },
  } as WorkspaceService;
}

// ---- scan implementation ------------------------------------------

function runScan(core: Core): ScanReport {
  // The scan-log cap bounds the LOG, not the work —
  // scanEntry must visit EVERY entry (the deterministic creation completion
  // and the corruption/stale reporting run on all of them); only the
  // report's entries are capped at 100. `total` counts all visited,
  // `truncated` means "more than 100 entries visited".
  const entries: ScanEntry[] = [];
  let total = 0;
  const names = new Set<string>();
  if (core.ops.dirExists(core.projectsRoot)) {
    for (const name of core.ops.listDir(core.projectsRoot)) names.add(name);
  }
  // Registered projects (folders outside the data root) are scanned too.
  for (const id of core.registry.keys()) names.add(id);
  for (const name of [...names].sort()) {
    total += 1;
    const entry = scanEntry(core, name);
    if (entries.length < 100) entries.push(entry);
  }
  // The report is also published through the `lastScan` getter and
  // `scan()` — freeze it at construction (single site for both).
  return deepFreeze({ entries, total, truncated: total > entries.length });
}

/**
 * One scan entry. Read-only except the deterministic creation completion;
 * claims no ownership; leftover temps are reported, NOT cleaned.
 */
function scanEntry(core: Core, name: string): ScanEntry {
  const entry: ScanEntry = { projectId: name, kind: 'orphan' };
  const reg = refreshRegistration(core, name);
  if (reg !== undefined) {
    entry.folder = reg.folder;
    if (reg.unavailable !== undefined) {
      entry.kind = 'project';
      entry.loadable = false;
      entry.code = 'folder_unavailable';
      entry.note = reg.unavailable.slice(0, 256);
      return entry;
    }
  }
  const dir = projectBaseDir(core, name);
  if (!core.ops.dirExists(dir)) {
    entry.note = 'directory absent (vanished during the scan)';
    return entry;
  }
  // The containment gate BEFORE any read or write
  // through the entry (the creation completion write included) — a symlinked
  // or unresolvable project directory is not a project of this backend:
  // reported as an orphan, not completed, not modified.
  if (!resolveContained(core, name).ok) {
    entry.kind = 'orphan';
    entry.note =
      'directory is not a contained project of this backend (symlink escape or missing path) — not completed, not modified';
    return entry;
  }
  // Leftover temps — reported, not cleaned.
  const temps = listLeftoverTemps(join(dir, 'scenes'), 'main.json', core.ops);
  // Storage v4: also the temps of content.json / project.json, every scene file and the journal.
  const tempsV4 = listLeftoverTempsV4(core.ops, dir, join(dir, 'scenes'), join(dir, '.thirdlight')).filter((rel) => !rel.startsWith('scenes/.main.json.tmp-'));
  if (temps.length + tempsV4.length > 0) entry.leftoverTemps = temps.length + tempsV4.length;

  // Ownership: a stale (dead-pid) record is reported; no action is taken
  // (a live record means another backend is working: untouched).
  // The read keeps the absent/unreadable/record
  // distinction — an UNREADABLE record is unknown, never absent, and
  // never proven dead: no `staleOwnership` flag (only a parseable owned
  // record with a proven-dead pid is reported; the scan claims nothing).
  const recRead = readOwnershipRecord(join(dir, '.thirdlight'), core.ops);
  const rec = recRead.kind === 'record' ? recRead.record : null;
  let stale = false;
  if (rec !== null && rec.state === 'owned') {
    if (evaluateLiveness(rec.pid, rec.openedAt, core.procRoot, core.processMarker) === 'dead') {
      stale = true;
    }
  }
  if (stale) entry.staleOwnership = true;

  // An interrupted migration copy made by an earlier version: a
  // `.thirdlight/migration.json` marker with no project files suppresses the
  // creation completion — auto-completing would create an empty default project
  // over the copy. Checked BEFORE the manifest (a marker-only destination has
  // no manifest yet). Reported; the operator deletes the directory.
  const contentExists = isV4Layout(core.ops, dir);
  const envelopeExists = core.ops.fileExists(join(dir, SCENE_REL));
  if (!contentExists && !envelopeExists && core.ops.fileExists(join(dir, MIGRATION_MARKER_REL))) {
    entry.kind = 'project';
    entry.loadable = false;
    entry.code = 'migration_resume_required';
    entry.migration = 'resume_required';
    entry.note = stale
      ? 'interrupted migration copy left by an earlier version (the copy operators were removed); stale ownership reported; delete the directory'
      : 'interrupted migration copy left by an earlier version (the copy operators were removed) — never auto-completed; delete the directory';
    return entry;
  }

  // A v4 project (one file per scene).
  if (contentExists) {
    entry.kind = 'project';
    const l = loadV4(core.ops, dir, name);
    if (l.kind === 'loaded') {
      entry.name = l.state.manifest.name;
      entry.createdAt = l.state.manifest.createdAt;
      entry.loadable = true;
      entry.note = stale ? 'complete (v4); stale ownership reported (no action — takeover is explicit)' : 'complete (v4; opens on demand)';
    } else {
      entry.loadable = false;
      entry.code = l.reason;
      // The first problem says why (a removed game component names itself).
      const first = l.errors[0]?.message;
      entry.note = `v4 project does not load (${l.reason}${first !== undefined ? `: ${first.slice(0, 160)}` : ''}); retained until operator repair`;
    }
    return entry;
  }

  // Manifest: a v4 manifest of an interrupted creation, or
  // the v1 manifest of a storage v3 project.
  const manPath = join(dir, 'project.json');
  if (!core.ops.fileExists(manPath)) {
    entry.note = stale
      ? 'orphan (no manifest); stale ownership reported'
      : 'orphan (no loadable manifest) — reported, retained';
    return entry;
  }
  let manifest: Manifest | null = null;
  let manifestVersion: unknown = null;
  try {
    const parsed = parseDocumentBytes(core.ops.readFile(manPath));
    if (parsed.ok) {
      manifestVersion = (parsed.value as { schemaVersion?: unknown } | null)?.schemaVersion ?? null;
      const v = validateAnyManifest(parsed.value);
      if (v.ok) manifest = v.manifest;
    }
  } catch {
    // unreadable manifest
  }
  if (manifest !== null) {
    entry.name = manifest.name;
    entry.createdAt = manifest.createdAt;
  }
  if (manifest === null) {
    entry.kind = 'project';
    entry.loadable = false;
    entry.code = 'manifest_invalid';
    entry.note = stale
      ? 'corrupt manifest; stale ownership reported; retained until operator repair'
      : 'corrupt manifest; retained until operator repair';
    return entry;
  }

  if (!envelopeExists) {
    entry.kind = 'project';
    if (manifestVersion !== PROJECT_SCHEMA_VERSION && !isUpgradedProjectSchemaVersion(manifestVersion)) {
      // A v3 manifest without its envelope: a creation interrupted by an
      // earlier version (it wrote storage v3). This version writes new
      // projects as v4 only, so it is kept for the operator.
      entry.completion = 'kept';
      entry.loadable = false;
      entry.code = 'envelope_invalid';
      entry.note = stale
        ? 'interrupted creation by an earlier version (a v3 manifest without scenes/main.json; kept — delete the directory and create the project again); stale ownership reported'
        : 'interrupted creation by an earlier version (a v3 manifest without scenes/main.json; kept — delete the directory and create the project again)';
      return entry;
    }
    // The completion writes go through the scenes
    // directory — a PRESENT scenes dir that escapes the data root is kept for
    // the operator, never completed through a symlink. (With an ABSENT scenes
    // dir the write attempt fails and the state is kept.)
    if (verifyChildDir(core, name, 'scenes').kind === 'escape') {
      entry.completion = 'kept';
      entry.loadable = false;
      entry.code = 'envelope_invalid';
      entry.note = stale
        ? 'interrupted creation (kept — the scenes directory is not a contained path of this backend); stale ownership reported'
        : 'interrupted creation (kept — the scenes directory is not a contained path of this backend)';
      return entry;
    }
    // Interrupted creation: the scan's only sanctioned write — the
    // deterministic creation completion.
    const completed = completeInterruptedCreation(core, dir, name, manifest);
    entry.completion = completed ? 'completed' : 'kept';
    entry.loadable = completed;
    if (!completed) entry.code = 'envelope_invalid';
    entry.note = stale
      ? `interrupted creation (${entry.completion}); stale ownership reported`
      : `interrupted creation (${entry.completion})`;
    return entry;
  }
  // A storage v3 project: loadable when its envelope loads (it is upgraded to
  // v4 when it is opened; the scan writes nothing). A storage v1/v2 envelope
  // is reported `storage_version_unsupported`.
  entry.kind = 'project';
  let envBytes: Uint8Array | null = null;
  try {
    envBytes = core.ops.readFile(join(dir, SCENE_REL));
  } catch {
    envBytes = null;
  }
  if (envBytes === null) {
    entry.loadable = false;
    entry.code = 'envelope_invalid';
    entry.note = stale
      ? 'envelope unreadable; stale ownership reported; retained until operator repair'
      : 'envelope unreadable; retained until operator repair';
    return entry;
  }
  const env = validateEnvelope(envBytes, name);
  if (!env.ok) {
    entry.loadable = false;
    entry.code = env.reason;
    entry.note = stale
      ? `corrupt envelope (${env.reason}); stale ownership reported; retained until operator repair`
      : `corrupt envelope (${env.reason}); retained until operator repair`;
    return entry;
  }
  if (manifest.scenes[0].id !== env.scene.sceneId || manifest.id !== name) {
    entry.loadable = false;
    entry.code = 'manifest_scene_mismatch';
    entry.note = stale
      ? 'manifest/scene cross-document mismatch; stale ownership reported; retained until operator repair'
      : 'manifest/scene cross-document mismatch; retained until operator repair';
    return entry;
  }
  entry.loadable = true;
  entry.note = stale
    ? 'complete (storage v3, upgraded to v4 when opened); stale ownership reported (no action — takeover is explicit)'
    : 'complete (storage v3, upgraded to v4 when opened)';
  return entry;
}

/**
 * The deterministic creation completion of a v4 project whose creation stopped
 * after `project.json`: the missing default scene file and `content.json` —
 * a pure function of the manifest (the default project at revision 0) — are
 * written via W, content.json last. A file already present is never
 * overwritten (it was written before the crash, or by someone else); the
 * project is loadable when the resulting files load.
 */
function completeInterruptedCreation(
  core: Core,
  dir: string,
  projectId: string,
  manifest: Manifest,
): boolean {
  const built = defaultProjectFilesV4(projectId, manifest.name, manifest.createdAt, manifest.engineVersion);
  if (!built.ok) return false;
  for (const f of [built.files.scene, built.files.content]) {
    const target = join(dir, f.rel);
    if (core.ops.fileExists(target)) continue;
    const res = writeAtomic({
      dir: dirname(target),
      target,
      bytes: f.bytes as Uint8Array,
      allowedPreHashes: null, // must stay absent
      previousHash: null,
      ops: core.ops,
    });
    if (res.ok) continue;
    // Appeared concurrently: kept (never overwrite a foreign write); the load below decides.
    if (res.external) continue;
    if (res.failed && res.failed.onDiskState === 'new-undurable') continue; // on disk; durability unproven
    return false; // "previous" / unreadable: still absent — kept for the operator
  }
  return loadV4(core.ops, dir, projectId).kind === 'loaded';
}

/**
 * Write a new project's files (creation sequence, v4): `project.json`,
 * the scene file, then `content.json` — its presence makes the directory a
 * v4 project, so a crash before it leaves an interrupted creation the startup
 * scan completes. A scene/content file that already exists is an external
 * appearance (a concurrent creator).
 */
function writeNewProjectFiles(
  core: Core,
  dir: string,
  files: ProjectFilesV4,
): { kind: 'ok' } | { kind: 'external' } | { kind: 'failed'; onDiskState: 'previous' | 'new-undurable'; errno: string | undefined } {
  for (const f of [files.manifest, files.scene, files.content]) {
    const target = join(dir, f.rel);
    const res = writeAtomic({
      dir: dirname(target),
      target,
      bytes: f.bytes as Uint8Array,
      // The manifest takes no pre-write check (races are handled by the
      // reload); the scene and content files must not exist yet.
      allowedPreHashes: f === files.manifest ? [] : null,
      previousHash: null,
      ops: core.ops,
    });
    if (res.external) return { kind: 'external' };
    if (res.failed) return { kind: 'failed', onDiskState: res.failed.onDiskState, errno: res.failed.errno };
    if (res.unreadable) return { kind: 'failed', onDiskState: 'previous', errno: res.unreadable.errno };
  }
  return { kind: 'ok' };
}

// ---- request envelope helpers ----------------------------------------------------------

/** Extract the request envelope's projectId (string or null). */
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
  const cross = (path: string): { ok: false; error: CommandError } => ({
    ok: false,
    error: {
      code: 'field_value',
      cls: 'validation',
      path,
      message: 'the entities of one command must be in one scene (moving between scenes is not supported yet)',
      expected: 'entities of a single scene',
    } as unknown as CommandError,
  });
  if (op === 'undo' || op === 'redo') {
    const entry = op === 'undo' ? history.entries[history.cursor - 1] : history.entries[history.cursor];
    return { ok: true, sceneId: (entry as { sceneId?: string } | undefined)?.sceneId ?? null };
  }
  if (op === 'createEntity' || op === 'instantiatePrefab' || op === 'pasteEntities') {
    const explicit = args['sceneId'];
    if (explicit !== undefined) {
      if (typeof explicit !== 'string' || !state.scenes.has(explicit)) {
        return { ok: false, error: { code: 'reference_missing', cls: 'validation', path: '/args/sceneId', reason: 'scene', found: explicit, message: 'no such scene in this project' } as unknown as CommandError };
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
        return { ok: false, error: { code: 'reference_missing', cls: 'validation', path: '/args/sceneId', reason: 'scene', found: explicit, message: 'no such scene in this project' } as unknown as CommandError };
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
  if (op === 'publishAsset') {
    const anim = args['animation'] as { entityId?: unknown } | undefined;
    return { ok: true, sceneId: anim !== undefined ? sceneOf(anim.entityId) : null };
  }
  if ('entityId' in args) return { ok: true, sceneId: sceneOf(args['entityId']) ?? primarySceneIdV4(state) };
  return { ok: true, sceneId: null };
}

function envelopeProjectId(request: unknown): string | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return null;
  const v = (request as Record<string, unknown>)['projectId'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** A missing/unparseable projectId cannot be resolved: `invalid_request`. */
function invalidRequestFor(request: unknown): CommandError {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return invalidRequest('', jsonTypeName(request), 'object (mutation request)', 'a mutation request must be an object');
  }
  const v = (request as Record<string, unknown>)['projectId'];
  if (v === undefined) {
    return invalidRequest('/projectId', undefined, 'project-model ID syntax', "required field 'projectId' is missing");
  }
  return invalidRequest('/projectId', v, 'project-model ID syntax: [a-z0-9][a-z0-9_-]{0,63}', 'projectId must use the project-model ID syntax');
}

/** Extract the request envelope's requestId (string or null). */
function envelopeRequestId(request: unknown): string | null {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return null;
  const v = (request as Record<string, unknown>)['requestId'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The first non-canonicalizable part of the request
 * value, or null when the ENTIRE value is a JSON value under the digest's
 * canonical rules (the same canonical-bytes semantics the
 * model's canonical serialization relies on: plain objects, arrays, finite
 * numbers, strings, booleans, null). Reports the first offending field with
 * a JSON-pointer-style path (first key order, then array order).
 */
interface CanonicalIssue {
  path: string;
  value: unknown;
  expected: string;
  message: string;
}

function canonicalIssue(value: unknown): CanonicalIssue | null {
  const stack = new Set<object>();
  const walk = (v: unknown, path: string): CanonicalIssue | null => {
    if (v === null) return null;
    if (typeof v === 'string' || typeof v === 'boolean') return null;
    if (typeof v === 'number') {
      return Number.isFinite(v)
        ? null
        : {
            path,
            value: v,
            expected: 'finite number',
            message: 'non-finite number is not a JSON value',
          };
    }
    if (
      typeof v === 'undefined' ||
      typeof v === 'bigint' ||
      typeof v === 'symbol' ||
      typeof v === 'function'
    ) {
      return {
        path,
        value: v,
        expected: 'JSON value (string, number, boolean, null, array or object)',
        message: `${typeof v} is not a JSON value`,
      };
    }
    // From here on v is an object (array or non-array object).
    if (stack.has(v)) {
      return {
        path,
        value: '[circular]',
        expected: 'acyclic JSON value',
        message: 'self-referencing value is not a JSON value',
      };
    }
    if (Array.isArray(v)) {
      stack.add(v);
      for (let i = 0; i < v.length; i += 1) {
        const issue = walk(v[i], `${path}/${i}`);
        if (issue !== null) return issue;
      }
      stack.delete(v);
      return null;
    }
    const tag = Object.prototype.toString.call(v);
    if (tag !== '[object Object]') {
      // Date, Map, Set, typed arrays, … — not plain JSON objects. (The
      // digest's canonicalizer would silently fold an empty-keyed Date into
      // `{}` — bytes that disagree with the JSON wire form — so these are
      // rejected here, before any digest is computed.)
      return {
        path,
        value: tag.slice(8, -1),
        expected: 'plain object (JSON object)',
        message: `${tag.slice(8, -1)} is not a plain JSON object`,
      };
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      return {
        path,
        value: 'Object',
        expected: 'plain object (JSON object)',
        message: 'class instance is not a plain JSON object',
      };
    }
    const rec = v as Record<string, unknown>;
    stack.add(v);
    for (const k of Object.keys(rec)) {
      const issue = walk(rec[k], `${path}/${pointerSegment(k)}`);
      if (issue !== null) return issue;
    }
    stack.delete(v);
    return null;
  };
  return walk(value, '');
}

/** A failure payload with the parseable echo fields (`op` ≤ 32 chars, `projectId` when parseable, `requestId` ≤ 64 chars). */
function failRequest(request: unknown, error: CommandError): MutationResult {
  const out: {
    ok: false;
    op?: string;
    projectId?: string;
    requestId?: string;
    error: CommandError;
  } = { ok: false, error };
  if (typeof request === 'object' && request !== null && !Array.isArray(request)) {
    const req = request as Record<string, unknown>;
    const op = echoOp(req['op']);
    if (op !== undefined) out.op = op;
    if (typeof req['projectId'] === 'string') out.projectId = req['projectId'];
    const rid = req['requestId'];
    if (typeof rid === 'string' && rid.length > 0) {
      out.requestId = rid.length > 64 ? rid.slice(0, 64) : rid;
    }
  }
  return out as MutationResult;
}

function echoOp(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > 32 ? v.slice(0, 32) : v;
}

function echoProjectId(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Query envelope validation (request-level `invalid_request`). */
function validateQueryRequest(request: unknown):
  | {
      ok: true;
      op: 'queryProject' | 'queryEntity' | 'queryEntities' | 'queryAssets' | 'queryPrefabs' | 'queryBehaviors' | 'queryGameConfig' | 'queryBlocks';
      projectId: string;
      args: Record<string, unknown> | undefined;
    }
  | { ok: false; error: CommandError } {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return {
      ok: false,
      error: invalidRequest('', jsonTypeName(request), 'object (query request)', 'a query request must be an object'),
    };
  }
  const req = request as Record<string, unknown>;
  for (const k of Object.keys(req)) {
    if (!['op', 'projectId', 'args'].includes(k)) {
      return {
        ok: false,
        error: invalidRequest(`/${pointerSegment(k)}`, k, 'known fields: op, projectId, args (optional)', 'unknown field is not permitted (strict M1 request drops nothing)'),
      };
    }
  }
  const op = req['op'];
  if (
    op !== 'queryProject' &&
    op !== 'queryEntity' &&
    op !== 'queryEntities' &&
    op !== 'queryAssets' &&
    op !== 'queryPrefabs' &&
    op !== 'queryBehaviors' &&
    op !== 'queryGameConfig' &&
    op !== 'queryBlocks'
  ) {
    return {
      ok: false,
      error: invalidRequest('/op', op, 'one of: queryProject, queryEntity, queryEntities, queryAssets, queryPrefabs, queryBehaviors, queryGameConfig, queryBlocks', typeof op !== 'string' ? 'op must be a string query op' : 'op is not one of the accepted query ops'),
    };
  }
  const projectId = req['projectId'];
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return {
      ok: false,
      error: invalidRequest('/projectId', projectId, 'project-model ID syntax', 'projectId must be a non-empty string'),
    };
  }
  let args: Record<string, unknown> | undefined;
  if (req['args'] !== undefined) {
    if (typeof req['args'] !== 'object' || req['args'] === null || Array.isArray(req['args'])) {
      return {
        ok: false,
        error: invalidRequest('/args', jsonTypeName(req['args']), 'object', 'args must be an object'),
      };
    }
    args = req['args'] as Record<string, unknown>; // shape-checked above
  }
  return { ok: true, op, projectId, args };
}

function jsonTypeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** `name` 1–128 chars, no control characters. */
function validName(s: string): boolean {
  if (s.length < 1 || s.length > 128) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

/**
 * Mkdir the project, scenes, .thirdlight and
 * .thirdlight/recovery (all 0755). Returns 'ok', 'failed' (the project
 * directory already exists — a concurrent creator: converge instead), or
 * 'error' (a real I/O failure).
 */
function createDirectories(dir: string, ops: WriteOps): 'ok' | 'failed' | 'error' {
  // Step 1: the project directory itself — NON-recursive so a concurrent
  // creator's EEXIST is detected (converge instead of clobbering).
  if (ops.dirExists(dir)) return 'failed';
  try {
    mkdirSync(dir, { mode: 0o755 });
    try {
      chmodSync(dir, 0o755);
    } catch {
      // best effort
    }
  } catch (e) {
    const errno = (e as { errno?: unknown })?.errno;
    if (errno === 'EEXIST') return 'failed'; // concurrent creator
    return 'error';
  }
  // The fixed sub-layout (recursive: the parent now exists).
  for (const d of [join(dir, 'scenes'), join(dir, '.thirdlight'), join(dir, '.thirdlight', 'recovery')]) {
    if (ops.dirExists(d)) continue;
    try {
      mkdirSync(d, { recursive: true, mode: 0o755 });
      try {
        chmodSync(d, 0o755);
      } catch {
        // best effort
      }
    } catch {
      return 'error';
    }
  }
  return 'ok';
}
