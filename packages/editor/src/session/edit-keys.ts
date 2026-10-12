/**
 * The one key map of the edit modes: every editor (terrain, vertex paint,
 * decals, blocks) reads its keys here, and the status line and tooltips list
 * them from here, so a key means the same in each.
 *
 * Esc cancels in order: a stroke or drag in flight (the Scene view's tools,
 * before this map sees the key), then leaves the mode. Modes switch with
 * Shift+number, leaving plain numbers to palettes (they are used far more
 * while painting); Home frames the edited object because F belongs to the
 * brush's resize-in-view.
 *
 * Pure.
 */

/** What a key does in an edit mode (null: not the map's; the mode's tools may take it). */
export type EditKeyAction = { kind: 'done' } | { kind: 'context' } | { kind: 'frame' } | { kind: 'mode'; index: number };

/** The parts of a key event this map reads. */
export interface EditKeyEvent {
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** The most modes a rail holds that a key reaches (Shift+1 … Shift+9). */
export const EDIT_MODE_KEYS = 9;

/** What a key does in an edit mode whose rail has `modes` modes. */
export function editKeyAction(e: EditKeyEvent, modes: number): EditKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === 'Escape') return { kind: 'done' };
  if (e.key === 'Home') return { kind: 'frame' };
  // Shift changes the key's character ("!" for 1): the physical digit is read.
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit !== null && e.shiftKey) {
    const index = Number(digit[1]) - 1;
    return index < Math.min(modes, EDIT_MODE_KEYS) ? { kind: 'mode', index } : null;
  }
  if (!e.shiftKey && e.key.toLowerCase() === 'c') return { kind: 'context' };
  return null;
}

/** One entry of the status line's key list: the keys (a chord's parts) and what they do. */
export interface KeyHint {
  readonly keys: readonly string[];
  readonly label: string;
}

/** The keys every edit mode has, as the status line lists them (`modes`: the rail's length). */
export function sharedKeyHints(modes: number): KeyHint[] {
  const out: KeyHint[] = [];
  if (modes > 1) out.push({ keys: ['Shift', `1–${Math.min(modes, EDIT_MODE_KEYS)}`], label: 'Mode' });
  out.push({ keys: ['Alt', 'Drag'], label: 'Orbit' }, { keys: ['Home'], label: 'Frame' }, { keys: ['C'], label: 'Context' }, { keys: ['Ctrl', 'Z'], label: 'Undo' }, { keys: ['Esc'], label: 'Done' });
  return out;
}
