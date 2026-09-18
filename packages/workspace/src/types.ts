/**
 * Public types — the workspace service surface (dependencies.md §3:
 * `openWorkspaceService(config) → WorkspaceService`, types, `runCommand`,
 * `query`, the operator operations per workspace.md §11, `ERROR_CODES`).
 *
 * Result shapes:
 * - mutations: commands.md §5.1/§5.2 (`MutationResult` from the commands
 *   package — the sole mutation path);
 * - queries: commands.md §5.6 (last-acknowledged state; the
 *   `workspace` block carries the pause state while an external change is
 *   pending);
 * - operator operations: workspace.md §11 result shapes
 *   (`createProject`, `releaseWorkspace`, `takeoverWorkspace`,
 *   `acceptExternalState`, `discardExternalState`).
 */

import type {
  CommandError,
  HistoryDepths,
  MutationResult,
  MutationSuccess,
} from '@thirdlight/commands';
import type { Entity, Manifest } from '@thirdlight/project-model';
import type { LoadDetail } from './errors';

import type { UnavailableReason } from './errors';

// ---- configuration -----------------------------------------------------------

export interface WorkspaceServiceConfig {
  /**
   * The configured data root (workspace.md §2/§3): projects live at
   * `<root>/projects/<projectId>`. All client-facing addressing is by
   * project ID inside this root — arbitrary absolute paths are never
   * accepted (charter §4).
   */
  root: string;
  /**
   * The backend's stable per-process identity: `tb-` + 32 hex
   * (workspace.md §6.1). Generated (CSPRNG) when absent — one per
   * backend process.
   */
  backendId?: string;
  /**
   * Liveness process marker (workspace.md §6.2): a `/proc/<pid>/cmdline`
   * argv[0] containing this string ⇒ the owner process is live.
   * Default: `thirdlight`.
   */
  processMarker?: string;
  /**
   * Root of the liveness proc filesystem (workspace.md §6.2). Default
   * `/proc`; tests may point it at a controlled tree.
   */
  procRoot?: string;
  /**
   * UTC-stamp function for recovery snapshot names
   * (`scene-<UTCstamp>-<sha8>.json`). Default: the real UTC clock; tests
   * may pin the fixture stamp.
   */
  stamp?: () => string;
  /**
   * The backend's process identity for ownership records (workspace.md
   * §6.1: the owner process's PID). Default: `process.pid`.
   */
  pid?: number;
  /**
   * Canonical-seconds UTC now (`YYYY-MM-DDTHH:MM:SSZ`) for ownership
   * `openedAt` and manifest `createdAt`. Default: the real clock.
   */
  utcNow?: () => string;
  /**
   * The write-operation seam (workspace.md §5.1 fault classification).
   * Defaults to the real filesystem; tests inject controlled faults
   * (EACCES/EIO at specific steps) while the rest of the sequence still
   * runs on the real filesystem.
   */
  ops?: import('./write').WriteOps;
}

// ---- pending external change (workspace.md §7.2) -------------------------------

export interface PendingChangeInfo {
  /** SHA-256 (lowercase hex) of the foreign on-disk bytes. */
  externalHash: string;
  /** Whether the foreign bytes pass the full §4.3 validation pipeline. */
  externalValid: boolean;
  /** The true total number of validation errors. */
  externalErrorCount: number;
  /** The error objects (≤ 10 reported). */
  externalErrors: readonly LoadDetail[];
}

// ---- queries (commands.md §5.6) ------------------------------------------------

export type WorkspaceQueryInfo =
  | { writePaused: false }
  | {
      writePaused: true;
      pauseReason: 'external_change';
      pendingChange: PendingChangeInfo;
    };

export interface QueryProjectResult {
  ok: true;
  projectId: string;
  revision: number;
  /** The full normalized manifest (bounded by construction). */
  manifest: Manifest;
  scene: { sceneId: string; entityCount: number; cameraId: string };
  history: HistoryDepths;
  workspace: WorkspaceQueryInfo;
}

export interface QueryEntityResult {
  ok: true;
  projectId: string;
  revision: number;
  /** The full entity value. */
  entity: Entity;
  /** Ancestor IDs root-first, excluding the entity itself. */
  parentChain: readonly string[];
  /** Direct children in document order. */
  childIds: readonly string[];
  /** Present only when `includeSubtree` is true. */
  subtree?: { count: number; entities: readonly Entity[] };
}

export interface QueryEntitiesResult {
  ok: true;
  projectId: string;
  revision: number;
  total: number;
  offset: number;
  limit: number;
  /** The page in document order (full entity values). */
  entities: readonly Entity[];
}

export interface QueryFailure {
  ok: false;
  /** Echoed when present (first 32 chars), same convention as mutations. */
  op?: string;
  /** Echoed when a string. */
  projectId?: string;
  error: CommandError;
}

