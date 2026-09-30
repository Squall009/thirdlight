/**
 * The history-comment check: what it flags, what it leaves alone, and that
 * it reads comments and test titles, and the strings package sources ship (never regexes).
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
    ['the pre-22.1 computation', 'item id'],
    ["everything (26.3's layout) opens", 'item id'],
    ['the 23.0 port dropped it', 'item id'],
    ['handle kinds (15.2 draws and drags them)', 'item id'],
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
    'default gravity -19.62 vs changed -30',
    'Safari older than 18.4 (macOS 15.4, iOS 18.4)',
    'the camera goes back to 24 m along its offset (z ≈ 23.6)',
    'the 29.9/30.0/44.9/45.0/45.1 degree table',
    'the 23.5 m fall (20.5 ms at most)',
    'M3 6.5A1.5 1.5 0 0 1 19.5 19h-15',
  ])('leaves %j alone', (text) => {
    expect(historyMarkers(text)).toEqual([]);
  });
});

describe('where it looks', () => {
  it('reads line, block and JSX comments; outside package sources not strings, templates or regexes', () => {
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

  it('reads the strings a package source ships (literals, template parts, JSX text), not a test file\'s', () => {
    const src = [
      "export const hint = 'see workspace.md §9';",
      'export const t = `a ${hint} (phase 25.17) b`;',
      'export const e = <p>removed in phase 24</p>;',
      "export const fine = 'Safari older than 18.4, 1.5 s, D-pad';",
    ].join('\n');
    expect(historyHits(src, 'packages/demo/src/a.tsx').map((h) => [h.line, h.kind, h.name])).toEqual([
      [1, 'string', 'spec section'],
      [2, 'string', 'phase'],
      [3, 'string', 'phase'],
    ]);
    expect(historyHits(src, 'packages/demo/src/a.test.tsx')).toEqual([]);
    expect(historyHits(src, 'packages/demo/tests/a.tsx')).toEqual([]);
    expect(historyHits(src, 'tools/a.tsx')).toEqual([]);
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
