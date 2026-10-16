/**
 * The one key map of the edit modes: every editor (terrain, vertex paint,
 * decals, blocks) reads its keys here, and the status line and tooltips list
 * them from here, so a key means the same in each.
 *
 * Esc does the first that applies (`escapeStep`): a field being typed in is
 * left (the editor never sees the key), a stroke or drawing in flight is
 * dropped (the Scene view's tools, before this map sees the key), the mode's
 * selection is cleared, the armed tool is dropped (Navigate: no tool, a drag
 * orbits and a click selects), and only then is the editor left. Space arms
 * the last tool again. Modes switch with
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
export type EditKeyAction = { kind: 'escape' } | { kind: 'last-tool' } | { kind: 'context' } | { kind: 'frame' } | { kind: 'mode'; index: number };

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
  if (e.key === 'Escape') return { kind: 'escape' };
  if (e.key === 'Home') return { kind: 'frame' };
  if (e.code === 'Space' && !e.shiftKey) return { kind: 'last-tool' };
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

/** What an editor holds that Esc reads: something selected in the mode, a tool armed (else Navigate). */
export interface EscapeState {
  readonly selection: boolean;
  readonly armed: boolean;
}

/**
 * What Esc does once no field is typed in and no stroke or drawing is in
 * flight (those come first, before the editor's key map sees the key).
 */
export type EscapeStep = 'deselect' | 'drop' | 'leave';

export function escapeStep(s: EscapeState): EscapeStep {
  return s.selection ? 'deselect' : s.armed ? 'drop' : 'leave';
}

/** What the status line calls each Esc step. */
const ESCAPE_LABELS: Readonly<Record<EscapeStep, string>> = { deselect: 'Deselect', drop: 'Drop the tool', leave: 'Leave' };

/** How the editor stands for the status line's shared keys. */
export interface SharedKeyState extends EscapeState {
  /** The rail's length. */
  readonly modes: number;
  /** The mode has a tool grid (else Navigate is all it has: no tool to drop or bring back). */
  readonly tools: boolean;
  /** The tool Space arms again (its label; null: none). */
  readonly lastTool: string | null;
}

/**
 * The keys every edit mode has, as the status line lists them: in Navigate a
 * plain drag orbits and a click selects (Space brings the last tool back);
 * with a tool armed the left button is the tool's, and Alt+drag orbits. Esc
 * says what it does next.
 */
export function sharedKeyHints(s: SharedKeyState): KeyHint[] {
  const out: KeyHint[] = [];
  const navigate = !s.armed || !s.tools;
  if (navigate) out.push({ keys: ['Drag'], label: 'Orbit' }, { keys: ['Click'], label: 'Select' }, { keys: ['Shift', 'Drag'], label: 'Pan' });
  else out.push({ keys: ['Alt', 'Drag'], label: 'Orbit' });
  if (navigate && s.tools && s.lastTool !== null) out.push({ keys: ['Space'], label: `Last tool: ${s.lastTool}` });
  if (s.modes > 1) out.push({ keys: ['Shift', `1–${Math.min(s.modes, EDIT_MODE_KEYS)}`], label: 'Mode' });
  out.push({ keys: ['Home'], label: 'Frame' }, { keys: ['C'], label: 'Context' }, { keys: ['Ctrl', 'Z'], label: 'Undo' }, { keys: ['Esc'], label: ESCAPE_LABELS[escapeStep({ selection: s.selection, armed: s.armed && s.tools })] });
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

/**
 * The letters a tool grid never binds: C (Context), F (resize in the view)
 * and X (paint / erase: a tile that erases shows X, the brush's key flips to
 * it). Physical keys, as the rest of the map reads them. (Space, which
 * brings the last tool back, is no letter.)
 */
export const RESERVED_TOOL_KEYS: ReadonlySet<string> = new Set(['KeyC', 'KeyF', 'KeyX']);

/** The tool-grid letter a key event is (upper case; null: not a free letter key). */
export function toolKeyOf(e: EditKeyEvent): string | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  const m = /^Key([A-Z])$/.exec(e.code);
  return m === null || RESERVED_TOOL_KEYS.has(e.code) ? null : m[1]!;
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
