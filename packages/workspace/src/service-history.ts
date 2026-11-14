/**
 * The open project's undo history as the service exposes it: steps grouped,
 * a history started afresh, the entries the project's one undo line
 * (undo-timeline.ts) follows, and their redo tail dropped.
 */
import type { Origin } from '@thirdlight/commands';
import type { Core } from './session';

export function historyOps(core: Core) {
  /**
   * Make the last `count` history entries one step: undo and redo take them
   * together (the backend repeats the command over the entries that share a
   * group). Used where one user action runs several commands (a content pack
   * added). False when the project is not open or fewer entries are applied.
   */
  function groupHistory(projectId: string, count: number): boolean {
    const s = core.sessions.get(projectId);
    if (s === undefined || s.mode !== 'open' || count < 2 || count > s.history.cursor) return false;
    const from = s.history.cursor - count;
    const group = s.history.entries[s.history.cursor - 1]!.seq;
    s.history = { ...s.history, entries: s.history.entries.map((e, i) => (i >= from && i < s.history.cursor ? { ...e, group } : e)) };
    return true;
  }

  /**
   * Start the project's undo history afresh (nothing to undo or redo): a
   * project just made from a template begins where the template's setup
   * left it. False when the project is not open.
   */
  function forgetHistory(projectId: string): boolean {
    const s = core.sessions.get(projectId);
    if (s === undefined || s.mode !== 'open') return false;
    s.history = { ...s.history, entries: [], cursor: 0 };
    return true;
  }

  /**
   * Group the commands a client ran for one user action (their request ids,
   * in order): only when they are exactly the last entries applied, so a
   * command someone else ran in between keeps them apart (`not_last`) rather
   * than being undone with them; and only the caller's own (each entry's
   * origin is `origin`), so one writer cannot fold another's commands (an
   * agent's, another tab's) into its undo step (`not_own`).
   */
  function groupRequests(projectId: string, requestIds: readonly string[], origin: Origin): 'grouped' | 'not_last' | 'not_own' {
    const s = core.sessions.get(projectId);
    const n = requestIds.length;
    if (s === undefined || s.mode !== 'open' || n < 2 || n > s.history.cursor) return 'not_last';
    const top = s.history.entries.slice(s.history.cursor - n, s.history.cursor);
    if (top.some((e, i) => e.requestId !== requestIds[i])) return 'not_last';
    if (top.some((e) => e.origin === null || e.origin.kind !== origin.kind || e.origin.clientId !== origin.clientId)) return 'not_own';
    return groupHistory(projectId, n) ? 'grouped' : 'not_last';
  }

  /**
   * The open project's history as the undo timeline follows it: the revision, every entry's request id in order,
   * and the cursor (entries below it applied, the rest the redo tail). Null when the project is not open.
   */
  function undoHistory(projectId: string): { revision: number; requestIds: readonly string[]; cursor: number } | null {
    const s = core.sessions.get(projectId);
    if (s === undefined || s.mode !== 'open') return null;
    return { revision: s.revision, requestIds: s.history.entries.map((e) => e.requestId), cursor: s.history.cursor };
  }

  /** Drops the history's redo tail (an edit elsewhere in the project's one undo timeline came after those undos). */
  function dropRedoTail(projectId: string): void {
    const s = core.sessions.get(projectId);
    if (s === undefined || s.mode !== 'open' || s.history.cursor === s.history.entries.length) return;
    s.history = { ...s.history, entries: s.history.entries.slice(0, s.history.cursor) };
  }

  /** The history group of the entry undo would take next, and of the one redo would (null: none, or not grouped). */
  function historyGroups(projectId: string): { undo: number | null; redo: number | null } {
    const s = core.sessions.get(projectId);
    if (s === undefined) return { undo: null, redo: null };
    const { entries, cursor } = s.history;
    return { undo: entries[cursor - 1]?.group ?? null, redo: entries[cursor]?.group ?? null };
  }

  return { groupHistory, forgetHistory, groupRequests, historyGroups, undoHistory, dropRedoTail };
}
