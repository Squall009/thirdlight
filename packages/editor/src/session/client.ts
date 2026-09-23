/**
 * Editor session transport (sessions.md §4/§5/§6/§8/§10; packet 10).
 *
 * The browser's connection to the backend: establish the authoring session,
 * upgrade the WS channel, issue commands (delegated to the backend — the
 * browser NEVER mutates files), observe `mutation.applied`, and drive the
 * isolated play preview. The browser state is a PROJECTION of the backend
 * (the `Projection`), hydrated from full state and advanced from
 * `mutation.applied`; on any gap/conflict the client re-syncs (full re-attach +
 * `queryEntities`) and explains the failure rather than silently losing an
 * edit. The browser never writes to browser storage as the authoritative
 * project database.
 *
 * Browser-only: uses `fetch` + `WebSocket` + `location` (the DOM). The pure
 * decision logic lives in `projection.ts` / `gesture.ts` / `envelope.ts`
 * (unit-tested in Node); this module is the thin transport that drives them.
 */

import type { CommandError, ChangeData } from '@thirdlight/commands';
import {
  makeEnvelope,
  makeEstablishBody,
  makeRequestId,
  type CommandOutcome,
  type MutationResponse,
  type Origin,
} from './envelope';
import { Projection, type FullState, type ProjectedEntity } from './projection';
import { ContentProjection, type AssetView } from './content-projection';
import { PrefabProjection } from './prefab-projection';
import type { GameConfigLike } from './gameplay';
import {
  applyAssetQueryPage,
  beginImport,
  beginProjectFileImport,
  canPublish,
  cancelImport,
  committed,
  discardImport,
  frameSent,
  importFailed,
  initialImportState,
  inspectionSucceeded,
  jobUpdated,
  planAssetQuery,
  planUploadFrames,
  publishStarted,
  stageCreated,
  uploadCompleted,
  validateDropCandidate,
  type AssetImportState,
  type AssetQueryState,
  type ImportProposal,
  type ImportTarget,
} from './asset-browser';
import { Gesture, type Transform } from './gesture';
import {
  planAcknowledgeTrust,
  planPublishDeclaration,
  planPublishSource,
} from './behavior-publication';
import type { ContentJobView } from '@thirdlight/protocol';
import type { BehaviorRecord, PrefabDefinition, PropertyDeclaration } from '@thirdlight/project-model';

export interface ClientConfig {
  projectId: string;
  /** The authoring origin (also the API base; the editor is same-origin). */
  authoringOrigin: string;
  /** The separate preview origin (the play iframe base, no trailing slash). */
  previewOrigin: string;
  /** The project-scoped authoring bearer token. */
  authoringToken: string;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type SaveStatus = 'idle' | 'pending' | 'saved' | 'error';

export interface ClientUiState {
  connection: ConnectionStatus;
  save: SaveStatus;
  /** The structured error, when the last operation failed (explained, not silent). */
  error: { code: string; message: string } | null;
  /** A revision_conflict to surface in the UI (with currentRevision). */
  conflict: { currentRevision: number; expectedRevision: number; message: string } | null;
  revision: number;
  /** The backend's authoring history depths (undo/redo availability). */
  undoDepth: number;
  redoDepth: number;
  /** The project's files changed on disk; writes are paused until resolved. */
  external: { valid: boolean | null; errorCount: number | null } | null;
  /** Recent project problems (failed commands, Play/export failures, external edits), oldest first. */
  problems: readonly ProblemView[];
}

/** One folder of the game folder, as the import-from-project-folder picker shows it. */
export interface ProjectFileListing {
  dir: string;
  entries: Array<{ name: string; path: string; kind: 'dir' | 'model' | 'audio'; byteLength?: number }>;
  truncated: boolean;
}

/** One row of the content-integrity report. */
export interface IntegrityEntryView {
  assetId: string;
  version: number;
  sourceDigest: string;
  referenced: boolean;
  sourcePath?: string;
  /** A converted model's original (FBX) and whether it still has the imported bytes. */
  convertedFrom?: { format: 'fbx'; sourcePath?: string; status: 'ok' | 'missing' | 'corrupt' | 'unreadable' | 'changed' };
  status: 'ok' | 'missing' | 'corrupt' | 'unreadable' | 'changed';
}

/** One entry of the backend's problems log. */
export interface ProblemView {
  seq: number;
  at: string;
  source: 'command' | 'import' | 'compile' | 'play' | 'export' | 'workspace';
  code: string;
  message: string;
}

/** A play-start result (sessions.md §10.1 + §17.2). */
export interface PlayStartResult {
  playSessionId: string;
  /** The preview iframe base (the backend's preview origin). */
  playBase: string;
  snapshotId: string;
  revision: number;
  expiresAt: number;
  /** Packet 35: the immutable play-content locator (capability + build id). */
  playContent?: {
    contentId: string;
    buildId: string;
    path: string;
    manifestPath: string;
    expiresAt: string;
  };
}

export interface ClientCallbacks {
  onState: (s: ClientUiState) => void;
  onSceneChanged: () => void;
  onPlayStarted: (r: PlayStartResult & { snapshot: unknown }) => void;
  onPlayStopped: (reason: string) => void;
  /** The backend asks the editor to stop the play (a tool or the TTL); the editor tears the preview down and acks. */
  onPlayStopRequested?: (playSessionId: string) => void;
  /** A backend relay request for the running play (screenshot, diagnostics, input, game control/observe). */
  onRelayRequest?: (request: Record<string, unknown>) => void;
}

/** A session-scoped `sessionId` (`sess-` + 32 hex), client-generated. */
function makeSessionId(rng: () => number = Math.random): string {
  let hex = '';
  for (let i = 0; i < 32; i++) hex += Math.floor(rng() * 16).toString(16);
  return `sess-${hex}`;
}

/** The paused-external-change facts from a queryProject `workspace` block. */
function externalOf(workspace: unknown): ClientUiState['external'] {
  const w = workspace as { writePaused?: boolean; pendingChange?: { externalValid?: boolean | null; externalErrorCount?: number | null } } | null;
  if (!w || w.writePaused !== true) return null;
  return { valid: w.pendingChange?.externalValid ?? null, errorCount: w.pendingChange?.externalErrorCount ?? null };
}

/**
 * The tab's sessionId for a project: kept in sessionStorage so a reload of
 * the same tab re-attaches to its own session instead of conflicting with it.
 */
function tabSessionId(projectId: string): string {
  const key = `thirdlight.sessionId.${projectId}`;
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing !== null && /^sess-[0-9a-f]{32}$/.test(existing)) return existing;
    const fresh = makeSessionId();
    window.sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return makeSessionId();
  }
}

/** A caller-assigned opaque `assetId` (project-model §18.1.1 ID syntax). */
export function makeAssetId(rng: () => number = Math.random): string {
  let hex = '';
  for (let i = 0; i < 16; i++) hex += Math.floor(rng() * 16).toString(16);
  return `asset-${hex}`;
}

/** The bounded `queryAssets` result (commands.md §5.6). */
export interface AssetQueryResult {
  ok: true;
  projectId: string;
  revision: number;
  total: number;
  offset: number;
  limit: number;
  assets: AssetView[];
}

