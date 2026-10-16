/**
 * Navigate and selection, shared by every editor: whether a tool is armed
 * (else Navigate: a left drag orbits and a click selects what the editor
 * edits), which tile Space brings back, and what is selected in the mode,
 * which Esc clears before it drops the tool and before it leaves.
 *
 * The shell holds the one state and gives it to everything it shows (the
 * column, the detail column, what lies over the view); a column reads
 * `useToolArmed` to arm its tool in the Scene view or put it in Navigate, its
 * tool grid says it is there (`useToolGridPresence`), and whatever holds a
 * selection says so with `useEditSelection`. Outside an editor (no shell) a
 * tool grid works as before: its tile is always armed.
 *
 * Browser-only (React).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export interface EditToolApi {
  /** A tool is armed (false: Navigate). False in a mode without a tool grid. */
  readonly armed: boolean;
  /** What Navigate does in the mode, in one sentence (the tool grid's note). */
  readonly hint: string;
  /** Arm the mode's remembered tool. */
  arm(): void;
  /** Drop the tool (Navigate). */
  drop(): void;
  /** A tool grid shows, with the tile Space arms (its label); the returned function says it went. */
  grid(id: symbol, last: string | null): () => void;
  /** What is selected in the mode, in words (null: nothing), and how to clear it. */
  selection(id: symbol, sel: EditSelection | null): void;
}

export interface EditSelection {
  readonly label: string;
  /** A shorter name where room is short (the column's head; absent: the label). */
  readonly short?: string;
  clear(): void;
}

export const EditToolContext = createContext<EditToolApi | null>(null);

/** The shell's Navigate state (null outside an editor). */
export function useEditTool(): EditToolApi | null {
  return useContext(EditToolContext);
}

/** Whether the mode's tool is armed (true outside an editor, where a tool grid always arms its tile). */
export function useToolArmed(): boolean {
  return useContext(EditToolContext)?.armed ?? true;
}

/**
 * A tool grid says it shows (and which tile Space arms) while it is mounted
 * and usable; a disabled one (a locked layer, a material that reads no paint)
 * has no tool to arm, so its mode is in Navigate and its column's words stay
 * on the status line.
 */
export function useToolGridPresence(last: string | null, usable: boolean): void {
  const grid = useContext(EditToolContext)?.grid;
  const id = useRef(Symbol('tool grid')).current;
  useEffect(() => (usable ? grid?.(id, last) : undefined), [grid, id, last, usable]);
}

/**
 * Say what is selected in the mode (null: nothing) while the caller shows;
 * Esc calls `clear` before it drops the tool or leaves the editor.
 */
export function useEditSelection(label: string | null, clear: () => void, short?: string): void {
  const select = useContext(EditToolContext)?.selection;
  const id = useRef(Symbol('selection')).current;
  const latest = useRef(clear);
  latest.current = clear;
  useEffect(() => {
    select?.(id, label === null ? null : { label, ...(short !== undefined ? { short } : {}), clear: () => latest.current() });
  }, [select, id, label, short]);
  useEffect(() => () => select?.(id, null), [select, id]);
}

/** What the shell reads back from its editors' columns and views. */
export interface EditToolHost {
  readonly api: EditToolApi;
  /** A tool grid shows in the mode. */
  readonly tools: boolean;
  /** The tile Space arms (null: none). */
  readonly lastTool: string | null;
  /** What is selected, in words (empty: nothing), and its shorter names. */
  readonly selected: readonly string[];
  readonly selectedShort: readonly string[];
  /** Something is selected now (read at the key press: two quick presses must not both see the one selection). */
  hasSelection(): boolean;
  /** A tool is armed now (the same: read at the key press). */
  isArmed(): boolean;
  /** A tool grid shows now (a mode just switched to has registered its grid before it is drawn again). */
  hasTools(): boolean;
  /** Clear every selection the mode holds (Esc); false when there was none. */
  clearSelection(): boolean;
}

/** The shell's side: `armed` and `setArmed` are the edit mode's state. */
export function useEditToolHost(armed: boolean, setArmed: (on: boolean) => void, hint: string): EditToolHost {
  const grids = useRef(new Map<symbol, string | null>());
  const selections = useRef(new Map<symbol, EditSelection>());
  const [gridState, setGridState] = useState<{ tools: boolean; last: string | null }>({ tools: false, last: null });
  const [selected, setSelected] = useState<{ labels: readonly string[]; short: readonly string[] }>({ labels: [], short: [] });
  const syncGrids = useCallback(() => {
    const last = [...grids.current.values()].find((v) => v !== null) ?? null;
    const tools = grids.current.size > 0;
    setGridState((g) => (g.tools === tools && g.last === last ? g : { tools, last }));
  }, []);
  const syncSelections = useCallback(() => {
    const all = [...selections.current.values()];
    const labels = all.map((s) => s.label);
    const short = all.map((s) => s.short ?? s.label);
    const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((l, i) => l === b[i]);
    setSelected((was) => (same(was.labels, labels) && same(was.short, short) ? was : { labels, short }));
  }, []);
  // The registrations are stable, so a tool armed or dropped never makes the grids and selections register again.
  const grid = useCallback(
    (id: symbol, last: string | null) => {
      grids.current.set(id, last);
      syncGrids();
      return () => {
        grids.current.delete(id);
        syncGrids();
      };
    },
    [syncGrids],
  );
  const selection = useCallback(
    (id: symbol, sel: EditSelection | null) => {
      if (sel === null) selections.current.delete(id);
      else selections.current.set(id, sel);
      syncSelections();
    },
    [syncSelections],
  );
  const effective = armed && gridState.tools;
  // The armed state as last set (a press arms or drops at once, before the editor is drawn again).
  const armedNow = useRef(effective);
  armedNow.current = effective;
  const api = useMemo<EditToolApi>(
    () => ({
      armed: effective,
      hint,
      arm: () => {
        armedNow.current = grids.current.size > 0;
        setArmed(true);
      },
      drop: () => {
        armedNow.current = false;
        setArmed(false);
      },
      grid,
      selection,
    }),
    [effective, hint, setArmed, grid, selection],
  );
  const isArmed = useCallback((): boolean => armedNow.current, []);
  const hasTools = useCallback((): boolean => grids.current.size > 0, []);
  const hasSelection = useCallback((): boolean => selections.current.size > 0, []);
  const clearSelection = useCallback((): boolean => {
    const all = [...selections.current.values()];
    for (const s of all) s.clear();
    // Gone at once: the next Esc goes on to the tool even before the cleared selections are drawn again.
    selections.current.clear();
    syncSelections();
    return all.length > 0;
  }, [syncSelections]);
  return { api, tools: gridState.tools, lastTool: gridState.last, selected: selected.labels, selectedShort: selected.short, hasSelection, isArmed, hasTools, clearSelection };
}
