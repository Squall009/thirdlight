/**
 * The dialogue runner — lines and the typewriter, advance and
 * instant reveal, choices with conditions and effects, branches, jumps,
 * signals and waits, skip-if-seen, the backlog, voice on the voice bus with
 * ducking and auto-advance, the save section, and determinism.
 */
import { describe, expect, it } from 'vitest';
import { dialogueForRuntime, type DialogueDocument, type DialogueSettings, type DialogueSpeaker, type GraphData } from '@thirdlight/project-model';

import { AudioMixer, type AudioCommand } from './audio-mixer';
import { DialogueRunner, validateDialogueInputs, type DialogueInputRecord } from './dialogue';
import { UiState } from './ui';

type N = { id: string; type: string; data?: Record<string, string | number | boolean> };
/** A graph from nodes and wires "from.port>to" (port `next` when omitted; into port `in`). */
function graph(nodes: N[], wires: string[]): GraphData {
  return {
    nodes: nodes.map((n, i) => ({ id: n.id, type: n.type, position: [i * 200, i * 10] as [number, number], ...(n.data !== undefined ? { data: n.data } : {}) })),
    edges: wires.map((w, i) => {
      const [from, to] = w.split('>') as [string, string];
      const [node, port] = from.includes('.') ? (from.split('.') as [string, string]) : [from, 'next'];
      return { id: `e${i}`, from: { node, port }, to: { node: to, port: 'in' } };
    }),
  };
}

const SPEAKERS: DialogueSpeaker[] = [
  { speakerId: 'guide', name: 'Guide', color: '#80c0ff', portraits: { neutral: 'tex-guide', happy: 'tex-guide-happy' } },
  { speakerId: 'visitor', name: 'Visitor', portraits: { neutral: 'tex-visitor' }, blip: 'blip', blipEvery: 2 },
];

function setup(docs: DialogueDocument[], settings: DialogueSettings = {}, durations: Record<string, number> = {}): { r: DialogueRunner; ui: UiState; mixer: AudioMixer; step: () => void; commands: AudioCommand[]; state: { step: number } } {
  const data = dialogueForRuntime({ dialogues: docs, speakers: SPEAKERS, dialogueSettings: settings })!;
  const ui = new UiState([{ uiDocumentId: 'tl-dialogue', layer: 50, modal: false }]);
  const state = { step: 0 };
  const mixer = new AudioMixer(60, durations, () => state.step);
  const r = new DialogueRunner(data, { set: (p, v) => ui.set(p, v), clear: (p) => ui.clear(p), show: (d) => ui.show(d), hide: (d) => ui.hide(d), isShown: (d) => ui.isShown(d) }, mixer, 60, (id) => (durations[id] !== undefined ? durations[id]! / 1000 : null));
  const commands: AudioCommand[] = [];
  const step = (): void => {
    r.endStep();
    mixer.endStep();
    commands.push(...mixer.take());
    state.step += 1;
  };
  return { r, ui, mixer, step, commands, state };
}

const conversation: DialogueDocument = {
  dialogueId: 'intro',
  name: 'Intro',
  graph: graph(
    [
      { id: 'start', type: 'start' },
      { id: 'l1', type: 'line', data: { speaker: 'guide', text: 'Hello [b]there[/b].' } },
      { id: 'l2', type: 'line', data: { speaker: 'visitor', expression: 'neutral', text: 'Hi, {$name}!' } },
      { id: 'ask', type: 'choice' },
      { id: 'o1', type: 'option', data: { text: 'Tea, please', effects: 'tea = true; cups += 1' } },
      { id: 'o2', type: 'option', data: { text: 'Secret', condition: 'knowsSecret' } },
      { id: 'o3', type: 'option', data: { text: 'No thanks' } },
      { id: 'b', type: 'branch', data: { condition: 'tea && cups >= 1' } },
      { id: 'yes', type: 'line', data: { speaker: 'guide', expression: 'happy', text: 'One tea for {cups} cup.' } },
      { id: 'no', type: 'line', data: { speaker: 'guide', text: 'Suit yourself.' } },
      { id: 'end', type: 'end' },
    ],
    ['start>l1', 'l1>l2', 'l2>ask', 'ask.options>o1', 'ask.options>o2', 'ask.options>o3', 'o1>b', 'o2>no', 'o3>b', 'b.true>yes', 'b.false>no', 'yes>end', 'no>end'],
  ),
};