/** The bounded `queryPrefabs` result (commands.md §5.6, packet 28). */
export interface PrefabQueryResult {
  ok: true;
  projectId: string;
  revision: number;
  total: number;
  offset: number;
  limit: number;
  prefabs: PrefabDefinition[];
}

/** The bounded `queryBehaviors` result with `includeDeclaration` (packet 28). */
export interface BehaviorQueryResult {
  ok: true;
  projectId: string;
  revision: number;
  total: number;
  offset: number;
  limit: number;
  behaviors: BehaviorRecord[];
}

/** Merge one asset page into the cached summaries (page entries win). */
function mergeAssets(existing: readonly AssetView[], page: readonly AssetView[]): AssetView[] {
  const byId = new Map<string, AssetView>();
  for (const a of existing) byId.set(a.assetId, a);
  for (const a of page) byId.set(a.assetId, a);
  return [...byId.values()].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
}

export class SessionClient {
  readonly projection = new Projection();
  /** The additive M2 content projection (asset summaries; sessions.md §8/§19.4). */
  readonly content = new ContentProjection();
  /**
   * M2 (packet 28): the prefix/declaration projection. Definitions are the
   * capture/instantiation source; declarations are the only schema source for
   * the property controls (never behavior code).
   */
  readonly prefabs = new PrefabProjection();
  private readonly cfg: ClientConfig;
  private readonly cb: ClientCallbacks;
  private readonly sessionId: string;
  private ws: WebSocket | null = null;
  private connId: string | null = null;
  private connection: ConnectionStatus = 'idle';
  private save: SaveStatus = 'idle';
  private error: { code: string; message: string } | null = null;
  private conflict: { currentRevision: number; expectedRevision: number; message: string } | null = null;
  private disposed = false;
  private history = { undoDepth: 0, redoDepth: 0 };
  private external: ClientUiState['external'] = null;
  private problems: ProblemView[] = [];
  private selection: string[] = [];
  private historyRefreshQueued = false;
  /** Active play (the retained `play.started` snapshot + preview bridge). */
  private activePlay: (PlayStartResult & { snapshot: unknown }) | null = null;
  /** M4 (packet 70, D-63-4 repair): the playSessionId the WS
   * `play.preview.ready` was already sent for (sent exactly once per play
   * session — sessions.md §10.2). */
  private playReadySentFor: string | null = null;
  /** M4 (packet 70, D-63-4 repair): the §5.2 heartbeat timer (a WS `ping`
   * at least every 20 s; the server drops a 60 s-silent connection). */
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  /**
   * M3 (packet 56): the `content.game` block projection. Hydrated from
   * `queryGameConfig` on every full state and advanced from the SAME
   * applied `setGameConfig` change records the scene projection uses
   * (sessions.md §8 — the backend remains the sole authority).
   */
  private gameConfig: GameConfigLike | null = null;
  /** Whether the last full state read the game block (vs a v2 project). */
  private gameConfigLoaded = false;
  /**
   * M3 (packet 56): the last-known `content.settings` map. No accepted query
   * returns settings VALUES (the `queryProject` summary carries only the
   * `settingsKeys` count — commands.md §5.6), so the baseline is `null`
   * (unknown) until the session observes an applied `setSettings` change
   * (whose `next` is the full map, commands.md §5.3/§8.11). The settings
   * panel seeds from the registry defaults in the unknown case and submits
   * only the touched keys (partial semantics preserve the rest).
   */
  private settings: Record<string, unknown> | null = null;
  /** Phase 12 (b): the project tag registry (from `queryGameConfig`, then `setTags` changes). */
  private tags: { bit: number; name: string }[] = [];
  /**
   * Phase 12 (c): the scenes open in this browser (the hierarchy and the
   * viewport show them) and the active one (new root entities go there).
   * Remembered per project in localStorage; never part of the project.
   */
  private openSceneIds: string[] = [];
  private activeScene: string | null = null;

  constructor(cfg: ClientConfig, cb: ClientCallbacks, sessionId?: string) {
    this.cfg = cfg;
    this.cb = cb;
    this.sessionId = sessionId ?? tabSessionId(cfg.projectId);
  }

  get connectionStatus(): ConnectionStatus {
    return this.connection;
  }

  private emit(): void {
    this.cb.onState({
      connection: this.connection,
      save: this.save,
      error: this.error,
      conflict: this.conflict,
      revision: this.projection.revision,
      undoDepth: this.history.undoDepth,
      redoDepth: this.history.redoDepth,
      external: this.external,
      problems: this.problems,
    });
  }

