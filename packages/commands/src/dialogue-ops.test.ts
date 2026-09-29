/**
 * Dialogue through the commands — conversations (create with a
 * Start node, rename keeps the graph, delete refused while a Jump names it),
 * graph edits on owner kind `dialogue` (expressions must parse), speakers
 * (delete refused while a line names one), settings, and undo/redo.
 */
import { describe, expect, it } from 'vitest';
import type { DialogueDocument, DialogueSpeaker, SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess, SetDialogueChange } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x2316 * 4096 + counter).toString(16).padStart(32, '0')}`, args });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: SetDialogueChange } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 500)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change as unknown as SetDialogueChange };
}
function refused(state: State, op: string, args: Record<string, unknown>): { code: string; message: string; path?: string } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 300)).toBe(false);
  return r.result['error'] as { code: string; message: string };
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const dialogues = (s: State): DialogueDocument[] => (s.content as { dialogues?: DialogueDocument[] }).dialogues ?? [];
const speakers = (s: State): DialogueSpeaker[] => (s.content as { speakers?: DialogueSpeaker[] }).speakers ?? [];

describe('dialogue through the commands', () => {
  it('conversations: create (a Start node), rename keeps the graph, graph edits, delete, undo/redo', () => {
    let s = fresh();
    const made = ok(s, 'setDialogue', { dialogue: { dialogueId: 'talk', name: 'Talk' } });
    expect(made.change).toMatchObject({ type: 'setDialogue', dialogueKind: 'dialogue', id: 'talk', previous: null });
    s = made.state;
    expect(dialogues(s)[0]!.graph.nodes.map((n) => n.type)).toEqual(['start']);
    // A line wired after Start (one graphEdit, one undo step).
    s = ok(s, 'graphEdit', {
      owner: { kind: 'dialogue', id: 'talk' },
      ops: [
        { op: 'addNodes', nodes: [{ id: 'l1', type: 'line', position: [0, 120], data: { text: 'Hello.' } }] },
        { op: 'connect', edges: [{ id: 'w1', from: { node: 'start', port: 'next' }, to: { node: 'l1', port: 'in' } }] },
      ],
    }).state;
    expect(dialogues(s)[0]!.graph.edges).toHaveLength(1);
    // A condition that does not parse is refused.
    expect(refused(s, 'graphEdit', { owner: { kind: 'dialogue', id: 'talk' }, ops: [{ op: 'addNodes', nodes: [{ id: 'b', type: 'branch', position: [0, 240], data: { condition: 'gold >' } }] }] }).message).toContain('condition');
    // Rename: the graph stays.
    s = ok(s, 'setDialogue', { dialogue: { dialogueId: 'talk', name: 'Small talk' } }).state;
    expect(dialogues(s)[0]!.name).toBe('Small talk');
    expect(dialogues(s)[0]!.graph.nodes).toHaveLength(2);
    // A second conversation jumping to the first: the first cannot be deleted.
    s = ok(s, 'setDialogue', {
      dialogue: {
        dialogueId: 'other',
        name: 'Other',
        graph: { nodes: [{ id: 'start', type: 'start', position: [0, 0] }, { id: 'j', type: 'jump', position: [0, 100], data: { dialogue: 'talk' } }], edges: [{ id: 'w', from: { node: 'start', port: 'next' }, to: { node: 'j', port: 'in' } }] },
      },
    }).state;
    expect(refused(s, 'deleteDialogue', { dialogueId: 'talk' }).code).toBe('reference_missing');
    s = ok(s, 'deleteDialogue', { dialogueId: 'other' }).state;
    s = ok(s, 'deleteDialogue', { dialogueId: 'talk' }).state;
    expect((s.content as { dialogues?: unknown }).dialogues).toBeUndefined();
    s = ok(s, 'undo', {}).state;
    expect(dialogues(s).map((d) => d.dialogueId)).toEqual(['talk']);
    s = ok(s, 'redo', {}).state;
    expect(dialogues(s)).toEqual([]);
  });

  it('speakers: a line naming a missing speaker is refused; a speaker in use cannot be deleted', () => {
    let s = ok(fresh(), 'setDialogue', { dialogue: { dialogueId: 'talk', name: 'Talk' } }).state;
    const line = (speaker: string): Record<string, unknown> => ({ owner: { kind: 'dialogue', id: 'talk' }, ops: [{ op: 'addNodes', nodes: [{ id: `l-${speaker.replace('$', 'b-')}`, type: 'line', position: [0, 100], data: { speaker, text: 'Hi' } }] }] });
    expect(refused(s, 'graphEdit', line('guide')).code).toBe('reference_missing');
    s = ok(s, 'setSpeaker', { speaker: { speakerId: 'guide', name: 'Guide', color: '#80c0ff' } }).state;
    expect(speakers(s)).toEqual([{ speakerId: 'guide', name: 'Guide', color: '#80c0ff' }]);
    s = ok(s, 'graphEdit', line('guide')).state;
    expect(refused(s, 'deleteSpeaker', { speakerId: 'guide' }).code).toBe('reference_missing');
    // A portrait must be a texture asset of the project.
    expect(refused(s, 'setSpeaker', { speaker: { speakerId: 'guide', name: 'Guide', portraits: { neutral: 'no-such-texture' } } }).code).toBe('asset_reference_missing');
    // A $binding speaker needs no registry entry.
    s = ok(s, 'graphEdit', line('$who')).state;
    expect(refused(s, 'setSpeaker', { speaker: { speakerId: 'Bad', name: 'x' } }).path).toBe('/args/speaker/speakerId');
  });

  it('settings: set, refused bad values and missing documents, reset with null', () => {
    let s = fresh();
    const set = ok(s, 'setDialogueSettings', { settings: { textSpeed: 50, autoAdvance: true, duck: 0.3 } });
    expect(set.change).toMatchObject({ dialogueKind: 'settings', id: '', previous: null, next: { textSpeed: 50, autoAdvance: true, duck: 0.3 } });
    s = set.state;
    expect(refused(s, 'setDialogueSettings', { settings: { duck: 3 } }).path).toBe('/args/settings/duck');
    expect(refused(s, 'setDialogueSettings', { settings: { document: 'nothing' } }).code).toBe('reference_missing');
    s = ok(s, 'setDialogueSettings', { settings: { document: 'tl-dialogue' } }).state;
    s = ok(s, 'setDialogueSettings', { settings: null }).state;
    expect((s.content as { dialogueSettings?: unknown }).dialogueSettings).toBeUndefined();
    expect(refused(s, 'setDialogueSettings', { value: 1 }).code).toBe('field_unexpected');
  });
});
