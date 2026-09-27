/**
 * Phase 23.14: the player's bindings, the device in use and rebinding, as the
 * simulation sees them.
 *
 * Rebinding happens on the host (the page captures raw input and applies the
 * new binding set to the input owner); the simulation only ever sees action
 * values, so a recorded replay stays valid across a rebind. What scripts may
 * read about bindings — the device used last, every action's bindings with
 * their display glyphs, and the results of the rebinds they asked for —
 * arrives as an optional input-frame entry (`ActionFrame.input`), sent by the
 * host only when something changed. It is part of the recorded input, so a
 * replay shows a script exactly what it saw live. The runtime keeps the last
 * device and binding list it was sent (input state, not simulation state: not
 * in the step digest, not reset by a new run).
 *
 * Requests go the other way: `ctx.input.rebind(...)`, `cancelRebind()`,
 * `resetBindings()`, `useBindingProfile()` queue (at most 8 a step) and the
 * host takes them after the frame (`Runtime.takeBindingRequests`); their
 * outcome comes back as frame events.
 */

/** The device the player used last: keyboard and mouse are one device. */
export type InputDeviceKind = 'keyboardMouse' | 'gamepad';
/** The gamepad families glyphs distinguish (from the pad's id; `generic` when unknown). */
export type GamepadFamily = 'xbox' | 'playstation' | 'switch' | 'generic';
/** Where a binding comes from. */
export type InputBindingDevice = 'keyboard' | 'mouse' | 'gamepad';
/** A composite binding's part (two keys/buttons: negative, positive; four keys: up, down, left, right). */
export type InputBindingPart = 'negative' | 'positive' | 'up' | 'down' | 'left' | 'right';
/** What happens when a new binding's input is already used by another action of the same map. */
export type RebindConflictPolicy = 'swap' | 'refuse' | 'allow';

/** The device the player used last (a key, the mouse, or a gamepad button or stick). */
export interface InputDeviceStatus {
  readonly kind: InputDeviceKind;
  /** The gamepad's id as the browser reports it (clipped to 64 characters); absent for the keyboard and mouse. */
  readonly id?: string;
  /** The gamepad family (absent for the keyboard and mouse). */
  readonly family?: GamepadFamily;
}

/** One part of a composite binding's glyph. */
export interface InputGlyphPart {
  readonly part: InputBindingPart;
  readonly label: string;
  readonly icon: string;
  /** The project's own image (a texture asset id), when it overrides the icon. */
  readonly image?: string;
}

/**
 * What to show for a binding: a label a player reads ("Space", "A", "Cross",
 * "Left button"), an icon id of the engine's generic glyph set (`key`,
 * `pad-south`, `mouse-left`, …) and the project's own image when it has one.
 * A composite binding (two or four keys) also lists its parts.
 */
export interface InputGlyph {
  readonly label: string;
  readonly icon: string;
  readonly image?: string;
  readonly parts?: readonly InputGlyphPart[];
}

/** One binding of an action as scripts see it (its position in `bindings` is the index rebinding addresses). */
export interface InputBindingStatus extends InputGlyph {
  readonly device: InputBindingDevice;
  /** The binding kind (key, gamepadButton, keys1d, pointerButton, …). */
  readonly kind: string;
  /** Hold instead of tap: seconds the binding must be held. */
  readonly hold?: number;
}

/** One project action with the player's current bindings. */
export interface InputActionStatus {
  readonly name: string;
  readonly type: 'button' | 'axis1d' | 'axis2d';
  readonly map: 'gameplay' | 'ui';
  readonly bindings: readonly InputBindingStatus[];
  /** The player changed this action's bindings (they differ from the project's). */
  readonly changed?: boolean;
}

/** A rebind's target: an action, which of its bindings and (composites) which part. */
export interface InputRebindTarget {
  readonly action: string;
  readonly index: number;
  readonly part?: InputBindingPart;
}

/** An action binding that uses the same input as a new binding. */
export interface InputBindingConflict {
  readonly action: string;
  readonly index: number;
  readonly part?: InputBindingPart;
}

