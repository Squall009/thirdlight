/**
 * Phase 23.14: rebinding as data — pure functions over an input config.
 *
 * - `resolveTarget`: which binding (index, part) a rebind addresses.
 * - `bindingFrom`: the binding a captured input makes for a target (or why it
 *   does not fit the action).
 * - `findConflicts`: other actions of the same map already using the input.
 * - `applyRebind`: put the new binding in place under a conflict policy —
 *   `swap` (the other action takes the input this slot had), `refuse`, or
 *   `allow` (both keep it).
 * - `resetBindings`, `overridesOf` / `applyOverrides`: the player's changes
 *   against the project's bindings (what is saved per player profile).
 *
 * No DOM, no input owner.
 */
import type { InputBindingConflict, InputBindingPart, InputDeviceKind, RebindConflictPolicy } from '@thirdlight/runtime';

import { bindingDevice } from './glyphs';

export type BindingData = { readonly kind: string } & Readonly<Record<string, unknown>>;
export interface ActionData {
  readonly name: string;
  readonly type: string;
  readonly map: string;
  readonly bindings: readonly unknown[];
  readonly [k: string]: unknown;
}
export interface ConfigData {
  readonly actions: readonly ActionData[];
  readonly cursor?: { readonly [map: string]: 'free' | 'locked' | undefined };
  readonly glyphs?: Readonly<Record<string, string>>;
}

/** What a rebind heard (the input owner's `captureInput`). */
export type Captured =
  | { readonly device: 'keyboard'; readonly code: string }
  | { readonly device: 'mouse'; readonly button: 'left' | 'right' | 'middle' }
  | { readonly device: 'mouse'; readonly wheel: 1 | -1 }
  | { readonly device: 'gamepad'; readonly button: number }
  | { readonly device: 'gamepad'; readonly axis: number; readonly sign: 1 | -1 };

export interface RebindTarget {
  readonly action: string;
  readonly index: number;
  readonly part?: InputBindingPart;
  /** The device group listened to. */
  readonly device: InputDeviceKind;
}

export const MAX_BINDINGS = 8;
const CODE_RE = /^[A-Za-z0-9]{1,32}$/;
const COMPOSITE_PARTS: Readonly<Record<string, readonly InputBindingPart[]>> = {
  keys1d: ['negative', 'positive'],
  gamepadButtons1d: ['negative', 'positive'],
  keys2d: ['up', 'down', 'left', 'right'],
};
const HOLDABLE = new Set(['key', 'gamepadButton', 'pointerButton']);
/** Which bindings fit which action type (project-model's rule). */
const FITS: Readonly<Record<string, readonly string[]>> = {
  button: ['key', 'gamepadButton', 'pointerButton'],
  axis1d: ['keys1d', 'gamepadButtons1d', 'gamepadAxis', 'key', 'gamepadButton', 'pointerAxis', 'pointerButton'],
  axis2d: ['keys2d', 'gamepadStick', 'pointerPosition', 'pointerDelta'],
};

const asBinding = (b: unknown): BindingData | null => (typeof b === 'object' && b !== null && typeof (b as { kind?: unknown }).kind === 'string' ? (b as BindingData) : null);

/** The parts of a composite binding kind (empty for a single input). */
export function partsOf(kind: string): readonly InputBindingPart[] {
  return COMPOSITE_PARTS[kind] ?? [];
}

const inGroup = (kind: string, group: InputDeviceKind): boolean => (group === 'gamepad' ? bindingDevice(kind) === 'gamepad' : bindingDevice(kind) !== 'gamepad');

/** The device group a binding belongs to. */
export function groupOf(kind: string): InputDeviceKind {
  return bindingDevice(kind) === 'gamepad' ? 'gamepad' : 'keyboardMouse';
}

/**
 * Which binding a rebind addresses: the given index (or the next free slot to
 * add one), else the action's first binding of the device group, else a new
 * binding at the end. A composite needs a part (the first part when none is
 * given). Null (with the reason) when the action or index does not exist.
 */
