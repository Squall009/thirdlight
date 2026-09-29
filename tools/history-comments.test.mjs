/**
 * The history-comment check: what it flags, what it leaves alone, and that
 * it reads comments and test titles only (never strings, templates or regexes).
 */

import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHistory, commentRanges, historyHits, historyMarkers } from './history-comments.mjs';
import { emitWithoutComments } from './emit-compare.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('history markers', () => {
  it.each([
    ['Phase 25.7c: the chunk size', 'phase'],
    ['kept since phase 24', 'phase'],
    ['the set chunk (25.7c)', 'item id'],
    ['added in 24.8 for the menus', 'item id'],
    ['since 24.8 the list is sorted', 'item id'],
    ['the reader (packet 57)', 'packet'],
    ['M4 (the delivery):', 'milestone'],
    ['the M2 era', 'milestone'],
    ['fixes D48', 'audit id'],
    ['review of 2026-09-18', 'date'],
    ['runtime.md §12.1', 'spec section'],
  ])('flags %j as a %s', (text, name) => {
    expect(historyMarkers(text).map((m) => m.name)).toContain(name);
  });

  it.each([
    'the broad phase of the physics step',
    'a 3D project uses the 3D backend; 2D stays on the plane',
    'the pinned `M3_ENGINE_PINS` table',
    'fade over 1.5 s, or 0.25 m per step',
    'a 16.7 ms frame at 60 Hz',
    'three 0.186.1 and Rapier 0.19.3',
    'the Draco decoder (D-pad input is separate)',
  ])('leaves %j alone', (text) => {
    expect(historyMarkers(text)).toEqual([]);
  });
});

describe('where it looks', () => {
  it('reads line, block and JSX comments, not strings, templates or regexes', () => {
    const src = [
      "const a = 'Phase 25.7c in a string';",
      'const b = `packet 57 in a template ${a}`;',
      'const c = /§1/;',
      '// line: phase 9 here',
      '/* block: D48 here */',
      'const d = <div>{/* jsx: 2026-09-18 */}text // not a comment</div>;',
    ].join('\n');
    const { comments } = commentRanges(src, 'x.tsx');
    expect(comments.map((c) => c.text)).toEqual(['// line: phase 9 here', '/* block: D48 here */', '/* jsx: 2026-09-18 */']);
    expect(historyHits(src, 'x.tsx').map((h) => [h.line, h.name])).toEqual([
      [4, 'phase'],
      [5, 'audit id'],
      [6, 'date'],
    ]);
  });

  it('reads test titles, including chained forms', () => {
    const src = "describe('the model (phase 15.3)', () => { it.each([1])('case M3: %s', () => {}); test('fine', () => {}); });";
    expect(historyHits(src, 'x.test.ts').map((h) => [h.kind, h.name])).toEqual([
      ['test title', 'phase'],
      ['test title', 'milestone'],
    ]);
  });

  it('fails a workspace with a marker in a package source and passes it once removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'tl-history-'));
    roots.push(root);
    mkdirSync(join(root, 'packages/demo/src'), { recursive: true });
    mkdirSync(join(root, 'packages/demo/node_modules/dep'), { recursive: true });
    writeFileSync(join(root, 'packages/demo/node_modules/dep/index.js'), '// phase 1 in a dependency is not ours\n');
    const file = join(root, 'packages/demo/src/a.ts');
    writeFileSync(file, '// the reader, since 24.8\nexport const x = 1;\n');
    const failing = checkHistory(root);
    expect(failing.hits.map((h) => [h.file, h.line])).toEqual([['packages/demo/src/a.ts', 1]]);
    writeFileSync(file, '// the reader keeps one copy per path\nexport const x = 1;\n');
    expect(checkHistory(root)).toEqual({ files: 1, hits: [] });
  });
});

describe('the comment-only proof', () => {
  it('emits the same JavaScript when only comments change, and different JavaScript otherwise', () => {
    const before = '// why: phase 9\nexport const x = /* D48 */ 1;\n';
    expect(emitWithoutComments('// why: the reader keeps one copy\nexport const x = 1;\n', 'a.ts')).toBe(emitWithoutComments(before, 'a.ts'));
    expect(emitWithoutComments("export const x = 'phase 9';\n", 'a.ts')).not.toBe(emitWithoutComments("export const x = 'phase';\n", 'a.ts'));
    expect(emitWithoutComments('// a\nexport const y = 2;\n', 'a.mjs')).toContain('export const y = 2;');
  });
});
