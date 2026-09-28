/**
 * Phase 23.14: the host's input-bindings controller — the one rebinding API
 * behind scripts (through the frame's input entry and their requests), the
 * built-in settings screen and project UI.
 *
 * It holds the player's effective bindings (the project's with the saved
 * changes of the current player profile), applies every change to the input
 * owner (`configure`), listens for input for a rebind (`captureInput`, with a
 * cancel key and a timeout), resolves conflicts by policy, resets, saves per
 * profile (the settings storage, keyed by the game's namespace) and follows
 * the device used last. What scripts may read goes into the next sampled
 * frame (`ActionFrame.input`) only when it changed; the simulation still sees
 * only action values, so a replay stays valid across a rebind.
 */
import type {
  GamepadFamily,
  InputActionStatus,
  InputBindingPart,
  InputBindingRequest,
  InputDeviceKind,
  InputDeviceStatus,
  InputGlyph,
  InputRebindEvent,
  InputRebindOptions,
  InputRebindTarget,
  InputStatusEntry,
  RebindConflictPolicy,
} from '@thirdlight/runtime';

import { bindingGlyph, gamepadFamily, glyphDataUrl, partGlyph } from './glyphs';
import { applyOverrides, applyRebind, findConflicts, overridesOf, resetBindings, resolveTarget, type Captured, type ConfigData, type RebindResult, type RebindTarget } from './input-bindings';
import type { SettingsStore } from './storage';

/** Defaults: listen 10 s (long enough to find a key, short enough that a forgotten listen ends); Escape cancels; swap keeps every action bound. */
export const REBIND_DEFAULT_TIMEOUT_S = 10;
export const REBIND_DEFAULT_CANCEL = 'Escape';
export const REBIND_DEFAULT_POLICY: RebindConflictPolicy = 'swap';
const PROFILE_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** The input-owner surface the controller uses (the browser owner has it all). */
export interface BindingsInputOwner {
  configure?(config: { actions: readonly { name: string; type: string; map: string; bindings: readonly unknown[] }[] }): void;
  captureInput?(options: { devices?: readonly ('keyboard' | 'mouse' | 'gamepad')[]; cancelKeys?: readonly string[] }, onInput: (input: Captured | null) => void): () => void;
  activeDevice?(): 'keyboard' | 'gamepad';
  activeDeviceInfo?(): { device: 'keyboard' | 'gamepad'; gamepadId: string | null };
  setFrameInput?(source: (() => InputStatusEntry | undefined) | null): void;
}

export interface BindingsControllerDeps {
  /** The project's input config (its bindings are the defaults). */
  readonly defaults: ConfigData;
  readonly input: BindingsInputOwner;
  readonly store?: SettingsStore;
  /** Milliseconds (timeouts). */
  readonly now?: () => number;
  /** The effective config changed (the host's input prompts follow). */
  readonly onChange?: (config: ConfigData) => void;
  /** A texture asset id → an image URL (the project's glyph images); null while it loads or when unknown. */
  readonly imageUrl?: (assetId: string) => string | null;
}

export interface ListenOptions extends InputRebindOptions {
  /** Called with the outcome (also sent to scripts as an event). */
  readonly onDone?: (event: InputRebindEvent) => void;
}

