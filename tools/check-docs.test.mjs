/**
 * The docs check, run as the build runs it over a workspace on disk: a long
 * STATUS or progress row fails, the ratchet only shrinks (a grown, shrunk or
 * gone entry fails until it is recorded), a STATUS row naming a missing file
 * fails, and an open defect row in the closed list fails.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_CLOSED_FILE, AUDIT_OPEN_FILE, RATCHET_FILE, ROW_CHARS_MAX, STATUS_FILE, progressRows, writeRatchet } from './check-docs.mjs';

const TOOL = fileURLToPath(new URL('./check-docs.mjs', import.meta.url));
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'tl-check-docs-'));
  roots.push(root);
  mkdirSync(join(root, 'tools'), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: 'utf8' });
}

/** A table row of exactly `chars` characters whose first cell is `key`. */
const row = (key, chars) => {
  const head = `| ${key} | `;
  return `${head}${'x'.repeat(chars - head.length - 2)} |`;
};
const status = (...rows) => `# Status\n\n| Phase | Goal | Status |\n|---|---|---|\n${rows.join('\n')}\n\n## Notes\n`;
const plan = (...rows) => `# Plan\n\n## 2. Items\n\n| Item | What |\n|---|---|\n${row('1.1', 900)}\n\n## 3. Progress\n\n| Item | Status |\n|---|---|\n${rows.join('\n')}\n\n| Scene | ms |\n|---|---|\n${row('village', 900)}\n`;
const readRatchetFile = (root) => JSON.parse(readFileSync(join(root, RATCHET_FILE), 'utf8')).entries;

describe('row lengths', () => {
  it('passes rows at the limit, and reads only the progress table of a plan', () => {
    const root = workspace({ [STATUS_FILE]: status(row('1', ROW_CHARS_MAX)), 'docs/plan-phase-1.md': plan(row('1.1', ROW_CHARS_MAX)) });
    expect(progressRows(readFileSync(join(root, 'docs/plan-phase-1.md'), 'utf8')).map((r) => r.length)).toEqual([ROW_CHARS_MAX]);
    const r = run(root);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails a STATUS row and a progress row one character over the limit', () => {
    const root = workspace({ [STATUS_FILE]: status(row('7', ROW_CHARS_MAX + 1)), 'docs/plan-phase-1.md': plan(row('1.2', ROW_CHARS_MAX + 1)) });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${STATUS_FILE} row '7': ${ROW_CHARS_MAX + 1} characters`);
    expect(r.stderr).toContain(`docs/plan-phase-1.md row '1.2': ${ROW_CHARS_MAX + 1} characters`);
  });

  it('does not read plans under archive/', () => {
    const root = workspace({ [STATUS_FILE]: status(), 'archive/plans/plan-phase-1.md': plan(row('1.1', 2000)) });
    expect(run(root).status).toBe(0);
  });
});

describe('the ratchet', () => {
  const files = (n) => ({ [STATUS_FILE]: status(), 'docs/plan-phase-1.md': plan(row('1.1', n), row('1.1', 300)) });

  it('lets a listed row stay, and fails it when it grows', () => {
    const root = workspace(files(700));
    writeRatchet(root, [{ file: 'docs/plan-phase-1.md', row: '1.1', size: 700 }]);
    expect(run(root).status).toBe(0);
    writeFileSync(join(root, 'docs/plan-phase-1.md'), plan(row('1.1', 701)));
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("row '1.1': grew to 701 characters (the ratchet list allows 700)");
  });

  it('fails a shrunk entry until --update records it, and --update never raises or adds', () => {
    const root = workspace(files(600));
    writeRatchet(root, [{ file: 'docs/plan-phase-1.md', row: '1.1', size: 700 }]);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("shrank to 600 characters (listed at 700)");
    expect(run(root, '--update').status).toBe(0);
    expect(readRatchetFile(root)).toEqual([{ file: 'docs/plan-phase-1.md', row: '1.1', size: 600 }]);
    expect(run(root).status).toBe(0);
    writeFileSync(join(root, 'docs/plan-phase-1.md'), plan(row('1.1', 650), row('1.3', 500)));
    expect(run(root, '--update').status).toBe(1);
    expect(readRatchetFile(root)).toEqual([{ file: 'docs/plan-phase-1.md', row: '1.1', size: 600 }]);
  });

  it('fails an entry whose row fits now or is gone, until it is dropped', () => {
    const root = workspace(files(700));
    writeRatchet(root, [
      { file: 'docs/plan-phase-1.md', row: '1.1', size: 700 },
      { file: 'docs/plan-phase-1.md', row: '1.9', size: 900 },
    ]);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("row '1.9': fits the limit");
    run(root, '--update');
    expect(readRatchetFile(root)).toEqual([{ file: 'docs/plan-phase-1.md', row: '1.1', size: 700 }]);
    writeFileSync(join(root, 'docs/plan-phase-1.md'), plan(row('1.1', 300)));
    expect(run(root).stderr).toContain("row '1.1': fits the limit");
  });

  it('keys a repeated row by its order, so a second long row with the same key is new', () => {
    const root = workspace({ [STATUS_FILE]: status(), 'docs/plan-phase-1.md': plan(row('1.1', 700), row('1.1', 500)) });
    writeRatchet(root, [{ file: 'docs/plan-phase-1.md', row: '1.1', size: 700 }]);
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("row '1.1#2': 500 characters, over the limit");
  });
});

describe('links and defect lists', () => {
  it('fails a STATUS row naming a plan that does not exist', () => {
    const root = workspace({ [STATUS_FILE]: status('| 9 | Thing — `docs/plan-phase-9.md` | done |', '| 8 | Other — `docs/plan-phase-8.md` | done |'), 'docs/plan-phase-8.md': plan() });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("row '9' names docs/plan-phase-9.md, which does not exist");
    expect(r.stderr).not.toContain('plan-phase-8.md, which');
  });

  it('fails an open row in the closed list, an unknown status and a D-number in both lists', () => {
    const table = (...rows) => `| # | Sev | Status | Defect | Location |\n|---|---|---|---|---|\n${rows.join('\n')}\n`;
    const root = workspace({
      [STATUS_FILE]: status(),
      [AUDIT_OPEN_FILE]: table('| D1 | M | open | a | b |', '| D2 | L | watch | a | b |', '| D3 | L | fixed `abc1234` | a | b |', '| D7 | L | done | a | b |'),
      [AUDIT_CLOSED_FILE]: table("| D4 | L | won't fix (kept) | a | b |", '| D5 | L | superseded → D1 | a | b |', '| D6 | L | open | a | b |', '| D1 | M | fixed `abc1234` | a | b |'),
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${AUDIT_CLOSED_FILE}: D6 has status 'open'`);
    expect(r.stderr).toContain(`${AUDIT_OPEN_FILE}: D7 has status 'done'`);
    expect(r.stderr).toContain('D1 is listed twice');
    // A row closed in the open list waits there for the tidy at the phase end.
    expect(r.stderr).not.toMatch(/D[2345] has status/);
  });
});
