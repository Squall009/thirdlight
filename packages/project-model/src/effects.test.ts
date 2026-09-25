/**
 * Phase 20.0/20.1: effect data — the catalogue's shape (contexts, chains,
 * field ports), validation (curves, gradients, parameters, systems), the
 * canonical form (the canonicalizer keeps every field), the component and
 * the content block (asset references of system graphs).
 */
import { describe, expect, it } from 'vitest';

import { curveValueError, gradientValueError, validateGraphData } from './graph';
import { EFFECT_CONTEXTS, EFFECT_CONTEXT_FLOWS, EFFECT_GRAPH_KIND, newEffectSystemGraph } from './effect-graph-kinds';
import { canonicalEffect, canonicalEffectComponent, effectComponentErrors, parseEffectSystemOwnerId, validateEffect, validateEffectComponent, type EffectDef } from './effects';
import { GRAPH_KINDS } from './graph-kinds';
import { validateContentV4 } from './content';
import type { ModelErrorV2 } from './errors';

const errs = (fn: (e: ModelErrorV2[]) => void): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  fn(e);
  return e;
};

const FX: EffectDef = {
  effectId: 'fx-a',
  name: 'Sparks',
  duration: 2,
  loop: true,
  seed: 3,
  bounds: { center: [0, 1, 0], size: [4, 4, 4] },
  parameters: [{ key: 'tint', type: 'color', default: '#ffaa00', visibility: 'public', label: 'Tint' }],
  systems: [
    {
      systemId: 'sparks',
      name: 'Sparks',
      maxParticles: 100,
      space: 'world',
      graph: {
        nodes: [...newEffectSystemGraph().nodes, { id: 'bb', type: 'output.billboard', position: [200, 600], data: { texture: 'tex-a' } }],
        edges: [{ id: 'e', from: { node: 'output', port: 'then' }, to: { node: 'bb', port: 'in' } }],
      },
    },
  ],
};

describe('the effect graph kind', () => {
  it('is registered, owned by effects, JSON data, with every node in a listed category', () => {
    expect(GRAPH_KINDS['effect']).toBe(EFFECT_GRAPH_KIND);
    expect(EFFECT_GRAPH_KIND.owner).toBe('effect');
    expect(JSON.parse(JSON.stringify(EFFECT_GRAPH_KIND))).toEqual(EFFECT_GRAPH_KIND);
    for (const n of EFFECT_GRAPH_KIND.nodes) expect(EFFECT_GRAPH_KIND.categories, n.type).toContain(n.category);
    expect(new Set(EFFECT_GRAPH_KIND.nodes.map((n) => n.type)).size).toBe(EFFECT_GRAPH_KIND.nodes.length);
  });

  it('has the four contexts as fixed nodes; each block chains within one context and exposes its value fields as ports', () => {
    for (const c of EFFECT_CONTEXTS) {
      const d = EFFECT_GRAPH_KIND.nodes.find((n) => n.type === c)!;
      expect(d.fixed).toBe(true);
      expect(d.outputs).toEqual([{ id: 'then', label: 'then', type: EFFECT_CONTEXT_FLOWS[c], single: true }]);
    }
    const flows = Object.values(EFFECT_CONTEXT_FLOWS) as string[];
    for (const n of EFFECT_GRAPH_KIND.nodes) {
      const inFlow = n.inputs.find((p) => p.id === 'in' && flows.includes(p.type));
      if (inFlow === undefined) {
        expect(n.inputs.every((p) => !flows.includes(p.type)), n.type).toBe(true);
        continue;
      }
      expect(n.outputs).toEqual([{ id: 'then', label: 'then', type: inFlow.type, single: true }]);
      // Every value port of a block is a field of the same key (unwired → the field).
      for (const p of n.inputs.filter((x) => x.id !== 'in')) expect(n.fields?.some((f) => f.key === p.id), `${n.type}.${p.id}`).toBe(true);
    }
    // Forces only in Update, renderers only in Output.
    expect(EFFECT_GRAPH_KIND.nodes.find((n) => n.type === 'update.gravity')!.inputs[0]!.type).toBe('update');
    expect(EFFECT_GRAPH_KIND.nodes.find((n) => n.type === 'output.billboard')!.inputs[0]!.type).toBe('render');
  });

  it('curve and gradient fields validate their shape', () => {
    expect(curveValueError([0, 1, 1, 0])).toBeNull();
    expect(curveValueError([0, 1])).not.toBeNull();
    expect(curveValueError([0.5, 1, 0.2, 0])).not.toBeNull();
    expect(curveValueError([0, 1, 1, 5], 0, 2)).not.toBeNull();
    expect(curveValueError([0, 1, 1.5, 0])).not.toBeNull();
    expect(gradientValueError([0, 1, 1, 1, 1])).toBeNull();
    expect(gradientValueError([0, 1, 1, 1])).not.toBeNull();
    expect(gradientValueError([0.6, 1, 1, 1, 1, 0.2, 0, 0, 0, 1])).not.toBeNull();
    expect(gradientValueError([0, 1, 1, 1, 1.2])).not.toBeNull();
    const g = { nodes: [...newEffectSystemGraph().nodes, { id: 'c', type: 'update.size.curve', position: [0, 0] as [number, number], data: { curve: [0, 2, 1, 200] } }], edges: [] };
    expect(errs((e) => validateGraphData(EFFECT_GRAPH_KIND, g, '', e))[0]!.message).toMatch(/a curve/);
  });
});

