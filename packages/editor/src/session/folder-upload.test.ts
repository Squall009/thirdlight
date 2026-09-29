import { describe, expect, it } from 'vitest';

import { describeFolderImport, parseLabels, planFolderUpload } from './folder-upload';

const f = (relativePath: string) => ({ relativePath, file: new File(['x'], relativePath.split('/').pop()!) });

describe('folder upload planning', () => {
  it('keeps the picked folder under its own name, or the next free one; hidden entries stay home', () => {
    const plan = planFolderUpload([f('voice/a.ogg'), f('voice/act2/b.ogg'), f('voice/.DS_Store'), f('voice/.git/x')], 'assets/props', new Set());
    expect(plan?.folder).toBe('assets/props/voice');
    expect(plan?.files.map((x) => x.path)).toEqual(['assets/props/voice/a.ogg', 'assets/props/voice/act2/b.ogg']);
    expect(planFolderUpload([f('voice/a.ogg')], 'assets', new Set(['voice', 'voice-2']))?.folder).toBe('assets/voice-3');
    expect(planFolderUpload([f('voice/.hidden')], 'assets', new Set())).toBeNull();
  });

  it('reads labels typed with commas or spaces and reports what is not one', () => {
    expect(parseLabels('voice, act-1  voice level/3')).toEqual({ labels: ['voice', 'act-1', 'level/3'], invalid: [] });
    expect(parseLabels('ok, -bad, a+b').invalid).toEqual(['-bad', 'a+b']);
  });

  it('says what an import did in one line', () => {
    expect(describeFolderImport(3, { folder: 'a', prepared: 3, skipped: [{ path: 'a/x.ogg', assetId: 'x' }], unsupported: [{ path: 'a/notes.txt', reason: 'no importer takes .txt files' }], rejected: [] })).toBe(
      'imported 3 assets · 1 already imported · not imported: notes.txt (no importer takes .txt files)',
    );
  });
});
