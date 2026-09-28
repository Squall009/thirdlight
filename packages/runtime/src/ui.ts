/**
 * Phase 23.9a: project UI in the simulation — the scripts' view model, the
 * stack of shown UI documents and the UI events of a step.
 *
 * The runtime never draws: the game host draws the documents (DOM/CSS) from
 * what this state publishes. Scripts publish view-model values with
 * `ctx.ui.set(path, value)` and show/hide documents; the changes of each step
 * leave as a diff (`takeOutput`, coalesced by path: a later write to a path
 * replaces an earlier one, which is safe because a write replaces the whole
 * subtree under its path). UI events (a click, a submit, a focus change, a
 * custom event, a show/hide from a document's button) come back as entries of
 * the next sampled input frame (`ActionFrame.ui`), so a recorded input
 * replays them exactly; the runtime applies a frame's show/hide entries to
 * the stack before any script runs and hands every entry to scripts
 * (`ctx.ui.events()`, intent phase).
 *
 * Everything here is simulation state: two runs with the same input produce
 * the same view model and stack at every step (the step digest covers them).
 */
import type { RuntimeUiDocumentRow } from '@thirdlight/project-model';

/** What a UI event is. */
// Phase 23.10: `mode` (a button's mode action: switch to the game mode named by `value`) and
// `restart` (the engine's restart of the run) are applied by
// the runtime when the frame is sampled; their `doc` may be '' (the engine's pause panel).
// Phase 24.4j: `scene` (the shell's move to an entry of its scene list: `value` is the entry's index),
// applied by the runtime at the next step boundary.
export type UiEventKind = 'click' | 'submit' | 'focus' | 'custom' | 'show' | 'hide' | 'toggle' | 'mode' | 'restart' | 'scene';
export const UI_EVENT_KINDS: readonly UiEventKind[] = ['click', 'submit', 'focus', 'custom', 'show', 'hide', 'toggle', 'mode', 'restart', 'scene'];

/** One UI event carried by an input frame (and read by scripts). */
export interface UiEventRecord {
  readonly kind: UiEventKind;
  /** The document it happened in (show/hide/toggle: the document shown or hidden). */
  readonly doc: string;
  /** The widget it happened on ('' for none). */
  readonly widget: string;
  /** The event name (a button's event action, an input's submit action; '' for focus/show/hide). */
  readonly name: string;
  /** Its value (a button action's value, the submitted text). */
  readonly value?: number | string | boolean | null;
  /** The list item it happened in (the item's index), when it came from a list template. */
  readonly index?: number;
}

/** Engine limits of UI events and the view model. */
export const MAX_FRAME_UI_EVENTS = 16;
export const UI_MODEL_MAX_BYTES = 65_536;
export const UI_VALUE_MAX_TEXT = 1024;
export const UI_VALUE_MAX_ITEMS = 256;
export const UI_VALUE_MAX_KEYS = 64;
export const UI_VALUE_MAX_DEPTH = 8;
/** Documents shown at once. */
export const UI_MAX_SHOWN = 32;
/** Pending presentation commands (tween plays, focus requests) between two host frames. */
export const UI_MAX_COMMANDS = 64;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const DOC_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const hasOwn = Object.prototype.hasOwnProperty;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The segments of a view-model path ("hud.hp" → ["hud", "hp"]), or null when it is not one. */
export function uiPathSegments(path: unknown): string[] | null {
  if (typeof path !== 'string' || path.length < 1 || path.length > 128) return null;
  const segs = path.split('.');
  if (segs.length > UI_VALUE_MAX_DEPTH) return null;
  for (const s of segs) if (!SEGMENT_RE.test(s)) return null;
  return segs;
}

