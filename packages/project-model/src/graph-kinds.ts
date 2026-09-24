/**
 * Phase 16.1: the registered graph kinds (data).
 *
 * A graph kind is its node catalogue, port types, conversions and rules
 * (see graph.ts). Later phases register theirs here: the animator state graph
 * (16.2), material graphs (18), visual scripts (19) and effect graphs (20).
 *
 * `test` is the framework's own neutral kind: a small numeric data-flow graph
 * (constants, maths, a vector, a select, one output) that exercises every
 * framework rule — three port types with two implicit conversions and a
 * wildcard, a multi input, required inputs, a required single sink, no
 * cycles and node data fields of every field type. It has no runtime
 * meaning; it exists so the framework and its editor are tested end to end
 * without depending on any later graph kind.
 */
import type { GraphKindDef } from './graph';

export const TEST_GRAPH_KIND: GraphKindDef = {
  kind: 'test',
  label: 'Test graph',
  portTypes: [
    { id: 'number', label: 'number', color: '#7fb3ff' },
    { id: 'vector', label: 'vector', color: '#ffc46b' },
    { id: 'boolean', label: 'boolean', color: '#e67e9b' },
    { id: 'any', label: 'any', color: '#b0b0b0' },
  ],
  conversions: [
    { from: 'number', to: 'vector', label: 'number → vector (all components)' },
    { from: 'boolean', to: 'number', label: 'boolean → number (0 or 1)' },
  ],
  anyType: 'any',
  categories: ['Inputs', 'Math', 'Logic', 'Output'],
  nodes: [
    { type: 'constant', label: 'Constant', category: 'Inputs', description: 'A fixed number.', inputs: [], outputs: [{ id: 'value', label: 'value', type: 'number' }], fields: [{ key: 'value', label: 'Value', type: 'number', default: 0, min: -1e6, max: 1e6 }] },
    { type: 'toggle', label: 'Toggle', category: 'Inputs', description: 'A fixed true/false.', inputs: [], outputs: [{ id: 'value', label: 'value', type: 'boolean' }], fields: [{ key: 'on', label: 'On', type: 'boolean', default: false }] },
    { type: 'vector', label: 'Vector', category: 'Inputs', description: 'Three numbers as a vector.', inputs: [{ id: 'x', label: 'x', type: 'number' }, { id: 'y', label: 'y', type: 'number' }, { id: 'z', label: 'z', type: 'number' }], outputs: [{ id: 'vector', label: 'vector', type: 'vector' }], fields: [{ key: 'fallback', label: 'Unconnected', type: 'vector', size: 3, default: [0, 0, 0] }] },
    { type: 'add', label: 'Add', category: 'Math', inputs: [{ id: 'a', label: 'a', type: 'number', required: true }, { id: 'b', label: 'b', type: 'number', required: true }], outputs: [{ id: 'sum', label: 'sum', type: 'number' }] },
    { type: 'multiply', label: 'Multiply', category: 'Math', inputs: [{ id: 'a', label: 'a', type: 'number', required: true }, { id: 'b', label: 'b', type: 'number', required: true }], outputs: [{ id: 'product', label: 'product', type: 'number' }] },
    { type: 'sum', label: 'Sum all', category: 'Math', description: 'Adds every connected number.', inputs: [{ id: 'values', label: 'values', type: 'number', multi: true }], outputs: [{ id: 'sum', label: 'sum', type: 'number' }] },
    { type: 'scale', label: 'Scale vector', category: 'Math', inputs: [{ id: 'vector', label: 'vector', type: 'vector', required: true }, { id: 'factor', label: 'factor', type: 'number' }], outputs: [{ id: 'vector', label: 'vector', type: 'vector' }] },
    { type: 'select', label: 'Select', category: 'Logic', description: 'a when the condition is true, else b.', inputs: [{ id: 'condition', label: 'condition', type: 'boolean', required: true }, { id: 'a', label: 'a', type: 'any' }, { id: 'b', label: 'b', type: 'any' }], outputs: [{ id: 'value', label: 'value', type: 'any' }], fields: [{ key: 'mode', label: 'Compare', type: 'enum', options: ['strict', 'loose'], default: 'strict' }] },
    { type: 'label', label: 'Label', category: 'Logic', description: 'Passes a value through under a name.', inputs: [{ id: 'in', label: 'in', type: 'any' }], outputs: [{ id: 'out', label: 'out', type: 'any' }], fields: [{ key: 'name', label: 'Name', type: 'string', default: '', maxLength: 32 }] },
    { type: 'output', label: 'Output', category: 'Output', description: 'The graph result.', inputs: [{ id: 'value', label: 'value', type: 'vector', required: true }], outputs: [], max: 1, required: true },
  ],
  allowCycles: false,
  // 4096: the framework's upper bound; the editor is measured at 2000 nodes.
  maxNodes: 4096,
  sinks: ['output'],
};

/** Every registered graph kind, by kind id. */
export const GRAPH_KINDS: Readonly<Record<string, GraphKindDef>> = {
  [TEST_GRAPH_KIND.kind]: TEST_GRAPH_KIND,
};