describe('effects', () => {
  it('validates and canonicalizes (every field kept, public omitted)', () => {
    expect(errs((e) => validateEffect(FX, '', e))).toEqual([]);
    const c = canonicalEffect(FX);
    expect(c.parameters).toEqual([{ key: 'tint', type: 'color', default: '#ffaa00', label: 'Tint' }]);
    expect(Object.keys(c)).toEqual(['effectId', 'name', 'duration', 'loop', 'seed', 'bounds', 'parameters', 'systems']);
    expect(Object.keys(c.systems[0]!)).toEqual(['systemId', 'name', 'maxParticles', 'space', 'graph']);
    expect(canonicalEffect(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(errs((e) => validateEffect({ ...FX, bounds: { center: [0, 0, 0], size: [0, 1, 1] } }, '', e))[0]!.path).toBe('/bounds/size');
    expect(errs((e) => validateEffect({ ...FX, systems: [{ ...FX.systems[0]!, maxParticles: 0 }] }, '', e))[0]!.path).toBe('/systems/0/maxParticles');
    expect(errs((e) => validateEffect({ ...FX, extra: 1 } as unknown as EffectDef, '', e))[0]!.code).toBe('field_unexpected');
    expect(parseEffectSystemOwnerId('fx-a/sparks')).toEqual({ effectId: 'fx-a', systemId: 'sparks' });
    expect(parseEffectSystemOwnerId('fx-a')).toBeNull();
  });

  it('the component: shape, canonical form and the project rule (public parameters only)', () => {
    expect(errs((e) => validateEffectComponent({ effectId: 'fx-a', playOnStart: false, params: { tint: '#00ff00' } }, '', e))).toEqual([]);
    expect(errs((e) => validateEffectComponent({ playOnStart: 1 }, '', e)).map((x) => x.code)).toEqual(['field_missing', 'field_type']);
    expect(canonicalEffectComponent({ effectId: 'fx-a', playOnStart: true, params: {} })).toEqual({ effectId: 'fx-a' });
    expect(effectComponentErrors({ effectId: 'fx-a', params: { tint: '#00ff00' } }, [FX])).toEqual([]);
    expect(effectComponentErrors({ effectId: 'fx-a', params: { tint: 3 } }, [FX])[0]!.message).toMatch(/colour/);
    expect(effectComponentErrors({ effectId: 'fx-a', params: { nope: 3 } }, [FX])[0]!.code).toBe('reference_missing');
    expect(effectComponentErrors({ effectId: 'fx-b' }, [FX])[0]!.message).toMatch(/names no effect/);
  });

  it('content: effects are an optional block; system graph assets must exist', () => {
    const base = { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null, scenes: [{ sceneId: 'main', name: 'Main' }], startScenes: ['main'] };
    const bad = validateContentV4({ ...base, effects: [FX] });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toMatch(/effects\/0\/systems\/0\/graph\/nodes\/4\/data\/texture/);
    const tex = { assetId: 'tex-a', kind: 'texture', displayName: 'T', currentVersion: 1, versions: [] };
    const withAsset = validateContentV4({ ...base, assets: [tex], effects: [FX] });
    // (the asset record itself may be refused for its versions; the effect reference is not)
    expect(JSON.stringify(withAsset)).not.toMatch(/effects\/0\/systems\/0\/graph\/nodes\/4\/data\/texture/);
    const none = validateContentV4({ ...base, effects: [] });
    expect(none.ok).toBe(true);
    if (none.ok) expect((none.normalized as unknown as Record<string, unknown>)['effects']).toBeUndefined();
  });
});
