/**
 * `importAssets`, the pure command: the files' facts come only from the
 * host's prepared import (never the request), every record is created in one
 * revision and one history entry with the request's labels and each file's
 * own, and undo/redo forget and bring back the whole batch.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, PreparedAssetImport } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
const MODEL = BEFORE.content.assets[0]!;
const FACTS = (() => {
  const v = MODEL.versions[0]!;
  return { kind: 'model' as const, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength, importRecipe: v.importRecipe, metrics: v.metrics, importedAt: '2026-09-29T00:00:00Z' };
})();

function state(prepared?: PreparedAssetImport): CommandState<SceneV4> {
  const s = createCommandState(BEFORE.scene, BEFORE.content);
  if (prepared !== undefined) s.preparedAssetImport = prepared;
  return s;
}

let seq = 0;
function request(args: Record<string, unknown>, revision: number): Record<string, unknown> {
  seq += 1;
  return { op: 'importAssets', projectId: BEFORE.projectId, expectedRevision: revision, requestId: `req-${String(seq).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'test' }, args };
}

const prepared = (n: number, extra: Partial<PreparedAssetImport['items'][number]> = {}): PreparedAssetImport => ({
  folder: 'assets/props',
  items: Array.from({ length: n }, (_, i) => ({ ...FACTS, assetId: `prop-${i + 1}`, displayName: `prop ${i + 1}`, sourcePath: `assets/props/prop-${i + 1}.glb`, ...extra })),
});

describe('importAssets', () => {
  it('creates every prepared record in one revision and one undo, with the labels', () => {
    const s = state(prepared(3, { labels: ['crates'] }));
    const rev = s.scene.revision;
    const r = applyMutation(s, request({ folder: 'assets/props', labels: ['props', 'level-3', 'props'] }, rev));
    expect(r.ok, JSON.stringify(r.ok ? null : r.result)).toBe(true);
    if (!r.ok) return;
    expect(r.result.revision).toBe(rev + 1);
    expect(r.state.history.entries).toHaveLength(1);
    const added = (r.result.change as { added: { assetId: string; labels?: string[]; displayName: string }[] }).added;
    expect(added.map((a) => a.assetId)).toEqual(['prop-1', 'prop-2', 'prop-3']);
    for (const a of added) expect(a.labels).toEqual(['crates', 'level-3', 'props']);
    expect(r.state.content!.assets.filter((a) => a.assetId.startsWith('prop-'))).toHaveLength(3);

    const undo = applyMutation(r.state, { ...request({}, rev + 1), op: 'undo' });
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.state.content!.assets.some((a) => a.assetId.startsWith('prop-'))).toBe(false);
    expect((undo.result.change as { removed: unknown[] }).removed).toHaveLength(3);
    const redo = applyMutation(undo.state, { ...request({}, rev + 2), op: 'redo' });
    expect(redo.ok).toBe(true);
    if (!redo.ok) return;
    expect(redo.state.content!.assets.filter((a) => a.assetId.startsWith('prop-'))).toHaveLength(3);
  });

  it('refuses a folder the host did not prepare, whatever the request carries', () => {
    const s = state(prepared(1));
    const other = applyMutation(s, request({ folder: 'assets/other' }, s.scene.revision));
    expect(other.ok).toBe(false);
    const none = applyMutation(state(), request({ folder: 'assets/props' }, s.scene.revision));
    expect(none.ok).toBe(false);
    // Items in the request are not an input.
    const smuggled = applyMutation(state(), request({ folder: 'assets/props', assets: prepared(1).items }, s.scene.revision));
    expect(smuggled.ok).toBe(false);
    if (!smuggled.ok) expect(smuggled.result.error.code).toBe('field_unexpected');
  });

  it('refuses bad labels, taken ids and an empty folder', () => {
    const s = state(prepared(1));
    const bad = applyMutation(s, request({ folder: 'assets/props', labels: ['has space'] }, s.scene.revision));
    expect(!bad.ok && bad.result.error.code).toBe('field_value');
    const taken = applyMutation(state({ folder: 'assets/props', items: [{ ...FACTS, assetId: MODEL.assetId, sourcePath: 'assets/props/x.glb' }] }), request({ folder: 'assets/props' }, s.scene.revision));
    expect(!taken.ok && taken.result.error.code).toBe('asset_id_duplicate');
    const empty = applyMutation(state({ folder: 'assets/props', items: [] }), request({ folder: 'assets/props' }, s.scene.revision));
    expect(!empty.ok && empty.result.error.code).toBe('no_change');
  });
});
