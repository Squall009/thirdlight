/**
 * Phase 10: the optional `sourcePath` of an asset version (a file referenced
 * in place in the game folder). Syntax only here; containment on disk is the
 * workspace's (referenced-sources.test.ts).
 */
import { describe, expect, it } from 'vitest';

import { isValidSourcePath, normalizeContentV3, validateContentV3 } from '@thirdlight/project-model';
import { m3ContractFixtureText } from './test-fixtures';

describe('isValidSourcePath', () => {
  it('accepts relative forward-slash paths inside the folder', () => {
    for (const ok of ['a.glb', 'assets/env/kit/meadow/env_kit_meadow.glb', 'assets/a b/c-d_e.1.wav', 'x/.hidden/y.glb']) {
      expect(isValidSourcePath(ok), ok).toBe(true);
    }
  });
  it('refuses anything that could leave the folder or is not a plain relative name', () => {
    for (const bad of ['', '/etc/passwd', '../x.glb', 'a/../../x.glb', 'a/./b.glb', './a.glb', 'a//b.glb', 'a/', 'a\\b.glb', 'C:/x.glb', 'a\u0000b', 'a\nb', 'x'.repeat(513), 3, null]) {
      expect(isValidSourcePath(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('asset version sourcePath in the v3 content block', () => {
  const doc = JSON.parse(m3ContractFixtureText('catalog/referenced-model-record-v3.json')) as { content: { assets: Array<{ versions: Array<Record<string, unknown>> }> } };

  it('is optional, validated and kept by normalization (after sourceByteLength)', () => {
    const n = normalizeContentV3(doc.content);
    expect(n.ok).toBe(true);
    if (!n.ok) return;
    const v = n.normalized.assets[0]!.versions[0]!;
    expect(v.sourcePath).toBe('assets/characters/courier.glb');
    expect(Object.keys(v).slice(0, 4)).toEqual(['version', 'sourceDigest', 'sourceByteLength', 'sourcePath']);
  });

  it('refuses an escaping or non-string sourcePath at its JSON pointer', () => {
    for (const bad of ['../courier.glb', '/abs/courier.glb', 7]) {
      const content = structuredClone(doc.content);
      content.assets[0]!.versions[0]!['sourcePath'] = bad;
      const r = validateContentV3(content);
      expect(r.ok, String(bad)).toBe(false);
      if (r.ok) continue;
      expect(r.errors[0]).toMatchObject({ code: typeof bad === 'string' ? 'field_value' : 'field_type', path: '/assets/0/versions/0/sourcePath' });
    }
  });
});
