/**
 * Phase 23.16: dialogue as project content (v4).
 *
 * - `content.dialogues[]` — conversations, each a node graph of kind
 *   `dialogue` on the phase 16 graph framework (owner kind `dialogue`,
 *   edited with `graphEdit`; created/renamed with `setDialogue`). Nodes:
 *   Start (fixed), named Entries, Lines (speaker, expression, text, voice
 *   clip, auto-advance), Choices with Option nodes (text, condition,
 *   effects, once), Branches (a condition), Sets (effects), Signals (for
 *   scripts and the sequencer; may wait), Waits, Jumps (to another
 *   conversation's entry) and Ends. Wires say what comes next.
 * - `content.speakers[]` — the speaker registry: display name, name-plate
 *   colour, portrait set (expression → texture), voice profile id and a
 *   text-blip sound.
 * - `content.dialogueSettings` — engine defaults (text speed, auto-advance,
 *   the delay after a line, the music/SFX duck under a voice, the backlog
 *   length) and the UI document the runner shows (absent: the engine's
 *   default dialogue document, reskinnable with a theme).
 *
 * Conditions and effects are a small expression language over the
 * dialogue variables (`ctx.dialogue.get/set`, saved by the opt-in `dialogue`
 * save section) and the conversation's bindings (`$name`). Line text is the
 * subtitle: 23.9a rich text (`[b]`, `[color=#…]`, `[icon=…]`), `{name}` /
 * `{$name}` values and `[pause=0.5]` pauses of the typewriter reveal.
 *
 * Localization: a line's text is addressed by `<dialogueId>.<nodeId>` (node
 * ids are stable), the key a string table would use; no table is read yet.
 *
 * Pure data rules: validation, canonical form, the compiled runtime form and
 * the engine's default dialogue UI document.
 */
import type { ModelErrorV2 } from './errors';
import { canonicalGraphData, GRAPH_ITEM_ID_RE, nodeFieldValue, validateGraphData, type GraphData, type GraphFieldDef, type GraphKindDef, type GraphNode } from './graph';
import { parseRichText, richTextVisibleLength } from './rich-text';
import type { UiDocument } from './ui-documents';
import { fieldType, unexpectedField, withFound } from './validate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DialogueDocument {
  dialogueId: string;
  name: string;
  graph: GraphData;
}

export interface DialogueSpeaker {
  speakerId: string;
  /** Shown on the name plate. */
  name: string;
  /** The name plate colour (`#rrggbb`; absent: the document's style). */
  color?: string;
  /** Expression id → texture asset (absent: no portrait). */
  portraits?: Record<string, string>;
  /** The expression a line without one shows (absent: `neutral`, else the first portrait by id). */
  defaultExpression?: string;
  /** A voice profile id (project data, e.g. what a voice pipeline or a script keys on). */
  voiceProfile?: string;
  /** An audio asset played while this speaker's text reveals (not on voiced lines). */
  blip?: string;
  /** Characters between two blips (absent: 2). */
  blipEvery?: number;
  /** Blip volume 0–1 (absent: 0.6). */
  blipVolume?: number;
}

export interface DialogueSettings {
  /** Characters per second of the typewriter reveal; 0 = the whole line at once (absent: 40). */
  textSpeed?: number;
  /** Lines advance by themselves after the voice clip (or the reveal) ends, unless a line says otherwise (absent: false). */
  autoAdvance?: boolean;
  /** Seconds between the end of a line's voice/reveal and an auto-advance (absent: 0.5). */
  autoDelay?: number;
  /** Music and SFX level while a voice line plays (0–1; absent: 0.4; 1 = no ducking). */
  duck?: number;
  /** Lines kept in the backlog (absent: 50). */
  backlog?: number;
  /** The UI document the runner shows (absent: the engine's default dialogue document). */
  document?: string;
  /** A UI theme the engine's default document uses (its styles override the default look). */
  theme?: string;
}

// ---------------------------------------------------------------------------
// Limits and defaults
// ---------------------------------------------------------------------------

export const DIALOGUE_LIMITS = Object.freeze({
  dialogues: 256,
  /** Nodes of one conversation (a long branching scene; the editor stays fast). */
  nodes: 1024,
  speakers: 128,
  portraits: 32,
  textChars: 1024,
  optionChars: 256,
  exprChars: 512,
  variables: 256,
  variableText: 256,
  bindings: 16,
  /** Lines remembered as seen (the skip-if-seen set). */
  seen: 8192,
  backlog: 100,
  /** Non-blocking nodes followed in one step (a loop without a line or a choice stops there). */
  hopsPerStep: 256,
  /** Dialogue inputs per input frame. */
  frameInputs: 8,
  nameChars: 64,
  signalValueChars: 256,
});

/**
 * Engine defaults, each with a genre-neutral reason:
 * - textSpeed 40 chars/s: comfortably faster than speech (~15 chars/s), so the
 *   text leads a voice and a silent line reads without waiting.
 * - autoDelay 0.5 s: a beat after the voice ends before the next line.
 * - duck 0.4: a voice stays clear over music and effects without silencing them.
 * - backlog 50 lines: a scene's worth of history in a small view model.
 * - blipEvery 2, blipVolume 0.6: a blip per syllable-ish, under the music.
 */
export const DIALOGUE_DEFAULTS = Object.freeze({ textSpeed: 40, autoAdvance: false, autoDelay: 0.5, duck: 0.4, backlog: 50, blipEvery: 2, blipVolume: 0.6, expression: 'neutral' });

/** The engine's default dialogue UI document id (a project document with this id replaces it). */
export const DIALOGUE_DOCUMENT_ID = 'tl-dialogue';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const EXPR_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const SIGNAL_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;

// ---------------------------------------------------------------------------
// The graph kind
// ---------------------------------------------------------------------------

const FLOW_IN = { id: 'in', label: 'in', type: 'flow', multi: true } as const;
const NEXT = { id: 'next', label: 'next', type: 'flow', single: true } as const;
const CONDITION_FIELD: GraphFieldDef = { key: 'condition', label: 'Condition', type: 'string', default: '', maxLength: DIALOGUE_LIMITS.exprChars };
const EFFECTS_FIELD: GraphFieldDef = { key: 'effects', label: 'Effects', type: 'string', default: '', maxLength: DIALOGUE_LIMITS.exprChars };

