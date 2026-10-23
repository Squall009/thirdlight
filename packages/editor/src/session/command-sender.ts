/**
 * The command path: every edit the editor makes goes to the backend as a
 * command (the browser never mutates files). Own commands go one at a time
 * in the order they were made; a lost ack is retried once with the same
 * requestId; a conflict caused only by this editor's own earlier edits, or by
 * someone else's edit the change feed had not delivered yet, is sent again
 * against the current revision (own-commands.ts). The answer drives the save
 * status the client shows.
 */

import type { CommandError } from '@thirdlight/commands';
import { RESOURCE_CREATING_OPS } from '@thirdlight/protocol';
import { makeEnvelope, makeRequestId, refusalResponse, type CommandOutcome, type MutationResponse, type Origin } from './envelope';
import type { FolderImportView } from './folder-upload';
import { CHANGE_FEED_CATCH_UP_MS, CHANGE_FEED_POLL_MS, OwnCommands, WHOLE_DOCUMENT_OPS } from './own-commands';
import type { Projection } from './projection';

/** A command's answer (a staged library commit also says which scripts it recompiled). */
export interface CommandResultOk {
  ok: true;
  revision: number;
  createdId?: string;
  libraryStage?: { dependents: { behaviorId: string; outputDigest: string }[]; compiled: number };
  /** A folder import's report (skipped, unsupported and refused files). */
  folderImport?: FolderImportView;
  /** The applied change (a folder import lists the assets it added). */
  change?: unknown;
  /** A terrain edit's report: the tiles it changed and added ([x, z]), the samples changed. */
  terrain?: { tiles: [number, number][]; added: [number, number][]; changed: number; clamped?: number; scatter?: [number, number][] };
}
export type CommandResult = CommandResultOk | { ok: false; response: MutationResponse };

type SaveStatus = 'idle' | 'pending' | 'saved' | 'error';

/** A command refused because the project moved on since the view it was made on. */
export interface CommandConflict {
  currentRevision: number;
  expectedRevision: number;
  message: string;
  /** An undo or redo refused so: never sent again, the user presses it again once the view shows the change. */
  refused?: 'undo' | 'redo';
}

/** What a command's answer does to the client's save status, error and conflict (a key left out stays). */
export interface CommandStatus {
  save: SaveStatus;
  error?: { code: string; message: string } | null;
  conflict?: CommandConflict | null;
}

export interface CommandSenderHost {
  readonly projectId: string;
  readonly projection: Projection;
  /** POST a body to the project's commands route. */
  post<T>(body: unknown): Promise<T>;
  /** The scene and folder new items go into (the client's view settings). */
  activeScene(): string | null;
  newItemFolder(): string;
  /** Apply an own command's acked change as the WS `mutation.applied` would. */
  applyAcked(ev: { requestId: string; revision: number; change: unknown; sceneId?: string }): void;
  report(status: CommandStatus): void;
  /** Read the backend's state again (the feed did not catch up in time). */
  resync(): Promise<void>;
  disposed(): boolean;
}

export class CommandSender {
  private readonly ownCommands = new OwnCommands();

  constructor(private readonly host: CommandSenderHost) {}

  /**
   * Send a command. `args` may be a function: it is called at send time, so
   * args derived from the client state see every earlier edit. With
   * `afterFeed`, a refusal because someone else's command came first is sent
   * once more after the feed caught up; without, it is surfaced.
   */
  issue(op: string, args: unknown, expectedRevision: number, requestId: string | undefined, origin: Origin, afterFeed: boolean): Promise<CommandResult> {
    const lazy = typeof args === 'function';
    // A whole-document op with args built at call time keeps its revision (stale args conflict instead of undoing an edit).
    const rebases = lazy || !WHOLE_DOCUMENT_OPS.has(op);
    const resends = rebases && afterFeed;
    const projection = this.host.projection;
    return this.ownCommands.enqueue(async () => {
      const expected = rebases ? this.ownCommands.rebase(expectedRevision, projection.revision) : expectedRevision;
      const first = await this.send(op, lazy ? (args as () => unknown)() : args, expected, requestId, origin, !resends);
      if (first.ok || first.response.ok || first.response.code !== 'revision_conflict' || !resends) return first;
      const behind = first.response.currentRevision;
      if (!(await this.rebaseAfterFeed(typeof behind === 'number' ? behind : projection.revision + 1))) {
        return this.finish({ status: 'response', response: first.response }, expected, op);
      }
      return this.send(op, lazy ? (args as () => unknown)() : args, projection.revision, requestId, origin, true);
    });
  }

  /**
   * Wait until the change feed has brought the projection to `revision`
   * (bounded by `CHANGE_FEED_CATCH_UP_MS`; past it the state is read again,
   * as after a gap). True when the projection got there.
   */
  private async rebaseAfterFeed(revision: number): Promise<boolean> {
    const projection = this.host.projection;
    const deadline = Date.now() + CHANGE_FEED_CATCH_UP_MS;
    while (projection.revision < revision && Date.now() < deadline && !this.host.disposed()) {
      await new Promise((r) => setTimeout(r, CHANGE_FEED_POLL_MS));
    }
    if (projection.revision < revision && !this.host.disposed()) await this.host.resync();
    return projection.revision >= revision;
  }

