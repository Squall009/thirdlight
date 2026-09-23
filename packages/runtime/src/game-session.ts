/**
 * The M3 run state machine and committed game view — `gameplay.md` §2 (states,
 * transitions T1–T8, the bounded respawn delay, the boundary queues), §6 (the
 * committed read-only `GameView`, the ≤ 32 event ring) and runtime.md §15.
 *
 * Ownership: this is the *runtime-side* run data (gameplay.md §1 ownership
 * table: the runtime owns the run state, the event log and the `GameView`
 * publication). The zone *decisions* that drive the transitions are made by
 * the `gameplay`-phase module through the validated port calls
 * (`beginRespawn`/`activateCheckpoint`/`reachGoal`); this class owns the
 * transition effects, the counters, the bounded event ring and the view
 * construction. It holds no world, no port, no DOM and no timers — the
 * respawn delay is measured in executed fixed steps only (gameplay.md §2.4:
 * no wall clock, no `setTimeout` anywhere in a step).
 *
 * The reset transaction (R1–R7: destination resolution/verification,
 * clearance probe, physics reset, module reset hooks, rebase) is the
 * packet-50 consumer; this class owns the R8 bookkeeping (the T1/T5/T6
 * run-state and counter updates and the boundary event) and the `activeSpawnId`
 * derivation, which are pure run data.
 */
import { deepFreeze } from './snapshot';
import type { ErrorCode } from './errors';
import {
  type GameEvent,
  type GameEventKind,
  type GameView,
  type PlayerMotion,
  type RunSnapshot,
  type RunState,
} from './types';

/** gameplay.md §2.4: the bounded respawn delay in executed fixed steps. */
export const RESPAWN_DELAY_STEPS = 30;
/** gameplay.md §6: the retained `GameView` event bound (front evictions). */
export const MAX_GAME_EVENTS = 32;
/** gameplay.md §7.1: the default aspect until the first accepted `setViewport`. */
export const DEFAULT_ASPECT = 16 / 9;
/** gameplay.md §7.1: the fixed view depth (m) — the camera module's constant (packet 51). */
export const CAMERA_Z = 12;
/** gameplay.md §7.1: the per-axis per-step camera displacement cap (m) (packet 51). */
export const CAMERA_MAX_STEP = 4;

/** The one pending run command per kind (gameplay.md §2.3). */
export type RunCommand = 'start' | 'replay';

/**
 * One rejected run command (gameplay.md §8.1 `game_command_invalid`):
 * `reason: 'state'` (invalid for the current run state) or `reason: 'pending'`
 * (a conflicting submission while another command is pending).
 */
export type GameCommandRejection = {
  readonly ok: false;
  readonly error: {
    readonly code: 'game_command_invalid';
    readonly reason: 'state' | 'pending';
    readonly command: RunCommand;
    readonly state?: RunState;
    readonly message: string;
  };
};

export interface GameCommandAccepted {
  readonly ok: true;
  /** A second identical submission (idempotent coalesce, gameplay.md §2.3). */
  readonly coalesced?: true;
}

/** The boundary outcome (gameplay.md §3.2 item 0). */
export interface BoundaryOutcome {
  /** The boundary events published at this boundary, in consumption order. */
  readonly events: GameEvent[];
  /**
   * The reset the boundary made due (R8's transaction), or `null`:
   * a consumed `replay` supersedes a due scheduled reset; a consumed `start`
   * starts a life at the start spawn; a due scheduled reset respawns at the
   * active (checkpoint) spawn. Consumption order is replay → reset → start
   * (gameplay.md §2.3); at most one reset can be due (a `start` requires
   * `awaitingStart`, a scheduled reset requires `respawning`).
   */
  readonly reset: 'spawn' | 'replay' | 'start' | null;
}

/** The inputs the committed view needs at publication (gameplay.md §6). */
export interface ViewInputs {
  readonly snapshotId: string;
  readonly stepIndex: number;
  readonly simTime: number;
  readonly playerId: string;
  readonly cameraId: string;
  /** `content.game.spawnId` (the view's fallback active spawn). */
  readonly spawnId: string;
  /** The activated checkpoint's `safeSpawnId` (`content.game.zones`), or `null`. */
  readonly checkpointSafeSpawnId: string | null;
  readonly playerMotion: PlayerMotion;
}

/**
 * The runtime-owned M3 run state (gameplay.md §2). One instance per
 * M3-enabled runtime; absent for M1/M2 sets.
 */
export class GameSession {
  private readonly snapshotId: string;
  private state: RunState = 'awaitingStart';
  private epoch = 0;
  private checkpointId: string | null = null;
  private goalReached = false;
  private deathCount = 0;
  private respawnAtStep: number | null = null;
  /**
   * The first `playing` step after the most recent run-start/respawn/replay
   * boundary (gameplay.md §2.5 item 2: the jump gate). `null` before the
   * first such boundary.
   */
  private firstLive: number | null = null;
  /** The pending run command queue (≤ 1 entry; gameplay.md §2.3). */
  private readonly pending: RunCommand[] = [];
  private events: GameEvent[] = [];
  private eventCount = 0;
  private eventDropped = 0;
  private failed = false;
  private failure: { code: string; reason?: string; stepIndex: number; phase?: string } | null = null;