export function resolveTarget(config: ConfigData, action: string, options: { index?: number; part?: InputBindingPart; device?: InputDeviceKind }, fallbackDevice: InputDeviceKind): { ok: true; target: RebindTarget } | { ok: false; reason: string } {
  const a = config.actions.find((x) => x.name === action);
  if (a === undefined) return { ok: false, reason: `no action "${action}"` };
  let index: number;
  let group: InputDeviceKind;
  if (options.index !== undefined) {
    if (options.index > a.bindings.length || options.index >= MAX_BINDINGS) return { ok: false, reason: `"${action}" has no binding ${options.index}` };
    index = options.index;
    const b = asBinding(a.bindings[index]);
    group = b !== null ? groupOf(b.kind) : (options.device ?? fallbackDevice);
  } else {
    group = options.device ?? fallbackDevice;
    const found = a.bindings.findIndex((b) => {
      const d = asBinding(b);
      return d !== null && inGroup(d.kind, group);
    });
    if (found >= 0) index = found;
    else if (a.bindings.length < MAX_BINDINGS) index = a.bindings.length;
    else return { ok: false, reason: `"${action}" has ${MAX_BINDINGS} bindings already` };
  }
  const b = asBinding(a.bindings[index]);
  const parts = b !== null ? partsOf(b.kind) : [];
  let part: InputBindingPart | undefined;
  if (parts.length > 0) {
    part = options.part !== undefined && parts.includes(options.part) ? options.part : parts[0];
    if (options.part !== undefined && !parts.includes(options.part)) return { ok: false, reason: `a ${b!.kind} binding has no part "${options.part}"` };
  }
  return { ok: true, target: { action, index, ...(part !== undefined ? { part } : {}), device: group } };
}

/** The physical input ids a binding uses (with the part for a composite). */
export function inputIds(b: BindingData): { id: string; part?: InputBindingPart }[] {
  switch (b.kind) {
    case 'key':
      return [{ id: `key:${String(b['code'])}` }];
    case 'gamepadButton':
      return [{ id: `pad:${Number(b['button'])}` }];
    case 'gamepadAxis':
      return [{ id: `axis:${Number(b['axis'])}` }];
    case 'gamepadStick':
      return [{ id: `axis:${Number(b['x'])}` }, { id: `axis:${Number(b['y'])}` }];
    case 'keys1d':
      return [{ id: `key:${String(b['negative'])}`, part: 'negative' }, { id: `key:${String(b['positive'])}`, part: 'positive' }];
    case 'keys2d':
      return (['up', 'down', 'left', 'right'] as const).map((p) => ({ id: `key:${String(b[p])}`, part: p }));
    case 'gamepadButtons1d':
      return [{ id: `pad:${Number(b['negative'])}`, part: 'negative' }, { id: `pad:${Number(b['positive'])}`, part: 'positive' }];
    case 'pointerButton':
      return [{ id: `mouse:${String(b['button'])}` }];
    case 'pointerAxis':
      return [{ id: `mouseaxis:${String(b['axis'])}` }];
    case 'pointerDelta':
      return [{ id: 'mouseaxis:x' }, { id: 'mouseaxis:y' }];
    default:
      return [];
  }
}

/** The physical input id of a captured input. */
export function capturedId(c: Captured): string {
  if (c.device === 'keyboard') return `key:${c.code}`;
  if (c.device === 'mouse') return 'button' in c ? `mouse:${c.button}` : 'mouseaxis:wheel';
  return 'button' in c ? `pad:${c.button}` : `axis:${c.axis}`;
}

/** The input id a target slot holds now (null: an empty slot). */
function slotId(config: ConfigData, target: RebindTarget): string | null {
  const a = config.actions.find((x) => x.name === target.action);
  const b = asBinding(a?.bindings[target.index]);
  if (b === null) return null;
  const ids = inputIds(b);
  return (target.part !== undefined ? ids.find((i) => i.part === target.part) : ids[0])?.id ?? null;
}

const keepHold = (old: BindingData | null, next: Record<string, unknown>): Record<string, unknown> => (old !== null && HOLDABLE.has(old.kind) && HOLDABLE.has(next['kind'] as string) && typeof old['hold'] === 'number' ? { ...next, hold: old['hold'] } : next);

/**
 * The binding a captured input makes at a target: a part of a composite, or
 * the single binding that fits the action type (a key or pad button makes a
 * button binding — on an axis its positive direction; a pad axis makes a 1D
 * axis or, for a 2D axis, the stick it belongs to; the wheel a 1D axis).
 */