export type QueryResult =
  | QueryProjectResult
  | QueryEntityResult
  | QueryEntitiesResult
  | QueryFailure;

// ---- operator operations (workspace.md §11) ------------------------------------

/** `createProject(projectId, name)` (§8.1). */
export type CreateProjectResult =
  | { ok: true; created: true; revision: 0 }
  | { ok: true; created: false; revision: number }
  | { ok: false; error: CommandError };

/** `releaseWorkspace(projectId)` (§9.1). */
export type ReleaseResult =
  | { ok: true; revision: number; retryCleared: true }
  | { ok: false; error: CommandError };

/** `takeoverWorkspace(projectId)` (§6.4 — explicit, never automatic). */
export type TakeoverResult =
  | { ok: true; lockEpoch: number; backendId: string; pid: number }
  | { ok: false; error: CommandError };

/** `acceptExternalState(projectId)` (§7.3). */
export type AcceptResult =
  | { ok: true; revision: number; historyReset: true; retryCleared: true }
  | { ok: false; error: CommandError };

/** `discardExternalState(projectId)` (§7.3). */
export type DiscardResult =
  | { ok: true; revision: number; historyReset: true }
  | { ok: false; error: CommandError };

// ---- durable retry records (workspace.md §4.2; commands.md §7.1) ---------------

export interface RetryRecord {
  requestId: string;
  /** SHA-256 (lowercase hex) of the canonical request bytes (§6.6). */
  digest: string;
  /** The revision this command produced (per-record history metadata). */
  appliedRevision: number;
  /** The full §5.1 success payload as originally acked, `duplicated: false`. */
  result: MutationSuccess;
}

// ---- startup scan (workspace.md §10) -------------------------------------------

export interface ScanEntry {
  projectId: string;
  /**
   * - `project`: a loadable (or load-failed) project;
   * - `orphan`: no loadable manifest (reported, retained).
   */
  kind: 'project' | 'orphan';
  /** Projects only: whether the §4.3 load pipeline succeeded. */
  loadable?: boolean;
  /** The load-failure code (§4.3 / workspace §11 codes) when not loadable. */
  code?: UnavailableReason | 'manifest_invalid';
  /**
   * Interrupted creation (valid manifest, no envelope): `completed` = the
   * deterministic §8.3 completion wrote the initial envelope; `kept` = the
   * completion could not be written (the state is retained for the operator).
   */
  completion?: 'completed' | 'kept';
  /** A stale (dead-pid) ownership record was reported (no action taken). */
  staleOwnership?: boolean;
  /** Leftover `.main.json.tmp-*` files (NOT cleaned by the scan). */
  leftoverTemps?: number;
  /** Bounded human note (safe for logs). */
  note?: string;
}

export interface ScanReport {
  /** At most 100 entries (the bounded log), then a count. */
  entries: readonly ScanEntry[];
  /** The total number of project entries found. */
  total: number;
  truncated: boolean;
}

// ---- the service ----------------------------------------------------------------

export interface WorkspaceService {
  /** The backend process identity (workspace.md §6.1). */
  readonly backendId: string;

  /**
   * The full commands.md §6.1 pipeline for one mutation request — the sole
   * command executor (dependencies.md §4.3): project resolution,
   * deduplication, pause check, `applyMutation` (steps 4–6), durability
   * write, publish, acknowledge. Synchronous by construction: the
   * per-project mutation lock is the entire synchronous pipeline (one
   * mutation at a time, FIFO arrival order — commands.md §10).
   */
  runCommand(request: unknown): MutationResult;

  /**
   * Bounded queries (commands.md §4/§5.6) — no mutation lock; served from
   * the last acknowledged in-memory state (never a partial state; while
   * paused, the last known good projection with the `workspace` block).
   */
  query(request: unknown): QueryResult;

  /** Operator operation (workspace.md §8.1): create a project. */
  createProject(projectId: string, name: string): CreateProjectResult;
  /** Operator operation (workspace.md §9.1): release for maintenance. */
  releaseWorkspace(projectId: string): ReleaseResult;
  /** Operator operation (workspace.md §6.4): explicit stale-owner takeover. */
  takeoverWorkspace(projectId: string): TakeoverResult;
  /** Operator operation (workspace.md §7.3): accept the external bytes. */
  acceptExternalState(projectId: string): AcceptResult;
  /** Operator operation (workspace.md §7.3): discard the external bytes. */
  discardExternalState(projectId: string): DiscardResult;
  /**
   * The startup scan (workspace.md §10) — re-runs it. The initial scan ran
   * at `openWorkspaceService` (the report is also in `lastScan`).
   */
  scan(): ScanReport;
  /**
   * Discard all in-memory state without writing (process-exit semantics):
   * the durable state is untouched; the ownership record persists (it
   * becomes stale when the process exits — explicit takeover thereafter).
   */
  dispose(): void;

  /** The most recent scan report (initial or explicit `scan()`). */
  readonly lastScan: ScanReport;
}