/**
 * Per-project sessions — the on-demand open pipeline (workspace.md §6.2),
 * ownership (claim, takeover, release §9) and the dispatch to the storage v4
 * session (`session-v4.ts`: load, external changes and their resolutions,
 * queries).
 *
 * Only storage v4 projects are opened. A storage v3 project (one envelope,
 * `scenes/main.json`) is upgraded to v4 on open; a storage v1/v2 (M1/M2)
 * project is refused with `project_unavailable { reason:
 * "storage_version_unsupported" }` and left untouched (phase 9.3).
 *
 * A session holds the last acknowledged in-memory state (commands.md §10:
 * queries read exactly this), the durable retry records and the pending
 * external change (when writes are paused).
 */

import { resolveEntry, type RegisteredProject } from './registry';
import { mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import type { CommandError, HistoryState } from '@thirdlight/commands';
import type {
  ContentCatalogV3,
  Manifest,
  SceneV3,
  SceneV4,
  ContentCatalogV4,
} from '@thirdlight/project-model';
import {
  parseDocumentBytes,
  validateManifest,
  validateProjectV3,
} from '@thirdlight/project-model';

import { ID_RE, validateEnvelope, type RetryRecord } from './envelope';
import { cleanBlobTemps, cleanupStages, type ContentConfig } from './content-store';
import {
  invalidRequest,
  projectNotFound,
  projectUnavailable,
  staleOwnership,
  ownershipConflict,
  claimInconsistent,
  writeFailed,
  type Holder,
  type LoadDetail,
  type UnavailableReason,
} from './errors';
import {
  EMPTY_BYTES,
  cleanLeftoverTemps,
  type WriteOps,
} from './write';
import {
  claimOwnership,
  evaluateLiveness,
  evaluateOwnership,
  parseOwnershipRecord,
  readOwnershipRecord,
  reReadOwnershipHolder,
  releaseOwnership,
  stillHoldsOwnership,
  utcSecond,
  type ClaimInconsistentInfo,
  type ClaimOutcome,
  type Liveness,
  type OwnershipEval,
  type OwnershipRecord,
  type SelfIdentity,
} from './ownership';
import type { PendingChangeInfo, QueryResult } from './types';
import { cleanLeftoverTempsV4, type V4State } from './store-v4';
import {
  acceptExternalV4,
  clearRecordsV4,
  discardExternalV4,
  isV4Layout,
  legacyManifestOf,
  openV4,
  serveQueryV4,
  type OpenV4Outcome,
} from './session-v4';
import { validateManifestV2Project } from '@thirdlight/project-model';

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
  /** The external project's first start scene (canonical) when the files are valid. */
  externalScene: SceneV4 | null;
  /** The external project's content block when the files are valid. */
  externalContent: ContentCatalogV4 | null;
  /** The external project's storageVersion (null while unreadable). */
  externalStorageVersion: 4 | null;
  /** Phase 12 (c), v4: the whole external project when it validates. */
  externalV4?: V4State | null;
  /** Phase 12 (c), v4: the project file found changed. */
  externalFile?: string;
}

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
  /** The game folder (holding `thirdlight.json`) of a folder project; null in the data root. */
  gameFolder?: string | null;
  /** The v1-shaped manifest view (id, name, engine, createdAt, first start scene); the real v2 manifest is `v4.manifest`. */
  manifest: Manifest;
  /** Published (last acknowledged) first start scene; null while blocked (the whole project is `v4`). */
  scene: SceneV4 | null;
  /** Always 4: storage v4, one file per scene (v3 projects are upgraded on open). */
  storageVersion: 4;
  /** The published content catalog; null while blocked. */
  content: ContentCatalogV4 | null;
  /** The whole v4 project (scenes, files, per-file records); null while blocked. */
  v4?: V4State | null;
  /** Phase 12 (c): what the automatic v3 → v4 upgrade did at this open (for the problems log). */
  upgradeNotes?: string[];
  /** === scene.revision (0 while blocked). */
  revision: number;
  /** Published retry records (ascending appliedRevision). */
  records: RetryRecord[];
  recordMap: Map<string, RetryRecord>;
  /** One digest over the last known good project files (workspace.md §5.2). */
  lastWrittenHash: string;
  /** Unused since storage v4 (the files are in `v4.files`); always empty. */
  envelopeBytes: Uint8Array;
  history: HistoryState;
  /** The ownership record this backend holds (owned) — or null while blocked. */
  ownership: OwnershipRecord | null;
  mode: 'open' | 'released' | 'blocked';
  /**
   * R4 (2026-09-18 review): set when a release attempt did NOT durably
   * complete (a failed/incomplete record write left the session in mode
   * 'open' — workspace.md §9 "no partial release"). The session must
   * not act on the cached ownership: before serving any operation the
   * ownership record AND the claim file are re-read from disk
   * (`stillHoldsOwnership`); if the session no longer holds the project
   * (record changed underneath us, or the claim file is gone/foreign)
   * the session is dropped and every later operation is a fresh open
   * re-evaluating from disk (the R4 split-brain bound: a failed or
   * partially-applied release must not leave a live writer). Fresh
   * sessions start `false`.
   */
  ownershipReverify: boolean;
  blocked: { reason: UnavailableReason; errors: readonly LoadDetail[]; count: number } | null;
  pendingChange: PendingChange | null;
  /**
   * The digest-bound prepared behavior-source facts for this project
   * (packet 33; a derived cache, never authoritative). Loaded at open from
   * the project's `.thirdlight/derived` prepared records and extended by
   * `prepareBehaviorSource`. The command layer reads ONLY these facts for a
   * `publishBehavior{mode:"source"}` request.
   */
  preparedSources: Map<string, import('@thirdlight/behavior-build').PreparedBehaviorSource>;
}