/** Phase 23.16: a conversation's graph (owner kind `dialogue`). */
export const DIALOGUE_GRAPH_KIND: GraphKindDef = {
  kind: 'dialogue',
  label: 'Dialogue',
  portTypes: [
    { id: 'flow', label: 'next', color: '#9fb4d6', flow: true },
    { id: 'option', label: 'option', color: '#f2b544', flow: true },
  ],
  conversions: [],
  categories: ['Flow', 'Lines', 'Logic', 'Events'],
  nodes: [
    { type: 'start', label: 'Start', category: 'Flow', description: 'Where the conversation starts.', inputs: [], outputs: [NEXT], max: 1, required: true, fixed: true },
    { type: 'entry', label: 'Entry', category: 'Flow', description: 'A named place to start or jump to (ctx.dialogue.start(id, {entry})).', inputs: [], outputs: [NEXT], titleField: 'name', fields: [{ key: 'name', label: 'Name', type: 'string', default: 'entry', maxLength: 32, pattern: '[A-Za-z_][A-Za-z0-9_]*' }] },
    {
      type: 'line',
      label: 'Line',
      category: 'Lines',
      description: 'A speaker says a line (its text is the subtitle); its voice clip plays on the voice bus.',
      inputs: [FLOW_IN],
      outputs: [NEXT],
      titleField: 'speaker',
      fields: [
        { key: 'speaker', label: 'Speaker', type: 'string', default: '', maxLength: 64 },
        { key: 'expression', label: 'Expression', type: 'string', default: '', maxLength: 32 },
        { key: 'text', label: 'Text', type: 'string', default: '', maxLength: DIALOGUE_LIMITS.textChars },
        // `voice`: an audio or music asset (a voice line may be longer than an audio clip's cap).
        { key: 'voice', label: 'Voice clip', type: 'string', default: '', maxLength: 64, asset: 'voice' },
        { key: 'auto', label: 'Auto-advance', type: 'enum', options: ['default', 'on', 'off'], default: 'default' },
      ],
    },
    { type: 'choice', label: 'Choice', category: 'Lines', description: 'The player picks one of the options wired to it (top to bottom); "none" when no option is available.', inputs: [FLOW_IN], outputs: [{ id: 'options', label: 'options', type: 'option' }, { id: 'none', label: 'none', type: 'flow', single: true }] },
    {
      type: 'option',
      label: 'Option',
      category: 'Lines',
      description: 'One option of a choice: shown when its condition holds (and, with once, until picked); picking it applies its effects.',
      inputs: [{ id: 'in', label: 'choice', type: 'option', required: true }],
      outputs: [NEXT],
      titleField: 'text',
      fields: [{ key: 'text', label: 'Text', type: 'string', default: '', maxLength: DIALOGUE_LIMITS.optionChars }, CONDITION_FIELD, EFFECTS_FIELD, { key: 'once', label: 'Once', type: 'boolean', default: false }],
    },
    { type: 'branch', label: 'Branch', category: 'Logic', description: 'Goes on by "true" when the condition holds, else by "false".', inputs: [FLOW_IN], outputs: [{ id: 'true', label: 'true', type: 'flow', single: true }, { id: 'false', label: 'false', type: 'flow', single: true }], fields: [CONDITION_FIELD] },
    { type: 'set', label: 'Set', category: 'Logic', description: 'Changes dialogue variables: "name = value; count += 1".', inputs: [FLOW_IN], outputs: [NEXT], fields: [EFFECTS_FIELD] },
    {
      type: 'signal',
      label: 'Signal',
      category: 'Events',
      description: 'Raises an event scripts and timelines see; with Wait the conversation holds until ctx.dialogue.resume().',
      inputs: [FLOW_IN],
      outputs: [NEXT],
      titleField: 'name',
      fields: [{ key: 'name', label: 'Name', type: 'string', default: 'signal', maxLength: 64, pattern: '[A-Za-z_][A-Za-z0-9_.:-]*' }, { key: 'value', label: 'Value', type: 'string', default: '', maxLength: DIALOGUE_LIMITS.signalValueChars }, { key: 'wait', label: 'Wait', type: 'boolean', default: false }],
    },
    { type: 'wait', label: 'Wait', category: 'Events', description: 'Holds the conversation for some seconds (the dialogue box stays as it is).', inputs: [FLOW_IN], outputs: [NEXT], fields: [{ key: 'seconds', label: 'Seconds', type: 'number', default: 1, min: 0, max: 600 }] },
    { type: 'jump', label: 'Jump', category: 'Flow', description: 'Continues in another conversation (its start, or a named entry).', inputs: [FLOW_IN], outputs: [], titleField: 'dialogue', fields: [{ key: 'dialogue', label: 'Dialogue', type: 'string', default: '', maxLength: 64 }, { key: 'entry', label: 'Entry', type: 'string', default: '', maxLength: 32 }] },
    { type: 'end', label: 'End', category: 'Flow', description: 'Ends the conversation (a node with nothing next ends it too).', inputs: [FLOW_IN], outputs: [] },
  ],
  // A conversation may loop ("ask me again").
  allowCycles: true,
  maxNodes: DIALOGUE_LIMITS.nodes,
  owner: 'dialogue',
};

/** A new conversation's graph: its Start node. */
export function newDialogueGraph(): GraphData {
  return { nodes: [{ id: 'start', type: 'start', position: [0, 0] }], edges: [] };
}

// ---------------------------------------------------------------------------
// Expressions: conditions and effects
// ---------------------------------------------------------------------------

export type DialogueValue = number | string | boolean | null;

export type DialogueExpr =
  | { readonly k: 'lit'; readonly v: DialogueValue }
  | { readonly k: 'var'; readonly name: string }
  | { readonly k: 'bind'; readonly name: string }
  | { readonly k: 'not'; readonly a: DialogueExpr }
  | { readonly k: 'neg'; readonly a: DialogueExpr }
  | { readonly k: 'bin'; readonly op: string; readonly a: DialogueExpr; readonly b: DialogueExpr }
  | { readonly k: 'seen'; readonly key: string };

export interface DialogueEffect {
  readonly name: string;
  readonly op: '=' | '+=' | '-=';
  readonly value: DialogueExpr;
}

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'bind'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (m === null) return `a number at ${i + 1}`;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
        } else {
          s += src[j];
          j += 1;
        }
      }
      if (j >= src.length) return `an unclosed text at ${i + 1}`;
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]{0,31})/.exec(src.slice(i));
      if (m === null) return `a binding name after "$" at ${i + 1}`;
      out.push({ t: 'bind', v: m[1]! });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      if (m[0].length > 32) return `the name "${m[0].slice(0, 40)}" is longer than 32 characters`;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '+=', '-='].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/%<>!()=;,'.includes(c)) {
      out.push({ t: 'op', v: c });
      i += 1;
      continue;
    }
    return `the character "${c}" at ${i + 1}`;
  }
  return out;
}

