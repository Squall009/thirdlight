/**
 * Phase 15.4: the declaration editor model (drafts ⇄ declaration) and the
 * Inspector's handling of private properties (not shown, never sent).
 */
import { describe, expect, it } from 'vitest';
import type { PropertyDeclaration } from '@thirdlight/project-model';

import { declarationOf, draftsOf, newPropertyDraft, retype } from './declaration-draft';
import { derivePropertyControls, planSetBehaviorProperties } from './property-controls';

const DECLARATION: PropertyDeclaration = {
  properties: [
    { key: 'speed', label: 'Speed', type: 'number', default: 3, min: 0, max: 10, step: 0.5, group: 'Movement', tooltip: 'Metres per second' },
    { key: 'secret', label: 'Secret', type: 'number', default: 1, visibility: 'private' },
    { key: 'mode', label: 'Mode', type: 'enum', default: 'walk', values: ['walk', 'run'], header: 'Gait' },
    { key: 'tint', label: 'Tint', type: 'vec3', default: [1, 0.5, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] } },
    { key: 'on', label: 'On', type: 'boolean', default: true },
    { key: 'name', label: 'Name', type: 'string', default: 'x', maxLength: 8 },
    { key: 'target', label: 'Target', type: 'entityRef', default: null },
    { key: 'look', label: 'Look', type: 'assetRef', default: null },
  ],
};

describe('phase 15.4: declaration drafts', () => {
  it('round-trips every property type, visibility, group, header and tooltip', () => {
    const r = declarationOf(draftsOf(DECLARATION));
    if (!r.ok) throw new Error(JSON.stringify(r.problem));
    expect(r.declaration).toEqual(DECLARATION);
  });

  it('reports the first problem next to its field', () => {
    const drafts = draftsOf(DECLARATION);
    expect(declarationOf([{ ...drafts[0]!, default: 'fast' }])).toEqual({ ok: false, problem: { index: 0, field: 'default', message: 'the default must be a number' } });
    expect(declarationOf([drafts[0]!, { ...drafts[1]!, key: 'speed' }])).toMatchObject({ ok: false, problem: { index: 1, field: 'key' } });
    expect(declarationOf([{ ...drafts[2]!, default: 'fly' }])).toMatchObject({ ok: false, problem: { field: 'default' } });
    expect(declarationOf([{ ...drafts[3]!, boundsMax: '1, 1' }])).toMatchObject({ ok: false, problem: { field: 'boundsMax' } });
    expect(declarationOf([])).toMatchObject({ ok: false, problem: { field: 'properties' } });
  });

  it('new properties get unused keys; retyping resets the default', () => {
    const one = newPropertyDraft([]);
    const two = newPropertyDraft([one]);
    expect([one.key, two.key]).toEqual(['value', 'value_2']);
    const vec = retype(one, 'vec3');
    expect(declarationOf([vec])).toEqual({ ok: true, declaration: { properties: [{ key: 'value', label: 'Value', type: 'vec3', default: [0, 0, 0] }] } });
  });
});

describe('phase 15.4: the Inspector hides private properties', () => {
  it('derives controls for public properties only, with group/header/tooltip', () => {
    const controls = derivePropertyControls(DECLARATION, { speed: 5, secret: 9 });
    expect(controls.map((c) => c.key)).toEqual(['speed', 'mode', 'tint', 'on', 'name', 'target', 'look']);
    expect(controls[0]).toMatchObject({ current: 5, group: 'Movement', tooltip: 'Metres per second' });
    expect(controls[1]).toMatchObject({ header: 'Gait' });
  });

  it('a property edit never sends a private key and a private edit is refused', () => {
    const plan = planSetBehaviorProperties('box-1', 'mover-a', DECLARATION, { speed: 5, secret: 9 }, 'speed', 6);
    if (!plan.ok) throw new Error(JSON.stringify(plan.error));
    expect(Object.keys(plan.args.values ?? {})).not.toContain('secret');
    expect(plan.args.values?.['speed']).toBe(6);
    const refused = planSetBehaviorProperties('box-1', 'mover-a', DECLARATION, {}, 'secret', 2);
    expect(refused).toMatchObject({ ok: false, error: { code: 'property_private' } });
  });
});
