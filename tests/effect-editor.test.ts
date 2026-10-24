/**
 * The editor's effect code against project-model, which validates what it
 * sends:
 *
 * - a new effect and a new system built by the editor are what the backend
 *   accepts;
 * - the parameter port context types the effect graph's ports (Parameter
 *   nodes, attribute maps, auto maths widths).
 */
import { describe, expect, it } from 'vitest';

import { EFFECT_DEFAULTS, EFFECT_GRAPH_KIND, newEffectSystemGraph, validateEffect, type EffectParameter, type GraphData, type ModelErrorV2 } from '../packages/project-model/src/index';
import * as editor from '../packages/editor/src/graph/model';
import { newEffect, newSystem, uniqueId } from '../packages/editor/src/session/effect-edit';
import { effectPortContext } from '../packages/editor/src/ui/effect/EffectDocument';

describe('effect editor', () => {
  it('a new effect and a new system match project-model and validate', () => {
    const sys = newSystem('system-1', 'System 1');
    expect(sys.graph).toEqual(newEffectSystemGraph());
    expect(sys.maxParticles).toBe(EFFECT_DEFAULTS.maxParticles);
    expect(sys.space).toBe(EFFECT_DEFAULTS.space);
    const fx = { ...newEffect('sparks', 'Sparks'), systems: [sys] };
    expect({ duration: fx.duration, loop: fx.loop, seed: fx.seed, bounds: fx.bounds }).toEqual({ duration: EFFECT_DEFAULTS.duration, loop: EFFECT_DEFAULTS.loop, seed: EFFECT_DEFAULTS.seed, bounds: EFFECT_DEFAULTS.bounds });
    const errors: ModelErrorV2[] = [];
    validateEffect(fx, '', errors);
    expect(errors).toEqual([]);
    expect(uniqueId('System 1', ['system-1'], 'system')).toBe('system-1-2');
    expect(uniqueId('!!!', [], 'effect')).toBe('effect');
  });

  it('the editor resolves effect ports from the effect\'s parameters', () => {
    const params: EffectParameter[] = [
      { key: 'rate', type: 'float', default: 1 },
      { key: 'wind', type: 'vec3', default: [0, 0, 0] },
      { key: 'tint', type: 'color', default: '#ffffff' },
    ];
    const g: GraphData = {
      nodes: [
        ...newEffectSystemGraph().nodes,
        { id: 'p1', type: 'value.parameter', position: [0, 0], data: { key: 'rate' } },
        { id: 'p2', type: 'value.parameter', position: [0, 0], data: { key: 'wind' } },
        { id: 'p3', type: 'value.parameter', position: [0, 0], data: { key: 'tint' } },
        { id: 'p4', type: 'value.parameter', position: [0, 0], data: { key: 'ghost' } },
        { id: 'a', type: 'value.attribute', position: [0, 0], data: { attribute: 'velocity' } },
        { id: 'm', type: 'math.multiply', position: [0, 0] },
        { id: 'grav', type: 'update.gravity', position: [0, 0] },
      ],
      edges: [
        { id: 'e1', from: { node: 'a', port: 'value' }, to: { node: 'm', port: 'a' } },
        { id: 'e2', from: { node: 'p1', port: 'value' }, to: { node: 'm', port: 'b' } },
        { id: 'e3', from: { node: 'm', port: 'out' }, to: { node: 'grav', port: 'acceleration' } },
      ],
    };
    const theirs = editor.resolvePorts(EFFECT_GRAPH_KIND, g, effectPortContext(params));
    expect(theirs.get('p2')!.outputs[0]!.type).toBe('vec3');
    expect(theirs.get('p3')!.outputs[0]!.type).toBe('color');
    expect(theirs.get('p4')!.outputs[0]!.type).toBe('float');
    expect(theirs.get('m')!.outputs[0]!.type).toBe('vec3');
  });
});