/** The core the service shares with the session layer. */
export interface Core {
  root: string;
  projectsRoot: string;
  /** Projects stored outside the data root (id → folder), from `<root>/registry.json`. */
  registry: Map<string, RegisteredProject>;
  self: SelfIdentity;
  processMarker: string;
  procRoot: string;
  /** UTC-stamp for recovery snapshot names (config seam; real clock by default). */
  stamp: () => string;
  /** Canonical-seconds UTC now (config seam; real clock by default). */
  utcNow: () => string;
  ops: WriteOps;
  sessions: Map<string, ProjectSession>;
  /** Content-storage configuration (workspace.md §13.9): quota, device-space
   * reserve and the clock/TTL seam. */
  content: ContentConfig;
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
  // A registered project resolves to its own folder, and its children must
  // stay inside that folder; an in-tree project must stay inside the data root.
  let reg = core.registry.get(segs[0]!);
  // A folder that was missing may be back (re-read only then; an available entry keeps its realDir).
  if (reg !== undefined && reg.unavailable !== undefined) reg = refreshRegistration(core, segs[0]!);
  if (reg !== undefined && reg.unavailable !== undefined) return { ok: false };
  const base = reg !== undefined ? reg.projectDir : core.projectsRoot;
  const rest = reg !== undefined ? segs.slice(1) : segs;
  let p = base;
  if (!core.ops.dirExists(p)) return { ok: false };
  for (const seg of rest) {
    p = join(p, seg);
    if (!core.ops.dirExists(p)) return { ok: false };
  }
  const dir = p;
  let realRoot: string;
  let realFull: string;
  try {
    realRoot = realpathSync(base);
    realFull = realpathSync(dir);
  } catch {
    return { ok: false };
  }
  // A registered folder later replaced by a symlink elsewhere is not the registered project.
  if (reg !== undefined && realRoot !== reg.realDir) return { ok: false };
  const inside =
    realFull === realRoot || realFull.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  return inside ? { ok: true, dir } : { ok: false };
}

/**
 * Re-read a registered folder's marker: a folder can go missing or come back
 * while the backend runs. A folder that now resolves somewhere else (a
 * symlink swap) keeps the recorded entry, reported unavailable, so it is
 * not opened; unregister and open it again to accept the new place.
 */
