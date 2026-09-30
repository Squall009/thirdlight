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
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';

import type { CommandError, MutationResult } from '@thirdlight/commands';
import type { Manifest } from '@thirdlight/project-model';
import {
  parseDocumentBytes,
  PROJECT_SCHEMA_VERSION,
  isUpgradedProjectSchemaVersion,
} from '@thirdlight/project-model';

import { ID_RE, validateEnvelope } from './envelope';
import {
  DEFAULT_DEVICE_SPACE_RESERVE_BYTES,
  defaultFreeSpace,
} from './content-store';
import { contentOps } from './service-content';
import { checkScriptLibraryDraft, discardScriptLibraryStage, prepareBehaviorSource, prepareScriptLibraryDependents, prepareScriptLibraryStage, projectScriptLibraryInputs, stageScriptLibraryPatch, type PrepareBehaviorSourceRequest } from './behavior';
import {
  externalChangeUnreadable,
  externalChangeUnresolved,
  fieldValueType,
  invalidRequest,
  projectNotFound,
  projectUnavailable,
  requestIdReused,
  workspaceClosed as workspaceClosedError,
  writeFailed,
} from './errors';
import { requestDigest } from './digest';
import { runCommandV4 } from './command-v4';
import { dropFlushes, whenFlushed } from './journal-flush';
import { completeInterruptedCreation, createProjectFrom, createProjectImpl } from './project-create';
import { canonicalIssue, echoOp, echoProjectId, envelopeProjectId, envelopeRequestId, failRequest, invalidRequestFor, validateQueryRequest } from './request-envelope';
import { defaultOps, listLeftoverTemps } from './write';
import { deepFreeze } from './isolate';
import { isV4Layout, listLeftoverTempsV4, loadV4 } from './store-v4';
import { checkExternalV4, gameRootFor } from './session-v4';
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
      deviceSpaceReserveBytes: config.deviceSpaceReserveBytes ?? DEFAULT_DEVICE_SPACE_RESERVE_BYTES,
      freeSpaceBytes: config.freeSpaceBytes ?? ((p?: string) => defaultFreeSpace(p ?? root)),
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
    return runCommandV4(core, s, request, D);
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
    return deepFreeze(createProjectImpl(core, projectId, name));
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
    // backend reclaims them once this process is dead. Journals still being
    // flushed stay on disk for the next open to replay.
    for (const s of core.sessions.values()) dropFlushes(s.thirdlightDir);
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
    const created = opts.source !== undefined ? createProjectFrom(core, projectId, name, opts.source) : createProjectImpl(core, projectId, name);
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
    flushed: whenFlushed,
    checkExternal,
    createProjectFrom: (projectId: string, name: string, source: ProjectSource) => createProjectFrom(core, projectId, name, source),
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
    const l = loadV4(core.ops, dir, name, gameRootFor(core, name, dir));
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

