/**
 * The unit-size check: exact spans and member counts from the parser, the
 * names units are listed under, and the ratchet (an entry may only shrink,
 * a new or grown unit fails, a fitting one must leave the list), run as the
 * build runs it over a workspace on disk.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLASS_MEMBERS_MAX,
  FILE_LINES_MAX,
  FUNCTION_LINES_MAX,
  RATCHET_FILE,
  checkSize,
  compareRatchet,
  measureUnits,
  oversized,
  writeRatchet,
} from './check-size.mjs';

const TOOL = fileURLToPath(new URL('./check-size.mjs', import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'tl-check-size-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const body = (n) => Array.from({ length: n }, (_, i) => `  const v${i} = ${i};`).join('\n');
/** A function declaration spanning exactly `lines` lines. */
const fn = (name, lines) => `function ${name}() {\n${body(lines - 2)}\n}\n`;
/** A class with exactly `members` members. */
const cls = (name, members) => `class ${name} {\n${Array.from({ length: members }, (_, i) => `  m${i}() { return ${i}; }`).join('\n')}\n}\n`;

function run(root, ...args) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: 'utf8' });
}

describe('measuring units', () => {
  it('spans a function from its first to its last line, leading comments not counted', () => {
    const { units } = measureUnits(`// why\n/** doc */\n${fn('f', 7)}`);
    expect(units).toEqual([{ unit: 'f', kind: 'function', size: 7, line: 3 }]);
  });

  it('names closures by where they live, and counts a nested one on its own and in its parent', () => {
    const text = [
      'export function createThing() {',
      '  const onFrame = () => {',
      '    return 1;',
      '  };',
      '  const api = { start() { return 2; } };',
      '  list.forEach((x) => x);',
      '  return api;',
      '}',
      'class View {',
      '  render() { return function () { return 3; }; }',
      '  get size() { return 1; }',
      '}',
    ].join('\n');
    const names = measureUnits(text).units.map((u) => [u.unit, u.size]);
    expect(names).toEqual([
      ['createThing', 8],
      ['createThing > onFrame', 3],
      ['createThing > start', 1],
      ['createThing > (list.forEach callback)', 1],
      ['View', 2],
      ['View.render', 1],
      ['View.render > (function)', 1],
      ['View.get size', 1],
    ]);
  });

  it('gives repeated names a source-order suffix', () => {
    const text = 'describe("a", () => {});\ndescribe("b", () => {});\n';
    expect(measureUnits(text).units.map((u) => u.unit)).toEqual(['(describe callback)', '(describe callback)#2']);
  });

  it('counts class members once per overload set, without stray semicolons', () => {
    const text = 'class A {\n  x = 1;\n  ;\n  f(a: string): void;\n  f(a: number): void;\n  f(a: unknown) {}\n  constructor() {}\n}\n';
    expect(measureUnits(text, 'a.ts').units[0]).toMatchObject({ unit: 'A', kind: 'class', size: 3 });
  });

  it('counts the lines of a file with or without a final newline', () => {
    expect(measureUnits('a;\nb;\n').lines).toBe(2);
    expect(measureUnits('a;\nb;').lines).toBe(2);
  });
});

describe('what is over a limit', () => {
  it('holds package sources and tools to the unit limits, tests only to the file limit, generated files to nothing', () => {
    const big = fn('big', FUNCTION_LINES_MAX + 1);
    const root = workspace({
      'packages/p/src/a.ts': big + fn('fits', FUNCTION_LINES_MAX) + cls('Wide', CLASS_MEMBERS_MAX + 1) + cls('Ok', CLASS_MEMBERS_MAX),
      'packages/p/src/a.test.ts': big,
      'tests/e2e/x.e2e.ts': big,
      'tools/t.mjs': big,
      'tools/long-steps.ts': 'x;\n'.repeat(FILE_LINES_MAX + 1),
      'packages/p/src/api.generated.ts': big + 'x;\n'.repeat(FILE_LINES_MAX),
      'packages/p/node_modules/m/index.js': big,
    });
    expect(oversized(root).map((e) => [e.file, e.kind, e.unit, e.size])).toEqual([
      ['tools/long-steps.ts', 'file', '(file)', FILE_LINES_MAX + 1],
      ['packages/p/src/a.ts', 'function', 'big', FUNCTION_LINES_MAX + 1],
      ['tools/t.mjs', 'function', 'big', FUNCTION_LINES_MAX + 1],
      ['packages/p/src/a.ts', 'class', 'Wide', CLASS_MEMBERS_MAX + 1],
    ]);
  });
});

describe('the ratchet', () => {
  const entry = (unit, size, kind = 'function') => ({ file: 'f.ts', unit, kind, size });

  it('passes listed units at their size and fails new, grown, shrunk and stale ones', () => {
    const found = [entry('same', 500), entry('grew', 510), entry('shrank', 450), entry('fresh', 401)];
    const listed = [entry('same', 500), entry('grew', 500), entry('shrank', 480), entry('gone', 420)];
    const { problems, updated } = compareRatchet(found, listed);
    expect(problems.map((p) => [p.entry.unit, p.problem, p.size])).toEqual([
      ['grew', 'grew', 510],
      ['shrank', 'shrank', 450],
      ['gone', 'stale', undefined],
      ['fresh', 'new', 401],
    ]);
    // An update records the shrink and drops the stale entry; it never raises one or adds one.
    expect(updated.map((e) => [e.unit, e.size])).toEqual([['same', 500], ['grew', 500], ['shrank', 450]]);
  });

  it('runs as the build runs it: green within the list, red on growth, --update only ever lowers', () => {
    const root = workspace({ 'packages/p/src/a.ts': fn('big', 450) + fn('other', 10) });
    expect(run(root).status).toBe(1);
    expect(run(root).stderr).toContain('packages/p/src/a.ts big (function): 450 lines, over the limit of 400; split it');
    // --update never blesses a new offender.
    expect(run(root, '--update').status).toBe(1);
    expect(JSON.parse(readFileSync(join(root, RATCHET_FILE), 'utf8')).entries).toEqual([]);

    writeRatchet(root, [{ file: 'packages/p/src/a.ts', kind: 'function', unit: 'big', size: 450 }]);
    const ok = run(root);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('1 unit(s) over a limit');

    writeFileSync(join(root, 'packages/p/src/a.ts'), fn('big', 451));
    expect(run(root).stderr).toContain('grew to 451 lines (the ratchet list allows 450)');
    expect(run(root, '--update').status).toBe(1);
    expect(checkSize(root).updated).toEqual([{ file: 'packages/p/src/a.ts', kind: 'function', unit: 'big', size: 450 }]);

    writeFileSync(join(root, 'packages/p/src/a.ts'), fn('big', 420));
    expect(run(root).status).toBe(1);
    expect(run(root, '--update').status).toBe(0);
    expect(run(root).status).toBe(0);
    expect(checkSize(root).updated[0].size).toBe(420);

    writeFileSync(join(root, 'packages/p/src/a.ts'), fn('big', 400));
    expect(run(root).stderr).toContain('fits the limit of 400 now or is gone; drop its entry');
    expect(run(root, '--update').status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, RATCHET_FILE), 'utf8')).entries).toEqual([]);
    expect(run(root).status).toBe(0);
  }, 60_000);

  it("the repository's own list matches its sources", () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const { problems } = checkSize(repo);
    expect(problems).toEqual([]);
  }, 60_000);
});
