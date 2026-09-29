/**
 * The dialogue runner — conversations in the simulation.
 *
 * A script starts a conversation (`ctx.dialogue.start`); the runner walks the
 * compiled dialogue graph (project-model `RuntimeDialogueData`): a Line shows
 * its speaker, portrait and text with a typewriter reveal (text speed,
 * `[pause=s]` pauses, instant reveal on advance), plays its voice clip on the
 * voice bus with the music and SFX ducked, and advances on input or by
 * itself (auto-advance: after the voice clip — its recorded length — or the
 * reveal, plus a delay). A Choice shows the options whose conditions hold;
 * picking one applies its effects. Branches, Sets, Signals (which may wait
 * for `resume`), Waits, Jumps and Ends are followed in the same step.
 *
 * Everything is simulation state and time is counted in fixed steps: two
 * runs with the same input frames produce the same view model, events and
 * audio commands at every step (page, worker and replays agree). Player
 * input arrives as input-frame entries (`ActionFrame.dialogue`, from the
 * dialogue UI's buttons); scripts' calls are queued; both are applied at the
 * end of the step (`endStep`), and the events a step produces are seen by
 * scripts in the next step.
 *
 * The runner publishes what the dialogue UI binds to under `dialogue.` in
 * the project UI's view model and shows/hides the dialogue document.
 */
import {
  applyDialogueEffect,
  DIALOGUE_DEFAULTS,
  DIALOGUE_DOCUMENT_ID,
  DIALOGUE_LIMITS,
  dialogueLineText,
  dialogueTruthy,
  dialogueValueText,
  evalDialogueExpr,
  parseDialogueCondition,
  parseDialogueEffects,
  type DialogueEffect,
  type DialogueEnv,
  type DialogueExpr,
  type DialogueSpeaker,
  type DialogueValue,
  type RuntimeDialogue,
  type RuntimeDialogueData,
  type RuntimeDialogueNode,
} from '@thirdlight/project-model';

import type { AudioPlayOptions, BehaviorDialogue, BehaviorDialogueEvent, BehaviorDialogueHistoryEntry, BehaviorDialogueState, DialogueVariableValue } from './types';

// ---- input-frame entries -------------------------------------------------------

export type DialogueInputKind = 'advance' | 'choose' | 'skip' | 'auto' | 'backlog';
export const DIALOGUE_INPUT_KINDS: readonly DialogueInputKind[] = ['advance', 'choose', 'skip', 'auto', 'backlog'];

/** One dialogue input carried by an input frame (from the dialogue UI's buttons, a tool, a test). */
export interface DialogueInputRecord {
  readonly kind: DialogueInputKind;
  /** choose: the option's index among those shown. */
  readonly index?: number;
}

const hasOwn = Object.prototype.hasOwnProperty;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate a frame's `dialogue` entries (at most 8), returning frozen copies. */
export function validateDialogueInputs(raw: unknown): { ok: true; inputs: readonly DialogueInputRecord[] } | { ok: false; field: string; message: string } {
  if (!Array.isArray(raw) || raw.length > DIALOGUE_LIMITS.frameInputs) return { ok: false, field: 'dialogue', message: `dialogue must be an array of at most ${DIALOGUE_LIMITS.frameInputs} dialogue inputs` };
  const out: DialogueInputRecord[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const c = validateDialogueInput(raw[i]);
    if (!c.ok) return { ok: false, field: `dialogue/${i}${c.field === '' ? '' : `/${c.field}`}`, message: c.message };
    out.push(c.input);
  }
  return { ok: true, inputs: Object.freeze(out) };
}

export function validateDialogueInput(raw: unknown): { ok: true; input: DialogueInputRecord } | { ok: false; field: string; message: string } {
  if (!isObj(raw)) return { ok: false, field: '', message: 'a dialogue input is { kind, index? }' };
  for (const k in raw) if (hasOwn.call(raw, k) && k !== 'kind' && k !== 'index') return { ok: false, field: k, message: `unknown dialogue input field "${k}"` };
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(DIALOGUE_INPUT_KINDS as readonly string[]).includes(kind)) return { ok: false, field: 'kind', message: `kind is one of ${DIALOGUE_INPUT_KINDS.join(', ')}` };
  const index = raw['index'];
  if (index !== undefined && !(typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 256)) return { ok: false, field: 'index', message: 'index is an option index 0–255' };
  if (kind === 'choose' && index === undefined) return { ok: false, field: 'index', message: 'choose names the option index' };
  return { ok: true, input: Object.freeze({ kind: kind as DialogueInputKind, ...(index !== undefined ? { index: index as number } : {}) }) };
}

// ---- the runner's ports ----------------------------------------------------------

/** What the runner writes to: the project UI's state (view model + shown documents). */
export interface DialogueUiPort {
  set(path: string, value: unknown): boolean;
  clear(path: string): boolean;
  show(doc: string): boolean;
  hide(doc: string): boolean;
  isShown(doc: string): boolean;
  /** Move the keyboard/gamepad focus to a widget (a presentation command; optional). */
  focus?(doc: string, widget: string): boolean;
}

