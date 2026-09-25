/**
 * Phase 19.0: the editor's copy of the visual-script port context (editor
 * session/behavior-graph.ts) equals project-model's `behaviorGraphContext`,
 * and its new-script template is a valid behavior graph whose declaration
 * is the one its variables make.
 */
import { describe, expect, it } from 'vitest';

import { behaviorGraphContext, behaviorGraphDeclaration, BEHAVIOR_GRAPH_KIND, validateGraphData, type GraphData, type ModelErrorV2 } from '@thirdlight/project-model';

import { behaviorPortContext, newBehaviorGraph } from '../packages/editor/src/session/behavior-graph';

const GRAPHS: GraphData[] = [
  { nodes: [], edges: [] },
  {
    nodes: [
      { id: 'b', type: 'var.boolean', position: [0, 10], data: { name: 'armed' } },
      { id: 'a', type: 'var.number', position: [0, 10], data: { name: 'armed' } },
      { id: 'c', type: 'var.string', position: [0, -5], data: { name: 'title' } },
      { id: 'd', type: 'var.number', position: [0, 0] },
      { id: 'g', type: 'var.get', position: [0, 0], data: { variable: 'armed' } },
    ],
    edges: [],
  },
];

describe('behavior graph parity (editor ↔ project-model)', () => {
  it('the variable lookup gives the same types', () => {
    for (const g of GRAPHS) {
      const a = behaviorGraphContext(g);
      const b = behaviorPortContext(g);
      for (const name of ['armed', 'title', '', 'ghost']) {
        for (const lookup of ['variable', 'parameter']) expect(b.lookup!(lookup, name), `${lookup} ${name}`).toBe(a.lookup!(lookup, name));
      }
    }
  });

  it('the new-script template is valid and declares what its variables make', () => {
    const t = newBehaviorGraph();
    const errors: ModelErrorV2[] = [];
    validateGraphData(BEHAVIOR_GRAPH_KIND, t.graph, '', errors, behaviorGraphContext(t.graph));
    expect(errors).toEqual([]);
    expect(t.declaration).toEqual(behaviorGraphDeclaration(t.graph));
  });
});