/** The value at `segs` under `root` (undefined when absent). */
export function readUiPath(root: unknown, segs: readonly string[]): unknown {
  let cur: unknown = root;
  for (const s of segs) {
    if (Array.isArray(cur)) {
      const i = /^\d+$/.test(s) ? Number(s) : -1;
      cur = i >= 0 && i < cur.length ? cur[i] : undefined;
    } else if (isPlainObject(cur)) cur = hasOwn.call(cur, s) ? cur[s] : undefined;
    else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** A JSON copy of a value when it fits a view-model value (bounded text, lists, keys and depth), else null. */
function copyValue(v: unknown, depth: number): { ok: true; value: unknown } | { ok: false } {
  if (v === null || typeof v === 'boolean') return { ok: true, value: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { ok: true, value: Object.is(v, -0) ? 0 : v } : { ok: false };
  if (typeof v === 'string') return v.length <= UI_VALUE_MAX_TEXT ? { ok: true, value: v } : { ok: false };
  if (depth >= UI_VALUE_MAX_DEPTH) return { ok: false };
  if (Array.isArray(v)) {
    if (v.length > UI_VALUE_MAX_ITEMS) return { ok: false };
    const out: unknown[] = [];
    for (const x of v) {
      const c = copyValue(x, depth + 1);
      if (!c.ok) return c;
      out.push(c.value);
    }
    return { ok: true, value: Object.freeze(out) };
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length > UI_VALUE_MAX_KEYS) return { ok: false };
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (!SEGMENT_RE.test(k)) return { ok: false };
      if (v[k] === undefined) continue;
      const c = copyValue(v[k], depth + 1);
      if (!c.ok) return c;
      out[k] = c.value;
    }
    return { ok: true, value: Object.freeze(out) };
  }
  return { ok: false };
}

/** Validate a frame's `ui` entries (at most 16), returning frozen copies. */
export function validateUiEvents(raw: unknown): { ok: true; events: readonly UiEventRecord[] } | { ok: false; field: string; message: string } {
  if (!Array.isArray(raw) || raw.length > MAX_FRAME_UI_EVENTS) return { ok: false, field: 'ui', message: `ui must be an array of at most ${MAX_FRAME_UI_EVENTS} UI events` };
  const out: UiEventRecord[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const c = validateUiEvent(raw[i]);
    if (!c.ok) return { ok: false, field: `ui/${i}${c.field === '' ? '' : `/${c.field}`}`, message: c.message };
    out.push(c.event);
  }
  return { ok: true, events: Object.freeze(out) };
}

/** Validate one UI event (see `UiEventRecord`). */
export function validateUiEvent(raw: unknown): { ok: true; event: UiEventRecord } | { ok: false; field: string; message: string } {
  if (!isPlainObject(raw)) return { ok: false, field: '', message: 'a UI event is { kind, doc, widget, name, value?, index? }' };
  for (const k in raw) if (hasOwn.call(raw, k) && !['kind', 'doc', 'widget', 'name', 'value', 'index'].includes(k)) return { ok: false, field: k, message: `unknown UI event field "${k}"` };
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(UI_EVENT_KINDS as readonly string[]).includes(kind)) return { ok: false, field: 'kind', message: `kind is one of ${UI_EVENT_KINDS.join(', ')}` };
  const doc = raw['doc'];
  const engine = kind === 'mode' || kind === 'restart' || kind === 'scene';
  if (typeof doc !== 'string' || !(DOC_RE.test(doc) || (engine && doc === ''))) return { ok: false, field: 'doc', message: 'doc is a UI document id' };
  const widget = raw['widget'] ?? '';
  if (typeof widget !== 'string' || (widget !== '' && !NAME_RE.test(widget))) return { ok: false, field: 'widget', message: "widget is a widget id or ''" };
  const name = raw['name'] ?? '';
  if (typeof name !== 'string' || (name !== '' && !NAME_RE.test(name))) return { ok: false, field: 'name', message: "name is an event name or ''" };
  const value = raw['value'];
  if (value !== undefined && !(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 256))) {
    return { ok: false, field: 'value', message: 'value is a number, text (≤ 256), true/false or null' };
  }
  const index = raw['index'];
  if (index !== undefined && !(typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 65_536)) return { ok: false, field: 'index', message: 'index is a list item index' };
  const ev: UiEventRecord = Object.freeze({
    kind: kind as UiEventKind,
    doc,
    widget,
    name,
    ...(value !== undefined ? { value: Object.is(value, -0) ? 0 : (value as number | string | boolean | null) } : {}),
    ...(index !== undefined ? { index: index as number } : {}),
  });
  return { ok: true, event: ev };
}

/** One shown document (bottom first when sorted by layer, then show order). */
export interface UiShownDocument {
  readonly doc: string;
  readonly layer: number;
  readonly modal: boolean;
}

/** A presentation command for the host (tweens, focus): not simulation state, delivered once. */
export type UiCommand =
  | { readonly op: 'play'; readonly doc: string; readonly tween: string; readonly widget: string }
  | { readonly op: 'focus'; readonly doc: string; readonly widget: string };