/** The simulation's audio intent log (`AudioMixer`). */
export interface DialogueAudioPort {
  play(assetId: unknown, options?: AudioPlayOptions): number;
  stop(handle: unknown, fadeSeconds?: unknown): void;
  setDuck(source: string, level: number, fade: number, bus?: 'music' | 'sfx'): void;
}

/** Seconds of a duck in or out (short: the voice starts on the word, the music comes back promptly). */
const DUCK_IN_SECONDS = 0.15;
const DUCK_OUT_SECONDS = 0.4;
/** A voice cut short by an advance fades out this fast (no click). */
const VOICE_CUT_SECONDS = 0.08;
/** The backlog's share of the project UI's 64 KiB view model (engine limit). */
const BACKLOG_VIEW_BYTES = 24_576;

type Phase = 'line' | 'choice' | 'signal' | 'wait';

interface LineState {
  readonly id: string;
  readonly speakerId: string;
  readonly speaker: DialogueSpeaker | null;
  readonly expression: string;
  readonly display: string;
  readonly visible: number;
  /** Step offsets (from the line's start) at which each visible character shows (index k = character k+1). */
  readonly revealAt: readonly number[];
  readonly voice: string;
  /** Steps the voice lasts (null: no voice or its length is unknown). */
  readonly voiceSteps: number | null;
  readonly auto: 'default' | 'on' | 'off';
  /** It was seen before this visit (skip mode passes it). */
  readonly seenBefore: boolean;
  readonly next: string | null;
  elapsed: number;
  revealed: number;
  /** Revealed everything (the time or an advance). */
  instant: boolean;
  voiceHandle: number;
  voiceDone: boolean;
  /** The step (elapsed) when the reveal and the voice were both done (auto-advance counts from it). */
  doneAt: number | null;
  lastBlip: number;
}

interface ChoiceState {
  readonly id: string;
  readonly options: readonly { readonly id: string; readonly text: string; readonly effects: string; readonly next: string | null }[];
}

interface Conversation {
  readonly serial: number;
  dialogue: RuntimeDialogue;
  node: string;
  phase: Phase;
  readonly bindings: Readonly<Record<string, DialogueValue>>;
  line: LineState | null;
  /** The last line shown (kept on screen under a choice). */
  lastLine: LineState | null;
  choice: ChoiceState | null;
  waitLeft: number;
}

type Request =
  | { readonly op: 'start'; readonly serial: number; readonly dialogueId: string; readonly node: string | null; readonly bindings: Readonly<Record<string, DialogueValue>> }
  | { readonly op: 'stop' }
  | { readonly op: 'advance' }
  | { readonly op: 'choose'; readonly index: number }
  | { readonly op: 'resume' }
  | { readonly op: 'skip'; readonly on: boolean | null }
  | { readonly op: 'auto'; readonly on: boolean | null | 'toggle' }
  | { readonly op: 'backlog' }
  | { readonly op: 'speed'; readonly cps: number | null };

const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}\/[A-Za-z0-9_-]{1,64}$/;

function validValue(v: unknown): v is DialogueValue {
  return v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= DIALOGUE_LIMITS.variableText);
}

/** The saved dialogue state (the opt-in `dialogue` save section). */
export interface DialogueSaveState {
  readonly variables: Readonly<Record<string, DialogueValue>>;
  readonly seen: readonly string[];
}

export class DialogueRunner {
  private readonly byId: ReadonlyMap<string, RuntimeDialogue>;
  private readonly speakers: ReadonlyMap<string, DialogueSpeaker>;
  private readonly exprCache = new Map<string, DialogueExpr | null>();
  private readonly effectsCache = new Map<string, readonly DialogueEffect[]>();
  private conv: Conversation | null = null;
  private serial = 0;
  private requests: Request[] = [];
  private frameInputs: readonly DialogueInputRecord[] = [];
  private variables = new Map<string, DialogueValue>();
  private seenSet = new Set<string>();
  private history: BehaviorDialogueHistoryEntry[] = [];
  private stepEvents: BehaviorDialogueEvent[] = [];
  private visible: readonly BehaviorDialogueEvent[] = Object.freeze([]);
  private skipMode = false;
  private autoMode: boolean | null = null;
  private speed: number | null = null;
  private backlogOpen = false;
  /** Published values by path (JSON), so an unchanged value is not written again. */
  private published = new Map<string, string>();
  /** Something happened (the digest includes the runner only then). */
  private used = false;
  readonly api: BehaviorDialogue;

  constructor(
    private readonly data: RuntimeDialogueData | null,
    private readonly ui: DialogueUiPort | null,
    private readonly audio: DialogueAudioPort | null,
    private readonly hz: number,
    /** A clip's recorded length in seconds (null: unknown). */
    private readonly durationOf: (assetId: string) => number | null,
  ) {
    this.byId = new Map((data?.dialogues ?? []).map((d) => [d.dialogueId, d] as const));
    this.speakers = new Map((data?.speakers ?? []).map((s) => [s.speakerId, s] as const));
    this.api = this.buildApi();
  }

  /** The project has conversations. */
  get enabled(): boolean {
    return this.data !== null;
  }

  // ---- settings -------------------------------------------------------------