export interface InputBindingsController {
  /** The effective bindings (the project's with the player's changes). */
  config(): ConfigData;
  /** Every action with its bindings and glyphs for the current pad family. */
  actions(): readonly InputActionStatus[];
  /** The device used last. */
  device(): InputDeviceStatus;
  /** An action's glyph for a device (default: the device used last) — a binding's part when given. */
  glyph(action: string, device?: InputDeviceKind, target?: { index: number; part?: InputBindingPart }): InputGlyph | null;
  /** An image URL for a glyph: the project's image when it has one (and it loaded), else the generic SVG. */
  glyphImage(glyph: InputGlyph): string;
  /** Start listening for input for an action's binding. */
  listen(action: string, options?: ListenOptions): { ok: true; target: InputRebindTarget } | { ok: false; reason: string };
  /** Stop listening (a `cancelled` event). */
  cancel(): void;
  listening(): InputRebindTarget | null;
  /** Bind a captured input directly (no listening). */
  bind(action: string, input: Captured, options?: InputRebindOptions): RebindResult;
  /** The actions of the same map already using an input. */
  conflicts(action: string, input: Captured, options?: InputRebindOptions): ReturnType<typeof findConflicts>;
  /** One action (or all) back to the project's bindings. */
  reset(action?: string): void;
  profile(): string;
  useProfile(profile: string): boolean;
  /** Called after every change (bindings, device, listening). */
  subscribe(fn: () => void): () => void;
  /** Carry out scripts' requests (after a frame). */
  handle(requests: readonly InputBindingRequest[]): void;
  /** Per host frame: the timeout, the device used last. */
  tick(): void;
  /** What the next sampled frame carries (drained). */
  takeFrameEntry(): InputStatusEntry | undefined;
  /** Counts every change of what glyphs show (bindings, device, pad family). */
  revision(): number;
  /** The observation block. */
  observe(): { device: InputDeviceStatus; profile: string; listening: InputRebindTarget | null; changed: readonly string[]; glyphs: Readonly<Record<string, { label: string; icon: string }>> };
  dispose(): void;
}

const kindOf = (device: 'keyboard' | 'gamepad'): InputDeviceKind => (device === 'gamepad' ? 'gamepad' : 'keyboardMouse');

