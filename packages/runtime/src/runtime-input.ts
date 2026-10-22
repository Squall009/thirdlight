/**
 * The input a step samples: the input source's frame, with what the host
 * queued for the next sampled step riding on it (storage's answers, debug
 * commands, UI events, dialogue inputs, the answers to asset loads) — so a
 * recording keeps them and a replay or the worker applies them at the same
 * step — and the pointer state, the cursor a script asked for and the
 * host's binding and device status.
 */
import {
  InputFrameError,
  MAX_FRAME_COMMANDS,
  validateActionFrame,
  type ActionFrame,
  type ActionSource,
  type DebugCommandCall,
  type PointerSample,
} from './actions';
import { MAX_FRAME_ASSET_ANSWERS, validateAssetAnswers, type AssetHandleAnswer, type RuntimeAssetHandles } from './asset-handles';
import type { GameplayBlocks } from './blocks';
import { DebugCommands } from './debug-commands';
import { validateDialogueInput, type DialogueInputRecord, type DialogueRunner } from './dialogue';
import { clipMessage, type RuntimeError } from './errors';
import { rideOnFrame } from './frame-queues';
import { RuntimeInputStatus, type InputBindingRequest } from './input-status';
import type { ModeState } from './modes';
import { MAX_FRAME_SAVE_EVENTS, validateSaveEvents, type RuntimeSaves, type SaveEvent } from './project-saves';
import { fail } from './runtime-config';
import type { RuntimeFaults } from './runtime-faults';
import { messageOf, type RuntimeSim } from './runtime-sim';
import type { RuntimeScenes } from './runtime-scenes';
import { deprecatedEngineActionLine } from './scene-list';
import { MAX_FRAME_UI_EVENTS, type UiEventRecord, type UiState } from './ui';
import { queueUiEventChecked } from './ui-control';
import type { DebugCommandState } from './types';

/** The pointer state the runtime keeps — a pointer sample plus this step's enter/leave edges. */
export interface HeldPointer extends PointerSample {
  readonly entered?: boolean;
  readonly left?: boolean;
}

/** Dialogue inputs per input frame (DIALOGUE_LIMITS.frameInputs). */
const DIALOGUE_FRAME_INPUTS = 8;
/** Storage answers that may wait for the next step. */
const SAVE_QUEUE_MAX = 64;

/** An `ActionSource.sample()` throw (module_error, reason `input_source_threw`). */
export class InputSourceError extends Error {
  readonly reason = 'input_source_threw';
}

/** The parts a sampled frame's queued entries are delivered to. */
export interface InputHost {
  readonly saves: RuntimeSaves;
  readonly assetHandles: RuntimeAssetHandles;
  readonly ui: UiState;
  readonly dialogue: DialogueRunner;
  readonly modes: ModeState;
  readonly scenes: RuntimeScenes;
  readonly blocks: GameplayBlocks | null;
  /** A run restart at the next step boundary (a restart UI event). */
  requestRestart(): void;
}

type Result = { ok: true } | { ok: false; error: RuntimeError };

export class RuntimeInput {
  /** The last validated input frame (its frozen action values are reused when equal). */
  private lastFrame: ActionFrame | null = null;
  /** The pointer state after the last sampled step (null before the first pointer sample). */
  private heldPointer: HeldPointer | null = null;
  /** The cursor a script asked for (null: the active input map decides). */
  private cursorMode: 'free' | 'locked' | null = null;
  /** What the host last sent about bindings and devices, this step's rebind events, the scripts' requests. */
  readonly status = new RuntimeInputStatus();
  /** `ctx.input.setCursor` (the StepContext's cursor channel). */
  readonly cursorControl = Object.freeze({
    request: (mode: 'free' | 'locked' | 'auto'): void => {
      this.cursorMode = mode === 'auto' ? null : mode;
    },
  });
  /** Debug commands: declared ones, calls waiting for the next step, this step's calls. */
  readonly debugCommands: DebugCommands;
  /** Storage answers, UI events, dialogue inputs and asset answers queued by the host for the next sampled step. */
  private saveQueue: SaveEvent[] = [];
  private uiQueue: UiEventRecord[] = [];
  private dialogueQueue: DialogueInputRecord[] = [];
  private assetAnswerQueue: AssetHandleAnswer[] = [];
  /** Executed-step action samples. */
  samples = 0;

  constructor(
    private readonly sim: RuntimeSim,
    private readonly faults: RuntimeFaults,
    private readonly actions: ActionSource,
    private readonly host: InputHost,
  ) {
    this.debugCommands = new DebugCommands({
      emitSignal: (name) => this.host.blocks?.emit(name),
      dropped: (problem, stepIndex) => this.faults.record({ code: 'module_error', message: clipMessage(`debug command dropped: ${problem}`), stepIndex, reason: 'debug_command_invalid' }),
    });
  }

