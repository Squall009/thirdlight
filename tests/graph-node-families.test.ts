/**
 * Graph nodes are styled by their category's family: every category of the
 * framework's own graph kinds has one, a visual script's game API namespaces
 * are actions, and the families read apart.
 */
import { describe, expect, it } from 'vitest';
import { GRAPH_KINDS } from '@thirdlight/project-model';

import { FAMILY_OF_CATEGORY, familyColor, familyOf, NODE_FAMILIES } from '../packages/editor/src/graph/node-style';

/** The graph kinds whose catalogue is the framework's own (a visual script's also lists the game API's namespaces). */
const STRUCTURAL = Object.values(GRAPH_KINDS).filter((k) => !k.kind.startsWith('behavior'));

describe('graph node families', () => {
  it('names a family for every category of the material, effect, dialogue, animator and test graph kinds', () => {
    for (const k of STRUCTURAL) for (const n of k.nodes) expect(FAMILY_OF_CATEGORY[n.category], `${k.kind}: ${n.category}`).toBeDefined();
  });

  it("tells a visual script's events, flow, values and maths apart, and its game API calls are actions", () => {
    const b = GRAPH_KINDS['behavior']!;
    const families = new Set(b.nodes.map((n) => familyOf(n.category)));
    for (const f of ['event', 'logic', 'input', 'math', 'action'] as const) expect(families, f).toContain(f);
    expect(familyOf('Physics')).toBe('action');
  });

  it('gives inputs, maths and the output of a material graph different families', () => {
    expect(new Set([familyOf('Inputs'), familyOf('Maths'), familyOf('Output'), familyOf('Textures')]).size).toBe(4);
    for (const f of Object.values(FAMILY_OF_CATEGORY)) expect(NODE_FAMILIES).toContain(f);
  });

  it('falls back to a neutral colour without a stylesheet', () => {
    expect(familyColor('math')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
