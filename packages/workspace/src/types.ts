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
import type { EntityV3, GameConfig, Manifest } from '@thirdlight/project-model';
import type { LoadDetail } from './errors';

import type { UnavailableReason } from './errors';
import type {
  BlobPublishRequest,
  BlobPublishResult,
  BlobReadRequest,
  BlobReadResult,
  SourceBlobReadRequest,
  SourceBlobReadResult,
  CapturedV3ReadResult,
  ContentIntegrityResult,
  ConversionSourceResult,
  InspectProjectFileResult,
  InspectStageOptions,
  InspectStageResult,
  ProjectFileListResult,
  StageDiscardResult,
  StageInspector,
  StageRequest,
  StageResult,
} from './content-store';
import type {
  PrepareBehaviorSourceRequest,
  PrepareBehaviorSourceResult,
  PrepareLibraryDependentsResult,
  ScriptLibraryDraftCheckResult,
} from './behavior';

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
  /** Authoritative-bytes quota per project (workspace.md §13.9; default
   * 536 870 912 = 512 MiB). Deployment-configurable. */
  maxSourceBytesPerProject?: number;
  /** Device free space that must remain after a blob write (default
   * 67 108 864 = 64 MiB). */
  deviceSpaceReserveBytes?: number;
  /** Device free-space probe (default `statfs` on the data root). */
  freeSpaceBytes?: () => number;
  /** Millisecond clock for the stage TTL and abandoned-stage retention
   * (default `Date.now`; tests pin it for deterministic TTL cases). */
  now?: () => number;
  /**
   * The injected GLB inspector (packet 25; dependencies.md §4.1: `backend`
   * constructs the `asset-pipeline` inspector and injects it). The workspace
   * holds only its type and supplies the job port.
   */
  assetInspector?: StageInspector;
  /** The bounded inspection budget (default 30 000 ms). */
  inspectTimeoutMs?: number;
  /**
   * The injected behavior-source compiler (packet 33; dependencies.md §4.1:
   * `backend` constructs the `behavior-build` compiler and injects it). The
   * workspace holds only its type.
   */
  behaviorCompiler?: import('@thirdlight/behavior-build').BehaviorCompiler;
}

// ---- pending external change (workspace.md §7.2) -------------------------------

export interface PendingChangeInfo {
  /**
   * §7.2 step 4: the recovery snapshot's durable state — "ok" (durable),
   * "snapshot_failed" (the bytes were read and validated but no snapshot
   * is durable), "unreadable" (step 1 failed with a non-ENOENT error: the
   * bytes were never read).
   */
  snapshotState: 'ok' | 'snapshot_failed' | 'unreadable';
  /** SHA-256 (lowercase hex) of the foreign on-disk bytes; null while unreadable. */
  externalHash: string | null;
  /** Whether the foreign bytes pass the full §4.3 validation pipeline; null while unreadable. */
  externalValid: boolean | null;
  /** The true total number of validation errors; null while unreadable. */
  externalErrorCount: number | null;
  /** The error objects (≤ 10 reported; none while unreadable). */
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
  scene: { sceneId: string; schemaVersion: number; entityCount: number; cameraId: string };
  history: HistoryDepths;
  workspace: WorkspaceQueryInfo;
  /** Phase 12 (b): the project tag registry (ascending bit; empty when none). */
  tags?: { bit: number; name: string }[];
}

export interface QueryEntityResult {
  ok: true;
  projectId: string;
  revision: number;
  /** The full entity value. */
  entity: EntityV3;
  /** Ancestor IDs root-first, excluding the entity itself. */
  parentChain: readonly string[];
  /** Direct children in document order. */
  childIds: readonly string[];
  /** Phase 12 (b): the entity's tags by name, own and effective (own + folders above). */
  tagNames: { own: string[]; effective: string[] };
  /** Present only when `includeSubtree` is true. */
  subtree?: { count: number; entities: readonly EntityV3[] };
}

