/**
 * Editor session transport: the session
 * client. `SessionClientCore` (`client-core.ts`) holds the connection, the
 * projection and the command path; this subclass adds the project operations
 * that go over HTTP: gameplay authoring queries and commands, the content
 * browser, behavior publication, instance buffers, thumbnails,
 * asset uploads, project-file imports and content jobs.
 */

import type { FolderImportView } from './folder-upload';
import { makeRequestId, type MutationResponse, type Origin } from './envelope';
import { type AssetView } from './content-projection';
import type { DecalAtlasView } from './decal-atlas';
import type { PrefabCopyView } from './prefab-copy';
import {
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
  type ImportProposal,
  type ImportTarget,
} from './asset-browser';
import {
  planAcknowledgeTrust,
  planPublishDeclaration,
  planPublishSource,
  type CompileDiagnosticView,
} from './behavior-publication';
import type { ContentJobView } from '@thirdlight/protocol';
import type { KitCheckReport, MissingAssetFile, PropertyDeclaration, TrimPaddingProblem, TrimSheet } from '@thirdlight/project-model';

/** The backend's check of a trim sheet's image: its size, whether it was read from a lossy KTX2, the padding rows that differ. */
export interface TrimCheckView {
  ok: true;
  width: number;
  height: number;
  sizeMatches: boolean;
  transcoded: boolean;
  /** False: an ETC1S KTX2 whose padding differs, which its blocks alone can do: not judged (no problems listed). */
  paddingRead: boolean;
  problems: TrimPaddingProblem[];
}
import { type CommandResult, type ProjectFileListing, type IntegrityEntryView, type FileCheckView, makeAssetId, SessionClientCore } from './client-core';
import { FetchGate } from './fetch-gate';

/**
 * Texture-array requests in flight at once. The backend assembles arrays one at a time, so two keep it busy (one
 * answered, the next asked) while the browser's other connections stay free for commands and reads (`FetchGate`).
 */
export const SLOT_FETCHES_MAX = 2;

export * from './client-core';

export class SessionClient extends SessionClientCore {
  private readonly slotFetches = new FetchGate(SLOT_FETCHES_MAX);
  /**
   * Run one user action that sends several commands (a material and the
   * block types that wear it) and make what it stored one undo step. The
   * action gets `scope`: the client as the action sees it. Only commands
   * sent through the scope (directly, or by a client method called on it,
   * such as a model publish) are the action's own; anything sent through the
   * client itself meanwhile (an Inspector edit while a slow GLB uploads)
   * stays its own step. Browsers have no async context to tell the two
   * apart, so the scope is passed explicitly. `scope.grouped` joins the
   * action's step rather than starting another. The backend groups the
   * entries only when nothing else ran between them (else each stays a step).
   */
  async grouped<T>(action: (scope: SessionClient) => Promise<T>): Promise<T> {
    const ids: string[] = [];
    const scope = this.commandScope(ids);
    let done: () => void = () => undefined;
    const step = new Promise<void>((r) => (done = r));
    this.groupsUnderWay.add(step);
    try {
      return await action(scope);
    } finally {
      if (ids.length > 1) {
        try {
          await this.api(`/projects/${this.cfg.projectId}/history/group`, { requestIds: ids, origin: { kind: 'browser', clientId: this.sessionId } });
        } catch {
          // Not grouped (someone else's command ran between them): each stays its own undo step.
        }
      }
      this.groupsUnderWay.delete(step);
      done();
    }
  }

  /**
   * The grouped actions not finished yet, the request that makes their
   * commands one step included. An undo or redo waits for them: sent in
   * between, it would take back only the action's last command (its step
   * not joined yet), leaving the rest.
   */
  private readonly groupsUnderWay = new Set<Promise<void>>();

