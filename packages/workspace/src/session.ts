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

import { resolveEntry, type RegisteredProject } from './registry';
import { mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

import { createCommandState, filterEntitiesByComponent, queryAssets, queryBehaviors, queryGameConfig, queryPrefabs } from '@thirdlight/commands';
import type { CommandError, ContentDocument, HistoryState } from '@thirdlight/commands';
import type {
  ContentCatalog,
  ContentCatalogV3,
  Entity,
  Manifest,
  Scene,
  SceneV2,
  SceneV3,
} from '@thirdlight/project-model';
import {
  normalizeScene,
  parseDocumentBytes,
  validateManifest,
  validateProjectV2,
  validateProjectV3,
} from '@thirdlight/project-model';

import {
  buildEnvelopeBytes,
  buildEnvelopeBytesV2,
  buildEnvelopeBytesV3,
  ID_RE,
  validateEnvelope,
  type RetryRecord,
} from './envelope';
import { cleanBlobTemps, cleanupStages, loadPreparedSources, type ContentConfig } from './content-store';
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
  pointerSegment,
  noPendingChange,
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
  readOwnershipRecord,
  releaseOwnership,
  reReadOwnershipHolder,
  stillHoldsOwnership,
  utcSecond,
  type ClaimInconsistentInfo,
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
  externalScene: Scene | SceneV2 | SceneV3 | null;
  /** The parsed external content block (v2/v3 only; null for a v1 envelope). */
  externalContent: ContentCatalog | ContentCatalogV3 | null;
  /** The external envelope's storageVersion (null while unreadable). */
  externalStorageVersion: 1 | 2 | 3 | null;
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
  scene: Scene | SceneV2 | SceneV3 | null;
  /** The envelope's storageVersion (1 for M1, 2 for M2, 3 for v3). */
  storageVersion: 1 | 2 | 3;
  /** The published v2/v3 content catalog; null for a storageVersion 1 project. */
  content: ContentCatalog | ContentCatalogV3 | null;
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

/** Read + strictly validate the manifest (project-model pass 1 + validator).
 * Exported for the read-only migration loader (workspace.md §14.1 reads the
 * source without claiming it). */
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
  const v = validateManifest(parsed.value);
  if (!v.ok) return { ok: false, errors: v.errors.slice(0, 10) };
  return { ok: true, manifest: v.normalized };
}

type LoadOutcome =
  | {
      kind: 'loaded';
      scene: Scene | SceneV2 | SceneV3;
      storageVersion: 1 | 2 | 3;
      content: ContentCatalog | ContentCatalogV3 | null;
      records: RetryRecord[];
      bytes: Uint8Array;
      hash: string;
    }
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
  // Step 6e — the v2 cross-block composition (workspace.md §4.3 step 6e,
  // project-model §13.1): only when scene and content both passed. The
  // manifest supplies the manifest/scene identity that all three blocks are
  // composed against; any failure is reported with its model code
  // (e.g. `asset_reference_missing`).
  if (env.storageVersion === 2) {
    const cross = validateProjectV2(manifest, env.scene, env.content);
    if (!cross.ok) {
      const first = cross.errors[0];
      return {
        kind: 'blocked',
        reason: (first === undefined ? 'scene_invalid' : (first.code as UnavailableReason)),
        errors: cross.errors.slice(0, 10),
        count: cross.errors.length,
      };
    }
  }
  // §16.4 step 5 — the v3 cross-block composition: the accepted v2
  // cross-block check plus the §23.5/§23.8-step-6 game/cue/animation
  // reference checks (`validateProjectV3`). Runs only when the scene and
  // content blocks both passed; a failure is reported with its model code
  // (`game_reference_missing`, `asset_kind_mismatch`, `zone_goal_missing`, …).
  if (env.storageVersion === 3) {
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
    storageVersion: env.storageVersion,
    content: env.content,
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
    storageVersion: loaded.storageVersion,
    content: loaded.content,
    revision: loaded.scene.revision,
    records: [...loaded.records],
    recordMap,
    lastWrittenHash: loaded.hash,
    envelopeBytes: loaded.bytes,
    history:
      loaded.content === null
        ? createCommandState(loaded.scene).history
        : createCommandState(
            loaded.scene,
            loaded.content as unknown as ContentDocument,
            manifest,
          ).history,
    ownership,
    mode: 'open',
    ownershipReverify: false,
    blocked: null,
    pendingChange: null,
    preparedSources: loadPreparedSources(thirdlightDir),
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
    storageVersion: 1,
    content: null,
    revision: 0,
    records: [],
    recordMap: new Map(),
    lastWrittenHash: '',
    envelopeBytes: EMPTY_BYTES,
    history: createCommandState(defaultScene()).history,
    ownership,
    mode: 'blocked',
    ownershipReverify: false,
    blocked,
    pendingChange: null,
    preparedSources: new Map(),
  };
}

