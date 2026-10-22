/**
 * Editor session transport, its core.
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
 * decision logic is in `projection.ts` / `gesture.ts` / `envelope.ts`
 * (unit-tested in Node); this module is the thin transport that drives them.
 *
 * The core keeps the connection, the projection and the command path; the
 * project operations over HTTP (content, assets, behaviors, bakes, project
 * files) are the `SessionClient` subclass in `client.ts`. The parts: the
 * content copy it extends (`project-state.ts`), the socket
 * (`session-socket.ts`), the command path (`command-sender.ts`), the play
 * link (`play-link.ts`) and the open scenes (`open-scenes.ts`).
 */

import type { BlockChunk, BlockLayerComponent, BlockRegion, DescriptorRegistry, EnvironmentConfig, SceneEnvironment } from '@thirdlight/project-model';
import type { ChangeData, FootprintChunks } from '@thirdlight/commands';
import { makeEstablishBody, type Origin } from './envelope';
import { Projection, type FullState, type ProjectedEntity } from './projection';
import { ContentProjection, type AssetView } from './content-projection';
import { PrefabProjection } from './prefab-projection';
import { Catalog } from './catalog';
import { planAssetQuery } from './asset-browser';
import { type Transform } from './gesture';
import { type CompileDiagnosticView } from './behavior-publication';
import { fromWireChange } from '@thirdlight/protocol';
import type { BehaviorRecord, DialogueDocument, PrefabDefinition, TrustEntry } from '@thirdlight/project-model';
import { ASSET_QUERY_PAGE_MAX } from '@thirdlight/project-model/limits';
import { SessionProjectState, type BlockLayerView } from './project-state';
import { SessionSocket } from './session-socket';
import { CommandSender, type CommandResult, type CommandStatus } from './command-sender';
import { PlayLink, type ActivePlay, type PlayStartResult, type PlayStartedFrame } from './play-link';
import { OpenScenes } from './open-scenes';

export type { BlockLayerView } from './project-state';
export type { CommandResult, CommandResultOk } from './command-sender';
export type { PlayStartResult } from './play-link';

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
  entries: Array<{ name: string; path: string; kind: 'dir' | 'model' | 'audio' | 'texture' | 'font'; byteLength?: number }>;
  truncated: boolean;
}

/** One row of the content-integrity report. */
export interface IntegrityEntryView {
  assetId: string;
  version: number;
  sourceDigest: string;
  referenced: boolean;
  sourcePath?: string;
  /** A converted asset's original (FBX, or the PNG/JPEG of a KTX2) and whether it still has the imported bytes. */
  convertedFrom?: { format: string; sourcePath?: string; status: 'ok' | 'missing' | 'corrupt' | 'unreadable' | 'changed' };
  status: 'ok' | 'missing' | 'corrupt' | 'unreadable' | 'changed';
}

/** What the backend's file check did: moved files found by their sidecars, changed files imported again, the import cache made whole. */
export interface FileCheckView {
  relocated: { assetId: string; from: string | null; to: string }[];
  /** With the file's digest before and after (the Problems log says the same in a line each). */
  reimported: { assetId: string; file: string; version: number; reason: 'file_changed' | 'converted_again'; oldDigest: string; newDigest: string }[];
  rebuilt: { assetId: string; file: string }[];
  failed: { assetId: string; file: string | null; code: string; message: string }[];
  sidecarProblems: string[];
}