/**
 * What became of a binding request: a rebind `started` (listening),
 * `rebound`, `cancelled` (the cancel key), `timeout`, `refused` (it does not
 * fit the action, or it conflicts under the refuse policy — `conflicts` says
 * with what), `reset`, or the player `profile` changed.
 */
export interface InputRebindEvent {
  readonly type: 'started' | 'rebound' | 'cancelled' | 'timeout' | 'refused' | 'reset' | 'profile';
  readonly action?: string;
  readonly index?: number;
  readonly part?: InputBindingPart;
  /** The new binding's label (rebound). */
  readonly label?: string;
  readonly reason?: string;
  readonly conflicts?: readonly InputBindingConflict[];
  /** The bindings of these actions moved to make room (swap policy). */
  readonly swapped?: readonly string[];
  readonly profile?: string;
}

/** Phase 23.14: the frame entry (every field optional; sent when it changed). */
export interface InputStatusEntry {
  readonly device?: InputDeviceStatus;
  readonly actions?: readonly InputActionStatus[];
  readonly events?: readonly InputRebindEvent[];
  /** The player profile whose bindings are in effect. */
  readonly profile?: string;
}

/** Options of a listen-for-input rebind (`ctx.input.rebind`). */
export interface InputRebindOptions {
  /** Which of the action's bindings (its index in `bindings()`); absent: the first one of the device. */
  readonly index?: number;
  /** A composite binding's part (negative/positive, up/down/left/right). */
  readonly part?: InputBindingPart;
  /** The device to listen to (absent: the device used last). Keyboard and mouse listen together. */
  readonly device?: InputDeviceKind;
  /** When the input is already used in the same map: swap (default), refuse or allow. */
  readonly policy?: RebindConflictPolicy;
  /** The key that cancels listening (a KeyboardEvent.code; default Escape). */
  readonly cancelKey?: string;
  /** Seconds to listen before giving up (default 10; 1–60). */
  readonly timeout?: number;
}

/** A binding request a script queued (the host takes them after the frame). */
export type InputBindingRequest =
  | { readonly op: 'rebind'; readonly action: string; readonly options: InputRebindOptions }
  | { readonly op: 'cancel' }
  | { readonly op: 'reset'; readonly action?: string }
  | { readonly op: 'profile'; readonly profile: string };

/** Engine limits: binding requests a step (all scripts), events a frame. */
export const MAX_BINDING_REQUESTS = 8;
export const MAX_FRAME_INPUT_EVENTS = 8;
const MAX_ACTIONS = 64;
const MAX_BINDINGS = 8;
const MAX_TEXT = 64;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const ICON_RE = /^[a-z][a-z0-9-]{0,47}$/;
const PROFILE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const CODE_RE = /^[A-Za-z0-9]{1,32}$/;
const PARTS: readonly string[] = ['negative', 'positive', 'up', 'down', 'left', 'right'];
const FAMILIES: readonly string[] = ['xbox', 'playstation', 'switch', 'generic'];
const EVENT_TYPES: readonly string[] = ['started', 'rebound', 'cancelled', 'timeout', 'refused', 'reset', 'profile'];

type Fail = { ok: false; field: string; message: string };
const hasOwn = Object.prototype.hasOwnProperty;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT;
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[], at: string): Fail | null => {
  for (const k in o) if (hasOwn.call(o, k) && !keys.includes(k)) return { ok: false, field: `${at}/${k}`, message: `unknown field "${k}"` };
  return null;
};

function glyphFields(o: Record<string, unknown>, at: string): Fail | null {
  if (!text(o['label'])) return { ok: false, field: `${at}/label`, message: `a glyph label is text of at most ${MAX_TEXT} characters` };
  if (typeof o['icon'] !== 'string' || !ICON_RE.test(o['icon'])) return { ok: false, field: `${at}/icon`, message: 'a glyph icon is an icon id (lower-case letters, digits and -)' };
  if (o['image'] !== undefined && !(typeof o['image'] === 'string' && o['image'].length > 0 && o['image'].length <= 128)) return { ok: false, field: `${at}/image`, message: 'a glyph image is a texture asset id' };
  return null;
}

