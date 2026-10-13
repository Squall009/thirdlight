/**
 * Kits as content: the shape a kit may have, its canonical form, and the
 * problems its references raise against the project (never a refusal).
 */
import { describe, expect, it } from 'vitest';

import { canonicalKit, kitProblems, validateKits, type KitDef } from './kits';
import type { ModelErrorV2 } from './errors';

const errorsOf = (v: unknown): ModelErrorV2[] => {
  const errors: ModelErrorV2[] = [];
  validateKits(v, '/kits', errors);
  return errors;
};

describe('kits', () => {
  it('accepts a full kit and an empty one; ids are unique', () => {
    const full: KitDef = { kitId: 'town', name: 'Town', description: 'Plaster and timber', thumbnail: 'town-pic', trimMaterial: 'town-trim', presets: ['house'], blockTypes: ['wall', 'floor'], pieces: { door: [{ assetId: 'doors', piece: 'Door_A', weight: 2 }], 'arch-door': [{ assetId: 'doors' }] } };
    expect(errorsOf([full, { kitId: 'empty', name: 'Empty' }])).toEqual([]);
    expect(errorsOf([full, full]).map((e) => e.code)).toEqual(['id_duplicate']);
    expect(errorsOf({}).map((e) => e.code)).toEqual(['field_type']);
  });

  it('refuses unknown fields, bad slot names, empty or oversized slots and bad pieces', () => {
    const codes = (k: Record<string, unknown>): string[] => errorsOf([{ kitId: 'k', name: 'K', ...k }]).map((e) => `${e.code} ${e.path}`);
    expect(codes({ colour: 1 })).toEqual(['field_unexpected /kits/0/colour']);
    expect(codes({ pieces: { Door: [{ assetId: 'a' }] } })).toEqual(['field_value /kits/0/pieces/Door']);
    expect(codes({ pieces: { door: [] } })).toEqual(['field_value /kits/0/pieces/door']);
    expect(codes({ pieces: { door: [{ assetId: 'a', node: 'x' }] } })).toEqual(['field_unexpected /kits/0/pieces/door/0/node']);
    expect(codes({ pieces: { door: [{ assetId: 'a', weight: 1001 }] } })).toEqual(['field_value /kits/0/pieces/door/0/weight']);
    expect(codes({ blockTypes: ['wall', 'wall'] })).toEqual(['id_duplicate /kits/0/blockTypes/1']);
    expect(codes({ description: 'x'.repeat(1025) })).toEqual(['field_value /kits/0/description']);
  });

  it('canonical form: fields in order, empty lists and default weights left out, slots by name', () => {
    const k = canonicalKit({ pieces: { window: [{ assetId: 'w', weight: 1 }], door: [{ assetId: 'd' }] }, presets: [], blockTypes: ['b'], name: 'N', kitId: 'n', description: '' });
    expect(JSON.stringify(k)).toBe('{"kitId":"n","name":"N","blockTypes":["b"],"pieces":{"door":[{"assetId":"d"}],"window":[{"assetId":"w"}]}}');
  });

  it('reports each reference the project does not satisfy, in plain words', () => {
    const kits: KitDef[] = [
      { kitId: 'ok', name: 'Fine', trimMaterial: 'inst', presets: ['house'], blockTypes: ['wall'], pieces: { door: [{ assetId: 'door-model' }] }, thumbnail: 'pic' },
      { kitId: 'bad', name: 'Broken', trimMaterial: 'plain', presets: ['house', 'gone', 'fx'], blockTypes: ['nope'], pieces: { window: [{ assetId: 'pic' }, { assetId: 'lost' }] }, thumbnail: 'door-model' },
    ];
    const rows = kitProblems({
      kits,
      // A trim sheet material instance draws with its root's rows, so it counts as a trim sheet.
      materials: [
        { materialId: 'sheet', name: 'Sheet', shader: 'trim', params: {}, textures: {} },
        { materialId: 'inst', name: 'Inst', instanceOf: 'sheet' } as never,
        { materialId: 'plain', name: 'Plain', shader: 'standard', params: {}, textures: {} },
      ],
      graphs: [
        { graphId: 'house', kind: 'architecture-preset' },
        { graphId: 'fx', kind: 'material-function' },
      ],
      blockTypes: [{ blockId: 'wall' }],
      assets: [
        { assetId: 'door-model', kind: 'model' },
        { assetId: 'pic', kind: 'texture' },
      ],
    });
    expect(rows).toEqual([
      {
        kitId: 'bad',
        name: 'Broken',
        problems: [
          'its trim material "plain" is not a trim sheet material',
          'preset "gone" is not in the project',
          '"fx" is a material-function graph, not an architecture preset',
          'block type "nope" is not in the project',
          'the window piece "pic" is a texture, not a model',
          'the window piece\'s model "lost" is not in the project',
          'its thumbnail "door-model" is a model, not a texture',
        ],
      },
    ]);
  });
});