const BIN_PREC: Record<string, number> = { '||': 1, or: 1, '&&': 2, and: 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

class Parser {
  i = 0;
  constructor(readonly toks: Tok[]) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  isOp(v: string): boolean {
    const t = this.peek();
    return t !== undefined && ((t.t === 'op' && t.v === v) || (t.t === 'id' && t.v === v && (v === 'and' || v === 'or' || v === 'not')));
  }
  expr(minPrec = 1): DialogueExpr {
    let a = this.unary();
    for (;;) {
      const t = this.peek();
      const op = t === undefined ? undefined : t.t === 'op' ? t.v : t.t === 'id' && (t.v === 'and' || t.v === 'or') ? t.v : undefined;
      const prec = op !== undefined ? BIN_PREC[op] : undefined;
      if (op === undefined || prec === undefined || prec < minPrec) return a;
      this.i += 1;
      const b = this.expr(prec + 1);
      a = { k: 'bin', op: op === 'and' ? '&&' : op === 'or' ? '||' : op, a, b };
    }
  }
  unary(): DialogueExpr {
    if (this.isOp('!') || this.isOp('not')) {
      this.i += 1;
      return { k: 'not', a: this.unary() };
    }
    if (this.isOp('-')) {
      this.i += 1;
      return { k: 'neg', a: this.unary() };
    }
    return this.primary();
  }
  primary(): DialogueExpr {
    const t = this.peek();
    if (t === undefined) throw new Error('the expression ends too early');
    this.i += 1;
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') {
      if (t.v.length > DIALOGUE_LIMITS.variableText) throw new Error(`a text is at most ${DIALOGUE_LIMITS.variableText} characters`);
      return { k: 'lit', v: t.v };
    }
    if (t.t === 'bind') return { k: 'bind', name: t.v };
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (t.v === 'and' || t.v === 'or' || t.v === 'not') throw new Error(`"${t.v}" needs a value beside it`);
      if (t.v === 'seen' && this.isOp('(')) {
        this.i += 1;
        const arg = this.peek();
        if (arg === undefined || arg.t !== 'str') throw new Error('seen("node") takes a node id text');
        this.i += 1;
        if (!this.isOp(')')) throw new Error('seen("node") takes one argument');
        this.i += 1;
        return { k: 'seen', key: arg.v };
      }
      if (this.isOp('(')) throw new Error(`there is no function "${t.v}" (only seen("node"))`);
      return { k: 'var', name: t.v };
    }
    if (t.v === '(') {
      const e = this.expr();
      if (!this.isOp(')')) throw new Error('a "(" is not closed');
      this.i += 1;
      return e;
    }
    throw new Error(`unexpected "${t.v}"`);
  }
}