export function bindingFrom(config: ConfigData, target: RebindTarget, c: Captured): { ok: true; binding: BindingData } | { ok: false; reason: string } {
  const a = config.actions.find((x) => x.name === target.action);
  if (a === undefined) return { ok: false, reason: `no action "${target.action}"` };
  const old = asBinding(a.bindings[target.index]);
  const fits = FITS[a.type] ?? [];
  if (old !== null && target.part !== undefined && partsOf(old.kind).includes(target.part)) {
    const keys = old.kind === 'keys1d' || old.kind === 'keys2d';
    if (keys && c.device === 'keyboard') return { ok: true, binding: { ...old, [target.part]: c.code } };
    if (!keys && c.device === 'gamepad' && 'button' in c) return { ok: true, binding: { ...old, [target.part]: c.button } };
    return { ok: false, reason: keys ? 'this part takes a key' : 'this part takes a gamepad button' };
  }
  let next: Record<string, unknown> | null = null;
  if (c.device === 'keyboard') next = CODE_RE.test(c.code) ? { kind: 'key', code: c.code } : null;
  else if (c.device === 'gamepad' && 'button' in c) next = { kind: 'gamepadButton', button: c.button };
  else if (c.device === 'gamepad') next = a.type === 'axis2d' ? { kind: 'gamepadStick', x: c.axis - (c.axis % 2), y: c.axis - (c.axis % 2) + 1 } : { kind: 'gamepadAxis', axis: c.axis };
  else if ('button' in c) next = { kind: 'pointerButton', button: c.button };
  else next = { kind: 'pointerAxis', axis: 'wheel' };
  if (next === null || !fits.includes(next['kind'] as string)) return { ok: false, reason: `a ${String(next?.['kind'] ?? 'this')} binding does not fit a ${a.type} action` };
  return { ok: true, binding: keepHold(old, next) as BindingData };
}

/** Other actions of the target's map whose bindings use the captured input. */
export function findConflicts(config: ConfigData, target: RebindTarget, c: Captured): InputBindingConflict[] {
  const a = config.actions.find((x) => x.name === target.action);
  if (a === undefined) return [];
  const id = capturedId(c);
  const out: InputBindingConflict[] = [];
  for (const other of config.actions) {
    if (other.name === a.name || other.map !== a.map) continue;
    other.bindings.forEach((raw, index) => {
      const b = asBinding(raw);
      if (b === null) return;
      for (const i of inputIds(b)) if (i.id === id && out.length < 8) out.push({ action: other.name, index, ...(i.part !== undefined ? { part: i.part } : {}) });
    });
  }
  return out;
}

/** Replace the input `id` in a binding with `replacement` (same input class), or null when it cannot. */
function swapInto(b: BindingData, conflict: InputBindingConflict, replacement: string | null): BindingData | null | 'remove' {
  if (replacement === null) return partsOf(b.kind).length > 0 ? null : 'remove';
  const [cls, value] = [replacement.slice(0, replacement.indexOf(':')), replacement.slice(replacement.indexOf(':') + 1)];
  if (conflict.part !== undefined) {
    if ((b.kind === 'keys1d' || b.kind === 'keys2d') && cls === 'key') return { ...b, [conflict.part]: value };
    if (b.kind === 'gamepadButtons1d' && cls === 'pad') return { ...b, [conflict.part]: Number(value) };
    return null;
  }
  if (b.kind === 'key' && cls === 'key') return { ...b, code: value };
  if (b.kind === 'gamepadButton' && cls === 'pad') return { ...b, button: Number(value) };
  if (b.kind === 'pointerButton' && cls === 'mouse' && ['left', 'right', 'middle'].includes(value)) return { ...b, button: value };
  if (b.kind === 'gamepadAxis' && cls === 'axis') return { ...b, axis: Number(value) };
  return null;
}

export type RebindResult =
  | { readonly ok: true; readonly config: ConfigData; readonly binding: BindingData; readonly conflicts: readonly InputBindingConflict[]; readonly swapped: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly conflicts?: readonly InputBindingConflict[] };

/**
 * Put a captured input at a target under a conflict policy. `swap`: each
 * conflicting binding takes the input the target slot had (a single binding
 * with nothing to take is removed; a composite part that cannot take it keeps
 * the input and is reported); `refuse`: nothing changes; `allow`: both keep it.
 */
