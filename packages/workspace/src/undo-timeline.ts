/**
 * The project's one undo: every undoable edit, a project command or a voxel
 * stroke, on one line in the order it was made, and `undo` / `redo` taking
 * the newest step back or applying the next again, whichever kind it is.
 *
 * The two stores stay what they are: the project history (commands'
 * history.ts, in the workspace session) holds the project's entries, and
 * each voxel world (voxel-worlds.ts) its strokes' records. The line holds
 * only which store each step went to and in what order: a project entry by
 * its request id, a stroke by its world and stroke id. So it lasts as long
 * as they do (in this process; a backend restart starts every project with
 * nothing to undo, as the project history always has) and is shared by
 * every client of the project, as the project history is.
 *
 * Project commands are applied by the workspace's synchronous pipeline,
 * which the line does not sit in front of: before each use the line is
 * brought level with the project history (`reconcile`). Entries the history
 * gained since are new edits, made after everything the line holds: the
 * line's redo tail goes (of both kinds: one line, the usual rule) and they
 * are appended. A stroke made through the line drops the project's redo tail
 * the same way. A project history started afresh (an external change taken
 * in, a project reopened) leaves the strokes on the line, and a world read
 * again, closed or deleted leaves the project entries: a step whose store no
 * longer holds it is skipped and named in the answer (`skipped`), never a
 * wall every later undo stops at.
 *
 * Steps of one project run one at a time in arrival order; a request id
 * seen again answers as the first time (an undo resent after a lost answer
 * does not take back a second step).
 */
import type { MutationResult } from '@thirdlight/commands';
import type { WorkspaceService } from './types';
import type { VoxelCommandResult, VoxelStepDirection, VoxelWorlds } from './voxel-worlds';

/** One step on the line: a project history entry, or a voxel world's stroke. */
export type TimelineEntry = { readonly kind: 'project'; readonly requestId: string } | { readonly kind: 'voxel'; readonly world: string; readonly stroke: number };

/** A step the line held whose store no longer has it: left out of the undo (or redo) and named in its answer. */
export interface SkippedStep {
  readonly world: string;
  readonly stroke: number;
  readonly reason: string;
}

/** What one `undo` / `redo` did. */
export type TimelineStep =
  /** The project's own pipeline ran it (a project entry, or nothing left to step: its refusal). */
  | { readonly kind: 'project'; readonly result: MutationResult; readonly skipped: readonly SkippedStep[] }
  /** A voxel world's stroke; `revision` is the project's (unchanged by a stroke). */
  | { readonly kind: 'voxel'; readonly result: VoxelCommandResult; readonly revision: number; readonly skipped: readonly SkippedStep[] }
  /** Refused before any store was asked (the project moved on since the revision the caller saw). */
  | { readonly kind: 'refused'; readonly error: { code: string; cls: 'conflict'; message: string; expectedRevision: number; currentRevision: number }; readonly skipped: readonly SkippedStep[] };

/** Answers kept per project for request ids sent again. */
const ANSWERS_KEPT = 256;
/** Notes of strokes left out between steps kept for the next step's answer. */
const SKIPPED_KEPT = 64;

