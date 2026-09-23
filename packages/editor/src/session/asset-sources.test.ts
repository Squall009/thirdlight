import { describe, expect, it } from 'vitest';

import { sourceIssuesFrom } from './asset-sources';
import {
  beginProjectFileImport,
  canPublish,
  initialImportState,
  inspectionSucceeded,
  publishArgsFromProposal,
  type ImportProposal,
} from './asset-browser';

const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);
const names = new Map([['crate', 'Crate']]);

describe('sourceIssuesFrom (Problems rows for files referenced in place)', () => {
  it('reports nothing when every referenced file matches, and ignores stored blobs', () => {
    expect(
      sourceIssuesFrom(
        [
          { assetId: 'crate', version: 1, sourceDigest: D1, referenced: true, sourcePath: 'assets/crate.glb', status: 'ok' },
          { assetId: 'blob', version: 1, sourceDigest: D2, referenced: true, status: 'missing' },
        ],
        names,
      ),
    ).toEqual([]);
  });

  it('a changed current file offers re-import; a missing one does not', () => {
    const changed = sourceIssuesFrom([{ assetId: 'crate', version: 2, sourceDigest: D1, referenced: true, sourcePath: 'assets/crate.glb', status: 'changed' }], names);
    expect(changed).toMatchObject([{ assetId: 'crate', kind: 'changed', canReimport: true, sourcePath: 'assets/crate.glb', versions: [2] }]);
    expect(changed[0]!.message).toContain('Crate: assets/crate.glb has changed since v2 was imported');
    const missing = sourceIssuesFrom([{ assetId: 'crate', version: 1, sourceDigest: D1, referenced: true, sourcePath: 'assets/crate.glb', status: 'missing' }], names);
    expect(missing).toMatchObject([{ kind: 'missing', canReimport: false }]);
    expect(missing[0]!.message).toContain('is missing from the game folder');
  });

  it('older versions whose file changed are said to be unreadable', () => {
    const rows = sourceIssuesFrom(
      [
        { assetId: 'crate', version: 1, sourceDigest: D1, referenced: false, sourcePath: 'assets/crate.glb', status: 'changed' },
        { assetId: 'crate', version: 2, sourceDigest: D2, referenced: true, sourcePath: 'assets/crate.glb', status: 'ok' },
      ],
      names,
    );
    expect(rows).toMatchObject([{ kind: 'old-versions', versions: [1], canReimport: false }]);
    expect(rows[0]!.message).toBe('Crate: older version v1 can no longer be read: assets/crate.glb no longer holds the bytes it was imported from.');
  });
});

describe('import from the project folder (state machine)', () => {
  it('goes straight to inspecting, accepts only the same file, and publishes with sourcePath', () => {
    const target = { mode: 'create' as const, assetId: 'crate', displayName: 'Crate' };
    const s = beginProjectFileImport(initialImportState, target, 'assets/crate.glb');
    expect(s.phase).toBe('inspecting');
    const proposal = (sourcePath: string): ImportProposal => ({
      stageId: null,
      sourcePath,
      digest: D1,
      byteLength: 10,
      status: 'ok',
      proposal: { status: 'ok', sourceDigest: D1, sourceByteLength: 10, importRecipe: {}, metrics: {} },
    });
    expect(inspectionSucceeded(s, proposal('assets/other.glb')).phase).toBe('stale');
    const ok = inspectionSucceeded(s, proposal('assets/crate.glb'));
    expect(canPublish(ok)).toBe(true);
    const args = publishArgsFromProposal(ok.proposal!, target, '2026-09-23T10:00:00Z', 'model');
    expect(args.ok && args.args.sourcePath).toBe('assets/crate.glb');
    expect(args.ok && args.args.sourceDigest).toBe(D1);
  });
});