  override command(op: string, args: unknown, expectedRevision: number, requestId?: string, origin?: Origin): Promise<CommandResult> {
    if (op !== 'undo' && op !== 'redo') return super.command(op, args, expectedRevision, requestId, origin);
    // The history is shared with MCP and other tools: an undo or redo goes against the revision the user saw. This
    // editor's own commands since then move it on (own commands); a command anyone else stored meanwhile makes the
    // backend refuse it, and it is not sent again (it would take that command back, unseen): the user presses it
    // again once the view shows the change.
    if (this.groupsUnderWay.size === 0) return this.commandAsSeen(op, args, expectedRevision, requestId, origin);
    const waiting = [...this.groupsUnderWay];
    return Promise.allSettled(waiting).then(() => this.commandAsSeen(op, args, expectedRevision, requestId, origin));
  }

  /** The client as one `grouped` action sees it: its stored commands' request ids go to `ids`, in the order they were stored. */
  private commandScope(ids: string[]): SessionClient {
    const send = (op: string, args: unknown, expectedRevision: number, requestId?: string, origin?: Origin): Promise<CommandResult> => {
      const rid = requestId ?? makeRequestId();
      const p = this.command(op, args, expectedRevision, rid, origin);
      // Registered before the caller's own continuation, so the ids are in the order the commands were stored.
      void p.then((r) => {
        if (r.ok) ids.push(rid);
      });
      return p;
    };
    const join = <T>(action: (scope: SessionClient) => Promise<T>): Promise<T> => action(scope);
    // Every other member is the client's own; methods run with the scope as `this`, so their commands are recorded.
    const scope: SessionClient = new Proxy(this, {
      get: (target, prop, receiver) => (prop === 'command' ? send : prop === 'grouped' ? join : Reflect.get(target, prop, receiver)),
      set: (target, prop, value) => Reflect.set(target, prop, value),
    });
    return scope;
  }