/**
 * A fresh history for the session's published state (workspace.md §9.2
 * boundaries): a v2/v3 session builds the command state with its content
 * block and manifest so the M2/M3 ops keep their three-block validation
 * inputs (commands.md §6.1 step 5; C21-1).
 */
function freshHistory(s: ProjectSession): HistoryState {
  if (s.content === null) return createCommandState(s.scene!).history;
  return createCommandState(
    s.scene!,
    s.content as unknown as ContentDocument,
    s.manifest,
  ).history;
}

/**
 * Build the session's canonical envelope bytes at the session's
 * storageVersion: a `storageVersion` 3 project writes the v3 envelope (scene
 * + six-key content + retry, workspace.md §16.3); a `storageVersion` 2
 * project writes the v2 envelope (scene + content + retry, §4.4/§4.5); an M1
 * project writes the accepted v1 bytes unchanged. This is the ONE envelope
 * construction used by the mutation write, the release rewrite and the
 * migration copy — no second mutation path.
 */
export function envelopeBytesFor(
  storageVersion: 1 | 2 | 3,
  projectId: string,
  scene: Scene | SceneV2 | SceneV3,
  content: ContentCatalog | ContentCatalogV3 | null,
  records: readonly RetryRecord[],
): Uint8Array {
  if (storageVersion === 3 && content !== null) {
    return buildEnvelopeBytesV3(projectId, scene as SceneV3, content as ContentCatalogV3, records);
  }
  if (storageVersion === 2 && content !== null) {
    return buildEnvelopeBytesV2(projectId, scene as SceneV2, content as ContentCatalog, records);
  }
  return buildEnvelopeBytes(projectId, scene as Scene, records);
}

export function envelopeBytesForSession(
  s: ProjectSession,
  records: readonly RetryRecord[],
): Uint8Array {
  return envelopeBytesFor(s.storageVersion, s.projectId, s.scene!, s.content, records);
}

/** Open-time artifact hygiene (workspace.md §5.4/§7.6.2): the owner removes
 * leftover envelope temps and abandoned staging directories (mtime older than
 * 24 h). The staging cleanup only ever removes directories under
 * `.thirdlight/staging/` — never an authoritative path. */