  constructor(snapshotId: string) {
    this.snapshotId = snapshotId;
  }

  get runId(): string {
    return `${this.snapshotId}#${this.epoch}`;
  }

  get runState(): RunState {
    return this.state;
  }

  get replayEpoch(): number {
    return this.epoch;
  }

  get deathCountTotal(): number {
    return this.deathCount;
  }

  get checkpointTotal(): string | null {
    return this.checkpointId;
  }

  get eventCountTotal(): number {
    return this.eventCount;
  }

  get respawnAtStepTotal(): number | null {
    return this.respawnAtStep;
  }

  get failedTotal(): boolean {
    return this.failed;
  }

  get failureTotal(): { code: string; reason?: string; stepIndex: number; phase?: string } | null {
    return this.failure;
  }

  get eventsTotal(): readonly GameEvent[] {
    return this.events;
  }

  get eventDroppedTotal(): number {
    return this.eventDropped;
  }

  get pendingCommandsTotal(): readonly RunCommand[] {
    return this.pending;
  }

  /**
   * Queue one run command (gameplay.md §2.3/§6.1). The checker's submitted
   * semantics, exactly:
   * 1. a second identical submission coalesces (idempotent `ok`);
   * 2. a conflicting submission with a pending command is rejected
   *    (`game_command_invalid`, `reason: 'pending'`);
   * 3. a command invalid for the current run state is rejected immediately
   *    (`reason: 'state'`): `start` only in `awaitingStart`, `replay` only in
   *    `playing`/`respawning`/`won`.
   */
  submit(command: RunCommand): GameCommandAccepted | GameCommandRejection {
    if (this.pending.includes(command)) return { ok: true, coalesced: true };
    if (this.pending.length > 0) {
      return {
        ok: false,
        error: {
          code: 'game_command_invalid',
          reason: 'pending',
          command,
          message: `a run command is already pending (one pending command per kind; a conflicting submission within the same boundary is rejected)`,
        },
      };
    }
    if (command === 'start' && this.state !== 'awaitingStart') {
      return {
        ok: false,
        error: {
          code: 'game_command_invalid',
          reason: 'state',
          command,
          state: this.state,
          message: `"start" is valid only in "awaitingStart" (current run state: "${this.state}")`,
        },
      };
    }
    if (command === 'replay' && this.state !== 'playing' && this.state !== 'respawning' && this.state !== 'won') {
      return {
        ok: false,
        error: {
          code: 'game_command_invalid',
          reason: 'state',
          command,
          state: this.state,
          message: `"replay" is valid only in "playing"/"respawning"/"won" (current run state: "${this.state}")`,
        },
      };
    }
    this.pending.push(command);
    return { ok: true };
  }

  /**
   * The step boundary (gameplay.md §3.2 item 0): consumes the queued run
   * commands in the order replay → scheduled reset → start, applying the T1/T5/
   * T6 bookkeeping and publishing the boundary events. The caller runs the
   * reset transaction the outcome makes due (R1–R7; a reset-phase failure
   * fail-stops with no rollback, gameplay.md §5.4) and then publishes the view
   * (R8). The boundary event is published here, at the boundary (gameplay.md
   * §3.2 item 0: the boundary event is published at the boundary and visible
   * to every phase of the step that follows it) — the `check-fixtures.mjs`
   * reference replay publishes it the same way.
   */
  boundary(stepIndex: number): BoundaryOutcome {
    const events: GameEvent[] = [];
    let reset: BoundaryOutcome['reset'] = null;
    // 1. The `replay` command (T6): supersedes a due scheduled reset.
    const replayIdx = this.pending.indexOf('replay');
    if (replayIdx !== -1) {
      this.pending.splice(replayIdx, 1);
      this.epoch += 1;
      this.checkpointId = null;
      this.deathCount = 0;
      this.goalReached = false;
      this.respawnAtStep = null;
      this.state = 'playing';
      this.firstLive = stepIndex;
      events.push(this.emit('replayed', stepIndex, true));
      reset = 'replay';
    }
    // 2. The scheduled reset (T5): due exactly at the boundary before
    //    step `respawnAtStep` (= death step + 1 + RESPAWN_DELAY_STEPS).
    if (this.respawnAtStep !== null && this.respawnAtStep === stepIndex) {
      this.respawnAtStep = null;
      this.state = 'playing';
      this.firstLive = stepIndex;
      events.push(this.emit('respawned', stepIndex, true));
      reset = 'spawn';
    }
    // 3. The `start` command (T1): a fresh run at the start spawn.
    const startIdx = this.pending.indexOf('start');
    if (startIdx !== -1) {
      this.pending.splice(startIdx, 1);
      this.state = 'playing';
      this.firstLive = stepIndex;
      events.push(this.emit('runStarted', stepIndex, true));
      reset = 'start';
    }
    return { events, reset };
  }