export interface QueryEntitiesResult {
  ok: true;
  projectId: string;
  revision: number;
  total: number;
  offset: number;
  limit: number;
  /** The page in document order (full entity values). */
  entities: readonly EntityV3[];
}

/** `queryGameConfig` (commands.md §3.1.11 / authoring §A6): the full normalized
 * `content.game` block, or `null` (a v2 state has no `game` key). */
export interface QueryGameConfigResult {
  ok: true;
  projectId: string;
  revision: number;
  game: GameConfig | null;
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
  | QueryGameConfigResult
  | QueryFailure;

// ---- operator operations (workspace.md §11) ------------------------------------

/** A template/sample to create a project from (see `createProjectFrom`). */
export interface ProjectSource {
  scene: unknown;
  content: unknown;
  /** sha256 hex → bytes for every blob the content references. */
  blobs: ReadonlyMap<string, Uint8Array>;
}

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
  code?: UnavailableReason | 'manifest_invalid' | 'migration_resume_required' | 'folder_unavailable';
  /** Registered projects: the folder holding the `thirdlight.json` marker. */
  folder?: string;
  /**
   * Interrupted creation (valid manifest, no envelope): `completed` = the
   * deterministic §8.3 completion wrote the initial envelope; `kept` = the
   * completion could not be written (the state is retained for the operator).
   */
  completion?: 'completed' | 'kept';
  /** A migration marker (`.thirdlight/migration.json`) with no project files:
   * the interrupted destination of a migration copy made by an earlier
   * version (the copy operators were removed in phase 9.3). Reported, never
   * auto-completed; delete the directory. */
  migration?: 'resume_required';
  /** A stale (dead-pid) ownership record was reported (no action taken). */
  staleOwnership?: boolean;
  /** Leftover temps of the project files (NOT cleaned by the scan). */
  leftoverTemps?: number;
  /** Bounded human note (safe for logs). */
  note?: string;
  /** Projects with a valid manifest: the display name and creation time. */
  name?: string;
  createdAt?: string;
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

  // ---- content storage (workspace.md §11/§13, packet 23) ---------------------