/** Parse a condition ("" = always true, returned as null). */
export function parseDialogueCondition(src: string): { ok: true; expr: DialogueExpr | null } | { ok: false; message: string } {
  if (src.trim() === '') return { ok: true, expr: null };
  if (src.length > DIALOGUE_LIMITS.exprChars) return { ok: false, message: `a condition is at most ${DIALOGUE_LIMITS.exprChars} characters` };
  const toks = tokenize(src);
  if (typeof toks === 'string') return { ok: false, message: `unexpected ${toks}` };
  const p = new Parser(toks);
  try {
    const e = p.expr();
    if (p.i < toks.length) return { ok: false, message: `unexpected "${String(toks[p.i]!.v)}" after the expression` };
    return { ok: true, expr: e };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Parse effects: `name = expr`, `name += expr`, `name -= expr`, separated by ";" or new lines. */
export function parseDialogueEffects(src: string): { ok: true; effects: DialogueEffect[] } | { ok: false; message: string } {
  if (src.length > DIALOGUE_LIMITS.exprChars) return { ok: false, message: `effects are at most ${DIALOGUE_LIMITS.exprChars} characters` };
  const out: DialogueEffect[] = [];
  for (const part of src.split(/[;\n]/)) {
    if (part.trim() === '') continue;
    const toks = tokenize(part);
    if (typeof toks === 'string') return { ok: false, message: `unexpected ${toks}` };
    const [name, op] = toks;
    if (name === undefined || name.t !== 'id' || !VAR_RE.test(name.v) || ['true', 'false', 'null', 'and', 'or', 'not', 'seen'].includes(name.v)) return { ok: false, message: `an effect starts with a variable name ("${part.trim().slice(0, 40)}")` };
    if (op === undefined || op.t !== 'op' || (op.v !== '=' && op.v !== '+=' && op.v !== '-=')) return { ok: false, message: `an effect is name = value, name += value or name -= value ("${part.trim().slice(0, 40)}")` };
    const p = new Parser(toks.slice(2));
    try {
      const value = p.expr();
      if (p.i < toks.length - 2) return { ok: false, message: `unexpected "${String(toks[p.i + 2]!.v)}" in "${part.trim().slice(0, 40)}"` };
      out.push({ name: name.v, op: op.v, value });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: true, effects: out };
}

/** What an expression reads: variables, bindings and the seen set (`seen(key)` gets the key as written). */
export interface DialogueEnv {
  variable(name: string): DialogueValue;
  binding(name: string): DialogueValue;
  seen(key: string): boolean;
}

const num = (v: DialogueValue): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' ? (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : 0) : 0);
/** Truthiness: false, null, 0 and "" are false. */
export const dialogueTruthy = (v: DialogueValue): boolean => !(v === false || v === null || v === 0 || v === '');
const finite = (n: number): number => (Number.isFinite(n) ? (Object.is(n, -0) ? 0 : n) : 0);

/** Evaluate an expression (total: every operation has a value; never throws). */
export function evalDialogueExpr(e: DialogueExpr, env: DialogueEnv): DialogueValue {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'var':
      return env.variable(e.name);
    case 'bind':
      return env.binding(e.name);
    case 'seen':
      return env.seen(e.key);
    case 'not':
      return !dialogueTruthy(evalDialogueExpr(e.a, env));
    case 'neg':
      return finite(-num(evalDialogueExpr(e.a, env)));
    case 'bin': {
      if (e.op === '&&') {
        const a = evalDialogueExpr(e.a, env);
        return dialogueTruthy(a) ? evalDialogueExpr(e.b, env) : a;
      }
      if (e.op === '||') {
        const a = evalDialogueExpr(e.a, env);
        return dialogueTruthy(a) ? a : evalDialogueExpr(e.b, env);
      }
      const a = evalDialogueExpr(e.a, env);
      const b = evalDialogueExpr(e.b, env);
      switch (e.op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '<':
        case '<=':
        case '>':
        case '>=': {
          const both = typeof a === 'string' && typeof b === 'string';
          const x = both ? a : num(a);
          const y = both ? b : num(b);
          return e.op === '<' ? x < y : e.op === '<=' ? x <= y : e.op === '>' ? x > y : x >= y;
        }
        case '+':
          if (typeof a === 'string' || typeof b === 'string') return (dialogueValueText(a) + dialogueValueText(b)).slice(0, DIALOGUE_LIMITS.variableText);
          return finite(num(a) + num(b));
        case '-':
          return finite(num(a) - num(b));
        case '*':
          return finite(num(a) * num(b));
        case '/':
          return num(b) === 0 ? 0 : finite(num(a) / num(b));
        case '%':
          return num(b) === 0 ? 0 : finite(num(a) % num(b));
      }
      return null;
    }
  }
}

/** A value as text in a line (`{name}`): numbers trimmed to 4 decimals, null empty. */
export function dialogueValueText(v: DialogueValue): string {
  if (v === null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 10_000) / 10_000);
  return typeof v === 'boolean' ? (v ? 'true' : 'false') : v;
}

/** The value an effect writes (texts clipped to the variable limit). */
export function applyDialogueEffect(before: DialogueValue, eff: DialogueEffect, env: DialogueEnv): DialogueValue {
  const v = evalDialogueExpr(eff.value, env);
  if (eff.op === '=') return typeof v === 'string' ? v.slice(0, DIALOGUE_LIMITS.variableText) : v;
  if (eff.op === '+=') {
    if (typeof before === 'string' || typeof v === 'string') return (dialogueValueText(before) + dialogueValueText(v)).slice(0, DIALOGUE_LIMITS.variableText);
    return finite(num(before) + num(v));
  }
  return finite(num(before) - num(v));
}

// ---------------------------------------------------------------------------
// Line text: values, pauses, visible characters
// ---------------------------------------------------------------------------

/**
 * A line's text as shown: `{name}` / `{$name}` replaced by values (`{{` stays
 * a literal brace for the rich-text parser), `[pause=s]` removed and noted at
 * the visible character it follows. `display` is 23.9a rich text read with
 * `values: false` (braces are text); `visible` counts its characters.
 */
export interface DialogueLineText {
  readonly display: string;
  readonly visible: number;
  /** Pauses of the reveal: after `at` visible characters, hold `seconds`. */
  readonly pauses: readonly { readonly at: number; readonly seconds: number }[];
}

const PAUSE_RE = /\[pause=(\d{1,2}(?:\.\d{1,3})?)\]/g;

export function dialogueLineText(text: string, value: (ref: string) => string): DialogueLineText {
  // Values first ({{ is a literal brace and stays escaped for the parser).
  let withValues = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === '{' && text[i + 1] === '{') {
      withValues += '{{';
      i += 1;
      continue;
    }
    if (c === '{') {
      const end = text.indexOf('}', i + 1);
      const ref = end > i + 1 ? text.slice(i + 1, end) : '';
      if (/^\$?[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(ref)) {
        withValues += value(ref).replace(/\{/g, '{{').replace(/\[/g, '[[');
        i = end;
        continue;
      }
    }
    withValues += c;
  }
  // Pauses: split on the tags and count the visible characters before each.
  const pauses: { at: number; seconds: number }[] = [];
  let display = '';
  let last = 0;
  PAUSE_RE.lastIndex = 0;
  for (let m = PAUSE_RE.exec(withValues); m !== null; m = PAUSE_RE.exec(withValues)) {
    // A "[[pause=1]" is a literal: skip it (an odd count of "[" before it).
    let brackets = 0;
    for (let j = m.index - 1; j >= 0 && withValues[j] === '['; j -= 1) brackets += 1;
    if (brackets % 2 === 1) continue;
    display += withValues.slice(last, m.index);
    last = m.index + m[0].length;
    const at = richTextVisibleLength(parseRichText(closeOpenTags(display), { values: false }));
    pauses.push({ at, seconds: Math.min(10, Number(m[1])) });
  }
  display += withValues.slice(last);
  return { display, visible: richTextVisibleLength(parseRichText(display, { values: false })), pauses };
}

/** Count visible characters of a prefix: unbalanced open tags there are fine (the parser shows unknown tags as text, so close them). */
function closeOpenTags(prefix: string): string {
  const stack: string[] = [];
  const re = /\[(\/?)(b|i|color|size)(?:=[^\]]*)?\]/g;
  for (let m = re.exec(prefix); m !== null; m = re.exec(prefix)) {
    if (m[1] === '/') {
      if (stack[stack.length - 1] === m[2]) stack.pop();
    } else stack.push(m[2]!);
  }
  return prefix + stack.reverse().map((t) => `[/${t}]`).join('');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (path: string, found: unknown, message: string, expected: string): ModelErrorV2 => withFound({ code: 'field_value', path, message, expected }, found);
const isName = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 1 && v.length <= DIALOGUE_LIMITS.nameChars && !/[\u0000-\u001f\u007f]/.test(v);

/** Why a node's expression fields do not parse (per node), shared with the editor's diagnostics. */
export function dialogueNodeProblems(node: GraphNode): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  const def = DIALOGUE_GRAPH_KIND.nodes.find((n) => n.type === node.type);
  const field = (key: string): string => {
    const f = def?.fields?.find((x) => x.key === key);
    const v = f !== undefined ? nodeFieldValue(node, f) : '';
    return typeof v === 'string' ? v : '';
  };
  if (node.type === 'option' || node.type === 'branch') {
    const c = parseDialogueCondition(field('condition'));
    if (!c.ok) out.push({ field: 'condition', message: c.message });
  }
  if (node.type === 'option' || node.type === 'set') {
    const e = parseDialogueEffects(field('effects'));
    if (!e.ok) out.push({ field: 'effects', message: e.message });
  }
  return out;
}

export function validateDialogue(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isObj(v)) {
    errors.push(fieldType(path, v, 'object'));
    return;
  }
  for (const k of Object.keys(v)) if (!['dialogueId', 'name', 'graph'].includes(k)) errors.push(unexpectedField(`${path}/${k}`, k, 'dialogueId, name, graph'));
  if (typeof v['dialogueId'] !== 'string' || !ID_RE.test(v['dialogueId'])) errors.push(bad(`${path}/dialogueId`, v['dialogueId'], 'a dialogue id is 1–64 lower-case letters, digits, _ or - (starting with a letter or digit)', 'an id'));
  if (!isName(v['name'])) errors.push(bad(`${path}/name`, v['name'], `a name is 1–${DIALOGUE_LIMITS.nameChars} characters`, 'a name'));
  const before = errors.length;
  validateGraphData(DIALOGUE_GRAPH_KIND, v['graph'], `${path}/graph`, errors);
  if (errors.length > before || !isObj(v['graph'])) return;
  const graph = v['graph'] as unknown as GraphData;
  graph.nodes.forEach((n, i) => {
    for (const p of dialogueNodeProblems(n)) errors.push(bad(`${path}/graph/nodes/${i}/data/${p.field}`, n.data?.[p.field], `${p.field} of node ${n.id}: ${p.message}`, 'an expression'));
    if (n.type === 'line') {
      const sp = n.data?.['speaker'];
      if (typeof sp === 'string' && sp !== '' && !ID_RE.test(sp) && !/^\$[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(sp)) errors.push(bad(`${path}/graph/nodes/${i}/data/speaker`, sp, 'a speaker is a speaker id, a $binding or "" (narration)', 'a speaker id'));
      const ex = n.data?.['expression'];
      if (typeof ex === 'string' && ex !== '' && !EXPR_ID_RE.test(ex)) errors.push(bad(`${path}/graph/nodes/${i}/data/expression`, ex, 'an expression id is 1–32 letters, digits, _ or -', 'an expression id'));
    }
  });
  // Entry names are unique in a conversation.
  const names = new Set<string>();
  graph.nodes.forEach((n, i) => {
    if (n.type !== 'entry') return;
    const name = String(n.data?.['name'] ?? 'entry');
    if (names.has(name)) errors.push(bad(`${path}/graph/nodes/${i}/data/name`, name, 'entry names are unique in a conversation', 'a new name'));
    names.add(name);
  });
}

export function validateDialogues(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(v)) {
    errors.push(fieldType(path, v, 'array'));
    return;
  }
  if (v.length > DIALOGUE_LIMITS.dialogues) errors.push(withFound({ code: 'limits_exceeded', path, message: `at most ${DIALOGUE_LIMITS.dialogues} dialogues`, expected: `<= ${DIALOGUE_LIMITS.dialogues}` }, v.length));
  const ids = new Set<string>();
  v.forEach((d, i) => {
    validateDialogue(d, `${path}/${i}`, errors);
    if (isObj(d) && typeof d['dialogueId'] === 'string') {
      if (ids.has(d['dialogueId'])) errors.push(withFound({ code: 'id_duplicate', path: `${path}/${i}/dialogueId`, message: 'dialogue ids are unique' }, d['dialogueId']));
      ids.add(d['dialogueId']);
    }
  });
}

const SPEAKER_KEYS = ['speakerId', 'name', 'color', 'portraits', 'defaultExpression', 'voiceProfile', 'blip', 'blipEvery', 'blipVolume'];