interface Line {
  entries: TimelineEntry[];
  /** Entries below it are applied; the rest are the redo tail. */
  cursor: number;
  readonly answers: Map<string, TimelineStep>;
  queue: Promise<unknown>;
  /** A step or stroke under way: a world's stacks may be between states, so strokes are not checked meanwhile. */
  busy: number;
  /** Strokes left out by a read of the line (depths, next) since the last step: the next step's answer names them. */
  skipped: SkippedStep[];
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export class UndoTimeline {
  private readonly lines = new Map<string, Line>();

  constructor(
    private readonly service: Pick<WorkspaceService, 'runCommand' | 'undoHistory' | 'dropRedoTail'>,
    private readonly worlds: Pick<VoxelWorlds, 'command' | 'step' | 'strokeSide' | 'newestStroke' | 'clearRedo'>,
  ) {}

  private line(projectId: string): Line {
    let l = this.lines.get(projectId);
    if (l === undefined) this.lines.set(projectId, (l = { entries: [], cursor: 0, answers: new Map(), queue: Promise.resolve(), busy: 0, skipped: [] }));
    return l;
  }

  private serial<T>(l: Line, fn: () => Promise<T>): Promise<T> {
    const run = l.queue.then(async () => {
      l.busy++;
      try {
        return await fn();
      } finally {
        l.busy--;
      }
    });
    l.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * A voxel world command (a stroke) applied through the line: the stroke it made becomes the line's newest step,
   * after the redo tail of both kinds is dropped.
   */
  voxelCommand(projectId: string, envelope: Record<string, unknown>): Promise<VoxelCommandResult> {
    const l = this.line(projectId);
    return this.serial(l, async () => {
      l.skipped.push(...this.reconcile(projectId, l, true));
      const r = await this.worlds.command(projectId, envelope);
      // A partial write applied the stroke too (the refusal says which files hold it): it is undoable all the same.
      const world = (envelope.args as { world?: unknown } | undefined)?.world;
      if (r.ok && !r.duplicated) this.recordStroke(projectId, l, r.world, r.stroke);
      else if (!r.ok && r.error.code === 'write_partial' && typeof world === 'string') this.recordPartial(projectId, l, world);
      return r;
    });
  }

  /**
   * `undo` (or `redo`) of the project: the newest applied step (or the next undone one) is taken back (or applied
   * again) by its own store. `envelope` is the project command envelope (`expectedRevision` the project's revision
   * the caller saw: a stroke is refused against it as a project entry is).
   */
  step(projectId: string, op: VoxelStepDirection, envelope: Record<string, unknown>): Promise<TimelineStep> {
    const l = this.line(projectId);
    return this.serial(l, async () => {
      const requestId = typeof envelope.requestId === 'string' ? envelope.requestId : null;
      const seen = requestId === null ? undefined : l.answers.get(requestId);
      if (seen !== undefined) {
        // The project pipeline answers its own repeats (duplicated: true); a stroke's answer is kept here.
        return seen.kind === 'project' ? { ...seen, result: this.service.runCommand(envelope) } : seen.kind === 'voxel' && seen.result.ok ? { ...seen, result: { ...seen.result, duplicated: true } } : seen;
      }
      const skipped: SkippedStep[] = l.skipped.splice(0);
      for (;;) {
        skipped.push(...this.reconcile(projectId, l, true));
        const at = op === 'undo' ? l.cursor - 1 : l.cursor;
        const e = l.entries[at];
        if (e === undefined || e.kind === 'project') {
          const result = this.service.runCommand(envelope);
          if (result.ok && !result.duplicated && e !== undefined) l.cursor += op === 'undo' ? -1 : 1;
          return this.answered(l, requestId, { kind: 'project', result, skipped });
        }
        const h = this.service.undoHistory(projectId);
        const expected = envelope.expectedRevision;
        if (h !== null && typeof expected === 'number' && expected !== h.revision) {
          return { kind: 'refused', error: { code: 'revision_conflict', cls: 'conflict', message: `the project is at revision ${h.revision}, not ${expected}: an ${op} now would step a change this view has not seen`, expectedRevision: expected, currentRevision: h.revision }, skipped };
        }
        const result = await this.worlds.step(projectId, e.world, op, e.stroke, requestId);
        if (!result.ok && result.error.code === 'history_gone') {
          l.entries.splice(at, 1);
          if (at < l.cursor) l.cursor--;
          skipped.push({ world: e.world, stroke: e.stroke, reason: result.error.message });
          continue;
        }
        if (result.ok && !result.duplicated) l.cursor += op === 'undo' ? -1 : 1;
        return this.answered(l, requestId, { kind: 'voxel', result, revision: h?.revision ?? 0, skipped });
      }
    });
  }

  /** Which store the next `undo` (or `redo`) goes to (null: nothing to step). */
  next(projectId: string, op: VoxelStepDirection): 'project' | 'voxel' | null {
    const l = this.line(projectId);
    this.read(projectId, l);
    return l.entries[op === 'undo' ? l.cursor - 1 : l.cursor]?.kind ?? null;
  }

  /** The undo and redo depths of the one line (what the editor's Edit menu and MCP read as the project's history). */
  depths(projectId: string): { undoDepth: number; redoDepth: number } {
    const l = this.line(projectId);
    this.read(projectId, l);
    return { undoDepth: l.cursor, redoDepth: l.entries.length - l.cursor };
  }

  /** The line as it stands (tests and diagnostics). */
  entries(projectId: string): { entries: readonly TimelineEntry[]; cursor: number } {
    const l = this.line(projectId);
    this.read(projectId, l);
    return { entries: [...l.entries], cursor: l.cursor };
  }

  /** The line brought level for a read; what it leaves out waits for the next step's answer. */
  private read(projectId: string, l: Line): void {
    l.skipped.push(...this.reconcile(projectId, l, l.busy === 0));
    // Bounded: a line read often and never stepped keeps the newest notes.
    if (l.skipped.length > SKIPPED_KEPT) l.skipped.splice(0, l.skipped.length - SKIPPED_KEPT);
  }

  private answered(l: Line, requestId: string | null, step: TimelineStep): TimelineStep {
    // Only what moved the line is kept: a refusal may be sent again and find the line as it was.
    const moved = step.kind === 'project' ? step.result.ok : step.kind === 'voxel' && step.result.ok;
    if (requestId !== null && moved) {
      l.answers.set(requestId, step);
      if (l.answers.size > ANSWERS_KEPT) l.answers.delete(l.answers.keys().next().value!);
    }
    return step;
  }

  /** A new stroke: the redo tail of both kinds goes, the stroke is the newest step. */
  private recordStroke(projectId: string, l: Line, world: string, stroke: number): void {
    if (l.entries.some((e) => e.kind === 'voxel' && e.world === world && e.stroke === stroke)) return;
    this.dropTail(projectId, l);
    l.entries.push({ kind: 'voxel', world, stroke });
    l.cursor = l.entries.length;
  }

  /** A stroke written only in part is applied in the backend and undoable: found as its world's newest undoable one. */
  private recordPartial(projectId: string, l: Line, world: string): void {
    // Every earlier stroke of the world came through the line, so its newest is the one the line lacks.
    const newest = this.worlds.newestStroke(projectId, world);
    if (newest !== null) this.recordStroke(projectId, l, world, newest);
  }

  private dropTail(projectId: string, l: Line): void {
    const tail = l.entries.splice(l.cursor);
    if (tail.some((e) => e.kind === 'project')) this.service.dropRedoTail(projectId);
    for (const world of new Set(tail.flatMap((e) => (e.kind === 'voxel' ? [e.world] : [])))) void this.worlds.clearRedo(projectId, world);
  }

  /**
   * Brings the line level with its stores: strokes their world no longer holds on the side the line has them
   * (`checkStrokes`) are left out (and returned), and the project history's entries are matched by request id.
   * The history's applied entries are the line's applied project entries followed by any it gained since (new
   * edits, newer than everything on the line: the line's redo tail goes); anything else (a history started afresh)
   * keeps the strokes in their order and the history's entries in theirs, applied ones last among the applied.
   */
  private reconcile(projectId: string, l: Line, checkStrokes: boolean): SkippedStep[] {
    const skipped: SkippedStep[] = [];
    if (checkStrokes) {
      for (let i = l.entries.length - 1; i >= 0; i--) {
        const e = l.entries[i]!;
        if (e.kind !== 'voxel') continue;
        const side = this.worlds.strokeSide(projectId, e.world, e.stroke);
        if (side === (i < l.cursor ? 'undo' : 'redo')) continue;
        l.entries.splice(i, 1);
        if (i < l.cursor) l.cursor--;
        skipped.push({ world: e.world, stroke: e.stroke, reason: `voxel world ${e.world} no longer holds stroke ${e.stroke} (the world was read again, closed or deleted since)` });
      }
    }
    const h = this.service.undoHistory(projectId);
    const ids = h?.requestIds ?? [];
    const applied = ids.slice(0, h?.cursor ?? 0);
    const redo = ids.slice(h?.cursor ?? 0);
    const projectIds = (from: number, to: number): string[] => l.entries.slice(from, to).flatMap((e) => (e.kind === 'project' ? [e.requestId] : []));
    const lineApplied = projectIds(0, l.cursor);
    const lineRedo = projectIds(l.cursor, l.entries.length);
    if (same(lineApplied, applied) && same(lineRedo, redo)) return skipped;
    if (redo.length === 0 && applied.length > lineApplied.length && same(applied.slice(0, lineApplied.length), lineApplied)) {
      // New project edits: everything undone before them is no longer redoable.
      this.dropTail(projectId, l);
      for (const requestId of applied.slice(lineApplied.length)) l.entries.push({ kind: 'project', requestId });
      l.cursor = l.entries.length;
      return skipped;
    }
    // The history started afresh or lost entries: its entries in its order, the strokes kept in theirs.
    const held = new Set(ids);
    const keptApplied = l.entries.slice(0, l.cursor).filter((e) => e.kind === 'voxel' || held.has(e.requestId));
    const keptRedo = l.entries.slice(l.cursor).filter((e) => e.kind === 'voxel' || held.has(e.requestId));
    const strokesApplied = keptApplied.filter((e) => e.kind === 'voxel');
    const strokesRedo = keptRedo.filter((e) => e.kind === 'voxel');
    const asEntries = (list: readonly string[]): TimelineEntry[] => list.map((requestId) => ({ kind: 'project', requestId }));
    const nowApplied = same(projectIds(0, l.cursor).filter((id) => held.has(id)), applied) ? keptApplied : [...strokesApplied, ...asEntries(applied)];
    const nowRedo = same(projectIds(l.cursor, l.entries.length).filter((id) => held.has(id)), redo) ? keptRedo : [...asEntries(redo), ...strokesRedo];
    l.entries = [...nowApplied, ...nowRedo];
    l.cursor = nowApplied.length;
    return skipped;
  }
}