  /** `stageContent` — non-authoritative staged input (workspace.md §7.6). */
  stageContent(projectId: string, request: StageRequest): StageResult;
  /** `discardStage` — non-authoritative cleanup (workspace.md §7.6.2). */
  discardStage(projectId: string, stageId: string): StageDiscardResult;
  /**
   * `inspectStage` — the injected bounded GLB inspector over the staged bytes
   * (workspace.md §11/§13.3.1): non-authoritative proposal only, never an
   * authoring mutation; a rejected profile is `import_rejected`.
   */
  inspectStage(projectId: string, stageId: string, options?: InspectStageOptions): InspectStageResult;
  /** `publishBlob` — immutable blob publication (workspace.md §13.2, no lock). */
  publishBlob(projectId: string, request: BlobPublishRequest): BlobPublishResult;
  /**
   * `readBlob` — the only public verified byte read (workspace.md §13.5). A
   * version with a `sourcePath` is read from the game folder and verified
   * against its digest (`asset_source_missing` / `asset_source_changed`).
   */
  readBlob(projectId: string, request: BlobReadRequest): BlobReadResult;
  /** One folder of a folder project's game folder: subfolders and `.glb`/`.wav` files. */
  listProjectFiles(projectId: string, dir: string): ProjectFileListResult;
  /**
   * Inspect a file in the game folder in place ("import from project folder").
   * Nothing is copied; `publishAsset` with the returned `sourcePath` records it.
   */
  inspectProjectFile(projectId: string, sourcePath: string, options?: InspectStageOptions): InspectProjectFileResult;
  /**
   * The input of an FBX conversion: a contained game-folder file's real path
   * and current digest. Backend-internal (a host path); never sent to clients.
   */
  conversionSource(projectId: string, sourcePath: string): ConversionSourceResult;
  /** The bytes of an open stage (an uploaded file the backend converts before inspecting). */
  readStage(projectId: string, stageId: string): { ok: true; bytes: Uint8Array } | { ok: false; error: CommandError };
  /**
   * `readSourceBlob` — a digest-addressed verified read of one immutable
   * `sources/sha256/<digest>` blob (packet 35; contract-change request C35-1).
   */
  readSourceBlob(projectId: string, request: SourceBlobReadRequest): SourceBlobReadResult;
  /** `contentIntegrity` — bounded integrity report (workspace.md §13.5). */
  contentIntegrity(projectId: string): ContentIntegrityResult;
  /** `readCapturedV3` — the single acknowledged project read (the merged
   *  start scene, every scene and the content block) for the shared closure
   *  builder (packet 58, delivery.md §2.6).
   */
  readCapturedV3(projectId: string): CapturedV3ReadResult;
  /**
   * `prepareBehaviorSource` — the behavior-source preparation layer (packet 33;
   * project-model.md §22.4.1, workspace.md §13.3.1): resolve the stage / accept
   * bytes, apply the trust gate, run the INJECTED compiler, publish the
   * immutable container blob and store the digest-bound prepared record as a
   * derived cache. No lock, repeatable, changes no authoritative state.
   */
  prepareBehaviorSource(projectId: string, request: PrepareBehaviorSourceRequest): Promise<PrepareBehaviorSourceResult>;
  /**
   * Phase 23.7: compile every published behavior that imports a script
   * library against the library set a `setScriptLibrary` patch will commit
   * and file the prepared facts the command reads (no authoritative change).
   */
  prepareScriptLibraryDependents(projectId: string, patch: import('@thirdlight/project-model').ScriptLibraryPatch): Promise<PrepareLibraryDependentsResult>;
  /** Phase 23.7: compile one script library draft on its own (nothing is written). */
  checkScriptLibraryDraft(projectId: string, draft: { libraryId: string; files: { path: string; text: string }[] }): Promise<ScriptLibraryDraftCheckResult>;
  /** Phase 23.7: the compiler inputs of the project's script libraries as stored now. */
  scriptLibraryInputs(projectId: string): import('@thirdlight/behavior-build').ScriptLibraryInput[];
  /**
   * The startup scan (workspace.md §10) — re-runs it. The initial scan ran
   * at `openWorkspaceService` (the report is also in `lastScan`).
   */
  scan(): ScanReport;
  /**
   * Discard all in-memory state without writing (process-exit semantics):
   * the durable state is untouched; the ownership record persists and is
   * reclaimed automatically once this process is dead.
   */
  dispose(): void;
  /** Graceful shutdown: release every held project, then discard in-memory state. */
  close(): void;
  /** Create a new project from a template: scene + content + referenced blob bytes. */
  createProjectFrom(projectId: string, name: string, source: ProjectSource): CreateProjectResult;
  /** Register an existing project folder (holding `thirdlight.json`); idempotent for the same folder. */
  registerProject(folder: unknown): { ok: true; projectId: string; name: string; created: boolean } | { ok: false; error: CommandError };
  /** Create a project in a folder (marker + `thirdlight/` subfolder) and register it. */
  createProjectInFolder(
    folder: unknown,
    projectId: string,
    name: string,
    opts?: { engine?: import('./registry').EnginePin; source?: ProjectSource },
  ): CreateProjectResult;
  /** Forget a registered project; never deletes files. */
  unregisterProject(projectId: string): { ok: true; folder: string } | { ok: false; error: CommandError };
  /** The registered project a server path belongs to (walks up to `thirdlight.json`). */
  resolveFolder(path: unknown):
    | { ok: true; projectId: string; folder: string }
    | { ok: false; reason: 'invalid' | 'no_marker' | 'not_registered'; message: string; markerProjectId?: string; folder?: string };
  /** The registered (out-of-tree) projects. */
  registeredProjects(): Array<{ projectId: string; folder: string; projectDir: string; unavailable?: string }>;
  /** Detect an external edit of an open project's envelope now (pauses writes). */
  checkExternal(projectId: string): { ok: true; pending: boolean } | { ok: false };

  /** The most recent scan report (initial or explicit `scan()`). */
  readonly lastScan: ScanReport;
}