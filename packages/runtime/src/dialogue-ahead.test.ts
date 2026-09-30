/**
 * The voices a conversation may say next, read ahead by the page: every
 * path (choice options, branches, jumps into another conversation), a few
 * lines deep, nearest first, each once, the line now playing left out.
 */
import { compileDialogue, type DialogueDocument, type RuntimeDialogueData } from '@thirdlight/project-model';
import { describe, expect, it } from 'vitest';

import { DIALOGUE_VOICE_LOOKAHEAD_LINES, dialogueVoicesAhead } from './dialogue-ahead';

type N = { id: string; type: string; data?: Record<string, unknown> };
type E = [from: string, port: string, to: string];

function doc(dialogueId: string, nodes: N[], edges: E[]): DialogueDocument {
  return {
    dialogueId,
    name: dialogueId,
    graph: {
      nodes: nodes.map((n, i) => ({ ...n, position: [0, i * 10] as [number, number] })),
      edges: edges.map(([from, port, to], i) => ({ id: `e${i}`, from: { node: from, port }, to: { node: to, port: 'in' } })),
    },
  } as unknown as DialogueDocument;
}
const line = (id: string, voice: string): N => ({ id, type: 'line', data: { speaker: '', text: id, voice } });

function data(...docs: DialogueDocument[]): RuntimeDialogueData {
  return { dialogues: docs.map(compileDialogue), speakers: [], settings: {}, document: 'tl-dialogue' };
}

describe('dialogue voices ahead', () => {
  const main = doc(
    'main',
    [
      { id: 'start', type: 'start' },
      line('a', 'vo-a'),
      { id: 'pick', type: 'choice' },
      { id: 'o1', type: 'option', data: { text: 'yes' } },
      { id: 'o2', type: 'option', data: { text: 'no' } },
      line('yes1', 'vo-yes1'),
      line('yes2', 'vo-yes2'),
      line('yes3', 'vo-yes3'),
      { id: 'br', type: 'branch', data: { condition: 'x' } },
      line('t', 'vo-t'),
      line('f', ''),
      { id: 'j', type: 'jump', data: { dialogue: 'other', entry: '' } },
    ],
    [
      ['start', 'next', 'a'],
      ['a', 'next', 'pick'],
      ['pick', 'options', 'o1'],
      ['pick', 'options', 'o2'],
      ['o1', 'next', 'yes1'],
      ['yes1', 'next', 'yes2'],
      ['yes2', 'next', 'yes3'],
      ['o2', 'next', 'br'],
      ['br', 'true', 't'],
      ['br', 'false', 'f'],
      ['f', 'next', 'j'],
    ],
  );
  const other = doc('other', [{ id: 'start', type: 'start' }, line('x1', 'vo-x1'), line('x2', 'vo-x2')], [['start', 'next', 'x1'], ['x1', 'next', 'x2']]);

  it('every path is read, nearest first, the playing line left out', () => {
    expect(DIALOGUE_VOICE_LOOKAHEAD_LINES).toBe(3);
    // From a: yes1, t and f (silent) are one line ahead; yes2 and other's x1 two; yes3 would be three.
    expect(dialogueVoicesAhead(data(main, other), 'main', 'a')).toEqual([
      { voice: 'vo-yes1', depth: 0 },
      { voice: 'vo-t', depth: 0 },
      { voice: 'vo-yes2', depth: 1 },
      { voice: 'vo-x1', depth: 1 },
      { voice: 'vo-yes3', depth: 2 },
      { voice: 'vo-x2', depth: 2 },
    ]);
  });

  it('the depth bounds how far each path is read; a loop is walked once', () => {
    expect(dialogueVoicesAhead(data(main, other), 'main', 'a', 1).map((v) => v.voice)).toEqual(['vo-yes1', 'vo-t']);
    const loop = doc('loop', [{ id: 'start', type: 'start' }, line('p', 'vo-p'), line('q', 'vo-q')], [['start', 'next', 'p'], ['p', 'next', 'q'], ['q', 'next', 'p']]);
    expect(dialogueVoicesAhead(data(loop), 'loop', 'p', 10).map((v) => v.voice)).toEqual(['vo-q', 'vo-p']);
    expect(dialogueVoicesAhead(data(loop), 'nothing', 'p')).toEqual([]);
  });
});
