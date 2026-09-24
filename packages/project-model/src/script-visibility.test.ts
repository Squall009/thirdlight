/**
 * Phase 15.4: declared-property visibility, group, header and tooltip in the
 * content model (validation and canonical form), `declaredInCode` on a source
 * record.
 */
import { describe, expect, it } from 'vitest';

import { canonicalContentV3, validateContentV4 } from './content';

function content(properties: unknown[], source: unknown = null): Record<string, unknown> {
  return {
    assets: [],
    prefabs: [],
    behaviors: [{ behaviorId: 'mover-a', displayName: 'Mover', declaration: { properties }, source, publishedRevision: 1 }],
    settings: {},
    behaviorTrust: { entries: [] },
    game: null,
    scenes: [{ sceneId: 'main', name: 'Main' }],
    startScenes: ['main'],
  };
}

const SPEED = { key: 'speed', label: 'Speed', type: 'number', default: 3 };
const SOURCE = {
  sourceDigest: 'a'.repeat(64),
  sourceByteLength: 10,
  entryPath: 'src/index.ts',
  fileCount: 1,
  manifestDigest: 'b'.repeat(64),
  outputDigest: 'c'.repeat(64),
  outputByteLength: 10,
  requiredModules: [],
  publishedRevision: 1,
};

describe('phase 15.4: script property visibility in the model', () => {
  it('accepts visibility, group, header and tooltip', () => {
    const r = validateContentV4(content([{ ...SPEED, visibility: 'private', group: 'Movement', header: 'Tuning', tooltip: 'How fast.' }, { ...SPEED, key: 'jump', visibility: 'public' }]));
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it('refuses a bad visibility and bad texts', () => {
    const codes = (p: Record<string, unknown>): string[] => {
      const r = validateContentV4(content([{ ...SPEED, ...p }]));
      return r.ok ? [] : r.errors.map((e) => `${e.code}@${e.path}`);
    };
    expect(codes({ visibility: 'hidden' })).toEqual(['field_value@/behaviors/0/declaration/properties/0/visibility']);
    expect(codes({ group: '' })).toEqual(['field_value@/behaviors/0/declaration/properties/0/group']);
    expect(codes({ header: 'x'.repeat(65) })).toEqual(['field_value@/behaviors/0/declaration/properties/0/header']);
    expect(codes({ tooltip: 7 })).toEqual(['field_type@/behaviors/0/declaration/properties/0/tooltip']);
  });

  it('the canonical form keeps private and the texts, and omits public (older bytes unchanged)', () => {
    const r = validateContentV4(content([{ tooltip: 'Help', group: 'G', visibility: 'private', header: 'H', ...SPEED }, { ...SPEED, key: 'jump', visibility: 'public' }], { ...SOURCE, declaredInCode: true }));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const canonical = canonicalContentV3(r.normalized as never);
    expect(canonical.behaviors[0]?.declaration.properties).toEqual([
      { key: 'speed', label: 'Speed', type: 'number', default: 3, visibility: 'private', group: 'G', header: 'H', tooltip: 'Help' },
      { key: 'jump', label: 'Speed', type: 'number', default: 3 },
    ]);
    expect(Object.keys(canonical.behaviors[0]?.declaration.properties[0] ?? {})).toEqual(['key', 'label', 'type', 'default', 'visibility', 'group', 'header', 'tooltip']);
    expect(canonical.behaviors[0]?.source?.declaredInCode).toBe(true);
  });

  it('declaredInCode is true or absent', () => {
    const r = validateContentV4(content([SPEED], { ...SOURCE, declaredInCode: false }));
    expect(r.ok ? [] : r.errors.map((e) => e.path)).toEqual(['/behaviors/0/source/declaredInCode']);
  });
});