/**
 * What the host applies after a frame: the view-model writes in order
 * (`[path]` removes a path, `[path, value]` sets it), the shown documents
 * when they changed, the presentation commands. `reset` first clears the
 * whole view model (a new run).
 */
export interface UiOutput {
  readonly reset?: true;
  readonly set: readonly (readonly [string] | readonly [string, unknown])[];
  readonly shown?: readonly UiShownDocument[];
  readonly commands: readonly UiCommand[];
}

/** The committed UI state (the step digest and a late mirror read it). */
export interface UiStateView {
  readonly model: Readonly<Record<string, unknown>>;
  readonly shown: readonly UiShownDocument[];
}

/** Merge a later output into an earlier one (the host takes several steps' outputs at once). */
export function mergeUiOutput(a: UiOutput | null, b: UiOutput | null): UiOutput | null {
  if (a === null) return b;
  if (b === null) return a;
  if (b.reset === true) return b;
  const set = new Map<string, readonly [string] | readonly [string, unknown]>();
  for (const e of a.set) set.set(e[0], e);
  for (const e of b.set) {
    set.delete(e[0]);
    set.set(e[0], e);
  }
  const commands = [...a.commands, ...b.commands];
  if (commands.length > UI_MAX_COMMANDS) commands.splice(0, commands.length - UI_MAX_COMMANDS);
  const shown = b.shown ?? a.shown;
  return { ...(a.reset === true ? { reset: true as const } : {}), set: [...set.values()], ...(shown !== undefined ? { shown } : {}), commands };
}

/** The simulation's UI state (one per runtime). */
export class UiState {
  private readonly docs: ReadonlyMap<string, RuntimeUiDocumentRow>;
  private model: Record<string, unknown> = {};
  /** JSON text length per top-level key (the model's size without re-serializing it). */
  private readonly sizes = new Map<string, number>();
  private total = 0;
  private shownList: { doc: string; layer: number; modal: boolean; serial: number }[] = [];
  private serial = 0;
  private pendingSet = new Map<string, readonly [string] | readonly [string, unknown]>();
  private pendingShown = false;
  private pendingReset = false;
  private pendingCommands: UiCommand[] = [];
  private stepEvents: readonly UiEventRecord[] = Object.freeze([]);
  private shownCache: readonly UiShownDocument[] | null = null;
  private viewCache: UiStateView | null = null;
  /** Bumped on every change (the host and the digest read the view by it). */
  revision = 0;

  constructor(rows: readonly RuntimeUiDocumentRow[] | undefined) {
    this.docs = new Map((rows ?? []).map((r) => [r.uiDocumentId, r] as const));
  }

  /** The project has this document. */
  hasDocument(id: string): boolean {
    return this.docs.has(id);
  }

  private touched(): void {
    this.revision += 1;
    this.viewCache = null;
  }

  /** `ctx.ui.set`: publish a value at a path (false: a bad path or value, or the 64 KiB limit). */
  set(path: unknown, value: unknown): boolean {
    const segs = uiPathSegments(path);
    if (segs === null) return false;
    const copy = copyValue(value, segs.length);
    if (!copy.ok) return false;
    const top = segs[0]!;
    // Build the new top-level entry without touching the model until it fits.
    const nextTop = segs.length === 1 ? copy.value : writeUnder(this.model[top], segs.slice(1), copy.value);
    if (nextTop === undefined) return false;
    const size = JSON.stringify(nextTop).length + top.length + 4;
    const nextTotal = this.total - (this.sizes.get(top) ?? 0) + size;
    if (nextTotal > UI_MODEL_MAX_BYTES) return false;
    this.model = { ...this.model, [top]: nextTop };
    Object.freeze(this.model);
    this.sizes.set(top, size);
    this.total = nextTotal;
    this.pend(path as string, [path as string, copy.value]);
    return true;
  }