  /** Sample the step's frame; throws `InputSourceError` (the source threw) or `InputFrameError` (the frame is invalid). */
  sample(stepIndex: number): ActionFrame {
    let raw: unknown;
    try {
      raw = this.actions.sample(stepIndex);
    } catch (e) {
      throw new InputSourceError(messageOf(e));
    }
    const host = this.host;
    // What the host queued rides on this step's frame (so a recording keeps it): storage's answers,
    // debug commands, UI events, dialogue inputs and the answers to asset loads.
    raw = rideOnFrame(raw, 'saves', this.saveQueue.length, (n) => this.saveQueue.splice(0, n), MAX_FRAME_SAVE_EVENTS);
    raw = rideOnFrame(raw, 'commands', this.debugCommands.pending ? 1 : 0, (n) => this.debugCommands.take(n), MAX_FRAME_COMMANDS);
    raw = rideOnFrame(raw, 'ui', this.uiQueue.length, (n) => this.uiQueue.splice(0, n), MAX_FRAME_UI_EVENTS);
    raw = rideOnFrame(raw, 'dialogue', this.dialogueQueue.length, (n) => this.dialogueQueue.splice(0, n), DIALOGUE_FRAME_INPUTS);
    raw = rideOnFrame(raw, 'assets', this.assetAnswerQueue.length, (n) => this.assetAnswerQueue.splice(0, n), MAX_FRAME_ASSET_ANSWERS);
    // Equal action values of the last frame are shared (immutable).
    const check = validateActionFrame(raw, stepIndex, this.lastFrame ?? undefined);
    if (!check.ok) throw new InputFrameError(check.field, check.message);
    this.lastFrame = check.frame;
    this.samples += 1;
    this.debugCommands.deliver(check.frame);
    // storage's answers (the slot list, outcomes, a loaded document).
    if (check.frame.saves !== undefined) host.saves.deliver(check.frame.saves);
    // The answers to asset loads (a script sees ready in this step).
    host.assetHandles.deliver(check.frame.assets);
    // The host's input status (device, bindings, rebind events).
    this.status.apply(check.frame.input);
    this.deliverUiEvents(check.frame.ui, stepIndex);
    // The frame's dialogue inputs (applied at the end of the step).
    host.dialogue.deliver(check.frame.dialogue);
    return this.withHeldPointer(check.frame);
  }

  /** A step that runs on a given frame (the settle pre-roll) delivers nothing queued. */
  skipDelivery(): void {
    this.debugCommands.clearStep();
    this.host.ui.deliver(undefined);
    this.host.dialogue.deliver(undefined);
  }

  /**
   * A step's UI events: show/hide entries apply before any script runs, a mode action switches now
   * (before the scripts), a restart and a move along the shell's scene list apply at the next boundary.
   */
  private deliverUiEvents(events: readonly UiEventRecord[] | undefined, stepIndex: number): void {
    const host = this.host;
    host.ui.deliver(events);
    if (events === undefined) return;
    host.modes.deliver(events, stepIndex + 1);
    for (const e of events) {
      if (e.kind === 'restart') {
        host.requestRestart();
        // The run restart is a deprecated way to restart a level or start a new game: said once per Play.
        const line = deprecatedEngineActionLine(e.name);
        if (line !== null) this.faults.problem(line.code, line.message);
      } else if (e.kind === 'reload' || e.kind === 'load' || e.kind === 'unload') host.scenes.opFromUi(e.kind, e.value);
      else if (e.kind === 'hold') host.modes.setScreenHold(e.value === true);
    }
    // The scene list move comes after a restart of the same frame; the nextScene action's says it is deprecated (a new game's has its restart's line).
    for (const e of events) {
      if (e.kind !== 'scene' || typeof e.value !== 'number') continue;
      host.scenes.requestListed(e.value);
      const line = deprecatedEngineActionLine(e.name);
      if (line !== null) this.faults.problem(line.code, line.message);
    }
  }

