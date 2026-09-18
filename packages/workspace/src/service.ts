/**
 * The workspace service — the sole command executor (dependencies.md §4.3).
 *
 * `openWorkspaceService(config)` builds a service bound to one configured
 * data root (`<root>/projects/<projectId>` — arbitrary absolute paths are
 * never accepted, charter §4). `runCommand` runs the full commands.md §6.1
 * pipeline per mutation: project resolution (1), deduplication before any
 * revision check (2), pause check (3), `applyMutation` (4–6, the pure
 * layer), the durable write (7), publish (8), acknowledge (9). The
 * pipeline is synchronous: the per-project mutation lock is the whole
 * synchronous sequence (one mutation at a time — commands.md §10).
 *
 * Acknowledgement timing (workspace.md §5.3): a success ack is returned
 * only after the durable write completed including the directory flush AND
 * the verification read, and the in-memory state is published at the same
 * point — a success ack implies the durable state already contains the
 * command's record.
 */

import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { applyMutation } from '@thirdlight/commands';
import type { CommandError, HistoryState, MutationResult } from '@thirdlight/commands';
import type { Manifest, Scene } from '@thirdlight/project-model';
import {
  normalizeScene,
  parseDocumentBytes,
  serializeCanonical,
  validateManifest,
} from '@thirdlight/project-model';

import {
  buildEnvelopeBytes,
  ID_RE,
  validateEnvelope,
  type RetryRecord,
} from './envelope';
import {
  externalChangeUnreadable,
  externalChangeUnresolved,
  fieldTypeError,
  fieldValueType,
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
  defaultScene,
  detectExternalChange,
  ensureSession,
  ENGINE_VERSION,
  loadProjectDir,
  pendingInfo,
  releaseProject,
  resolveContained,
  serveQuery,
  setPendingUnreadable,
  takeover,
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
  WorkspaceService,
  WorkspaceServiceConfig,
} from './types';

/** The M1 scene path inside a project (project-model §7.1). */
const SCENE_REL = join('scenes', 'main.json');

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
    self: newSelfIdentity(config.pid ?? process.pid, config.backendId),
    processMarker: config.processMarker ?? DEFAULT_PROCESS_MARKER,
    procRoot: config.procRoot ?? DEFAULT_PROC_ROOT,
    stamp: config.stamp ?? utcStamp,
    utcNow: config.utcNow ?? (() => utcSecond()),
    ops: config.ops ?? defaultOps,
    sessions: new Map(),
  };
  return buildService(core);
}