export function validateSpeaker(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isObj(v)) {
    errors.push(fieldType(path, v, 'object'));
    return;
  }
  for (const k of Object.keys(v)) if (!SPEAKER_KEYS.includes(k)) errors.push(unexpectedField(`${path}/${k}`, k, SPEAKER_KEYS.join(', ')));
  if (typeof v['speakerId'] !== 'string' || !ID_RE.test(v['speakerId'])) errors.push(bad(`${path}/speakerId`, v['speakerId'], 'a speaker id is 1–64 lower-case letters, digits, _ or -', 'an id'));
  if (!isName(v['name'])) errors.push(bad(`${path}/name`, v['name'], `a name is 1–${DIALOGUE_LIMITS.nameChars} characters`, 'a name'));
  if (v['color'] !== undefined && (typeof v['color'] !== 'string' || !COLOR_RE.test(v['color']))) errors.push(bad(`${path}/color`, v['color'], 'a colour is #rrggbb (lower case)', '#rrggbb'));
  const portraits = v['portraits'];
  if (portraits !== undefined) {
    if (!isObj(portraits)) errors.push(fieldType(`${path}/portraits`, portraits, 'object'));
    else {
      const keys = Object.keys(portraits);
      if (keys.length > DIALOGUE_LIMITS.portraits) errors.push(withFound({ code: 'limits_exceeded', path: `${path}/portraits`, message: `at most ${DIALOGUE_LIMITS.portraits} portraits`, expected: `<= ${DIALOGUE_LIMITS.portraits}` }, keys.length));
      for (const k of keys) {
        if (!EXPR_ID_RE.test(k)) errors.push(bad(`${path}/portraits/${k}`, k, 'an expression id is 1–32 letters, digits, _ or -', 'an expression id'));
        if (typeof portraits[k] !== 'string' || !ID_RE.test(portraits[k] as string)) errors.push(bad(`${path}/portraits/${k}`, portraits[k], 'a portrait is a texture asset id', 'an asset id'));
      }
    }
  }
  if (v['defaultExpression'] !== undefined && (typeof v['defaultExpression'] !== 'string' || !EXPR_ID_RE.test(v['defaultExpression']))) errors.push(bad(`${path}/defaultExpression`, v['defaultExpression'], 'an expression id is 1–32 letters, digits, _ or -', 'an expression id'));
  if (v['voiceProfile'] !== undefined && (typeof v['voiceProfile'] !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(v['voiceProfile']))) errors.push(bad(`${path}/voiceProfile`, v['voiceProfile'], 'a voice profile is 1–64 letters, digits, _ . : or -', 'an id'));
  if (v['blip'] !== undefined && (typeof v['blip'] !== 'string' || !ID_RE.test(v['blip']))) errors.push(bad(`${path}/blip`, v['blip'], 'a blip is an audio asset id', 'an asset id'));
  if (v['blipEvery'] !== undefined && !(typeof v['blipEvery'] === 'number' && Number.isInteger(v['blipEvery']) && v['blipEvery'] >= 1 && v['blipEvery'] <= 16)) errors.push(bad(`${path}/blipEvery`, v['blipEvery'], 'blipEvery is a whole number 1–16', '1..16'));
  if (v['blipVolume'] !== undefined && !(typeof v['blipVolume'] === 'number' && v['blipVolume'] >= 0 && v['blipVolume'] <= 1)) errors.push(bad(`${path}/blipVolume`, v['blipVolume'], 'blipVolume is 0–1', '0..1'));
}

export function validateSpeakers(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(v)) {
    errors.push(fieldType(path, v, 'array'));
    return;
  }
  if (v.length > DIALOGUE_LIMITS.speakers) errors.push(withFound({ code: 'limits_exceeded', path, message: `at most ${DIALOGUE_LIMITS.speakers} speakers`, expected: `<= ${DIALOGUE_LIMITS.speakers}` }, v.length));
  const ids = new Set<string>();
  v.forEach((s, i) => {
    validateSpeaker(s, `${path}/${i}`, errors);
    if (isObj(s) && typeof s['speakerId'] === 'string') {
      if (ids.has(s['speakerId'])) errors.push(withFound({ code: 'id_duplicate', path: `${path}/${i}/speakerId`, message: 'speaker ids are unique' }, s['speakerId']));
      ids.add(s['speakerId']);
    }
  });
}

const SETTINGS_KEYS = ['textSpeed', 'autoAdvance', 'autoDelay', 'duck', 'backlog', 'document', 'theme'];

export function validateDialogueSettings(v: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isObj(v)) {
    errors.push(fieldType(path, v, 'object'));
    return;
  }
  for (const k of Object.keys(v)) if (!SETTINGS_KEYS.includes(k)) errors.push(unexpectedField(`${path}/${k}`, k, SETTINGS_KEYS.join(', ')));
  const range = (k: string, lo: number, hi: number, int = false): void => {
    const x = v[k];
    if (x !== undefined && !(typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi && (!int || Number.isInteger(x)))) errors.push(bad(`${path}/${k}`, x, `${k} is a ${int ? 'whole ' : ''}number ${lo}–${hi}`, `${lo}..${hi}`));
  };
  range('textSpeed', 0, 1000);
  range('autoDelay', 0, 10);
  range('duck', 0, 1);
  range('backlog', 1, DIALOGUE_LIMITS.backlog, true);
  if (v['autoAdvance'] !== undefined && typeof v['autoAdvance'] !== 'boolean') errors.push(fieldType(`${path}/autoAdvance`, v['autoAdvance'], 'boolean'));
  for (const k of ['document', 'theme']) if (v[k] !== undefined && (typeof v[k] !== 'string' || !ID_RE.test(v[k] as string))) errors.push(bad(`${path}/${k}`, v[k], `${k} is a UI ${k} id`, 'an id'));
}

/**
 * The references a project's dialogue content makes (checked on the whole
 * content): line speakers exist (or are "" / a $binding), assets have the
 * right kind (voice: audio or music; portraits: texture; blip: audio), a
 * Jump names a conversation (and one of its entries), the settings name a
 * UI document (or the engine's) and theme of the project.
 */
