/**
 * What goes wrong in a run and how it is reported: the bounded error ring of
 * the diagnostics, the behavior log entries the runtime records, the
 * author's Problems lines (one per kind and Play), and the fail-stop — the
 * failure every refusal of the phase contract ends in, named by its code,
 * reason, module, phase and step.
 *
 * The runtime's parts report through this one object; the fail-stop's state
 * change (the driver cancelled, the failed state) is the runtime's own, run
 * through `halt`.
 */
import { BehaviorHostError, BehaviorHostIntentLimit, compiledFramesOf, graphNodeIdOf, type BehaviorDebugView, type BehaviorPropertyView, type CompiledFrame } from './behavior';
import { ErrorRing } from './error-ring';
import { clipMessage, errorEntryOf, scriptStopReport, ScriptErrorLines, type ErrorCode } from './errors';
import { InputFrameError, type ActionSource } from './actions';
import { DuplicateMoveError, PhaseViolationError } from './guard';
import { BehaviorIntentError, type BehaviorLogLevel } from './intents';
import { PhysicsPortFailure } from './player-controllers';
import { actionDiagnostics, behaviorLogTotals, physicsDiagnostics } from './diagnostics-reads';
import { messageOf, type ModuleEntry, type RuntimeSim } from './runtime-sim';
import type { DiagnosticErrorEntry, RuntimeDiagnostics, ScriptStop, SimulationPhase } from './types';

export class RuntimeFaults {
  private readonly ring = new ErrorRing();
  private count = 0;
  /** The visual-script node of the error being fail-stopped (consumed by `failStop`). */
  private failNodeId: string | undefined = undefined;
  /** The failing error's compiled script frames (consumed by the fail-stop entry). */
  private failFrames: CompiledFrame[] = [];
  private failedModuleId?: string;
  private failedPhase?: SimulationPhase;
  private failedStepIndex?: number;
  /** Problems for the author (one Problems line per kind and Play; the host drains them). */
  private problems: { code: string; message: string }[] = [];
  private readonly problemCodes = new Set<string>();
  /** The script errors put in Problems this run. */
  readonly scriptErrorLines = new ScriptErrorLines();
  /** Last observed behavior log totals (retained after disposal). */
  private logTotals = { logCount: 0, logDropped: 0 };

  constructor(
    private readonly sim: RuntimeSim,
    private readonly halt: () => void,
  ) {}

  record(entry: DiagnosticErrorEntry): void {
    this.ring.push(entry);
    this.count += 1;
  }

  /**
   * Record one accepted behavior `ctx.log` entry in the runtime's bounded
   * ring. A log flood cannot grow a diagnostics frame beyond
   * the 32-entry ring; the per-instance ring and counters live in the host.
   */
  log(moduleId: string, level: BehaviorLogLevel, message: string, at?: { file: string; line: number; column: number }): void {
    this.record({
      code: 'behavior_log',
      reason: level,
      moduleId,
      message: clipMessage(message),
      stepIndex: this.sim.stepIndex,
      ...(at !== undefined ? { at } : {}),
    });
  }

  /** A script stopped by its host (a throwing hook): its entry, and its Problems line once. */
  scriptStopped(moduleId: string, stop: ScriptStop): void {
    const r = scriptStopReport(moduleId, stop, this.sim.stepIndex);
    this.record(r.entry);
    const line = this.scriptErrorLines.take(r);
    if (line !== null) this.problems.push(line);
  }

  /** One Problems line per kind for the author (the host passes them to Play's Problems; repeated kinds are dropped). */
  problem(code: string, message: string): void {
    if (this.problemCodes.has(code)) return;
    this.problemCodes.add(code);
    this.problems.push({ code, message: clipMessage(message) });
  }

  /** The problems since the last call (the host relays them). */
  takeProblems(): { code: string; message: string }[] {
    if (this.problems.length === 0) return [];
    const out = this.problems;
    this.problems = [];
    return out;
  }

  /**
   * Fail-stop: abandon the step (no transform rollback), cancel the
   * driver, retain the last committed state for rendering, report the
   * failed module/step and refuse to resume.
   */
  failStop(code: ErrorCode, reason: string, message: string, stepIndex: number, moduleId?: string, phase?: SimulationPhase, detail?: string): void {
    this.halt();
    this.failedModuleId = moduleId;
    this.failedPhase = phase;
    this.failedStepIndex = stepIndex;
    this.record(errorEntryOf({ code, message, stepIndex, reason, moduleId, phase, detail, nodeId: this.failNodeId, frames: this.failFrames }));
    this.failNodeId = undefined;
    this.failFrames = [];
  }