  /**
   * T2 (gameplay.md §2.2): a death decided in the gameplay phase of executed
   * step `stepIndex`. `deathCount += 1`; `respawnAtStep = stepIndex + 1 +
   * RESPAWN_DELAY_STEPS` (the 30 executed delay steps, no wall clock); the
   * `died` event carries `stepIndex` and is NOT a boundary event.
   */
  beginRespawn(stepIndex: number, cause: 'hazard' | 'fall', zoneId?: string): void {
    this.deathCount += 1;
    this.respawnAtStep = stepIndex + 1 + RESPAWN_DELAY_STEPS;
    this.state = 'respawning';
    this.emit('died', stepIndex, false, { ...(zoneId !== undefined ? { zoneId } : {}), cause });
  }

  /** T3: activate the single checkpoint zone (`checkpointId` latch, §4.5). */
  activateCheckpoint(stepIndex: number, zoneId: string): void {
    this.checkpointId = zoneId;
    this.emit('checkpointActivated', stepIndex, false, { zoneId });
  }

  /** Phase 12 (c): the checkpoint's scene was unloaded — respawns go to the start spawn again. */
  clearCheckpoint(): void {
    this.checkpointId = null;
  }

  /** T4: the goal wins once and freezes all evaluation. */
  reachGoal(stepIndex: number, zoneId: string): void {
    this.goalReached = true;
    this.state = 'won';
    this.emit('goalReached', stepIndex, false, { zoneId });
  }

  /**
   * T7 (gameplay.md §2.2): a runtime fail-stop freezes the run at its last
   * committed value — no run event is emitted and the failure is not a death.
   * `phase` (CC-49-1) is the failure phase label the promoted fixture pins.
   */
  markFailure(code: string, reason: string | undefined, stepIndex: number, phase?: string): void {
    this.failed = true;
    this.failure = {
      code,
      ...(reason !== undefined ? { reason } : {}),
      stepIndex,
      ...(phase !== undefined ? { phase } : {}),
    };
  }

  /** The first `playing` step after the latest boundary (the §2.5 jump gate). */
  isFirstLiveStep(stepIndex: number): boolean {
    return this.state === 'playing' && this.firstLive === stepIndex;
  }

  /** The committed run data the `gameplay` phase reads (gameplay.md §3.3). */
  runSnapshot(stepIndex: number): RunSnapshot {
    return Object.freeze({
      state: this.state,
      stepIndex,
      checkpointId: this.checkpointId,
      goalReached: this.goalReached,
      deathCount: this.deathCount,
      replayEpoch: this.epoch,
      respawnAtStep: this.respawnAtStep,
      runId: this.runId,
    });
  }

  /**
   * Append one event to the bounded ring (gameplay.md §6): `eventCount` is
   * cumulative and unbounded; the ring retains ≤ `MAX_GAME_EVENTS`, evicting
   * from the front and counting `eventDropped`.
   */
  private emit(
    kind: GameEventKind,
    stepIndex: number,
    boundary: boolean,
    extra?: { zoneId?: string; cause?: 'hazard' | 'fall' },
  ): GameEvent {
    this.eventCount += 1;
    const event: GameEvent = Object.freeze({
      id: `${this.runId}/${kind}/${stepIndex}`,
      kind,
      stepIndex,
      boundary,
      ...(extra?.zoneId !== undefined ? { zoneId: extra.zoneId } : {}),
      ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
      deathCount: this.deathCount,
    });
    this.events.push(event);
    if (this.events.length > MAX_GAME_EVENTS) {
      this.events.shift();
      this.eventDropped += 1;
    }
    return event;
  }

  /**
   * Build one committed `GameView` (gameplay.md §6). Called at the phase-8
   * commit, at every reset boundary (R8), at instantiate and after a
   * fail-stop (T7: the last committed view retained with `failed: true` and
   * the `failure` record; no further event is appended).
   */
  buildView(inputs: ViewInputs): GameView {
    const view: GameView = {
      viewVersion: 1,
      runId: this.runId,
      snapshotId: inputs.snapshotId,
      replayEpoch: this.epoch,
      state: this.state,
      stepIndex: inputs.stepIndex,
      simTime: inputs.simTime,
      playerId: inputs.playerId,
      cameraId: inputs.cameraId,
      activeSpawnId: this.checkpointId === null ? inputs.spawnId : (inputs.checkpointSafeSpawnId ?? inputs.spawnId),
      checkpointId: this.checkpointId,
      checkpointActive: this.checkpointId !== null,
      playerMotion: inputs.playerMotion,
      goalReached: this.goalReached,
      deathCount: this.deathCount,
      respawnAtStep: this.respawnAtStep,
      events: [...this.events],
      eventCount: this.eventCount,
      eventDropped: this.eventDropped,
      failed: this.failed,
      ...(this.failure !== null ? { failure: { ...this.failure } } : {}),
    };
    return deepFreeze(view);
  }
}

/** The error code a rejected run command carries (gameplay.md §8.1). */
export const GAME_COMMAND_INVALID_CODE: ErrorCode = 'game_command_invalid';