export function validateDialogueReferences(
  doc: { dialogues?: unknown; speakers?: unknown; dialogueSettings?: unknown; uiDocuments?: unknown; uiThemes?: unknown },
  errors: ModelErrorV2[],
  assetKind: (id: string) => unknown,
): void {
  const dialogues = Array.isArray(doc.dialogues) ? (doc.dialogues as DialogueDocument[]) : [];
  const speakers = Array.isArray(doc.speakers) ? (doc.speakers as DialogueSpeaker[]) : [];
  const speakerIds = new Set(speakers.map((s) => s.speakerId));
  const entriesOf = new Map(dialogues.map((d) => [d.dialogueId, new Set(d.graph.nodes.filter((n) => n.type === 'entry').map((n) => String(n.data?.['name'] ?? 'entry')))] as const));
  dialogues.forEach((d, i) => {
    d.graph.nodes.forEach((n, j) => {
      const at = `/dialogues/${i}/graph/nodes/${j}/data`;
      if (n.type === 'line') {
        const sp = n.data?.['speaker'];
        if (typeof sp === 'string' && sp !== '' && !sp.startsWith('$') && !speakerIds.has(sp)) errors.push(withFound({ code: 'reference_missing', path: `${at}/speaker`, message: `line ${n.id} names the speaker "${sp}", which is not in content.speakers`, expected: 'a speakerId' }, sp));
        const voice = n.data?.['voice'];
        if (typeof voice === 'string' && voice !== '' && assetKind(voice) !== 'audio' && assetKind(voice) !== 'music') errors.push(withFound({ code: 'asset_reference_missing', path: `${at}/voice`, message: `line ${n.id}'s voice clip must name an audio or music asset of this project`, expected: 'an audio or music assetId' }, voice));
      } else if (n.type === 'jump') {
        const target = String(n.data?.['dialogue'] ?? '');
        const entry = String(n.data?.['entry'] ?? '');
        const entries = entriesOf.get(target);
        if (entries === undefined) errors.push(withFound({ code: 'reference_missing', path: `${at}/dialogue`, message: `jump ${n.id} names the dialogue "${target}", which is not in this project`, expected: 'a dialogueId' }, target));
        else if (entry !== '' && !entries.has(entry)) errors.push(withFound({ code: 'reference_missing', path: `${at}/entry`, message: `jump ${n.id} names the entry "${entry}", which dialogue "${target}" does not have`, expected: 'an entry name' }, entry));
      }
    });
  });
  speakers.forEach((s, i) => {
    for (const [expr, id] of Object.entries(s.portraits ?? {})) if (assetKind(id) !== 'texture') errors.push(withFound({ code: 'asset_reference_missing', path: `/speakers/${i}/portraits/${expr}`, message: 'a portrait must name a texture asset of this project', expected: 'a texture assetId' }, id));
    if (s.blip !== undefined && assetKind(s.blip) !== 'audio') errors.push(withFound({ code: 'asset_reference_missing', path: `/speakers/${i}/blip`, message: 'a text blip must name an audio asset of this project', expected: 'an audio assetId' }, s.blip));
  });
  const settings = isObj(doc.dialogueSettings) ? (doc.dialogueSettings as DialogueSettings) : null;
  if (settings !== null) {
    const docs = Array.isArray(doc.uiDocuments) ? (doc.uiDocuments as { uiDocumentId: string }[]).map((d) => d.uiDocumentId) : [];
    if (settings.document !== undefined && settings.document !== DIALOGUE_DOCUMENT_ID && !docs.includes(settings.document)) errors.push(withFound({ code: 'reference_missing', path: '/dialogueSettings/document', message: `the dialogue document "${settings.document}" is not a UI document of this project`, expected: 'a uiDocumentId' }, settings.document));
    const themes = Array.isArray(doc.uiThemes) ? (doc.uiThemes as { uiThemeId: string }[]).map((t) => t.uiThemeId) : [];
    if (settings.theme !== undefined && !themes.includes(settings.theme)) errors.push(withFound({ code: 'reference_missing', path: '/dialogueSettings/theme', message: `the dialogue theme "${settings.theme}" is not a UI theme of this project`, expected: 'a uiThemeId' }, settings.theme));
  }
}

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

export function canonicalDialogue(d: DialogueDocument): DialogueDocument {
  return { dialogueId: d.dialogueId, name: d.name, graph: canonicalGraphData(d.graph) };
}
export function canonicalDialogues(list: readonly DialogueDocument[]): DialogueDocument[] {
  return [...list].sort((a, b) => (a.dialogueId < b.dialogueId ? -1 : a.dialogueId > b.dialogueId ? 1 : 0)).map(canonicalDialogue);
}
export function canonicalSpeaker(s: DialogueSpeaker): DialogueSpeaker {
  const portraits = s.portraits !== undefined ? Object.keys(s.portraits).sort() : [];
  return {
    speakerId: s.speakerId,
    name: s.name,
    ...(s.color !== undefined ? { color: s.color } : {}),
    ...(portraits.length > 0 ? { portraits: Object.fromEntries(portraits.map((k) => [k, s.portraits![k]!])) } : {}),
    ...(s.defaultExpression !== undefined ? { defaultExpression: s.defaultExpression } : {}),
    ...(s.voiceProfile !== undefined ? { voiceProfile: s.voiceProfile } : {}),
    ...(s.blip !== undefined ? { blip: s.blip } : {}),
    ...(s.blipEvery !== undefined ? { blipEvery: s.blipEvery } : {}),
    ...(s.blipVolume !== undefined ? { blipVolume: s.blipVolume } : {}),
  };
}
export function canonicalSpeakers(list: readonly DialogueSpeaker[]): DialogueSpeaker[] {
  return [...list].sort((a, b) => (a.speakerId < b.speakerId ? -1 : a.speakerId > b.speakerId ? 1 : 0)).map(canonicalSpeaker);
}
export function canonicalDialogueSettings(s: DialogueSettings): DialogueSettings {
  const out: DialogueSettings = {};
  for (const k of SETTINGS_KEYS as (keyof DialogueSettings)[]) if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  return out;
}