export function createInputBindings(deps: BindingsControllerDeps): InputBindingsController {
  const defaults = deps.defaults;
  const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let profile = 'default';
  let config: ConfigData = defaults;
  let family: GamepadFamily = 'generic';
  let device: InputDeviceStatus = { kind: 'keyboardMouse' };
  let statusCache: { config: ConfigData; family: GamepadFamily; list: InputActionStatus[] } | null = null;
  let listen: { target: RebindTarget; policy: RebindConflictPolicy; until: number; stop: () => void; onDone?: (e: InputRebindEvent) => void } | null = null;
  const subscribers = new Set<() => void>();
  // The first frame carries everything scripts may read.
  let pending: { device?: InputDeviceStatus; actions?: boolean; events: InputRebindEvent[]; profile?: string } = { device, actions: true, events: [], profile };
  let disposed = false;
  let rev = 0;

  const notify = (): void => {
    for (const f of [...subscribers]) {
      try {
        f();
      } catch {
        /* a subscriber's error stays its own */
      }
    }
  };
  const loadProfile = (): ConfigData => {
    const saved = deps.store?.readBindings(profile) ?? null;
    return saved !== null ? applyOverrides(defaults, saved) : defaults;
  };
  const apply = (next: ConfigData, save: boolean): void => {
    config = next;
    rev += 1;
    deps.input.configure?.(next as never);
    deps.onChange?.(next);
    if (save) deps.store?.writeBindings(profile, overridesOf(next, defaults));
    pending.actions = true;
  };
  const event = (e: InputRebindEvent): void => {
    pending.events.push(e);
    if (pending.events.length > 8) pending.events.splice(0, pending.events.length - 8);
  };
  const readDevice = (): void => {
    const info = deps.input.activeDeviceInfo?.() ?? { device: deps.input.activeDevice?.() ?? 'keyboard', gamepadId: null };
    const kind = kindOf(info.device);
    const fam = info.gamepadId !== null ? gamepadFamily(info.gamepadId) : family;
    const next: InputDeviceStatus = kind === 'gamepad' ? { kind, ...(info.gamepadId !== null ? { id: info.gamepadId.slice(0, 64) } : {}), family: fam } : { kind };
    if (fam !== family) {
      family = fam;
      rev += 1;
      pending.actions = true;
    }
    if (next.kind !== device.kind || next.id !== device.id || next.family !== device.family) {
      device = next;
      rev += 1;
      pending.device = next;
      notify();
    }
  };

  const status = (): InputActionStatus[] => {
    if (statusCache !== null && statusCache.config === config && statusCache.family === family) return statusCache.list;
    const list: InputActionStatus[] = config.actions.map((a) => {
      const d = defaults.actions.find((x) => x.name === a.name);
      const changed = d !== undefined && JSON.stringify(d.bindings) !== JSON.stringify(a.bindings);
      return {
        name: a.name,
        type: a.type as InputActionStatus['type'],
        map: a.map as InputActionStatus['map'],
        bindings: a.bindings.map((b) => bindingGlyph(b as never, family, config.glyphs ?? defaults.glyphs)),
        ...(changed ? { changed: true } : {}),
      };
    });
    statusCache = { config, family, list };
    return list;
  };

  const finish = (e: InputRebindEvent): void => {
    const l = listen;
    listen = null;
    event(e);
    l?.onDone?.(e);
    notify();
  };

  const bindAt = (target: RebindTarget, input: Captured, policy: RebindConflictPolicy): RebindResult => {
    const r = applyRebind(config, target, input, policy);
    if (r.ok) apply(r.config, true);
    return r;
  };

  const resultEvent = (target: RebindTarget, r: RebindResult): InputRebindEvent => {
    const at = { action: target.action, index: target.index, ...(target.part !== undefined ? { part: target.part } : {}) };
    if (!r.ok) return { type: 'refused', ...at, reason: r.reason.slice(0, 160), ...(r.conflicts !== undefined && r.conflicts.length > 0 ? { conflicts: r.conflicts } : {}) };
    const g = partGlyph(bindingGlyph(r.binding as never, family, config.glyphs), target.part);
    return { type: 'rebound', ...at, label: g.label.slice(0, 160), ...(r.conflicts.length > 0 ? { conflicts: r.conflicts } : {}), ...(r.swapped.length > 0 ? { swapped: r.swapped } : {}) };
  };

  const startListen = (action: string, options: ListenOptions = {}): { ok: true; target: InputRebindTarget } | { ok: false; reason: string } => {
    if (disposed) return { ok: false, reason: 'the game has ended' };
    if (deps.input.captureInput === undefined) return { ok: false, reason: 'this input owner cannot listen for input' };
    readDevice();
    const t = resolveTarget(config, action, options, options.device ?? device.kind);
    if (!t.ok) {
      const e: InputRebindEvent = { type: 'refused', action, reason: t.reason.slice(0, 160) };
      event(e);
      options.onDone?.(e);
      notify();
      return t;
    }
    if (listen !== null) {
      const prev = listen;
      listen = null;
      prev.stop();
      event({ type: 'cancelled', action: prev.target.action, index: prev.target.index, ...(prev.target.part !== undefined ? { part: prev.target.part } : {}) });
    }
    const target = t.target;
    const policy = options.policy ?? REBIND_DEFAULT_POLICY;
    const devices: ('keyboard' | 'mouse' | 'gamepad')[] = target.device === 'gamepad' ? ['gamepad'] : target.part !== undefined ? ['keyboard'] : ['keyboard', 'mouse'];
    const at = { action: target.action, index: target.index, ...(target.part !== undefined ? { part: target.part } : {}) };
    const entry = {
      target,
      policy,
      until: now() + (options.timeout ?? REBIND_DEFAULT_TIMEOUT_S) * 1000,
      stop: () => undefined as void,
      ...(options.onDone !== undefined ? { onDone: options.onDone } : {}),
    };
    listen = entry;
    event({ type: 'started', ...at });
    entry.stop = deps.input.captureInput({ devices, cancelKeys: [options.cancelKey ?? REBIND_DEFAULT_CANCEL] }, (input) => {
      if (listen !== entry) return;
      if (input === null) return finish({ type: 'cancelled', ...at });
      finish(resultEvent(target, bindAt(target, input, policy)));
    });
    notify();
    return { ok: true, target: at };
  };

  deps.input.setFrameInput?.(() => api.takeFrameEntry());
  config = loadProfile();
  if (config !== defaults) deps.input.configure?.(config as never);
  deps.onChange?.(config);

  const api: InputBindingsController = {
    config: () => config,
    actions: () => status(),
    device: () => device,
    glyph(action, dev, target) {
      const a = status().find((x) => x.name === action);
      if (a === undefined) return null;
      if (target !== undefined) {
        const b = a.bindings[target.index];
        return b === undefined ? null : partGlyph(b, target.part);
      }
      const want = dev ?? device.kind;
      return a.bindings.find((b) => (want === 'gamepad' ? b.device === 'gamepad' : b.device !== 'gamepad')) ?? null;
    },
    glyphImage(glyph) {
      if (glyph.image !== undefined) {
        const url = deps.imageUrl?.(glyph.image) ?? null;
        if (url !== null) return url;
      }
      return glyphDataUrl(glyph.icon, glyph.label);
    },
    listen: startListen,
    cancel() {
      const l = listen;
      if (l === null) return;
      l.stop();
      finish({ type: 'cancelled', action: l.target.action, index: l.target.index, ...(l.target.part !== undefined ? { part: l.target.part } : {}) });
    },
    listening: () => (listen === null ? null : { action: listen.target.action, index: listen.target.index, ...(listen.target.part !== undefined ? { part: listen.target.part } : {}) }),
    bind(action, input, options = {}) {
      const t = resolveTarget(config, action, options, options.device ?? (input.device === 'gamepad' ? 'gamepad' : 'keyboardMouse'));
      if (!t.ok) return t;
      const r = bindAt(t.target, input, options.policy ?? REBIND_DEFAULT_POLICY);
      event(resultEvent(t.target, r));
      notify();
      return r;
    },
    conflicts(action, input, options = {}) {
      const t = resolveTarget(config, action, options, options.device ?? (input.device === 'gamepad' ? 'gamepad' : 'keyboardMouse'));
      return t.ok ? findConflicts(config, t.target, input) : [];
    },
    reset(action) {
      apply(resetBindings(config, defaults, action), true);
      event({ type: 'reset', ...(action !== undefined ? { action } : {}) });
      notify();
    },
    profile: () => profile,
    useProfile(next) {
      if (!PROFILE_RE.test(next)) return false;
      api.cancel();
      profile = next;
      apply(loadProfile(), false);
      pending.profile = profile;
      event({ type: 'profile', profile });
      notify();
      return true;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    handle(requests) {
      for (const r of requests) {
        if (r.op === 'rebind') startListen(r.action, r.options);
        else if (r.op === 'cancel') api.cancel();
        else if (r.op === 'reset') {
          if (r.action !== undefined && !config.actions.some((a) => a.name === r.action)) event({ type: 'refused', action: r.action, reason: `no action "${r.action}"` });
          else api.reset(r.action);
        } else if (r.op === 'profile') api.useProfile(r.profile);
      }
    },
    tick() {
      if (disposed) return;
      readDevice();
      const l = listen;
      if (l !== null && now() >= l.until) {
        l.stop();
        finish({ type: 'timeout', action: l.target.action, index: l.target.index, ...(l.target.part !== undefined ? { part: l.target.part } : {}) });
      }
    },
    takeFrameEntry() {
      if (disposed) return undefined;
      readDevice();
      const p = pending;
      if (p.device === undefined && p.actions !== true && p.events.length === 0 && p.profile === undefined) return undefined;
      pending = { events: [] };
      return {
        ...(p.device !== undefined ? { device: p.device } : {}),
        ...(p.actions === true ? { actions: status() } : {}),
        ...(p.events.length > 0 ? { events: p.events } : {}),
        ...(p.profile !== undefined ? { profile: p.profile } : {}),
      };
    },
    revision: () => rev,
    observe() {
      const list = status();
      const glyphs: Record<string, { label: string; icon: string }> = {};
      for (const a of list) {
        const g = api.glyph(a.name);
        if (g !== null) glyphs[a.name] = { label: g.label, icon: g.icon };
      }
      return { device, profile, listening: api.listening(), changed: list.filter((a) => a.changed === true).map((a) => a.name), glyphs };
    },
    dispose() {
      if (disposed) return;
      listen?.stop();
      listen = null;
      disposed = true;
      deps.input.setFrameInput?.(null);
      subscribers.clear();
    },
  };
  return api;
}
