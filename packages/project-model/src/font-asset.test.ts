/**
 * Phase 23.9a: `font` asset records in the v4 catalog — accepted with the
 * `font` recipe and `{format, familyName?}` metrics (canonical form keeps the
 * optional name), refused with a bad kind member, and capped at 16 records
 * (`font_assets`) and 8 versions per record (`font_versions`).
 */
import { describe, expect, it } from 'vitest';

import { validateContentV4 } from './content';
import { ASSET_KINDS } from './descriptors';

const base = { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null, scenes: [{ sceneId: 'main', name: 'Main' }], startScenes: ['main'] };
const RECIPE = { profile: 'font', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } };

function version(n: number, metrics: Record<string, unknown> = { format: 'ttf', familyName: 'Neutral Sans' }, recipe: Record<string, unknown> = RECIPE) {
  return { version: n, sourceDigest: n.toString(16).padStart(64, '0'), sourceByteLength: 1000, importRecipe: recipe, metrics, importedAt: '2026-09-26T00:00:00Z', publishedRevision: n };
}
function font(assetId: string, versions = [version(1)]) {
  return { assetId, kind: 'font', displayName: assetId, currentVersion: versions.length, versions };
}
const limitOf = (r: ReturnType<typeof validateContentV4>): unknown[] => (r.ok ? [] : r.errors.map((e) => (e as { limit?: unknown }).limit ?? e.code));

describe('font asset records (phase 23.9a)', () => {
  it('accepts a font record and keeps its metrics canonical', () => {
    const r = validateContentV4({ ...base, assets: [font('font-a'), font('font-b', [version(1, { format: 'woff2' })])] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const assets = (r.normalized as unknown as { assets: Array<{ kind: string; versions: Array<{ metrics: unknown }> }> }).assets;
    expect(assets.map((a) => a.kind)).toEqual(['font', 'font']);
    expect(assets[0]!.versions[0]!.metrics).toEqual({ format: 'ttf', familyName: 'Neutral Sans' });
    expect(assets[1]!.versions[0]!.metrics).toEqual({ format: 'woff2' });
    expect(ASSET_KINDS).toContain('font');
  });

  it('refuses a wrong recipe, an unknown format, an extra metric and a control character in the name', () => {
    for (const v of [
      version(1, undefined, { ...RECIPE, profile: 'music' }),
      version(1, { format: 'eot' }),
      version(1, { format: 'otf', glyphs: 3 }),
      version(1, { format: 'ttf', familyName: 'bad\u0001name' }),
    ]) {
      expect(validateContentV4({ ...base, assets: [font('font-a', [v])] }).ok, JSON.stringify(v)).toBe(false);
    }
  });

  it('caps a catalog at 16 fonts and a font at 8 versions', () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => font(`font-${String(i).padStart(2, '0')}`));
    expect(validateContentV4({ ...base, assets: sixteen }).ok).toBe(true);
    expect(limitOf(validateContentV4({ ...base, assets: [...sixteen, font('font-zz')] }))).toContain('font_assets');
    const eight = Array.from({ length: 8 }, (_, i) => version(i + 1));
    expect(validateContentV4({ ...base, assets: [font('font-a', eight)] }).ok).toBe(true);
    expect(limitOf(validateContentV4({ ...base, assets: [font('font-a', [...eight, version(9)])] }))).toContain('font_versions');
  });
});
