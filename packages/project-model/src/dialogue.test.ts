/**
 * Dialogue data rules — the expression language (conditions and
 * effects), line text (values, pauses, visible characters), validation and
 * references, the compiled form, and the engine's default dialogue document.
 */
import { describe, expect, it } from 'vitest';

import {
  compileDialogue,
  DIALOGUE_DOCUMENT_ID,
  dialogueLineText,
  dialogueUiDocument,
  evalDialogueExpr,
  newDialogueGraph,
  parseDialogueCondition,
  parseDialogueEffects,
  applyDialogueEffect,
  validateDialogue,
  validateDialogueReferences,
  validateDialogueSettings,
  validateSpeaker,
  withDialogueUiDocument,
  type DialogueDocument,
  type DialogueEnv,
  type DialogueValue,
} from './dialogue';
import type { ModelErrorV2 } from './errors';
import { validateUiDocument } from './ui-documents';
import { parseRichText } from './rich-text';

const env = (vars: Record<string, DialogueValue>, binds: Record<string, DialogueValue> = {}, seen: string[] = []): DialogueEnv => ({ variable: (n) => vars[n] ?? null, binding: (n) => binds[n] ?? null, seen: (k) => seen.includes(k) });
const cond = (src: string, e: DialogueEnv): DialogueValue => {
  const p = parseDialogueCondition(src);
  if (!p.ok) throw new Error(p.message);
  return p.expr === null ? true : evalDialogueExpr(p.expr, e);
};

describe('dialogue expressions', () => {
  it('evaluates conditions: literals, variables, bindings, operators, precedence, seen()', () => {
    const e = env({ gold: 5, name: 'Ada', met: true }, { npc: 'guide' }, ['intro/l1']);
    expect(cond('', e)).toBe(true);
    expect(cond('gold >= 5 && met', e)).toBe(true);
    expect(cond('gold > 5 or not met', e)).toBe(false);
    expect(cond('1 + 2 * 3', e)).toBe(7);
    expect(cond('(1 + 2) * 3', e)).toBe(9);
    expect(cond('"a" + name', e)).toBe('aAda');
    expect(cond("$npc == 'guide'", e)).toBe(true);
    expect(cond('missing == null', e)).toBe(true);
    expect(cond('seen("intro/l1") && !seen("intro/l2")', e)).toBe(true);
    expect(cond('10 / 0', e)).toBe(0);
    expect(cond('-gold', e)).toBe(-5);
  });

  it('refuses malformed conditions with a message', () => {
    for (const bad of ['gold >', '(1 + 2', 'foo(1)', 'a ? b', "'open", '1 2', 'and']) {
      const p = parseDialogueCondition(bad);
      expect(p.ok, bad).toBe(false);
    }
  });

  it('parses and applies effects: =, +=, -= separated by ; or new lines', () => {
    const p = parseDialogueEffects('tea = true; cups += 2\nname = "Bo" + "b"; gold -= 1');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const vars: Record<string, DialogueValue> = { gold: 3 };
    for (const eff of p.effects) vars[eff.name] = applyDialogueEffect(vars[eff.name] ?? null, eff, env(vars));
    expect(vars).toEqual({ gold: 2, tea: true, cups: 2, name: 'Bob' });
    expect(parseDialogueEffects('1 = 2').ok).toBe(false);
    expect(parseDialogueEffects('x == 2').ok).toBe(false);
    expect(parseDialogueEffects('x = ').ok).toBe(false);
  });
});

describe('dialogue line text', () => {
  it('replaces values, strips pauses at the right visible character and counts characters like the host', () => {
    const t = dialogueLineText('Hi [b]{name}[/b],[pause=0.5] have {n} [color=#ff0000]cups[/color].', (ref) => (ref === 'name' ? 'Ada' : ref === 'n' ? '2' : ''));
    expect(t.display).toBe('Hi [b]Ada[/b], have 2 [color=#ff0000]cups[/color].');
    expect(t.pauses).toEqual([{ at: 7, seconds: 0.5 }]);
    expect(t.visible).toBe('Hi Ada, have 2 cups.'.length);
  });
  it('escapes markup inside values and keeps literal brackets', () => {
    const t = dialogueLineText('Say {x} [[pause=1] {{y}', () => '[b]');
    expect(t.display).toBe('Say [[b] [[pause=1] {{y}');
    expect(t.pauses).toEqual([]);
    expect(t.visible).toBe('Say [b] [pause=1] {y}'.length);
  });
  it('keeps {action:x} as a glyph (one visible character) and a value cannot make one', () => {
    const t = dialogueLineText('Press {action:jump} to {x}.[pause=1] {{action:jump}', () => '{action:fire}');
    expect(t.display).toBe('Press {action:jump} to {{action:fire}. {{action:jump}');
    expect(t.pauses).toEqual([{ at: 'Press # to {action:fire}.'.length, seconds: 1 }]);
    expect(t.visible).toBe('Press # to {action:fire}. {action:jump}'.length);
    const tokens = parseRichText(t.display, { values: false });
    expect(tokens.filter((k) => k.t === 'glyph').map((k) => (k as { action: string }).action)).toEqual(['jump']);
    expect(tokens.some((k) => k.t === 'value')).toBe(false);
  });
});

function doc(nodes: DialogueDocument['graph']['nodes'], edges: DialogueDocument['graph']['edges'] = []): DialogueDocument {
  return { dialogueId: 'talk', name: 'Talk', graph: { nodes, edges } };
}