export function applyRebind(config: ConfigData, target: RebindTarget, c: Captured, policy: RebindConflictPolicy): RebindResult {
  const made = bindingFrom(config, target, c);
  if (!made.ok) return made;
  const conflicts = findConflicts(config, target, c);
  if (conflicts.length > 0 && policy === 'refuse') return { ok: false, reason: 'the input is used by another action', conflicts };
  const previous = slotId(config, target);
  const swapped: string[] = [];
  const left: InputBindingConflict[] = [];
  let actions = config.actions.map((a) => {
    if (a.name !== target.action) return a;
    const bindings = [...a.bindings];
    bindings[target.index] = made.binding;
    return { ...a, bindings };
  });
  if (policy === 'swap' && conflicts.length > 0) {
    actions = actions.map((a) => {
      const mine = conflicts.filter((x) => x.action === a.name);
      if (mine.length === 0) return a;
      let bindings: (unknown | null)[] = [...a.bindings];
      for (const x of mine) {
        const b = asBinding(bindings[x.index]);
        if (b === null) continue;
        const r = swapInto(b, x, previous === capturedId(c) ? null : previous);
        if (r === null) left.push(x);
        else {
          bindings[x.index] = r === 'remove' ? null : r;
          if (!swapped.includes(a.name)) swapped.push(a.name);
        }
      }
      bindings = bindings.filter((b) => b !== null);
      return { ...a, bindings };
    });
  } else left.push(...conflicts);
  return { ok: true, config: { ...config, actions }, binding: made.binding, conflicts: left, swapped };
}

/** One action's bindings (or every action's, without a name) back to the project's. */
export function resetBindings(config: ConfigData, defaults: ConfigData, action?: string): ConfigData {
  return {
    ...config,
    actions: config.actions.map((a) => {
      if (action !== undefined && a.name !== action) return a;
      const d = defaults.actions.find((x) => x.name === a.name);
      return d === undefined ? a : { ...a, bindings: d.bindings };
    }),
  };
}

/** The player's changes: the bindings of every action that differs from the project's. */
export function overridesOf(config: ConfigData, defaults: ConfigData): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const a of config.actions) {
    const d = defaults.actions.find((x) => x.name === a.name);
    if (d !== undefined && JSON.stringify(d.bindings) !== JSON.stringify(a.bindings)) out[a.name] = JSON.parse(JSON.stringify(a.bindings)) as unknown[];
  }
  return out;
}

/** A binding is well formed and fits the action type (the project-model rules, re-checked for saved data). */
export function validBinding(raw: unknown, type: string): boolean {
  const b = asBinding(raw);
  if (b === null || !(FITS[type] ?? []).includes(b.kind)) return false;
  const code = (v: unknown): boolean => typeof v === 'string' && CODE_RE.test(v);
  const idx = (v: unknown, max: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
  const fields: Record<string, (o: BindingData) => boolean> = {
    key: (o) => code(o['code']),
    gamepadButton: (o) => idx(o['button'], 31),
    gamepadAxis: (o) => idx(o['axis'], 7),
    gamepadStick: (o) => idx(o['x'], 7) && idx(o['y'], 7),
    keys1d: (o) => code(o['negative']) && code(o['positive']),
    keys2d: (o) => code(o['up']) && code(o['down']) && code(o['left']) && code(o['right']),
    gamepadButtons1d: (o) => idx(o['negative'], 31) && idx(o['positive'], 31),
    pointerButton: (o) => ['left', 'right', 'middle'].includes(o['button'] as string),
    pointerAxis: (o) => ['x', 'y', 'wheel'].includes(o['axis'] as string),
    pointerPosition: () => true,
    pointerDelta: () => true,
  };
  const ok = fields[b.kind]?.(b) ?? false;
  const hold = b['hold'];
  return ok && (hold === undefined || (HOLDABLE.has(b.kind) && typeof hold === 'number' && hold >= 0.05 && hold <= 10));
}

/** Saved changes applied over the project's bindings (an unknown action, or one whose saved bindings do not fit it, keeps the project's). */
export function applyOverrides(defaults: ConfigData, overrides: Readonly<Record<string, unknown>> | null): ConfigData {
  if (overrides === null) return defaults;
  let changed = false;
  const actions = defaults.actions.map((a) => {
    const o = overrides[a.name];
    if (!Array.isArray(o) || o.length > MAX_BINDINGS || !o.every((b) => validBinding(b, a.type))) return a;
    changed = true;
    return { ...a, bindings: o };
  });
  return changed ? { ...defaults, actions } : defaults;
}