describe('dialogue runner', () => {
  it('validates dialogue inputs on frames', () => {
    expect(validateDialogueInputs([{ kind: 'advance' }, { kind: 'choose', index: 1 }]).ok).toBe(true);
    expect(validateDialogueInputs([{ kind: 'choose' }]).ok).toBe(false);
    expect(validateDialogueInputs([{ kind: 'jump' }]).ok).toBe(false);
    expect(validateDialogueInputs(new Array(9).fill({ kind: 'advance' })).ok).toBe(false);
  });

  it('starts at the end of the step, reveals the line over time, advance reveals the rest then goes on; events are seen next step', () => {
    const { r, ui, step } = setup([conversation], { textSpeed: 30 });
    const id = r.api.start('intro', { bindings: { name: 'Sam' } });
    expect(id).toBe(1);
    expect(r.api.isRunning()).toBe(true);
    expect(r.api.start('intro')).toBe(0); // one conversation at a time
    step();
    expect(ui.isShown('tl-dialogue')).toBe(true);
    expect(r.api.events().map((e) => e.kind)).toEqual(['start', 'lineStart']);
    const cur = r.api.current()!;
    expect(cur).toMatchObject({ nodeId: 'l1', kind: 'line', speaker: 'guide', text: 'Hello [b]there[/b].', total: 12, revealed: 0 });
    // 30 chars/s at 60 Hz: a character every 2 steps.
    for (let i = 0; i < 4; i++) step();
    expect(r.api.current()!.revealed).toBe(2);
    expect((ui.get('dialogue.line') as { reveal: number; name: string; portrait: string }).reveal).toBe(2);
    expect((ui.get('dialogue.line') as { name: string }).name).toBe('[color=#80c0ff]Guide[/color]');
    expect((ui.get('dialogue.line') as { portrait: string }).portrait).toBe('tex-guide');
    expect(r.api.events()).toEqual([]);
    // Advance while revealing: the whole line at once.
    r.deliver([{ kind: 'advance' }]);
    step();
    expect(r.api.current()!.revealed).toBe(12);
    expect(ui.get('dialogue.line.done')).toBe(true);
    // Advance again: the next line (bindings in the text).
    r.api.advance();
    step();
    expect(r.api.current()).toMatchObject({ nodeId: 'l2', speaker: 'visitor', text: 'Hi, Sam!' });
    expect(r.api.events().map((e) => e.kind)).toEqual(['lineEnd', 'lineStart']);
  });

  it('choices: conditions hide options, a pick applies effects and branches; the backlog holds lines and the pick', () => {
    const { r, ui, step } = setup([conversation], { textSpeed: 0 });
    r.api.start('intro', { bindings: { name: 'Ada' } });
    step();
    r.deliver([{ kind: 'advance' }]);
    step();
    r.deliver([{ kind: 'advance' }]);
    step();
    const cur = r.api.current()!;
    expect(cur.kind).toBe('choice');
    expect(cur.options).toEqual(['Tea, please', 'No thanks']); // "Secret" needs knowsSecret
    expect(ui.get('dialogue.showChoices')).toBe(true);
    expect(ui.get('dialogue.showLine')).toBe(true); // the last line stays under the choice
    expect(r.api.events().map((e) => e.kind)).toEqual(['lineEnd', 'choice']);
    r.deliver([{ kind: 'choose', index: 0 }]);
    step();
    expect(r.api.get('tea')).toBe(true);
    expect(r.api.get('cups')).toBe(1);
    expect(r.api.current()).toMatchObject({ nodeId: 'yes', text: 'One tea for 1 cup.' });
    const chosen = r.api.event('chosen')!;
    expect(chosen).toMatchObject({ nodeId: 'ask', text: 'Tea, please', index: 0, name: 'o1' });
    expect((ui.get('dialogue.line') as { portrait: string }).portrait).toBe('tex-guide-happy');
    r.api.advance();
    step();
    expect(r.api.isRunning()).toBe(false);
    expect(r.api.event('end')).toMatchObject({ name: 'end', dialogueId: 'intro' });
    expect(ui.isShown('tl-dialogue')).toBe(false);
    const h = r.api.history();
    expect(h.map((x) => [x.nodeId, x.choice])).toEqual([['l1', false], ['l2', false], ['o1', true], ['yes', false]]);
    expect(h[0]!.name).toBe('Guide');
    const backlog = ui.get('dialogue.backlog') as { name: string; text: string }[];
    expect(backlog.map((b) => b.text)).toEqual(['Hello [b]there[/b].', 'Hi, Ada!', '> Tea, please', 'One tea for 1 cup.']);
    // A condition over a variable a script set.
    r.api.set('knowsSecret', true);
    r.api.start('intro', { bindings: { name: 'Ada' } });
    step();
    r.api.advance();
    step();
    r.api.advance();
    step();
    expect(r.api.current()!.options).toEqual(['Tea, please', 'Secret', 'No thanks']);
  });

  it('jumps to another conversation\'s entry, signals (and waits for resume), wait nodes, once options', () => {
    const second: DialogueDocument = {
      dialogueId: 'second',
      name: 'Second',
      graph: graph(
        [
          { id: 'start', type: 'start' },
          { id: 'en', type: 'entry', data: { name: 'later' } },
          { id: 'sig', type: 'signal', data: { name: 'camera.cut', value: 'wide', wait: true } },
          { id: 'w', type: 'wait', data: { seconds: 0.05 } },
          { id: 'l', type: 'line', data: { speaker: 'guide', text: 'After the wait.' } },
          { id: 'c', type: 'choice' },
          { id: 'o', type: 'option', data: { text: 'Once', once: true } },
        ],
        ['en>sig', 'sig>w', 'w>l', 'l>c', 'c.options>o', 'o>c'],
      ),
    };
    const first: DialogueDocument = { dialogueId: 'first', name: 'First', graph: graph([{ id: 'start', type: 'start' }, { id: 'j', type: 'jump', data: { dialogue: 'second', entry: 'later' } }], ['start>j']) };
    const { r, step } = setup([first, second], { textSpeed: 0 });
    r.api.start('first');
    step();
    expect(r.api.current()).toMatchObject({ dialogueId: 'second', nodeId: 'sig', kind: 'signal' });
    expect(r.api.event('signal', 'camera.cut')).toMatchObject({ value: 'wide' });
    step();
    expect(r.api.current()!.kind).toBe('signal'); // still waiting
    r.api.resume();
    step();
    expect(r.api.current()!.kind).toBe('wait');
    for (let i = 0; i < 3; i++) step();
    expect(r.api.current()).toMatchObject({ nodeId: 'l', kind: 'line' });
    r.api.advance();
    step();
    expect(r.api.current()!.options).toEqual(['Once']);
    r.api.choose(0);
    step();
    // Once picked, the choice has no option left and no "none" wire: the conversation ends.
    expect(r.api.isRunning()).toBe(false);
    expect(r.api.event('end')!.name).toBe('end');
    expect(r.api.seen('second/o')).toBe(true);
  });

  it('skip-if-seen: skip passes lines seen before (one per step) and stops at an unseen line or a choice', () => {
    const { r, step } = setup([conversation], { textSpeed: 10 });
    r.api.start('intro', { bindings: { name: 'A' } });
    step();
    // Skip on the first visit: the line is unseen, so skip turns itself off.
    r.api.setSkip(true);
    step();
    step();
    expect(r.api.current()!.nodeId).toBe('l1');
    r.api.stop();
    step();
    expect(r.api.seen('intro/l1')).toBe(true);
    expect(r.api.seen('intro/l2')).toBe(false);
    // Second visit: l1 is skipped (seen), l2 stops the skip (unseen).
    r.api.start('intro', { bindings: { name: 'A' } });
    step();
    r.deliver([{ kind: 'skip' }]);
    step();
    step();
    expect(r.api.current()!.nodeId).toBe('l2');
    step();
    step();
    expect(r.api.current()!.nodeId).toBe('l2');
  });

  it('voice: plays on the voice bus, ducks music and SFX, auto-advances after the clip and the delay, then unducks', () => {
    const voiced: DialogueDocument = {
      dialogueId: 'voiced',
      name: 'Voiced',
      graph: graph(
        [
          { id: 'start', type: 'start' },
          { id: 'a', type: 'line', data: { speaker: 'guide', text: 'Hi.', voice: 'vo-a', auto: 'on' } },
          { id: 'b', type: 'line', data: { speaker: 'visitor', text: 'Hello there, friend.' } },
        ],
        ['start>a', 'a>b'],
      ),
    };
    // A 0.5 s clip, 0.25 s auto delay, 60 chars/s.
    const { r, step, commands, ui } = setup([voiced], { textSpeed: 60, autoDelay: 0.25, duck: 0.3 }, { 'vo-a': 500 });
    r.api.start('voiced');
    step();
    const play = commands.find((c) => c.op === 'play')!;
    // A voice may start later than an effect: the dialogue default bound (the settings' voiceMaxLateMs).
    expect(play).toMatchObject({ assetId: 'vo-a', bus: 'voice', maxLateMs: 1000 });
    expect(commands.filter((c) => c.op === 'duck')).toEqual([
      expect.objectContaining({ level: 0.3 }),
      expect.objectContaining({ level: 0.3, bus: 'sfx' }),
    ]);
    expect(ui.get('dialogue.line.voiced')).toBe(true);
    // The clip lasts 30 steps; then 15 steps of delay.
    for (let i = 0; i < 30; i++) step();
    expect(r.api.current()!.nodeId).toBe('a');
    expect(commands.filter((c) => c.op === 'duck').slice(-2)).toEqual([expect.objectContaining({ level: 1 }), expect.objectContaining({ level: 1, bus: 'sfx' })]);
    for (let i = 0; i < 14; i++) step();
    expect(r.api.current()!.nodeId).toBe('a');
    step();
    expect(r.api.current()!.nodeId).toBe('b');
    // Line b is not voiced: its speaker's blip plays while it reveals (sfx bus), and it waits for input (no auto).
    const before = commands.filter((c) => c.op === 'play' && c.assetId === 'blip').length;
    for (let i = 0; i < 40; i++) step();
    expect(commands.filter((c) => c.op === 'play' && c.assetId === 'blip').length).toBeGreaterThan(before);
    expect(commands.find((c) => c.op === 'play' && c.assetId === 'blip')).toMatchObject({ bus: 'sfx' });
    expect(r.api.current()!.nodeId).toBe('b');
  });

  it('an advance during a voiced line cuts the voice with a short fade and unducks', () => {
    const voiced: DialogueDocument = { dialogueId: 'v', name: 'V', graph: graph([{ id: 'start', type: 'start' }, { id: 'a', type: 'line', data: { text: 'Hi.', voice: 'vo' } }, { id: 'b', type: 'line', data: { text: 'Next.' } }], ['start>a', 'a>b']) };
    const { r, step, commands } = setup([voiced], { textSpeed: 0 }, { vo: 2000 });
    r.api.start('v');
    step();
    r.api.advance();
    step();
    expect(r.api.current()!.nodeId).toBe('b');
    expect(commands.find((c) => c.op === 'stop')).toMatchObject({ fade: expect.any(Number) });
    expect(commands.filter((c) => c.op === 'duck').at(-1)).toMatchObject({ level: 1, bus: 'sfx' });
  });

  it('player auto mode (the auto input) advances unvoiced lines after the reveal and the delay', () => {
    const { r, step } = setup([conversation], { textSpeed: 0, autoDelay: 0.1 });
    r.api.start('intro', { bindings: { name: 'B' } });
    step();
    r.deliver([{ kind: 'auto' }]);
    step();
    for (let i = 0; i < 6; i++) step();
    expect(r.api.current()!.nodeId).toBe('l2');
  });

  it('the save section: variables and the seen set out and back', () => {
    const { r, step } = setup([conversation], { textSpeed: 0 });
    r.api.set('met', 'yes');
    r.api.start('intro', { bindings: { name: 'C' } });
    step();
    const saved = r.saveState();
    expect(saved).toEqual({ variables: { met: 'yes' }, seen: ['intro/l1'] });
    expect(r.checkState(saved)).toBeNull();
    expect(r.checkState({ variables: { 'bad name': 1 }, seen: [] })).not.toBeNull();
    r.resetRun();
    expect(r.api.get('met')).toBeNull();
    r.restoreState(saved);
    expect(r.api.get('met')).toBe('yes');
    expect(r.api.seen('intro/l1')).toBe(true);
  });

  it('is deterministic: the same calls and inputs give the same digests and view model at every step', () => {
    const run = (): string[] => {
      const { r, ui, step } = setup([conversation], { textSpeed: 45 }, {});
      const inputs: Record<number, DialogueInputRecord[]> = { 20: [{ kind: 'advance' }], 21: [{ kind: 'advance' }], 60: [{ kind: 'advance' }], 61: [{ kind: 'advance' }], 90: [{ kind: 'choose', index: 1 }], 91: [{ kind: 'advance' }] };
      const out: string[] = [];
      r.api.start('intro', { bindings: { name: 'D' } });
      for (let i = 0; i < 120; i++) {
        r.deliver(inputs[i]);
        step();
        out.push(`${r.digestText()}|${JSON.stringify(ui.view().model)}`);
      }
      return out;
    };
    const a = run();
    expect(run()).toEqual(a);
    expect(a.at(-1)).toContain('Suit yourself.');
  });

  it('a project without conversations is inert', () => {
    const r = new DialogueRunner(null, null, null, 60, () => null);
    expect(r.enabled).toBe(false);
    expect(r.api.start('x')).toBe(0);
    r.endStep();
    expect(r.digestText()).toBeNull();
  });
});