  /** Fail-stop on a thrown error, named after the module and phase running now and the error's kind. */
  failStopFromError(e: unknown, stepIndex: number): void {
    const moduleId = this.sim.currentModuleId;
    const phase = this.sim.currentPhase;
    // A visual script's error names the node it came from.
    this.failNodeId = graphNodeIdOf(e);
    // And where in the compiled scripts it was thrown.
    this.failFrames = compiledFramesOf(e);
    if (e instanceof PhaseViolationError) {
      this.failStop('module_error', 'phase_violation', messageOf(e), stepIndex, moduleId, phase);
      return;
    }
    if (e instanceof DuplicateMoveError) {
      this.failStop('module_error', 'duplicate_move', messageOf(e), stepIndex, moduleId, phase);
      return;
    }
    if (e instanceof PhysicsPortFailure) {
      this.failStop('physics_port_error', e.reason, messageOf(e), stepIndex, moduleId, phase);
      return;
    }
    if (e instanceof InputFrameError) {
      this.failStop('module_error', 'input_frame_invalid', messageOf(e), stepIndex, moduleId, phase);
      return;
    }
    // Behavior contract: the validated-intent API's
    // own rejection reasons, the per-instance cap and the host's step/shape
    // failures. Each is a fail-stop with the contract's exact reason.
    if (e instanceof BehaviorIntentError) {
      this.failStop('module_error', e.reason, messageOf(e), stepIndex, moduleId, phase, e.detail);
      return;
    }
    if (e instanceof BehaviorHostIntentLimit) {
      this.failStop('module_error', e.reason, messageOf(e), stepIndex, moduleId, phase, e.detail);
      return;
    }
    if (e instanceof BehaviorHostError) {
      this.failStop(e.code, e.reason, messageOf(e), stepIndex, moduleId, phase, e.detail);
      return;
    }
    this.failStop('module_error', 'module_threw', `module step threw: ${messageOf(e)}`, stepIndex, moduleId, phase);
  }

  /** Cumulative behavior log totals the host instances report (kept: they stay readable after dispose). */
  behaviorLogTotals(): { logCount: number; logDropped: number } {
    const entries = this.sim.entries;
    if (entries.length > 0) this.logTotals = behaviorLogTotals(entries.map((e) => e.instance));
    return this.logTotals;
  }

  /** The diagnostics' error ring and its count. */
  base(): { errors: DiagnosticErrorEntry[]; errorCount: number } {
    return { errors: this.ring.entries(), errorCount: this.count };
  }

  /** The phased module sets' diagnostics fields: input, physics, intents, the behavior logs and the failed flag. */
  phasedFields(actions: ActionSource, characterId: string | undefined, counts: { inputSamples: number; droppedInputSteps: number; settleSteps: number; physicsSteps: number; intentCommitCount: number }): Partial<RuntimeDiagnostics> {
    const a = actionDiagnostics(actions);
    const physics = physicsDiagnostics(this.sim.physics ?? this.sim.physics3d, characterId);
    const logs = this.behaviorLogTotals();
    return {
      failed: this.sim.stateName === 'failed',
      inputSamples: counts.inputSamples,
      droppedInputSteps: counts.droppedInputSteps,
      settleSteps: counts.settleSteps,
      physicsSteps: counts.physicsSteps,
      inputSuspendCount: a.suspend,
      inputActivateCount: a.activate,
      inputDisconnectCount: a.disconnect,
      inputMappingUnsupportedCount: a.mappingUnsupported,
      physicsStallSteps: physics.stall,
      physicsPenetrationCorrectedCount: physics.penetration,
      ...physics.deepest,
      intentCommitCount: counts.intentCommitCount,
      logCount: logs.logCount,
      logDropped: logs.logDropped,
    };
  }

  /** The failed module, phase and step (set by a fail-stop; added last to a diagnostics frame). */
  failure(): Pick<RuntimeDiagnostics, 'failedModuleId' | 'failedPhase' | 'failedStepIndex'> {
    const out: Pick<RuntimeDiagnostics, 'failedModuleId' | 'failedPhase' | 'failedStepIndex'> = {};
    if (this.failedModuleId !== undefined) out.failedModuleId = this.failedModuleId;
    if (this.failedPhase !== undefined) out.failedPhase = this.failedPhase;
    if (this.failedStepIndex !== undefined) out.failedStepIndex = this.failedStepIndex;
    return out;
  }
}

/**
 * Play debugging: what the running behavior instances expose
 * for a debugger (their module's optional `debug(state)`; a visual script
 * built for Play returns its trace, wire values and variables), for one
 * behavior and/or one entity. Read-only by contract; exported games carry
 * no module that answers.
 */
export function behaviorDebugOf(entries: readonly ModuleEntry[], filter: { behaviorId?: string; entityId?: string }): BehaviorDebugView[] {
  const out: BehaviorDebugView[] = [];
  for (const entry of entries) {
    const probe = entry.instance as { behaviorDebug?: (f: { behaviorId?: string; entityId?: string }) => BehaviorDebugView[] };
    if (typeof probe.behaviorDebug !== 'function') continue;
    out.push(...probe.behaviorDebug(filter));
  }
  return out;
}

/** The property values every behavior instance on `entityId` reads (public and private), read-only, for the Play debug view. */
export function behaviorPropertiesOf(entries: readonly ModuleEntry[], entityId: string): BehaviorPropertyView[] {
  const out: BehaviorPropertyView[] = [];
  for (const entry of entries) {
    const probe = entry.instance as { behaviorProperties?: (id: string) => BehaviorPropertyView | null };
    if (typeof probe.behaviorProperties !== 'function') continue;
    const view = probe.behaviorProperties(entityId);
    if (view !== null) out.push(view);
  }
  return out;
}
