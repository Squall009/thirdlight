/**
 * Zone gizmo gesture decisions (packet 56; authoring.md §A8 rows 6–10; the
 * packet-56 surface rule "local zone handles use zero commands during
 * gesture, one on release, none on cancel; one undo").
 *
 * The imperative overlay (viewport/zone-overlay.ts) converts pointer deltas
 * into WORLD-UNIT deltas and feeds them here; this module owns the local
 * preview and decides the single commit command (or nothing). Exactly the
 * sessions.md §9 shape the transform gesture uses (gesture.ts): `commandDecisions`
 * is 0 during the drag, 1 on a committing release, 0 on cancel; a bounded
 * `revision_conflict` rebase retries at most once.
 *
 * Three gesture kinds:
 *  - `move`   — drag a zone's body; commits one `setTransform`;
 *  - `resize` — drag a zone's size handle; commits one
 *               `setComponent(gameZone, { size })`;
 *  - `create` — drag a new zone's extent from the anchor; commits one
 *               `createEntity` with the `gameZone` (or `playerSpawn`)
 *               component. A negligible drag (a click) places the default
 *               size at the anchor.
 *
 * Pure: no DOM, no I/O, no Node builtins.
 */

import {
  DEFAULT_ZONE_SIZE,
  MIN_ZONE_SPAN_UI,
  MAX_ZONE_SPAN,
  planCreateZone,
  type ZoneCreateArgs,
  type ZoneRole,
} from './gameplay';

/** A world-space zone pose: center position + full extents. */
export interface ZonePose {
  position: [number, number, number];
  size: [number, number];
}

/** The single commit command a zone gesture produces. */
export type ZoneCommit =
  | { op: 'setTransform'; entityId: string; args: { entityId: string; transform: { position: number[]; rotation: number[]; scale: number[] } } }
  | { op: 'setComponent'; entityId: string; args: { entityId: string; component: 'gameZone'; value: { size: [number, number] } } }
  | { op: 'createEntity'; args: ZoneCreateArgs & { components: { gameZone: Record<string, unknown> } } };

export type ZoneGestureOutcome =
  | { kind: 'noop' }
  | { kind: 'commit'; command: ZoneCommit }
  | { kind: 'conflict'; conflict: { currentRevision: number; expectedRevision: number } };

export type ZoneCommitResult =
  | { ok: true }
  | { ok: false; code: 'revision_conflict'; currentRevision: number };

/** A world-axis translate delta for the local preview (units = meters). */
export interface ZoneDragDelta {
  dx: number;
  dy: number;
}

const clampSize = (v: number): number => {
  if (!Number.isFinite(v)) return MIN_ZONE_SPAN_UI;
  return Math.min(MAX_ZONE_SPAN, Math.max(MIN_ZONE_SPAN_UI, v));
};

const clampPosition = (v: number): number => (Number.isFinite(v) ? v : 0);

function clonePose(p: ZonePose): ZonePose {
  return { position: [p.position[0], p.position[1], p.position[2]], size: [p.size[0], p.size[1]] };
}

function posesEqual(a: ZonePose, b: ZonePose): boolean {
  return (
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2] &&
    a.size[0] === b.size[0] &&
    a.size[1] === b.size[1]
  );
}

export type ZoneGestureKind = 'move' | 'resize' | 'create';

export interface ZoneGestureOptions {
  /** The role the `create` gesture commits (required for `create`). */
  role?: ZoneRole;
  /** A checkpoint creation's safe-spawn reference (required for `create` checkpoints). */
  safeSpawnId?: string;
  /** The entity the `move`/`resize` gesture edits. */
  entityId?: string;
}

/**
 * One active zone gesture. `base` is captured at pointer-down (from the
 * projection at `baseRevision` for move/resize; the anchor for create);
 * `local` is the live preview (display only). The commit decision is pure and
 * single-valued: `decideCommit()` returns the one command (or `noop`), and
 * `handleResult()` may issue exactly one rebased retry on a revision
 * conflict — nothing else ever decides a command.
 */
export class ZoneGesture {
  readonly kind: ZoneGestureKind;
  private baseRevision: number;
  private base: ZonePose;
  private local: ZonePose;
  private readonly opts: ZoneGestureOptions;
  private retryUsed = false;
  private cancelled = false;
  private commandDecisionsCount = 0;

