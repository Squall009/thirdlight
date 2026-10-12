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
 * The brush keys are the same in every editor with a brush: `[` / `]` size,
 * Shift with them strength, F then a drag resizes in the view (Shift+F:
 * strength), X switches paint and erase, Ctrl held inverts one stroke.
 * Brackets are read by their physical key, so they work on any layout.
 *
 * Pure.
 */
import type { BrushUse } from './brush';

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

/** One entry of the status line's key list: the keys (a chord's parts; "a / b" is either key) and what they do. */
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

/** What a brush key does (null: not a brush key). */
export type BrushKeyAction = { kind: 'size'; dir: 1 | -1 } | { kind: 'strength'; dir: 1 | -1 } | { kind: 'resize' } | { kind: 'restrength' } | { kind: 'invert' };

/** The brush key a key event is, for a tool using `uses`. */
export function brushKeyAction(e: EditKeyEvent, uses: readonly BrushUse[]): BrushKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const strength = uses.includes('strength');
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    const dir = e.code === 'BracketRight' ? 1 : -1;
    if (e.shiftKey) return strength ? { kind: 'strength', dir } : null;
    return uses.includes('size') ? { kind: 'size', dir } : null;
  }
  if (e.code === 'KeyF') {
    if (e.shiftKey) return strength ? { kind: 'restrength' } : null;
    return uses.includes('size') ? { kind: 'resize' } : null;
  }
  if (e.code === 'KeyX' && !e.shiftKey) return uses.includes('invert') ? { kind: 'invert' } : null;
  return null;
}

/**
 * The brush keys of a tool, as the status line lists them. `invert`: what
 * inverting does in plain words ("Lower", "Erase", "Fill").
 */
export function brushKeyHints(uses: readonly BrushUse[], invert = 'Invert'): KeyHint[] {
  const out: KeyHint[] = [];
  if (uses.includes('size')) out.push({ keys: ['[ / ]'], label: 'Size' });
  if (uses.includes('strength')) out.push({ keys: ['Shift', '[ / ]'], label: 'Strength' });
  if (uses.includes('size')) out.push({ keys: ['F'], label: 'Resize in view' });
  if (uses.includes('strength')) out.push({ keys: ['Shift', 'F'], label: 'Strength in view' });
  if (uses.includes('invert')) out.push({ keys: ['X'], label: `Paint / ${invert.toLowerCase()}` }, { keys: ['Ctrl'], label: invert });
  return out;
}

/** The most palette entries a number key reaches (1 … 9). */
export const PALETTE_KEYS = 9;

/** The palette entry a key picks (0-based; null: not a palette key): a plain digit 1–9, read by its physical key. */
export function paletteKeyIndex(e: EditKeyEvent): number | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  const digit = /^Digit([1-9])$/.exec(e.code);
  return digit === null ? null : Number(digit[1]) - 1;
}

/** The status line's entry for a palette of `count` entries (none for an empty one). */
export function paletteKeyHint(count: number, label: string): KeyHint[] {
  const n = Math.min(count, PALETTE_KEYS);
  return n < 1 ? [] : [{ keys: [n === 1 ? '1' : `1–${n}`], label }];
}
