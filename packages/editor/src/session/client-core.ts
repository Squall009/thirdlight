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
 * files) are the `SessionClient` subclass in `client.ts`.
 */

import { applyGraphOpsLocal } from '../graph/model';
import type { BlockChunk, BlockLayerComponent, BlockRegion, BlockStamp, BlockType, CellField, SaveSchema } from '@thirdlight/project-model';
import type { DialogueDocument, DialogueSettings, DialogueSpeaker } from '@thirdlight/project-model';
import type { AnimatorController, DescriptorRegistry, GraphDocument, GraphKindDef, EnvironmentConfig, InputConfig, LightingBake, MaterialDef, EffectDef, ScriptLibrary, UiDocument, UiTheme, TimelineAsset, GameMode, EventCue, GameShell } from '@thirdlight/project-model';
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
import { committed, planAssetQuery } from './asset-browser';
import { type Transform } from './gesture';
import { type CompileDiagnosticView } from './behavior-publication';
import { fromWireChange } from '@thirdlight/protocol';
import { OwnCommands, WHOLE_DOCUMENT_OPS } from './own-commands';
import type { BehaviorRecord, PrefabDefinition } from '@thirdlight/project-model';

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
  entries: Array<{ name: string; path: string; kind: 'dir' | 'model' | 'audio' | 'texture' | 'music' | 'font'; byteLength?: number }>;
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

/** A play-start result. */
export interface PlayStartResult {
  playSessionId: string;
  /** The preview iframe base (the backend's preview origin). */
  playBase: string;
  snapshotId: string;
  revision: number;
  expiresAt: number;
  /** The immutable play-content locator (capability + build id). */
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
}

/** A command's answer (a staged library commit also says which scripts it recompiled). */
export interface CommandResultOk {
  ok: true;
  revision: number;
  createdId?: string;
  libraryStage?: { dependents: { behaviorId: string; outputDigest: string }[]; compiled: number };
}
export type CommandResult = CommandResultOk | { ok: false; response: MutationResponse };