function checkDevice(d: unknown): Fail | null {
  if (!isObj(d)) return { ok: false, field: 'input/device', message: 'device is { kind: keyboardMouse | gamepad, id?, family? }' };
  const k = onlyKeys(d, ['kind', 'id', 'family'], 'input/device');
  if (k !== null) return k;
  if (d['kind'] !== 'keyboardMouse' && d['kind'] !== 'gamepad') return { ok: false, field: 'input/device/kind', message: 'device kind is keyboardMouse or gamepad' };
  if (d['id'] !== undefined && !text(d['id'])) return { ok: false, field: 'input/device/id', message: `a device id is text of at most ${MAX_TEXT} characters` };
  if (d['family'] !== undefined && !FAMILIES.includes(d['family'] as string)) return { ok: false, field: 'input/device/family', message: 'family is xbox, playstation, switch or generic' };
  return null;
}

function checkAction(a: unknown, at: string): Fail | null {
  if (!isObj(a)) return { ok: false, field: at, message: 'an action is { name, type, map, bindings, changed? }' };
  const k = onlyKeys(a, ['name', 'type', 'map', 'bindings', 'changed'], at);
  if (k !== null) return k;
  if (typeof a['name'] !== 'string' || !NAME_RE.test(a['name'])) return { ok: false, field: `${at}/name`, message: 'an action name' };
  if (a['type'] !== 'button' && a['type'] !== 'axis1d' && a['type'] !== 'axis2d') return { ok: false, field: `${at}/type`, message: 'type is button, axis1d or axis2d' };
  if (a['map'] !== 'gameplay' && a['map'] !== 'ui') return { ok: false, field: `${at}/map`, message: 'map is gameplay or ui' };
  if (a['changed'] !== undefined && typeof a['changed'] !== 'boolean') return { ok: false, field: `${at}/changed`, message: 'changed is true or false' };
  const bs = a['bindings'];
  if (!Array.isArray(bs) || bs.length > MAX_BINDINGS) return { ok: false, field: `${at}/bindings`, message: `bindings is a list of at most ${MAX_BINDINGS}` };
  for (let j = 0; j < bs.length; j += 1) {
    const b = bs[j];
    const bp = `${at}/bindings/${j}`;
    if (!isObj(b)) return { ok: false, field: bp, message: 'a binding is { device, kind, label, icon, image?, parts?, hold? }' };
    const bk = onlyKeys(b, ['device', 'kind', 'label', 'icon', 'image', 'parts', 'hold'], bp);
    if (bk !== null) return bk;
    if (b['device'] !== 'keyboard' && b['device'] !== 'mouse' && b['device'] !== 'gamepad') return { ok: false, field: `${bp}/device`, message: 'device is keyboard, mouse or gamepad' };
    if (typeof b['kind'] !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(b['kind'])) return { ok: false, field: `${bp}/kind`, message: 'a binding kind' };
    const g = glyphFields(b, bp);
    if (g !== null) return g;
    if (b['hold'] !== undefined && !(typeof b['hold'] === 'number' && Number.isFinite(b['hold']) && b['hold'] > 0 && b['hold'] <= 10)) return { ok: false, field: `${bp}/hold`, message: 'hold is seconds in (0, 10]' };
    const parts = b['parts'];
    if (parts !== undefined) {
      if (!Array.isArray(parts) || parts.length > 4) return { ok: false, field: `${bp}/parts`, message: 'parts is a list of at most 4' };
      for (let p = 0; p < parts.length; p += 1) {
        const q = parts[p];
        const pp = `${bp}/parts/${p}`;
        if (!isObj(q)) return { ok: false, field: pp, message: 'a part is { part, label, icon, image? }' };
        const pk = onlyKeys(q, ['part', 'label', 'icon', 'image'], pp);
        if (pk !== null) return pk;
        if (!PARTS.includes(q['part'] as string)) return { ok: false, field: `${pp}/part`, message: 'part is negative, positive, up, down, left or right' };
        const pg = glyphFields(q, pp);
        if (pg !== null) return pg;
      }
    }
  }
  return null;
}

