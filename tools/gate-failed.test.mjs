import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { aloneVerdict, codeDigest, fileDigest, planFailedRerun } from './gate-failed.mjs';

describe('check --failed: which failed unit files run alone', () => {
  const recorded = { code: 'c1', files: { 'a.test.ts': 'ha', 'b.test.ts': 'hb', 'c.test.ts': 'hc' } };

  it('a file whose text and code are unchanged since the failing run runs alone; a changed one reruns; a gone one is gone', () => {
    const plan = planFailedRerun(recorded, { code: 'c1', files: { 'a.test.ts': 'ha', 'b.test.ts': 'hb2', 'c.test.ts': null } });
    expect(plan).toEqual({ alone: ['a.test.ts'], rerun: ['b.test.ts'], gone: ['c.test.ts'] });
  });

  it('a change to the code the files reach (a fix outside the test) reruns every file, unchanged text or not', () => {
    const plan = planFailedRerun(recorded, { code: 'c2', files: { 'a.test.ts': 'ha', 'b.test.ts': 'hb' } });
    expect(plan).toEqual({ alone: [], rerun: ['a.test.ts', 'b.test.ts'], gone: [] });
  });

  it('with no digests recorded (an older state) or a file not in them, the files rerun as before', () => {
    expect(planFailedRerun(null, { code: 'c1', files: { 'a.test.ts': 'ha' } }).rerun).toEqual(['a.test.ts']);
    expect(planFailedRerun(recorded, { code: 'c1', files: { 'new.test.ts': 'hn' } }).rerun).toEqual(['new.test.ts']);
  });

  it('a file run alone with nothing changed is red whether it passes or fails, and a pass says it is order-dependent', () => {
    const passed = aloneVerdict('a.test.ts', true);
    expect(passed.red).toBe(true);
    expect(passed.line).toBe('a.test.ts passed alone, failed in the shared pool, unchanged: order-dependent — isolate it (vitest.config.mts) or fix it');
    const failed = aloneVerdict('a.test.ts', false);
    expect(failed.red).toBe(true);
    expect(failed.line).toContain('failed alone too');
  });
});

describe('check --failed: the digests it compares', () => {
  it('the code digest follows code, tracked or untracked, and not the docs; a file digest is its text, null when gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-failed-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
      git('init', '-q');
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'docs'));
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(root, 'docs', 'notes.md'), 'one\n');
      writeFileSync(join(root, '.gitignore'), 'out/\n');
      git('add', '.');
      const first = codeDigest(root);
      expect(codeDigest(root)).toBe(first);
      // Prose and ignored output change nothing.
      writeFileSync(join(root, 'docs', 'notes.md'), 'two\n');
      writeFileSync(join(root, 'README.md'), 'hello\n');
      mkdirSync(join(root, 'out'));
      writeFileSync(join(root, 'out', 'log.txt'), 'x\n');
      expect(codeDigest(root)).toBe(first);
      // A code edit, staged or not, and a new untracked code file each do.
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
      const edited = codeDigest(root);
      expect(edited).not.toBe(first);
      writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 1;\n');
      expect(codeDigest(root)).not.toBe(edited);

      expect(fileDigest('src/a.ts', root)).toMatch(/^[0-9a-f]{64}$/);
      expect(fileDigest('src/a.ts', root)).not.toBe(fileDigest('src/b.ts', root));
      expect(fileDigest('src/none.ts', root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
