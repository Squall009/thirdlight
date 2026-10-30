/**
 * The three ratchet lists (unit sizes, long doc rows, helper copies) hold
 * against the list HEAD has: an entry added or raised by hand fails the
 * check as the build runs it, and `--update` drops or lowers it again, in a
 * real git checkout on disk. Outside a checkout nothing is compared.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { committedEntries, handEdits } from './ratchet-base.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'tl-ratchet-base-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const git = (root, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
};
const commitAll = (root) => {
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
};
const list = (entries) => `{\n  "entries": [\n${entries.map((e) => `    ${JSON.stringify(e)}`).join(',\n')}\n  ]\n}\n`;
const tool = (name) => fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));
const run = (root, name, ...args) => spawnSync(process.execPath, [tool(name), ...args], { cwd: root, encoding: 'utf8' });
const entriesOf = (root, file) => JSON.parse(readFileSync(join(root, file), 'utf8')).entries;

const fn = (name, lines) => `function ${name}() {\n${Array.from({ length: lines - 2 }, (_, i) => `  const v${i} = ${i};`).join('\n')}\n}\n`;
const row = (key, chars) => `| ${key} | ${'x'.repeat(chars - key.length - 7)} |`;
const plan = (...rows) => `# Plan\n\n## 3. Progress\n\n| Item | Status |\n|---|---|\n${rows.join('\n')}\n`;

describe('hand edits against the committed list', () => {
  it('compares by key: added entries, and raised ones when entries carry a size', () => {
    const key = (e) => e.k;
    expect(handEdits([{ k: 'a', size: 5 }, { k: 'b', size: 9 }, { k: 'c', size: 3 }], [{ k: 'a', size: 5 }, { k: 'b', size: 7 }, { k: 'c', size: 4 }], key)).toEqual([{ entry: { k: 'b', size: 9 }, problem: 'raised', size: 7 }]);
    expect(handEdits([{ k: 'a' }, { k: 'n' }], [{ k: 'a' }], key)).toEqual([{ entry: { k: 'n' }, problem: 'added' }]);
    expect(handEdits([{ k: 'n' }], null, key)).toEqual([]);
  });

  it('reads nothing outside a git checkout of the root, or before the list is committed', () => {
    const root = workspace({ 'tools/size-ratchet.json': list([]) });
    expect(committedEntries(root, 'tools/size-ratchet.json')).toBeNull();
    git(root, 'init', '-q');
    expect(committedEntries(root, 'tools/size-ratchet.json')).toBeNull();
  });

  it('unit sizes: a unit listed by hand and an entry raised by hand fail; --update drops and lowers them', () => {
    const root = workspace({ 'packages/p/src/a.ts': fn('big', 450), 'tools/size-ratchet.json': list([{ file: 'packages/p/src/a.ts', kind: 'function', unit: 'big', size: 450 }]) });
    commitAll(root);
    expect(run(root, 'check-size').status).toBe(0);
    writeFileSync(join(root, 'packages/p/src/b.ts'), fn('other', 420));
    writeFileSync(join(root, 'tools/size-ratchet.json'), list([{ file: 'packages/p/src/a.ts', kind: 'function', unit: 'big', size: 460 }, { file: 'packages/p/src/b.ts', kind: 'function', unit: 'other', size: 420 }]));
    const r = run(root, 'check-size');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('packages/p/src/b.ts other (function): not in the committed tools/size-ratchet.json');
    expect(r.stderr).toContain('packages/p/src/a.ts big (function): listed above the committed tools/size-ratchet.json (450)');
    // The update keeps only what the committed list allows; the new unit still has to be split.
    expect(run(root, 'check-size', '--update').status).toBe(1);
    expect(entriesOf(root, 'tools/size-ratchet.json')).toEqual([{ file: 'packages/p/src/a.ts', kind: 'function', unit: 'big', size: 450 }]);
  });

  it('doc rows: a row listed by hand fails', () => {
    const root = workspace({ 'docs/STATUS.md': '# Status\n', 'docs/plan-phase-1.md': plan(row('1.1', 300)), 'tools/docs-ratchet.json': list([]) });
    commitAll(root);
    writeFileSync(join(root, 'docs/plan-phase-1.md'), plan(row('1.1', 700)));
    writeFileSync(join(root, 'tools/docs-ratchet.json'), list([{ file: 'docs/plan-phase-1.md', row: '1.1', size: 700 }]));
    const r = run(root, 'check-docs');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docs/plan-phase-1.md row '1.1': not in the committed tools/docs-ratchet.json");
  });

  it('helper copies: a copy listed by hand fails', () => {
    const root = workspace({ 'packages/a/src/x.ts': 'export const one = 1;\n', 'tools/redefinition-ratchet.json': list([]) });
    commitAll(root);
    writeFileSync(join(root, 'packages/a/src/x.ts'), 'export function crc32(b: Uint8Array): number { return b.length; }\n');
    writeFileSync(join(root, 'tools/redefinition-ratchet.json'), list([{ file: 'packages/a/src/x.ts', name: 'crc32' }]));
    const r = run(root, 'check-redefinitions');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("packages/a/src/x.ts: 'crc32': not in the committed tools/redefinition-ratchet.json");
  });
});