export function refreshRegistration(core: Core, projectId: string): RegisteredProject | undefined {
  const reg = core.registry.get(projectId);
  if (reg === undefined) return undefined;
  const fresh = resolveEntry(reg.folder, projectId);
  if (reg.unavailable === undefined && fresh.unavailable === undefined && fresh.realDir !== reg.realDir) {
    return { ...reg, unavailable: `the project folder now resolves to ${fresh.realDir}, not ${reg.realDir}; remove it and open the folder again` };
  }
  core.registry.set(projectId, fresh);
  return fresh;
}

/** The directory a project id lives in (registered folder or `<root>/projects/<id>`). */
export function projectBaseDir(core: Core, projectId: string): string {
  const reg = core.registry.get(projectId);
  return reg !== undefined ? reg.projectDir : join(core.projectsRoot, projectId);
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
  let p = projectBaseDir(core, segs[0]!);
  for (const seg of segs.slice(1)) p = join(p, seg);
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

/** Read + strictly validate the manifest (project-model pass 1 + validator):
 * the v2 manifest of a v4 project (as its v1-shaped view) or the v1
 * manifest of a v3 project (read for the upgrade). */
export function loadManifest(
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
  return validateAnyManifest(parsed.value);
}

/**
 * Validate a parsed manifest value: a v4 project's manifest (schemaVersion
 * 2, no scene list — returned as its v1-shaped view) or a v3 project's
 * manifest (schemaVersion 1, read for the upgrade). At most 10 errors.
 */
export function validateAnyManifest(
  value: unknown,
): { ok: true; manifest: Manifest } | { ok: false; errors: readonly LoadDetail[] } {
  if ((value as { schemaVersion?: unknown } | null)?.schemaVersion === 2) {
    const v2 = validateManifestV2Project(value);
    if (!v2.ok) return { ok: false, errors: v2.errors.slice(0, 10) as unknown as readonly LoadDetail[] };
    return { ok: true, manifest: legacyManifestOf(v2.normalized, 'scene-main') };
  }
  const v = validateManifest(value);
  if (!v.ok) return { ok: false, errors: v.errors.slice(0, 10) };
  return { ok: true, manifest: v.normalized };
}

type LoadOutcome =
  | {
      kind: 'loaded';
      scene: SceneV3;
      content: ContentCatalogV3;
      records: RetryRecord[];
      bytes: Uint8Array;
    }
  | { kind: 'envelope-missing' }
  | { kind: 'blocked'; reason: UnavailableReason; errors: readonly LoadDetail[]; count: number };

/**
 * The §4.3/§16.4 load pipeline over a storage v3 project's envelope
 * (`scenes/main.json`), then the v3 cross-block composition and the
 * manifest cross-document checks (step 8, against the manifest already
 * loaded at resolution). First failure wins; a storage v1/v2 envelope is
 * `storage_version_unsupported`. READ-ONLY: no session, no ownership, no
 * writes — the open pipeline upgrades a loaded v3 project to v4; the §8.1
 * idempotent createProject probe (R15) only reads.
 */
export function loadEnvelopeV3(
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
  // §16.4 step 5 — the v3 cross-block composition: the §13.1 cross-block
  // check plus the §23.5/§23.8-step-6 game/cue/animation reference checks
  // (`validateProjectV3`). A failure is reported with its model code
  // (`game_reference_missing`, `asset_kind_mismatch`, `zone_goal_missing`, …).
  {
    const cross = validateProjectV3(manifest, env.scene, env.content);
    if (!cross.ok) {
      const first = cross.errors[0];
      return {
        kind: 'blocked',
        reason: (first === undefined ? 'scene_invalid' : (first.code as UnavailableReason)),
        errors: cross.errors.slice(0, 10) as readonly LoadDetail[],
        count: cross.errors.length,
      };
    }
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
    content: env.content,
    records: env.records,
    bytes,
  };
}

// ---- session construction --------------------------------------------------------

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
    gameFolder: core.registry.get(projectId)?.folder ?? null,
    manifest,
    scene: null,
    storageVersion: 4,
    content: null,
    v4: null,
    revision: 0,
    records: [],
    recordMap: new Map(),
    lastWrittenHash: '',
    envelopeBytes: EMPTY_BYTES,
    // A blocked session never runs a command: its history stays empty.
    history: { entries: [], cursor: 0, seq: 1 },
    ownership,
    mode: 'blocked',
    ownershipReverify: false,
    blocked,
    pendingChange: null,
    preparedSources: new Map(),
  };
}

