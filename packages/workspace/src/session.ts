/**
 * Per-project sessions — the on-demand open pipeline (workspace.md §6.2),
 * the §4.3 load, external-change detection and the operator resolutions
 * (§7), and the maintenance release (§9).
 *
 * A session holds the last acknowledged in-memory state (commands.md §10:
 * queries read exactly this), the durable retry records, the last known
 * good envelope bytes + hash (`lastWrittenHash`, workspace.md §5.2), and
 * the pending external change (when writes are paused).
 */

import { mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import { createCommandState } from '@thirdlight/commands';
import type { CommandError, HistoryState } from '@thirdlight/commands';
import type { Entity, Manifest, Scene } from '@thirdlight/project-model';
import {
  normalizeScene,
  parseDocumentBytes,
  validateManifest,
} from '@thirdlight/project-model';

import {
  buildEnvelopeBytes,
  ID_RE,
  validateEnvelope,
  type RetryRecord,
} from './envelope';
import {
  entityNotFound,
  externalChangeEvidenceMissing,
  externalChangeInvalid,
  externalChangeUnreadable,
  externalChangeUnresolved,
  fieldMissing,
  fieldTypeError,
  fieldUnexpected,
  fieldValueType,
  invalidRequest,
  isPlainObject,
  isSafeInt,
  noPendingChange,
  projectNotFound,
  projectUnavailable,
  staleOwnership,
  ownershipConflict,
  writeFailed,
  type Holder,
  type LoadDetail,
  type UnavailableReason,
} from './errors';
import {
  EMPTY_BYTES,
  EMPTY_HASH,
  cleanLeftoverTemps,
  errnoOf,
  writeAtomic,
  type WriteOps,
} from './write';
import {
  claimOwnership,
  evaluateLiveness,
  evaluateOwnership,
  parseOwnershipRecord,
  readOwnershipRecordBytes,
  releaseOwnership,
  utcSecond,
  type ClaimOutcome,
  type Liveness,
  type OwnershipEval,
  type OwnershipRecord,
  type SelfIdentity,
} from './ownership';
import { sha256Hex } from './digest';
import { snapshotForeignBytes } from './recovery';
import type { PendingChangeInfo, QueryResult } from './types';

// ---- internal state ------------------------------------------------------------

/** A pending external change (workspace.md §7.2 step 4). */
export interface PendingChange {
  /**
   * §7.2 step 4: the recovery snapshot's durable state — "ok" (the step-2
   * snapshot is durable), "snapshot_failed" (the bytes were read and
   * validated but no snapshot is durable), "unreadable" (step 1 failed
   * with a non-ENOENT error: the bytes were never read — externalHash /
   * externalValid / externalErrors are null).
   */
  snapshotState: 'ok' | 'snapshot_failed' | 'unreadable';
  externalHash: string | null;
  externalValid: boolean | null;
  /** All validation errors (the public shape reports ≤ 10 + the count); null while unreadable. */
  externalErrors: readonly LoadDetail[] | null;
  /** The parsed external scene (canonical) when the bytes are valid. */
  externalScene: Scene | null;
}

/**
 * A pending change established over READABLE bytes (§7.2 steps 2–4):
 * the step-2 snapshot is either durable ("ok") or failed
 * ("snapshot_failed") — never "unreadable" (that state is
 * `setPendingUnreadable`, step 1). The §11 `external_change_unresolved`
 * payload carries this narrower `snapshotState` (the bytes were read —
 * the real `externalHash` is always present).
 */
type ReadablePendingChange = PendingChange & {
  snapshotState: 'ok' | 'snapshot_failed';
};

export interface ProjectSession {
  projectId: string;
  dir: string;
  /**
   * The VERIFIED child artifact directories (R7, 2026-09-18 review):
   * resolved + containment-checked at open with `resolveContained` (a
   * symlink escaping the data root ⇒ the project is not a project of
   * this backend ⇒ the not-found outcome). All subsequent path building
   * for this project (envelope W, ownership, recovery) uses these —
   * never a re-join from the raw project id.
   */
  sceneDir: string;
  thirdlightDir: string;
  manifest: Manifest;
  /** Published (last acknowledged) scene; null while blocked. */
  scene: Scene | null;
  /** === scene.revision (0 while blocked). */
  revision: number;
  /** Published retry records (ascending appliedRevision). */
  records: RetryRecord[];
  recordMap: Map<string, RetryRecord>;
  /** SHA-256 of the last known good envelope bytes (workspace.md §5.2). */
  lastWrittenHash: string;
  /** The last known good envelope bytes. */
  envelopeBytes: Uint8Array;
  history: HistoryState;
  /** The ownership record this backend holds (owned) — or null while blocked. */
  ownership: OwnershipRecord | null;
  mode: 'open' | 'released' | 'blocked';
  blocked: { reason: UnavailableReason; errors: readonly LoadDetail[]; count: number } | null;
  pendingChange: PendingChange | null;
}

/** The core the service shares with the session layer. */
export interface Core {
  root: string;
  projectsRoot: string;
  self: SelfIdentity;
  processMarker: string;
  procRoot: string;
  /** UTC-stamp for recovery snapshot names (config seam; real clock by default). */
  stamp: () => string;
  /** Canonical-seconds UTC now (config seam; real clock by default). */
  utcNow: () => string;
  ops: WriteOps;
  sessions: Map<string, ProjectSession>;
}

export type OpenOutcome =
  | { kind: 'open'; session: ProjectSession }
  | { kind: 'released' }
  | { kind: 'not-found' }
  | {
      kind: 'unavailable';
      reason: UnavailableReason;
      holder: Holder | null;
      errors?: readonly LoadDetail[];
      count?: number;
    };

const MANIFEST_REL = 'project.json';

function livenessFn(core: Core): (pid: number, openedAt: string) => Liveness {
  return (pid, openedAt) =>
    evaluateLiveness(pid, openedAt, core.procRoot, core.processMarker);
}

/** The configured engine version (M1 baseline, workspace.md §8.2). */
export const ENGINE_VERSION = '0.1.0';

/** The project-model §15 default scene (the project-creation template). */
export function defaultScene(): Scene {
  const res = normalizeScene({
    schemaVersion: 1,
    sceneId: 'scene-main',
    revision: 0,
    entities: [
      {
        id: 'cam-main',
        name: 'Main Camera',
        components: {
          transform: {
            position: [0, 0.5, 4],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
        },
      },
    ],
  });
  if (!res.ok) throw new Error('default scene template failed model validation');
  return res.normalized;
}

/**
 * The ONE containment policy (R7, 2026-09-18 review): `projectsRoot` +
 * `segs` is a project of this backend only if every component exists and
 * the realpath of the FULL path stays inside the realpath of the data
 * root — any symlink component escaping the data root makes the path NOT
 * a project of this backend. It is verified BEFORE any content-acting
 * read or any write; a hostile unlink-replace race AFTER verification is
 * the workspace.md §7.1 bypassing-actor class (documented bound, not
 * solved by checking only the outer directory).
 */
export function resolveContained(
  core: Core,
  ...segs: string[]
): { ok: true; dir: string } | { ok: false } {
  if (segs.length === 0) return { ok: false };
  let p = core.projectsRoot;
  for (const seg of segs) {
    p = join(p, seg);
    if (!core.ops.dirExists(p)) return { ok: false };
  }
  const dir = p;
  let realRoot: string;
  let realFull: string;
  try {
    realRoot = realpathSync(core.projectsRoot);
    realFull = realpathSync(dir);
  } catch {
    return { ok: false };
  }
  const inside =
    realFull === realRoot || realFull.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  return inside ? { ok: true, dir } : { ok: false };
}

/**
 * Verify a project's child artifact path for a project whose directory
 * already passed `resolveProjectDir` (R7, 2026-09-18 review):
 * - the final component ABSENT ⇒ `absent` — nothing can escape, and the
 *   existing open behavior applies (a missing envelope blocks until the
 *   scan completes it, workspace.md §8.3/§10; an absent ownership record
 *   is claimed, creating the directory, §6.2);
 * - present but escaping the data root (a symlink component outside the
 *   data root) ⇒ `escape` — NOT a project of this backend;
 * - present and contained ⇒ `ok` with the verified path (all later path
 *   building uses it — no re-join from the raw name).
 */
export function verifyChildDir(
  core: Core,
  ...segs: string[]
): { kind: 'ok'; dir: string } | { kind: 'absent' } | { kind: 'escape' } {
  let p = core.projectsRoot;
  for (const seg of segs) p = join(p, seg);
  if (!core.ops.dirExists(p)) return { kind: 'absent' };
  const res = resolveContained(core, ...segs);
  return res.ok ? { kind: 'ok', dir: res.dir } : { kind: 'escape' };
}

/**
 * Resolve a project directory inside the configured data root, enforcing
 * the supported policy: the project ID is the only addressing (charter §4 —
 * arbitrary absolute paths are never accepted), the ID syntax excludes
 * traversal by construction, and the single containment check
 * (`resolveContained`) rejects symlink escapes out of the data root (an
 * escaped directory is not a project of this backend ⇒ `project_not_found`).
 */
export function resolveProjectDir(
  core: Core,
  projectId: string,
): { ok: true; dir: string } | { ok: false } {
  if (!ID_RE.test(projectId)) return { ok: false };
  return resolveContained(core, projectId);
}

// ---- manifest + envelope loading -----------------------------------------------

/** Read + strictly validate the manifest (project-model pass 1 + validator). */
function loadManifest(
  core: Core,
  dir: string,
): { ok: true; manifest: Manifest } | { ok: false; errors: readonly LoadDetail[] } {
  const p = join(dir, MANIFEST_REL);
  if (!core.ops.fileExists(p)) {
    return {
      ok: false,
      errors: [
        {
          code: 'manifest_invalid',
          path: '',
          message: 'project.json is missing',
          expected: 'a loadable project manifest (workspace.md §8.2)',
        },
      ],
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = core.ops.readFile(p);
  } catch {
    return {
      ok: false,
      errors: [
        {
          code: 'manifest_invalid',
          path: '',
          message: 'project.json is unreadable',
          expected: 'a loadable project manifest (workspace.md §8.2)',
        },
      ],
    };
  }
  const parsed = parseDocumentBytes(bytes);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  const v = validateManifest(parsed.value);
  if (!v.ok) return { ok: false, errors: v.errors.slice(0, 10) };
  return { ok: true, manifest: v.normalized };
}

type LoadOutcome =
  | { kind: 'loaded'; scene: Scene; records: RetryRecord[]; bytes: Uint8Array; hash: string }
  | { kind: 'envelope-missing' }
  | { kind: 'blocked'; reason: UnavailableReason; errors: readonly LoadDetail[]; count: number };

/**
 * The §4.3 load pipeline over the on-disk envelope (steps 1–7), then the
 * manifest cross-document checks (step 8, against the manifest already
 * loaded at resolution). First failure wins. READ-ONLY: no session,
 * no ownership, no writes — usable outside the on-demand open pipeline
 * (the §8.1 idempotent createProject probe, R15).
 */
export function loadProjectDir(
  core: Core,
  sceneDir: string,
  projectId: string,
  manifest: Manifest,
): LoadOutcome {
  // R7: the caller passes the VERIFIED scenes directory — no re-join from
  // the raw project id (the open pipeline verifies containment first).
  const p = join(sceneDir, 'main.json');
  if (!core.ops.fileExists(p)) return { kind: 'envelope-missing' };
  let bytes: Uint8Array;
  try {
    bytes = core.ops.readFile(p);
  } catch {
    return { kind: 'envelope-missing' };
  }
  const env = validateEnvelope(bytes, projectId);
  if (!env.ok) {
    return { kind: 'blocked', reason: env.reason, errors: env.errors, count: env.count };
  }
  // Step 8 — cross-document checks (project-model §13 + the workspace
  // -enforced directory-name rule, §13.3).
  if (manifest.scenes[0].id !== env.scene.sceneId) {
    return {
      kind: 'blocked',
      reason: 'manifest_scene_mismatch',
      errors: [
        {
          code: 'manifest_scene_mismatch',
          path: '/scenes/0/id',
          document: 'manifest',
          message: 'manifest scenes[0].id does not equal the envelope scene sceneId',
          expected: 'scene document sceneId',
        },
      ],
      count: 1,
    };
  }
  if (manifest.id !== projectId) {
    return {
      kind: 'blocked',
      reason: 'manifest_scene_mismatch',
      errors: [
        {
          code: 'manifest_scene_mismatch',
          path: '/id',
          document: 'manifest',
          message: 'manifest.id must equal the project directory name (project-model §13.3)',
          expected: projectId,
        },
      ],
      count: 1,
    };
  }
  return {
    kind: 'loaded',
    scene: env.scene,
    records: env.records,
    bytes,
    hash: sha256Hex(bytes),
  };
}

// ---- session construction --------------------------------------------------------

function makeSession(
  core: Core,
  dir: string,
  projectId: string,
  loaded: Extract<LoadOutcome, { kind: 'loaded' }>,
  manifest: Manifest,
  ownership: OwnershipRecord,
  sceneDir: string,
  thirdlightDir: string,
): ProjectSession {
  const recordMap = new Map<string, RetryRecord>();
  for (const r of loaded.records) recordMap.set(r.requestId, r);
  return {
    projectId,
    dir,
    sceneDir,
    thirdlightDir,
    manifest,
    scene: loaded.scene,
    revision: loaded.scene.revision,
    records: [...loaded.records],
    recordMap,
    lastWrittenHash: loaded.hash,
    envelopeBytes: loaded.bytes,
    history: createCommandState(loaded.scene).history,
    ownership,
    mode: 'open',
    blocked: null,
    pendingChange: null,
  };
}

function blockSession(
  core: Core,
  dir: string,
  projectId: string,
  manifest: Manifest,
  ownership: OwnershipRecord | null,
  blocked: { reason: UnavailableReason; errors: readonly LoadDetail[]; count: number },
  sceneDir: string,
  thirdlightDir: string,
): ProjectSession {
  return {
    projectId,
    dir,
    sceneDir,
    thirdlightDir,
    manifest,
    scene: null,
    revision: 0,
    records: [],
    recordMap: new Map(),
    lastWrittenHash: '',
    envelopeBytes: EMPTY_BYTES,
    history: createCommandState(defaultScene()).history,
    ownership,
    mode: 'blocked',
    blocked,
    pendingChange: null,
  };
}

/**
 * The on-demand open pipeline (commands.md §6.1 step 1; workspace.md §6.2):
 * resolution + manifest loadability → ownership evaluation/claim → temp
 * cleanup (§5.4) → the §4.3 load. A previously blocked session re-runs the
 * load on every access (repair-the-file-and-reopen without a process
 * restart; the ownership is already held).
 */
/**
 * On-demand open (workspace.md §6.2) with caller awareness:
 * - `command` — the next command on a RELEASED project is the on-demand
 *   re-open (workspace.md §9.3): the released record is re-claimed and the
 *   (edited) disk state is re-validated from scratch;
 * - `query` — queries never trigger a re-open of a released project: they
 *   fail `project_unavailable { reason: "workspace_closed" }` (§9.1).
 */
export function ensureSession(
  core: Core,
  projectId: string,
  caller: 'command' | 'query' = 'command',
): OpenOutcome {
  const existing = core.sessions.get(projectId);
  if (existing !== undefined) {
    if (existing.mode === 'open') return { kind: 'open', session: existing };
    if (existing.mode === 'released') {
      if (caller === 'query') return { kind: 'released' };
      core.sessions.delete(projectId); // fall through: the fresh open below
      // re-claims the released record at epoch + 1 (workspace.md §9.3).
    } else {
    // blocked: re-validate from disk (the operator repairs the file by
    // hand and retries; §7.5). The ownership is already ours.
    const man = loadManifest(core, existing.dir);
    if (!man.ok) {
      // The manifest became unloadable (an external edit — the manifest is
      // detected at the next open, workspace.md §8.2): the project is no
      // longer a loadable project.
      return { kind: 'not-found' };
    }
    const l = loadProjectDir(core, existing.sceneDir, projectId, man.manifest);
    if (l.kind === 'loaded') {
      const s = makeSession(
        core,
        existing.dir,
        projectId,
        l,
        man.manifest,
        existing.ownership ?? releasedRecord(core),
        existing.sceneDir,
        existing.thirdlightDir,
      );
      s.mode = 'open';
      s.blocked = null;
      s.pendingChange = null;
      core.sessions.set(projectId, s);
      return { kind: 'open', session: s };
    }
    if (l.kind === 'envelope-missing') {
      existing.blocked = {
        reason: 'envelope_invalid',
        errors: [
          {
            code: 'envelope_invalid',
            path: '',
            message: 'scenes/main.json is missing (an interrupted creation is completed by the startup scan, workspace.md §8.3/§10)',
            expected: 'a loadable authoring-state envelope',
          },
        ],
        count: 1,
      };
    } else {
      existing.blocked = { reason: l.reason, errors: l.errors, count: l.count };
    }
    return {
      kind: 'unavailable',
      reason: existing.blocked.reason,
      holder: null,
      errors: existing.blocked.errors,
      count: existing.blocked.count,
    };
    }
  }

  // Fresh open.
  const res = resolveProjectDir(core, projectId);
  if (!res.ok) return { kind: 'not-found' };
  const dir = res.dir;

  // R7 (2026-09-18 review): the child artifact directories are verified
  // with the SAME containment policy BEFORE any read/write through them —
  // a PRESENT scenes/.thirdlight that escapes the data root (symlink)
  // ⇒ the project is not a project of this backend ⇒ the same not-found
  // outcome a top-level escape produces (queries/mutations report
  // `project_not_found`). An ABSENT child keeps the existing behavior
  // (blocked-until-scan / claim-creates-the-dir). The verified dirs are
  // stored on the session; no later path building re-joins from the raw
  // name.
  const scenesCheck = verifyChildDir(core, projectId, 'scenes');
  const thirdCheck = verifyChildDir(core, projectId, '.thirdlight');
  if (scenesCheck.kind === 'escape' || thirdCheck.kind === 'escape') {
    return { kind: 'not-found' };
  }
  const sceneDir = scenesCheck.kind === 'ok' ? scenesCheck.dir : join(dir, 'scenes');
  const thirdlightDir = thirdCheck.kind === 'ok' ? thirdCheck.dir : join(dir, '.thirdlight');

  // Manifest loadability (commands.md §5.4: a directory without a loadable
  // manifest is not a project ⇒ project_not_found).
  const man = loadManifest(core, dir);
  if (!man.ok) return { kind: 'not-found' };

  // Ownership evaluation + claim (workspace.md §6.2/§6.3) — bounded re-
  // evaluation: a claim that fails against a MOVED record re-evaluates.
  let claim: ClaimOutcome | null = null;
  for (let round = 0; round < 3 && claim === null; round++) {
    const recBytes = readOwnershipRecordBytes(thirdlightDir, core.ops);
    const ev = evaluateOwnership(recBytes, core.self, livenessFn(core));
    if (ev.action !== 'claim') {
      return evalToUnavailable(ev);
    }
    ensureThirdlightDir(thirdlightDir, core.ops);
    const c = claimOwnership(
      thirdlightDir,
      core.self,
      ev.lockEpoch,
      livenessFn(core),
      core.ops,
      () => core.utcNow(),
      recBytes,
    );
    if (c.ok) {
      claim = c;
    } else if (c.eval.action === 'claim') {
      continue; // the record moved (concurrent claimer / transient I/O): retry
    } else {
      return evalToUnavailable(c.eval);
    }
  }
  if (claim === null || !claim.ok) {
    return { kind: 'unavailable', reason: 'ownership_conflict', holder: null };
  }

  // §5.4: the owner cleans leftover temps on open, before any command.
  cleanLeftoverTemps(sceneDir, 'main.json', core.ops);

  // The §4.3 load (through the VERIFIED scenes directory).
  const l = loadProjectDir(core, sceneDir, projectId, man.manifest);
  if (l.kind === 'envelope-missing') {
    // An interrupted creation is completed by the startup scan (§8.3/§10).
    // At on-demand open the project is blocked until that completion has
    // happened (no destructive auto-write at open outside the scan).
    const s = blockSession(
      core,
      dir,
      projectId,
      man.manifest,
      claim.record,
      {
        reason: 'envelope_invalid',
        errors: [
          {
            code: 'envelope_invalid',
            path: '',
            message: 'scenes/main.json is missing (an interrupted creation is completed by the startup scan, workspace.md §8.3/§10)',
            expected: 'a loadable authoring-state envelope',
          },
        ],
        count: 1,
      },
      sceneDir,
      thirdlightDir,
    );
    core.sessions.set(projectId, s);
    return {
      kind: 'unavailable',
      reason: 'envelope_invalid',
      holder: null,
      errors: s.blocked?.errors,
      count: 1,
    };
  }
  if (l.kind === 'blocked') {
    const s = blockSession(
      core,
      dir,
      projectId,
      man.manifest,
      claim.record,
      {
        reason: l.reason,
        errors: l.errors,
        count: l.count,
      },
      sceneDir,
      thirdlightDir,
    );
    core.sessions.set(projectId, s);
    return {
      kind: 'unavailable',
      reason: l.reason,
      holder: null,
      errors: l.errors,
      count: l.count,
    };
  }
  const s = makeSession(core, dir, projectId, l, man.manifest, claim.record, sceneDir, thirdlightDir);
  core.sessions.set(projectId, s);
  return { kind: 'open', session: s };
}

function evalToUnavailable(ev: OwnershipEval): OpenOutcome {
  if (ev.action === 'stale') return { kind: 'unavailable', reason: 'stale_ownership', holder: ev.holder };
  if (ev.action === 'conflict') {
    return { kind: 'unavailable', reason: 'ownership_conflict', holder: ev.holder };
  }
  // A 'claim' eval here is unreachable (callers claim or continue), but
  // fail closed as a conflict without a holder.
  return { kind: 'unavailable', reason: 'ownership_conflict', holder: null };
}

/** Ensure the project's VERIFIED `.thirdlight` directory exists (0755)
 * before the first ownership write (it is containment-checked at open,
 * R7 — this only closes the post-verification creation race). */
function ensureThirdlightDir(p: string, ops: WriteOps): void {
  if (ops.dirExists(p)) return;
  try {
    mkdirSync(p, { mode: 0o755 });
    try {
      chmodSync(p, 0o755);
    } catch {
      // best effort
    }
  } catch (e) {
    if ((e as { errno?: unknown })?.errno === 'EEXIST') return;
    throw e;
  }
}

function releasedRecord(core: Core): OwnershipRecord {
  return {
    storageVersion: 1,
    state: 'released',
    backendId: core.self.backendId,
    pid: core.self.pid,
    openedAt: utcSecond(),
    lockEpoch: 0,
  };
}

// ---- external change protocol (workspace.md §7) ----------------------------------

/**
 * §7.2 detection and pause: snapshot the foreign bytes (byte-for-byte,
 * before the project pauses), run the FULL §4.3 validation pipeline over
 * them (externalValid + errors), and set the pending change. The
 * triggering command fails `external_change_unresolved`; no state, no
 * record, no revision change.
 */
export function detectExternalChange(
  core: Core,
  s: ProjectSession,
  foreign: { bytes: Uint8Array; hash: string },
): ReadablePendingChange {
  // Step 2 — snapshot BEFORE the pause (the original file stays in
  // place). A FAILED snapshot write is the §7.2 step-2 normative state
  // (R3): the pending change records `snapshotState: "snapshot_failed"`
  // — the pause stays fail-closed and the §7.3 resolutions are refused
  // with `external_change_evidence_missing` until a durable snapshot
  // exists. The failure is reported, never swallowed.
  const snapshotName = snapshotForeignBytes(s.thirdlightDir, foreign.bytes, core.ops, core.stamp);
  // Step 3 — the full §4.3 pipeline over the foreign bytes.
  const envRes = validateEnvelope(foreign.bytes, s.projectId);
  let externalValid = false;
  let externalErrors: readonly LoadDetail[] = [];
  let externalScene: Scene | null = null;
  if (envRes.ok) {
    const crossOk =
      s.manifest.scenes[0].id === envRes.scene.sceneId && s.manifest.id === s.projectId;
    if (crossOk) {
      externalValid = true;
      externalScene = envRes.scene;
    } else {
      externalValid = false;
      externalErrors = [
        {
          code: 'manifest_scene_mismatch',
          path: '/scenes/0/id',
          document: 'manifest',
          message: 'the external envelope does not cross-check against the manifest',
          expected: 'scene document sceneId',
        },
      ];
    }
  } else {
    externalErrors = envRes.errors;
  }
  // Step 4 — pending change + pause (queries serve the last known good).
  // `snapshotState` records the step-2 outcome truthfully (R3): "ok" when
  // the snapshot is durable, "snapshot_failed" when it could not be
  // written (the §7.3 refusal clause below handles both states).
  const pending: ReadablePendingChange = {
    snapshotState: snapshotName === null ? 'snapshot_failed' : 'ok',
    externalHash: foreign.hash,
    externalValid,
    externalErrors,
    externalScene,
  };
  s.pendingChange = pending;
  return pending;
}

/**
 * §7.2 step 1 (a non-ENOENT read failure): the on-disk bytes are UNKNOWN,
 * never absent. No snapshot is taken (nothing was read); the pending
 * change records the unknown state (`paused-unreadable`) and writes stay
 * paused. Nothing is fabricated — `externalHash`/`externalValid` /
 * `externalErrors` are null.
 */
export function setPendingUnreadable(s: ProjectSession): void {
  s.pendingChange = {
    snapshotState: 'unreadable',
    externalHash: null,
    externalValid: null,
    externalErrors: null,
    externalScene: null,
  };
}

export function pendingInfo<T extends PendingChange>(pc: T): {
  snapshotState: T['snapshotState'];
  externalHash: string | null;
  externalValid: boolean | null;
  externalErrorCount: number | null;
} {
  return {
    snapshotState: pc.snapshotState,
    externalHash: pc.externalHash,
    externalValid: pc.externalValid,
    externalErrorCount: pc.externalErrors === null ? null : pc.externalErrors.length,
  };
}

/** The `workspace` block of queryProject (§5.6). */
export function workspaceBlock(s: ProjectSession):
  | { writePaused: false }
  | {
      writePaused: true;
      pauseReason: 'external_change';
      pendingChange: PendingChangeInfo;
    } {
  if (s.pendingChange === null) return { writePaused: false };
  const pc = s.pendingChange;
  return {
    writePaused: true,
    pauseReason: 'external_change',
    pendingChange: {
      snapshotState: pc.snapshotState,
      externalHash: pc.externalHash,
      externalValid: pc.externalValid,
      externalErrorCount: pc.externalErrors === null ? null : pc.externalErrors.length,
      externalErrors: (pc.externalErrors ?? []).slice(0, 10),
    },
  };
}

/** The outcome of the §7.3 refusal-clause re-read (before answering). */
type RereadOutcome =
  | { kind: 'proceed' | 'refired'; pc: ReadablePendingChange }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

/**
 * The §7.3 refusal-clause re-read: while `snapshotState` is not "ok",
 * the resolution is refused — but BEFORE answering, the command re-reads
 * the scene file (the answer is never based on a stale read; the blind
 * `allowAbsent` W is gone). Outcomes:
 * - `unreadable` — a non-ENOENT read error: the bytes are still unknown
 *   (`paused-unreadable`; the pending change is the unreadable shape);
 * - `absent` — ENOENT: the foreign state is gone (the caller durably
 *   restores the LKG envelope via W);
 * - `refired` — readable bytes with a hash DIFFERENT from the pending
 *   `externalHash` (a new foreign state while paused): the §7.2 protocol
 *   re-fires on the real bytes (a fresh detection cycle — snapshot,
 *   validate, pause); the caller fails the resolution with
 *   `external_change_unresolved` and the operator re-resolves;
 * - `proceed` — readable bytes establishing the (real) pending change via
 *   the §7.2 detection path (steps 2–4: snapshot byte-for-byte, validate):
 *   the same foreign bytes for a `snapshot_failed` pending change (the
 *   snapshot is re-attempted) or any readable bytes for an `unreadable`
 *   pending change (the hash was unknown). The caller proceeds with the
 *   resolution in the same call once the snapshot is durable.
 */
function rereadSceneForResolution(core: Core, s: ProjectSession): RereadOutcome {
  const target = join(s.sceneDir, 'main.json');
  let bytes: Uint8Array;
  try {
    bytes = core.ops.readFile(target);
  } catch (e) {
    if (errnoOf(e) === 'ENOENT') return { kind: 'absent' };
    // Bytes still unreadable (non-ENOENT): the unreadable pending state
    // stands (the pending state and the pause persist across the refusal).
    setPendingUnreadable(s);
    return { kind: 'unreadable' };
  }
  const hash = sha256Hex(bytes);
  const pending = s.pendingChange!;
  if (pending.externalHash !== null && pending.externalHash !== hash) {
    // Other foreign bytes (readable, different hash): a fresh detection
    // cycle on the real bytes (the step-2 snapshot is RETRIED here — the
    // detection is the same call the triggering mutation used); the
    // resolution fails with external_change_unresolved and the operator
    // re-resolves.
    const pc = detectExternalChange(core, s, { bytes, hash });
    return { kind: 'refired', pc };
  }
  // (Re)establish the pending change from the REAL bytes (§7.2 steps 2–4:
  // snapshot byte-for-byte — RETRIED for a `snapshot_failed` pending
  // change — validate, pause).
  const pc = detectExternalChange(core, s, { bytes, hash });
  return { kind: 'proceed', pc };
}

/** The LKG restore W of the §7.3 ENOENT re-read branch. */
function restoreLkg(core: Core, s: ProjectSession) {
  return writeAtomic({
    dir: s.sceneDir, // R7: the VERIFIED scenes directory (no re-join)
    target: join(s.sceneDir, 'main.json'),
    bytes: s.envelopeBytes,
    // Creation-style check: the target must stay absent (it was just
    // re-read as absent); a readable appearance racing in re-fires §5.2.
    allowedPreHashes: null,
    // The target did not exist before THIS write: a failed sequence
    // classifies `previous` (nothing on disk changed; the in-memory LKG
    // is unchanged and retrying re-executes fresh).
    previousHash: null,
    ops: core.ops,
  });
}

/**
 * The §7.3 ENOENT re-read branch (shared by accept and discard): the file
 * is absent at re-read — the foreign state is gone. The last known good
 * envelope is durably restored via W (creation-style check), the pending
 * change is cleared and the project unpaused, and history is cleared
 * (new boundary — the file was replaced externally, M1 performs no
 * reconciliation). The in-memory records are kept: they match the restored
 * LKG bytes (the running system stays self-consistent with disk). Nothing
 * is cleared on a `previous`-classified failure (nothing was written —
 * the pending state and the pause persist across the refusal).
 */
function restoreLkgAfterAbsentReread(
  core: Core,
  s: ProjectSession,
):
  | { kind: 'restored' }
  | { kind: 'writeFailed'; onDiskState: 'previous' | 'new-undurable'; errno?: string }
  | { kind: 'refired'; pc: ReadablePendingChange }
  | { kind: 'unreadable' } {
  const res = restoreLkg(core, s);
  if (res.ok) {
    s.pendingChange = null;
    s.history = createCommandState(s.scene!).history;
    return { kind: 'restored' };
  }
  if (res.failed && res.failed.onDiskState === 'new-undurable') {
    // The LKG bytes are on disk (the rename took effect); durability is
    // unproven. The foreign state is gone either way: clear the pending
    // change and un-pause (memory already equals the restored bytes).
    s.pendingChange = null;
    s.history = createCommandState(s.scene!).history;
  }
  if (res.external) {
    // A readable appearance raced in between the re-read and the W
    // pre-check: the §7.2 protocol re-fires on the real bytes.
    const pc = detectExternalChange(core, s, res.external);
    return { kind: 'refired', pc };
  }
  if (res.unreadable) {
    // An unreadable appearance raced in: the bytes are unknown, never
    // absent — the unreadable pending state is recorded.
    setPendingUnreadable(s);
    return { kind: 'unreadable' };
  }
  if (res.failed) {
    // Nothing was written (`previous`): the pending state and the pause
    // persist; the write failure is reported (a re-issue re-reads and
    // re-attempts the restore).
    return { kind: 'writeFailed', onDiskState: res.failed.onDiskState, errno: res.failed.errno };
  }
  // Unreachable: exactly one of ok/failed/external/unreadable is set.
  return { kind: 'writeFailed', onDiskState: 'previous' };
}

// ---- operator resolutions (workspace.md §7.3/§6.4/§9) ----------------------------

/** `acceptExternalState` (§7.3). */
export function acceptExternal(
  core: Core,
  s: ProjectSession,
): { ok: true; revision: number; historyReset: true; retryCleared: true } | { ok: false; error: CommandError } {
  if (s.mode !== 'open' || s.pendingChange === null) {
    return { ok: false, error: noPendingChange() };
  }
  let pc = s.pendingChange;
  if (pc.snapshotState !== 'ok') {
    // §7.3 refusal: while evidence is missing or unreadable, the
    // resolution is refused — but before answering, the command re-reads
    // the file (nothing is answered from a stale read).
    const rr = rereadSceneForResolution(core, s);
    if (rr.kind === 'unreadable') {
      return { ok: false, error: externalChangeUnreadable(s.projectId) };
    }
    if (rr.kind === 'absent') {
      const out = restoreLkgAfterAbsentReread(core, s);
      if (out.kind === 'restored') {
        return { ok: true, revision: s.revision, historyReset: true, retryCleared: true };
      }
      if (out.kind === 'refired') {
        return { ok: false, error: externalChangeUnresolved(pendingInfo(out.pc)) };
      }
      if (out.kind === 'unreadable') {
        return { ok: false, error: externalChangeUnreadable(s.projectId) };
      }
      return { ok: false, error: writeFailed(out.onDiskState, out.errno) };
    }
    if (rr.kind === 'refired') {
      // A new foreign state while paused: the §7.2 protocol re-fired on
      // the fresh bytes — the resolution fails; the operator re-resolves.
      return { ok: false, error: externalChangeUnresolved(pendingInfo(rr.pc)) };
    }
    // 'proceed': the pending change is (re)established from the real
    // bytes. Proceed with the resolution in the SAME call only once the
    // snapshot is durable — otherwise the refusal stands (nothing
    // written; the pending state and the pause persist).
    if (rr.pc.snapshotState !== 'ok') {
      return { ok: false, error: externalChangeEvidenceMissing(s.projectId, pendingInfo(rr.pc)) };
    }
    pc = rr.pc;
  }
  if (!pc.externalValid || pc.externalScene === null) {
    return { ok: false, error: externalChangeInvalid() };
  }
  // The external scene becomes authoritative: canonical re-serialization
  // with retry.records = [] (new retry boundary), ownership unchanged.
  const newBytes = buildEnvelopeBytes(s.projectId, pc.externalScene, []);
  const res = writeAtomic({
    dir: s.sceneDir, // R7: the VERIFIED scenes directory (no re-join)
    target: join(s.sceneDir, 'main.json'),
    bytes: newBytes,
    allowedPreHashes: [s.lastWrittenHash, pc.externalHash!],
    allowAbsent: pc.externalHash === EMPTY_HASH,
    previousHash: s.lastWrittenHash,
    ops: core.ops,
  });
  if (res.unreadable) {
    // A non-ENOENT read failure during the resolution W: the on-disk
    // bytes are unknown, never absent — the unreadable pending state
    // stands; the operator retries once the bytes are readable.
    setPendingUnreadable(s);
    return { ok: false, error: externalChangeUnreadable(s.projectId) };
  }
  if (res.external) {
    // A new foreign value appeared during the resolution: the protocol
    // fires again on the new bytes (the step-2 snapshot is taken/retried
    // by the same detection call); the operator re-resolves.
    const pc = detectExternalChange(core, s, res.external);
    return {
      ok: false,
      error: externalChangeUnresolved(pendingInfo(pc)),
    };
  }
  if (res.failed) {
    return { ok: false, error: writeFailed(res.failed.onDiskState, res.failed.errno) };
  }
  // Publish (the accepted revision is whatever the external document
  // carries — an operator accept is a declared re-base, §7.3).
  s.scene = pc.externalScene;
  s.revision = pc.externalScene.revision;
  s.records = [];
  s.recordMap = new Map();
  s.envelopeBytes = newBytes;
  s.lastWrittenHash = sha256Hex(newBytes);
  s.history = createCommandState(pc.externalScene).history;
  s.pendingChange = null;
  return { ok: true, revision: s.revision, historyReset: true, retryCleared: true };
}

/** `discardExternalState` (§7.3). */
export function discardExternal(
  core: Core,
  s: ProjectSession,
): { ok: true; revision: number; historyReset: true } | { ok: false; error: CommandError } {
  if (s.mode !== 'open' || s.pendingChange === null) {
    return { ok: false, error: noPendingChange() };
  }
  let pc = s.pendingChange;
  if (pc.snapshotState !== 'ok') {
    // §7.3 refusal: while evidence is missing or unreadable, the
    // resolution is refused — but before answering, the command re-reads
    // the file (nothing is answered from a stale read).
    const rr = rereadSceneForResolution(core, s);
    if (rr.kind === 'unreadable') {
      return { ok: false, error: externalChangeUnreadable(s.projectId) };
    }
    if (rr.kind === 'absent') {
      const out = restoreLkgAfterAbsentReread(core, s);
      if (out.kind === 'restored') {
        return { ok: true, revision: s.revision, historyReset: true };
      }
      if (out.kind === 'refired') {
        return { ok: false, error: externalChangeUnresolved(pendingInfo(out.pc)) };
      }
      if (out.kind === 'unreadable') {
        return { ok: false, error: externalChangeUnreadable(s.projectId) };
      }
      return { ok: false, error: writeFailed(out.onDiskState, out.errno) };
    }
    if (rr.kind === 'refired') {
      // A new foreign state while paused: the §7.2 protocol re-fired on
      // the fresh bytes — the resolution fails; the operator re-resolves.
      return { ok: false, error: externalChangeUnresolved(pendingInfo(rr.pc)) };
    }
    // 'proceed': the pending change is (re)established from the real
    // bytes. Proceed with the resolution in the SAME call only once the
    // snapshot is durable — otherwise the refusal stands (nothing
    // written; the pending state and the pause persist). (Discard has no
    // validity gate: the last known good state is restored regardless.)
    if (rr.pc.snapshotState !== 'ok') {
      return { ok: false, error: externalChangeEvidenceMissing(s.projectId, pendingInfo(rr.pc)) };
    }
    pc = rr.pc;
  }
  // Re-write the last known good envelope bytes exactly (they are verified
  // against lastWrittenHash — the resolution pre-write check accepts LKG
  // or the pending externalHash; any other value re-fires the protocol).
  const res = writeAtomic({
    dir: s.sceneDir, // R7: the VERIFIED scenes directory (no re-join)
    target: join(s.sceneDir, 'main.json'),
    bytes: s.envelopeBytes,
    allowedPreHashes: [s.lastWrittenHash, pc.externalHash!],
    allowAbsent: pc.externalHash === EMPTY_HASH,
    previousHash: s.lastWrittenHash,
    ops: core.ops,
  });
  if (res.unreadable) {
    // A non-ENOENT read failure during the resolution W: the on-disk
    // bytes are unknown, never absent — the unreadable pending state
    // stands; the operator retries once the bytes are readable.
    setPendingUnreadable(s);
    return { ok: false, error: externalChangeUnreadable(s.projectId) };
  }
  if (res.external) {
    // A new foreign value appeared during the resolution: the protocol
    // fires again on the new bytes (the step-2 snapshot is taken/retried
    // by the same detection call); the operator re-resolves.
    const pc = detectExternalChange(core, s, res.external);
    return {
      ok: false,
      error: externalChangeUnresolved(pendingInfo(pc)),
    };
  }
  if (res.failed) {
    return { ok: false, error: writeFailed(res.failed.onDiskState, res.failed.errno) };
  }
  // lastWrittenHash is unchanged (the same LKG bytes were re-written);
  // history is cleared (new boundary — no reconciliation, charter §6).
  s.history = createCommandState(s.scene!).history;
  s.pendingChange = null;
  return { ok: true, revision: s.revision, historyReset: true };
}

/**
 * `takeoverWorkspace` (workspace.md §6.4 — the explicit stale-owner
 * recovery; no automatic takeover, ever). Works on a fresh open (the
 * normal case) and on a released session of this backend.
 */
export function takeover(
  core: Core,
  projectId: string,
): { ok: true; lockEpoch: number; backendId: string; pid: number } | { ok: false; error: CommandError } {
  if (!ID_RE.test(projectId)) return { ok: false, error: projectNotFound(projectId) };
  const res = resolveProjectDir(core, projectId);
  if (!res.ok) return { ok: false, error: projectNotFound(projectId) };
  const dir = res.dir;
  const man = loadManifest(core, dir);
  if (!man.ok) return { ok: false, error: projectNotFound(projectId) };

  const existing = core.sessions.get(projectId);
  if (existing !== undefined && existing.mode === 'open') {
    // We own it and our process is live: a live owner ⇒ conflict
    // (workspace.md §6.2 — no takeover of a live owner, even our own).
    const holder: Holder | null = existing.ownership
      ? {
          backendId: existing.ownership.backendId,
          pid: existing.ownership.pid,
          openedAt: existing.ownership.openedAt,
          lockEpoch: existing.ownership.lockEpoch,
          state: 'owned',
        }
      : null;
    return { ok: false, error: ownershipConflict(holder) };
  }
  if (existing !== undefined && existing.mode === 'blocked') {
    // We hold a blocked project (our record is live): not stale.
    return {
      ok: false,
      error: ownershipConflict(
        existing.ownership
          ? {
              backendId: existing.ownership.backendId,
              pid: existing.ownership.pid,
              openedAt: existing.ownership.openedAt,
              lockEpoch: existing.ownership.lockEpoch,
              state: 'owned',
            }
          : null,
      ),
    };
  }

  // R7 (2026-09-18 review): the fresh-takeover path reads/writes the
  // ownership record and the envelope — verify the child artifact
  // directories with the containment policy FIRST (a PRESENT child that
  // escapes the data root ⇒ the project is not a project of this backend
  // ⇒ `project_not_found`; an absent child keeps the existing behavior).
  const scenesCheck = verifyChildDir(core, projectId, 'scenes');
  const thirdCheck = verifyChildDir(core, projectId, '.thirdlight');
  if (scenesCheck.kind === 'escape' || thirdCheck.kind === 'escape') {
    return { ok: false, error: projectNotFound(projectId) };
  }
  const sceneDir = scenesCheck.kind === 'ok' ? scenesCheck.dir : join(dir, 'scenes');
  const thirdlightDir = thirdCheck.kind === 'ok' ? thirdCheck.dir : join(dir, '.thirdlight');

  // Fresh (or released-session) takeover: the §6.4 procedure.
  const lf = livenessFn(core);
  for (let round = 0; round < 3; round++) {
    const recBytes = readOwnershipRecordBytes(thirdlightDir, core.ops);
    const ev = evaluateOwnership(recBytes, core.self, lf);
    if (ev.action === 'claim') {
      const out = performClaimAndLoad(core, dir, projectId, man.manifest, ev.lockEpoch, sceneDir, thirdlightDir, recBytes);
      if (out.ok) return out;
      return { ok: false, error: out.error };
    }
    if (ev.action === 'conflict') {
      return { ok: false, error: ownershipConflict(ev.holder) };
    }
    // stale — the §6.4 procedure:
    // (1) re-read: byte-identical to the record that evaluated stale,
    //     otherwise re-evaluate from scratch (a concurrent takeover may
    //     have landed).
    const reread = readOwnershipRecordBytes(thirdlightDir, core.ops);
    if (!bytesEqual(reread, recBytes)) continue;
    // (2) liveness again — it must still be dead.
    const staleRec = parseOwnershipRecord(recBytes);
    const lv = staleRec === null ? 'unknown' : lf(staleRec.pid, staleRec.openedAt);
    if (lv !== 'dead') continue;
    // (3) claim with lockEpoch = previous + 1.
    const claim = claimOwnership(thirdlightDir, core.self, staleRec!.lockEpoch + 1, lf, core.ops, () => core.utcNow(), recBytes);
    if (!claim.ok) {
      const e2 = claim.eval;
      if (e2.action === 'claim') continue; // the record moved: re-evaluate
      return {
        ok: false,
        error:
          e2.action === 'stale'
            ? staleOwnership(e2.holder)
            : ownershipConflict(e2.holder),
      };
    }
    // (4) load the project (§4.3) — plus the owner temp cleanup (§5.4).
    cleanLeftoverTemps(sceneDir, 'main.json', core.ops);
    const l = loadProjectDir(core, sceneDir, projectId, man.manifest);
    if (l.kind === 'loaded') {
      const s = makeSession(core, dir, projectId, l, man.manifest, claim.record, sceneDir, thirdlightDir);
      core.sessions.set(projectId, s);
      return {
        ok: true,
        lockEpoch: claim.record.lockEpoch,
        backendId: core.self.backendId,
        pid: core.self.pid,
      };
    }
    if (l.kind === 'envelope-missing') {
      core.sessions.set(
        projectId,
        blockSession(core, dir, projectId, man.manifest, claim.record, {
          reason: 'envelope_invalid',
          errors: [
            {
              code: 'envelope_invalid',
              path: '',
              message: 'scenes/main.json is missing (an interrupted creation is completed by the startup scan, workspace.md §8.3/§10)',
              expected: 'a loadable authoring-state envelope',
            },
          ],
          count: 1,
        }, sceneDir, thirdlightDir),
      );
      return {
        ok: false,
        error: projectUnavailable('envelope_invalid', null, [
          {
            code: 'envelope_invalid',
            path: '',
            message: 'scenes/main.json is missing (an interrupted creation is completed by the startup scan, workspace.md §8.3/§10)',
            expected: 'a loadable authoring-state envelope',
          },
        ]),
      };
    }
    core.sessions.set(
      projectId,
      blockSession(core, dir, projectId, man.manifest, claim.record, {
        reason: l.reason,
        errors: l.errors,
        count: l.count,
      }, sceneDir, thirdlightDir),
    );
    return {
      ok: false,
      error: projectUnavailable(l.reason, null, l.errors),
    };
  }
  // The bounded re-evaluation loop did not converge (oscillating external
  // writer): report the current evaluation.
  const recBytes = readOwnershipRecordBytes(thirdlightDir, core.ops);
  const ev = evaluateOwnership(recBytes, core.self, lf);
  if (ev.action === 'stale') return { ok: false, error: staleOwnership(ev.holder) };
  return {
    ok: false,
    error: ownershipConflict(ev.action === 'conflict' ? ev.holder : null),
  };
}

function performClaimAndLoad(
  core: Core,
  dir: string,
  projectId: string,
  manifest: Manifest,
  lockEpoch: number,
  sceneDir: string,
  thirdlightDir: string,
  existingBytes?: Uint8Array | null,
): { ok: true; lockEpoch: number; backendId: string; pid: number } | { ok: false; error: CommandError } {
  const lf = livenessFn(core);
  let claim: ClaimOutcome | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    ensureThirdlightDir(thirdlightDir, core.ops);
    const c = claimOwnership(thirdlightDir, core.self, lockEpoch, lf, core.ops, () => core.utcNow(), existingBytes);
    if (c.ok) {
      claim = c;
      break;
    }
    if (c.eval.action === 'claim') continue; // the record moved: retry
    return {
      ok: false,
      error: c.eval.action === 'stale' ? staleOwnership(c.eval.holder) : ownershipConflict(c.eval.holder),
    };
  }
  if (claim === null || !claim.ok) {
    return { ok: false, error: ownershipConflict(null) };
  }
  cleanLeftoverTemps(sceneDir, 'main.json', core.ops);
  const l = loadProjectDir(core, sceneDir, projectId, manifest);
  if (l.kind === 'loaded') {
    const s = makeSession(core, dir, projectId, l, manifest, claim.record, sceneDir, thirdlightDir);
    core.sessions.set(projectId, s);
    return {
      ok: true,
      lockEpoch: claim.record.lockEpoch,
      backendId: core.self.backendId,
      pid: core.self.pid,
    };
  }
  if (l.kind === 'envelope-missing') {
    const errors: readonly LoadDetail[] = [
      {
        code: 'envelope_invalid',
        path: '',
        message: 'scenes/main.json is missing (an interrupted creation is completed by the startup scan, workspace.md §8.3/§10)',
        expected: 'a loadable authoring-state envelope',
      },
    ];
    core.sessions.set(projectId, blockSession(core, dir, projectId, manifest, claim.record, { reason: 'envelope_invalid', errors, count: 1 }, sceneDir, thirdlightDir));
    return { ok: false, error: projectUnavailable('envelope_invalid', null, errors) };
  }
  core.sessions.set(projectId, blockSession(core, dir, projectId, manifest, claim.record, { reason: l.reason, errors: l.errors, count: l.count }, sceneDir, thirdlightDir));
  return { ok: false, error: projectUnavailable(l.reason, null, l.errors) };
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- release (workspace.md §9.1) ---------------------------------------------------

/**
 * `releaseWorkspace` (§9.1): the current state is already durable (every
 * acked command is written, §5.3) — rewrite the envelope with the same
 * scene/revision but retry.records: [] (a lost-ack retry of a pre-release
 * command must not replay across the boundary), then rewrite the ownership
 * record with state "released" (same W + verify primitive; the file is
 * never deleted), then discard the in-memory state.
 */
export function releaseProject(
  core: Core,
  s: ProjectSession,
): { ok: true; revision: number; retryCleared: true } | { ok: false; error: CommandError } {
  if (s.mode !== 'open') {
    const reason: UnavailableReason =
      s.mode === 'released'
        ? 'workspace_closed'
        : s.blocked?.reason ?? 'envelope_invalid';
    return {
      ok: false,
      error:
        s.mode === 'released'
          ? projectUnavailable('workspace_closed', null, [])
          : projectUnavailable(reason, null, s.blocked?.errors ?? []),
    };
  }
  if (s.pendingChange !== null) {
    // The on-disk bytes are foreign (or unknown — the unreadable pending
    // state): the operator must resolve the pending change before the
    // project can be handed out for maintenance.
    return {
      ok: false,
      error: projectUnavailable(
        s.pendingChange.snapshotState === 'unreadable'
          ? 'external_change_unreadable'
          : 'external_change_unresolved',
        null,
        [],
      ),
    };
  }
  // (a) Rewrite the envelope (records cleared) via W.
  const newBytes = buildEnvelopeBytes(s.projectId, s.scene!, []);
  const newHash = sha256Hex(newBytes);
  const res = writeAtomic({
    dir: s.sceneDir, // R7: the VERIFIED scenes directory (no re-join)
    target: join(s.sceneDir, 'main.json'),
    bytes: newBytes,
    allowedPreHashes: [s.lastWrittenHash],
    previousHash: s.lastWrittenHash,
    ops: core.ops,
  });
  if (res.unreadable) {
    // §7.2 step 1: a non-ENOENT read failure — the on-disk bytes are
    // unknown, never absent: record the unreadable pending change and
    // fail closed (no release; no state changes).
    setPendingUnreadable(s);
    return {
      ok: false,
      error: projectUnavailable('external_change_unreadable', null, []),
    };
  }
  if (res.external) {
    detectExternalChange(core, s, res.external);
    return {
      ok: false,
      error: projectUnavailable('external_change_unresolved', null, []),
    };
  }
  if (res.failed) {
    return { ok: false, error: writeFailed(res.failed.onDiskState, res.failed.errno) };
  }
  // The durable envelope is now the records-cleared one: keep the in-
  // memory state consistent with disk even if (b) fails (a retried release
  // is idempotent — the pre-write check passes against the new LKG).
  s.records = [];
  s.recordMap = new Map();
  s.envelopeBytes = newBytes;
  s.lastWrittenHash = newHash;
  // (b) Rewrite the ownership record with state "released".
  if (s.ownership === null) {
    return { ok: false, error: ownershipConflict(null) };
  }
  const rel = releaseOwnership(s.thirdlightDir, s.ownership, core.ops);
  if (!rel.ok) {
    if (rel.failed?.external) {
      // A foreign ownership writer raced: the project is still owned by us
      // in memory; surface it for the operator (no takeover was attempted).
      return { ok: false, error: ownershipConflict(null) };
    }
    if (rel.failed?.unreadable) {
      // The ownership record on disk is unknown (a non-ENOENT read
      // failure): no release write, no state change — the record is
      // unreadable and a live foreign owner may hold the project.
      return { ok: false, error: ownershipConflict(null) };
    }
    return {
      ok: false,
      error: writeFailed(rel.failed?.onDiskState ?? 'previous', rel.failed?.errno),
    };
  }
  // (c) Discard in-memory state (history and record map); the session
  //     stays in this backend's map as released.
  s.history = createCommandState(s.scene!).history;
  s.ownership = { ...s.ownership, state: 'released' };
  s.mode = 'released';
  return { ok: true, revision: s.revision, retryCleared: true };
}

// ---- query serving (commands.md §5.6) ------------------------------------------------

function echoOp(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > 32 ? v.slice(0, 32) : v;
}

const QUERY_OPS = ['queryProject', 'queryEntity', 'queryEntities'] as const;
type QueryOp = (typeof QUERY_OPS)[number];

/** Strict query envelope validation (request-level: `invalid_request`). */
function validateQueryEnvelope(req: unknown):
  | { ok: true; op: QueryOp; projectId: string; args: Record<string, unknown> | undefined }
  | { ok: false; error: import('@thirdlight/commands').CommandError } {
  if (!isPlainObject(req)) {
    return {
      ok: false,
      error: invalidRequest('', jsonTypeName(req), 'object (query request)', 'a query request must be an object'),
    };
  }
  for (const k of Object.keys(req)) {
    if (!['op', 'projectId', 'args'].includes(k)) {
      return {
        ok: false,
        error: invalidRequest(`/${k}`, k, 'known fields: op, projectId, args (optional)', 'unknown field is not permitted (strict M1 request drops nothing)'),
      };
    }
  }
  const op = req['op'];
  if (typeof op !== 'string' || !(QUERY_OPS as readonly string[]).includes(op)) {
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
    if (!isPlainObject(req['args'])) {
      return {
        ok: false,
        error: invalidRequest('/args', jsonTypeName(req['args']), 'object', 'args must be an object'),
      };
    }
    args = req['args'];
  }
  return { ok: true, op: op as QueryOp, projectId, args };
}

function jsonTypeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function queryFailure(
  op: unknown,
  projectId: unknown,
  error: CommandError,
): { ok: false; op?: string; projectId?: string; error: CommandError } {
  const out: { ok: false; op?: string; projectId?: string; error: CommandError } = { ok: false, error };
  const o = echoOp(op);
  if (o !== undefined) out.op = o;
  if (typeof projectId === 'string') out.projectId = projectId;
  return out;
}

/** Per-op args validation for queries (strict; `field_*` inside args). */
function validateQueryArgs(
  op: QueryOp,
  args: Record<string, unknown> | undefined,
):
  | {
      ok: true;
      entityId?: string;
      includeSubtree?: boolean;
      limit?: number;
      offset?: number;
    }
  | { ok: false; error: import('@thirdlight/commands').CommandError } {
  if (op === 'queryProject') {
    if (args !== undefined) {
      for (const k of Object.keys(args)) {
        return {
          ok: false,
          error: fieldUnexpected(`/args/${k}`, k, 'queryProject takes no args (field absent or {})'),
        };
      }
    }
    return { ok: true };
  }
  if (args === undefined) {
    if (op === 'queryEntity') {
      return { ok: false, error: fieldMissing('/args', 'entityId') };
    }
    // queryEntities: args are entirely optional (defaults: offset 0, limit 100).
    return { ok: true };
  }
  if (op === 'queryEntity') {
    for (const k of Object.keys(args)) {
      if (k !== 'entityId' && k !== 'includeSubtree') {
        return { ok: false, error: fieldUnexpected(`/args/${k}`, k, 'entityId, includeSubtree') };
      }
    }
    if (args['entityId'] === undefined) {
      return { ok: false, error: fieldMissing('/args/entityId', 'entityId') };
    }
    if (typeof args['entityId'] !== 'string' || args['entityId'].length === 0) {
      return { ok: false, error: fieldTypeError('/args/entityId', args['entityId'], 'string') };
    }
    let includeSubtree = false;
    if (args['includeSubtree'] !== undefined) {
      if (typeof args['includeSubtree'] !== 'boolean') {
        return { ok: false, error: fieldTypeError('/args/includeSubtree', args['includeSubtree'], 'boolean') };
      }
      includeSubtree = args['includeSubtree'];
    }
    return { ok: true, entityId: args['entityId'], includeSubtree };
  }
  // queryEntities
  for (const k of Object.keys(args)) {
    if (k !== 'limit' && k !== 'offset') {
      return { ok: false, error: fieldUnexpected(`/args/${k}`, k, 'limit, offset') };
    }
  }
  let limit = 100;
  if (args['limit'] !== undefined) {
    const l = args['limit'];
    if (!isSafeInt(l)) {
      return { ok: false, error: fieldTypeError('/args/limit', l, 'integer') };
    }
    if (l < 1 || l > 1024) {
      // The §5.6 code list: `limits_exceeded` "only limit > 1024, via
      // field_value" — an argument-level rejection.
      return {
        ok: false,
        error: fieldValueType(
          '/args/limit',
          l,
          'integer 1-1024',
          'limit must be between 1 and 1024 (the M1 entity limit)',
        ),
      };
    }
    limit = l;
  }
  let offset = 0;
  if (args['offset'] !== undefined) {
    const o = args['offset'];
    if (!isSafeInt(o)) {
      return { ok: false, error: fieldTypeError('/args/offset', o, 'integer') };
    }
    if (o < 0) {
      return {
        ok: false,
        error: fieldValueType('/args/offset', o, 'integer >= 0', 'offset must be >= 0'),
      };
    }
    offset = o;
  }
  return { ok: true, limit, offset };
}

/**
 * Serve one query from the published in-memory state (commands.md §10:
 * no mutation lock; always a complete state at one acknowledged revision —
 * while paused, the last known good projection, §5.6/workspace.md §5).
 */
export function serveQuery(
  core: Core,
  op: QueryOp,
  projectId: string,
  args: Record<string, unknown> | undefined,
): QueryResult {
  if (!ID_RE.test(projectId)) {
    return queryFailure(op, projectId, invalidRequest('/projectId', projectId, 'project-model ID syntax', 'projectId must use the project-model ID syntax'));
  }
  // Project resolution precedes argument validation (the commands.md §6.1
  // step-1 order, applied to queries: a missing/unavailable project is
  // reported before any args error). Queries never trigger a re-open of a
  // released project (workspace.md §9.1) — `caller: 'query'`.
  const o = ensureSession(core, projectId, 'query');
  if (o.kind === 'not-found') return queryFailure(op, projectId, projectNotFound(projectId));
  if (o.kind === 'released') {
    return queryFailure(op, projectId, projectUnavailable('workspace_closed', null, []));
  }
  if (o.kind === 'unavailable') {
    return queryFailure(op, projectId, projectUnavailable(o.reason, o.holder, o.errors ?? []));
  }
  const s = o.session;
  if (s.mode !== 'open' || s.scene === null) {
    // Blocked (a fresh process, no last known good — workspace.md §7.5):
    // queries fail the same way as commands.
    const b = s.blocked;
    return queryFailure(op, projectId, projectUnavailable(b?.reason ?? 'envelope_invalid', null, b?.errors ?? []));
  }
  const ov = validateQueryArgs(op, args);
  if (!ov.ok) return queryFailure(op, projectId, ov.error);
  const scene = s.scene;
  if (op === 'queryProject') {
    return {
      ok: true,
      projectId,
      revision: s.revision,
      manifest: s.manifest,
      scene: {
        sceneId: scene.sceneId,
        entityCount: scene.entities.length,
        cameraId: cameraIdOf(scene),
      },
      history: depths(s.history),
      workspace: workspaceBlock(s),
    };
  }
  if (op === 'queryEntity') {
    const entityId = ov.entityId!;
    const idx = scene.entities.findIndex((e) => e.id === entityId);
    if (idx === -1) return queryFailure(op, projectId, entityNotFound(entityId));
    const entity = scene.entities[idx]!;
    const parentChain: string[] = [];
    let cur = entity.parentId;
    const byId = new Map<string, Entity>();
    for (const e of scene.entities) byId.set(e.id, e);
    while (cur !== undefined && byId.has(cur)) {
      parentChain.unshift(cur);
      cur = byId.get(cur)!.parentId;
    }
    const childIds = scene.entities.filter((e) => e.parentId === entityId).map((e) => e.id);
    const out: {
      ok: true;
      projectId: string;
      revision: number;
      entity: Entity;
      parentChain: readonly string[];
      childIds: readonly string[];
      subtree?: { count: number; entities: readonly Entity[] };
    } = {
      ok: true,
      projectId,
      revision: s.revision,
      entity,
      parentChain,
      childIds,
    };
    if (ov.includeSubtree === true) {
      const descendants = new Set<string>([entityId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const e of scene.entities) {
          if (e.parentId !== undefined && descendants.has(e.parentId) && !descendants.has(e.id)) {
            descendants.add(e.id);
            grew = true;
          }
        }
      }
      const entities = scene.entities.filter((e) => descendants.has(e.id));
      out.subtree = { count: entities.length, entities };
    }
    return out;
  }
  // queryEntities — paged in document order; offset > total ⇒ empty page.
  const total = scene.entities.length;
  const offset = ov.offset ?? 0;
  const limit = ov.limit ?? 100;
  const entities = offset >= total ? [] : scene.entities.slice(offset, offset + limit);
  return { ok: true, projectId, revision: s.revision, total, offset, limit, entities };
}

function cameraIdOf(scene: Scene): string {
  for (const e of scene.entities) {
    if (e.components.camera !== undefined) return e.id;
  }
  return '';
}

function depths(h: HistoryState): { undoDepth: number; redoDepth: number } {
  return { undoDepth: h.cursor, redoDepth: h.entries.length - h.cursor };
}