  private textSpeed(): number {
    return this.speed ?? this.data?.settings.textSpeed ?? DIALOGUE_DEFAULTS.textSpeed;
  }
  private autoDelaySteps(): number {
    return Math.round((this.data?.settings.autoDelay ?? DIALOGUE_DEFAULTS.autoDelay) * this.hz);
  }
  private duckLevel(): number {
    return this.data?.settings.duck ?? DIALOGUE_DEFAULTS.duck;
  }
  private backlogMax(): number {
    return this.data?.settings.backlog ?? DIALOGUE_DEFAULTS.backlog;
  }

  // ---- script API -----------------------------------------------------------

  private buildApi(): BehaviorDialogue {
    const r = this;
    return Object.freeze({
      start: (dialogueId: string, options?: { entry?: string; node?: string; bindings?: Readonly<Record<string, DialogueVariableValue>> }): number => r.requestStart(dialogueId, options),
      stop: (): boolean => r.queue({ op: 'stop' }),
      isRunning: (conversation?: number): boolean => r.isRunning(conversation),
      current: (): BehaviorDialogueState | null => r.currentState(),
      advance: (): boolean => r.queue({ op: 'advance' }),
      choose: (index: number): boolean => (Number.isInteger(index) && index >= 0 && index < 256 ? r.queue({ op: 'choose', index }) : false),
      resume: (): boolean => r.queue({ op: 'resume' }),
      setSkip: (on: boolean): void => void r.queueAlways({ op: 'skip', on: on === true }),
      setAuto: (on: boolean | null): void => void r.queueAlways({ op: 'auto', on: on === null ? null : on === true }),
      setTextSpeed: (cps: number | null): void => void r.queueAlways({ op: 'speed', cps: cps === null ? null : typeof cps === 'number' && Number.isFinite(cps) ? Math.max(0, Math.min(1000, cps)) : null }),
      events: (): readonly BehaviorDialogueEvent[] => r.visible,
      event: (kind: BehaviorDialogueEvent['kind'], name?: string): BehaviorDialogueEvent | null => r.visible.find((e) => e.kind === kind && (name === undefined || e.name === name)) ?? null,
      get: (name: string): DialogueVariableValue => (typeof name === 'string' ? (r.variables.get(name) ?? null) : null),
      set: (name: string, value: DialogueVariableValue): boolean => r.setVariable(name, value),
      variables: (): Readonly<Record<string, DialogueVariableValue>> => Object.freeze(Object.fromEntries([...r.variables.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))),
      seen: (key: string): boolean => typeof key === 'string' && r.seenSet.has(key),
      history: (): readonly BehaviorDialogueHistoryEntry[] => Object.freeze([...r.history]),
    });
  }

  private queue(req: Request): boolean {
    if (this.data === null) return false;
    const running = this.conv !== null || this.requests.some((q) => q.op === 'start');
    if (!running) return false;
    this.requests.push(req);
    this.used = true;
    return true;
  }

  private queueAlways(req: Request): boolean {
    if (this.data === null) return false;
    this.requests.push(req);
    this.used = true;
    return true;
  }

  private requestStart(dialogueId: unknown, options?: { entry?: unknown; node?: unknown; bindings?: unknown }): number {
    if (this.data === null || typeof dialogueId !== 'string') return 0;
    const d = this.byId.get(dialogueId);
    if (d === undefined) return 0;
    if (this.conv !== null || this.requests.some((q) => q.op === 'start')) return 0;
    let node: string | null;
    if (options?.node !== undefined) {
      if (typeof options.node !== 'string' || !hasOwn.call(d.nodes, options.node)) return 0;
      node = options.node;
    } else if (options?.entry !== undefined) {
      if (typeof options.entry !== 'string' || !hasOwn.call(d.entries, options.entry)) return 0;
      node = d.entries[options.entry] ?? null;
    } else node = d.start;
    const bindings: Record<string, DialogueValue> = {};
    if (options?.bindings !== undefined) {
      if (!isObj(options.bindings)) return 0;
      const keys = Object.keys(options.bindings);
      if (keys.length > DIALOGUE_LIMITS.bindings) return 0;
      for (const k of keys) {
        const v = options.bindings[k];
        if (!VAR_RE.test(k) || !validValue(v)) return 0;
        bindings[k] = v;
      }
    }
    this.serial += 1;
    this.used = true;
    this.requests.push({ op: 'start', serial: this.serial, dialogueId, node, bindings: Object.freeze(bindings) });
    return this.serial;
  }

  /**
   * The timeline's dialogue track (`TimelineDialoguePort`): run a node (or an
   * entry of that name, or the start) with the timeline's bindings as
   * `$name` values; the handle is the conversation number (0: refused — no
   * such dialogue, or one is running); the track waits while it runs.
   */
  timelinePort(): { start(dialogueId: string, node: string | undefined, bindings: ReadonlyMap<string, string>): number; running(handle: number): boolean; stop(handle: number): void } {
    return {
      start: (dialogueId, node, bindings) => {
        const b: Record<string, DialogueValue> = {};
        for (const [k, v] of bindings) if (VAR_RE.test(k) && Object.keys(b).length < DIALOGUE_LIMITS.bindings) b[k] = String(v).slice(0, DIALOGUE_LIMITS.variableText);
        const d = this.byId.get(dialogueId);
        const where = node === undefined || node === '' || d === undefined ? {} : hasOwn.call(d.nodes, node) ? { node } : hasOwn.call(d.entries, node) ? { entry: node } : { node };
        return this.requestStart(dialogueId, { ...where, bindings: b });
      },
      running: (handle) => handle > 0 && this.isRunning(handle),
      stop: (handle) => {
        if (handle > 0 && this.isRunning(handle)) this.queue({ op: 'stop' });
      },
    };
  }