describe('dialogue validation and compile', () => {
  it('a new conversation is valid and compiles to an empty start', () => {
    const errors: ModelErrorV2[] = [];
    validateDialogue({ dialogueId: 'd1', name: 'D', graph: newDialogueGraph() }, '', errors);
    expect(errors).toEqual([]);
    expect(compileDialogue({ dialogueId: 'd1', name: 'D', graph: newDialogueGraph() })).toMatchObject({ start: null, entries: {}, nodes: {} });
  });

  it('refuses bad expressions, bad speaker ids and duplicate entry names', () => {
    const errors: ModelErrorV2[] = [];
    validateDialogue(
      doc([
        { id: 'start', type: 'start', position: [0, 0] },
        { id: 'b', type: 'branch', position: [0, 100], data: { condition: 'gold >' } },
        { id: 's', type: 'set', position: [0, 200], data: { effects: 'x == 1' } },
        { id: 'l', type: 'line', position: [0, 300], data: { speaker: 'Bad Id' } },
        { id: 'e1', type: 'entry', position: [0, 400], data: { name: 'again' } },
        { id: 'e2', type: 'entry', position: [0, 500], data: { name: 'again' } },
      ]),
      '',
      errors,
    );
    const paths = errors.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['/graph/nodes/1/data/condition', '/graph/nodes/2/data/effects', '/graph/nodes/3/data/speaker', '/graph/nodes/5/data/name']));
  });

  it('references: speakers exist, voice is audio or music, portraits are textures, jumps name a dialogue and entry, settings name a document and theme', () => {
    const d = doc([
      { id: 'start', type: 'start', position: [0, 0] },
      { id: 'l', type: 'line', position: [0, 100], data: { speaker: 'ghost', voice: 'tex' } },
      { id: 'n', type: 'line', position: [0, 200], data: { speaker: '$who', voice: 'song' } },
      { id: 'j', type: 'jump', position: [0, 300], data: { dialogue: 'talk', entry: 'nowhere' } },
    ]);
    const kinds: Record<string, string> = { tex: 'texture', song: 'music', beep: 'audio' };
    const errors: ModelErrorV2[] = [];
    validateDialogueReferences(
      { dialogues: [d], speakers: [{ speakerId: 'a', name: 'A', portraits: { neutral: 'song' }, blip: 'tex' }], dialogueSettings: { document: 'nope', theme: 'nope' }, uiDocuments: [], uiThemes: [] },
      errors,
      (id) => kinds[id],
    );
    expect(errors.map((e) => e.path).sort()).toEqual(
      ['/dialogueSettings/document', '/dialogueSettings/theme', '/dialogues/0/graph/nodes/1/data/speaker', '/dialogues/0/graph/nodes/1/data/voice', '/dialogues/0/graph/nodes/3/data/entry', '/speakers/0/blip', '/speakers/0/portraits/neutral'].sort(),
    );
  });

  it('speaker and settings shapes', () => {
    const e1: ModelErrorV2[] = [];
    validateSpeaker({ speakerId: 'guide', name: 'Guide', color: '#80C0FF', blipEvery: 0, extra: 1 }, '', e1);
    expect(e1.map((e) => e.path).sort()).toEqual(['/blipEvery', '/color', '/extra']);
    const e2: ModelErrorV2[] = [];
    validateDialogueSettings({ textSpeed: -1, duck: 2, backlog: 101, autoAdvance: 'yes' }, '', e2);
    expect(e2.length).toBe(4);
  });

  it('compiles wires to next pointers and orders options top to bottom', () => {
    const g = compileDialogue(
      doc(
        [
          { id: 'start', type: 'start', position: [0, 0] },
          { id: 'c', type: 'choice', position: [0, 100] },
          { id: 'low', type: 'option', position: [0, 300], data: { text: 'Second' } },
          { id: 'high', type: 'option', position: [0, 200], data: { text: 'First', once: true } },
        ],
        [
          { id: 'w0', from: { node: 'start', port: 'next' }, to: { node: 'c', port: 'in' } },
          { id: 'w1', from: { node: 'c', port: 'options' }, to: { node: 'low', port: 'in' } },
          { id: 'w2', from: { node: 'c', port: 'options' }, to: { node: 'high', port: 'in' } },
        ],
      ),
    );
    expect(g.start).toBe('c');
    expect(g.nodes['c']).toEqual({ t: 'choice', options: [expect.objectContaining({ id: 'high', text: 'First', once: true }), expect.objectContaining({ id: 'low', text: 'Second', once: false })], none: null });
  });
});

describe('the engine dialogue document', () => {
  it('is a valid UI document, themable, and added only when the project uses it', () => {
    const errors: ModelErrorV2[] = [];
    validateUiDocument(dialogueUiDocument('neutral'), '', errors);
    expect(errors).toEqual([]);
    expect(dialogueUiDocument('neutral').theme).toBe('neutral');
    const data = { dialogues: [], speakers: [], settings: {}, document: DIALOGUE_DOCUMENT_ID };
    expect(withDialogueUiDocument(undefined, data)!.map((d) => d.uiDocumentId)).toEqual([DIALOGUE_DOCUMENT_ID]);
    expect(withDialogueUiDocument(undefined, null)).toBeUndefined();
    // A project document with the engine's id replaces it; another document chosen in the settings leaves it out.
    const own = { ...dialogueUiDocument(), name: 'Mine' };
    expect(withDialogueUiDocument([own], data)).toEqual([own]);
    expect(withDialogueUiDocument([], { ...data, document: 'custom' })).toEqual([]);
  });
});
