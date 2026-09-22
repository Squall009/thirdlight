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
 * Packet 27 adds the M2 **local snapping option** (sessions.md §9) and an
 * explicit cancellation path:
 *
 *  - `preview(raw, shiftKey)` applies the contract's snapping increments to the
 *    local preview only (no message, no command);
 *  - `cancel()` reverts the preview and decides **no** command — the backend
 *    never learns the gesture happened;
 *  - the command count of a gesture is exactly 0 during the drag, 1 on release
 *    and 0 on cancel (`commandDecisions`), because only `decideCommit()` /
 *    `handleResult()` can decide a command.
 *
 * Pure: no DOM, no I/O, no Node builtins. The transport (the client) is the
 * only thing that actually issues the command; this module decides WHAT to
 * commit and HOW to recover.
 */

import {
  snapActive,
  snapScaleFromBase,
  snapRotationAngle,
  snapTranslateDelta,
  type RawGesture,
} from './snapping';

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
  /** Whether the local snapping option is enabled for this gesture. */
  private snapping: boolean;
  /** Set by `cancel()`; a cancelled gesture can never decide a command. */
  private cancelled = false;
  /**
   * How many commands this gesture DECIDED (0 during the drag, 1 on release,
   * 0 on cancel; a bounded conflict rebase may add exactly one more). The
   * transport issues exactly these — the decision layer never sends anything
   * by itself.
   */
  private commandDecisionsCount = 0;

  constructor(entityId: string, baseRevision: number, baseTransform: Transform, options: { snapping?: boolean } = {}) {
    this.entityId = entityId;
    this.baseRevision = baseRevision;
    this.baseTransform = cloneTransform(baseTransform);
    this.local = cloneTransform(baseTransform);
    this.snapping = options.snapping === true;
  }

  /** Toggle the LOCAL snapping option (never persisted, sessions.md §9). */
  setSnapping(enabled: boolean): void {
    this.snapping = enabled;
  }

  get snappingEnabled(): boolean {
    return this.snapping;
  }

  /** How many commit commands this gesture has decided so far. */
  get commandDecisions(): number {
    return this.commandDecisionsCount;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Update the LOCAL preview (no traffic, no commit). Display only. */
  setLocal(t: Transform): void {
    this.local = cloneTransform(t);
  }

  /**
   * Advance the local preview from a RAW (unsnapped) gesture delta. Snapping is
   * applied to the preview only — this method decides no command, ever, so a
   * drag sends zero commands (sessions.md §9). `shiftKey` disables snapping for
   * this gesture only.
   */
  preview(raw: RawGesture, shiftKey = false): Transform {
    if (this.cancelled) return this.local;
    const active = snapActive(this.snapping, shiftKey);
    this.local = applyRawGesture(this.baseTransform, raw, active);
    return this.local;
  }

  /**
   * Cancel the gesture (Esc / cancel control): revert the preview and decide no
   * command — no record, no revision, nothing observable to other clients
   * (sessions.md §9).
   */
  cancel(): void {
    this.cancelled = true;
    this.local = cloneTransform(this.baseTransform);
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
    if (this.cancelled || transformsEqual(this.local, this.baseTransform)) {
      return { kind: 'noop' };
    }
    this.commandDecisionsCount += 1;
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
    if (!this.retryUsed && !this.cancelled) {
      this.retryUsed = true;
      // Auto-rebase ONCE: the new base is the entity's CURRENT transform at
      // the backend's current revision; we re-apply the user's full delta.
      this.baseRevision = result.currentRevision;
      this.baseTransform = cloneTransform(rebase(result.currentRevision));
      if (transformsEqual(this.local, this.baseTransform)) {
        // The user's target already equals the (changed) base — nothing left.
        return { kind: 'noop' };
      }
      this.commandDecisionsCount += 1;
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

/**
 * Apply a RAW gesture delta to a base transform, in the contract's coordinate
 * spaces: world-axis translate deltas, an axis-angle rotation about the gizmo
 * axis, and the entity's uniform scale (sessions.md §9). When `snap` is true
 * the contract's increments/rounding/clamps are applied; when false the raw
 * value is used (Shift disables snapping for that gesture). Pure, so the whole
 * local-preview path is Node-testable without three.js.
 */
export function applyRawGesture(base: Transform, raw: RawGesture, snap: boolean): Transform {
  switch (raw.kind) {
    case 'translate': {
      const delta = snap ? snapTranslateDelta(raw.delta) : raw.delta;
      return {
        position: [
          (base.position[0] ?? 0) + (delta[0] ?? 0),
          (base.position[1] ?? 0) + (delta[1] ?? 0),
          (base.position[2] ?? 0) + (delta[2] ?? 0),
        ],
        rotation: [...base.rotation],
        scale: [...base.scale],
      };
    }
    case 'rotate': {
      const angleRad = snap ? snapRotationAngle(raw.angleRad, raw.axis).angleRad : raw.angleRad;
      const delta = axisAngleQuaternion(raw.axis, angleRad);
      return {
        position: [...base.position],
        rotation: multiplyQuaternion(delta, base.rotation),
        scale: [...base.scale],
      };
    }
    case 'scale': {
      if (snap) {
        return { position: [...base.position], rotation: [...base.rotation], scale: snapScaleFromBase(base.scale, raw.factor) };
      }
      const factor = Number.isFinite(raw.factor) ? raw.factor : 1;
      return {
        position: [...base.position],
        rotation: [...base.rotation],
        scale: base.scale.map((b) => (Number.isFinite(b) ? b : 1) * factor),
      };
    }
  }
}

/** `a * b` for `[x, y, z, w]` quaternions (delta applied on top of the base). */
function multiplyQuaternion(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  const [ax = 0, ay = 0, az = 0, aw = 1] = a;
  const [bx = 0, by = 0, bz = 0, bw = 1] = b;
  const q: [number, number, number, number] = [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
  const norm = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
}

/**
 * Rebuild a unit quaternion from an axis-angle pair (project-model §12.2: the
 * quaternion is re-normalized). The angle passed here is already the final,
 * possibly snapped, accumulated gesture angle.
 */
function axisAngleQuaternion(
  axis: readonly number[],
  angleRad: number,
): [number, number, number, number] {
  const [ax = 0, ay = 1, az = 0] = axis;
  const length = Math.hypot(ax, ay, az) || 1;
  const half = (Number.isFinite(angleRad) ? angleRad : 0) / 2;
  const s = Math.sin(half);
  const w = Math.cos(half);
  const q: [number, number, number, number] = [(ax / length) * s, (ay / length) * s, (az / length) * s, w];
  const norm = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm];
}

/**
 * A pure, Node-testable gesture driver: it owns one `Gesture` and issues the
 * commands that gesture decides to an injected sink. This is the module that
 * makes "zero commands during the drag, exactly one on release, none on cancel"
 * an observable property of the authoring logic (the Node tests use a counting
 * sink; the React app drives `Gesture` directly in `onGestureEnd` and issues
 * the single command itself — see the Gate G review §3.3 correction).
 */
export interface GestureCommandSink {
  issue(command: CommitCommand): void;
}

export class GestureRunner {
  readonly gesture: Gesture;
  private readonly sink: GestureCommandSink;

  constructor(
    entityId: string,
    baseRevision: number,
    baseTransform: Transform,
    sink: GestureCommandSink,
    options: { snapping?: boolean } = {},
  ) {
    this.gesture = new Gesture(entityId, baseRevision, baseTransform, options);
    this.sink = sink;
  }

  /** Per-frame local preview; never issues a command. */
  preview(raw: RawGesture, shiftKey = false): Transform {
    return this.gesture.preview(raw, shiftKey);
  }

  /** Release: decide (and issue) the single commit, or nothing for a no-op. */
  release(): GestureOutcome {
    const outcome = this.gesture.decideCommit();
    if (outcome.kind === 'commit') this.sink.issue(outcome.command);
    return outcome;
  }

  /** Cancel: no command is issued and the preview reverts. */
  cancel(): void {
    this.gesture.cancel();
  }

  /** React to the transport result (bounded auto-rebase, ≤ 1). */
  handleResult(result: CommitResult, rebase: (expectedRevision: number) => Transform): GestureOutcome {
    const outcome = this.gesture.handleResult(result, rebase);
    if (outcome.kind === 'commit') this.sink.issue(outcome.command);
    return outcome;
  }
}

function cloneTransform(t: Transform): Transform {
  return { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] };
}