function cleanOpenArtifacts(core: Core, projectDir: string, sceneDir: string, thirdlightDir: string): void {
  cleanLeftoverTemps(sceneDir, 'main.json', core.ops);
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
  let externalScene: Scene | SceneV2 | SceneV3 | null = null;
  let externalContent: ContentCatalog | ContentCatalogV3 | null = null;
  let externalStorageVersion: 1 | 2 | 3 | null = null;
  if (envRes.ok) {
    // v2/v3 envelopes additionally require the three-block composition (the
    // cross-block reference checks the envelope loader defers to the manifest
    // holder): `validateProjectV2` for v2, `validateProjectV3` for v3.
    let crossOk = s.manifest.scenes[0].id === envRes.scene.sceneId && s.manifest.id === s.projectId;
    if (crossOk && envRes.storageVersion === 2) {
      const cross = validateProjectV2(s.manifest, envRes.scene, envRes.content);
      if (!cross.ok) {
        crossOk = false;
        externalErrors = cross.errors.slice(0, 10);
      }
    } else if (crossOk && envRes.storageVersion === 3) {
      const cross = validateProjectV3(s.manifest, envRes.scene, envRes.content);
      if (!cross.ok) {
        crossOk = false;
        externalErrors = cross.errors.slice(0, 10) as readonly LoadDetail[];
      }
    }
    if (crossOk) {
      externalValid = true;
      externalScene = envRes.scene;
      externalContent = envRes.content;
      externalStorageVersion = envRes.storageVersion;
    } else if (externalErrors.length === 0) {
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
    externalContent,
    externalStorageVersion,
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
    externalContent: null,
    externalStorageVersion: null,
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
    s.history = freshHistory(s);
    return { kind: 'restored' };
  }
  if (res.failed && res.failed.onDiskState === 'new-undurable') {
    // The LKG bytes are on disk (the rename took effect); durability is
    // unproven. The foreign state is gone either way: clear the pending
    // change and un-pause (memory already equals the restored bytes).
    s.pendingChange = null;
    s.history = freshHistory(s);
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
  // The pending change is readable on every path that reaches the publish
  // below: an `unreadable` pending state is either refused or (re)established
  // from the real bytes by `rereadSceneForResolution` (which yields a
  // ReadablePendingChange). The cast records that invariant.
  let pc: ReadablePendingChange = s.pendingChange as ReadablePendingChange;
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
  // with retry.records = [] (new retry boundary), ownership unchanged. The
  // storageVersion dispatch follows the parsed external envelope (a v2/v3
  // envelope carries its content block verbatim into the rewrite).
  const newBytes = envelopeBytesFor(
    pc.externalStorageVersion ?? s.storageVersion,
    s.projectId,
    pc.externalScene,
    pc.externalContent,
    [],
  );
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
    if (res.failed.onDiskState === 'new-undurable') {
      // R5/§5.1: the rename took effect — the accepted envelope is ON
      // DISK (durability unproven). The intended state becomes the
      // RUNNING state so the running system is self-consistent (the
      // accepted revision/records/hash/history are published exactly as
      // on the success path; `lastWrittenHash` is set to the intended
      // hash on `new-undurable`, workspace.md §5.2) while the operation
      // still reports the FAILURE for unproven durability (`write_failed
      // { onDiskState: "new-undurable" }`, §5.1 — never a success ack).
      // The foreign bytes are gone from disk (retained only in the
      // recovery snapshot): the resolution is applied, so the pending
      // change is cleared and writes unpaused (§7.3: "Resolving clears
      // the pending state and unpauses writes").
      publishAcceptedExternal(s, pc, newBytes);
      return { ok: false, error: writeFailed('new-undurable', res.failed.errno) };
    }
    // `previous`: nothing was written — the pending state and the pause
    // persist across the refusal (the re-issue re-reads and re-attempts).
    return { ok: false, error: writeFailed(res.failed.onDiskState, res.failed.errno) };
  }
  // Publish (the accepted revision is whatever the external document
  // carries — an operator accept is a declared re-base, §7.3).
  publishAcceptedExternal(s, pc, newBytes);
  return { ok: true, revision: s.revision, historyReset: true, retryCleared: true };
}

/** Publish an accepted external envelope into the session (both the success
 * path and the `new-undurable` path share exactly this state transition). */
function publishAcceptedExternal(
  s: ProjectSession,
  pc: ReadablePendingChange,
  newBytes: Uint8Array,
): void {
  const scene = pc.externalScene!;
  const content = pc.externalContent;
  s.scene = scene;
  s.storageVersion = pc.externalStorageVersion ?? s.storageVersion;
  s.content = content;
  s.revision = scene.revision;
  s.records = [];
  s.recordMap = new Map();
  s.envelopeBytes = newBytes;
  s.lastWrittenHash = sha256Hex(newBytes);
  s.history =
    content === null
      ? createCommandState(scene).history
      : createCommandState(scene, content as unknown as ContentDocument, s.manifest).history;
  s.pendingChange = null;
}

/** `discardExternalState` (§7.3). */
export function discardExternal(
  core: Core,
  s: ProjectSession,
): { ok: true; revision: number; historyReset: true } | { ok: false; error: CommandError } {
  if (s.mode !== 'open' || s.pendingChange === null) {
    return { ok: false, error: noPendingChange() };
  }
  // The pending change is readable on every path that reaches the publish
  // below: an `unreadable` pending state is either refused or (re)established
  // from the real bytes by `rereadSceneForResolution` (which yields a
  // ReadablePendingChange). The cast records that invariant.
  let pc: ReadablePendingChange = s.pendingChange as ReadablePendingChange;
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
    if (res.failed.onDiskState === 'new-undurable') {
      // R5/§5.1: the rename took effect — the LKG bytes are back ON DISK
      // (durability unproven). The running state was already the LKG (the
      // discard re-wrote exactly the last known good bytes; the
      // `lastWrittenHash` is unchanged, workspace.md §5.2), so the only
      // in-memory reconciliation is the boundary the successful discard
      // publishes: history cleared (new boundary — the file was replaced
      // externally, §7.3) and the pending change resolved (the foreign
      // bytes are gone from disk — retained only in the recovery
      // snapshot; unpaused, §7.3) — while the operation still reports the
      // FAILURE for unproven durability (`write_failed { onDiskState:
      // "new-undurable" }`, §5.1 — never a success ack).
      s.history = freshHistory(s);
      s.pendingChange = null;
      return { ok: false, error: writeFailed('new-undurable', res.failed.errno) };
    }
    // `previous`: nothing was written — the pending state and the pause
    // persist across the refusal (the re-issue re-reads and re-attempts).
    return { ok: false, error: writeFailed(res.failed.onDiskState, res.failed.errno) };
  }
  // lastWrittenHash is unchanged (the same LKG bytes were re-written);
  // history is cleared (new boundary — no reconciliation, charter §6).
  s.history = freshHistory(s);
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
  // (a) Rewrite the envelope (records cleared) via W.
  const newBytes = envelopeBytesForSession(s, []);
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
    // fail closed (no release; no state changes). The pending pause gates
    // every later operation until the bytes are readable again.
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
    if (res.failed.onDiskState === 'new-undurable') {
      // R5/§5.1: the records-cleared envelope is ON DISK (the rename took
      // effect) — the in-memory state advances so the running system is
      // self-consistent (the retry records are gone from memory exactly
      // as from disk; a lost-ack retry of a pre-release command re-
      // executes and fails revision_conflict, which is safe, §9) while the
      // release still reports the failure for unproven durability.
      s.records = [];
      s.recordMap = new Map();
      s.envelopeBytes = newBytes;
      s.lastWrittenHash = newHash;
    }
    // R4: the release did not reach the record write — the project is
    // still owned and this session is still the writer (workspace.md §9:
    // no partial release), but the next operation re-verifies ownership
    // from disk first (the old session must not act on cached ownership).
    s.ownershipReverify = true;
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
  if (rel.ok) {
    // (c) The released record is DURABLE: the release tail ran (the
    // own-claim-file unlink with its by-path holder verification —
    // workspace.md §9 step 1). Discard the in-memory state (history and
    // record map): the session is a non-writer — any later command is a
    // fresh open (workspace.md §9 step 3: "not a continuation of the
    // released session"), and while released queries fail
    // project_unavailable { reason: "workspace_closed" } (§9.1).
    s.history = freshHistory(s);
    s.ownership = { ...s.ownership, state: 'released' };
    s.mode = 'released';
    return { ok: true, revision: s.revision, retryCleared: true };
  }
  if (rel.failed?.onDiskState === 'new-undurable') {
    // R4: the released record IS on disk (the rename took effect; the
    // directory flush failed — durability unproven). The moment the
    // released record is on disk the old session must not remain an
    // active writer: the release tail completed (the own-claim-file
    // unlink ran inside releaseOwnership) and the in-memory state is
    // discarded — while the operation still reports the FAILURE for
    // unproven durability (workspace.md §5.1: `write_failed
    // { onDiskState: "new-undurable" }`; the R4 acceptance: "while still
    // returning failure for unproven durability").
    s.history = freshHistory(s);
    s.ownership = { ...s.ownership, state: 'released' };
    s.mode = 'released';
    return { ok: false, error: writeFailed('new-undurable', rel.failed?.errno) };
  }
  if (rel.failed?.external !== undefined || rel.failed?.unreadable !== undefined) {
    // R4: FOREIGN OWNERSHIP OBSERVED (the record W's `external` outcome —
    // the record is no longer ours) or the record bytes are UNKNOWN
    // (`unreadable` — a non-ENOENT read failure: fail closed). The old
    // session becomes a non-writer immediately: its in-memory state is
    // discarded and the session is dropped, so every later operation is
    // a fresh open that re-evaluates ownership from disk (the old backend
    // never acts on cached ownership; no further writes from this
    // session). The release itself reports ownership_conflict (a
    // releaseWorkspace failure code, workspace.md §11) carrying the
    // foreign holder when the re-read finds a parseable owned record.
    core.sessions.delete(s.projectId);
    return {
      ok: false,
      error: ownershipConflict(reReadOwnershipHolder(s.thirdlightDir, core.ops)),
    };
  }
  // res.failed 'previous': the record write did not take effect — the
  // project is still owned and the old session is still the writer
  // (workspace.md §9: no partial release). The next operation re-verifies
  // ownership from disk first (R4 — no acting on cached ownership).
  s.ownershipReverify = true;
  return { ok: false, error: writeFailed('previous', rel.failed?.errno) };
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
        error: invalidRequest(`/${pointerSegment(k)}`, k, 'known fields: op, projectId, args (optional)', 'unknown field is not permitted (strict M1 request drops nothing)'),
      };
    }
  }
  const op = req['op'];
  if (typeof op !== 'string' || !(QUERY_OPS as readonly string[]).includes(op)) {
    return {
      ok: false,
      error: invalidRequest('/op', op, 'one of: queryProject, queryEntity, queryEntities, queryAssets, queryPrefabs, queryBehaviors, queryGameConfig', typeof op !== 'string' ? 'op must be a string query op' : 'op is not one of the known query ops'),
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
      component?: string;
    }
  | { ok: false; error: import('@thirdlight/commands').CommandError } {
  if (op === 'queryProject') {
    if (args !== undefined) {
      for (const k of Object.keys(args)) {
        return {
          ok: false,
          error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'queryProject takes no args (field absent or {})'),
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
        return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'entityId, includeSubtree') };
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
    if (k !== 'limit' && k !== 'offset' && k !== 'component') {
      return { ok: false, error: fieldUnexpected(`/args/${pointerSegment(k)}`, k, 'limit, offset, component') };
    }
  }
  // packet 45/48: the optional `component` filter (commands.md §4). Validated
  // through the pure commands helper so the accepted names live in one place.
  let component: string | undefined;
  if (args['component'] !== undefined) {
    const f = filterEntitiesByComponent([], args['component']);
    if (!f.ok) return { ok: false, error: f.error };
    component = args['component'] as string;
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
  return { ok: true, limit, offset, ...(component !== undefined ? { component } : {}) };
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
  const scene = s.scene;
  // ---- packet 25: the bounded M2 content queries (commands.md §4/§5.6) -------
  // Served from exactly the same last-acknowledged in-memory state as the M1
  // queries (never a mutation, no lock, no revision advance). The pure query
  // functions live in `commands` (the single implementation); the workspace
  // only supplies the current state.
  if (op === 'queryAssets' || op === 'queryPrefabs' || op === 'queryBehaviors' || op === 'queryGameConfig') {
    const state =
      s.content !== null
        ? createCommandState(scene, s.content as unknown as ContentDocument, s.manifest)
        : createCommandState(scene);
    const request: Record<string, unknown> = { op, projectId };
    if (args !== undefined) request['args'] = args;
    const result =
      op === 'queryAssets'
        ? queryAssets(state, request)
        : op === 'queryPrefabs'
          ? queryPrefabs(state, request)
          : op === 'queryBehaviors'
            ? queryBehaviors(state, request)
            : queryGameConfig(state, request);
    return result as unknown as QueryResult;
  }
  const ov = validateQueryArgs(op, args);
  if (!ov.ok) return queryFailure(op, projectId, ov.error);
  if (op === 'queryProject') {
    return {
      ok: true,
      projectId,
      revision: s.revision,
      manifest: s.manifest,
      scene: {
        sceneId: scene.sceneId,
        // C35-5 / sessions.md §19.x: the SCENE document's version (1/2/3),
        // never the manifest's (always 1).
        schemaVersion: scene.schemaVersion,
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
  // packet 45/48: the optional `component` filter is applied first and `total`
  // counts the filtered set (commands.md §4).
  const filtered: { ok: true; entities: readonly Entity[] } | { ok: false; error: CommandError } =
    ov.component === undefined
      ? { ok: true, entities: scene.entities }
      : (filterEntitiesByComponent(
          scene.entities as unknown as readonly { components: Record<string, unknown> }[],
          ov.component,
        ) as { ok: true; entities: readonly Entity[] } | { ok: false; error: CommandError });
  if (!filtered.ok) return queryFailure(op, projectId, filtered.error);
  const total = filtered.entities.length;
  const offset = ov.offset ?? 0;
  const limit = ov.limit ?? 100;
  const entities = offset >= total ? [] : filtered.entities.slice(offset, offset + limit);
  return { ok: true, projectId, revision: s.revision, total, offset, limit, entities } as unknown as QueryResult;
}

function cameraIdOf(scene: Scene | SceneV2 | SceneV3): string {
  for (const e of scene.entities) {
    if (e.components.camera !== undefined) return e.id;
  }
  return '';
}

function depths(h: HistoryState): { undoDepth: number; redoDepth: number } {
  return { undoDepth: h.cursor, redoDepth: h.entries.length - h.cursor };
}