/** Open-time artifact hygiene (workspace.md §5.4/§7.6.2): the owner removes
 * leftover envelope temps and abandoned staging directories (mtime older than
 * 24 h). The staging cleanup only ever removes directories under
 * `.thirdlight/staging/` — never an authoritative path. */
function cleanOpenArtifacts(core: Core, projectDir: string, sceneDir: string, thirdlightDir: string): void {
  cleanLeftoverTemps(sceneDir, 'main.json', core.ops);
  // Storage v4: the temps of content.json / project.json, every scene file and the journal.
  cleanLeftoverTempsV4(core.ops, projectDir, sceneDir, thirdlightDir);
  // §5.4 extended to blob temps (§13.2 rule 5): the owner removes every
  // leftover `sources/sha256/.<digest>.tmp-*`.
  cleanBlobTemps(projectDir);
  cleanupStages(core, projectDir, thirdlightDir, core.content.now());
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
  const first = ensureSessionOnce(core, projectId, caller);
  if (first.kind === 'unavailable' && first.reason === 'stale_ownership') {
    // The previous owner is PROVEN dead (same-host liveness check), so
    // reclaim the project instead of demanding a manual takeover after every
    // crash or restart. A live or unknown holder still conflicts.
    const t = takeover(core, projectId);
    if (t.ok) return ensureSessionOnce(core, projectId, caller);
  }
  return first;
}