  constructor(kind: ZoneGestureKind, baseRevision: number, base: ZonePose, opts: ZoneGestureOptions = {}) {
    this.kind = kind;
    this.baseRevision = baseRevision;
    this.base = clonePose(base);
    this.local = clonePose(base);
    this.opts = opts;
  }

  /** How many commands this gesture has DECIDED (0 during the drag, 1 on a
   * committing release, 0 on cancel; a bounded rebase may add exactly one). */
  get commandDecisions(): number {
    return this.commandDecisionsCount;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** The live local preview (the overlay renders this). */
  get localPreview(): ZonePose {
    return clonePose(this.local);
  }

  /** The revision the next commit will expect. */
  get expectedRevision(): number {
    return this.baseRevision;
  }

  /**
   * Advance the LOCAL preview with one world-unit drag delta. Zero commands,
   * ever, from this method — the drag sends no traffic (sessions.md §9).
   */
  preview(delta: ZoneDragDelta): ZonePose {
    if (this.cancelled) return this.localPreview;
    if (this.kind === 'move') {
      this.local = {
        position: [
          clampPosition(this.base.position[0] + delta.dx),
          clampPosition(this.base.position[1] + delta.dy),
          this.base.position[2],
        ],
        size: [...this.base.size],
      };
    } else if (this.kind === 'resize') {
      this.local = {
        position: [...this.base.position],
        size: [clampSize(this.base.size[0] + delta.dx), clampSize(this.base.size[1] + delta.dy)],
      };
    } else {
      // create: the drag EXTENDS the zone from the anchor (the anchor is the
      // zone's corner at pointer-down; the preview centers on the extent).
      const w = clampSize(Math.abs(delta.dx));
      const h = clampSize(Math.abs(delta.dy));
      const x = clampPosition(this.base.position[0] + (delta.dx < 0 ? -w / 2 : w / 2));
      const y = clampPosition(this.base.position[1] + (delta.dy < 0 ? -h / 2 : h / 2));
      this.local = { position: [x, y, 0], size: [w, h] };
    }
    return this.localPreview;
  }

  /**
   * Cancel (Esc / cancel control): revert the preview and decide NO command —
   * no record, no revision, nothing observable to another client.
   */
  cancel(): void {
    this.cancelled = true;
    this.local = clonePose(this.base);
  }

  /**
   * Decide the commit at pointer-up. No command is issued here — the caller
   * issues the returned command (or nothing for a `noop`). A negligible
   * `create` drag (a plain click) commits the default size at the anchor.
   */
  decideCommit(): ZoneGestureOutcome {
    if (this.cancelled) return { kind: 'noop' };
    if (this.kind === 'move' || this.kind === 'resize') {
      if (posesEqual(this.local, this.base)) return { kind: 'noop' };
    }
    const command = this.buildCommand();
    if (command === null) return { kind: 'noop' };
    this.commandDecisionsCount += 1;
    return { kind: 'commit', command };
  }

  /**
   * React to the transport's result for the committed command:
   *  - success ⇒ done;
   *  - `revision_conflict` and the retry is unused ⇒ rebase to
   *    `currentRevision` (the `move` gesture re-reads the entity's current
   *    transform via `rebase` and re-applies the user's delta) and commit
   *    again — at most once;
   *  - otherwise ⇒ surface the conflict (explained in the UI; the edit is
   *    preserved, not lost).
   */
  handleResult(result: ZoneCommitResult, rebase: (expectedRevision: number) => ZonePose): ZoneGestureOutcome {
    if (result.ok) return { kind: 'noop' };
    if (this.retryUsed || this.cancelled) {
      return { kind: 'conflict', conflict: { currentRevision: result.currentRevision, expectedRevision: this.baseRevision } };
    }
    this.retryUsed = true;
    if (this.kind === 'move') {
      // The new base is the entity's CURRENT pose at the backend revision;
      // re-apply the user's full delta from it.
      const fresh = rebase(result.currentRevision);
      const delta = {
        dx: this.local.position[0] - this.base.position[0],
        dy: this.local.position[1] - this.base.position[1],
      };
      this.baseRevision = result.currentRevision;
      this.base = clonePose(fresh);
      this.local = {
        position: [
          clampPosition(fresh.position[0] + delta.dx),
          clampPosition(fresh.position[1] + delta.dy),
          fresh.position[2],
        ],
        size: [...fresh.size],
      };
      if (posesEqual(this.local, this.base)) return { kind: 'noop' };
      const command = this.buildCommand();
      if (command === null) return { kind: 'noop' };
      this.commandDecisionsCount += 1;
      return { kind: 'commit', command };
    }
    // resize/create rebase has no changed base (size/creation are not
    // position-relative) — surface the conflict; the user re-issues.
    return { kind: 'conflict', conflict: { currentRevision: result.currentRevision, expectedRevision: this.baseRevision } };
  }

  private buildCommand(): ZoneCommit | null {
    if (this.kind === 'move') {
      const id = this.opts.entityId ?? '';
      return {
        op: 'setTransform',
        entityId: id,
        args: {
          entityId: id,
          transform: {
            position: [...this.local.position],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      };
    }
    if (this.kind === 'resize') {
      const id = this.opts.entityId ?? '';
      return {
        op: 'setComponent',
        entityId: id,
        args: { entityId: id, component: 'gameZone', value: { size: [this.local.size[0], this.local.size[1]] } },
      };
    }
    // create: a negligible extent (a click) falls back to the role default
    // at the anchor. An unplannable value (the preflight validated before the
    // gesture began, so this is defensive) decides NO command.
    const negligible = this.local.size[0] <= MIN_ZONE_SPAN_UI + 1e-9 && this.local.size[1] <= MIN_ZONE_SPAN_UI + 1e-9;
    const size: [number, number] = negligible ? DEFAULT_ZONE_SIZE[this.opts.role ?? 'hazard'] : [this.local.size[0], this.local.size[1]];
    const position: [number, number, number] = negligible ? [...this.base.position] : [...this.local.position];
    const plan = planCreateZone({
      role: this.opts.role ?? 'hazard',
      size,
      position,
      ...(this.opts.role === 'checkpoint' && this.opts.safeSpawnId ? { safeSpawnId: this.opts.safeSpawnId } : {}),
    });
    if (!plan.ok) return null;
    return { op: 'createEntity', args: plan.args as ZoneCreateArgs & { components: { gameZone: Record<string, unknown> } } };
  }
}

/**
 * The pure, Node-testable zone-gesture driver: it owns one `ZoneGesture` and
 * issues the commands the gesture decides to an injected sink — the module
 * that makes "zero commands during the gesture, one on release, none on
 * cancel" an observable property (the Node tests use a counting sink; the
 * React app drives the gesture directly and issues the single command itself
 * — the Gate-G review §3.3 correction, mirrored).
 */
export interface ZoneCommandSink {
  issue(command: ZoneCommit): void;
}

export class ZoneGestureRunner {
  readonly gesture: ZoneGesture;
  private readonly sink: ZoneCommandSink;

  constructor(kind: ZoneGestureKind, baseRevision: number, base: ZonePose, sink: ZoneCommandSink, opts: ZoneGestureOptions = {}) {
    this.gesture = new ZoneGesture(kind, baseRevision, base, opts);
    this.sink = sink;
  }

  /** Per-drag local preview; never issues a command. */
  preview(delta: ZoneDragDelta): ZonePose {
    return this.gesture.preview(delta);
  }

  /** Release: decide (and issue) the single commit, or nothing for a noop. */
  release(): ZoneGestureOutcome {
    const outcome = this.gesture.decideCommit();
    if (outcome.kind === 'commit') this.sink.issue(outcome.command);
    return outcome;
  }

  /** Cancel: no command is issued and the preview reverts. */
  cancel(): void {
    this.gesture.cancel();
  }

  /** React to the transport result (bounded rebase, ≤ 1). */
  handleResult(result: ZoneCommitResult, rebase: (expectedRevision: number) => ZonePose): ZoneGestureOutcome {
    const outcome = this.gesture.handleResult(result, rebase);
    if (outcome.kind === 'commit') this.sink.issue(outcome.command);
    return outcome;
  }
}