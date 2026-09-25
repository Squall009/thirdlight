/**
 * The graph editor's placement of a node added from the search catalogue and
 * its handling of a wire dropped on a node body (editor/src/graph/model.ts).
 *
 * Found with the effect-graph e2e (2026-09-25): a block added next to the
 * four effect contexts landed on top of Spawn, its `in` port on Spawn's
 * `then` port. New nodes now keep clear of existing ones. A wire dropped on
 * a node body connects to the best port there, or says why none fits (the
 * editor refuses it, nothing is sent). (The e2e failure itself was a native
 * drag of a leftover text selection cancelling the wire gesture; the stage
 * now blocks that, pinned in tests/e2e/effect-graph.e2e.ts.)
 */
import { describe, expect, it } from 'vitest';

import { EFFECT_GRAPH_KIND as K, newEffectSystemGraph, type GraphData, type GraphNode } from '../packages/project-model/src/index';
import * as editor from '../packages/editor/src/graph/model';

const rectOf = (n: GraphNode): editor.Rect => editor.nodeRect(K, n);

describe('graph editor: catalogue placement', () => {
  it('a block asked for on top of the effect contexts goes to the nearest clear spot', () => {
    const g = newEffectSystemGraph();
    const spawn = g.nodes.find((n) => n.id === 'spawn')!;
    // The spot the e2e test's click produced: overlapping Spawn's right edge.
    const at: editor.GraphPoint = [spawn.position[0] + 140, spawn.position[1] + 20];
    const burst: GraphNode = { id: 'b', type: 'spawn.burst', position: at };
    const size = rectOf(burst);
    expect(g.nodes.some((n) => editor.overlaps(rectOf(n), { ...size, x: at[0], y: at[1] }))).toBe(true);

    const placed = editor.freePlace(at, size, g.nodes.map(rectOf), true);
    expect(placed[0] % editor.GRID).toBe(0);
    expect(placed[1] % editor.GRID).toBe(0);
    // Near where it was asked for (it stays in view), not pushed past the whole graph.
    expect(Math.hypot(placed[0] - at[0], placed[1] - at[1])).toBeLessThanOrEqual(size.w + 2 * editor.PLACE_GAP);
    const me = editor.nodeRect(K, { ...burst, position: placed });
    for (const n of g.nodes) {
      expect(editor.overlaps(me, rectOf(n))).toBe(false);
      // No port of the new block within a port's reach of a context's port.
      for (const [side, other] of [['in', 'out'], ['out', 'in']] as const) {
        const mine = editor.portPoint(K, { ...burst, position: placed }, side, side === 'in' ? 'in' : 'then');
        const theirs = editor.portPoint(K, n, other, other === 'in' ? 'in' : 'then');
        expect(Math.hypot(mine[0] - theirs[0], mine[1] - theirs[1])).toBeGreaterThan(editor.PLACE_GAP);
      }
    }
  });

  it('a free spot is kept as asked (snapped); a blocked one moves the shortest way; nothing free nearby: right past everything', () => {
    const size = { w: 180, h: 60 };
    expect(editor.freePlace([1003, 497], size, [{ x: 0, y: 0, w: 180, h: 60 }], true)).toEqual([1000, 500]);
    expect(editor.freePlace([1003, 497], size, [], false)).toEqual([1003, 497]);
    const row = [0, 1, 2].map((i) => ({ x: i * 200, y: 0, w: 180, h: 60 }));
    // A row of blockers: below it (60 high + the gap) is nearer than past its end; below wins the tie with above.
    const p = editor.freePlace([0, 0], size, row, true);
    expect(p).toEqual([0, 60 + editor.PLACE_GAP]);
    // A wall bigger than the search: right past it.
    const reach = editor.PLACE_SEARCH * editor.GRID;
    const wall = [{ x: -2 * reach, y: -2 * reach, w: 4 * reach, h: 4 * reach }];
    expect(editor.freePlace([0, 0], size, wall, true)).toEqual([2 * reach + editor.PLACE_GAP, 0]);
  });
});

describe('graph editor: a wire dropped on a node body', () => {
  function chained(): GraphData {
    const g = newEffectSystemGraph();
    return {
      ...g,
      nodes: [...g.nodes, { id: 'burst', type: 'spawn.burst', position: [300, 0] }, { id: 'bb', type: 'output.billboard', position: [300, 600] }],
    };
  }

  it('a wrong-context wire is refused with the reason (nothing to send)', () => {
    const plan = editor.planDropOnNode(K, chained(), { node: 'burst', port: 'then', side: 'out' }, 'bb');
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/^Billboard/);
  });

  it('a fitting wire connects to the first free port that takes it', () => {
    const plan = editor.planDropOnNode(K, chained(), { node: 'output', port: 'then', side: 'out' }, 'bb');
    expect(plan).toMatchObject({ ok: true, from: { node: 'output', port: 'then' }, to: { node: 'bb', port: 'in' } });
    // Dragged from an input onto a node body: its output.
    const back = editor.planDropOnNode(K, chained(), { node: 'burst', port: 'in', side: 'in' }, 'spawn');
    expect(back).toMatchObject({ ok: true, from: { node: 'spawn', port: 'then' }, to: { node: 'burst', port: 'in' } });
  });

  it('dropping on the node the wire starts from is refused', () => {
    expect(editor.planDropOnNode(K, chained(), { node: 'burst', port: 'then', side: 'out' }, 'burst').ok).toBe(false);
  });
});