function ensureSessionOnce(
  core: Core,
  projectId: string,
  caller: 'command' | 'query',
): OpenOutcome {
  const existing = core.sessions.get(projectId);
  if (existing !== undefined) {
    if (existing.mode === 'open') {
      // R4 (2026-09-18 review): a session that attempted a release which
      // did not durably complete must not act on the cached ownership:
      // before serving anything, re-read the ownership record AND the
      // claim file from disk; if the session no longer holds the project
      // (the record changed underneath us — released/foreign/other epoch/
      // unreadable — or the claim file is gone/foreign) the session is a
      // non-writer: its in-memory state is discarded and the session is
      // dropped, so every later operation is a fresh open re-evaluating
      // from disk (never a continuation of the old session — the R4
      // split-brain bound). A session that still verifiably holds the
      // project serves as usual (workspace.md §9: a release that failed
      // before the record write leaves the old session still the writer).
      if (
        existing.ownershipReverify === true &&
        existing.ownership !== null &&
        !stillHoldsOwnership(existing.thirdlightDir, existing.ownership, core.ops)
      ) {
        core.sessions.delete(projectId); // fall through: the fresh open below
      } else {
        return { kind: 'open', session: existing };
      }
    } else if (existing.mode === 'released') {
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
    // A v4 project (or a v3 one, upgraded on the spot).
    const v4Open = openProject(core, existing.dir, projectId, man.manifest, existing.sceneDir, existing.thirdlightDir, existing.ownership ?? releasedRecord(core));
    if (v4Open.kind === 'open') {
      core.sessions.set(projectId, v4Open.session);
      return { kind: 'open', session: v4Open.session };
    }
    existing.blocked = { reason: v4Open.reason, errors: v4Open.errors, count: v4Open.count };
    return { kind: 'unavailable', reason: v4Open.reason, holder: null, errors: v4Open.errors, count: v4Open.count };
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

  // Manifest loadability. An ABSENT manifest ⇒ the directory is not a
  // project at all (commands.md §5.4: `project_not_found` = "no project
  // directory with a loadable manifest exists at the data root"). A
  // manifest that EXISTS but fails to load is a project that exists on
  // disk yet cannot load ⇒ the workspace.md §7.5 block with the §4.3
  // step-8 code: `project_unavailable { reason: 'manifest_invalid' }`
  // (workspace.md §11: `manifest_invalid` is a permitted
  // `project_unavailable.reason`; "a project that exists on disk but
  // cannot load is exactly what project_unavailable reports"). Never a
  // throw — the model's `validateManifest` is pure and total
  // (project-model.md §12.1), so `loadManifest` always returns structured
  // errors (Gate B re-review round 1, G2).
  const man = loadManifest(core, dir);
  if (!man.ok) {
    if (!core.ops.fileExists(join(dir, MANIFEST_REL))) return { kind: 'not-found' };
    return { kind: 'unavailable', reason: 'manifest_invalid', holder: null, errors: man.errors };
  }

  // Ownership evaluation + claim (workspace.md §6.2/§6.3) — bounded re-
  // evaluation: a claim that fails against a MOVED record re-evaluates.
  let claim: ClaimOutcome | null = null;
  for (let round = 0; round < 3 && claim === null; round++) {
    const recRead = readOwnershipRecord(thirdlightDir, core.ops);
    if (recRead.kind === 'unreadable') {
      // R8a (2026-09-18 review; workspace.md §6.2/§11): a non-ENOENT
      // ownership read failure — the record's state is UNKNOWN, never
      // absent ⇒ the conservative rule resolves it to live ⇒ REFUSE
      // (no claim — a claim would overwrite unknown bytes; a live foreign
      // owner may hold the project). §11: `ownership_conflict` carries
      // holder null when no parseable owned record exists.
      return { kind: 'unavailable', reason: 'ownership_conflict', holder: null };
    }
    const recBytes = recRead.kind === 'absent' ? null : recRead.bytes;
    const ev = evaluateOwnership(recBytes, core.self, livenessFn(core));
    if (ev.action !== 'claim') {
      return evalToUnavailable(ev);
    }
    ensureThirdlightDir(thirdlightDir, core.ops);
    const c = claimOwnership({
      thirdlightDir,
      self: core.self,
      lockEpoch: ev.lockEpoch,
      liveness: livenessFn(core),
      ops: core.ops,
      previousRecord: recBytes,
      openedAt: () => core.utcNow(),
    });
    if (c.ok) {
      claim = c;
    } else if ('inconsistent' in c) {
      // The §6.3 orphan-recovery rule cannot resolve the claim file at
      // the target epoch (content unparseable/unreadable, or the holder
      // not proven dead): the documented stuck state — the open fails
      // with claim_inconsistent (holder null; nothing was claimed). The
      // operator confirms the holder is dead, removes the orphan claim
      // file, and re-issues the open (an operator file operation — no
      // backend command).
      return {
        kind: 'unavailable',
        reason: 'claim_inconsistent',
        holder: null,
        errors: [claimInconsistentDetail(c.inconsistent)],
        count: 1,
      };
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
  cleanOpenArtifacts(core, dir, sceneDir, thirdlightDir);

  // A v4 project (or a v3 one, upgraded on the spot).
  const v4Open = openProject(core, dir, projectId, man.manifest, sceneDir, thirdlightDir, claim.record);
  if (v4Open.kind === 'open') {
    core.sessions.set(projectId, v4Open.session);
    return { kind: 'open', session: v4Open.session };
  }
  const bs = blockSession(core, dir, projectId, man.manifest, claim.record, { reason: v4Open.reason, errors: v4Open.errors, count: v4Open.count }, sceneDir, thirdlightDir);
  core.sessions.set(projectId, bs);
  return { kind: 'unavailable', reason: v4Open.reason, holder: null, errors: v4Open.errors, count: v4Open.count };
}

/**
 * Open a project directory: a v4 project, or a valid v3 project upgraded to
 * v4 on the spot (storage v3 → v4, phase 12 c). A v3 project that does not
 * load, a storage v1/v2 project (`storage_version_unsupported`) or a
 * directory with neither `content.json` nor `scenes/main.json` (an
 * interrupted creation, completed by the startup scan) is blocked; nothing is
 * written for them.
 */
function openProject(
  core: Core,
  dir: string,
  projectId: string,
  manifest: Manifest,
  sceneDir: string,
  thirdlightDir: string,
  ownership: OwnershipRecord,
): OpenV4Outcome {
  if (isV4Layout(core.ops, dir)) return openV4(core, dir, projectId, sceneDir, thirdlightDir, ownership);
  const l = loadEnvelopeV3(core, sceneDir, projectId, manifest);
  if (l.kind === 'envelope-missing') {
    return { kind: 'blocked', reason: 'envelope_invalid', errors: [envelopeMissingDetail()], count: 1 };
  }
  if (l.kind === 'blocked') return l;
  return openV4(core, dir, projectId, sceneDir, thirdlightDir, ownership, {
    manifest,
    scene: l.scene,
    content: l.content,
    envelopeBytes: l.bytes,
  });
}

/** Neither `content.json` (v4) nor `scenes/main.json` (v3): an interrupted creation. */
function envelopeMissingDetail(): LoadDetail {
  return {
    code: 'envelope_invalid',
    path: '',
    message: 'the project has no content.json (an interrupted creation is completed by the startup scan, workspace.md §8.3/§10)',
    expected: 'a loadable project (content.json and its scene files)',
  };
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

/**
 * The `claim_inconsistent` payload carried by the open-path error
 * (workspace.md §11: carries the claim file path, the holder content if
 * parseable, and the liveness outcome — mapped into the `project_
 * unavailable` detail fields the open path surfaces).
 */
function claimInconsistentDetail(info: ClaimInconsistentInfo): LoadDetail {
  return {
    code: 'claim_inconsistent',
    path: info.claimFile,
    message:
      info.holderContent === null
        ? `the claim file ${info.claimFile} exists at the target epoch but its content is unparseable or unreadable — it cannot be reclaimed`
        : `the claim file ${info.claimFile}'s holder (${info.holderContent.backendId}, pid ${info.holderContent.pid}) is not proven dead (liveness: ${info.liveness}) — the orphan cannot be reclaimed`,
    found: info.holderContent,
  };
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

/** `acceptExternalState` (§7.3): the files on disk become the project (`session-v4.ts`). */
export function acceptExternal(
  core: Core,
  s: ProjectSession,
): { ok: true; revision: number; historyReset: true; retryCleared: true } | { ok: false; error: CommandError } {
  return acceptExternalV4(core, s);
}

/** `discardExternalState` (§7.3): this backend's last known files go back on disk (`session-v4.ts`). */
export function discardExternal(
  core: Core,
  s: ProjectSession,
): { ok: true; revision: number; historyReset: true } | { ok: false; error: CommandError } {
  return discardExternalV4(core, s);
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
    // R4 (2026-09-18 review): a session that attempted a release which
    // did not durably complete must not claim "we own it" from the cached
    // record: re-verify ownership from disk first (the record AND the
    // claim file); if the session no longer holds the project, drop it
    // and evaluate fresh below (the explicit takeover is exactly the
    // remedy the disk state may call for — never act on cached
    // ownership). A session that still verifiably holds the project is a
    // live owner: no takeover of a live owner, even our own.
    if (
      existing.ownershipReverify === true &&
      existing.ownership !== null &&
      !stillHoldsOwnership(existing.thirdlightDir, existing.ownership, core.ops)
    ) {
      core.sessions.delete(projectId); // fall through: the fresh path below
    } else {
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
    const recRead = readOwnershipRecord(thirdlightDir, core.ops);
    if (recRead.kind === 'unreadable') {
      // R8a (2026-09-18 review; workspace.md §6.2/§11): the record's
      // state is UNKNOWN, never absent ⇒ it cannot evaluate stale; the
      // conservative rule resolves it to live ⇒ REFUSE (no takeover —
      // only PROVEN death permits one, §6.4). §11: holder null.
      return { ok: false, error: ownershipConflict(null) };
    }
    const recBytes = recRead.kind === 'absent' ? null : recRead.bytes;
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
    //     have landed). An unreadable re-read is NOT byte-identical (the
    //     state moved / is unknown) — the next round re-evaluates (and
    //     refuses if it is still unreadable).
    const rereadRead = readOwnershipRecord(thirdlightDir, core.ops);
    const reread = rereadRead.kind === 'record' ? rereadRead.bytes : null;
    if (!bytesEqual(reread, recBytes)) continue;
    // (2) liveness again — it must still be dead.
    const staleRec = parseOwnershipRecord(recBytes);
    const lv = staleRec === null ? 'unknown' : lf(staleRec.pid, staleRec.openedAt);
    if (lv !== 'dead') continue;
    // (3) claim with lockEpoch = previous + 1.
    const claim = claimOwnership({
      thirdlightDir,
      self: core.self,
      lockEpoch: staleRec!.lockEpoch + 1,
      liveness: lf,
      ops: core.ops,
      previousRecord: recBytes,
      openedAt: () => core.utcNow(),
    });
    if (!claim.ok) {
      if ('inconsistent' in claim) {
        // The §6.3 orphan-recovery rule cannot resolve the claim file at
        // the target epoch: claim_inconsistent (holder null; nothing was
        // claimed) — the operator removes the orphan file and re-issues.
        return {
          ok: false,
          error: claimInconsistent(
            projectId,
            claim.inconsistent.claimFile,
            claim.inconsistent.holderContent,
            claim.inconsistent.liveness,
          ),
        };
      }
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
    cleanOpenArtifacts(core, dir, sceneDir, thirdlightDir);
    // A v4 project (or a v3 one, upgraded on the spot) — the same branch as
    // the fresh open and `performClaimAndLoad`.
    const v4Open = openProject(core, dir, projectId, man.manifest, sceneDir, thirdlightDir, claim.record);
    if (v4Open.kind === 'open') {
      core.sessions.set(projectId, v4Open.session);
      return { ok: true, lockEpoch: claim.record.lockEpoch, backendId: core.self.backendId, pid: core.self.pid };
    }
    core.sessions.set(projectId, blockSession(core, dir, projectId, man.manifest, claim.record, { reason: v4Open.reason, errors: v4Open.errors, count: v4Open.count }, sceneDir, thirdlightDir));
    return { ok: false, error: projectUnavailable(v4Open.reason, null, v4Open.errors) };
  }
  // The bounded re-evaluation loop did not converge (oscillating external
  // writer): report the current evaluation.
  const recRead = readOwnershipRecord(thirdlightDir, core.ops);
  if (recRead.kind === 'unreadable') {
    // R8a (workspace.md §6.2/§11): unknown record state ⇒ refuse
    // (never absent — §11: holder null).
    return { ok: false, error: ownershipConflict(null) };
  }
  const ev = evaluateOwnership(recRead.kind === 'absent' ? null : recRead.bytes, core.self, lf);
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
    const c = claimOwnership({
      thirdlightDir,
      self: core.self,
      lockEpoch,
      liveness: lf,
      ops: core.ops,
      previousRecord: existingBytes,
      openedAt: () => core.utcNow(),
    });
    if (c.ok) {
      claim = c;
      break;
    }
    if ('inconsistent' in c) {
      // The §6.3 orphan-recovery rule cannot resolve the claim file at
      // the target epoch: claim_inconsistent (holder null; nothing was
      // claimed).
      return {
        ok: false,
        error: claimInconsistent(
          projectId,
          c.inconsistent.claimFile,
          c.inconsistent.holderContent,
          c.inconsistent.liveness,
        ),
      };
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
  cleanOpenArtifacts(core, dir, sceneDir, thirdlightDir);
  // A v4 project (or a v3 one, upgraded on the spot).
  const v4Open = openProject(core, dir, projectId, manifest, sceneDir, thirdlightDir, claim.record);
  if (v4Open.kind === 'open') {
    core.sessions.set(projectId, v4Open.session);
    return { ok: true, lockEpoch: claim.record.lockEpoch, backendId: core.self.backendId, pid: core.self.pid };
  }
  core.sessions.set(projectId, blockSession(core, dir, projectId, manifest, claim.record, { reason: v4Open.reason, errors: v4Open.errors, count: v4Open.count }, sceneDir, thirdlightDir));
  return { ok: false, error: projectUnavailable(v4Open.reason, null, v4Open.errors) };
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
 * command must not replay across the boundary), then rewrite the
 * ownership record with state "released" (the same W primitive; the file
 * is never deleted), then unlink the owner's own claim file (verified by
 * path — workspace.md §9 step 1) and discard the in-memory state.
 *
 * R4 (2026-09-18 review): every ownership-write outcome is handled
 * explicitly (ok / failed / external / unreadable / new-undurable). The
 * moment the released record is on disk (`ok` or `new-undurable` — the
 * rename took effect) or foreign ownership is observed (`external`, or an
 * unreadable record — fail closed), the session becomes a NON-WRITER: its
 * in-memory state is discarded and, in the foreign-observation case, the
 * session is dropped so every later operation is a fresh open
 * re-evaluating from disk (never a continuation of the released session —
 * the R4 split-brain bound). The failure for unproven durability is still
 * reported (`write_failed { onDiskState: "new-undurable" }`, §5.1). A
 * release that fails before the record write (`previous`) leaves the
 * project owned with the old session still the writer (no partial
 * release) — but the session is flagged so the next operation re-verifies
 * ownership from disk first.
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
  // A v4 project clears the records in each of its files, then marks the
  // ownership record released.
  const cleared = clearRecordsV4(core, s);
  if (!cleared.ok) {
    s.ownershipReverify = true;
    return cleared;
  }
  if (s.ownership === null) return { ok: false, error: ownershipConflict(null) };
  const relV4 = releaseOwnership(s.thirdlightDir, s.ownership, core.ops);
  if (relV4.ok) {
    s.ownership = { ...s.ownership, state: 'released' };
    s.mode = 'released';
    return { ok: true, revision: s.revision, retryCleared: true };
  }
  s.ownershipReverify = true;
  if (relV4.failed.external === true) {
    // Foreign ownership observed (the record is no longer ours): report the
    // holder found on disk; the next operation re-verifies from disk.
    return { ok: false, error: ownershipConflict(reReadOwnershipHolder(s.thirdlightDir, core.ops)) };
  }
  return { ok: false, error: writeFailed(relV4.failed.onDiskState ?? 'previous', relV4.failed.errno) };
}

/**
 * Graceful-shutdown release: mark the ownership record released WITHOUT
 * rewriting the envelope, so retry records survive and a client that lost
 * an ack can still replay it against the next backend. Best effort: on any
 * failure the record stays owned and the next backend reclaims it once this
 * process is dead.
 */
export function releaseOnShutdown(core: Core, s: ProjectSession): void {
  if (s.mode !== 'open' || s.ownership === null) return;
  const rel = releaseOwnership(s.thirdlightDir, s.ownership, core.ops);
  if (rel.ok || rel.failed?.onDiskState === 'new-undurable') {
    s.ownership = { ...s.ownership, state: 'released' };
    s.mode = 'released';
  }
}

// ---- query serving (commands.md §5.6) ------------------------------------------------

function echoOp(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > 32 ? v.slice(0, 32) : v;
}

const QUERY_OPS = [
  'queryProject',
  'queryEntity',
  'queryEntities',
  // packet 25: the bounded M2 content queries (commands.md §4) are served
  // through the same query path (last acknowledged state, never a mutation).
  'queryAssets',
  'queryPrefabs',
  'queryBehaviors',
  // packet 48 / authoring §A6 (commands.md §3.1.11): the v3 game-config query
  // is the same read path (wiring completed by the coordinator repair; the
  // pure function is `commands`' single implementation).
  'queryGameConfig',
] as const;
type QueryOp = (typeof QUERY_OPS)[number];

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
  // A v4 project (several scenes) is served by the v4 queries.
  if (s.v4 === null || s.v4 === undefined) {
    return queryFailure(op, projectId, projectUnavailable('envelope_invalid', null, []));
  }
  return serveQueryV4(s, op, projectId, args, workspaceBlock(s));
}