  private async api<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.authoringOrigin}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.cfg.authoringToken}`,
        origin: this.cfg.authoringOrigin,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text.length === 0 ? null : JSON.parse(text);
    } catch {
      json = text;
    }
    if (!res.ok) throw { status: res.status, body: json };
    return json as T;
  }

  /** A bounded authenticated request (content routes need PUT/DELETE + raw bodies). */
  private async request<T>(path: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit | null }): Promise<T> {
    const res = await fetch(`${this.cfg.authoringOrigin}/api/v1${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${this.cfg.authoringToken}`,
        origin: this.cfg.authoringOrigin,
        ...(init.headers ?? {}),
      },
      body: init.body ?? undefined,
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = JSON.parse(await res.text());
      } catch {
        body = null;
      }
      throw { status: res.status, body };
    }
    const text = await res.text();
    return (text.length === 0 ? null : JSON.parse(text)) as T;
  }

  /** Establish the authoring session + upgrade the WS (§5.1/§4.3). */
  async connect(): Promise<void> {
    if (this.disposed) return;
    this.connection = this.connection === 'reconnecting' ? 'reconnecting' : 'connecting';
    this.emit();
    try {
      const est = await this.api<{ ok: true; sessionId: string; connId: string; wsToken: string; revision: number; entities?: unknown[] }>(
        '/sessions',
        makeEstablishBody(this.cfg.projectId, this.sessionId),
      );
      this.connId = est.connId;
      await this.fullResync();
      this.cb.onSceneChanged();
      await this.upgradeWs(est.wsToken);
      this.connection = 'connected';
      this.error = null;
      this.emit();
    } catch (e) {
      this.connection = 'disconnected';
      this.error = this.describeError(e);
      this.emit();
      // A bad token or unknown project will not fix itself by retrying.
      if (this.error.code !== 'unauthorized' && this.error.code !== 'project_not_found') this.scheduleReconnect();
    }
  }

  /** The WS upgrade (§4.3): single-use wsToken. */
  private upgradeWs(wsToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.cfg.authoringOrigin.replace(/^http/, 'ws')}/api/v1/ws?sessionId=${this.sessionId}&wsToken=${wsToken}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.startHeartbeat(); // §5.2: the client pings at least every 20 s
        if (this.selection.length > 0) this.sendRelayAck({ type: 'selection.changed', entityIds: this.selection });
        resolve();
      };
      ws.onerror = () => reject(new Error('ws upgrade failed'));
      ws.onclose = (ev) => {
        this.ws = null;
        this.stopHeartbeat();
        if (this.disposed) return;
        // Reconnect: re-establish (re-attach) + resync + re-upgrade.
        if (ev.code === 1000 || ev.reason === 'detached') {
          // a deliberate detach (re-attach elsewhere) — don't auto-reconnect a
          // stale socket over a live one.
          this.connection = 'disconnected';
          this.emit();
          return;
        }
        this.connection = 'reconnecting';
        this.emit();
        this.scheduleReconnect();
      };
      ws.onmessage = (ev) => this.onWsMessage(ev.data as string);
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 2000);
  }

  /** A full-state resync (queryEntities is the authoritative scene source). */
  async fullResync(): Promise<void> {
    // Phase 12 (c): a v4 project lists its scenes; its entities are read in
    // pages (each names its scene).
    const proj = await this.api<{ ok: boolean; revision?: number; scenes?: { sceneId: string; name: string }[]; startScenes?: string[] }>(
      `/projects/${this.cfg.projectId}/commands`,
      { op: 'queryProject', projectId: this.cfg.projectId },
    );
    const v4 = proj.ok && Array.isArray(proj.scenes);
    const page = v4 ? 16_384 : 1024;
    const entities: unknown[] = [];
    const entitySceneIds: string[] = [];
    let revision: number | null = null;
    for (let offset = 0; ; offset += page) {
      const q = await this.api<{ ok: boolean; revision: number; entities: unknown[]; total: number; entitySceneIds?: string[] }>(
        `/projects/${this.cfg.projectId}/commands`,
        { op: 'queryEntities', projectId: this.cfg.projectId, args: { limit: page, offset } },
      );
      if (!q.ok) break;
      // A page read at another revision: start over at the next full state.
      if (revision !== null && q.revision !== revision) {
        revision = null;
        break;
      }
      revision = q.revision;
      entities.push(...q.entities);
      if (q.entitySceneIds !== undefined) entitySceneIds.push(...q.entitySceneIds);
      if (entities.length >= q.total || q.entities.length === 0 || !v4) break;
    }
    if (revision !== null) {
      this.projection.hydrate({
        revision,
        entities: entities as FullState['entities'],
        ...(v4 ? { entitySceneIds, scenes: proj.scenes!, startScenes: proj.startScenes ?? [] } : {}),
      });
      this.reconcileScenes();
    }
    await this.refreshHistory();
    try {
      const pr = await this.api<{ ok: boolean; problems?: ProblemView[] }>(`/projects/${this.cfg.projectId}/problems`);
      if (pr.ok && Array.isArray(pr.problems)) {
        this.problems = pr.problems;
        this.emit();
      }
    } catch {
      // the log is advisory; live entries still arrive over the socket
    }
    // M3 (packet 56): the game block re-reads on every full state —
    // reopening the editor retains the authored game configuration
    // (authoring §A8 row 1; `null` for a v2 project or an absent block).
    try {
      const g = await this.queryGameConfig();
      if (g.ok) {
        this.gameConfig = g.game === null ? null : { ...g.game, ...(g.game.level !== undefined ? { level: { ...g.game.level } } : {}), cues: { ...g.game.cues } };
        this.gameConfigLoaded = true;
        const tags = (g as { tags?: { bit: number; name: string }[] }).tags;
        this.tags = Array.isArray(tags) ? tags.map((t) => ({ bit: t.bit, name: t.name })) : [];
      }
    } catch {
      // A missing game page is resolved by the next full state; it never
      // corrupts the scene projection.
    }
    // The additive content projection is rebuilt from the same full state
    // (sessions.md §8): a bounded `queryAssets` page, never a partial merge.
    try {
      const assets = await this.queryAssets({ limit: 128, offset: 0, includeVersions: true });
      if (assets.ok) this.content.hydrate({ assets: assets.assets });
    } catch {
      // A missing content page is resolved by the next full state; it never
      // corrupts the scene projection.
    }
    // M2 (packet 28): reopening rebuilds definitions and published
    // declarations from bounded queries — no in-memory assumption.
    try {
      const [defs, behaviors] = await Promise.all([
        this.queryPrefabs({ limit: 128, offset: 0, includeEntities: true }),
        this.queryBehaviors({ limit: 128, offset: 0, includeDeclaration: true }),
      ]);
      if (defs.ok && behaviors.ok) this.prefabs.hydrate(defs.prefabs, behaviors.behaviors);
    } catch {
      // A missing content page is resolved by the next full state.
    }
  }

  /** Re-read the backend's undo/redo depths (the history is shared with MCP). */
  private async refreshHistory(): Promise<void> {
    try {
      const q = await this.api<{ ok: boolean; history?: { undoDepth: number; redoDepth: number }; workspace?: unknown }>(
        `/projects/${this.cfg.projectId}/commands`,
        { op: 'queryProject', projectId: this.cfg.projectId, args: {} },
      );
      if (q.ok && q.history) {
        this.history = { undoDepth: q.history.undoDepth, redoDepth: q.history.redoDepth };
        this.external = externalOf(q.workspace);
        this.emit();
      }
    } catch {
      // Depths are advisory; the next applied mutation re-reads them.
    }
  }

  /** Coalesce history re-reads after a burst of applied mutations. */
  private queueHistoryRefresh(): void {
    if (this.historyRefreshQueued) return;
    this.historyRefreshQueued = true;
    queueMicrotask(() => {
      this.historyRefreshQueued = false;
      void this.refreshHistory();
    });
  }

  /** Report the editor's selection (tools can inspect what is selected). */
  setSelection(entityIds: readonly string[]): void {
    this.selection = [...entityIds].slice(0, 64);
    this.sendRelayAck({ type: 'selection.changed', entityIds: this.selection });
  }

  /** Answer a relay request over the socket (the preview's exact result). */
  sendRelayAck(frame: Record<string, unknown>): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch {
      // the backend times the relay out
    }
  }

  /** Resolve a paused external edit: load the disk version, or keep the editor's. */
  async resolveExternal(action: 'accept' | 'discard'): Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }> {
    try {
      await this.api(`/projects/${this.cfg.projectId}/external/${action}`, {});
      this.external = null;
      await this.fullResync();
      this.cb.onSceneChanged();
      this.emit();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** Handle one WS message (sessions.md §7). */
  private onWsMessage(raw: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (m.type) {
      case 'attached':
        this.connection = 'connected';
        this.emit();
        break;
      case 'mutation.applied':
        this.applyMutationApplied(m as unknown as Parameters<Projection['applyMutationApplied']>[0]);
        break;
      case 'play.started':
        this.handlePlayStarted(m as unknown as { playSessionId: string; snapshot: unknown; playContent?: PlayStartResult['playContent'] });
        break;
      case 'play.stop.request': {
        const psid = String(m.playSessionId ?? '');
        this.cb.onPlayStopRequested?.(psid);
        this.sendWsFrame({ type: 'play.stopped.ack', playSessionId: psid });
        break;
      }
      case 'play.stopped':
        this.handlePlayStopped((m as { reason?: string }).reason ?? 'request');
        break;
      case 'error':
        this.error = { code: String(m.code ?? 'error'), message: String(m.message ?? '') };
        this.emit();
        break;
      case 'workspace.externalChange':
        this.external = externalOf(m.workspace) ?? { valid: null, errorCount: null };
        this.emit();
        break;
      case 'screenshot.request':
      case 'play.diagnostics.request':
      case 'input.request':
      case 'game.control.request':
      case 'game.observe.request':
        this.cb.onRelayRequest?.(m);
        break;
      case 'problems.added': {
        const p = m.problem as ProblemView | undefined;
        if (p !== undefined && !this.problems.some((x) => x.seq === p.seq)) {
          this.problems = [...this.problems, p].slice(-50);
          this.emit();
        }
        break;
      }
      case 'workspace.resync':
        void this.fullResync().then(() => this.cb.onSceneChanged());
        break;
      default:
        break;
    }
  }

  private applyMutationApplied(ev: { requestId: string; revision: number; change: unknown; sceneId?: string }): void {
    const res = this.projection.applyMutationApplied({
      requestId: ev.requestId,
      revision: ev.revision,
      change: ev.change as ChangeData,
      ...(typeof ev.sceneId === 'string' ? { sceneId: ev.sceneId } : {}),
    });
    if (res.applied && (ev.change as ChangeData).type === 'setSceneIndex') this.reconcileScenes();
    if (res.gap) {
      // The gap rule: we missed events — resync from the backend (authoritative).
      void this.fullResync().then(() => this.cb.onSceneChanged());
      return;
    }
    if (res.applied) {
      // The content projection advances from the SAME applied change records
      // the scene projection uses (sessions.md §8); a failed or stale job
      // never reaches this path, so previous committed content is preserved.
      this.content.applyChange(ev.change as ChangeData);
      // M2 (packet 28): definitions/declarations converge from the same
      // records, so an MCP-origin edit is visible without a reload.
      this.prefabs.applyChange(ev.change as ChangeData);
      // M3 (packet 56): the game block + settings map converge from the same
      // records (the `setGameConfig` change carries the full next block or
      // `null`; the `setSettings` change carries the full next map —
      // commands.md §5.3/§8.11). An MCP-origin edit is visible without a
      // reload.
      const change = ev.change as ChangeData;
      if (change.type === 'setGameConfig') {
        this.gameConfig = change.next === null ? null : ({ ...change.next, ...(change.next.level !== undefined ? { level: { ...change.next.level } } : {}), cues: { ...change.next.cues } } as GameConfigLike);
        this.gameConfigLoaded = true;
      } else if (change.type === 'setSettings') {
        this.settings = { ...(change.next as Record<string, unknown>) };
      } else if (change.type === 'setTags') {
        this.tags = change.next.map((t) => ({ bit: t.bit, name: t.name }));
      }
      this.save = 'saved';
      this.cb.onSceneChanged();
      this.emit();
      this.queueHistoryRefresh();
    }
  }

  private handlePlayStarted(m: { playSessionId: string; snapshot: unknown; playContent?: PlayStartResult['playContent'] }): void {
    // The retained `play.started` (§7.1 one-shot delivery). The editor stores
    // it and, on the preview iframe load, hands it across the bridge.
    const base = this.activePlay ?? ({} as PlayStartResult);
    this.activePlay = {
      playSessionId: m.playSessionId,
      playBase: base.playBase ?? this.cfg.previewOrigin,
      snapshotId: base.snapshotId ?? '',
      revision: base.revision ?? 0,
      expiresAt: base.expiresAt ?? 0,
      // M4 (packet 70, D-63-7 repair): the play-content locator (contentId /
      // buildId / path) is retained — the preview bootstrap's handshake +
      // `tl.playContent.expect` gate read it from the onPlayStarted result.
      playContent: m.playContent ?? base.playContent,
      snapshot: m.snapshot,
    };
    this.cb.onPlayStarted(this.activePlay);
  }

  private handlePlayStopped(reason: string): void {
    this.activePlay = null;
    this.cb.onPlayStopped(reason);
  }

  /**
   * Issue a mutation command (delegated to the backend; the browser never
   * mutates files). Retries a LOST ack with the same requestId (idempotent);
   * a revision_conflict is surfaced (and handed to the gesture for the bounded
   * auto-rebase). Returns the authoritative revision on success.
   */
  async command(
    op: string,
    args: unknown,
    expectedRevision: number,
    requestId?: string,
    origin: Origin = { kind: 'browser', clientId: this.sessionId },
  ): Promise<{ ok: true; revision: number; createdId?: string } | { ok: false; response: MutationResponse }> {
    const rid = requestId ?? makeRequestId();
    // Phase 12 (c): a new root entity goes into the active scene (with a
    // parent, the parent's scene decides).
    if ((op === 'createEntity' || op === 'instantiatePrefab') && this.activeScene !== null && typeof args === 'object' && args !== null) {
      const a = args as Record<string, unknown>;
      if ((a['parentId'] === undefined || a['parentId'] === null) && a['sceneId'] === undefined) args = { ...a, sceneId: this.activeScene };
    }
    const env = makeEnvelope(op, this.cfg.projectId, rid, expectedRevision, args, origin);
    this.save = 'pending';
    this.emit();
    let outcome = await this.postCommand(env);
    // A lost ack retries ONCE with the same requestId (idempotent; the backend
    // either replays `duplicated:true` or executes fresh — the revision
    // advances exactly once, commands.md §7.2).
    if (outcome.status === 'lost') {
      this.save = 'pending';
      this.emit();
      outcome = await this.postCommand(env);
    }
    return this.finishCommand(outcome, expectedRevision);
  }

  private finishCommand(
    outcome: CommandOutcome,
    expectedRevision: number,
  ): { ok: true; revision: number; createdId?: string } | { ok: false; response: MutationResponse } {
    if (outcome.status === 'response') {
      const r = outcome.response;
      if (r.ok) {
        // The projection advances via the `mutation.applied` WS event (deduped
        // by requestId); the HTTP ack only drives the save status.
        this.save = 'saved';
        this.error = null;
        this.conflict = null;
        this.emit();
        const createdId = (r as { createdId?: unknown }).createdId;
        return { ok: true, revision: r.revision, ...(typeof createdId === 'string' ? { createdId } : {}) };
      }
      if (r.code === 'revision_conflict') {
        const current = r.currentRevision ?? -1;
        this.conflict = {
          currentRevision: current,
          expectedRevision,
          message: `revision conflict — the scene changed since this edit began (the backend is now at revision ${current})`,
        };
        this.save = 'error';
        this.emit();
        return { ok: false, response: r };
      }
      this.error = { code: r.code, message: r.message ?? r.code };
      this.save = 'error';
      this.emit();
      return { ok: false, response: r };
    }
    this.error = { code: 'network', message: 'the command response was lost after the single retry' };
    this.save = 'error';
    this.emit();
    return { ok: false, response: { ok: false, code: 'network', message: this.error.message } };
  }

  private async postCommand(env: ReturnType<typeof makeEnvelope>): Promise<CommandOutcome> {
    try {
      const r = await this.api<MutationResponse>(`/projects/${this.cfg.projectId}/commands`, env);
      return { status: 'response', response: r };
    } catch (e) {
      const err = e as { status?: number; body?: unknown };
      if (err.body && typeof err.body === 'object' && 'error' in (err.body as Record<string, unknown>)) {
        const body = err.body as { error: CommandError };
        const code = body.error.code;
        if (code === 'revision_conflict') {
          return {
            status: 'response',
            response: { ok: false, code: 'revision_conflict', currentRevision: (body.error as { currentRevision?: number }).currentRevision ?? 0 },
          };
        }
        // `limits_exceeded` carries the declared bound (limit/current/max,
        // commands.md §5.4) so the UI can surface the exact rejected limit
        // instead of a generic message.
        const details = body.error as { limit?: string; current?: number; max?: number };
        return {
          status: 'response',
          response: {
            ok: false,
            code,
            message: body.error.message,
            ...(details.limit !== undefined ? { limit: details.limit } : {}),
            ...(details.current !== undefined ? { current: details.current } : {}),
            ...(details.max !== undefined ? { max: details.max } : {}),
          },
        };
      }
      // A network-level failure (no response) = a lost ack.
      return { status: 'lost' };
    }
  }

  /** Start an isolated play (sessions.md §10.1). */
  async playStart(demo = false): Promise<PlayStartResult> {
    const r = await this.api<PlayStartResult>('/projects/' + this.cfg.projectId + '/play', { options: { demo } });
    this.activePlay = { ...r, snapshot: null };
    this.playReadySentFor = null; // a new play session: the ready send resets
    return r;
  }

  /** Stop the active play (sessions.md §10.3). */
  async playStop(playSessionId: string): Promise<void> {
    await this.api(`/projects/${this.cfg.projectId}/play/${playSessionId}/stop`, {});
    this.activePlay = null;
    if (this.playReadySentFor === playSessionId) this.playReadySentFor = null;
  }

  /**
   * M4 (packet 70, D-63-4 repair): send the WS `play.preview.ready` EXACTLY
   * ONCE per play session (sessions.md §10.2 — the editor presented the
   * preview and received the preview's `tl.ready`; the backend marks the play
   * `presented`, lifting the 15 s present-timeout). Idempotent per
   * playSessionId; a closed socket drops the frame (the play is then bounded
   * by the accepted present-timeout — no retry, no fabrication).
   */
  sendPlayPreviewReady(playSessionId: string): boolean {
    if (this.playReadySentFor === playSessionId) return true; // already sent
    const ok = this.sendWsFrame({ type: 'play.preview.ready', playSessionId });
    if (ok) this.playReadySentFor = playSessionId;
    return ok;
  }

  /** M4 (packet 70, D-63-4 repair — failure side): send the WS
   * `play.preview.failed` when the preview could not start (sessions.md
   * §10.2 — the editor relays the preview's `tl.error`; the backend stops the
   * play `preview_failed` instead of waiting out the 15 s present-timeout).
   * The message is truncated to the accepted ≤ 256 bound. */
  sendPlayPreviewFailed(playSessionId: string, code: string, message?: string): boolean {
    return this.sendWsFrame({
      type: 'play.preview.failed',
      playSessionId,
      code,
      ...(message !== undefined ? { message: message.slice(0, 256) } : {}),
    });
  }

  /** The one WS client→server send path (sessions.md §5.2): a strict JSON
   * text frame on the live socket. Returns false when no live socket exists
   * (the caller treats a dropped frame as bounded by the session's accepted
   * timeouts — never a fabricated ack). */
  private sendWsFrame(obj: unknown): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  /** The §5.2 heartbeat: a WS `ping` at least every 20 s while the socket is
   * live (the server replies `pong`; a 60 s-silent connection is dropped
   * `heartbeat_timeout`). M4 (packet 70, D-63-4 repair). */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.sendWsFrame({ type: 'ping' });
    }, 15_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  getActivePlay(): (PlayStartResult & { snapshot: unknown }) | null {
    return this.activePlay;
  }

  /** The entity's current transform (for a gesture's conflict rebase). */
  entityTransform(entityId: string): Transform | null {
    const e = this.projection.getEntity(entityId);
    if (!e) return null;
    return { position: e.position, rotation: e.rotation, scale: e.scale };
  }

  // ---- M3 gameplay authoring (packet 56) ---------------------------------

  /**
   * The projected `content.game` block (the `queryGameConfig` result), or
   * `null` (absent / not yet read). Advanced from full states and applied
   * `setGameConfig` change records only.
   */
  getGameConfig(): GameConfigLike | null {
    return this.gameConfig === null ? null : { ...this.gameConfig, ...(this.gameConfig.level !== undefined ? { level: { ...this.gameConfig.level } } : {}), cues: { ...this.gameConfig.cues } };
  }

  /** Whether the game block has been read from the backend (vs unknown). */
  getGameConfigLoaded(): boolean {
    return this.gameConfigLoaded;
  }

  /**
   * The last-known `content.settings` map (tracked from applied
   * `setSettings` changes; `null` until one is observed — no accepted query
   * returns settings values, so a fresh session seeds the panel from the
   * registry defaults). See the `settings` field note above.
   */
  /** Phase 12 (b): the project tag registry, ascending bit. */
  /** Phase 12 (c): the entities of the open scenes (all of them for a single-scene project). */
  visibleEntities(): ProjectedEntity[] {
    const all = this.projection.listEntities();
    if (this.projection.scenes.length === 0) return all;
    const open = new Set(this.openSceneIds);
    return all.filter((e) => e.sceneId === undefined || open.has(e.sceneId));
  }

  /** Phase 12 (c): the open scenes (in index order) and the active one; empty for a single-scene project. */
  getSceneView(): { open: readonly string[]; active: string | null } {
    return { open: this.openSceneIds, active: this.activeScene };
  }

  /** Phase 12 (c): open or close a scene in this browser (the last open scene stays open). */
  setSceneOpen(sceneId: string, open: boolean): void {
    const known = this.projection.scenes.some((r) => r.sceneId === sceneId);
    if (!known) return;
    if (open && !this.openSceneIds.includes(sceneId)) this.openSceneIds = [...this.openSceneIds, sceneId];
    if (!open && this.openSceneIds.length > 1) this.openSceneIds = this.openSceneIds.filter((id) => id !== sceneId);
    this.reconcileScenes();
    this.cb.onSceneChanged();
  }

  /** Phase 12 (c): make a scene the active one (it is opened if needed). */
  setActiveScene(sceneId: string): void {
    if (!this.projection.scenes.some((r) => r.sceneId === sceneId)) return;
    if (!this.openSceneIds.includes(sceneId)) this.openSceneIds = [...this.openSceneIds, sceneId];
    this.activeScene = sceneId;
    this.reconcileScenes();
    this.cb.onSceneChanged();
  }

  /** Keep the open/active scenes valid for the current index and remember them. */
  private reconcileScenes(): void {
    const scenes = this.projection.scenes;
    if (scenes.length === 0) {
      this.openSceneIds = [];
      this.activeScene = null;
      return;
    }
    const key = `thirdlight.scenes.${this.cfg.projectId}`;
    if (this.openSceneIds.length === 0 && this.activeScene === null) {
      try {
        const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { open?: unknown; active?: unknown } | null;
        if (saved !== null && Array.isArray(saved.open)) this.openSceneIds = saved.open.filter((x): x is string => typeof x === 'string');
        if (saved !== null && typeof saved.active === 'string') this.activeScene = saved.active;
      } catch {
        // storage blocked or corrupt: start from the start scenes
      }
    }
    const known = new Set(scenes.map((r) => r.sceneId));
    let open = this.openSceneIds.filter((id) => known.has(id));
    if (open.length === 0) open = this.projection.startScenes.filter((id) => known.has(id));
    if (open.length === 0) open = [scenes[0]!.sceneId];
    // Index order keeps the hierarchy stable.
    this.openSceneIds = scenes.map((r) => r.sceneId).filter((id) => open.includes(id));
    if (this.activeScene === null || !this.openSceneIds.includes(this.activeScene)) this.activeScene = this.openSceneIds[0]!;
    try {
      localStorage.setItem(key, JSON.stringify({ open: this.openSceneIds, active: this.activeScene }));
    } catch {
      // the choice still holds for this page
    }
  }

  getTags(): { bit: number; name: string }[] {
    return this.tags.map((t) => ({ ...t }));
  }

  getSettings(): Record<string, unknown> | null {
    return this.settings === null ? null : { ...this.settings };
  }

  /**
   * A bounded `queryGameConfig` (commands.md §4/§5.6, authoring §A6): the
   * full normalized `content.game` block or `null`; read-only.
   */
  async queryGameConfig(): Promise<{ ok: true; revision: number; game: GameConfigLike | null } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.api<{ ok: true; projectId: string; revision: number; game: GameConfigLike | null }>(
        `/projects/${this.cfg.projectId}/commands`,
        { op: 'queryGameConfig', projectId: this.cfg.projectId, args: {} },
      );
      return { ok: true, revision: r.revision, game: r.game };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** One entity with its full components (read-only). */
  async queryEntity(entityId: string): Promise<{ ok: true; entity: Record<string, unknown>; parentChain: string[] } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.api<{ ok: true; entity: Record<string, unknown>; parentChain: string[] }>(
        `/projects/${this.cfg.projectId}/commands`,
        { op: 'queryEntity', projectId: this.cfg.projectId, args: { entityId } },
      );
      return { ok: true, entity: r.entity, parentChain: r.parentChain };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** Export the current revision as a standalone web game (the admin export route). */
  async exportProject(): Promise<{ ok: true; outputDir: string; revision: number; files: number } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.api<{ ok: true; outputDir: string; revision: number; files: Record<string, number> | unknown[] }>(`/admin/projects/${this.cfg.projectId}/export`, {});
      const files = Array.isArray(r.files) ? r.files.length : typeof r.files === 'object' && r.files !== null ? Object.keys(r.files).length : 0;
      return { ok: true, outputDir: r.outputDir, revision: r.revision, files };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** The URL + headers to fetch one export as a zip (the caller turns it into a download). */
  async fetchExportZip(dir: string): Promise<Blob> {
    const res = await fetch(`${this.cfg.authoringOrigin}/api/v1/projects/${this.cfg.projectId}/exports/${encodeURIComponent(dir)}/zip`, {
      headers: { authorization: `Bearer ${this.cfg.authoringToken}` },
    });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return res.blob();
  }

  /**
   * A bounded `queryEntities` page with the `component` filter (commands.md
   * §4, packet 45/48): the page contains only entities carrying `component`,
   * still in document order. Read-only.
   */
  async queryEntitiesByComponent(
    component: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ ok: true; revision: number; total: number; entities: unknown[] } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.api<{ ok: true; projectId: string; revision: number; total: number; offset: number; limit: number; entities: unknown[] }>(
        `/projects/${this.cfg.projectId}/commands`,
        { op: 'queryEntities', projectId: this.cfg.projectId, args: { limit: options.limit ?? 1024, offset: options.offset ?? 0, component } },
      );
      return { ok: true, revision: r.revision, total: r.total, entities: r.entities };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * `setGameConfig` through the ordinary command path (authoring §A3.4):
   * `game` is the complete canonical block (create), a non-empty partial edit
   * (changed top-level fields only) or `null` (remove the block).
   */
  async setGameConfig(
    game: Record<string, unknown> | null,
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('setGameConfig', { game }, expectedRevision, requestId);
  }

  /** `setSettings` through the ordinary command path (the touched keys only). */
  async setSettings(
    settings: Record<string, number>,
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('setSettings', { settings }, expectedRevision, requestId);
  }

  /**
   * `setComponent` through the ordinary command path (the v3 union,
   * commands.md §8.10): `value` is the partial field replacement or `null`
   * (remove the add-capable component).
   */
  async setComponent(
    entityId: string,
    component: string,
    value: unknown,
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('setComponent', { entityId, component, value }, expectedRevision, requestId);
  }

  /** `createEntity` with M3 `components` (a zone / spawn creation). */
  async createGameEntity(
    args: Record<string, unknown>,
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('createEntity', args, expectedRevision, requestId);
  }

  /** `deleteEntity` through the ordinary command path (zone/spawn removal). */
  async deleteEntityCommand(
    entityId: string,
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('deleteEntity', { entityId }, expectedRevision, requestId);
  }

  // ---- M2 content browser (packet 27) -------------------------------------

  /**
   * A bounded `queryAssets` (commands.md §4/§5.6). Read-only: it carries no
   * `expectedRevision`/`requestId` and is never deduplicated.
   */
  async queryAssets(options: { limit?: number; offset?: number; includeVersions?: boolean; assetId?: string } = {}): Promise<AssetQueryResult> {
    const page = planAssetQuery(options);
    return this.api<AssetQueryResult>(`/projects/${this.cfg.projectId}/commands`, {
      op: 'queryAssets',
      projectId: this.cfg.projectId,
      args: {
        ...page,
        ...(options.includeVersions ? { includeVersions: true } : {}),
        ...(options.assetId ? { assetId: options.assetId } : {}),
      },
    });
  }

  /**
   * A bounded `queryPrefabs` (commands.md §4/§5.6). Read-only. With
   * `includeEntities` the entries are full `PrefabDefinition` values — the
   * capture/instantiation source; never bytes and never a projection.
   */
  async queryPrefabs(
    options: { limit?: number; offset?: number; includeEntities?: boolean; prefabId?: string } = {},
  ): Promise<PrefabQueryResult> {
    return this.api<PrefabQueryResult>(`/projects/${this.cfg.projectId}/commands`, {
      op: 'queryPrefabs',
      projectId: this.cfg.projectId,
      args: {
        ...planAssetQuery({ limit: options.limit, offset: options.offset }),
        ...(options.includeEntities ? { includeEntities: true } : {}),
        ...(options.prefabId ? { prefabId: options.prefabId } : {}),
      },
    });
  }

  /**
   * A bounded `queryBehaviors` (commands.md §4/§5.6). With `includeDeclaration`
   * the entries are the exact published records — the declaration data the
   * property controls are derived from. Source bytes are never returned.
   */
  async queryBehaviors(
    options: { limit?: number; offset?: number; includeDeclaration?: boolean; behaviorId?: string } = {},
  ): Promise<BehaviorQueryResult> {
    return this.api<BehaviorQueryResult>(`/projects/${this.cfg.projectId}/commands`, {
      op: 'queryBehaviors',
      projectId: this.cfg.projectId,
      args: {
        ...planAssetQuery({ limit: options.limit, offset: options.offset }),
        ...(options.includeDeclaration ? { includeDeclaration: true } : {}),
        ...(options.behaviorId ? { behaviorId: options.behaviorId } : {}),
      },
    });
  }

  // ---- M2 behavior publication (packet 34) --------------------------------

  /**
   * Stage one source container through the EXISTING non-authoritative content
   * stage route (`POST /content/stages` + the bounded frame PUTs; packet 25).
   * Staging writes no authoritative state and advances no revision. The digest
   * is computed client-side over the exact container bytes (the same SHA-256
   * the preparer binds), because no accepted query returns a behavior digest.
   */
  async stageBehaviorSource(
    bytes: Uint8Array,
  ): Promise<{ ok: true; stageId: string; digest: string; byteLength: number } | { ok: false; error: { code: string; message: string } }> {
    try {
      const stage = await this.request<{ ok: true; stageId: string; expiresAt: string }>(
        `/projects/${this.cfg.projectId}/content/stages`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
      );
      // The backend digests the staged bytes; the final frame's response
      // carries the digest (the editor never hashes locally).
      let digest: string | null = null;
      for (const frame of planUploadFrames(bytes.length)) {
        const put = await this.request<{ complete?: boolean; digest?: string }>(`/projects/${this.cfg.projectId}/content/stages/${stage.stageId}/bytes`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            'x-thirdlight-offset': String(frame.offset),
            'x-thirdlight-total': String(bytes.length),
          },
          body: bytes.slice(frame.offset, frame.offset + frame.length),
        });
        if (put.complete === true && typeof put.digest === 'string') digest = put.digest;
      }
      if (digest === null) throw new Error('the upload completed without a digest');
      return { ok: true, stageId: stage.stageId, digest, byteLength: bytes.length };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** `acknowledgeBehaviorTrust` through the ordinary command path (§3.1.8). */
  async acknowledgeBehaviorTrust(
    sourceDigest: string,
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('acknowledgeBehaviorTrust', planAcknowledgeTrust(sourceDigest), expectedRevision, requestId);
  }

  /** `publishBehavior` declaration modes through the ordinary command path (§8.8). */
  async publishBehaviorDeclaration(
    args: {
      behaviorId: string;
      displayName: string;
      mode: 'declaration-create' | 'declaration-update';
      declaration: PropertyDeclaration;
    },
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('publishBehavior', planPublishDeclaration(args), expectedRevision, requestId);
  }

  /**
   * `publishBehavior{mode:"source"}` through the ordinary command path. The
   * preparation step is the workspace's digest-bound preparation layer
   * (project-model §22.4.1); until a wire route exists for it the backend
   * returns `behavior_publication_unavailable` (`preparation_missing`), which
   * the panel surfaces verbatim instead of faking a build.
   */
  async publishBehaviorSource(
    args: {
      behaviorId: string;
      displayName: string;
      declaration: PropertyDeclaration;
      sourceDigest: string;
      sourceByteLength: number;
    },
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('publishBehavior', planPublishSource(args), expectedRevision, requestId);
  }

  /** The observed trust digests (from the projection; advanced by changes only). */
  acknowledgedDigests(): string[] {
    return this.prefabs.listTrust().map((e) => e.sourceDigest);
  }

  /** Fetch one bounded asset page and fold it into the paging state. */
  async loadAssetPage(
    state: AssetQueryState | null,
    request: Partial<{ limit: number; offset: number }> = {},
  ): Promise<{ state: AssetQueryState; assets: AssetView[] }> {
    const page = planAssetQuery(request);
    const result = await this.queryAssets({ ...page, includeVersions: true });
    if (result.ok) this.content.hydrate({ assets: mergeAssets(this.content.listAssets(), result.assets) });
    return {
      state: applyAssetQueryPage(state, { total: result.total, offset: result.offset, limit: result.limit, count: result.assets.length }),
      assets: result.assets,
    };
  }

  /** `POST /content/stages` + the bounded frame PUTs + the inspect (the §19.1 upload bounds).
   * M3 (packet 57): `kind` selects the inspector (`'audio'` = the bounded
   * PCM-WAV inspector; absent = the accepted M2 GLB inspector, byte-unchanged)
   * and `animation` requests the role-aware animated GLB profile (stages 3–6
   * validate the bindings against the staged bytes' real clip list). */
  async uploadAsset(
    bytes: Uint8Array,
    options: {
      target?: ImportTarget;
      displayName?: string | null;
      kind?: 'model' | 'audio';
      animation?: { entityId: string; roles: unknown };
      onState?: (s: AssetImportState) => void;
    } = {},
  ): Promise<{ ok: true; stageId: string; proposal: ImportProposal } | { ok: false; error: { code: string; message: string } }> {
    const target: ImportTarget = options.target ?? { mode: 'create', assetId: makeAssetId(), displayName: options.displayName ?? null };
    let state = beginImport(initialImportState, target);
    const emit = (): void => options.onState?.(state);
    emit();
    const inspectBody = JSON.stringify({
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.animation !== undefined ? { animation: options.animation } : {}),
    });
    try {
      const stage = await this.request<{ ok: true; stageId: string; expiresAt: string }>(
        `/projects/${this.cfg.projectId}/content/stages`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.displayName ? { displayName: options.displayName } : {}) },
      );
      state = stageCreated(state, stage.stageId, bytes.length);
      emit();
      for (const frame of planUploadFrames(bytes.length)) {
        await this.request(`/projects/${this.cfg.projectId}/content/stages/${stage.stageId}/bytes`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            'x-thirdlight-offset': String(frame.offset),
            'x-thirdlight-total': String(bytes.length),
          },
          body: bytes.slice(frame.offset, frame.offset + frame.length),
        });
        state = frameSent(state, frame.offset + frame.length);
        emit();
      }
      state = uploadCompleted(state);
      emit();
      const inspected = await this.request<{ ok: true; convertedFrom?: unknown; proposal: ImportProposal['proposal'] & { proposalId?: string; stageId?: string; sourceDigest?: string; sourceByteLength?: number; status?: string } }>(
        `/projects/${this.cfg.projectId}/content/stages/${stage.stageId}/inspect`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: inspectBody },
      );
      const proposal: ImportProposal = {
        stageId: stage.stageId,
        ...(inspected.convertedFrom !== undefined ? { convertedFrom: inspected.convertedFrom } : {}),
        digest: String(inspected.proposal?.sourceDigest ?? ''),
        byteLength: Number(inspected.proposal?.sourceByteLength ?? bytes.length),
        status: String(inspected.proposal?.status ?? 'ok'),
        proposal: inspected.proposal,
      };
      state = inspectionSucceeded(state, proposal);
      emit();
      if (!canPublish(state)) {
        return { ok: false, error: state.error ?? { code: 'import_rejected', message: 'the inspection result was stale' } };
      }
      return { ok: true, stageId: stage.stageId, proposal };
    } catch (e) {
      const described = this.describeError(e);
      state = importFailed(state, described);
      emit();
      return { ok: false, error: described };
    }
  }

  /**
   * One folder of the game folder (import from project folder). A project in
   * the data root has no game folder: the backend answers `path_rejected`.
   */
  async listProjectFiles(dir: string): Promise<{ ok: true; listing: ProjectFileListing } | { ok: false; error: { code: string; message: string } }> {
    try {
      const q = dir === '' ? '' : `?${new URLSearchParams({ dir }).toString()}`;
      const listing = await this.request<ProjectFileListing>(`/projects/${this.cfg.projectId}/content/project-files${q}`, { method: 'GET' });
      return { ok: true, listing };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * Import from the project folder: inspect a file of the game folder in place
   * (nothing is uploaded or copied). The proposal carries `sourcePath`, which
   * the `publishAsset` args then record.
   */
  async importProjectFile(
    sourcePath: string,
    options: { target: ImportTarget; kind: 'model' | 'audio'; displayName?: string; onState?: (s: AssetImportState) => void },
  ): Promise<{ ok: true; proposal: ImportProposal } | { ok: false; error: { code: string; message: string } }> {
    let state = beginProjectFileImport(initialImportState, options.target, sourcePath);
    const emit = (): void => options.onState?.(state);
    emit();
    try {
      const inspected = await this.request<{ ok: true; sourcePath?: string; convertedFrom?: unknown; proposal: ImportProposal['proposal'] & { sourceDigest?: string; sourceByteLength?: number; status?: string } }>(
        `/projects/${this.cfg.projectId}/content/project-files/inspect`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: sourcePath, kind: options.kind, ...(options.displayName ? { displayName: options.displayName } : {}) }),
        },
      );
      const proposal: ImportProposal = {
        stageId: null,
        ...(inspected.sourcePath !== undefined ? { sourcePath: inspected.sourcePath } : {}),
        ...(inspected.convertedFrom !== undefined ? { convertedFrom: inspected.convertedFrom } : {}),
        digest: String(inspected.proposal?.sourceDigest ?? ''),
        byteLength: Number(inspected.proposal?.sourceByteLength ?? 0),
        status: String(inspected.proposal?.status ?? 'ok'),
        proposal: inspected.proposal,
      };
      state = inspectionSucceeded(state, proposal);
      emit();
      if (!canPublish(state)) {
        return { ok: false, error: state.error ?? { code: 'import_rejected', message: 'the inspection result was stale' } };
      }
      return { ok: true, proposal };
    } catch (e) {
      const described = this.describeError(e);
      state = importFailed(state, described);
      emit();
      return { ok: false, error: described };
    }
  }

  /** The content-integrity report (a file referenced in place: ok / changed / missing). */
  async contentIntegrity(): Promise<{ ok: true; entries: IntegrityEntryView[] } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.request<{ ok: true; entries: IntegrityEntryView[] }>(`/projects/${this.cfg.projectId}/content/integrity`, { method: 'GET' });
      return { ok: true, entries: r.entries };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * M3 (packet 57): a second inspect of the SAME stage with the role-aware
   * animated GLB profile (presentation.md §41.3.3 A1–A6): the staged bytes
   * stay, the new job validates the supplied role bindings against the real
   * clip list (stages 3–6) and returns the role-aware proposal the publish
   * carries. A stale/expired result never becomes publishable (the accepted
   * job TTL rule — the caller re-stages on `stale`/`expired`).
   */
  async reinspectStageAnimation(
    stageId: string,
    animation: { entityId: string; roles: unknown },
  ): Promise<
    | { ok: true; proposal: ImportProposal }
    | { ok: false; error: { code: string; message: string } }
  > {
    try {
      const inspected = await this.request<{ ok: true; proposal: ImportProposal['proposal'] & { proposalId?: string; stageId?: string; sourceDigest?: string; sourceByteLength?: number; status?: string } }>(
        `/projects/${this.cfg.projectId}/content/stages/${stageId}/inspect`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ animation }) },
      );
      const proposal: ImportProposal = {
        stageId,
        digest: String(inspected.proposal?.sourceDigest ?? ''),
        byteLength: Number(inspected.proposal?.sourceByteLength ?? 0),
        status: String(inspected.proposal?.status ?? 'ok'),
        proposal: inspected.proposal,
      };
      return { ok: true, proposal };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** Poll one bounded job record; a stale/expired result never becomes publishable. */
  async getJob(jobId: string): Promise<ContentJobView> {
    return this.request<ContentJobView>(`/projects/${this.cfg.projectId}/content/jobs/${jobId}`, { method: 'GET' });
  }

  /** Fold a job read into the pure flow state. */
  applyJobState(state: AssetImportState, job: ContentJobView): AssetImportState {
    return jobUpdated(state, job);
  }

  /** Mark the flow publishing (the catalog updates only from `mutation.applied`). */
  markPublishing(state: AssetImportState): AssetImportState {
    return publishStarted(state);
  }

  /** Mark the flow committed after a successful `publishAsset` ack. */
  markCommitted(state: AssetImportState): AssetImportState {
    return committed(state);
  }

  /** Cancel a flow locally (the caller discards the stage through `discardStage`). */
  cancelImport(state: AssetImportState): AssetImportState {
    return cancelImport(state);
  }

  /** `DELETE /content/stages/:stageId` (non-authoritative cleanup). */
  async discardStage(stageId: string): Promise<void> {
    await this.request(`/projects/${this.cfg.projectId}/content/stages/${stageId}`, { method: 'DELETE' });
  }

  /** Reset the flow state after a discard. */
  resetImport(state: AssetImportState): AssetImportState {
    return discardImport(state);
  }

  /** Validate a dropped file before any network call. */
  validateDrop(candidate: { name: string; byteLength: number }): ReturnType<typeof validateDropCandidate> {
    return validateDropCandidate(candidate);
  }

  /**
   * The authenticated committed asset-byte read (sessions.md §16.1). This is
   * the editor's only byte path: the renderer never receives the token and the
   * adapter never fetches (it calls the injected resolver this returns).
   */
  async assetBytes(assetId: string, version: number): Promise<Uint8Array> {
    const res = await fetch(
      `${this.cfg.authoringOrigin}/api/v1/projects/${this.cfg.projectId}/content/assets/${assetId}/versions/${version}/bytes`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${this.cfg.authoringToken}`, origin: this.cfg.authoringOrigin },
      },
    );
    if (!res.ok) throw { status: res.status, body: null };
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * A descriptor resolver for the three-adapter visual path (packet 26): it
   * receives only the immutable version facts and returns the verified bytes.
   */
  assetByteResolver(): (descriptor: { assetId: string; version: number }) => Promise<Uint8Array> {
    return (descriptor) => this.assetBytes(descriptor.assetId, descriptor.version);
  }

  describeError(e: unknown): { code: string; message: string } {
    const err = e as { status?: number; body?: unknown };
    const body = err.body as { error?: { code?: string; message?: string } } | null;
    if (body?.error?.code) return { code: body.error.code, message: body.error.message ?? body.error.code };
    return { code: 'network', message: 'the backend was unreachable' };
  }

  /** Release the connection + any active play (idempotent). */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close(1000, 'editor closed');
      this.ws = null;
    }
    this.connection = 'disconnected';
    this.emit();
  }
}