/**
 * `moveResources`, `renameFolder`, `createFolder` in the command layer: the
 * args are checked for their shape, the op reads only the moves the host
 * prepared, an asset's record names its file's new path (every version that
 * named the old one), one revision and one undo; undo and redo swap the
 * paths back and forth; nothing prepared is refused.
 */
import { describe, expect, it } from 'vitest';
import { validateContentV4, type ContentCatalogV4, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument, PreparedMoves } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');

function state(prepared?: PreparedMoves): CommandState<SceneV4> {
  const model = BEFORE.content.assets[0]!;
  const filed = { ...model, assetId: 'crate', displayName: 'Crate', versions: model.versions.map((v) => ({ ...v, sourcePath: 'assets/crate.glb' })) };
  const v = validateContentV4({ ...BEFORE.content, assets: [...BEFORE.content.assets, filed] });
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  const s = createCommandState(BEFORE.scene, v.normalized as ContentCatalogV4 as unknown as ContentDocument);
  if (prepared !== undefined) s.preparedMoves = prepared;
  return s;
}

let seq = 0;
function request(op: string, args: Record<string, unknown>, revision: number): Record<string, unknown> {
  seq += 1;
  return { op, projectId: BEFORE.projectId, expectedRevision: revision, requestId: `req-${String(seq).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'test' }, args };
}
const pathOf = (s: CommandState, id: string): string | undefined => (s.content!.assets as unknown as { assetId: string; currentVersion: number; versions: { version: number; sourcePath?: string }[] }[]).find((a) => a.assetId === id)?.versions.at(-1)?.sourcePath;

describe('moving files and folders', () => {
  it('checks the args for their shape', () => {
    const s = state();
    const bad: [string, Record<string, unknown>][] = [
      ['moveResources', { to: 'props' }],
      ['moveResources', { items: [], folders: [], to: 'props' }],
      ['moveResources', { items: [{ kind: 'model' }], to: 'props' }],
      ['moveResources', { items: [{ kind: 'model', id: 'crate' }], to: '../out' }],
      ['moveResources', { folders: ['a//b'], to: 'x' }],
      ['moveResources', { items: [{ kind: 'model', id: 'crate' }], to: 'props', extra: 1 }],
      ['renameFolder', { folder: 'a', name: 'b/c' }],
      ['renameFolder', { folder: 'a', name: '.hidden' }],
      ['createFolder', { folder: '' }],
    ];
    for (const [op, args] of bad) {
      const r = applyMutation(s, request(op, args, s.scene.revision));
      expect(r.ok, `${op} ${JSON.stringify(args)}`).toBe(false);
    }
  });

  it('refuses a move the host did not prepare', () => {
    const s = state();
    const r = applyMutation(s, request('moveResources', { items: [{ kind: 'model', id: 'crate' }], to: 'props' }, s.scene.revision));
    expect(r.ok).toBe(false);
  });

  it('points an asset at its file’s new path in one revision; undo and redo swap it', () => {
    const prepared: PreparedMoves = { moves: [{ kind: 'asset', id: 'crate', from: 'assets/crate.glb', to: 'props/crate.glb' }, { kind: 'material', id: 'stone', from: 'assets/materials/stone.material.json', to: 'props/stone.material.json' }], folders: [{ from: null, to: 'props' }] };
    const s = state(prepared);
    const rev = s.scene.revision;
    const r = applyMutation(s, request('moveResources', { items: [{ kind: 'model', id: 'crate' }], to: 'props' }, rev));
    expect(r.ok, JSON.stringify(r.ok ? null : r.result)).toBe(true);
    if (!r.ok) return;
    expect(r.result.revision).toBe(rev + 1);
    expect(pathOf(r.state, 'crate')).toBe('props/crate.glb');
    expect(r.result.change).toEqual({ type: 'moveResources', ...prepared });
    const undo = applyMutation(r.state, request('undo', {}, rev + 1));
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(pathOf(undo.state, 'crate')).toBe('assets/crate.glb');
    // The undo's change is the moves the other way, the last first.
    expect(undo.result.change).toEqual({ type: 'moveResources', moves: [{ kind: 'material', id: 'stone', from: 'props/stone.material.json', to: 'assets/materials/stone.material.json' }, { kind: 'asset', id: 'crate', from: 'props/crate.glb', to: 'assets/crate.glb' }], folders: [{ from: 'props', to: null }] });
    const redo = applyMutation(undo.state, request('redo', {}, rev + 2));
    expect(redo.ok).toBe(true);
    if (!redo.ok) return;
    expect(pathOf(redo.state, 'crate')).toBe('props/crate.glb');
  });

  it('a folder made or a resource moved changes no record, and still takes a revision and an undo', () => {
    const s = state({ moves: [], folders: [{ from: null, to: 'empty' }] });
    const r = applyMutation(s, request('createFolder', { folder: 'empty' }, s.scene.revision));
    expect(r.ok, JSON.stringify(r.ok ? null : r.result)).toBe(true);
    if (!r.ok) return;
    expect(r.state.content).toBe(s.content);
    const undo = applyMutation(r.state, request('undo', {}, s.scene.revision + 1));
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.result.change).toEqual({ type: 'moveResources', moves: [], folders: [{ from: 'empty', to: null }] });
  });
});
