/**
 * Phase 19.1: the visual-script API nodes stay generated from the runtime
 * typings (parity): a change to `BehaviorContext` (a new member, a new
 * parameter, a changed doc tag) without `node tools/gen-behavior-graph-api.mjs`
 * fails here. The graph kind builds its API nodes from this table, so new
 * script API shows up as nodes without hand-work.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { OUTPUT, generateBehaviorGraphApi } from './gen-behavior-graph-api.mjs';

const generated = generateBehaviorGraphApi();

function table(text) {
  const m = /BEHAVIOR_API_NODES: readonly BehaviorApiNodeSpec\[\] = (\[[\s\S]*?\n\]);\n/.exec(text);
  if (m === null) throw new Error('BEHAVIOR_API_NODES not found');
  return JSON.parse(m[1].replace(/,\n\]$/, '\n]'));
}

describe('visual-script API nodes (tools/gen-behavior-graph-api.mjs)', () => {
  it('the checked-in behavior-api.generated.ts matches the runtime typings (run node tools/gen-behavior-graph-api.mjs)', () => {
    expect(readFileSync(OUTPUT, 'utf8') === generated).toBe(true);
  });

  it('every entry is well formed: unique types, api.<path> names, calls reachable from ctx', () => {
    const nodes = table(generated);
    expect(nodes.length).toBeGreaterThan(50);
    expect(new Set(nodes.map((n) => n.type)).size).toBe(nodes.length);
    for (const n of nodes) {
      expect(n.type).toMatch(/^api\.[A-Za-z0-9_.]+$/);
      expect(n.label.length).toBeGreaterThan(0);
      expect(n.access.length).toBeGreaterThan(0);
      expect('prop' in n.access[0]).toBe(true);
      // A data node has a result to read.
      if (!n.exec) expect(n.outputs.length).toBeGreaterThan(0);
      for (const a of n.args) expect(a.id).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
    // Doc tags steer the table: labels, pure queries, defaults, phases.
    const add = nodes.find((n) => n.type === 'api.game.add');
    expect(add).toMatchObject({ label: 'Add to counter', exec: true, args: [{ id: 'name', label: 'counter', required: true }, { id: 'amount', default: 1 }] });
    expect(nodes.find((n) => n.type === 'api.signals.on')).toMatchObject({ exec: false, outputs: [{ id: 'value', type: 'boolean' }] });
    expect(nodes.find((n) => n.type === 'api.emit.transform')).toMatchObject({ phase: 'transform', moves: 'entityId' });
  });
});
