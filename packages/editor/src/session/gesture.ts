/**
 * Gizmo transform gesture (sessions.md §9; packet 10).
 *
 * A gizmo drag PREVIEWs locally (no per-frame network traffic — the browser
 * updates its own display only) and COMMITs as exactly ONE undoable
 * `setTransform` command on release (sessions.md §9: "no per-frame traffic;
 * one commit command"). If the base revision is stale by release time (another
 * change advanced the revision mid-gesture), the command fails with
 * `revision_conflict`; the gesture then auto-rebases and retries AT MOST ONCE,
 * and if it still conflicts the conflict is surfaced (explained, never
 * silently lost — the edit is not discarded).
 *
 * Pure: no DOM, no I/O, no Node builtins. The transport (the client) is the
 * only thing that actually issues the command; this module decides WHAT to
 * commit and HOW to recover.
 */

/** A full transform (all three fields, canonical order). */
export interface Transform {
  position: number[];
  rotation: number[];
  scale: number[];
}

/** The single commit command a gesture produces. */
export interface CommitCommand {
  op: 'setTransform';
  entityId: string;
  expectedRevision: number;
  args: { entityId: string; transform: Transform };
}

export type GestureOutcome =
  | { kind: 'noop' } // the gesture ended where it began — no command
  | { kind: 'commit'; command: CommitCommand } // issue this command
  | { kind: 'conflict'; conflict: { currentRevision: number; expectedRevision: number } };

/** The transport's result for a committed command. */
export type CommitResult =
  | { ok: true }
  | { ok: false; code: 'revision_conflict'; currentRevision: number };

export function transformsEqual(a: Transform, b: Transform): boolean {
  return (
    a.position.length === b.position.length &&
    a.rotation.length === b.rotation.length &&
    a.scale.length === b.scale.length &&
    a.position.every((v, i) => v === b.position[i]) &&
    a.rotation.every((v, i) => v === b.rotation[i]) &&
    a.scale.every((v, i) => v === b.scale[i])
  );
}

/**
 * One active gizmo gesture. `baseTransform` is captured at drag start (from
 * the projection at `baseRevision`); `local` is the live preview (display
 * only). The commit decision is pure.
 */
export class Gesture {
  readonly entityId: string;
  private baseRevision: number;
  private baseTransform: Transform;
  private local: Transform;
  /** Set once the gesture has consumed its single auto-retry. */
  private retryUsed = false;

  constructor(entityId: string, baseRevision: number, baseTransform: Transform) {
    this.entityId = entityId;
    this.baseRevision = baseRevision;
    this.baseTransform = cloneTransform(baseTransform);
    this.local = cloneTransform(baseTransform);
  }

  /** Update the LOCAL preview (no traffic, no commit). Display only. */
  setLocal(t: Transform): void {
    this.local = cloneTransform(t);
  }

  get localPreview(): Transform {
    return this.local;
  }

  /** The revision the next commit will expect. */
  get expectedRevision(): number {
    return this.baseRevision;
  }

  /**
   * Decide the commit at drag end. No command is issued here — the transport
   * issues the returned command (or nothing for a noop).
   */
  decideCommit(): GestureOutcome {
    if (transformsEqual(this.local, this.baseTransform)) {
      return { kind: 'noop' };
    }
    return {
      kind: 'commit',
      command: {
        op: 'setTransform',
        entityId: this.entityId,
        expectedRevision: this.baseRevision,
        args: { entityId: this.entityId, transform: cloneTransform(this.local) },
      },
    };
  }

  /**
   * React to the transport's result for the committed command.
   *  - success ⇒ the gesture is done;
   *  - `revision_conflict` and we have NOT retried ⇒ auto-rebase to
   *    `currentRevision` (re-read the entity's current transform as the new
   *    base and re-apply the user's delta) and commit again;
   *  - `revision_conflict` and we HAVE retried ⇒ surface the conflict (the
   *    caller explains it in the UI; the edit is preserved, not lost).
   */
  handleResult(
    result: CommitResult,
    rebase: (expectedRevision: number) => Transform,
  ): GestureOutcome {
    if (result.ok) return { kind: 'noop' };
    if (!this.retryUsed) {
      this.retryUsed = true;
      // Auto-rebase ONCE: the new base is the entity's CURRENT transform at
      // the backend's current revision; we re-apply the user's full delta.
      this.baseRevision = result.currentRevision;
      this.baseTransform = cloneTransform(rebase(result.currentRevision));
      if (transformsEqual(this.local, this.baseTransform)) {
        // The user's target already equals the (changed) base — nothing left.
        return { kind: 'noop' };
      }
      return {
        kind: 'commit',
        command: {
          op: 'setTransform',
          entityId: this.entityId,
          expectedRevision: this.baseRevision,
          args: { entityId: this.entityId, transform: cloneTransform(this.local) },
        },
      };
    }
    return {
      kind: 'conflict',
      conflict: { currentRevision: result.currentRevision, expectedRevision: this.baseRevision },
    };
  }
}

function cloneTransform(t: Transform): Transform {
  return { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] };
}