  /** One entity with its full components (read-only). */
  async queryEntity(entityId: string): Promise<{ ok: true; entity: Record<string, unknown>; parentChain: string[]; prefabCopy: PrefabCopyView | null } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.api<{ ok: true; entity: Record<string, unknown>; parentChain: string[]; prefabCopy?: PrefabCopyView }>(
        `/projects/${this.cfg.projectId}/commands`,
        { op: 'queryEntity', projectId: this.cfg.projectId, args: { entityId } },
      );
      return { ok: true, entity: r.entity, parentChain: r.parentChain, prefabCopy: r.prefabCopy ?? null };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * Add an engine content pack (the Basic Kit) to the project: the backend publishes its files and runs its
   * commands, each an ordinary command on the change feed, together one undo step. Refused when the project
   * has any of its items already.
   */
  async addPack(packId: string): Promise<{ ok: true; added: number } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.api<{ ok: true; added: unknown[] }>(`/projects/${this.cfg.projectId}/packs/${encodeURIComponent(packId)}`, { origin: { kind: 'browser', clientId: this.sessionId } });
      return { ok: true, added: r.added.length };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * A kit checked against the trim sheet spec on the backend: its pieces from their files, its sheet's row
   * table, and with `image` its albedo's pixels (decoded on the backend; a sheet checked before is not
   * decoded again).
   */
  async kitCheck(kitId: string, image: boolean): Promise<KitCheckReport | { ok: false; error: { code: string; message: string } }> {
    try {
      return await this.request<KitCheckReport>(`/projects/${this.cfg.projectId}/kits/${encodeURIComponent(kitId)}/check${image ? '?image=1' : ''}`, { method: 'GET' });
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** A page or section of the manual of this build, as text (every part joined). */
  async docsText(topic: string): Promise<{ ok: true; title: string; text: string } | { ok: false; error: { code: string; message: string } }> {
    try {
      let part = 1;
      let title = '';
      const texts: string[] = [];
      for (;;) {
        const r = await this.request<{ ok: true; title: string; text: string; parts: number }>(`/docs?topic=${encodeURIComponent(topic)}&part=${part}`, { method: 'GET' });
        title = r.title;
        texts.push(r.text);
        if (part >= r.parts) break;
        part += 1;
      }
      return { ok: true, title, text: texts.join('\n') };
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
   * A bounded `queryEntities` page with the `component` filter: the page contains only entities carrying `component`,
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

  /** `setSettings` through the ordinary command path (the touched keys only). */
  async setSettings(
    settings: Record<string, number>,
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('setSettings', { settings }, expectedRevision, requestId);
  }

  /**
   * `setComponent` through the ordinary command path (the v3 union):
   * `value` is the partial field replacement or `null`
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

  /** `createEntity` with `components`. */
  async createGameEntity(
    args: Record<string, unknown>,
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('createEntity', args, expectedRevision, requestId);
  }

  /** `deleteEntity` through the ordinary command path. */
  async deleteEntityCommand(
    entityId: string,
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('deleteEntity', { entityId }, expectedRevision, requestId);
  }

  // ---- behavior publication -----------------------------------

  /**
   * Stage one source container through the EXISTING non-authoritative content
   * stage route (`POST /content/stages` + the bounded frame PUTs).
   * Staging writes no authoritative state and advances no revision. The digest
   * is computed client-side over the exact container bytes (the same SHA-256
   * the preparer binds), because no accepted query returns a behavior digest.
   */
  async stageBehaviorSource(
    bytes: Uint8Array,
  ): Promise<{ ok: true; stageId: string; digest: string; byteLength: number } | { ok: false; error: { code: string; message: string } }> {
    return this.stageBytes(bytes);
  }

  /** Stage a file's bytes for a command that reads one (a heightmap import; a behavior source above). */
  async stageBytes(
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

  /** `acknowledgeBehaviorTrust` through the ordinary command path. */
  async acknowledgeBehaviorTrust(
    sourceDigest: string,
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    return this.command('acknowledgeBehaviorTrust', planAcknowledgeTrust(sourceDigest), expectedRevision, requestId);
  }

  /** `publishBehavior` declaration modes through the ordinary command path. */
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
   * preparation step is the workspace's digest-bound preparation layer;
   * until a wire route exists for it the backend
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
      /** The stage holding the bytes — prepared (compiled) and published by the backend route. */
      stageId?: string;
    },
    expectedRevision: number,
    requestId?: string,
  ): Promise<{ ok: true; revision: number } | { ok: false; response: MutationResponse }> {
    if (args.stageId === undefined) return this.command('publishBehavior', planPublishSource(args), expectedRevision, requestId);
    // The preparation route compiles the staged source (deriving
    // the declaration when the code declares `export const properties`) and
    // runs the same `publishBehavior{mode:"source"}` command.
    try {
      const res = await this.request<{ ok: true; revision: number }>(`/projects/${this.cfg.projectId}/content/behaviors/source`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stageId: args.stageId,
          behaviorId: args.behaviorId,
          displayName: args.displayName,
          declaration: args.declaration,
          expectedRevision,
          requestId: requestId ?? makeRequestId(),
        }),
      });
      return { ok: true, revision: res.revision };
    } catch (e) {
      const body = (e as { body?: { error?: { code?: string; message?: string; sourceDigest?: string; diagnostics?: { message?: string }[] } } }).body;
      const err = body?.error;
      const detail = err?.diagnostics?.[0]?.message;
      return { ok: false, response: { ok: false, code: err?.code ?? 'internal', message: detail ?? err?.message ?? 'the source was not published', ...(typeof err?.sourceDigest === 'string' ? { sourceDigest: err.sourceDigest } : {}) } };
    }
  }

  /**
   * The published source-graph container of one behavior as text
   * (`null` when the behavior has no source yet).
   */
  async behaviorSource(
    behaviorId: string,
  ): Promise<{ ok: true; source: string | null; sourceDigest: string | null } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.request<{ ok: true; source: string | null; sourceDigest?: string }>(
        `/projects/${this.cfg.projectId}/content/behaviors/${encodeURIComponent(behaviorId)}/source`,
        { method: 'GET' },
      );
      return { ok: true, source: r.source, sourceDigest: r.sourceDigest ?? null };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * Compile a source-graph container without publishing it (the
   * source route's `check` mode — the same backend compiler; nothing is
   * written). Returns the compiler's bounded diagnostics.
   */
  async checkBehaviorSource(
    behaviorId: string,
    bytes: Uint8Array,
    declaration: PropertyDeclaration | null,
  ): Promise<
    | { ok: true; compiled: true; declaredInCode: boolean; declaration: PropertyDeclaration; outputByteLength: number }
    | { ok: true; compiled: false; code: string; reason: string; diagnostics: CompileDiagnosticView[] }
    | { ok: false; error: { code: string; message: string } }
  > {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    try {
      const r = await this.request<{
        ok: true;
        compiled: boolean;
        declaredInCode?: boolean;
        declaration?: PropertyDeclaration;
        outputByteLength?: number;
        code?: string;
        reason?: string;
        diagnostics?: CompileDiagnosticView[];
      }>(`/projects/${this.cfg.projectId}/content/behaviors/source`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ check: true, behaviorId, bytesBase64: btoa(binary), ...(declaration !== null ? { declaration } : {}) }),
      });
      if (r.compiled) {
        return { ok: true, compiled: true, declaredInCode: r.declaredInCode === true, declaration: r.declaration ?? { properties: [] }, outputByteLength: r.outputByteLength ?? 0 };
      }
      return { ok: true, compiled: false, code: r.code ?? 'behavior_compile_failed', reason: r.reason ?? '', diagnostics: r.diagnostics ?? [] };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * Compile a visual script's stored graph without publishing
   * it (the source route's `check` + `graph` mode). Returns the digest the
   * publication will ask trust for, or the problems (with their nodes).
   */
  async checkBehaviorGraph(
    behaviorId: string,
  ): Promise<
    | { ok: true; compiled: true; sourceDigest: string; declaration: PropertyDeclaration; warnings: { message: string; nodeId?: string }[] }
    | { ok: true; compiled: false; code: string; diagnostics: CompileDiagnosticView[]; warnings: { message: string; nodeId?: string }[] }
    | { ok: false; error: { code: string; message: string } }
  > {
    try {
      const r = await this.request<{ ok: true; compiled: boolean; sourceDigest?: string; declaration?: PropertyDeclaration; code?: string; diagnostics?: CompileDiagnosticView[]; warnings?: { message: string; nodeId?: string }[] }>(
        `/projects/${this.cfg.projectId}/content/behaviors/source`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ check: true, graph: true, behaviorId }) },
      );
      if (r.compiled) return { ok: true, compiled: true, sourceDigest: r.sourceDigest ?? '', declaration: r.declaration ?? { properties: [] }, warnings: r.warnings ?? [] };
      return { ok: true, compiled: false, code: r.code ?? 'behavior_compile_failed', diagnostics: r.diagnostics ?? [], warnings: r.warnings ?? [] };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * Publish a visual script — the backend generates the source
   * from the stored graph and runs the ordinary preparation + one
   * `publishBehavior{mode:"source"}` command (trust per exact digest).
   */
  async publishBehaviorGraph(
    behaviorId: string,
    displayName: string,
    expectedRevision: number,
  ): Promise<{ ok: true; revision: number; sourceDigest: string } | { ok: false; code: string; message: string; sourceDigest?: string; diagnostics?: CompileDiagnosticView[] }> {
    try {
      const r = await this.request<{ ok: true; revision: number; sourceDigest: string }>(`/projects/${this.cfg.projectId}/content/behaviors/source`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ graph: true, behaviorId, displayName, expectedRevision, requestId: makeRequestId() }),
      });
      return { ok: true, revision: r.revision, sourceDigest: r.sourceDigest };
    } catch (e) {
      const err = (e as { body?: { error?: { code?: string; message?: string; sourceDigest?: string; diagnostics?: CompileDiagnosticView[] } } }).body?.error;
      return { ok: false, code: err?.code ?? 'internal', message: err?.diagnostics?.[0]?.message ?? err?.message ?? 'the visual script was not published', ...(err?.sourceDigest !== undefined ? { sourceDigest: err.sourceDigest } : {}), ...(err?.diagnostics !== undefined ? { diagnostics: err.diagnostics } : {}) };
    }
  }

  /** The observed trust digests (from the projection; advanced by changes only). */
  acknowledgedDigests(): string[] {
    return this.prefabs.listTrust().map((e) => e.sourceDigest);
  }

  /** `POST /content/stages` + the bounded frame PUTs + the inspect (within the upload bounds).
   * `kind` selects the inspector (`'audio'` = the audio header
   * inspector, any format and length; absent = the GLB inspector)
   * and `animation` requests the role-aware animated GLB profile (stages 3–6
   * validate the bindings against the staged bytes' real clip list). */
  /**
   * Publish an instance-set buffer (10 float32 per copy) and
   * return its digest. Small sets go inline; larger ones through a stage.
   */
  async publishInstanceBuffer(floats: Float32Array): Promise<{ ok: true; digest: string; count: number } | { ok: false; error: { code: string; message: string } }> {
    try {
      const path = `/projects/${this.cfg.projectId}/content/buffers`;
      if (floats.length <= 4096 * 10) {
        const r = await this.request<{ ok: true; digest: string; count: number }>(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ transforms: Array.from(floats) }),
        });
        return { ok: true, digest: r.digest, count: r.count };
      }
      const bytes = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
      const stage = await this.request<{ ok: true; stageId: string }>(`/projects/${this.cfg.projectId}/content/stages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'instance buffer' }),
      });
      for (const frame of planUploadFrames(bytes.length)) {
        await this.request(`/projects/${this.cfg.projectId}/content/stages/${stage.stageId}/bytes`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'x-thirdlight-offset': String(frame.offset), 'x-thirdlight-total': String(bytes.length) },
          body: bytes.slice(frame.offset, frame.offset + frame.length),
        });
      }
      const r = await this.request<{ ok: true; digest: string; count: number }>(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stageId: stage.stageId }),
      });
      return { ok: true, digest: r.digest, count: r.count };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** The bytes of an instance-set buffer (the viewport draws the copies from them). */
  async instanceBufferBytes(digest: string): Promise<Float32Array> {
    return new Float32Array(await this.bufferBytes(digest));
  }

  /** A stored buffer's bytes by digest (an instance set's copies, a terrain tile). */
  async bufferBytes(digest: string): Promise<ArrayBuffer> {
    const res = await fetch(`${this.cfg.authoringOrigin}/api/v1/projects/${this.cfg.projectId}/content/buffers/${digest}`, {
      headers: { authorization: `Bearer ${this.cfg.authoringToken}`, origin: this.cfg.authoringOrigin },
    });
    if (!res.ok) throw new Error(`buffer read failed (HTTP ${res.status})`);
    return res.arrayBuffer();
  }

  /** The cached tile thumbnail of one asset version (and piece), or null when none is cached yet. */
  async thumbnail(digest: string, piece: string | null, make?: { asset: string }): Promise<Blob | null> {
    const params = new URLSearchParams();
    if (piece !== null) params.set('piece', piece);
    // A texture's thumbnail the backend makes from its image when the cache has none.
    if (make !== undefined) params.set('asset', make.asset);
    const q = params.size === 0 ? '' : `?${params.toString()}`;
    const res = await fetch(`${this.cfg.authoringOrigin}/api/v1/projects/${this.cfg.projectId}/content/thumbnails/${digest}${q}`, {
      headers: { authorization: `Bearer ${this.cfg.authoringToken}`, origin: this.cfg.authoringOrigin },
    });
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) throw new Error(`thumbnail read failed (HTTP ${res.status})`);
    return res.blob();
  }

  /** Store a rendered tile thumbnail (PNG) in the backend's cache. */
  async storeThumbnail(digest: string, piece: string | null, png: Blob | Uint8Array): Promise<void> {
    const q = piece === null ? '' : `?piece=${encodeURIComponent(piece)}`;
    const res = await fetch(`${this.cfg.authoringOrigin}/api/v1/projects/${this.cfg.projectId}/content/thumbnails/${digest}${q}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.cfg.authoringToken}`, origin: this.cfg.authoringOrigin, 'content-type': 'image/png' },
      body: png as BodyInit,
    });
    if (!res.ok) throw new Error(`thumbnail write failed (HTTP ${res.status})`);
  }

  async uploadAsset(
    bytes: Uint8Array,
    options: {
      target?: ImportTarget;
      displayName?: string | null;
      kind?: 'model' | 'audio' | 'texture' | 'font';
      animation?: { entityId: string; roles: unknown };
      /** A texture encoded to KTX2 on import (or as data). */
      ktx2?: 'color' | 'normal' | 'data';
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
      ...(options.ktx2 !== undefined ? { ktx2: options.ktx2 } : {}),
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
   * Pack a KTX2 texture (a texture array with several layers)
   * from the project's texture assets, channel by channel, and
   * publish it as a new texture asset (one `publishAsset`, one undo). The
   * result says which layers were encoded again from a lossy KTX2 and
   * whether the layers were joined as stored.
   */
  async packTexture(req: { layers: ({ assetId: string; channel: 'r' | 'g' | 'b' | 'a' } | { value: number })[][]; encoding: 'color' | 'normal' | 'data'; displayName: string }): Promise<{ ok: true; assetId: string; reencoded: boolean[]; joined: boolean } | { ok: false; error: { code: string; message: string } }> {
    try {
      const packed = await this.request<{ ok: true; packedFrom?: { reencoded?: boolean[] }; joined?: boolean; proposal: { status?: string; sourceDigest?: string; sourceByteLength?: number; importRecipe?: unknown; metrics?: unknown } }>(`/projects/${this.cfg.projectId}/content/textures/pack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
      const p = packed.proposal;
      if (p.status !== 'ok' || packed.packedFrom === undefined) return { ok: false, error: { code: 'import_rejected', message: 'the packed texture was not accepted by the texture inspector' } };
      const assetId = makeAssetId();
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const res = await this.command('publishAsset', { mode: 'create', assetId, kind: 'texture', displayName: req.displayName, sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, packedFrom: packed.packedFrom, importRecipe: p.importRecipe, metrics: p.metrics, importedAt: now }, this.projection.revision);
      if (!res.ok) {
        const r = res.response;
        return { ok: false, error: r.ok === false ? { code: r.code, message: r.message ?? r.code } : { code: 'network', message: 'the command response was lost' } };
      }
      return { ok: true, assetId, reencoded: packed.packedFrom.reencoded ?? req.layers.map(() => false), joined: packed.joined === true };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * Upload one file into the game folder at `path` (a folder dropped from the
   * computer arrives file by file): the bounded stage upload, then the stage
   * is written there. Another file already at the path is never replaced.
   */
  async uploadFileTo(path: string, bytes: Uint8Array): Promise<{ ok: true; path: string } | { ok: false; error: { code: string; message: string } }> {
    try {
      const stage = await this.request<{ ok: true; stageId: string }>(`/projects/${this.cfg.projectId}/content/stages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      for (const frame of planUploadFrames(bytes.length)) {
        await this.request(`/projects/${this.cfg.projectId}/content/stages/${stage.stageId}/bytes`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'x-thirdlight-offset': String(frame.offset), 'x-thirdlight-total': String(bytes.length) },
          body: bytes.slice(frame.offset, frame.offset + frame.length),
        });
      }
      const filed = await this.request<{ ok: true; path: string }>(`/projects/${this.cfg.projectId}/content/stages/${stage.stageId}/file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
      return { ok: true, path: filed.path };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** `importAssets`: every supported file of a game-folder folder as assets, with labels, in one command. */
  async importFolder(folder: string, labels: readonly string[], ktx2?: 'color' | 'normal' | 'data'): Promise<{ ok: true; added: number; report?: FolderImportView } | { ok: false; error: { code: string; message: string }; report?: FolderImportView }> {
    const res = await this.command('importAssets', { folder, ...(labels.length > 0 ? { labels: [...labels] } : {}), ...(ktx2 !== undefined ? { ktx2 } : {}) }, this.projection.revision);
    if (!res.ok) {
      const r = res.response;
      return { ok: false, error: r.ok === false ? { code: r.code, message: r.message ?? r.code } : { code: 'network', message: 'the command response was lost' }, ...(r.folderImport !== undefined ? { report: r.folderImport } : {}) };
    }
    const added = (res.change as { added?: unknown[] } | undefined)?.added?.length ?? 0;
    return { ok: true, added, ...(res.folderImport !== undefined ? { report: res.folderImport } : {}) };
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
    options: { target: ImportTarget; kind: 'model' | 'audio' | 'texture' | 'font'; displayName?: string; ktx2?: 'color' | 'normal' | 'data'; onState?: (s: AssetImportState) => void },
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
          body: JSON.stringify({ path: sourcePath, kind: options.kind, ...(options.displayName ? { displayName: options.displayName } : {}), ...(options.ktx2 !== undefined ? { ktx2: options.ktx2 } : {}) }),
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
  /**
   * "Check files": the backend brings the catalog in step with the game
   * folder (a file moved with its sidecar keeps its asset, a changed file is
   * imported again, the import cache is made whole) and answers the
   * integrity report after it. Its changes arrive on the change feed.
   */
  async checkFiles(): Promise<{ ok: true; entries: IntegrityEntryView[]; check: FileCheckView } | { ok: false; error: { code: string; message: string } }> {
    try {
      // Only the entries that need attention (a project of thousands of files answers with its problems, not every file).
      const r = await this.request<{ ok: true; entries: IntegrityEntryView[]; check: FileCheckView }>(`/projects/${this.cfg.projectId}/content/files/check`, { method: 'POST', body: '{"problems":true}' });
      return { ok: true, entries: r.entries, check: r.check };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** One page of the asset files missing from the game folder, with what uses each (read after every file check). */
  async missingFiles(offset: number, limit: number): Promise<{ ok: true; total: number; files: MissingAssetFile[] } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.request<{ ok: true; total: number; files: MissingAssetFile[] }>(`/projects/${this.cfg.projectId}/problems/missing-files?offset=${offset}&limit=${limit}`, { method: 'GET' });
      return { ok: true, total: r.total, files: r.files };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  async contentIntegrity(): Promise<{ ok: true; entries: IntegrityEntryView[] } | { ok: false; error: { code: string; message: string } }> {
    try {
      const r = await this.request<{ ok: true; entries: IntegrityEntryView[] }>(`/projects/${this.cfg.projectId}/content/integrity`, { method: 'GET' });
      return { ok: true, entries: r.entries };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * A second inspect of the SAME stage with the role-aware
   * animated GLB profile: the staged bytes
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
   * The authenticated committed asset-byte read. This is
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

  /** A model version's distance-field file (bricks and surfels; null: the model has nothing to make one of). */
  async modelBricks(assetId: string, version: number): Promise<Uint8Array | null> {
    const res = await fetch(`${this.cfg.authoringOrigin}/api/v1/projects/${this.cfg.projectId}/content/assets/${assetId}/versions/${version}/bricks`, {
      headers: { authorization: `Bearer ${this.cfg.authoringToken}`, origin: this.cfg.authoringOrigin },
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`bricks read failed (HTTP ${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * The texture array of per-layer slots (the layers' current versions; the backend assembles it once and caches it).
   * `height`: its alpha is a height (a layer without one gets a height from its brightness).
   */
  async textureSlotBytes(layers: readonly string[], mode: string, height = false): Promise<Uint8Array> {
    return this.slotFetches.run(async () => {
      const res = await fetch(`${this.cfg.authoringOrigin}/api/v1/projects/${this.cfg.projectId}/content/textures/slots`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.authoringToken}`, origin: this.cfg.authoringOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ layers, mode, ...(height ? { height: true } : {}) }),
      });
      if (!res.ok) throw { status: res.status, body: null };
      return new Uint8Array(await res.arrayBuffer());
    });
  }

  /**
   * The slot array at a preview size, made on the backend ahead of the other encodes (never stored), for a view to
   * draw while the array itself is made. Null: the array is made already (ask for it), or no preview could be made.
   */
  async textureSlotPreviewBytes(layers: readonly string[], mode: string, height = false): Promise<Uint8Array | null> {
    try {
      const res = await fetch(`${this.cfg.authoringOrigin}/api/v1/projects/${this.cfg.projectId}/content/textures/slots`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.authoringToken}`, origin: this.cfg.authoringOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ layers, mode, ...(height ? { height: true } : {}), preview: true }),
      });
      if (res.status !== 200) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Each slot layer's mean colour (RGBA 0–255) the backend reads ahead of the array's encode, and whether the array
   * itself is made already. Null on a failure.
   */
  async textureSlotBase(layers: readonly string[], mode: string, height = false): Promise<{ base: readonly (readonly number[])[]; final: boolean } | null> {
    try {
      const r = await this.request<{ ok: true; base: number[][]; final: boolean }>(`/projects/${this.cfg.projectId}/content/textures/slot-base`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layers, mode, ...(height ? { height: true } : {}) }),
      });
      return { base: r.base, final: r.final };
    } catch {
      return null;
    }
  }

  /**
   * Which textures carry a height in A, as the backend checks a layered surface's albedos: `height`, `flat` (none:
   * its blends are soft, a brightness height stands in), or null (not a readable single texture). Null on a failure.
   */
  async heightInAlpha(ids: readonly string[]): Promise<Readonly<Record<string, 'height' | 'flat' | null>> | null> {
    try {
      const r = await this.request<{ ok: true; textures: Record<string, 'height' | 'flat' | null> }>(`/projects/${this.cfg.projectId}/content/textures/height-alpha?ids=${ids.map(encodeURIComponent).join(',')}`, { method: 'GET' });
      return r.textures;
    } catch {
      return null;
    }
  }

  /**
   * The decal pages Play and the export will use (`compose`: made now, the Scene view then draws from them; `preview`:
   * at a preview size while some page is still to be made, the pages themselves composed behind it), or why not. One composition runs at a time per project; the encoding runs on the backend's encoder thread.
   */
  async decalAtlas(compose = false, preview = false): Promise<{ ok: true; view: DecalAtlasView } | { ok: false; error: { code: string; message: string } }> {
    try {
      const view = await this.request<DecalAtlasView>(`/projects/${this.cfg.projectId}/content/decal-pages${compose && preview ? '?preview=1' : ''}`, { method: compose ? 'POST' : 'GET' });
      return { ok: true, view };
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /** A composed decal page array's KTX2 bytes (the last composition's). */
  async decalPageArrayBytes(arrayId: string): Promise<Uint8Array> {
    const res = await fetch(`${this.cfg.authoringOrigin}/api/v1/projects/${this.cfg.projectId}/content/decal-pages/arrays/${encodeURIComponent(arrayId)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.cfg.authoringToken}`, origin: this.cfg.authoringOrigin },
    });
    if (!res.ok) throw { status: res.status, body: null };
    return new Uint8Array(await res.arrayBuffer());
  }

  /** A trim sheet's image checked against its row table on the backend (its padding, its size). */
  async checkTrimSheet(texture: string, trim: TrimSheet): Promise<TrimCheckView | { ok: false; error: { code: string; message: string } }> {
    try {
      return await this.request<TrimCheckView>(`/projects/${this.cfg.projectId}/content/textures/trim-check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texture, trim }),
      });
    } catch (e) {
      return { ok: false, error: this.describeError(e) };
    }
  }

  /**
   * A descriptor resolver for the three-adapter visual path: it
   * receives only the immutable version facts and returns the verified bytes.
   */
  assetByteResolver(): (descriptor: { assetId: string; version: number }) => Promise<Uint8Array> {
    return (descriptor) => this.assetBytes(descriptor.assetId, descriptor.version);
  }
}
