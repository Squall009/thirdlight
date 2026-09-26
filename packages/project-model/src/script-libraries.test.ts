/**
 * Phase 23.7: script library data rules — validation and bounds, the patch
 * rule, the digest (the canonical container) and the pins of behavior source
 * records (a pin names an existing library at its current digest).
 */
import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import {
  applyScriptLibraryPatch,
  canonicalScriptLibraries,
  scriptLibraryContainerText,
  scriptLibraryDigest,
  scriptLibrarySetKey,
  SCRIPT_LIBRARY_LIMITS,
  validateScriptLibraries,
  validateScriptLibrary,
  type ScriptLibrary,
} from './script-libraries';
import { validateContentV4 } from './content';

const LIB: ScriptLibrary = { libraryId: 'rules', name: 'Rules', files: [{ path: 'src/index.ts', text: 'export const a = 1;\n' }, { path: 'src/data.json', text: '{}' }] };
const errs = (fn: (e: ModelErrorV2[]) => void): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  fn(e);
  return e;
};

describe('script libraries (data)', () => {
  it('accepts a library with .ts and .json files and its entry', () => {
    expect(errs((e) => validateScriptLibrary(LIB, '', e))).toEqual([]);
  });

  it('refuses a missing entry, bad paths, duplicates, unknown fields and oversize files', () => {
    expect(errs((e) => validateScriptLibrary({ ...LIB, files: [{ path: 'src/a.ts', text: '' }] }, '', e))[0]?.code).toBe('field_missing');
    expect(errs((e) => validateScriptLibrary({ ...LIB, files: [...LIB.files, { path: 'src/a.tsx', text: '' }] }, '', e))[0]?.code).toBe('field_value');
    expect(errs((e) => validateScriptLibrary({ ...LIB, files: [...LIB.files, { path: 'src/index.ts', text: '' }] }, '', e))[0]?.code).toBe('id_duplicate');
    expect(errs((e) => validateScriptLibrary({ ...LIB, extra: 1 }, '', e))[0]?.code).toBe('field_unexpected');
    expect(errs((e) => validateScriptLibrary({ ...LIB, libraryId: 'Bad' }, '', e))[0]?.code).toBe('id_invalid');
    const big = 'x'.repeat(SCRIPT_LIBRARY_LIMITS.fileBytes + 1);
    expect(errs((e) => validateScriptLibrary({ ...LIB, files: [{ path: 'src/index.ts', text: big }] }, '', e)).some((x) => x.code === 'limits_exceeded')).toBe(true);
    expect(errs((e) => validateScriptLibraries([LIB, LIB], '', e)).some((x) => x.code === 'id_duplicate')).toBe(true);
  });

  it('the digest is the canonical container (file order does not matter; text does)', () => {
    const reordered = { ...LIB, files: [...LIB.files].reverse() };
    expect(scriptLibraryDigest(reordered)).toBe(scriptLibraryDigest(LIB));
    expect(scriptLibraryContainerText(LIB)).toContain('"entryPath": "src/index.ts"');
    expect(scriptLibraryDigest({ files: [{ path: 'src/index.ts', text: 'export const a = 2;\n' }] })).not.toBe(scriptLibraryDigest(LIB));
    expect(scriptLibrarySetKey([LIB])).not.toBe(scriptLibrarySetKey([{ ...LIB, files: [LIB.files[0]!] }]));
    expect(canonicalScriptLibraries([{ ...LIB, libraryId: 'z' }, LIB]).map((l) => l.libraryId)).toEqual(['rules', 'z']);
  });

  it('a patch adds, replaces and removes files and keeps the rest', () => {
    const r = applyScriptLibraryPatch(LIB, { libraryId: 'rules', files: [{ path: 'src/data.json', text: null }, { path: 'src/more.ts', text: 'x' }] });
    expect(r.ok && r.library.files.map((f) => f.path)).toEqual(['src/index.ts', 'src/more.ts']);
    expect(applyScriptLibraryPatch(null, { libraryId: 'n', files: [] }).ok).toBe(false);
    expect(applyScriptLibraryPatch(LIB, { libraryId: 'rules', files: [{ path: 'src/nope.ts', text: null }] }).ok).toBe(false);
  });

  it('a behavior pin must name an existing library at its current digest', () => {
    const content = (pins: unknown, libs: unknown[] = [LIB]): unknown =>
      structuredClone({
          assets: [],
          prefabs: [],
          behaviors: [{ behaviorId: 'b', displayName: 'B', declaration: { properties: [] }, source: { sourceDigest: 'a'.repeat(64), sourceByteLength: 10, entryPath: 'src/index.ts', fileCount: 1, manifestDigest: 'b'.repeat(64), outputDigest: 'c'.repeat(64), outputByteLength: 10, requiredModules: [], libraries: pins, publishedRevision: 1 }, publishedRevision: 1 }],
          settings: {},
          behaviorTrust: { entries: [] },
          game: null,
          scenes: [{ sceneId: 'main', name: 'Main' }],
          startScenes: ['main'],
          scriptLibraries: libs,
        });
    const codes = (doc: unknown): string[] => {
      const r = validateContentV4(doc) as { ok: boolean; errors?: { code: string }[] };
      return r.ok ? [] : (r.errors ?? []).map((e) => e.code);
    };
    expect(codes(content([{ libraryId: 'rules', sourceDigest: scriptLibraryDigest(LIB) }]))).toEqual([]);
    expect(codes(content([{ libraryId: 'rules', sourceDigest: 'f'.repeat(64) }]))).toContain('reference_missing');
    expect(codes(content([{ libraryId: 'gone', sourceDigest: scriptLibraryDigest(LIB) }]))).toContain('reference_missing');
  });
});
