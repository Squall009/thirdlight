import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { SAVE_LIMITS, canonicalSaveSchema, settingsDocumentOf, validateSaveSchema, type SaveSchema } from './save-schema';

const problems = (v: unknown): string[] => {
  const errors: ModelErrorV2[] = [];
  validateSaveSchema(v, '/saveSchema', errors);
  return errors.map((e) => e.path);
};

describe('the project save schema', () => {
  it('accepts a full schema and canonicalizes it', () => {
    const s: SaveSchema = {
      settings: [
        { key: 'music', type: 'number', default: 0.5, engine: 'music' },
        { key: 'quality', type: 'enum', values: ['low', 'high'], default: 'high', engine: 'quality' },
        { key: 'subtitles', type: 'bool', default: true, label: 'Subtitles' },
      ],
      sections: ['storage', 'grid'],
      migrations: [{ name: 'v2to3', from: 2 }, { from: 1, name: 'v1to2' }],
      slots: 12,
      version: 3,
      thumbnail: { width: 160, height: 90, format: 'webp', quality: 0.7 },
    };
    expect(problems(s)).toEqual([]);
    const c = canonicalSaveSchema(s);
    expect(Object.keys(c)).toEqual(['version', 'slots', 'migrations', 'sections', 'thumbnail', 'settings']);
    expect(c.sections).toEqual(['grid', 'storage']);
    expect(c.migrations!.map((m) => m.from)).toEqual([1, 2]);
  });

  it('enforces the engine caps and shapes', () => {
    expect(problems({ version: 1, slots: SAVE_LIMITS.slots + 1 })).toEqual(['/saveSchema/slots']);
    expect(problems({ version: 0, slots: 1 })).toEqual(['/saveSchema/version']);
    expect(problems({ version: 2, slots: 1, migrations: [{ from: 2, name: 'x' }] })).toEqual(['/saveSchema/migrations/0/from']);
    expect(problems({ version: 3, slots: 1, migrations: [{ from: 1, name: 'a' }, { from: 1, name: 'b' }] })).toEqual(['/saveSchema/migrations/1/from']);
    expect(problems({ version: 1, slots: 1, sections: ['grid', 'nope'] })).toEqual(['/saveSchema/sections/1']);
    expect(canonicalSaveSchema({ version: 1, slots: 1, sections: ['grid', 'grid'] }).sections).toEqual(['grid']);
    expect(problems({ version: 1, slots: 1, thumbnail: { width: 1024, height: 90, format: 'jpeg' } })).toEqual(['/saveSchema/thumbnail/width']);
    expect(problems({ version: 1, slots: 1, extra: 1 })).toEqual(['/saveSchema/extra']);
    // A volume binding is a 0–1 number; a default must fit its field.
    expect(problems({ version: 1, slots: 1, settings: [{ key: 'v', type: 'bool', default: true, engine: 'sfx' }] })).toEqual(['/saveSchema/settings/0/engine']);
    expect(problems({ version: 1, slots: 1, settings: [{ key: 'v', type: 'number', default: 2, engine: 'sfx' }] })).toEqual(['/saveSchema/settings/0/default']);
    expect(problems({ version: 1, slots: 1, settings: [{ key: 'a', type: 'bool', default: true }, { key: 'a', type: 'bool', default: false }] })).toEqual(['/saveSchema/settings/1/key']);
  });

  it('a settings document keeps stored values that still fit, defaults for the rest', () => {
    const fields: SaveSchema['settings'] = [
      { key: 'volume', type: 'number', default: 0.8, engine: 'music' },
      { key: 'difficulty', type: 'enum', values: ['easy', 'hard'], default: 'easy' },
      { key: 'name', type: 'string', default: '' },
    ];
    expect(settingsDocumentOf(fields!, { volume: 3, difficulty: 'hard', name: 7, stray: 1 })).toEqual({ volume: 0.8, difficulty: 'hard', name: '' });
    expect(settingsDocumentOf(fields!, null)).toEqual({ volume: 0.8, difficulty: 'easy', name: '' });
  });
});