export class SessionClientCore {
  readonly projection = new Projection();
  /** The additive content projection (asset summaries). */
  readonly content = new ContentProjection();
  /**
   * The prefix/declaration projection. Definitions are the
   * capture/instantiation source; declarations are the only schema source for
   * the property controls (never behavior code).
   */
  readonly prefabs = new PrefabProjection();
  protected readonly cfg: ClientConfig;
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
  /** The playSessionId the WS
   * `play.preview.ready` was already sent for (sent exactly once per play
   * session). */
  private playReadySentFor: string | null = null;
  /** The heartbeat timer (a WS `ping`
   * at least every 20 s; the server drops a 60 s-silent connection). */
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  /** Whether the last full state read the project content (`queryGameConfig`). */
  private contentLoaded = false;
  /**
   * The last-known `content.settings` map. No accepted query
   * returns settings VALUES (the `queryProject` summary carries only the
   * `settingsKeys` count), so the baseline is `null`
   * (unknown) until the session observes an applied `setSettings` change
   * (whose `next` is the full map). The settings
   * panel seeds from the registry defaults in the unknown case and submits
   * only the touched keys (partial semantics preserve the rest).
   */
  private settings: Record<string, unknown> | null = null;
  /** The project tag registry (from `queryGameConfig`, then `setTags` changes). */
  private tags: { bit: number; name: string }[] = [];
  /** The project materials and the environment (from queryGameConfig, then changes). */
  private materials: MaterialDef[] = [];
  private environment: EnvironmentConfig | null = null;
  /** Each scene's bake (from queryGameConfig, then setLighting changes). */
  private lighting: Record<string, LightingBake> = {};
  /** The animator controllers. */
  private animators: AnimatorController[] = [];
  /** The standalone graph documents and the registered graph kinds (from queryGameConfig, then changes). */
  private graphs: GraphDocument[] = [];
  private graphKinds: Record<string, GraphKindDef> = {};
  /** The visual effects (from queryGameConfig, then setEffect / graphEdit changes). */
  private effects: EffectDef[] = [];
  /** The shared script libraries (from queryGameConfig, then setScriptLibrary changes). */
  private scriptLibraries: ScriptLibrary[] = [];
  /** Block types, the cell metadata schema and stamps (from queryGameConfig, then changes). */
  private blockTypes: BlockType[] = [];
  private cellFields: CellField[] = [];
  private blockStamps: BlockStamp[] = [];
  /** Every block layer's cells (queryBlocks; the chunks a change names are read again). */
  private blockLayers = new Map<string, BlockLayerView>();
  /** Bumped whenever a layer's cells or the layer list change (the Scene view re-meshes). */
  private blockRevision = 0;
  /** The project UI documents and themes (from queryGameConfig, then setUi changes). */
  private uiDocuments: UiDocument[] = [];
  private uiThemes: UiTheme[] = [];
  /** Conversations, the speaker registry and the dialogue settings (from queryGameConfig, then setDialogue / graphEdit changes). */
  private dialogues: DialogueDocument[] = [];
  private speakers: DialogueSpeaker[] = [];
  private dialogueSettings: DialogueSettings | null = null;
  /** The timelines (from queryGameConfig, then setTimeline changes). */
  private timelines: TimelineAsset[] = [];
  /** The project's input actions (null = the defaults). */
  private input: InputConfig | null = null;
  /** The project's named collision layers (from `queryGameConfig`, then `setCollisionLayers` changes). */
  private collisionLayers: string[] = [];
  /** The game modes and behavior groups (from `queryGameConfig`, then setModes / setBehaviorGroups changes). */
  private modes: GameMode[] = [];
  private behaviorGroups: string[] = [];
  /** The event → cue table (from `queryGameConfig`, then `setEventCues` changes). */
  private eventCues: EventCue[] = [];
  /** The game shell (from `queryGameConfig`, then `setShell` changes; null: none). */
  private shell: GameShell | null = null;
  /** The project save schema (from `queryGameConfig`, then `setSaveSchema` changes). */
  private saveSchema: SaveSchema | null = null;
  private inputDefaults: InputConfig = { actions: [] };
  /**
   * The component and content descriptor registry (the editor
   * may import project-model types only, so it arrives with the first
   * `queryGameConfig`; it is static, fetched once).
   */
  private descriptors: DescriptorRegistry | null = null;
  /**
   * The scenes open in this browser (the hierarchy and the
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

  /** The WS upgrade: single-use wsToken. */
  private upgradeWs(wsToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.cfg.authoringOrigin.replace(/^http/, 'ws')}/api/v1/ws?sessionId=${this.sessionId}&wsToken=${wsToken}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.startHeartbeat(); // the client pings at least every 20 s
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
    // A v4 project lists its scenes; its entities are read in
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
    // The project content re-reads on every full state
    // (reopening the editor retains what was authored).
    try {
      const g = await this.queryGameConfig({ descriptors: this.descriptors === null });
      if (g.ok) {
        const descriptors = (g as { descriptors?: DescriptorRegistry }).descriptors;
        if (descriptors !== undefined) this.descriptors = descriptors;
        this.contentLoaded = true;
        const tags = (g as { tags?: { bit: number; name: string }[] }).tags;
        this.tags = Array.isArray(tags) ? tags.map((t) => ({ bit: t.bit, name: t.name })) : [];
        const mats = (g as { materials?: MaterialDef[] }).materials;
        this.materials = Array.isArray(mats) ? structuredClone(mats) : [];
        const env = (g as { environment?: EnvironmentConfig | null }).environment;
        this.environment = env !== undefined && env !== null ? structuredClone(env) : null;
        const lighting = (g as { lighting?: Record<string, LightingBake> | null }).lighting;
        this.lighting = lighting !== undefined && lighting !== null ? structuredClone(lighting) : {};
        const animators = (g as { animators?: AnimatorController[] | null }).animators;
        this.animators = Array.isArray(animators) ? structuredClone(animators) : [];
        const input = (g as { input?: InputConfig | null }).input;
        this.input = input !== undefined && input !== null ? structuredClone(input) : null;
        const layers = (g as { collisionLayers?: string[] }).collisionLayers;
        this.collisionLayers = Array.isArray(layers) ? [...layers] : [];
        const modes = (g as { modes?: GameMode[] }).modes;
        this.modes = Array.isArray(modes) ? structuredClone(modes) : [];
        const groups = (g as { behaviorGroups?: string[] }).behaviorGroups;
        this.behaviorGroups = Array.isArray(groups) ? [...groups] : [];
        const cues = (g as { eventCues?: EventCue[] }).eventCues;
        this.eventCues = Array.isArray(cues) ? structuredClone(cues) : [];
        const shell = (g as { shell?: GameShell | null }).shell;
        this.shell = shell !== undefined && shell !== null ? structuredClone(shell) : null;
        const saveSchema = (g as { saveSchema?: SaveSchema | null }).saveSchema;
        this.saveSchema = saveSchema !== undefined && saveSchema !== null ? structuredClone(saveSchema) : null;
        const defaults = (g as { inputDefaults?: InputConfig }).inputDefaults;
        if (defaults !== undefined) this.inputDefaults = structuredClone(defaults);
        // The settings map travels with the content (null before: only changes carried it).
        const settings = (g as { settings?: Record<string, unknown> }).settings;
        if (settings !== undefined && settings !== null && typeof settings === 'object') this.settings = { ...settings };
        const graphs = (g as { graphs?: GraphDocument[] }).graphs;
        this.graphs = Array.isArray(graphs) ? structuredClone(graphs) : [];
        const effects = (g as { effects?: EffectDef[] }).effects;
        this.effects = Array.isArray(effects) ? structuredClone(effects) : [];
        const libraries = (g as { scriptLibraries?: ScriptLibrary[] }).scriptLibraries;
        this.scriptLibraries = Array.isArray(libraries) ? structuredClone(libraries) : [];
        // Block types, cell fields and stamps.
        const blockTypes = (g as { blockTypes?: BlockType[] }).blockTypes;
        this.blockTypes = Array.isArray(blockTypes) ? structuredClone(blockTypes) : [];
        const cellFields = (g as { cellFields?: CellField[] }).cellFields;
        this.cellFields = Array.isArray(cellFields) ? structuredClone(cellFields) : [];
        const blockStamps = (g as { blockStamps?: BlockStamp[] }).blockStamps;
        this.blockStamps = Array.isArray(blockStamps) ? structuredClone(blockStamps) : [];
        const uiDocs = (g as { uiDocuments?: UiDocument[] }).uiDocuments;
        this.uiDocuments = Array.isArray(uiDocs) ? structuredClone(uiDocs) : [];
        const uiThemes = (g as { uiThemes?: UiTheme[] }).uiThemes;
        this.uiThemes = Array.isArray(uiThemes) ? structuredClone(uiThemes) : [];
        // Dialogue content.
        const dialogues = (g as { dialogues?: DialogueDocument[] }).dialogues;
        this.dialogues = Array.isArray(dialogues) ? structuredClone(dialogues) : [];
        const speakers = (g as { speakers?: DialogueSpeaker[] }).speakers;
        this.speakers = Array.isArray(speakers) ? structuredClone(speakers) : [];
        const ds = (g as { dialogueSettings?: DialogueSettings | null }).dialogueSettings;
        this.dialogueSettings = ds !== undefined && ds !== null ? structuredClone(ds) : null;
        const timelines = (g as { timelines?: TimelineAsset[] }).timelines;
        this.timelines = Array.isArray(timelines) ? structuredClone(timelines) : [];
        const kinds = (g as { graphKinds?: Record<string, GraphKindDef> }).graphKinds;
        if (kinds !== undefined) this.graphKinds = structuredClone(kinds);
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
    // The additive content projection is rebuilt from the same full state:
    // a bounded `queryAssets` page, never a partial merge.
    try {
      const assets = await this.queryAssets({ limit: 128, offset: 0, includeVersions: true });
      if (assets.ok) this.content.hydrate({ assets: assets.assets });
    } catch {
      // A missing content page is resolved by the next full state; it never
      // corrupts the scene projection.
    }
    // Reopening rebuilds definitions and published
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
        void this.receivePlayStarted(m as unknown as { playSessionId: string; snapshot?: unknown; snapshotRef?: { path?: unknown; bytes?: unknown }; playContent?: PlayStartResult['playContent'] });
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
    if (res.applied && (ev.change as ChangeData).type === 'setSceneIndex') this.reconcileScenes();
    if (res.gap) {
      // The gap rule: we missed events — resync from the backend (authoritative).
      void this.fullResync().then(() => this.cb.onSceneChanged());
      return;
    }
    if (res.applied) {
      // The content projection advances from the SAME applied change records
      // the scene projection uses; a failed or stale job
      // never reaches this path, so previous committed content is preserved.
      this.content.applyChange(ev.change as ChangeData);
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
      // The content converges from the same records (the
      // `setSettings` change carries the full next map). An MCP-origin edit is visible without a reload.
      const change = ev.change as ChangeData;
      if (change.type === 'setSettings') {
        this.settings = { ...(change.next as Record<string, unknown>) };
      } else if (change.type === 'setTags') {
        this.tags = change.next.map((t) => ({ bit: t.bit, name: t.name }));
      } else if (change.type === 'setMaterials') {
        this.materials = structuredClone(change.next);
      } else if (change.type === 'setEnvironment') {
        this.environment = change.next === null ? null : structuredClone(change.next);
      } else if (change.type === 'setInput') {
        this.input = change.next === null ? null : structuredClone(change.next);
      } else if (change.type === 'setCollisionLayers') {
        this.collisionLayers = [...change.next];
      } else if (change.type === 'setModes') {
        this.modes = structuredClone(change.next);
      } else if (change.type === 'setBehaviorGroups') {
        this.behaviorGroups = [...change.next];
      } else if (change.type === 'setEventCues') {
        this.eventCues = structuredClone(change.next);
      } else if (change.type === 'setShell') {
        this.shell = change.next === null ? null : structuredClone(change.next);
      } else if (change.type === 'setSaveSchema') {
        this.saveSchema = change.next === null ? null : structuredClone(change.next);
      } else if (change.type === 'setAnimators') {
        this.animators = structuredClone(change.next);
      } else if (change.type === 'setGraph') {
        const rest = this.graphs.filter((g) => g.graphId !== change.graphId);
        this.graphs = change.next === null ? rest : [...rest, structuredClone(change.next)].sort((a, b) => (a.graphId < b.graphId ? -1 : 1));
      } else if (change.type === 'setScriptLibrary') {
        // One library before/after (null = none); its dependents' records travel in the same change.
        const rest = this.scriptLibraries.filter((l) => l.libraryId !== change.libraryId);
        this.scriptLibraries = change.next === null ? rest : [...rest, structuredClone(change.next)].sort((a, b) => (a.libraryId < b.libraryId ? -1 : 1));
      } else if (change.type === 'setScriptLibraries') {
        // A staged commit - several libraries before/after at once.
        let list = this.scriptLibraries;
        for (const l of change.libraries) {
          const rest = list.filter((x) => x.libraryId !== l.libraryId);
          list = l.next === null ? rest : [...rest, structuredClone(l.next)];
        }
        this.scriptLibraries = [...list].sort((a, b) => (a.libraryId < b.libraryId ? -1 : 1));
      } else if (change.type === 'setTimeline') {
        // One timeline before/after (null = none).
        const rest = this.timelines.filter((t) => t.timelineId !== change.timelineId);
        this.timelines = change.next === null ? rest : [...rest, structuredClone(change.next)].sort((a, b) => (a.timelineId < b.timelineId ? -1 : 1));
      } else if (change.type === 'setUi') {
        // One UI document or theme before/after (null = none).
        if (change.uiKind === 'document') {
          const rest = this.uiDocuments.filter((d) => d.uiDocumentId !== change.id);
          this.uiDocuments = change.next === null ? rest : [...rest, structuredClone(change.next as UiDocument)].sort((a, b) => (a.uiDocumentId < b.uiDocumentId ? -1 : 1));
        } else {
          const rest = this.uiThemes.filter((t) => t.uiThemeId !== change.id);
          this.uiThemes = change.next === null ? rest : [...rest, structuredClone(change.next as UiTheme)].sort((a, b) => (a.uiThemeId < b.uiThemeId ? -1 : 1));
        }
      } else if (change.type === 'setDialogue') {
        // One conversation, speaker or the settings before/after (null = none).
        if (change.dialogueKind === 'dialogue') {
          const rest = this.dialogues.filter((d) => d.dialogueId !== change.id);
          this.dialogues = change.next === null ? rest : [...rest, structuredClone(change.next as DialogueDocument)].sort((a, b) => (a.dialogueId < b.dialogueId ? -1 : 1));
        } else if (change.dialogueKind === 'speaker') {
          const rest = this.speakers.filter((x) => x.speakerId !== change.id);
          this.speakers = change.next === null ? rest : [...rest, structuredClone(change.next as DialogueSpeaker)].sort((a, b) => (a.speakerId < b.speakerId ? -1 : 1));
        } else this.dialogueSettings = change.next === null ? null : structuredClone(change.next as DialogueSettings);
      } else if (change.type === 'setEffect') {
        // One effect before/after (null = none).
        const rest = this.effects.filter((e) => e.effectId !== change.effectId);
        this.effects = change.next === null ? rest : [...rest, structuredClone(change.next)].sort((a, b) => (a.effectId < b.effectId ? -1 : 1));
      } else if (change.type === 'graphEdit') {
        // Advance the owner's graph from the change's ops (the
        // backend applied and validated the same ops); a copy that does not
        // fit is stale — re-read everything.
        if (change.owner.kind === 'graph') {
          const doc = this.graphs.find((g) => g.graphId === change.owner.id);
          const next = doc !== undefined ? applyGraphOpsLocal(doc.graph, change.ops) : null;
          if (doc === undefined || next === null) {
            void this.fullResync().then(() => this.cb.onSceneChanged());
            return;
          }
          this.graphs = this.graphs.map((g) => (g === doc ? { ...g, graph: next } : g));
        } else if (change.owner.kind === 'material') {
          // A graph material's graph.
          const m = this.materials.find((x) => x.materialId === change.owner.id);
          const next = m?.graph !== undefined ? applyGraphOpsLocal(m.graph, change.ops) : null;
          if (m === undefined || next === null) {
            void this.fullResync().then(() => this.cb.onSceneChanged());
            return;
          }
          this.materials = this.materials.map((x) => (x === m ? { ...x, graph: next } : x));
        } else if (change.owner.kind === 'dialogue') {
          // A conversation's graph.
          const d = this.dialogues.find((x) => x.dialogueId === change.owner.id);
          const next = d !== undefined ? applyGraphOpsLocal(d.graph, change.ops) : null;
          if (d === undefined || next === null) {
            void this.fullResync().then(() => this.cb.onSceneChanged());
            return;
          }
          this.dialogues = this.dialogues.map((x) => (x === d ? { ...x, graph: next } : x));
        } else if (change.owner.kind === 'effect') {
          // One system's graph (owner id "<effectId>/<systemId>").
          const [effectId, systemId] = change.owner.id.split('/');
          const e = this.effects.find((x) => x.effectId === effectId);
          const sys = e?.systems.find((x) => x.systemId === systemId);
          const next = sys !== undefined ? applyGraphOpsLocal(sys.graph, change.ops) : null;
          if (e === undefined || sys === undefined || next === null) {
            void this.fullResync().then(() => this.cb.onSceneChanged());
            return;
          }
          this.effects = this.effects.map((x) => (x === e ? { ...x, systems: x.systems.map((y) => (y === sys ? { ...y, graph: next } : y)) } : x));
        }
      } else if (change.type === 'setLighting') {
        if (change.next === null) delete this.lighting[change.sceneId];
        else this.lighting[change.sceneId] = structuredClone(change.next);
      } else if (change.type === 'setBlockType') {
        // One block type before/after (null = none); the Scene view re-meshes.
        const rest = this.blockTypes.filter((t) => t.blockId !== change.blockId);
        this.blockTypes = change.next === null ? rest : [...rest, structuredClone(change.next)].sort((a, b) => (a.blockId < b.blockId ? -1 : 1));
        this.blockRevision += 1;
      } else if (change.type === 'setCellFields') {
        this.cellFields = structuredClone(change.next);
      } else if (change.type === 'setBlockStamp') {
        const rest = this.blockStamps.filter((x) => x.stampId !== change.stampId);
        this.blockStamps = change.next === null ? rest : [...rest, structuredClone(change.next)].sort((a, b) => (a.stampId < b.stampId ? -1 : 1));
      } else if (change.type === 'editBlocks') {
        // Read the chunks (and regions) the change names, then redraw.
        void this.refreshBlockChunks(change.entityId, change.chunks).then(() => this.cb.onSceneChanged());
      }
      if (blockLayerListTouched(change, this.blockLayers)) void this.refreshBlockLayers().then(() => this.cb.onSceneChanged());
      this.save = 'saved';
      this.cb.onSceneChanged();
      this.emit();
      this.queueHistoryRefresh();
    }
  }

  /**
   * A `play.started` carries the snapshot inline, or — when it
   * does not fit one WebSocket frame (1 MiB) — a `snapshotRef` to fetch it by
   * from the play's snapshot route over HTTP. A failed fetch is shown and the
   * play is stopped (`play.preview.failed`), never left waiting.
   */
  private async receivePlayStarted(m: { playSessionId: string; snapshot?: unknown; snapshotRef?: { path?: unknown; bytes?: unknown }; playContent?: PlayStartResult['playContent'] }): Promise<void> {
    if (m.snapshot !== undefined || m.snapshotRef === undefined) {
      this.handlePlayStarted({ ...m, snapshot: m.snapshot ?? null });
      return;
    }
    const path = typeof m.snapshotRef.path === 'string' ? m.snapshotRef.path : '';
    const expected = `/api/v1/projects/${this.cfg.projectId}/play/${m.playSessionId}/snapshot`;
    try {
      // Only this project's own play route (the reference never points elsewhere).
      if (path !== expected) throw new Error(`unexpected snapshot reference ${path.slice(0, 120)}`);
      const snapshot = await this.api<unknown>(path.slice('/api/v1'.length));
      this.handlePlayStarted({ ...m, snapshot });
    } catch (e) {
      const status = (e as { status?: number }).status;
      const message = `Play could not load the ${typeof m.snapshotRef.bytes === 'number' ? `${Math.round(m.snapshotRef.bytes / 1024)} KiB ` : ''}snapshot: ${status !== undefined ? `HTTP ${status}` : String((e as Error).message ?? e)}`;
      this.error = { code: 'play_snapshot_unavailable', message };
      this.emit();
      this.sendPlayPreviewFailed(m.playSessionId, 'play_snapshot_unavailable', message);
    }
  }

  private handlePlayStarted(m: { playSessionId: string; snapshot: unknown; playContent?: PlayStartResult['playContent'] }): void {
    // The retained `play.started` (delivered once). The editor stores
    // it and, on the preview iframe load, hands it across the bridge.
    const base = this.activePlay ?? ({} as PlayStartResult);
    this.activePlay = {
      playSessionId: m.playSessionId,
      playBase: base.playBase ?? this.cfg.previewOrigin,
      snapshotId: base.snapshotId ?? '',
      revision: base.revision ?? 0,
      expiresAt: base.expiresAt ?? 0,
      // The play-content locator (contentId /
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
   *
   * Own commands go one at a time in the order they were made; each one's
   * acked change is applied before the next is sent, and a command whose view
   * was behind only by this editor's own edits is sent against the current
   * revision (own-commands.ts). `args` may be a function: it is called at
   * send time, so args derived from the client state see every earlier edit.
   */
  command(
    op: string,
    args: unknown,
    expectedRevision: number,
    requestId?: string,
    origin: Origin = { kind: 'browser', clientId: this.sessionId },
  ): Promise<CommandResult> {
    const lazy = typeof args === 'function';
    return this.ownCommands.enqueue(() => {
      // A whole-document op with args built at call time keeps its revision (stale args conflict instead of undoing an edit).
      const expected = lazy || !WHOLE_DOCUMENT_OPS.has(op) ? this.ownCommands.rebase(expectedRevision, this.projection.revision) : expectedRevision;
      return this.sendCommand(op, lazy ? (args as () => unknown)() : args, expected, requestId, origin);
    });
  }

  private readonly ownCommands = new OwnCommands();

  private async sendCommand(
    op: string,
    args: unknown,
    expectedRevision: number,
    requestId: string | undefined,
    origin: Origin,
  ): Promise<CommandResult> {
    const rid = requestId ?? makeRequestId();
    // A new root entity goes into the active scene (with a
    // parent, the parent's scene decides).
    if ((op === 'createEntity' || op === 'instantiatePrefab' || op === 'pasteEntities') && this.activeScene !== null && typeof args === 'object' && args !== null) {
      const a = args as Record<string, unknown>;
      if ((a['parentId'] === undefined || a['parentId'] === null) && a['sceneId'] === undefined) args = { ...a, sceneId: this.activeScene };
    }
    const env = makeEnvelope(op, this.cfg.projectId, rid, expectedRevision, args, origin);
    this.save = 'pending';
    this.emit();
    let outcome = await this.postCommand(env);
    // A lost ack retries ONCE with the same requestId (idempotent; the backend
    // either replays `duplicated:true` or executes fresh — the revision
    // advances exactly once).
    if (outcome.status === 'lost') {
      this.save = 'pending';
      this.emit();
      outcome = await this.postCommand(env);
    }
    if (outcome.status === 'response' && outcome.response.ok) this.applyOwnAck(rid, outcome.response);
    return this.finishCommand(outcome, expectedRevision);
  }

  /**
   * Apply our own command's acked change now, not only when its WS
   * `mutation.applied` arrives (that event is then a duplicate, deduped by
   * requestId): the next command — and the panel that made this one — see
   * the result as soon as the command resolves. Only the next revision is
   * applied here; one past a revision we have not seen yet (someone else's
   * edit still on its way) is left to the WS events, in order.
   */
  private applyOwnAck(requestId: string, r: { revision: number; change: unknown }): void {
    this.ownCommands.recordOwnRevision(r.revision);
    if (r.revision !== this.projection.revision + 1 || r.change === null || typeof r.change !== 'object') return;
    const sceneId = (r as { sceneId?: unknown }).sceneId;
    this.applyMutationApplied({ requestId, revision: r.revision, change: r.change, ...(typeof sceneId === 'string' ? { sceneId } : {}) });
  }

  private finishCommand(
    outcome: CommandOutcome,
    expectedRevision: number,
  ): CommandResult {
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
        // A staged library commit says which scripts it recompiled (once each).
        const libraryStage = (r as { libraryStage?: CommandResultOk['libraryStage'] }).libraryStage;
        return { ok: true, revision: r.revision, ...(typeof createdId === 'string' ? { createdId } : {}), ...(libraryStage !== undefined ? { libraryStage } : {}) };
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
        // `limits_exceeded` carries the declared bound (limit/current/max)
        // so the UI can surface the exact rejected limit
        // instead of a generic message.
        const details = body.error as { limit?: string; current?: number; max?: number; sourceDigest?: string; behaviorId?: string; diagnostics?: CompileDiagnosticView[] };
        return {
          status: 'response',
          response: {
            ok: false,
            code,
            message: body.error.message,
            ...(details.limit !== undefined ? { limit: details.limit } : {}),
            ...(details.current !== undefined ? { current: details.current } : {}),
            ...(details.max !== undefined ? { max: details.max } : {}),
            // The digest to acknowledge / the dependent script that failed and why.
            ...(typeof details.sourceDigest === 'string' ? { sourceDigest: details.sourceDigest } : {}),
            ...(typeof details.behaviorId === 'string' ? { behaviorId: details.behaviorId } : {}),
            ...(Array.isArray(details.diagnostics) ? { diagnostics: details.diagnostics } : {}),
          },
        };
      }
      // A network-level failure (no response) = a lost ack.
      return { status: 'lost' };
    }
  }

  /**
   * Start an isolated play. `start` — Play
   * from a scene, with script variables or a project save (slot 1-99; the same body
   * `tl_play_start` sends; the backend resolves it).
   */
  async playStart(demo = false, start?: { sceneId?: string; mode?: string; variables?: Record<string, unknown>; save?: Record<string, unknown>; saveSlot?: string }): Promise<PlayStartResult> {
    const r = await this.api<PlayStartResult>('/projects/' + this.cfg.projectId + '/play', { options: { demo, ...(start ?? {}) } });
    this.activePlay = { ...r, snapshot: null };
    this.playReadySentFor = null; // a new play session: the ready send resets
    return r;
  }

  /** Stop the active play. */
  async playStop(playSessionId: string): Promise<void> {
    await this.api(`/projects/${this.cfg.projectId}/play/${playSessionId}/stop`, {});
    this.activePlay = null;
    if (this.playReadySentFor === playSessionId) this.playReadySentFor = null;
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
    if (this.playReadySentFor === playSessionId) return true; // already sent
    const ok = this.sendWsFrame({ type: 'play.preview.ready', playSessionId });
    if (ok) this.playReadySentFor = playSessionId;
    return ok;
  }

  /**
   * The preview reported load progress (`tl.load.progress`)
   * before it is ready: tell the backend at most once a second, so its
   * present timeout counts from the last progress. Nothing after `ready`.
   */
  sendPlayPreviewProgress(playSessionId: string): boolean {
    if (this.playReadySentFor === playSessionId) return true;
    const now = Date.now();
    if (this.progressSent !== null && this.progressSent.id === playSessionId && now - this.progressSent.at < 1000) return true;
    const ok = this.sendWsFrame({ type: 'play.preview.progress', playSessionId });
    if (ok) this.progressSent = { id: playSessionId, at: now };
    return ok;
  }
  private progressSent: { id: string; at: number } | null = null;

  /** Send the WS
   * `play.preview.failed` when the preview could not start (the editor
   * relays the preview's `tl.error`; the backend stops the
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

  /** The one WS client→server send path: a strict JSON
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

  /** The heartbeat: a WS `ping` at least every 20 s while the socket is
   * live (the server replies `pong`; a 60 s-silent connection is dropped
   * `heartbeat_timeout`). */
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

  // ---- gameplay authoring ------------------------------------

  /** Whether the project content has been read from the backend (vs unknown). */
  getContentLoaded(): boolean {
    return this.contentLoaded;
  }

  /**
   * The last-known `content.settings` map (tracked from applied
   * `setSettings` changes; `null` until one is observed — no accepted query
   * returns settings values, so a fresh session seeds the panel from the
   * registry defaults). See the `settings` field note above.
   */
  /** The project tag registry, ascending bit. */
  /** The entities of the open scenes (all of them for a single-scene project). */
  visibleEntities(): ProjectedEntity[] {
    const all = this.projection.listEntities();
    if (this.projection.scenes.length === 0) return all;
    // The same array until the projection or the open scenes change,
    // so views keyed on it (the Hierarchy, the Scene view sync) skip unchanged updates.
    const c = this.visibleCache;
    if (c !== null && c.all === all && c.open === this.openSceneIds) return c.list;
    const open = new Set(this.openSceneIds);
    const list = all.filter((e) => e.sceneId === undefined || open.has(e.sceneId));
    this.visibleCache = { all, open: this.openSceneIds, list };
    return list;
  }
  private visibleCache: { all: ProjectedEntity[]; open: readonly string[]; list: ProjectedEntity[] } | null = null;

  /** The open scenes (in index order) and the active one; empty for a single-scene project. */
  getSceneView(): { open: readonly string[]; active: string | null } {
    return { open: this.openSceneIds, active: this.activeScene };
  }

  /** Open or close a scene in this browser (the last open scene stays open). */
  setSceneOpen(sceneId: string, open: boolean): void {
    const known = this.projection.scenes.some((r) => r.sceneId === sceneId);
    if (!known) return;
    if (open && !this.openSceneIds.includes(sceneId)) this.openSceneIds = [...this.openSceneIds, sceneId];
    if (!open && this.openSceneIds.length > 1) this.openSceneIds = this.openSceneIds.filter((id) => id !== sceneId);
    this.reconcileScenes();
    this.cb.onSceneChanged();
  }

  /** Make a scene the active one (it is opened if needed). */
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

  /** The project materials. */
  getMaterials(): MaterialDef[] {
    return structuredClone(this.materials);
  }

  /** The environment (null = defaults). */
  getEnvironment(): EnvironmentConfig | null {
    return this.environment === null ? null : structuredClone(this.environment);
  }

  /** The project save schema (null: no project saves). */
  getSaveSchema(): SaveSchema | null {
    return this.saveSchema === null ? null : structuredClone(this.saveSchema);
  }

  /** The project's named collision layers ("default" is implicit). */
  getCollisionLayers(): string[] {
    return [...this.collisionLayers];
  }

  /** The game modes (the first is the start mode). */
  getModes(): GameMode[] {
    return structuredClone(this.modes);
  }

  /** The behavior group names. */
  getBehaviorGroups(): string[] {
    return [...this.behaviorGroups];
  }

  /** The event → cue table. */
  getEventCues(): EventCue[] {
    return structuredClone(this.eventCues);
  }

  /** The game shell (null: none). */
  getShell(): GameShell | null {
    return this.shell === null ? null : structuredClone(this.shell);
  }

  /** The project's input actions (null = the defaults). */
  getInput(): InputConfig | null {
    return this.input === null ? null : structuredClone(this.input);
  }

  /** The descriptor registry (null until the first full state). */
  getDescriptors(): DescriptorRegistry | null {
    return this.descriptors;
  }

  /** The default input actions (what a project without its own uses). */
  getInputDefaults(): InputConfig {
    return structuredClone(this.inputDefaults);
  }

  /** The standalone graph documents (the editor treats them as read-only values). */
  getGraphs(): readonly GraphDocument[] {
    return this.graphs;
  }

  /** The visual effects (the editor treats them as read-only values). */
  getEffects(): readonly EffectDef[] {
    return this.effects;
  }

  /** The project UI documents (the editor treats them as read-only values). */
  getUiDocuments(): readonly UiDocument[] {
    return this.uiDocuments;
  }

  /** The project UI themes. */
  getUiThemes(): readonly UiTheme[] {
    return this.uiThemes;
  }

  /** The conversations (read-only values). */
  getDialogues(): readonly DialogueDocument[] {
    return this.dialogues;
  }

  /** The speaker registry. */
  getSpeakers(): readonly DialogueSpeaker[] {
    return this.speakers;
  }

  /** The dialogue settings (null: the defaults). */
  getDialogueSettings(): DialogueSettings | null {
    return this.dialogueSettings;
  }

  /** The timelines (the editor treats them as read-only values). */
  getTimelines(): readonly TimelineAsset[] {
    return this.timelines;
  }

  /** The shared script libraries (the editor treats them as read-only values). */
  getScriptLibraries(): readonly ScriptLibrary[] {
    return this.scriptLibraries;
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

  /** The registered graph kinds (node catalogues, port types, rules), by kind id. */
  getGraphKinds(): Readonly<Record<string, GraphKindDef>> {
    return this.graphKinds;
  }

  /** The animator controllers. */
  getAnimators(): AnimatorController[] {
    return structuredClone(this.animators);
  }

  /** Each scene's bake. */
  /** The block types (content.blockTypes). */
  getBlockTypes(): readonly BlockType[] {
    return this.blockTypes;
  }

  /** The cell metadata schema (content.cellFields). */
  getCellFields(): readonly CellField[] {
    return this.cellFields;
  }

  /** The saved stamps (content.blockStamps). */
  getBlockStamps(): readonly BlockStamp[] {
    return this.blockStamps;
  }

  /** Every block layer's component, chunks and regions (entity id → layer). */
  getBlockLayers(): ReadonlyMap<string, BlockLayerView> {
    return this.blockLayers;
  }

  /** Bumped whenever a layer's cells, the layer list or the block types change. */
  getBlockRevision(): number {
    return this.blockRevision;
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

  getLighting(): Record<string, LightingBake> {
    return structuredClone(this.lighting);
  }

  getSettings(): Record<string, unknown> | null {
    return this.settings === null ? null : { ...this.settings };
  }

  /**
   * A bounded `queryGameConfig`: the
   * project content (tags, scenes, materials, environment, …); read-only.
   */
  async queryGameConfig(opts: { descriptors?: boolean } = {}): Promise<{ ok: true; revision: number } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.api<{ ok: true; projectId: string; revision: number }>(
        `/projects/${this.cfg.projectId}/commands`,
        { op: 'queryGameConfig', projectId: this.cfg.projectId, args: opts.descriptors === true ? { descriptors: true } : {} },
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

/** The backend's own headless editor opens the page with `headless=1`. */
function headlessEditor(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('headless') === '1';
  } catch {
    return false;
  }
}

/** One block layer as the editor holds it (queryBlocks). */
export interface BlockLayerView {
  component: BlockLayerComponent;
  chunks: Map<string, BlockChunk>;
  regions: BlockRegion[];
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