function checkEvent(e: unknown, at: string): Fail | null {
  if (!isObj(e)) return { ok: false, field: at, message: 'an event is { type, action?, index?, part?, label?, reason?, conflicts?, swapped?, profile? }' };
  const k = onlyKeys(e, ['type', 'action', 'index', 'part', 'label', 'reason', 'conflicts', 'swapped', 'profile'], at);
  if (k !== null) return k;
  if (!EVENT_TYPES.includes(e['type'] as string)) return { ok: false, field: `${at}/type`, message: 'type is started, rebound, cancelled, timeout, refused, reset or profile' };
  if (e['action'] !== undefined && !(typeof e['action'] === 'string' && NAME_RE.test(e['action']))) return { ok: false, field: `${at}/action`, message: 'an action name' };
  if (e['index'] !== undefined && !(Number.isInteger(e['index']) && (e['index'] as number) >= 0 && (e['index'] as number) < MAX_BINDINGS)) return { ok: false, field: `${at}/index`, message: `index is a binding index 0–${MAX_BINDINGS - 1}` };
  if (e['part'] !== undefined && !PARTS.includes(e['part'] as string)) return { ok: false, field: `${at}/part`, message: 'a binding part' };
  for (const f of ['label', 'reason'] as const) if (e[f] !== undefined && !(typeof e[f] === 'string' && (e[f] as string).length <= 160)) return { ok: false, field: `${at}/${f}`, message: `${f} is text of at most 160 characters` };
  if (e['profile'] !== undefined && !(typeof e['profile'] === 'string' && PROFILE_RE.test(e['profile']))) return { ok: false, field: `${at}/profile`, message: 'a profile name' };
  const cs = e['conflicts'];
  if (cs !== undefined) {
    if (!Array.isArray(cs) || cs.length > 8) return { ok: false, field: `${at}/conflicts`, message: 'conflicts is a list of at most 8' };
    for (let i = 0; i < cs.length; i += 1) {
      const c = cs[i];
      if (!isObj(c) || onlyKeys(c, ['action', 'index', 'part'], '') !== null || typeof c['action'] !== 'string' || !NAME_RE.test(c['action']) || !(Number.isInteger(c['index']) && (c['index'] as number) >= 0 && (c['index'] as number) < MAX_BINDINGS) || (c['part'] !== undefined && !PARTS.includes(c['part'] as string))) {
        return { ok: false, field: `${at}/conflicts/${i}`, message: 'a conflict is { action, index, part? }' };
      }
    }
  }
  const sw = e['swapped'];
  if (sw !== undefined && !(Array.isArray(sw) && sw.length <= 8 && sw.every((x) => typeof x === 'string' && NAME_RE.test(x)))) return { ok: false, field: `${at}/swapped`, message: 'swapped lists at most 8 action names' };
  return null;
}

const deepFreeze = <T>(v: T): T => {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
};