  private isRunning(conversation?: number): boolean {
    const starting = this.requests.find((q) => q.op === 'start') as Extract<Request, { op: 'start' }> | undefined;
    if (conversation === undefined) return this.conv !== null || starting !== undefined;
    return (this.conv !== null && this.conv.serial === conversation) || starting?.serial === conversation;
  }

  private setVariable(name: unknown, value: unknown): boolean {
    if (typeof name !== 'string' || !VAR_RE.test(name) || !validValue(value)) return false;
    if (!this.variables.has(name) && this.variables.size >= DIALOGUE_LIMITS.variables) return false;
    this.variables.set(name, value);
    this.used = true;
    return true;
  }

  private currentState(): BehaviorDialogueState | null {
    const c = this.conv;
    if (c === null) return null;
    const line = c.phase === 'line' ? c.line : null;
    return Object.freeze({
      conversation: c.serial,
      dialogueId: c.dialogue.dialogueId,
      nodeId: c.node,
      kind: c.phase,
      speaker: line?.speakerId ?? '',
      text: line?.display ?? '',
      revealed: line?.revealed ?? 0,
      total: line?.visible ?? 0,
      options: Object.freeze(c.phase === 'choice' && c.choice !== null ? c.choice.options.map((o) => o.text) : []),
    });
  }

  // ---- the runtime's calls --------------------------------------------------

  /** A sampled frame's dialogue entries (applied at the end of the step). */
  deliver(inputs: readonly DialogueInputRecord[] | undefined): void {
    this.frameInputs = inputs ?? [];
    if (this.frameInputs.length > 0) this.used = true;
  }

  /**
   * The end of a fixed step: time passes for what was shown (reveal, voice,
   * auto-advance, waits), then the frame's inputs and the scripts' requests
   * apply in order; the view model follows; this step's events become the
   * ones scripts see next step.
   */
  endStep(): void {
    if (this.data === null) return;
    this.stepEvents = [];
    this.tick();
    for (const input of this.frameInputs) this.applyInput(input);
    this.frameInputs = [];
    const reqs = this.requests;
    this.requests = [];
    for (const q of reqs) this.applyRequest(q);
    this.publish();
    this.visible = this.stepEvents.length === 0 ? (this.visible.length === 0 ? this.visible : Object.freeze([])) : Object.freeze(this.stepEvents.map((e) => Object.freeze(e)));
  }

  /** A new run (start, replay): no conversation, variables and the seen set cleared, the UI empty. */
  resetRun(): void {
    this.conv = null;
    this.requests = [];
    this.frameInputs = [];
    this.variables = new Map();
    this.seenSet = new Set();
    this.history = [];
    this.stepEvents = [];
    this.visible = Object.freeze([]);
    this.skipMode = false;
    this.autoMode = null;
    this.speed = null;
    this.backlogOpen = false;
    // The UI state is reset by the runtime (the whole view model empties); forget what was published.
    this.published = new Map();
    this.used = false;
  }

