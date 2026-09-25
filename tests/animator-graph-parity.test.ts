/**
 * Phase 16.2: the editor's controller → graph read (editor/src/graph/animator.ts —
 * the editor may import project-model types only) against project-model's
 * (the backend's `graphEdit` on owner kind `animator` applies ops to that
 * graph). Both must derive the same graph from the same controller, or the
 * editor would send ops for ids the backend does not have.
 */
import { describe, expect, it } from 'vitest';

import { animatorGraphOf, animatorTransitionPairs, applyAnimatorGraph, canonicalAnimatorController, parseAnimatorOwnerId, type AnimatorController } from '../packages/project-model/src/index';
import * as editor from '../packages/editor/src/graph/animator';

const clip = (name: string) => ({ assetId: 'model-a', clip: name, duration: name === 'idle' ? 1 : 0.75 });

function fixtures(): AnimatorController[] {
  const plain: AnimatorController = {
    controllerId: 'plain',
    name: 'No positions',
    parameters: [{ name: 'speed', type: 'float', default: 0 }, { name: 'go', type: 'trigger' }],
    states: [
      { id: 'a', name: 'A', motion: { kind: 'clip', clip: clip('idle') }, speed: 1, loop: true },
      { id: 'b', name: 'B', motion: { kind: 'clip', clip: clip('run') }, speed: 2, loop: false, speedParameter: 'speed' },
      { id: 'c', name: 'C', motion: { kind: 'blend1d', parameter: 'speed', children: [{ threshold: 0, clip: clip('idle') }, { threshold: 3, clip: clip('run') }] }, speed: 1, loop: true },
      { id: 'lonely', name: 'Lonely', motion: { kind: 'clip', clip: clip('run') }, speed: 1, loop: true },
    ],
    transitions: [
      { from: 'a', to: 'b', conditions: [{ parameter: 'go', op: 'trigger' }], duration: 0.1 },
      { from: 'b', to: 'c', conditions: [], duration: 0.2, exitTime: 1 },
      { from: 'a', to: 'b', conditions: [{ parameter: 'speed', op: 'greater', value: 1 }], duration: 0.1 },
      { from: '*', to: 'a', conditions: [{ parameter: 'go', op: 'trigger' }], duration: 0 },
      { from: 'c', to: 'c', conditions: [{ parameter: 'go', op: 'trigger' }], duration: 0 },
    ],
    entry: 'a',
    events: [],
  };
  const laidOut: AnimatorController = {
    ...plain,
    controllerId: 'laid',
    states: plain.states.map((s, i) => ({ ...s, position: [i * 300, 40] as [number, number] })),
    layout: { entry: [-400, 0], any: [-400, 200], groups: [{ id: 'g1', title: 'Moves', color: '#2f9e44', rect: [0, 0, 600, 200] }], comments: [{ id: 'k1', text: 'hello', position: [0, -100], size: [200, 60] }], collapsed: ['b', 'ANY'] },
    layers: [
      {
        name: 'Upper',
        mask: ['spine'],
        weight: 0.5,
        states: [
          { id: 'none', name: 'Empty', motion: { kind: 'empty' }, speed: 1, loop: true },
          { id: 'wave', name: 'Wave', motion: { kind: 'clip', clip: clip('wave') }, speed: 1, loop: false },
        ],
        transitions: [{ from: 'none', to: 'wave', conditions: [{ parameter: 'go', op: 'trigger' }], duration: 0.1 }, { from: 'wave', to: 'none', conditions: [], duration: 0.1, exitTime: 1 }],
        entry: 'none',
      },
    ],
  };
  const blendLaid: AnimatorController = {
    ...plain,
    controllerId: 'blend',
    states: plain.states.map((s) => (s.motion.kind === 'blend1d' ? { ...s, motion: { ...s.motion, children: s.motion.children.map((k, i) => ({ ...k, position: [10, i * 200] as [number, number] })), layout: { output: [500, 90], collapsed: ['C1'] } } } : s)),
  };
  return [plain, laidOut, blendLaid].map(canonicalAnimatorController);
}

const targets = ['plain', 'plain#c', 'laid', 'laid@1', 'laid#c', 'blend#c', 'plain@1', 'plain#a', 'laid@2'];

describe('animator graph read: editor = backend', () => {
  it('parses the same owner ids', () => {
    for (const id of [...targets, 'Bad', 'x@0', 'x@', '#a', 'x#']) expect(editor.parseAnimatorOwnerId(id)).toEqual(parseAnimatorOwnerId(id));
    for (const id of targets) expect(editor.animatorOwnerId(editor.parseAnimatorOwnerId(id)!)).toBe(id);
  });

  it('derives the same graph for every layer and blend tree (with and without layout)', () => {
    let compared = 0;
    for (const c of fixtures()) {
      for (const id of targets) {
        const t = parseAnimatorOwnerId(id)!;
        if (c.controllerId !== t.controllerId) continue;
        expect(editor.animatorGraphOf(c, t), `${c.controllerId} ${id}`).toEqual(animatorGraphOf(c, t));
        compared += 1;
      }
    }
    expect(compared).toBe(targets.length);
  });

  it('derives the same transition pairs (several transitions per pair = one wire)', () => {
    for (const c of fixtures()) expect(editor.animatorTransitionPairs(c.transitions)).toEqual(animatorTransitionPairs(c.transitions));
    const pairs = editor.animatorTransitionPairs(fixtures().find((c) => c.controllerId === 'plain')!.transitions);
    expect(pairs.find((p) => p.from === 'a' && p.to === 'b')!.indices).toEqual([0, 2]);
  });

  it('the editor view of a written controller is the backend read of it', () => {
    const c = fixtures().find((x) => x.controllerId === 'plain')!;
    const t = { controllerId: 'plain', layer: 0 };
    const g = animatorGraphOf(c, t)!.graph;
    const moved = { ...g, nodes: g.nodes.map((n) => (n.id === 'b' ? { ...n, position: [777, 55] as [number, number] } : n)) };
    const w = applyAnimatorGraph(c, t, moved);
    expect(w.ok).toBe(true);
    const next = (w as { controller: AnimatorController }).controller;
    expect(editor.animatorGraphOf(next, t)).toEqual(animatorGraphOf(next, t));
    expect(editor.animatorGraphOf(next, t)!.graph.nodes.find((n) => n.id === 'b')!.position).toEqual([777, 55]);
  });
});
