/**
 * `setLabels` and `setAddress`: labels on any number of assets and
 * resources in one revision and one undo, an address unique across the
 * project, a resource's names kept beside its record (`content.loadable`).
 */
import { describe, expect, it } from 'vitest';
import { validateContentV4, type ContentCatalogV4, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
const [A, B] = BEFORE.content.assets.map((a) => a.assetId) as [string, string];
const MATERIAL = { materialId: 'mat-a', name: 'A', shader: 'standard', params: {}, textures: {} };

function state(extraAssets = 0): CommandState<SceneV4> {
  const model = BEFORE.content.assets[0]!;
  const copies = Array.from({ length: extraAssets }, (_, i) => ({ ...model, assetId: `copy-${String(i).padStart(4, '0')}`, displayName: `copy ${i}` }));
  const v = validateContentV4({ ...BEFORE.content, assets: [...BEFORE.content.assets, ...copies], materials: [MATERIAL] });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return createCommandState(BEFORE.scene, v.normalized as ContentCatalogV4 as unknown as ContentDocument);
}

let seq = 0;
function request(op: string, args: Record<string, unknown>, revision: number): Record<string, unknown> {
  seq += 1;
  return { op, projectId: BEFORE.projectId, expectedRevision: revision, requestId: `req-${String(seq).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'test' }, args };
}

type Rec = { assetId: string; labels?: string[]; address?: string };
const assetOf = (s: CommandState, id: string): Rec => (s.content!.assets as unknown as Rec[]).find((a) => a.assetId === id)!;
const loadableOf = (s: CommandState): unknown => (s.content as unknown as { loadable?: unknown }).loadable;

describe('setLabels', () => {
  it('labels assets and a resource in one revision and one undo; undo and redo restore each', () => {
    const s = state();
    const rev = s.scene.revision;
    const r = applyMutation(s, request('setLabels', { items: [{ kind: 'asset', id: A }, { kind: 'model', id: B }, { kind: 'material', id: 'mat-a' }], add: ['voice', 'level-3', 'voice'] }, rev));
    expect(r.ok, JSON.stringify(r.ok ? null : r.result)).toBe(true);
    if (!r.ok) return;
    expect(r.result.revision).toBe(rev + 1);
    expect(r.state.history.entries).toHaveLength(1);
    expect(assetOf(r.state, A).labels).toEqual(['level-3', 'voice']);
    expect(assetOf(r.state, B).labels).toEqual(['level-3', 'voice']);
    expect(loadableOf(r.state)).toEqual([{ kind: 'material', id: 'mat-a', labels: ['level-3', 'voice'] }]);
    // The material's own record is untouched (its names are beside it).
    expect((r.state.content as unknown as { materials: unknown[] }).materials[0]).toBe((s.content as unknown as { materials: unknown[] }).materials[0]);
    const change = r.result.change as { type: string; items: { kind: string; id: string; previous: unknown; next: unknown }[] };
    expect(change.type).toBe('setLabels');
    expect(change.items.map((i) => `${i.kind}:${i.id}`)).toEqual([`asset:${A}`, `asset:${B}`, 'material:mat-a']);

    const undo = applyMutation(r.state, { ...request('undo', {}, rev + 1), op: 'undo' });
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(assetOf(undo.state, A).labels).toBeUndefined();
    expect(loadableOf(undo.state)).toBeUndefined();
    const redo = applyMutation(undo.state, { ...request('redo', {}, rev + 2), op: 'redo' });
    expect(redo.ok).toBe(true);
    if (!redo.ok) return;
    expect(assetOf(redo.state, B).labels).toEqual(['level-3', 'voice']);
    expect(loadableOf(redo.state)).toEqual([{ kind: 'material', id: 'mat-a', labels: ['level-3', 'voice'] }]);
  });

  it('labels 1,000 assets in one command', () => {
    const s = state(1000);
    const items = (s.content!.assets as unknown as Rec[]).filter((a) => a.assetId.startsWith('copy-')).map((a) => ({ kind: 'asset', id: a.assetId }));
    expect(items).toHaveLength(1000);
    const r = applyMutation(s, request('setLabels', { items, add: ['bulk'] }, s.scene.revision));
    expect(r.ok, JSON.stringify(r.ok ? null : r.result)).toBe(true);
    if (!r.ok) return;
    expect(r.state.history.entries).toHaveLength(1);
    expect((r.state.content!.assets as unknown as Rec[]).filter((a) => a.labels?.includes('bulk'))).toHaveLength(1000);
    const undo = applyMutation(r.state, { ...request('undo', {}, r.result.revision), op: 'undo' });
    expect(undo.ok && (undo.state.content!.assets as unknown as Rec[]).some((a) => a.labels !== undefined)).toBe(false);
  });

  it('removes labels; an entry left with no names goes; only changed items are recorded', () => {
    const s = state();
    const a = applyMutation(s, request('setLabels', { items: [{ kind: 'asset', id: A }, { kind: 'material', id: 'mat-a' }], add: ['x', 'y'] }, s.scene.revision));
    if (!a.ok) throw new Error(JSON.stringify(a.result));
    const b = applyMutation(a.state, request('setLabels', { items: [{ kind: 'asset', id: A }, { kind: 'asset', id: B }, { kind: 'material', id: 'mat-a' }], remove: ['x', 'y'] }, a.result.revision));
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(assetOf(b.state, A).labels).toBeUndefined();
    expect(loadableOf(b.state)).toBeUndefined();
    expect((b.result.change as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([A, 'mat-a']);
    // Nothing to change: refused as no change.
    const c = applyMutation(b.state, request('setLabels', { items: [{ kind: 'asset', id: B }], remove: ['x'] }, b.result.revision));
    expect(!c.ok && c.result.error.code).toBe('no_change');
  });

  it('refuses bad labels, unknown kinds and items the project does not have', () => {
    const s = state();
    const rev = s.scene.revision;
    const bad = applyMutation(s, request('setLabels', { items: [{ kind: 'asset', id: A }], add: ['has space'] }, rev));
    expect(!bad.ok && bad.result.error.code).toBe('field_value');
    const kind = applyMutation(s, request('setLabels', { items: [{ kind: 'scene', id: 'scene-main' }], add: ['x'] }, rev));
    expect(!kind.ok && kind.result.error.code).toBe('field_value');
    const missing = applyMutation(s, request('setLabels', { items: [{ kind: 'asset', id: 'nope' }], add: ['x'] }, rev));
    expect(!missing.ok && missing.result.error.code).toBe('asset_not_found');
    const noMaterial = applyMutation(s, request('setLabels', { items: [{ kind: 'material', id: 'nope' }], add: ['x'] }, rev));
    expect(!noMaterial.ok && noMaterial.result.error.code).toBe('field_value');
    const empty = applyMutation(s, request('setLabels', { items: [], add: ['x'] }, rev));
    expect(!empty.ok && empty.result.error.code).toBe('field_value');
    const nothing = applyMutation(s, request('setLabels', { items: [{ kind: 'asset', id: A }] }, rev));
    expect(!nothing.ok && nothing.result.error.code).toBe('field_value');
  });
});

describe('setAddress', () => {
  it('sets and clears an address, one undo each; an address is unique across assets and resources', () => {
    const s = state();
    const set = applyMutation(s, request('setAddress', { kind: 'asset', id: A, address: 'voice/intro/line-01' }, s.scene.revision));
    expect(set.ok, JSON.stringify(set.ok ? null : set.result)).toBe(true);
    if (!set.ok) return;
    expect(assetOf(set.state, A).address).toBe('voice/intro/line-01');
    const taken = applyMutation(set.state, request('setAddress', { kind: 'material', id: 'mat-a', address: 'voice/intro/line-01' }, set.result.revision));
    expect(taken.ok).toBe(false);
    if (!taken.ok) {
      expect(taken.result.error.code).toBe('field_value');
      expect(taken.result.error.message).toContain('unique project-wide');
      expect(taken.result.error.message).toContain(`asset ${A}`);
    }
    const mat = applyMutation(set.state, request('setAddress', { kind: 'material', id: 'mat-a', address: 'materials/a' }, set.result.revision));
    expect(mat.ok).toBe(true);
    if (!mat.ok) return;
    expect(loadableOf(mat.state)).toEqual([{ kind: 'material', id: 'mat-a', address: 'materials/a' }]);
    const clear = applyMutation(mat.state, request('setAddress', { kind: 'asset', id: A, address: null }, mat.result.revision));
    expect(clear.ok).toBe(true);
    if (!clear.ok) return;
    expect(assetOf(clear.state, A).address).toBeUndefined();
    // The freed address can be given to another.
    const reuse = applyMutation(clear.state, request('setAddress', { kind: 'asset', id: B, address: 'voice/intro/line-01' }, clear.result.revision));
    expect(reuse.ok).toBe(true);
    const undo = applyMutation(clear.state, { ...request('undo', {}, clear.result.revision), op: 'undo' });
    expect(undo.ok && assetOf(undo.state, A).address).toBe('voice/intro/line-01');
  });

  it('refuses a malformed address and keeps labels when the address changes', () => {
    const s = state();
    const bad = applyMutation(s, request('setAddress', { kind: 'asset', id: A, address: 'has space' }, s.scene.revision));
    expect(!bad.ok && bad.result.error.code).toBe('field_value');
    const missing = applyMutation(s, request('setAddress', { kind: 'asset', id: A }, s.scene.revision));
    expect(!missing.ok && missing.result.error.code).toBe('field_missing');
    const l = applyMutation(s, request('setLabels', { items: [{ kind: 'material', id: 'mat-a' }], add: ['m'] }, s.scene.revision));
    if (!l.ok) throw new Error(JSON.stringify(l.result));
    const a = applyMutation(l.state, request('setAddress', { kind: 'material', id: 'mat-a', address: 'm/a' }, l.result.revision));
    expect(a.ok && loadableOf(a.state)).toEqual([{ kind: 'material', id: 'mat-a', address: 'm/a', labels: ['m'] }]);
  });
});