  /** The deterministic state (the step digest), or null while nothing used dialogue. */
  digestText(): string | null {
    if (!this.used) return null;
    const c = this.conv;
    return JSON.stringify([
      this.serial,
      c === null ? null : [c.serial, c.dialogue.dialogueId, c.node, c.phase, c.waitLeft, c.line === null ? null : [c.line.id, c.line.elapsed, c.line.revealed, c.line.instant, c.line.voiceHandle, c.line.voiceDone, c.line.doneAt], c.choice?.options.map((o) => o.id) ?? null],
      [...this.variables.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      this.seenSet.size,
      this.history.length,
      this.skipMode,
      this.autoMode,
      this.speed,
      this.backlogOpen,
    ]);
  }

  /** The `dialogue` save section: the variables and the seen set. */
  saveState(): DialogueSaveState {
    return {
      variables: Object.fromEntries([...this.variables.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      seen: [...this.seenSet].sort(),
    };
  }

  /** Why a saved `dialogue` section does not fit (null: fine). */
  checkState(v: unknown): string | null {
    if (v === undefined) return null;
    if (!isObj(v) || !isObj(v['variables']) || !Array.isArray(v['seen'])) return 'the dialogue section is { variables, seen }';
    const vars = Object.entries(v['variables']);
    if (vars.length > DIALOGUE_LIMITS.variables) return `at most ${DIALOGUE_LIMITS.variables} dialogue variables`;
    for (const [k, x] of vars) if (!VAR_RE.test(k) || !validValue(x)) return `dialogue variable "${k.slice(0, 32)}" is not a name with a number, text, true/false or null`;
    if (v['seen'].length > DIALOGUE_LIMITS.seen) return `at most ${DIALOGUE_LIMITS.seen} seen lines`;
    for (const k of v['seen'] as unknown[]) if (typeof k !== 'string' || !KEY_RE.test(k)) return 'a seen line is "dialogueId/nodeId"';
    return null;
  }

  /** Restore a saved section (undefined: back to none). */
  restoreState(v: unknown): void {
    this.variables = new Map();
    this.seenSet = new Set();
    if (isObj(v)) {
      for (const [k, x] of Object.entries(v['variables'] as Record<string, DialogueValue>)) this.variables.set(k, x);
      for (const k of v['seen'] as string[]) this.seenSet.add(k);
    }
    this.used = true;
  }

  /** The observation (tools): the conversation now, the mode flags and the backlog length. */
  observe(): Record<string, unknown> | null {
    if (!this.used) return null;
    const c = this.conv;
    return {
      running: c !== null,
      ...(c !== null ? { conversation: c.serial, dialogueId: c.dialogue.dialogueId, node: c.node, kind: c.phase } : {}),
      ...(c?.line !== null && c?.line !== undefined ? { revealed: c.line.revealed, total: c.line.visible, voice: c.line.voice !== '' && !c.line.voiceDone } : {}),
      skip: this.skipMode,
      auto: this.autoMode,
      backlog: this.history.length,
      seen: this.seenSet.size,
    };
  }

  // ---- internals: stepping ---------------------------------------------------

  private tick(): void {
    const c = this.conv;
    if (c === null) return;
    if (c.phase === 'wait') {
      c.waitLeft -= 1;
      if (c.waitLeft <= 0) this.follow(c, (c.dialogue.nodes[c.node] as { next: string | null } | undefined)?.next ?? null);
      return;
    }
    if (c.phase !== 'line' || c.line === null) return;
    const l = c.line;
    l.elapsed += 1;
    const before = l.revealed;
    l.revealed = l.instant ? l.visible : this.revealedAt(l, l.elapsed);
    if (l.revealed > before) this.blips(l, before);
    if (!l.voiceDone && l.voiceSteps !== null && l.elapsed >= l.voiceSteps) this.endVoice(l, false);
    if (l.voice !== '' && l.voiceSteps === null && l.revealed >= l.visible && !l.voiceDone) {
      // A clip of unknown length: the line counts as spoken when its text is out (the clip plays on).
      l.voiceDone = true;
      this.unduck();
    }
    if (l.doneAt === null && l.revealed >= l.visible && (l.voice === '' || l.voiceDone)) l.doneAt = l.elapsed;
    // Skip mode passes lines seen before (one per step), else stops at an unseen one.
    if (this.skipMode) {
      if (l.seenBefore) {
        this.leaveLine(c, true);
        this.follow(c, l.next);
        return;
      }
      this.skipMode = false;
    }
    if (l.doneAt !== null && this.autoFor(l) && l.elapsed - l.doneAt >= this.autoDelaySteps()) {
      this.leaveLine(c, false);
      this.follow(c, l.next);
    }
  }

  private autoFor(l: LineState): boolean {
    if (l.auto === 'on') return true;
    if (l.auto === 'off') return false;
    return this.autoMode ?? this.data?.settings.autoAdvance ?? DIALOGUE_DEFAULTS.autoAdvance;
  }

  private revealedAt(l: LineState, elapsed: number): number {
    // revealAt is ascending: count the characters due by now.
    let lo = 0;
    let hi = l.revealAt.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (l.revealAt[mid]! <= elapsed) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private blips(l: LineState, before: number): void {
    const s = l.speaker;
    if (s === null || s.blip === undefined || l.voice !== '' || this.audio === null || l.instant) return;
    const every = s.blipEvery ?? DIALOGUE_DEFAULTS.blipEvery;
    // One blip per step at most, when the reveal passes a multiple of `every`.
    if (Math.floor(l.revealed / every) > Math.floor(before / every) && l.revealed - l.lastBlip >= every) {
      l.lastBlip = l.revealed;
      this.audio.play(s.blip, { volume: s.blipVolume ?? DIALOGUE_DEFAULTS.blipVolume, bus: 'sfx' });
    }
  }

  private endVoice(l: LineState, cut: boolean): void {
    if (l.voiceDone) return;
    l.voiceDone = true;
    if (cut && l.voiceHandle > 0) this.audio?.stop(l.voiceHandle, VOICE_CUT_SECONDS);
    this.unduck();
  }

  private unduck(): void {
    if (this.audio === null) return;
    this.audio.setDuck('dialogue-voice', 1, DUCK_OUT_SECONDS, 'music');
    this.audio.setDuck('dialogue-voice', 1, DUCK_OUT_SECONDS, 'sfx');
  }

  private applyInput(input: DialogueInputRecord): void {
    switch (input.kind) {
      case 'advance':
        this.doAdvance();
        return;
      case 'choose':
        this.doChoose(input.index ?? -1);
        return;
      case 'skip':
        this.skipMode = !this.skipMode;
        return;
      case 'auto':
        this.autoMode = !(this.autoMode ?? this.data?.settings.autoAdvance ?? DIALOGUE_DEFAULTS.autoAdvance);
        return;
      case 'backlog':
        this.backlogOpen = !this.backlogOpen;
        return;
    }
  }

  private applyRequest(q: Request): void {
    switch (q.op) {
      case 'start': {
        if (this.conv !== null) return;
        const d = this.byId.get(q.dialogueId)!;
        const c: Conversation = { serial: q.serial, dialogue: d, node: '', phase: 'line', bindings: q.bindings, line: null, lastLine: null, choice: null, waitLeft: 0 };
        this.conv = c;
        this.backlogOpen = false;
        this.emit({ kind: 'start', node: '', name: '' });
        if (this.data !== null && this.ui !== null) this.ui.show(this.data.document);
        this.follow(c, q.node);
        return;
      }
      case 'stop':
        if (this.conv !== null) this.end(this.conv, 'stopped');
        return;
      case 'advance':
        this.doAdvance();
        return;
      case 'choose':
        this.doChoose(q.index);
        return;
      case 'resume': {
        const c = this.conv;
        if (c !== null && c.phase === 'signal') this.follow(c, (c.dialogue.nodes[c.node] as { next: string | null } | undefined)?.next ?? null);
        return;
      }
      case 'skip':
        this.skipMode = q.on === true;
        return;
      case 'auto':
        this.autoMode = q.on === 'toggle' ? !(this.autoMode ?? false) : q.on;
        return;
      case 'backlog':
        this.backlogOpen = !this.backlogOpen;
        return;
      case 'speed':
        this.speed = q.cps;
        return;
    }
  }

  private doAdvance(): void {
    const c = this.conv;
    if (c === null) return;
    // An advance while the backlog is open closes it.
    if (this.backlogOpen) {
      this.backlogOpen = false;
      return;
    }
    if (c.phase !== 'line' || c.line === null) return;
    const l = c.line;
    if (l.revealed < l.visible) {
      // Instant reveal: the rest of the line at once (the voice plays on).
      const before = l.revealed;
      l.instant = true;
      l.revealed = l.visible;
      void before;
      if (l.voice === '' || l.voiceDone) l.doneAt = l.elapsed;
      return;
    }
    this.leaveLine(c, true);
    this.follow(c, l.next);
  }

  private doChoose(index: number): void {
    const c = this.conv;
    if (c === null || c.phase !== 'choice' || c.choice === null) return;
    const o = c.choice.options[index];
    if (o === undefined) return;
    const d = c.dialogue.dialogueId;
    this.seenSet.add(`${d}/${o.id}`);
    this.trimSeen();
    this.pushHistory({ dialogueId: d, nodeId: o.id, speaker: '', name: '', text: o.text, choice: true });
    this.emit({ kind: 'chosen', node: c.choice.id, text: o.text, name: o.id, index });
    this.applyEffects(c, o.effects);
    c.choice = null;
    // The engine box: the focus goes back to the box (Enter advances).
    if (this.data?.document === DIALOGUE_DOCUMENT_ID) this.ui?.focus?.(this.data.document, 'box');
    this.follow(c, o.next);
  }

  private leaveLine(c: Conversation, cutVoice: boolean): void {
    const l = c.line;
    if (l === null) return;
    this.endVoice(l, cutVoice);
    this.emit({ kind: 'lineEnd', node: l.id, speaker: l.speakerId, name: '' });
    c.line = null;
  }

  /** Walk from `nodeId` through non-blocking nodes to the next line, choice, signal wait or wait (or the end). */
  private follow(c: Conversation, start: string | null): void {
    let id = start;
    for (let hops = 0; ; hops += 1) {
      if (this.conv !== c) return;
      if (hops >= DIALOGUE_LIMITS.hopsPerStep) {
        this.end(c, 'loop');
        return;
      }
      if (id === null) {
        this.end(c, 'end');
        return;
      }
      const n: RuntimeDialogueNode | undefined = c.dialogue.nodes[id];
      if (n === undefined) {
        this.end(c, 'end');
        return;
      }
      c.node = id;
      switch (n.t) {
        case 'line':
          this.enterLine(c, id, n);
          return;
        case 'choice': {
          const shown = n.options.filter((o) => (!o.once || !this.seenSet.has(`${c.dialogue.dialogueId}/${o.id}`)) && this.condition(c, o.condition));
          if (shown.length === 0) {
            id = n.none;
            continue;
          }
          c.phase = 'choice';
          c.choice = { id, options: shown.map((o) => ({ id: o.id, text: this.interpolate(c, o.text), effects: o.effects, next: o.next })) };
          this.skipMode = false;
          // The engine box: the keyboard/gamepad focus goes to the first option.
          if (this.data?.document === DIALOGUE_DOCUMENT_ID) this.ui?.focus?.(this.data.document, 'choice');
          this.emit({ kind: 'choice', node: id, name: '', text: c.choice.options.map((o) => o.text).join('\n') });
          return;
        }
        case 'branch':
          id = this.condition(c, n.condition) ? n.then : n.else;
          continue;
        case 'set':
          this.applyEffects(c, n.effects);
          id = n.next;
          continue;
        case 'signal':
          this.emit({ kind: 'signal', node: id, name: n.name, value: n.value });
          if (n.wait) {
            c.phase = 'signal';
            return;
          }
          id = n.next;
          continue;
        case 'wait': {
          const steps = Math.round(n.seconds * this.hz);
          if (steps <= 0) {
            id = n.next;
            continue;
          }
          c.phase = 'wait';
          c.waitLeft = steps;
          return;
        }
        case 'jump': {
          const target = this.byId.get(n.dialogue);
          if (target === undefined) {
            this.end(c, 'end');
            return;
          }
          c.dialogue = target;
          id = n.entry === '' ? target.start : (target.entries[n.entry] ?? null);
          continue;
        }
        case 'goto':
          id = n.next;
          continue;
        case 'end':
          this.end(c, 'end');
          return;
      }
    }
  }

  private enterLine(c: Conversation, id: string, n: Extract<RuntimeDialogueNode, { t: 'line' }>): void {
    const speakerId = n.speaker.startsWith('$') ? dialogueValueText(c.bindings[n.speaker.slice(1)] ?? null) : n.speaker;
    const speaker = this.speakers.get(speakerId) ?? null;
    const text = dialogueLineText(n.text, (ref) => dialogueValueText(ref.startsWith('$') ? (c.bindings[ref.slice(1)] ?? null) : (this.variables.get(ref) ?? null)));
    const cps = this.textSpeed();
    const revealAt: number[] = [];
    if (cps > 0) {
      let pauseSteps = 0;
      let p = 0;
      for (let k = 1; k <= text.visible; k += 1) {
        while (p < text.pauses.length && text.pauses[p]!.at < k) {
          pauseSteps += Math.round(text.pauses[p]!.seconds * this.hz);
          p += 1;
        }
        revealAt.push(Math.max(1, Math.ceil((k * this.hz) / cps - 1e-9)) + pauseSteps);
      }
    }
    const key = `${c.dialogue.dialogueId}/${id}`;
    const seenBefore = this.seenSet.has(key);
    this.seenSet.add(key);
    this.trimSeen();
    const voiceSeconds = n.voice !== '' ? this.durationOf(n.voice) : null;
    const l: LineState = {
      id,
      speakerId,
      speaker,
      expression: n.expression,
      display: text.display,
      visible: text.visible,
      revealAt,
      voice: n.voice,
      voiceSteps: voiceSeconds !== null && voiceSeconds > 0 ? Math.max(1, Math.ceil(voiceSeconds * this.hz - 1e-9)) : null,
      auto: n.auto,
      seenBefore,
      next: n.next,
      elapsed: 0,
      revealed: cps > 0 ? 0 : text.visible,
      instant: cps <= 0,
      voiceHandle: 0,
      voiceDone: n.voice === '',
      doneAt: null,
      lastBlip: 0,
    };
    if (l.revealed >= l.visible && l.voiceDone) l.doneAt = 0;
    c.phase = 'line';
    c.line = l;
    c.lastLine = l;
    c.choice = null;
    if (n.voice !== '' && this.audio !== null) {
      l.voiceHandle = this.audio.play(n.voice, { bus: 'voice' });
      const duck = this.duckLevel();
      if (duck < 1) {
        this.audio.setDuck('dialogue-voice', duck, DUCK_IN_SECONDS, 'music');
        this.audio.setDuck('dialogue-voice', duck, DUCK_IN_SECONDS, 'sfx');
      }
    }
    this.pushHistory({ dialogueId: c.dialogue.dialogueId, nodeId: id, speaker: speakerId, name: speaker?.name ?? (speakerId !== '' ? speakerId : ''), text: text.display, choice: false });
    this.emit({ kind: 'lineStart', node: id, speaker: speakerId, text: text.display, name: '' });
  }

  private end(c: Conversation, reason: 'end' | 'stopped' | 'loop'): void {
    if (c.line !== null) this.leaveLine(c, true);
    this.conv = null;
    this.skipMode = false;
    this.backlogOpen = false;
    this.emitFor(c, { kind: 'end', node: '', name: reason });
    if (this.data !== null && this.ui !== null) this.ui.hide(this.data.document);
  }

  private trimSeen(): void {
    if (this.seenSet.size <= DIALOGUE_LIMITS.seen) return;
    // The oldest first (insertion order): a long game forgets its earliest lines.
    const drop = this.seenSet.size - DIALOGUE_LIMITS.seen;
    let i = 0;
    for (const k of this.seenSet) {
      if (i++ >= drop) break;
      this.seenSet.delete(k);
    }
  }

  private pushHistory(e: BehaviorDialogueHistoryEntry): void {
    this.history.push(Object.freeze(e));
    const max = this.backlogMax();
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
  }

  private emit(e: { kind: BehaviorDialogueEvent['kind']; node: string; speaker?: string; text?: string; name: string; value?: string; index?: number }): void {
    if (this.conv !== null) this.emitFor(this.conv, e);
  }

  private emitFor(c: Conversation, e: { kind: BehaviorDialogueEvent['kind']; node: string; speaker?: string; text?: string; name: string; value?: string; index?: number }): void {
    this.stepEvents.push({ kind: e.kind, conversation: c.serial, dialogueId: c.dialogue.dialogueId, nodeId: e.node, speaker: e.speaker ?? '', text: e.text ?? '', name: e.name, value: e.value ?? '', index: e.index ?? -1 });
  }

  // ---- expressions -----------------------------------------------------------

  private env(c: Conversation): DialogueEnv {
    return {
      variable: (name) => this.variables.get(name) ?? null,
      binding: (name) => c.bindings[name] ?? null,
      seen: (key) => this.seenSet.has(key.includes('/') ? key : `${c.dialogue.dialogueId}/${key}`),
    };
  }

  private condition(c: Conversation, src: string): boolean {
    if (src.trim() === '') return true;
    let e = this.exprCache.get(src);
    if (e === undefined) {
      const p = parseDialogueCondition(src);
      e = p.ok ? p.expr : null;
      this.exprCache.set(src, e);
    }
    return e === null ? true : dialogueTruthy(evalDialogueExpr(e, this.env(c)));
  }

  private applyEffects(c: Conversation, src: string): void {
    if (src.trim() === '') return;
    let effs = this.effectsCache.get(src);
    if (effs === undefined) {
      const p = parseDialogueEffects(src);
      effs = p.ok ? p.effects : [];
      this.effectsCache.set(src, effs);
    }
    const env = this.env(c);
    for (const eff of effs) {
      if (!this.variables.has(eff.name) && this.variables.size >= DIALOGUE_LIMITS.variables) continue;
      this.variables.set(eff.name, applyDialogueEffect(this.variables.get(eff.name) ?? null, eff, env));
    }
  }

  private interpolate(c: Conversation, text: string): string {
    return dialogueLineText(text, (ref) => dialogueValueText(ref.startsWith('$') ? (c.bindings[ref.slice(1)] ?? null) : (this.variables.get(ref) ?? null))).display.replace(/\[pause=[^\]]*\]/g, '');
  }

  // ---- the view model ---------------------------------------------------------

  private put(path: string, value: unknown): void {
    if (this.ui === null) return;
    const json = JSON.stringify(value);
    if (this.published.get(path) === json) return;
    if (this.ui.set(path, value)) this.published.set(path, json);
  }

  private publish(): void {
    if (this.ui === null || !this.used) return;
    const c = this.conv;
    const line = c === null ? null : c.phase === 'line' ? c.line : c.phase === 'choice' || c.phase === 'signal' || c.phase === 'wait' ? c.lastLine : null;
    this.put('dialogue.active', c !== null);
    this.put('dialogue.dialogueId', c?.dialogue.dialogueId ?? '');
    this.put('dialogue.node', c?.node ?? '');
    this.put('dialogue.kind', c?.phase ?? '');
    this.put('dialogue.showLine', line !== null);
    this.put('dialogue.showChoices', c !== null && c.phase === 'choice');
    if (line !== null) {
      const s = line.speaker;
      const plain = s?.name ?? line.speakerId;
      const escaped = plain.replace(/\[/g, '[[');
      const portraits = s?.portraits ?? {};
      const keys = Object.keys(portraits).sort();
      const expr = line.expression !== '' ? line.expression : (s?.defaultExpression ?? DIALOGUE_DEFAULTS.expression);
      const portrait = portraits[expr] ?? (line.expression === '' ? portraits[keys[0] ?? ''] : undefined) ?? '';
      this.put('dialogue.line', {
        id: line.id,
        speaker: line.speakerId,
        name: s?.color !== undefined && escaped !== '' ? `[color=${s.color}]${escaped}[/color]` : escaped,
        plainName: plain,
        color: s?.color ?? '',
        expression: expr,
        portrait,
        hasPortrait: portrait !== '',
        voiceProfile: s?.voiceProfile ?? '',
        text: line.display.slice(0, 1024),
        total: line.visible,
        reveal: line.revealed,
        done: line.revealed >= line.visible && c?.phase === 'line',
        voiced: line.voice !== '' && !line.voiceDone,
        auto: this.autoFor(line),
      });
    } else this.put('dialogue.line', null);
    this.put('dialogue.choices', c !== null && c.phase === 'choice' && c.choice !== null ? c.choice.options.map((o, i) => ({ index: i, id: o.id, text: o.text })) : []);
    this.put('dialogue.autoMode', this.autoMode ?? this.data?.settings.autoAdvance ?? DIALOGUE_DEFAULTS.autoAdvance);
    this.put('dialogue.skipMode', this.skipMode);
    this.put('dialogue.backlogOpen', this.backlogOpen);
    const colorOf = (id: string): string => this.speakers.get(id)?.color ?? '';
    const entries = this.history.map((h) => {
      const color = colorOf(h.speaker);
      const n = h.name.replace(/\[/g, '[[');
      return { name: h.choice ? '' : color !== '' && n !== '' ? `[color=${color}]${n}[/color]` : n, text: (h.choice ? `> ${h.text}` : h.text).slice(0, 1024), speaker: h.speaker, choice: h.choice };
    });
    // The view model holds 64 KiB for the whole project UI: the backlog keeps its newest entries within 24 KiB.
    let bytes = JSON.stringify(entries).length;
    while (bytes > BACKLOG_VIEW_BYTES && entries.length > 1) bytes -= JSON.stringify(entries.shift()).length + 1;
    this.put('dialogue.backlog', entries);
    this.put('dialogue.backlogRecent', entries.slice(-10));
  }
}
