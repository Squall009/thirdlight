/**
 * The `font` asset kind through `publishAsset` — a create with the
 * `font` recipe and metrics, the kind stays immutable on reimport, and the
 * per-project caps (16 fonts, 8 versions per font) refuse with `font_assets` /
 * `font_versions`. A bad recipe or bad metrics are refused by the model.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV3 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';
import { m3NeutralJson } from './test-fixtures';

interface EnvelopeFixture {
  projectId: string;
  scene: SceneV3;
  content: ContentDocument;
}

const BEFORE = m3NeutralJson<EnvelopeFixture>('commands/scenario.before.json');
type State = CommandState<SceneV3>;
const RECIPE = { profile: 'font', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } };

let counter = 0;
function req(args: Record<string, unknown>, expectedRevision: number): unknown {
  counter += 1;
  return { op: 'publishAsset', projectId: BEFORE.projectId, expectedRevision, requestId: `req-${counter.toString(16).padStart(32, '0')}`, args };
}
function publish(mode: 'create' | 'reimport', assetId: string, n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode, assetId, kind: 'font', sourceDigest: n.toString(16).padStart(64, '0'), sourceByteLength: 1000 + n, importRecipe: RECIPE, metrics: { format: 'ttf', familyName: 'Neutral Sans' }, importedAt: '2026-09-26T00:00:00Z', ...extra };
}
function start(): State {
  return createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content) as unknown as ContentDocument) as unknown as State;
}

describe('publishAsset kind "font" (phase 23.9a)', () => {
  it('creates a font record; the kind is immutable on reimport', () => {
    const created = applyMutation(start(), req(publish('create', 'font-a', 1), 0));
    expect(created.ok, JSON.stringify(created.result)).toBe(true);
    if (!created.ok) return;
    const next = created.state as State;
    const record = (next.content as unknown as { assets: Array<{ assetId: string; kind: string; versions: Array<{ metrics: unknown; importRecipe: unknown }> }> }).assets.find((a) => a.assetId === 'font-a');
    expect(record?.kind).toBe('font');
    expect(record?.versions[0]!.metrics).toEqual({ format: 'ttf', familyName: 'Neutral Sans' });
    expect(record?.versions[0]!.importRecipe).toEqual(RECIPE);
    const mismatch = applyMutation(next, req(publish('reimport', 'font-a', 2, { kind: 'texture' }), 1));
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.result.error.code).toBe('asset_kind_mismatch');
  });

  it('refuses a wrong recipe profile, an unknown format and an unexpected metric', () => {
    for (const extra of [{ importRecipe: { ...RECIPE, profile: 'image' } }, { metrics: { format: 'eot' } }, { metrics: { format: 'woff2', glyphs: 95 } }, { metrics: { format: 'ttf', familyName: '' } }]) {
      const out = applyMutation(start(), req(publish('create', 'font-a', 1, extra), 0));
      expect(out.ok, JSON.stringify(extra)).toBe(false);
    }
    // A WOFF2 without a family name is fine.
    expect(applyMutation(start(), req(publish('create', 'font-a', 1, { metrics: { format: 'woff2' } }), 0)).ok).toBe(true);
  });

  it('caps a project at 16 fonts and a font at 8 versions', () => {
    let s = start();
    let rev = 0;
    for (let i = 0; i < 16; i++) {
      const out = applyMutation(s, req(publish('create', `font-${i}`, i + 1), rev));
      expect(out.ok, JSON.stringify(out.result)).toBe(true);
      if (out.ok) s = out.state as State;
      rev += 1;
    }
    const seventeenth = applyMutation(s, req(publish('create', 'font-16', 99), rev));
    expect(seventeenth.ok).toBe(false);
    if (!seventeenth.ok) expect(seventeenth.result.error).toMatchObject({ code: 'limits_exceeded', limit: 'font_assets', max: 16 });
    for (let v = 2; v <= 8; v++) {
      const out = applyMutation(s, req(publish('reimport', 'font-0', 100 + v), rev));
      expect(out.ok, JSON.stringify(out.result)).toBe(true);
      if (out.ok) s = out.state as State;
      rev += 1;
    }
    const ninth = applyMutation(s, req(publish('reimport', 'font-0', 200), rev));
    expect(ninth.ok).toBe(false);
    if (!ninth.ok) expect(ninth.result.error).toMatchObject({ code: 'limits_exceeded', limit: 'font_versions', max: 8 });
  });

  it('refuses an unknown kind with the font in the expected list', () => {
    const out = applyMutation(start(), req(publish('create', 'font-a', 1, { kind: 'glyphs' }), 0));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.result.error.message).toContain('"font"');
  });
});