/** Phase 23.14: validate a frame's `input` entry strictly; returns a frozen copy. */
export function validateInputStatus(raw: unknown): { ok: true; input: InputStatusEntry } | Fail {
  if (!isObj(raw)) return { ok: false, field: 'input', message: 'input is { device?, actions?, events?, profile? }' };
  const k = onlyKeys(raw, ['device', 'actions', 'events', 'profile'], 'input');
  if (k !== null) return k;
  if (raw['device'] !== undefined) {
    const d = checkDevice(raw['device']);
    if (d !== null) return d;
  }
  const actions = raw['actions'];
  if (actions !== undefined) {
    if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) return { ok: false, field: 'input/actions', message: `actions is a list of at most ${MAX_ACTIONS}` };
    for (let i = 0; i < actions.length; i += 1) {
      const a = checkAction(actions[i], `input/actions/${i}`);
      if (a !== null) return a;
    }
  }
  const events = raw['events'];
  if (events !== undefined) {
    if (!Array.isArray(events) || events.length > MAX_FRAME_INPUT_EVENTS) return { ok: false, field: 'input/events', message: `events is a list of at most ${MAX_FRAME_INPUT_EVENTS}` };
    for (let i = 0; i < events.length; i += 1) {
      const e = checkEvent(events[i], `input/events/${i}`);
      if (e !== null) return e;
    }
  }
  if (raw['profile'] !== undefined && !(typeof raw['profile'] === 'string' && PROFILE_RE.test(raw['profile']))) return { ok: false, field: 'input/profile', message: 'a profile name is 1–32 letters, digits, _ or -' };
  return { ok: true, input: deepFreeze(structuredCloneJson(raw) as InputStatusEntry) };
}

/** A plain-data copy (the entry is JSON data by construction). */
function structuredCloneJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Phase 23.14: two entries with no step between them (the worker's tick
 * source): the newer device, list and profile; the events of both (the
 * newest 8).
 */
export function mergeInputStatus(a: InputStatusEntry | undefined, b: InputStatusEntry | undefined): InputStatusEntry | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const events = [...(a.events ?? []), ...(b.events ?? [])].slice(-MAX_FRAME_INPUT_EVENTS);
  const device = b.device ?? a.device;
  const actions = b.actions ?? a.actions;
  const profile = b.profile ?? a.profile;
  return { ...(device !== undefined ? { device } : {}), ...(actions !== undefined ? { actions } : {}), ...(events.length > 0 ? { events } : {}), ...(profile !== undefined ? { profile } : {}) };
}

const KEYBOARD_MOUSE: InputDeviceStatus = Object.freeze({ kind: 'keyboardMouse' });
const NO_ACTIONS: readonly InputActionStatus[] = Object.freeze([]);
const NO_EVENTS: readonly InputRebindEvent[] = Object.freeze([]);

/**
 * The glyph of an action for a device: its first binding from that device
 * (keyboard and mouse together), null when it has none.
 */
export function glyphOfAction(actions: readonly InputActionStatus[], action: string, device: InputDeviceKind): InputGlyph | null {
  const a = actions.find((x) => x.name === action);
  if (a === undefined) return null;
  const b = a.bindings.find((x) => (device === 'gamepad' ? x.device === 'gamepad' : x.device !== 'gamepad'));
  if (b === undefined) return null;
  return b;
}

/** The binding-status part of `ctx.input` (the runtime's side; `inputView` adds it). */
export interface InputStatusView {
  device(): InputDeviceStatus;
  actions(): readonly InputActionStatus[];
  events(): readonly InputRebindEvent[];
  rebinding(): InputRebindTarget | null;
  profile(): string;
  request(r: InputBindingRequest): void;
}

/** The runtime's copy of what the host last sent, this step's events and the queued requests. */
export class RuntimeInputStatus {
  private deviceNow: InputDeviceStatus = KEYBOARD_MOUSE;
  private actionsNow: readonly InputActionStatus[] = NO_ACTIONS;
  private eventsNow: readonly InputRebindEvent[] = NO_EVENTS;
  private listening: InputRebindTarget | null = null;
  private profileNow = 'default';
  private queue: InputBindingRequest[] = [];
  /** Requests dropped over the per-step limit since the last take (the host warns). */
  private dropped = 0;

  /** One sampled step's frame entry (absent: nothing changed, no events). */
  apply(entry: InputStatusEntry | undefined): void {
    if (entry === undefined) {
      this.eventsNow = NO_EVENTS;
      return;
    }
    if (entry.device !== undefined) this.deviceNow = entry.device;
    if (entry.actions !== undefined) this.actionsNow = entry.actions;
    if (entry.profile !== undefined) this.profileNow = entry.profile;
    this.eventsNow = entry.events ?? NO_EVENTS;
    for (const e of this.eventsNow) {
      if (e.type === 'started' && e.action !== undefined) this.listening = Object.freeze({ action: e.action, index: e.index ?? 0, ...(e.part !== undefined ? { part: e.part } : {}) });
      else if (e.type === 'rebound' || e.type === 'cancelled' || e.type === 'timeout' || e.type === 'refused' || e.type === 'reset' || e.type === 'profile') this.listening = null;
    }
  }