/** The assets dialogue content uses (they travel with the game): voice clips, portraits, blips. */
export function dialogueAssetRefs(content: { dialogues?: readonly DialogueDocument[]; speakers?: readonly DialogueSpeaker[] }): string[] {
  const out = new Set<string>();
  for (const d of content.dialogues ?? []) for (const n of d.graph.nodes) if (n.type === 'line' && typeof n.data?.['voice'] === 'string' && n.data['voice'] !== '') out.add(n.data['voice']);
  for (const s of content.speakers ?? []) {
    for (const id of Object.values(s.portraits ?? {})) out.add(id);
    if (s.blip !== undefined) out.add(s.blip);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// The compiled runtime form
// ---------------------------------------------------------------------------

export type RuntimeDialogueNode =
  | { readonly t: 'line'; readonly speaker: string; readonly expression: string; readonly text: string; readonly voice: string; readonly auto: 'default' | 'on' | 'off'; readonly next: string | null }
  | { readonly t: 'choice'; readonly options: readonly RuntimeDialogueOption[]; readonly none: string | null }
  | { readonly t: 'branch'; readonly condition: string; readonly then: string | null; readonly else: string | null }
  | { readonly t: 'set'; readonly effects: string; readonly next: string | null }
  | { readonly t: 'signal'; readonly name: string; readonly value: string; readonly wait: boolean; readonly next: string | null }
  | { readonly t: 'wait'; readonly seconds: number; readonly next: string | null }
  | { readonly t: 'jump'; readonly dialogue: string; readonly entry: string }
  | { readonly t: 'goto'; readonly next: string | null }
  | { readonly t: 'end' };

export interface RuntimeDialogueOption {
  readonly id: string;
  readonly text: string;
  readonly condition: string;
  readonly effects: string;
  readonly once: boolean;
  readonly next: string | null;
}

export interface RuntimeDialogue {
  readonly dialogueId: string;
  readonly name: string;
  /** The Start node's next (null: an empty conversation). */
  readonly start: string | null;
  /** Entry name → the node after it. */
  readonly entries: Readonly<Record<string, string | null>>;
  readonly nodes: Readonly<Record<string, RuntimeDialogueNode>>;
}

/** Everything the runtime's dialogue runner needs (the snapshot's `dialogue` field). */
export interface RuntimeDialogueData {
  readonly dialogues: readonly RuntimeDialogue[];
  readonly speakers: readonly DialogueSpeaker[];
  readonly settings: DialogueSettings;
  /** The UI document the runner shows and hides. */
  readonly document: string;
  /** Voice clip lengths in seconds (auto-advance waits for them; absent: the clip's end is not known). */
  readonly voiceSeconds: Readonly<Record<string, number>>;
}

const byPos = (a: GraphNode, b: GraphNode): number => a.position[1] - b.position[1] || a.position[0] - b.position[0] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Compile one conversation's graph to the runner's node table (wires become next pointers; options ordered top to bottom, then left to right). */
export function compileDialogue(d: DialogueDocument): RuntimeDialogue {
  const g = d.graph;
  const nodeById = new Map(g.nodes.map((n) => [n.id, n] as const));
  const out = (id: string, port: string): string | null => g.edges.find((e) => e.from.node === id && e.from.port === port)?.to.node ?? null;
  const str = (n: GraphNode, key: string): string => {
    const f = DIALOGUE_GRAPH_KIND.nodes.find((x) => x.type === n.type)?.fields?.find((x) => x.key === key);
    const v = f !== undefined ? nodeFieldValue(n, f) : '';
    return typeof v === 'string' ? v : String(v);
  };
  const nodes: Record<string, RuntimeDialogueNode> = {};
  const entries: Record<string, string | null> = {};
  let start: string | null = null;
  for (const n of [...g.nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    switch (n.type) {
      case 'start':
        start = out(n.id, 'next');
        break;
      case 'entry':
        entries[str(n, 'name')] = out(n.id, 'next');
        nodes[n.id] = { t: 'goto', next: out(n.id, 'next') };
        break;
      case 'line':
        nodes[n.id] = { t: 'line', speaker: str(n, 'speaker'), expression: str(n, 'expression'), text: str(n, 'text'), voice: str(n, 'voice'), auto: str(n, 'auto') as 'default' | 'on' | 'off', next: out(n.id, 'next') };
        break;
      case 'choice': {
        const opts = g.edges
          .filter((e) => e.from.node === n.id && e.from.port === 'options')
          .map((e) => nodeById.get(e.to.node))
          .filter((x): x is GraphNode => x !== undefined && x.type === 'option')
          .sort(byPos);
        nodes[n.id] = { t: 'choice', options: opts.map((o) => ({ id: o.id, text: str(o, 'text'), condition: str(o, 'condition'), effects: str(o, 'effects'), once: o.data?.['once'] === true, next: out(o.id, 'next') })), none: out(n.id, 'none') };
        break;
      }
      case 'option':
        // Reached only through its choice; a wire into it from elsewhere continues after it.
        nodes[n.id] = { t: 'goto', next: out(n.id, 'next') };
        break;
      case 'branch':
        nodes[n.id] = { t: 'branch', condition: str(n, 'condition'), then: out(n.id, 'true'), else: out(n.id, 'false') };
        break;
      case 'set':
        nodes[n.id] = { t: 'set', effects: str(n, 'effects'), next: out(n.id, 'next') };
        break;
      case 'signal':
        nodes[n.id] = { t: 'signal', name: str(n, 'name'), value: str(n, 'value'), wait: n.data?.['wait'] === true, next: out(n.id, 'next') };
        break;
      case 'wait': {
        const s = n.data?.['seconds'];
        nodes[n.id] = { t: 'wait', seconds: typeof s === 'number' ? s : 1, next: out(n.id, 'next') };
        break;
      }
      case 'jump':
        nodes[n.id] = { t: 'jump', dialogue: str(n, 'dialogue'), entry: str(n, 'entry') };
        break;
      case 'end':
        nodes[n.id] = { t: 'end' };
        break;
    }
  }
  return { dialogueId: d.dialogueId, name: d.name, start, entries, nodes };
}

/**
 * The runner's data from the project's dialogue content (null: no
 * conversations — the snapshot has no `dialogue` field and nothing changes
 * for projects without dialogue). `voiceSeconds` maps voice clips to their
 * recorded length.
 */
export function dialogueForRuntime(
  content: { dialogues?: readonly DialogueDocument[]; speakers?: readonly DialogueSpeaker[]; dialogueSettings?: DialogueSettings },
  voiceSeconds: (assetId: string) => number | null,
): RuntimeDialogueData | null {
  const dialogues = content.dialogues ?? [];
  if (dialogues.length === 0) return null;
  const seconds: Record<string, number> = {};
  for (const d of dialogues) {
    for (const n of d.graph.nodes) {
      const v = n.type === 'line' ? n.data?.['voice'] : undefined;
      if (typeof v === 'string' && v !== '' && seconds[v] === undefined) {
        const s = voiceSeconds(v);
        if (s !== null && Number.isFinite(s) && s > 0) seconds[v] = s;
      }
    }
  }
  const settings = content.dialogueSettings ?? {};
  return {
    dialogues: dialogues.map(compileDialogue),
    speakers: canonicalSpeakers(content.speakers ?? []),
    settings: canonicalDialogueSettings(settings),
    document: settings.document ?? DIALOGUE_DOCUMENT_ID,
    voiceSeconds: seconds,
  };
}

/** A runtime dialogue data value is well formed (the snapshot check; built by `dialogueForRuntime`). */
export function runtimeDialogueDataProblem(v: unknown): string | null {
  if (!isObj(v)) return 'dialogue is an object';
  if (!Array.isArray(v['dialogues']) || v['dialogues'].length > DIALOGUE_LIMITS.dialogues) return `dialogue.dialogues is a list of at most ${DIALOGUE_LIMITS.dialogues}`;
  for (const d of v['dialogues'] as unknown[]) {
    if (!isObj(d) || typeof d['dialogueId'] !== 'string' || !isObj(d['nodes']) || !isObj(d['entries'])) return 'a dialogue is { dialogueId, name, start, entries, nodes }';
    if (Object.keys(d['nodes']).length > DIALOGUE_LIMITS.nodes) return `a dialogue has at most ${DIALOGUE_LIMITS.nodes} nodes`;
    for (const [id, n] of Object.entries(d['nodes'])) if (!GRAPH_ITEM_ID_RE.test(id) || !isObj(n) || typeof n['t'] !== 'string') return `dialogue ${String(d['dialogueId'])} node ${id.slice(0, 64)} is malformed`;
  }
  if (!Array.isArray(v['speakers'])) return 'dialogue.speakers is a list';
  const errors: ModelErrorV2[] = [];
  validateSpeakers(v['speakers'], '/dialogue/speakers', errors);
  if (!isObj(v['settings'])) return 'dialogue.settings is an object';
  validateDialogueSettings(v['settings'], '/dialogue/settings', errors);
  if (errors.length > 0) return errors[0]!.message;
  if (typeof v['document'] !== 'string' || !ID_RE.test(v['document'])) return 'dialogue.document is a UI document id';
  if (!isObj(v['voiceSeconds'])) return 'dialogue.voiceSeconds maps assets to seconds';
  for (const s of Object.values(v['voiceSeconds'])) if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return 'a voice length is a positive number of seconds';
  return null;
}

// ---------------------------------------------------------------------------
// The engine's default dialogue UI document
// ---------------------------------------------------------------------------

/**
 * The engine-provided dialogue UI (a 23.9a UI document, id `tl-dialogue`):
 * a box at the bottom with the portrait, the name plate (the speaker's
 * colour), the typewriter text (a text widget with `content` + `reveal`),
 * the choices (a list of buttons), Auto / Skip / Log buttons and a backlog
 * view. It binds only to the paths the runner publishes under `dialogue.`,
 * so a project reskins it with a theme (`dialogueSettings.theme`; style
 * names below) or replaces it with its own document bound the same way.
 *
 * Style names a theme may define: dialogueBox, dialogueName, dialogueText,
 * dialoguePortrait, dialogueChoice, dialogueButton, dialogueBacklog,
 * dialogueBacklogName, dialogueBacklogText. Neutral look: dark translucent
 * panels, white text, readable at 720p (the reference size).
 */
export function dialogueUiDocument(theme?: string): UiDocument {
  const ADV = { do: 'dialogue', input: 'advance' } as const;
  return {
    uiDocumentId: DIALOGUE_DOCUMENT_ID,
    name: 'Dialogue (engine)',
    layer: 50,
    focus: true,
    actionMap: 'ui',
    ...(theme !== undefined ? { theme } : {}),
    scale: { reference: [1280, 720], mode: 'fit' },
    onCancel: { do: 'dialogue', input: 'backlog' },
    initialFocus: 'box',
    styles: {
      dialogueBox: { background: '#101218e0', color: '#ffffff', padding: [14, 18, 14, 18], radius: 10, borderWidth: 1, borderColor: '#ffffff30', focus: { borderColor: '#ffffff80' } },
      dialogueName: { color: '#ffd480', fontSize: 22, bold: true, textShadow: '#000000' },
      dialogueText: { color: '#ffffff', fontSize: 22, lineHeight: 1.35, textShadow: '#000000' },
      dialoguePortrait: { radius: 8 },
      dialogueChoice: { background: '#1c2130e8', color: '#ffffff', fontSize: 20, padding: [8, 16, 8, 16], radius: 8, borderWidth: 1, borderColor: '#ffffff30', hover: { borderColor: '#ffffffa0' }, focus: { background: '#e0a030', color: '#101218' } },
      dialogueButton: { background: '#00000080', color: '#ffffffc0', fontSize: 14, padding: [3, 10, 3, 10], radius: 6, focus: { color: '#ffffff', background: '#e0a030a0' }, hover: { color: '#ffffff' } },
      dialogueBacklog: { background: '#0a0c10f0', color: '#ffffff', padding: 20, radius: 10 },
      dialogueBacklogName: { color: '#ffd480', fontSize: 16, bold: true },
      dialogueBacklogText: { color: '#ffffff', fontSize: 16 },
    },
    tweens: { in: { kind: 'fade', duration: 0.15 } },
    showTween: 'in',
    root: {
      type: 'panel',
      stretch: 'both',
      children: [
        {
          id: 'portrait',
          type: 'image',
          anchor: [0, 1],
          pivot: [0, 1],
          offset: [40, -196],
          size: [220, 220],
          fit: 'contain',
          style: 'dialoguePortrait',
          image: { bind: 'dialogue.line.portrait' },
          visible: { bind: 'dialogue.line.hasPortrait' },
        },
        {
          id: 'box',
          type: 'button',
          anchor: [0.5, 1],
          pivot: [0.5, 1],
          offset: [0, -24],
          size: [1160, 160],
          style: 'dialogueBox',
          visible: { bind: 'dialogue.showLine' },
          onClick: ADV,
          children: [
            { id: 'name', type: 'text', anchor: [0, 0], pivot: [0, 0], offset: [0, 0], style: 'dialogueName', content: { bind: 'dialogue.line.name' } },
            { id: 'text', type: 'text', anchor: [0, 0], pivot: [0, 0], offset: [0, 32], size: [1120, 100], style: 'dialogueText', content: { bind: 'dialogue.line.text' }, reveal: { bind: 'dialogue.line.reveal' } },
            { id: 'more', type: 'text', anchor: [1, 1], pivot: [1, 1], offset: [0, 0], style: 'dialogueName', text: '▼', visible: { bind: 'dialogue.line.done' } },
          ],
        },
        {
          id: 'choices',
          type: 'list',
          anchor: [0.5, 1],
          pivot: [0.5, 1],
          offset: [0, -200],
          direction: 'column',
          gap: 8,
          align: 'center',
          visible: { bind: 'dialogue.showChoices' },
          items: { bind: 'dialogue.choices' },
          template: { id: 'choice', type: 'button', style: 'dialogueChoice', size: [640, null], text: '{$item.text}', onClick: { do: 'dialogue', input: 'choose' } },
        },
        {
          id: 'controls',
          type: 'stack',
          anchor: [1, 1],
          pivot: [1, 1],
          offset: [-44, -190],
          direction: 'row',
          gap: 6,
          visible: { bind: 'dialogue.active' },
          children: [
            { id: 'auto', type: 'button', style: 'dialogueButton', text: 'Auto', focusable: false, onClick: { do: 'dialogue', input: 'auto' } },
            { id: 'skip', type: 'button', style: 'dialogueButton', text: 'Skip', focusable: false, onClick: { do: 'dialogue', input: 'skip' } },
            { id: 'log', type: 'button', style: 'dialogueButton', text: 'Log', focusable: false, onClick: { do: 'dialogue', input: 'backlog' } },
          ],
        },
        {
          id: 'backlog',
          type: 'stack',
          anchor: [0.5, 0.5],
          pivot: [0.5, 0.5],
          size: [900, 560],
          direction: 'column',
          gap: 8,
          style: 'dialogueBacklog',
          visible: { bind: 'dialogue.backlogOpen' },
          children: [
            { id: 'backlogTitle', type: 'text', style: 'dialogueBacklogName', text: 'Log' },
            {
              id: 'backlogList',
              type: 'list',
              direction: 'column',
              gap: 6,
              grow: 1,
              items: { bind: 'dialogue.backlogRecent' },
              template: {
                id: 'entry',
                type: 'stack',
                direction: 'column',
                gap: 0,
                children: [
                  { id: 'entryName', type: 'text', style: 'dialogueBacklogName', content: { bind: '$item.name' } },
                  { id: 'entryText', type: 'text', style: 'dialogueBacklogText', content: { bind: '$item.text' } },
                ],
              },
            },
            { id: 'backlogClose', type: 'button', style: 'dialogueButton', text: 'Close', onClick: { do: 'dialogue', input: 'backlog' } },
          ],
        },
      ],
    },
  } as unknown as UiDocument;
}

/**
 * The UI documents a game draws: the project's, plus the engine's dialogue
 * document when the project has conversations, uses the default document
 * and has no document of that id itself.
 */
export function withDialogueUiDocument(docs: readonly UiDocument[] | undefined, dialogue: RuntimeDialogueData | null): UiDocument[] | undefined {
  if (dialogue === null || dialogue.document !== DIALOGUE_DOCUMENT_ID || (docs ?? []).some((d) => d.uiDocumentId === DIALOGUE_DOCUMENT_ID)) return docs === undefined ? undefined : [...docs];
  return [...(docs ?? []), dialogueUiDocument(dialogue.settings.theme)];
}