  private async send(op: string, args: unknown, expectedRevision: number, requestId: string | undefined, origin: Origin, final: boolean): Promise<CommandResult> {
    const rid = requestId ?? makeRequestId();
    // A new root entity goes into the active scene (with a
    // parent, the parent's scene decides).
    const activeScene = this.host.activeScene();
    if ((op === 'createEntity' || op === 'instantiatePrefab' || op === 'pasteEntities' || op === 'createEntities') && activeScene !== null && typeof args === 'object' && args !== null) {
      const a = args as Record<string, unknown>;
      // An item under an object that already exists goes to that object's scene.
      const named = (id: unknown): boolean => typeof id === 'string' && this.host.projection.getEntity(id) !== undefined;
      const parented = op === 'createEntities' ? Array.isArray(a['entities']) && (a['entities'] as { parentId?: unknown }[]).some((x) => named(x?.parentId)) : named(a['parentId']);
      if (!parented && a['sceneId'] === undefined) args = { ...a, sceneId: activeScene };
    }
    // A new scene or resource goes into the current folder (a record the op only changes stays where its file is).
    const folder = this.host.newItemFolder();
    if (folder !== '' && RESOURCE_CREATING_OPS.includes(op) && typeof args === 'object' && args !== null && (args as Record<string, unknown>)['folder'] === undefined) {
      args = { ...(args as Record<string, unknown>), folder };
    }
    const env = makeEnvelope(op, this.host.projectId, rid, expectedRevision, args, origin);
    this.host.report({ save: 'pending' });
    let outcome = await this.post(env);
    // A lost ack retries ONCE with the same requestId (idempotent; the backend
    // either replays `duplicated:true` or executes fresh — the revision
    // advances exactly once).
    if (outcome.status === 'lost') {
      this.host.report({ save: 'pending' });
      outcome = await this.post(env);
    }
    if (outcome.status === 'response' && outcome.response.ok) this.applyOwnAck(rid, outcome.response);
    // A conflict that may still be sent again is not shown until it is the answer.
    if (!final && outcome.status === 'response' && !outcome.response.ok && outcome.response.code === 'revision_conflict') return { ok: false, response: outcome.response };
    return this.finish(outcome, expectedRevision, op);
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
    if (r.revision !== this.host.projection.revision + 1 || r.change === null || typeof r.change !== 'object') return;
    const sceneId = (r as { sceneId?: unknown }).sceneId;
    this.host.applyAcked({ requestId, revision: r.revision, change: r.change, ...(typeof sceneId === 'string' ? { sceneId } : {}) });
  }

  private finish(outcome: CommandOutcome, expectedRevision: number, op: string): CommandResult {
    if (outcome.status === 'response') {
      const r = outcome.response;
      if (r.ok) {
        // The projection advances via the `mutation.applied` WS event (deduped
        // by requestId); the HTTP ack only drives the save status.
        // An undo or redo of a grouped step that the backend could not take whole: shown, not passed off as done.
        const incomplete = (r as { groupIncomplete?: { code: string; message: string } }).groupIncomplete;
        this.host.report({ save: 'saved', error: incomplete !== undefined ? { code: incomplete.code, message: incomplete.message } : null, conflict: null });
        const createdId = (r as { createdId?: unknown }).createdId;
        // A staged library commit says which scripts it recompiled (once each).
        const libraryStage = (r as { libraryStage?: CommandResultOk['libraryStage'] }).libraryStage;
        const terrain = (r as { terrain?: CommandResultOk['terrain'] }).terrain;
        return { ok: true, revision: r.revision, change: r.change, ...(typeof createdId === 'string' ? { createdId } : {}), ...(libraryStage !== undefined ? { libraryStage } : {}), ...(r.folderImport !== undefined ? { folderImport: r.folderImport } : {}), ...(terrain !== undefined ? { terrain } : {}) };
      }
      if (r.code === 'revision_conflict') {
        const current = r.currentRevision ?? -1;
        const refused = op === 'undo' || op === 'redo' ? op : undefined;
        this.host.report({
          // A refused undo lost nothing: the project is as saved as before.
          save: refused !== undefined ? 'saved' : 'error',
          conflict: {
            currentRevision: current,
            expectedRevision,
            message:
              refused !== undefined
                ? `${refused} refused: the project changed (another tool's edit, revision ${current}) before this view showed it, and ${refused === 'undo' ? 'an undo' : 'a redo'} now would take back that change unseen; press it again to ${refused} the latest step`
                : `revision conflict — the scene changed since this edit began (the backend is now at revision ${current})`,
            ...(refused !== undefined ? { refused } : {}),
          },
        });
        return { ok: false, response: r };
      }
      // A refusal is an answer: nothing was lost and the project is as saved as before
      // (the error badge says why the edit was refused).
      this.host.report({ save: 'saved', error: { code: r.code, message: r.message ?? r.code } });
      return { ok: false, response: r };
    }
    const message = 'the command response was lost after the single retry';
    this.host.report({ save: 'error', error: { code: 'network', message } });
    return { ok: false, response: { ok: false, code: 'network', message } };
  }

  private async post(env: ReturnType<typeof makeEnvelope>): Promise<CommandOutcome> {
    try {
      const r = await this.host.post<MutationResponse>(env);
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
        return { status: 'response', response: refusalResponse(body.error, (err.body as { folderImport?: FolderImportView }).folderImport) };
      }
      // A network-level failure (no response) = a lost ack.
      return { status: 'lost' };
    }
  }
}
