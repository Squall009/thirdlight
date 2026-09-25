/**
 * Phase 20.0/20.1: effect data — the catalogue's shape (contexts, chains,
 * field ports), validation (curves, gradients, parameters, systems), the
 * canonical form (the canonicalizer keeps every field), the component and
 * the content block (asset references of system graphs).
 */
import { describe, expect, it } from 'vitest';

import { curveValueError, gradientValueError, validateGraphData } from './graph';
import { EFFECT_CONTEXTS, EFFECT_CONTEXT_FLOWS, EFFECT_GRAPH_KIND, newEffectSystemGraph } from './effect-graph-kinds';
import { canonicalEffect, canonicalEffectComponent, effectAssetRefs, effectComponentErrors, effectHookRefs, effectMaterialRefs, effectsForRuntime, parseEffectSystemOwnerId, validateEffect, validateEffectComponent, type EffectDef } from './effects';
import { canonicalEnemy, canonicalHealth, canonicalPickup, validateEnemyComponent, validateHealthComponent, validatePickupComponent } from './blocks';
import { validateGameZoneComponent } from './scene-v3';
import { captureManifestV2, validateManifestV2 } from './manifest-v2';
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

  it('phase 20.2: the component starts and stops on signals (canonical: the new fields last)', () => {
    expect(errs((e) => validateEffectComponent({ effectId: 'fx-a', playOnStart: false, signal: 'go', stopSignal: 'halt' }, '', e))).toEqual([]);
    expect(errs((e) => validateEffectComponent({ effectId: 'fx-a', signal: 'bad signal!' }, '', e))[0]!.path).toBe('/signal');
    expect(Object.keys(canonicalEffectComponent({ stopSignal: 'halt', signal: 'go', effectId: 'fx-a', params: { tint: '#00FF00' } }))).toEqual(['effectId', 'params', 'signal', 'stopSignal']);
    // An existing component keeps its exact canonical bytes.
    expect(JSON.stringify(canonicalEffectComponent({ effectId: 'fx-a', playOnStart: false }))).toBe('{"effectId":"fx-a","playOnStart":false}');
  });

  it('phase 20.2: gameplay hooks name effects (pickup, enemy, health, checkpoint/goal zones)', () => {
    expect(errs((e) => validatePickupComponent({ kind: 'coin', value: 1, effect: 'fx-a' }, '', e))).toEqual([]);
    expect(errs((e) => validatePickupComponent({ kind: 'coin', value: 1, effect: 'Not an id' }, '', e))[0]!.path).toBe('/effect');
    expect(errs((e) => validateHealthComponent({ max: 3, hitEffect: 'fx-a' }, '', e))).toEqual([]);
    const enemy = { patrol: 'edges', speed: 1, size: [1, 1], contactDamage: 1, stompable: true, health: 1 };
    expect(errs((e) => validateEnemyComponent({ ...enemy, hitEffect: 'fx-a', defeatEffect: 'fx-b' }, '', e))).toEqual([]);
    expect(canonicalPickup({ kind: 'coin', value: 1, effect: 'fx-a' } as never)).toEqual({ kind: 'coin', value: 1, effect: 'fx-a' });
    expect(canonicalHealth({ max: 3, hitEffect: 'fx-a' } as never)).toEqual({ max: 3, hitEffect: 'fx-a' });
    expect(Object.keys(canonicalEnemy({ ...enemy, defeatEffect: 'fx-b', hitEffect: 'fx-a' } as never)).slice(-2)).toEqual(['hitEffect', 'defeatEffect']);
    const zone = (z: Record<string, unknown>): string[] => {
      const e: { path: string }[] = [];
      validateGameZoneComponent(z, '', e as never, 4);
      return e.map((x) => x.path);
    };
    expect(zone({ role: 'goal', size: [1, 1], effect: 'fx-a' })).toEqual([]);
    expect(zone({ role: 'hazard', size: [1, 1], effect: 'fx-a' })).toEqual(['/effect']);
    expect(effectHookRefs({ pickup: { effect: 'fx-a' }, enemy: { hitEffect: 'fx-b', defeatEffect: 'fx-c' }, health: { hitEffect: 'fx-d' }, gameZone: { effect: 'fx-e' } })).toEqual([
      ['pickup/effect', 'fx-a'],
      ['enemy/hitEffect', 'fx-b'],
      ['enemy/defeatEffect', 'fx-c'],
      ['health/hitEffect', 'fx-d'],
      ['gameZone/effect', 'fx-e'],
    ]);
  });

  it('phase 20.2: the runtime view (manifest effects): graphs without editor text, the assets and materials the graphs name', () => {
    const withText: EffectDef = { ...FX, systems: [{ ...FX.systems[0]!, graph: { ...FX.systems[0]!.graph, comments: [{ id: 'c', position: [0, 0], size: [100, 50], text: 'note' }] } as never }] };
    const rt = effectsForRuntime([withText]);
    expect((rt[0]!.systems[0]!.graph as unknown as Record<string, unknown>)['comments']).toBeUndefined();
    expect(rt[0]!.systems[0]!.graph.nodes).toHaveLength(5);
    expect(effectAssetRefs(FX)).toEqual([{ asset: 'texture', id: 'tex-a' }]);
    const nodes = [...FX.systems[0]!.graph.nodes.slice(0, 4), { id: 'bb', type: 'output.billboard', position: [0, 0] as [number, number], data: { shading: 'material', material: 'mat-a' } }];
    const shaded: EffectDef = { ...FX, systems: [{ ...FX.systems[0]!, graph: { ...FX.systems[0]!.graph, nodes } }] };
    expect(effectMaterialRefs(shaded)).toEqual(['mat-a']);
  });

  it('phase 20.2: the manifest carries the effects (an optional key, validated)', () => {
    const SETTINGS = { gravity_y: -19.62, run_speed: 4, jump_velocity: 7, max_fall_speed: -30, max_slope_climb_deg: 45, min_slope_slide_deg: 30 };
    const DIGEST = '0123456789abcdef'.repeat(4);
    const input = { projectId: 'demo-0001', revision: 1, capturedAt: '2026-09-25T10:00:00Z', sceneDigest: DIGEST, contentDigest: DIGEST, assets: [], behaviors: [], settings: SETTINGS, game: null, media: { cues: { start: null, jump: null, checkpoint: null, death: null, goal: null }, animation: [] }, moduleIds: [] };
    const plain = captureManifestV2(input as never);
    expect(plain.ok).toBe(true);
    if (plain.ok) expect('effects' in plain.manifest).toBe(false);
    const withFx = captureManifestV2({ ...input, effects: effectsForRuntime([FX]) } as never);
    expect(withFx.ok).toBe(true);
    if (!withFx.ok) return;
    expect((withFx.manifest as unknown as { effects: EffectDef[] }).effects.map((e) => e.effectId)).toEqual(['fx-a']);
    expect(validateManifestV2(withFx.manifest).ok).toBe(true);
    const broken = { ...withFx.manifest, effects: [{ ...FX, duration: -1 }] };
    expect(validateManifestV2(broken).ok).toBe(false);
  });
});