  /**
   * The frame modules see carries the complete pointer state —
   * the sample's own values, or (a frame without a sample) the last
   * position, buttons and over/locked state with no movement — and its edges:
   * a button pressed/released when the held mask changed (or the sample says
   * so: a click between two samples), `entered`/`left` when `over` changed.
   * Before the first sample there is no pointer (the frame is unchanged, so
   * every recorded replay without pointer samples plays exactly as before).
   */
  private withHeldPointer(frame: ActionFrame): ActionFrame {
    const sample = frame.pointer;
    const prev = this.heldPointer;
    if (sample === undefined && prev === null) return frame;
    const prevButtons = prev?.buttons ?? 0;
    const prevOver = prev === null ? false : prev.over !== false;
    let next: HeldPointer;
    if (sample === undefined) {
      const p = prev!;
      // No new sample: the same state without this step's movement and edges (reused when it had none).
      if (p.dx === undefined && p.dy === undefined && p.wheel === undefined && p.pressed === undefined && p.released === undefined && p.entered === undefined && p.left === undefined) return { ...frame, pointer: p };
      next = { x: p.x, y: p.y, buttons: prevButtons, over: prevOver, locked: p.locked === true, ...(p.overUi === true ? { overUi: true } : {}) };
    } else {
      const buttons = sample.buttons ?? 0;
      const over = sample.over !== false;
      const pressed = (sample.pressed ?? 0) | (buttons & ~prevButtons);
      const released = (sample.released ?? 0) | (prevButtons & ~buttons);
      next = {
        x: sample.x,
        y: sample.y,
        buttons,
        over,
        locked: sample.locked === true,
        // Over a UI element (absent false, so every recording without it is unchanged).
        ...(sample.overUi === true ? { overUi: true } : {}),
        ...(sample.dx !== undefined && sample.dx !== 0 ? { dx: sample.dx } : {}),
        ...(sample.dy !== undefined && sample.dy !== 0 ? { dy: sample.dy } : {}),
        ...(sample.wheel !== undefined && sample.wheel !== 0 ? { wheel: sample.wheel } : {}),
        ...(pressed !== 0 ? { pressed } : {}),
        ...(released !== 0 ? { released } : {}),
        ...(over && !prevOver ? { entered: true } : {}),
        ...(!over && prevOver ? { left: true } : {}),
      };
    }
    this.heldPointer = Object.freeze(next);
    return { ...frame, pointer: this.heldPointer };
  }

  /** The pointer state as of the last step (null before the first sample; observers, the host). */
  pointer(): Readonly<HeldPointer> | null {
    return this.heldPointer;
  }

  /** The cursor a script asked for (null: the active input map decides). */
  cursor(): 'free' | 'locked' | null {
    return this.cursorMode;
  }

  /** A new run starts with no cursor request. */
  newRun(): void {
    this.cursorMode = null;
  }

  takeBindingRequests(): { readonly requests: readonly InputBindingRequest[]; readonly dropped: number } {
    return this.status.take();
  }

  debugCommandState(): DebugCommandState {
    return this.debugCommands.state();
  }

  // ---- What the host queues for the next sampled step ------------------------

  queueDebugCommand(call: DebugCommandCall): Result {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    const r = this.debugCommands.enqueue(call);
    return r.ok ? r : { ok: false, error: fail('game_command_invalid', r.message, { reason: r.reason, ...(r.path !== undefined ? { path: r.path } : {}) }) };
  }

  queueUiEvent(event: UiEventRecord): Result {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    const queued = queueUiEventChecked(this.host.ui, this.uiQueue, event);
    return queued.ok ? queued : { ok: false, error: fail('game_command_invalid', queued.message, { reason: queued.reason, ...(queued.path !== undefined ? { path: queued.path } : {}) }) };
  }

  queueDialogueInput(input: DialogueInputRecord): Result {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    if (!this.host.dialogue.enabled) return { ok: false, error: fail('game_command_invalid', 'this game has no conversations', { reason: 'dialogue' }) };
    const checked = validateDialogueInput(input);
    if (!checked.ok) return { ok: false, error: fail('game_command_invalid', `dialogue input: ${checked.message}`, { reason: 'dialogue', path: `/${checked.field}` }) };
    if (this.dialogueQueue.length >= DIALOGUE_FRAME_INPUTS * 4) return { ok: false, error: fail('game_command_invalid', `at most ${DIALOGUE_FRAME_INPUTS * 4} dialogue inputs may wait for the next step`, { reason: 'pending' }) };
    this.dialogueQueue.push(checked.input);
    return { ok: true };
  }

  queueSaveEvent(event: SaveEvent): Result {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    if (this.host.saves.schema === null) return { ok: false, error: fail('game_command_invalid', 'this game has no project save schema', { reason: 'saves' }) };
    const checked = validateSaveEvents([event]);
    if (!checked.ok) return { ok: false, error: fail('game_command_invalid', `save entry: ${checked.message}`, { reason: 'saves' }) };
    if (this.saveQueue.length >= SAVE_QUEUE_MAX) return { ok: false, error: fail('game_command_invalid', `at most ${SAVE_QUEUE_MAX} storage answers may wait for the next step`, { reason: 'pending' }) };
    this.saveQueue.push(checked.events[0]!);
    return { ok: true };
  }

  queueAssetAnswer(answer: AssetHandleAnswer): Result {
    if (this.sim.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    const checked = validateAssetAnswers([answer]);
    if (!checked.ok) return { ok: false, error: fail('game_command_invalid', `assets answer: ${checked.message}`, { reason: 'assets' }) };
    // A recorded input replays the answers at the steps they arrived when it was recorded; a live one is not added.
    if (this.actions.recorded !== true) this.assetAnswerQueue.push(checked.answers[0]!);
    return { ok: true };
  }
}