  /** `ctx.ui.clear`: remove a path (false when it was not there). */
  clear(path: unknown): boolean {
    const segs = uiPathSegments(path);
    if (segs === null) return false;
    const top = segs[0]!;
    if (!hasOwn.call(this.model, top)) return false;
    if (segs.length === 1) {
      const next = { ...this.model };
      delete next[top];
      this.model = Object.freeze(next);
      this.total -= this.sizes.get(top) ?? 0;
      this.sizes.delete(top);
    } else {
      if (readUiPath(this.model[top], segs.slice(1)) === undefined) return false;
      const nextTop = removeUnder(this.model[top], segs.slice(1));
      const size = JSON.stringify(nextTop).length + top.length + 4;
      this.total = this.total - (this.sizes.get(top) ?? 0) + size;
      this.sizes.set(top, size);
      this.model = Object.freeze({ ...this.model, [top]: nextTop });
    }
    this.pend(path as string, [path as string]);
    return true;
  }

  private pend(path: string, entry: readonly [string] | readonly [string, unknown]): void {
    this.pendingSet.delete(path);
    this.pendingSet.set(path, entry);
    this.touched();
  }

  /** `ctx.ui.get`: the published value at a path (null when absent). */
  get(path: unknown): unknown {
    const segs = uiPathSegments(path);
    if (segs === null) return null;
    const v = readUiPath(this.model, segs);
    return v === undefined ? null : v;
  }

  /** `ctx.ui.show`: show a document (on top of its layer; again: brought to the top). */
  show(doc: unknown, options?: { layer?: unknown; modal?: unknown }): boolean {
    if (typeof doc !== 'string') return false;
    const row = this.docs.get(doc);
    if (row === undefined) return false;
    const layerIn = options?.layer;
    const layer = typeof layerIn === 'number' && Number.isInteger(layerIn) && layerIn >= -100 && layerIn <= 100 ? layerIn : row.layer;
    const modal = typeof options?.modal === 'boolean' ? options.modal : row.modal;
    const rest = this.shownList.filter((s) => s.doc !== doc);
    if (rest.length >= UI_MAX_SHOWN) return false;
    this.serial += 1;
    rest.push({ doc, layer, modal, serial: this.serial });
    this.shownList = rest;
    this.shownChanged();
    return true;
  }

  /** `ctx.ui.hide`: hide a shown document (false when it was not shown). */
  hide(doc: unknown): boolean {
    if (typeof doc !== 'string' || !this.shownList.some((s) => s.doc === doc)) return false;
    this.shownList = this.shownList.filter((s) => s.doc !== doc);
    this.shownChanged();
    return true;
  }

  isShown(doc: unknown): boolean {
    return typeof doc === 'string' && this.shownList.some((s) => s.doc === doc);
  }

  private shownChanged(): void {
    this.shownCache = null;
    this.pendingShown = true;
    this.touched();
  }

  /** The shown documents, bottom first (layer, then show order). */
  shown(): readonly UiShownDocument[] {
    if (this.shownCache === null) {
      const sorted = [...this.shownList].sort((a, b) => a.layer - b.layer || a.serial - b.serial);
      this.shownCache = Object.freeze(sorted.map((s) => Object.freeze({ doc: s.doc, layer: s.layer, modal: s.modal })));
    }
    return this.shownCache;
  }

  /** `ctx.ui.play` / `ctx.ui.focus`: a presentation command for the host (false: an unknown document or a bad name). */
  command(op: 'play' | 'focus', doc: unknown, name: unknown, widget: unknown): boolean {
    if (typeof doc !== 'string' || !this.docs.has(doc)) return false;
    if (op === 'play') {
      if (typeof name !== 'string' || !NAME_RE.test(name)) return false;
      const w = widget === undefined || widget === null ? '' : widget;
      if (typeof w !== 'string' || (w !== '' && !NAME_RE.test(w))) return false;
      this.pushCommand({ op: 'play', doc, tween: name, widget: w });
    } else {
      if (typeof name !== 'string' || !NAME_RE.test(name)) return false;
      this.pushCommand({ op: 'focus', doc, widget: name });
    }
    return true;
  }

  private pushCommand(c: UiCommand): void {
    this.pendingCommands.push(Object.freeze(c));
    if (this.pendingCommands.length > UI_MAX_COMMANDS) this.pendingCommands.splice(0, this.pendingCommands.length - UI_MAX_COMMANDS);
  }