function buildService(core: Core): WorkspaceService {
  const self = core.self;
  // The startup scan (workspace.md §10: run once at open, before serving)
  // with its deterministic completion (§8.3); its report is `lastScan`.
  const lastScanRef: [ScanReport] = [runScan(core)];

  // ---- mutation pipeline (commands.md §6.1) ------------------------------

  /**
   * Public `runCommand` (R10, 2026-09-18 review): the result may alias
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
    // Step 0 (R11, 2026-09-18 review) — canonicalizability gate: the request
    // must be a JSON value under the digest's canonical rules (commands.md
    // §6.6 — the same canonical-bytes semantics the model's serialization
    // relies on: plain objects/arrays, finite numbers, strings, booleans,
    // null; no undefined/BigInt/Symbol/function, no exotic objects such as
    // Date, no cycles). Non-canonicalizable requests fail here with a
    // structured validation error BEFORE project resolution, deduplication
    // and any record construction or write. Previously the digest came back
    // null and the null was written into the envelope's record (the `D!`
    // site), poisoning the envelope with a `null` digest its own loader
    // rejects (`retry_records_invalid` at reopen).
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
    // only addressing (charter §4); a syntactically invalid ID cannot exist
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

    // Step 2 — deduplication BEFORE any revision check (commands.md §6.1:
    // a retried request carries its ORIGINAL expectedRevision, which is
    // stale by definition after the original application).
    const rid = envelopeRequestId(request);
    const D = requestDigest(request);
    // R11: step 0's gate guarantees the canonical bytes exist, so the
    // digest is non-null. A null here would mean the gate was bypassed:
    // fail closed — a null digest must never reach a record (that was the
    // NULL_DIGEST failure: `"digest": null` on disk).
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
        // record map — served even while writes are paused, §6.1 step 2).
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
        // paused the project): the same §11 error stands for every
        // mutation while the state is unreadable.
        return failRequest(request, externalChangeUnreadable(pid));
      }
      // A readable pending state (a durable or failed step-2 snapshot,
      // §7.2 step 2): the §11 payload carries the real `snapshotState`
      // (R3 — the snapshot failure is reported, not swallowed).
      return failRequest(request, externalChangeUnresolved({
        ...pendingInfo(s.pendingChange),
        snapshotState: s.pendingChange.snapshotState,
      }));
    }

    // Steps 4–6 — revision check, validation + pure application, no-change
    // check (the pure layer; the input state is never mutated).
    const outcome = applyMutation({ scene: s.scene!, history: s.history }, request);
    if (!outcome.ok) return outcome.result;

    // Step 7 — durability write. The new envelope carries BOTH the new
    // scene (revision+1) and the new record (one atomic replacement —
    // commands.md §7.2: no window where the revision advanced but the
    // record is missing). D is non-null (step 0's gate + step 2's check),
    // so the record's digest is always a real digest (R11: no `D!`).
    const newRecord: RetryRecord = {
      requestId: envelopeRequestId(request)!,
      digest: D,
      appliedRevision: outcome.result.revision,
      result: outcome.result,
    };
    const records = appendRecord(s.records, newRecord);
    const envBytes = buildEnvelopeBytes(pid, outcome.state.scene, records);
    const res = writeAtomic({
      dir: s.sceneDir, // R7: the VERIFIED scenes directory (no re-join)
      target: join(s.sceneDir, 'main.json'),
      bytes: envBytes,
      allowedPreHashes: [s.lastWrittenHash],
      previousHash: s.lastWrittenHash,
      ops: core.ops,
    });
    if (res.unreadable) {
      // §7.2 step 1: a non-ENOENT read failure — the on-disk bytes are
      // UNKNOWN, never absent. No snapshot is taken (nothing was read):
      // the pending change records the unknown state and the triggering
      // mutation fails external_change_unreadable (§11). No state, no
      // record, no revision change.
      setPendingUnreadable(s);
      return failRequest(request, externalChangeUnreadable(pid));
    }
    if (res.external) {
      // A foreign writer won (pre-write check or the verification read):
      // snapshot + pause (the §7.2 protocol — the step-2 snapshot is
      // taken/retried by the same detection call); the triggering command
      // fails; no state, no record, no revision change.
      const pc = detectExternalChange(core, s, res.external);
      return failRequest(request, externalChangeUnresolved(pendingInfo(pc)));
    }
    if (res.failed) {
      if (res.failed.onDiskState === 'previous') {
        // In-memory state unchanged, no record exists: retrying the same
        // request re-executes the command fresh (commands.md §7.3).
        return failRequest(request, writeFailed('previous', res.failed.errno));
      }
      // new-undurable: the rename took effect (on-disk == intended) but
      // the directory flush failed. Advance the in-memory state (with its
      // record) so the running system is self-consistent; the ack is still
      // `ok: false` — a success ack is never sent for a failed write.
      publish(s, outcome.state, records, envBytes);
      return failRequest(request, writeFailed('new-undurable', res.failed.errno));
    }

    // Step 8 — publish (only after step 7's verification passed).
    publish(s, outcome.state, records, envBytes);
    // Step 9 — acknowledge.
    return outcome.result;
  }

  /**
   * Step 8 — publish the acknowledged state atomically (the same snapshot:
   * scene, history, record map, envelope bytes + hash). In one synchronous
   * sequence there is no window in which a query could observe a
   * half-updated state (commands.md §10).
   */
  function publish(
    s: ProjectSession,
    newState: { scene: Scene; history: HistoryState },
    records: RetryRecord[],
    envBytes: Uint8Array,
  ): void {
    s.scene = newState.scene;
    s.revision = newState.scene.revision;
    s.records = records;
    const m = new Map<string, RetryRecord>();
    for (const r of records) m.set(r.requestId, r);
    s.recordMap = m;
    s.envelopeBytes = envBytes;
    s.lastWrittenHash = sha256Hex(envBytes);
    s.history = newState.history;
  }

  // ---- queries --------------------------------------------------------------

  /** Public `query` (R10): results expose the published scene entities,
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

  // ---- operator operations (workspace.md §11) --------------------------------

  /** Public `createProject` (R10): operator results carry error payloads
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
    const dir = join(core.projectsRoot, projectId);
    if (core.ops.dirExists(dir)) {
      // R7 (2026-09-18 review): the containment gate BEFORE any read or
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
      // Existing directory (§8.1): loadable ⇒ idempotent no-op; otherwise
      // project_exists_invalid with the load errors. Nothing is written.
      return convergeExisting(projectId);
    }
    // §8.3 creation write sequence (two files — explicitly not "atomic";
    // deterministic crash completion by the startup scan).
    const partial = createDirectories(dir, core.ops);
    if (partial === 'error') {
      return { ok: false, error: writeFailed('previous', undefined) };
    }
    // 'failed' = the directory (partially) exists concurrently: converge.
    if (partial !== 'failed') {
      const manifest: Manifest = {
        schemaVersion: 1,
        engineVersion: ENGINE_VERSION,
        id: projectId,
        name,
        createdAt: core.utcNow(),
        scenes: [{ id: 'scene-main', path: 'scenes/main.json' }],
      };
      const manRes = serializeCanonical(manifest);
      if (!manRes.ok) return { ok: false, error: projectExistsInvalid([]) };
      const mres = writeAtomic({
        dir,
        target: join(dir, 'project.json'),
        bytes: manRes.bytes,
        allowedPreHashes: [],
        previousHash: null,
        ops: core.ops,
      });
      if (mres.external) return convergeExisting(projectId);
      if (mres.failed) {
        return { ok: false, error: writeFailed(mres.failed.onDiskState, mres.failed.errno) };
      }
      // The initial envelope (the §15 default scene at revision 0).
      const envRes = writeAtomic({
        dir: join(dir, 'scenes'),
        target: join(dir, SCENE_REL),
        bytes: buildEnvelopeBytes(projectId, defaultScene(), []),
        allowedPreHashes: null, // must not exist
        previousHash: null,
        ops: core.ops,
      });
      if (envRes.external) return convergeExisting(projectId);
      if (envRes.failed) {
        return { ok: false, error: writeFailed(envRes.failed.onDiskState, envRes.failed.errno) };
      }
      // Claim ownership (§6.3) and load in memory.
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

  /** The existing-directory outcome of createProject (§8.1 idempotency).
   * READ-ONLY (R15, 2026-09-18 review): a strict manifest + envelope load
   * via the same loaders the query path uses — MINUS session creation,
   * ownership evaluation/claim, and liveness side effects. Loadable ⇒ the
   * idempotent no-op; unloadable ⇒ `project_exists_invalid` with the load
   * errors; neither outcome writes anything (no ownership/claim file is
   * created or rewritten, envelope bytes are untouched — §8.1: "nothing
   * written"). */
  function convergeExisting(projectId: string): CreateProjectResult {
    const dir = join(core.projectsRoot, projectId);

    // Manifest loadability — report the actual manifest load details (a
    // garbage manifest is still an existing-invalid directory, workspace.md
    // §8.1). Nothing is written.
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
          const v = validateManifest(parsed.value);
          if (!v.ok) {
            for (const e of v.errors.slice(0, 10)) {
              details.push({ code: e.code, path: e.path, message: e.message });
            }
          } else {
            manifest = v.normalized;
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

    // The §4.3 envelope load — the same loader as the query path, without
    // the session/ownership acquisition around it.
    // R15/R7: read-only probe; the caller's containment gate verified the
    // project directory (the scenes child is read here, never written).
    const l = loadProjectDir(core, join(dir, 'scenes'), projectId, manifest);
    if (l.kind === 'loaded') return { ok: true, created: false, revision: l.scene.revision };
    const envDetails: LoadDetail[] =
      l.kind === 'envelope-missing'
        ? [
            {
              code: 'envelope_invalid',
              path: '',
              message:
                'scenes/main.json is missing (an interrupted creation is completed by the startup scan, workspace.md §8.3/§10)',
              expected: 'a loadable authoring-state envelope',
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

  /** Public `releaseWorkspace` (R10). */
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

  /** Public `takeoverWorkspace` (R10). */
  function takeoverWorkspace(projectId: string): TakeoverResult {
    return deepFreeze(takeover(core, projectId));
  }

  /** Public `acceptExternalState` (R10). */
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

  /** Public `discardExternalState` (R10). */
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

  function scan(): ScanReport {
    const report = runScan(core);
    lastScanRef[0] = report;
    return report;
  }

  function dispose(): void {
    // Process-exit semantics (workspace.md §9.4): discard all in-memory
    // state without writing. The durable state is untouched; the ownership
    // records persist and become stale when the process exits (explicit
    // takeover thereafter).
    core.sessions.clear();
  }

  return {
    backendId: self.backendId,
    runCommand,
    query,
    createProject,
    releaseWorkspace,
    takeoverWorkspace,
    acceptExternalState,
    discardExternalState,
    scan,
    dispose,
    get lastScan() {
      return lastScanRef[0];
    },
  } as WorkspaceService;
}

// ---- scan implementation (workspace.md §10) ------------------------------------------

function runScan(core: Core): ScanReport {
  // R14 (2026-09-18 review): the §10 cap bounds the LOG, not the work —
  // scanEntry must visit EVERY entry (the deterministic §8.3 completion
  // and the corruption/stale reporting run on all of them); only the
  // report's entries are capped at 100. `total` counts all visited,
  // `truncated` now means "more than 100 entries visited".
  const entries: ScanEntry[] = [];
  let total = 0;
  if (core.ops.dirExists(core.projectsRoot)) {
    for (const name of core.ops.listDir(core.projectsRoot).sort()) {
      total += 1;
      const entry = scanEntry(core, name);
      if (entries.length < 100) entries.push(entry);
    }
  }
  // R10: the report is also published through the `lastScan` getter and
  // `scan()` — freeze it at construction (single site for both).
  return deepFreeze({ entries, total, truncated: total > entries.length });
}

/**
 * One scan entry. Read-only except the deterministic creation completion
 * (§8.3); claims no ownership; leftover temps are reported, NOT cleaned.
 */
function scanEntry(core: Core, name: string): ScanEntry {
  const entry: ScanEntry = { projectId: name, kind: 'orphan' };
  const dir = join(core.projectsRoot, name);
  if (!core.ops.dirExists(dir)) {
    entry.note = 'directory absent (vanished during the scan)';
    return entry;
  }
  // R7 (2026-09-18 review): the containment gate BEFORE any read or write
  // through the entry (the §8.3 completion write included) — a symlinked
  // or unresolvable project directory is not a project of this backend:
  // reported as an orphan, not completed, not modified.
  if (!resolveContained(core, name).ok) {
    entry.kind = 'orphan';
    entry.note =
      'directory is not a contained project of this backend (symlink escape or missing path) — not completed, not modified';
    return entry;
  }
  // Leftover temps — reported, not cleaned (workspace.md §10).
  const temps = listLeftoverTemps(join(dir, 'scenes'), 'main.json', core.ops);
  if (temps.length > 0) entry.leftoverTemps = temps.length;

  // Ownership: a stale (dead-pid) record is reported; no action is taken
  // (a live record means another backend is working: untouched).
  // R8a (2026-09-18 review): the read keeps the absent/unreadable/record
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

  // Manifest.
  const manPath = join(dir, 'project.json');
  if (!core.ops.fileExists(manPath)) {
    entry.note = stale
      ? 'orphan (no manifest); stale ownership reported'
      : 'orphan (no loadable manifest) — reported, retained';
    return entry;
  }
  let manifest: Manifest | null = null;
  try {
    const parsed = parseDocumentBytes(core.ops.readFile(manPath));
    if (parsed.ok) {
      const v = validateManifest(parsed.value);
      if (v.ok) manifest = v.normalized;
    }
  } catch {
    // unreadable manifest
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

  // Envelope.
  const envelopeExists = core.ops.fileExists(join(dir, SCENE_REL));
  if (!envelopeExists) {
    // R7 (2026-09-18 review): the completion write is the scan's ONLY
    // write and it goes through the scenes directory — a PRESENT scenes
    // dir that escapes the data root is kept for the operator, never
    // completed through a symlink. (An ABSENT scenes dir keeps the
    // pre-fix path: the write attempt fails and the state is kept.)
    if (verifyChildDir(core, name, 'scenes').kind === 'escape') {
      entry.kind = 'project';
      entry.completion = 'kept';
      entry.loadable = false;
      entry.code = 'envelope_invalid';
      entry.note = stale
        ? 'interrupted creation (kept — the scenes directory is not a contained path of this backend); stale ownership reported'
        : 'interrupted creation (kept — the scenes directory is not a contained path of this backend)';
      return entry;
    }
    // Interrupted creation: the scan's only sanctioned write — the
    // deterministic §8.3 completion.
    entry.kind = 'project';
    const completed = completeInterruptedCreation(core, dir, name, manifest);
    entry.completion = completed ? 'completed' : 'kept';
    entry.loadable = completed;
    if (!completed) entry.code = 'envelope_invalid';
    entry.note = stale
      ? `interrupted creation (${entry.completion}); stale ownership reported`
      : `interrupted creation (${entry.completion})`;
    return entry;
  }
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
    ? 'complete; stale ownership reported (no action — takeover is explicit)'
    : 'complete (opens on demand)';
  return entry;
}

/**
 * The deterministic §8.3 completion for a manifest without an envelope:
 * write the initial envelope — a pure function of the manifest (the
 * default scene at revision 0) — via W.
 */
function completeInterruptedCreation(
  core: Core,
  dir: string,
  projectId: string,
  manifest: Manifest,
): boolean {
  const norm = normalizeScene({ ...defaultScene(), sceneId: manifest.scenes[0].id });
  if (!norm.ok) return false;
  const bytes = buildEnvelopeBytes(projectId, norm.normalized, []);
  const res = writeAtomic({
    dir: join(dir, 'scenes'),
    target: join(dir, SCENE_REL),
    bytes,
    allowedPreHashes: null, // must stay absent
    previousHash: null,
    ops: core.ops,
  });
  if (res.ok) return true;
  if (res.external) {
    // It appeared concurrently: keep it (never overwrite a foreign write);
    // loadable only if it actually loads.
    let foreign: Uint8Array | null = null;
    try {
      foreign = core.ops.readFile(join(dir, SCENE_REL));
    } catch {
      foreign = null;
    }
    if (foreign === null) return false;
    const e2 = validateEnvelope(foreign, projectId);
    return e2.ok && manifest.scenes[0].id === e2.scene.sceneId && manifest.id === projectId;
  }
  if (res.failed && res.failed.onDiskState === 'new-undurable') return true; // on disk; durability unproven
  return false; // "previous": still absent — kept for the operator
}

// ---- request envelope helpers ----------------------------------------------------------

/** Extract the request envelope's projectId (string or null). */
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
 * R11 (2026-09-18 review): the first non-canonicalizable part of the request
 * value, or null when the ENTIRE value is a JSON value under the digest's
 * canonical rules (commands.md §6.6 — the same canonical-bytes semantics the
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

/** A §5.2 failure payload with the parseable echo fields (commands.md §5.2:
 * `op` ≤ 32 chars, `projectId` when parseable, `requestId` ≤ 64 chars). */
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

/** §4/§5.6 query envelope validation (request-level `invalid_request`). */
function validateQueryRequest(request: unknown):
  | {
      ok: true;
      op: 'queryProject' | 'queryEntity' | 'queryEntities';
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
  if (op !== 'queryProject' && op !== 'queryEntity' && op !== 'queryEntities') {
    return {
      ok: false,
      error: invalidRequest('/op', op, 'one of: queryProject, queryEntity, queryEntities', typeof op !== 'string' ? 'op must be a string query op' : 'op is not one of the M1 query ops'),
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

/** `name` 1–128 chars, no control characters (workspace.md §8.1). */
function validName(s: string): boolean {
  if (s.length < 1 || s.length > 128) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

/**
 * §8.3 step 1: mkdir the project, scenes, .thirdlight and
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

/** Append a record and evict the oldest to stay ≤ 128 (commands.md §7.1). */
function appendRecord(
  existing: readonly RetryRecord[],
  rec: RetryRecord,
): RetryRecord[] {
  const out = [...existing, rec];
  const RETENTION = 128;
  while (out.length > RETENTION) out.shift();
  return out;
}