  /** Queue a request made this step (at most `MAX_BINDING_REQUESTS` wait; more are dropped). */
  push(r: InputBindingRequest): void {
    if (this.queue.length >= MAX_BINDING_REQUESTS) {
      this.dropped += 1;
      return;
    }
    this.queue.push(r);
  }

  /** The queued requests (and how many were dropped); the queue empties. */
  take(): { requests: readonly InputBindingRequest[]; dropped: number } {
    const out = { requests: this.queue, dropped: this.dropped };
    this.queue = [];
    this.dropped = 0;
    return out;
  }

  readonly view: InputStatusView = Object.freeze({
    device: (): InputDeviceStatus => this.deviceNow,
    actions: (): readonly InputActionStatus[] => this.actionsNow,
    events: (): readonly InputRebindEvent[] => this.eventsNow,
    rebinding: (): InputRebindTarget | null => this.listening,
    profile: (): string => this.profileNow,
    request: (r: InputBindingRequest): void => this.push(r),
  });
}

/** Check a script's rebind options (a script error names what is wrong). */
export function checkRebindOptions(action: unknown, options: unknown): InputRebindOptions {
  if (typeof action !== 'string' || !NAME_RE.test(action)) throw new Error(`rebind needs an action name (got ${JSON.stringify(String(action)).slice(0, 40)})`);
  if (options === undefined || options === null) return {};
  if (!isObj(options)) throw new Error('rebind options are { index?, part?, device?, policy?, cancelKey?, timeout? }');
  for (const k of Object.keys(options)) if (!['index', 'part', 'device', 'policy', 'cancelKey', 'timeout'].includes(k)) throw new Error(`unknown rebind option "${k.slice(0, 32)}"`);
  const o = options;
  if (o['index'] !== undefined && !(Number.isInteger(o['index']) && (o['index'] as number) >= 0 && (o['index'] as number) < MAX_BINDINGS)) throw new Error(`rebind index is a binding index 0–${MAX_BINDINGS - 1}`);
  if (o['part'] !== undefined && !PARTS.includes(o['part'] as string)) throw new Error('rebind part is negative, positive, up, down, left or right');
  if (o['device'] !== undefined && o['device'] !== 'keyboardMouse' && o['device'] !== 'gamepad') throw new Error('rebind device is keyboardMouse or gamepad');
  if (o['policy'] !== undefined && o['policy'] !== 'swap' && o['policy'] !== 'refuse' && o['policy'] !== 'allow') throw new Error('rebind policy is swap, refuse or allow');
  if (o['cancelKey'] !== undefined && !(typeof o['cancelKey'] === 'string' && CODE_RE.test(o['cancelKey']))) throw new Error('rebind cancelKey is a KeyboardEvent.code (e.g. Escape)');
  if (o['timeout'] !== undefined && !(typeof o['timeout'] === 'number' && Number.isFinite(o['timeout']) && o['timeout'] >= 1 && o['timeout'] <= 60)) throw new Error('rebind timeout is seconds in [1, 60]');
  const out: Record<string, unknown> = {};
  for (const k of ['index', 'part', 'device', 'policy', 'cancelKey', 'timeout']) if (o[k] !== undefined) out[k] = o[k];
  return Object.freeze(out) as InputRebindOptions;
}

/** A profile name (1–32 letters, digits, _ or -). */
export function isBindingProfile(v: unknown): v is string {
  return typeof v === 'string' && PROFILE_RE.test(v);
}

/** An action name (for `resetBindings`). */
export function isActionName(v: unknown): v is string {
  return typeof v === 'string' && NAME_RE.test(v);
}