/** One entry of the backend's problems log. */
export interface ProblemView {
  seq: number;
  at: string;
  source: 'command' | 'import' | 'compile' | 'play' | 'export' | 'workspace';
  code: string;
  message: string;
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

/** A caller-assigned opaque `assetId` (in the project model's ID syntax). */
export function makeAssetId(rng: () => number = Math.random): string {
  let hex = '';
  for (let i = 0; i < 16; i++) hex += Math.floor(rng() * 16).toString(16);
  return `asset-${hex}`;
}

/** The bounded `queryAssets` result. */
export interface AssetQueryResult {
  ok: true;
  projectId: string;
  revision: number;
  total: number;
  offset: number;
  limit: number;
  assets: AssetView[];
}

/** The bounded `queryPrefabs` result. */
export interface PrefabQueryResult {
  ok: true;
  projectId: string;
  revision: number;
  total: number;
  offset: number;
  limit: number;
  prefabs: PrefabDefinition[];
}

/** The bounded `queryBehaviors` result with `includeDeclaration`. */
export interface BehaviorQueryResult {
  ok: true;
  projectId: string;
  revision: number;
  total: number;
  offset: number;
  limit: number;
  behaviors: BehaviorRecord[];
  /** With `includeTrust`: every acknowledged script source. */
  trust?: TrustEntry[];
}


export class SessionClientCore extends SessionProjectState {
  readonly projection = new Projection();
  /** The additive content projection (asset summaries). */
  readonly content = new ContentProjection();
  /**
   * The prefix/declaration projection. Definitions are the
   * capture/instantiation source; declarations are the only schema source for
   * the property controls (never behavior code).
   */
  readonly prefabs = new PrefabProjection();
  /**
   * The project catalog at any size: index pages for lists, pickers and
   * search, and the records read by id into `content`, `prefabs` and the
   * conversations (catalog.ts).
   */
  readonly catalog: Catalog = new Catalog((op, args) => this.api<Record<string, unknown>>(`/projects/${this.cfg.projectId}/commands`, { op, projectId: this.cfg.projectId, args }), {
    assets: this.content,
    prefabs: this.prefabs,
    resources: {
      has: (kind, id) => kind === 'dialogue' && this.dialogues.some((d) => d.dialogueId === id),
      put: (kind, records) => {
        if (kind !== 'dialogue') return;
        const byId = new Map(this.dialogues.map((d) => [d.dialogueId, d] as const));
        for (const r of records) byId.set(String(r['dialogueId']), structuredClone(r) as unknown as DialogueDocument);
        this.dialogues = [...byId.values()].sort((a, b) => (a.dialogueId < b.dialogueId ? -1 : 1));
      },
    },
  });
  protected readonly cfg: ClientConfig;
  private readonly cb: ClientCallbacks;
  protected readonly sessionId: string;
  private readonly socket = new SessionSocket({
    opened: () => {
      if (this.selection.length > 0) this.sendRelayAck({ type: 'selection.changed', entityIds: this.selection });
    },
    message: (raw) => this.onWsMessage(raw),
    closed: (ev) => this.socketClosed(ev),
  });
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
  private reconnectTimer: number | null = null;
  private readonly scenes: OpenScenes;
  private readonly play: PlayLink;
  private readonly commands: CommandSender;
  /**
   * The folder of the game folder new scenes and resources go into (as
   * Unity's Create menu uses the project window's current folder); empty:
   * each kind's default folder. A view setting, never part of the project.
   */
  private newItemFolder = '';

  get newResourceFolder(): string {
    return this.newItemFolder;
  }

  setNewResourceFolder(folder: string): void {
    this.newItemFolder = folder.trim().replace(/\/+$/, '');
  }