  /**
   * A sampled frame's UI entries: show/hide/toggle apply to the stack now
   * (before scripts run); every entry is this step's events for scripts.
   */
  deliver(events: readonly UiEventRecord[] | undefined): void {
    if (events === undefined || events.length === 0) {
      if (this.stepEvents.length > 0) this.stepEvents = Object.freeze([]);
      return;
    }
    for (const e of events) {
      if (e.kind === 'show') this.show(e.doc);
      else if (e.kind === 'hide') this.hide(e.doc);
      else if (e.kind === 'toggle') {
        if (this.isShown(e.doc)) this.hide(e.doc);
        else this.show(e.doc);
      }
    }
    this.stepEvents = events;
  }

  /** This step's UI events (from its input frame). */
  events(): readonly UiEventRecord[] {
    return this.stepEvents;
  }

  /** A new run (start, replay): an empty view model, nothing shown. */
  resetRun(): void {
    this.model = Object.freeze({});
    this.sizes.clear();
    this.total = 0;
    this.shownList = [];
    this.pendingSet = new Map();
    this.pendingCommands = [];
    this.pendingReset = true;
    this.stepEvents = Object.freeze([]);
    this.shownChanged();
  }

  /** The changes since the host last took them (null: none). */
  takeOutput(): UiOutput | null {
    if (!this.pendingReset && this.pendingSet.size === 0 && !this.pendingShown && this.pendingCommands.length === 0) return null;
    const out: UiOutput = {
      ...(this.pendingReset ? { reset: true as const } : {}),
      set: [...this.pendingSet.values()],
      ...(this.pendingShown || this.pendingReset ? { shown: this.shown() } : {}),
      commands: this.pendingCommands,
    };
    this.pendingReset = false;
    this.pendingSet = new Map();
    this.pendingShown = false;
    this.pendingCommands = [];
    return out;
  }

  /** The committed view model and shown documents. */
  view(): UiStateView {
    if (this.viewCache === null) this.viewCache = Object.freeze({ model: this.model, shown: this.shown() });
    return this.viewCache;
  }
}

/** A copy of `node` with `value` written at `segs` (undefined: the path crosses a value that is not an object/list). */
function writeUnder(node: unknown, segs: readonly string[], value: unknown): unknown {
  const [head, ...rest] = segs as [string, ...string[]];
  if (Array.isArray(node)) {
    if (!/^\d+$/.test(head)) return undefined;
    const i = Number(head);
    if (i > node.length || i >= UI_VALUE_MAX_ITEMS) return undefined;
    const child = rest.length === 0 ? value : writeUnder(node[i], rest, value);
    if (child === undefined) return undefined;
    const out = node.slice();
    out[i] = child;
    return Object.freeze(out);
  }
  if (node === undefined || node === null || isPlainObject(node)) {
    const base = isPlainObject(node) ? node : {};
    if (!hasOwn.call(base, head) && Object.keys(base).length >= UI_VALUE_MAX_KEYS) return undefined;
    const child = rest.length === 0 ? value : writeUnder(base[head], rest, value);
    if (child === undefined) return undefined;
    return Object.freeze({ ...base, [head]: child });
  }
  return undefined;
}

/** A copy of `node` without the value at `segs` (a list item is removed; the ones after it move up). */
function removeUnder(node: unknown, segs: readonly string[]): unknown {
  const [head, ...rest] = segs as [string, ...string[]];
  if (Array.isArray(node)) {
    const i = Number(head);
    const out = node.slice();
    if (rest.length === 0) out.splice(i, 1);
    else out[i] = removeUnder(node[i], rest);
    return Object.freeze(out);
  }
  if (isPlainObject(node)) {
    const out = { ...node };
    if (rest.length === 0) delete out[head];
    else out[head] = removeUnder(node[head], rest);
    return Object.freeze(out);
  }
  return node;
}

/** Apply a host-side output to a plain view model copy (the host's mirror of the scripts' values). */
export function applyUiOutputToModel(model: Record<string, unknown>, out: UiOutput): Record<string, unknown> {
  let m = out.reset === true ? {} : model;
  for (const e of out.set) {
    const segs = uiPathSegments(e[0]);
    if (segs === null) continue;
    const top = segs[0]!;
    if (e.length === 1) {
      if (segs.length === 1) {
        const n = { ...m };
        delete n[top];
        m = n;
      } else if (hasOwn.call(m, top)) m = { ...m, [top]: removeUnder(m[top], segs.slice(1)) };
    } else {
      const v = segs.length === 1 ? e[1] : writeUnder(m[top], segs.slice(1), e[1]);
      if (v !== undefined) m = { ...m, [top]: v };
    }
  }
  return m;
}