  constructor(cfg: ClientConfig, cb: ClientCallbacks, sessionId?: string) {
    super();
    this.cfg = cfg;
    this.cb = cb;
    this.sessionId = sessionId ?? tabSessionId(cfg.projectId);
    this.scenes = new OpenScenes(this.projection, cfg.projectId);
    this.play = new PlayLink({
      projectId: cfg.projectId,
      previewOrigin: cfg.previewOrigin,
      get: (path) => this.api(path),
      send: (frame) => this.socket.send(frame),
      started: (play) => this.cb.onPlayStarted(play),
      stopped: (reason) => this.cb.onPlayStopped(reason),
      snapshotFailed: (playSessionId, message) => {
        this.error = { code: 'play_snapshot_unavailable', message };
        this.emit();
        this.sendPlayPreviewFailed(playSessionId, 'play_snapshot_unavailable', message);
      },
    });
    this.commands = new CommandSender({
      projectId: cfg.projectId,
      projection: this.projection,
      post: (body) => this.api(`/projects/${this.cfg.projectId}/commands`, body),
      activeScene: () => this.scenes.activeScene,
      newItemFolder: () => this.newItemFolder,
      applyAcked: (ev) => this.applyMutationApplied(ev),
      report: (s) => this.report(s),
      resync: async () => {
        await this.fullResync();
        this.cb.onSceneChanged();
      },
      disposed: () => this.disposed,
    });
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

  /** A command's answer, as the save status, error and conflict show it. */
  private report(s: CommandStatus): void {
    this.save = s.save;
    if (s.error !== undefined) this.error = s.error;
    if (s.conflict !== undefined) this.conflict = s.conflict;
    this.emit();
  }

  protected async api<T>(path: string, body?: unknown): Promise<T> {
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
  protected async request<T>(path: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit | null }): Promise<T> {
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

  /** Establish the authoring session + upgrade the WS. */
  async connect(): Promise<void> {
    if (this.disposed) return;
    this.connection = this.connection === 'reconnecting' ? 'reconnecting' : 'connecting';
    this.emit();
    try {
      const est = await this.api<{ ok: true; sessionId: string; connId: string; wsToken: string; revision: number; entities?: unknown[] }>(
        '/sessions',
        makeEstablishBody(this.cfg.projectId, this.sessionId, headlessEditor() ? 'headless' : 'editor'),
      );
      this.connId = est.connId;
      await this.fullResync();
      this.cb.onSceneChanged();
      await this.socket.open(`${this.cfg.authoringOrigin.replace(/^http/, 'ws')}/api/v1/ws?sessionId=${this.sessionId}&wsToken=${est.wsToken}`);
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

  /** Reconnect after a lost socket: re-establish (re-attach) + resync + re-upgrade. */
  private socketClosed(ev: CloseEvent): void {
    if (this.disposed) return;
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
    // A v4 project lists its scenes; its entities are read in
    // pages (each names its scene).
    // The scene rows carry each scene's look (sky, fog, post, wind).
    const proj = await this.api<{ ok: boolean; revision?: number; scenes?: { sceneId: string; name: string; environment?: SceneEnvironment }[]; startScenes?: string[] }>(
      `/projects/${this.cfg.projectId}/commands`,
      { op: 'queryProject', projectId: this.cfg.projectId, args: { environments: true } },
    );
    const v4 = proj.ok && Array.isArray(proj.scenes);
    if (v4) this.sceneLooks = new Map(proj.scenes!.filter((r) => r.environment !== undefined).map((r) => [r.sceneId, r.environment!]));
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
      this.scenes.reconcile();
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
    // The project content re-reads on every full state
    // (reopening the editor retains what was authored).
    try {
      const g = await this.queryGameConfig({ descriptors: this.descriptors === null, omit: ['dialogues'] });
      if (g.ok) {
        // Dialogue content: the conversations are read by id when they are opened or played.
        const openDialogues = this.dialogues.map((d) => d.dialogueId);
        this.hydrateContent(g);
        void this.catalog.ensureResources('dialogue', openDialogues);
      }
    } catch {
      // A missing game page is resolved by the next full state; it never
      // corrupts the scene projection.
    }
    // The block layers' cells (a full state re-reads them all).
    try {
      await this.refreshBlockLayers();
    } catch {
      // resolved by the next full state
    }
    // The records read by id are read again (a full state may follow changes this editor missed),
    // with what the open scenes use; lists read their index pages again.
    const heldAssets = this.content.cachedAssets().map((a) => a.assetId);
    const heldPrefabs = this.prefabs.prefabIds;
    this.content.hydrate(null);
    try {
      // The scripts' declarations are the schema of every behavior component: all of them, page by page.
      const { behaviors, trust } = await this.allBehaviors();
      this.prefabs.hydrate([], behaviors);
      this.prefabs.hydrateTrust(trust);
    } catch (e) {
      // Never a partial list (a script missing from it would read as having no properties): said, and
      // resolved by the next full state.
      this.error = { code: 'behaviors_unavailable', message: `the scripts' declarations could not be read: ${e instanceof Error ? e.message : String(e)}` };
      this.emit();
    }
    this.catalog.invalidate();
    void this.catalog.ensureAssets(heldAssets);
    void this.catalog.ensurePrefabs(heldPrefabs);
    this.ensureSceneRecords();
  }

  /** Every published script's record, read a page at a time, and the acknowledged sources (with the first page). */
  private async allBehaviors(): Promise<{ behaviors: BehaviorRecord[]; trust: TrustEntry[] }> {
    const out: BehaviorRecord[] = [];
    let trust: TrustEntry[] = [];
    for (let offset = 0; ; ) {
      const page = await this.queryBehaviors({ limit: ASSET_QUERY_PAGE_MAX, offset, includeDeclaration: true, includeTrust: offset === 0 });
      if ((page as { ok: boolean }).ok !== true) throw new Error('a page of scripts could not be read');
      if (offset === 0) trust = page.trust ?? [];
      out.push(...page.behaviors);
      offset += page.behaviors.length;
      if (page.behaviors.length === 0 || offset >= page.total) break;
    }
    return { behaviors: out, trust };
  }

  /**
   * The records the objects of the open scenes use and the editor has not read
   * yet: the model files the Scene view draws and the prefabs copies came
   * from. They arrive in the background; the Scene view draws them then.
   */
  ensureSceneRecords(): void {
    const assets = new Set<string>();
    const prefabs = new Set<string>();
    for (const e of this.visibleEntities()) {
      if (e.assetId !== undefined && !this.content.has(e.assetId)) assets.add(e.assetId);
      const instanced = e.instances?.assetId;
      if (instanced !== undefined && !this.content.has(instanced)) assets.add(instanced);
      const prefabId = e.prefab?.prefabId;
      if (prefabId !== undefined && !this.prefabs.hasDefinition(prefabId)) prefabs.add(prefabId);
    }
    if (assets.size > 0) void this.catalog.ensureAssets(assets);
    if (prefabs.size > 0) void this.catalog.ensurePrefabs(prefabs);
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
    this.socket.sendUnchecked(frame);
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

  /** Handle one WS message. */
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
        void this.play.receiveStarted(m as unknown as PlayStartedFrame);
        break;
      case 'play.stop.request': {
        const psid = String(m.playSessionId ?? '');
        this.cb.onPlayStopRequested?.(psid);
        this.socket.send({ type: 'play.stopped.ack', playSessionId: psid });
        break;
      }
      case 'play.stopped':
        this.play.receiveStopped((m as { reason?: string }).reason ?? 'request');
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
    // Files the file check took in may be of any kind and bring whole scenes: read the project again.
    if ((ev.change as { type?: unknown } | null)?.type === 'importResources') {
      void this.fullResync().then(() => this.cb.onSceneChanged());
      return;
    }
    // A keyed-list change arrives as a delta; rebuild it from our copy (a copy that does not fit resyncs).
    const full = fromWireChange(ev.change as Record<string, unknown>, { setMaterials: this.materials as unknown as Record<string, unknown>[], setAnimators: this.animators as unknown as Record<string, unknown>[] });
    if (full === null) {
      void this.fullResync().then(() => this.cb.onSceneChanged());
      return;
    }
    ev = { ...ev, change: full };
    const res = this.projection.applyMutationApplied({
      requestId: ev.requestId,
      revision: ev.revision,
      change: ev.change as ChangeData,
      ...(typeof ev.sceneId === 'string' ? { sceneId: ev.sceneId } : {}),
    });
    if (res.applied && (ev.change as ChangeData).type === 'setSceneIndex') this.scenes.reconcile();
    if (res.gap) {
      // The gap rule: we missed events — resync from the backend (authoritative).
      void this.fullResync().then(() => this.cb.onSceneChanged());
      return;
    }
    if (res.applied) {
      // The content projection advances from the SAME applied change records
      // the scene projection uses; a failed or stale job
      // never reaches this path, so previous committed content is preserved.
      if (this.content.applyChange(ev.change as ChangeData)) this.catalog.recordsChanged();
      this.catalog.changed((ev.change as ChangeData).type);
      // definitions/declarations converge from the same
      // records, so an MCP-origin edit is visible without a reload.
      // A visual-script edit that does not fit the copy is
      // stale — re-read everything.
      try {
        this.prefabs.applyChange(ev.change as ChangeData);
      } catch {
        void this.fullResync().then(() => this.cb.onSceneChanged());
        return;
      }
      // The content converges from the same records; an MCP-origin edit is visible without a reload.
      const change = ev.change as ChangeData;
      if (!this.applyContentChange(change)) {
        void this.fullResync().then(() => this.cb.onSceneChanged());
        return;
      }
      if (change.type === 'editBlocks') {
        // Read the chunks (and regions) the change names, then redraw.
        void this.refreshBlockChunks(change.entityId, change.chunks).then(() => this.cb.onSceneChanged());
      }
      // Props' block footprints written with the change: read those chunks too.
      for (const f of (change as { footprints?: readonly FootprintChunks[] }).footprints ?? []) void this.refreshBlockChunks(f.entityId, f.chunks).then(() => this.cb.onSceneChanged());
      if (blockLayerListTouched(change, this.blockLayers)) void this.refreshBlockLayers().then(() => this.cb.onSceneChanged());
      this.ensureSceneRecords();
      this.save = 'saved';
      this.cb.onSceneChanged();
      this.emit();
      this.queueHistoryRefresh();
    }
  }

  /**
   * Issue a mutation command (delegated to the backend; the browser never
   * mutates files). Retries a LOST ack with the same requestId (idempotent);
   * a revision_conflict is surfaced (and handed to the gesture for the bounded
   * auto-rebase). Returns the authoritative revision on success.
   *
   * Own commands go one at a time in the order they were made; each one's
   * acked change is applied before the next is sent, and a command whose view
   * was behind only by this editor's own edits is sent against the current
   * revision (own-commands.ts). `args` may be a function: it is called at
   * send time, so args derived from the client state see every earlier edit.
   *
   * A command refused with `revision_conflict` because someone else (MCP,
   * another tool) edited first was made on a view the change feed had not
   * caught up yet: the client waits for the feed to reach the backend's
   * revision and sends it once more against it (`rebaseAfterFeed`), so a
   * person editing while a tool edits is not refused. A whole-document op
   * whose args were built from the older view is not resent (it would undo
   * the edits in between); its conflict is surfaced.
   */
  command(
    op: string,
    args: unknown,
    expectedRevision: number,
    requestId?: string,
    origin: Origin = { kind: 'browser', clientId: this.sessionId },
  ): Promise<CommandResult> {
    return this.commands.issue(op, args, expectedRevision, requestId, origin, true);
  }

  /**
   * As `command`, but a refusal because someone else's command came first is
   * surfaced, never sent again after the feed: for an undo or redo that
   * waited (seconds, while an action's commands were joined into one step),
   * sent again it would take back whatever is latest, another client's
   * command included, which the user never saw. The view being behind only
   * by this editor's own commands still moves it on.
   */
  protected commandAsSeen(op: string, args: unknown, expectedRevision: number, requestId?: string, origin: Origin = { kind: 'browser', clientId: this.sessionId }): Promise<CommandResult> {
    return this.commands.issue(op, args, expectedRevision, requestId, origin, false);
  }

  /**
   * Start an isolated play. `start` — Play
   * from a scene, with script variables or a project save (slot 1-99; the same body
   * `tl_play_start` sends; the backend resolves it).
   */
  async playStart(demo = false, start?: { sceneId?: string; mode?: string; variables?: Record<string, unknown>; save?: Record<string, unknown>; saveSlot?: string }): Promise<PlayStartResult> {
    const r = await this.api<PlayStartResult>('/projects/' + this.cfg.projectId + '/play', { options: { demo, ...(start ?? {}) } });
    this.play.begin(r);
    return r;
  }

  /** Stop the active play. */
  async playStop(playSessionId: string): Promise<void> {
    await this.api(`/projects/${this.cfg.projectId}/play/${playSessionId}/stop`, {});
    this.play.end(playSessionId);
  }

  /**
   * Send the WS `play.preview.ready` EXACTLY
   * ONCE per play session (the editor presented the
   * preview and received the preview's `tl.ready`; the backend marks the play
   * `presented`, lifting the 15 s present-timeout). Idempotent per
   * playSessionId; a closed socket drops the frame (the play is then bounded
   * by the accepted present-timeout — no retry, no fabrication).
   */
  sendPlayPreviewReady(playSessionId: string): boolean {
    return this.play.ready(playSessionId);
  }

  /**
   * The preview reported load progress (`tl.load.progress`)
   * before it is ready: tell the backend at most once a second, so its
   * present timeout counts from the last progress. Nothing after `ready`.
   */
  sendPlayPreviewProgress(playSessionId: string): boolean {
    return this.play.progress(playSessionId);
  }

  /** Send the WS
   * `play.preview.failed` when the preview could not start (the editor
   * relays the preview's `tl.error`; the backend stops the
   * play `preview_failed` instead of waiting out the 15 s present-timeout).
   * The message is truncated to the accepted ≤ 256 bound. */
  sendPlayPreviewFailed(playSessionId: string, code: string, message?: string): boolean {
    return this.socket.send({
      type: 'play.preview.failed',
      playSessionId,
      code,
      ...(message !== undefined ? { message: message.slice(0, 256) } : {}),
    });
  }

  /** Relay a running play's problem (the preview's `tl.play.problem`) to the backend's Problems log. */
  sendPlayProblem(playSessionId: string, code: string, message: string): boolean {
    return this.socket.send({ type: 'play.problem', playSessionId, code, message });
  }

  getActivePlay(): ActivePlay | null {
    return this.play.current;
  }

  /** The entity's current transform (for a gesture's conflict rebase). */
  entityTransform(entityId: string): Transform | null {
    const e = this.projection.getEntity(entityId);
    if (!e) return null;
    return { position: e.position, rotation: e.rotation, scale: e.scale };
  }


  /** The entities of the open scenes (all of them for a single-scene project). */
  visibleEntities(): ProjectedEntity[] {
    return this.scenes.visibleEntities();
  }

  /** The open scenes (in index order) and the active one; empty for a single-scene project. */
  getSceneView(): { open: readonly string[]; active: string | null } {
    return this.scenes.view();
  }

  /** Open or close a scene in this browser (the last open scene stays open). */
  setSceneOpen(sceneId: string, open: boolean): void {
    if (this.scenes.setOpen(sceneId, open)) this.cb.onSceneChanged();
  }

  /** Make a scene the active one (it is opened if needed). */
  setActiveScene(sceneId: string): void {
    if (this.scenes.setActive(sceneId)) this.cb.onSceneChanged();
  }

  /**
   * What the Scene view and the previews show: the active scene's look with
   * the project's quality and presets (Unity's rule: with several scenes open
   * the active scene's settings apply). Null when neither sets anything.
   */
  getShownEnvironment(): (EnvironmentConfig & SceneEnvironment) | null {
    return this.shownEnvironment(this.scenes.activeScene);
  }


  /**
   * Compile a script library draft without saving it (`POST
   * content/libraries/check`; nothing is written). Also names the published
   * scripts that import it.
   */
  async checkScriptLibrary(
    libraryId: string,
    files: readonly { path: string; text: string }[],
  ): Promise<
    | { ok: true; compiled: true; sourceDigest: string; imports: string[]; outputByteLength: number; dependents: string[] }
    | { ok: true; compiled: false; code: string; reason: string; diagnostics: CompileDiagnosticView[]; dependents: string[] }
    | { ok: false; error: { code: string; message: string } }
  > {
    try {
      const r = await this.request<{ ok: true; compiled: boolean; sourceDigest?: string; imports?: string[]; outputByteLength?: number; dependents?: string[]; code?: string; reason?: string; diagnostics?: CompileDiagnosticView[] }>(
        `/projects/${this.cfg.projectId}/content/libraries/check`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ libraryId, files: files.map((f) => ({ path: f.path, text: f.text })) }) },
      );
      if (r.compiled) return { ok: true, compiled: true, sourceDigest: r.sourceDigest ?? '', imports: r.imports ?? [], outputByteLength: r.outputByteLength ?? 0, dependents: r.dependents ?? [] };
      return { ok: true, compiled: false, code: r.code ?? 'behavior_compile_failed', reason: r.reason ?? '', diagnostics: r.diagnostics ?? [], dependents: r.dependents ?? [] };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * Add one patch to a staged library edit set (`POST
   * content/libraries/stage`; a new stage without stageId). Nothing changes
   * in the project until `commitScriptLibraryStage` commits the stage.
   */
  async stageScriptLibrary(body: { stageId?: string; libraryId: string; name?: string; files?: { path: string; text: string | null; append?: true }[] } | { stageId: string; discard: true }): Promise<
    | { ok: true; stageId: string; patches: number; libraries: { libraryId: string; sourceDigest: string; changed: boolean }[] }
    | { ok: false; error: { code: string; message: string } }
  > {
    try {
      const r = await this.request<{ ok: true; stageId: string; patches?: number; libraries?: { libraryId: string; sourceDigest: string; changed: boolean }[] }>(`/projects/${this.cfg.projectId}/content/libraries/stage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ok: true, stageId: r.stageId, patches: r.patches ?? 0, libraries: r.libraries ?? [] };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * A running Play's diagnostics (the backend relays the request to
   * the preview and maps script error and log locations back to the sources).
   */
  async playDiagnostics(playSessionId: string): Promise<{ ok: true; diagnostics: unknown } | { ok: false; message: string }> {
    try {
      const r = await this.request<{ ok: true; diagnostics: unknown }>(`/projects/${this.cfg.projectId}/play/${playSessionId}/diagnostics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return { ok: true, diagnostics: r.diagnostics };
    } catch (e) {
      const d = this.describeError(e);
      return { ok: false, message: `${d.code}: ${d.message}` };
    }
  }


  /** `queryBlocks` (the layers, one layer's chunks, a box of cells or a region). */
  async queryBlocks(args: Record<string, unknown>): Promise<Record<string, unknown> & { ok: boolean }> {
    try {
      return await this.api<Record<string, unknown> & { ok: boolean }>(`/projects/${this.cfg.projectId}/commands`, { op: 'queryBlocks', projectId: this.cfg.projectId, args });
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** Re-read every layer (the layer list and all cells). */
  async refreshBlockLayers(): Promise<void> {
    const list = await this.queryBlocks({});
    if (list.ok !== true) return;
    const next = new Map<string, BlockLayerView>();
    for (const row of (list['layers'] as { entityId: string; component: BlockLayerComponent; chunks: number[][] }[] | undefined) ?? []) {
      const one = await this.queryBlocks({ entityId: row.entityId });
      if (one.ok !== true) continue;
      const chunks = new Map<string, BlockChunk>();
      for (const c of (one['chunks'] as { cx: number; cz: number; chunk: BlockChunk | null }[] | undefined) ?? []) if (c.chunk !== null) chunks.set(`${c.cx},${c.cz}`, c.chunk);
      next.set(row.entityId, { component: one['component'] as BlockLayerComponent, chunks, regions: (one['regions'] as BlockRegion[] | undefined) ?? [] });
    }
    this.blockLayers = next;
    this.blockRevision += 1;
  }

  /** Re-read some chunks of one layer (the chunks an editBlocks change named). */
  private async refreshBlockChunks(entityId: string, chunks: readonly (readonly [number, number])[]): Promise<void> {
    const one = await this.queryBlocks({ entityId, chunks: chunks.map((c) => [c[0], c[1]]) });
    if (one.ok !== true) return;
    const prev = this.blockLayers.get(entityId);
    const layer: BlockLayerView = { component: one['component'] as BlockLayerComponent, chunks: new Map(prev?.chunks ?? []), regions: (one['regions'] as BlockRegion[] | undefined) ?? [] };
    for (const c of (one['chunks'] as { cx: number; cz: number; chunk: BlockChunk | null }[] | undefined) ?? []) {
      if (c.chunk === null) layer.chunks.delete(`${c.cx},${c.cz}`);
      else layer.chunks.set(`${c.cx},${c.cz}`, c.chunk);
    }
    const map = new Map(this.blockLayers);
    map.set(entityId, layer);
    this.blockLayers = map;
    this.blockRevision += 1;
  }


  /**
   * A bounded `queryGameConfig`: the
   * project content (tags, scenes, materials, environment, …); read-only.
   */
  async queryGameConfig(opts: { descriptors?: boolean; omit?: readonly string[] } = {}): Promise<{ ok: true; revision: number } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.api<{ ok: true; projectId: string; revision: number }>(
        `/projects/${this.cfg.projectId}/commands`,
        { op: 'queryGameConfig', projectId: this.cfg.projectId, args: { ...(opts.descriptors === true ? { descriptors: true } : {}), ...(opts.omit !== undefined && opts.omit.length > 0 ? { omit: [...opts.omit] } : {}) } },
      );
      // The content (tags, scenes, materials, environment, lighting, …) rides along.
      return { ...r, ok: true, revision: r.revision };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  // ---- content browser ----------------------------------------

  /**
   * A bounded `queryAssets`. Read-only: it carries no
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
   * A bounded `queryPrefabs`. Read-only. With
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
   * A bounded `queryBehaviors`. With `includeDeclaration`
   * the entries are the exact published records — the declaration data the
   * property controls are derived from. Source bytes are never returned.
   */
  async queryBehaviors(
    options: { limit?: number; offset?: number; includeDeclaration?: boolean; includeTrust?: boolean; behaviorId?: string } = {},
  ): Promise<BehaviorQueryResult> {
    return this.api<BehaviorQueryResult>(`/projects/${this.cfg.projectId}/commands`, {
      op: 'queryBehaviors',
      projectId: this.cfg.projectId,
      args: {
        ...planAssetQuery({ limit: options.limit, offset: options.offset }),
        ...(options.includeDeclaration ? { includeDeclaration: true } : {}),
        ...(options.includeTrust === true ? { includeTrust: true } : {}),
        ...(options.behaviorId ? { behaviorId: options.behaviorId } : {}),
      },
    });
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
    this.socket.close();
    this.connection = 'disconnected';
    this.emit();
  }
}

/** The backend's own headless editor opens the page with `headless=1`. */
function headlessEditor(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('headless') === '1';
  } catch {
    return false;
  }
}

/** Whether a change adds, removes or re-shapes a block layer (the layer list is read again). */
function blockLayerListTouched(change: ChangeData, layers: ReadonlyMap<string, BlockLayerView>): boolean {
  const has = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { components?: { blockLayer?: unknown } }).components?.blockLayer !== undefined;
  switch (change.type) {
    case 'setComponent':
      return change.component === 'blockLayer';
    case 'deleteEntity':
      return change.deletedIds.some((id) => layers.has(id));
    case 'restoreSubtree':
      return change.entities.some(has);
    case 'createEntity':
      return has(change.entity) || (change.children ?? []).some(has);
    case 'pasteEntities':
      return (change.entities as readonly unknown[]).some(has);
    default:
      return false;
  }
}
