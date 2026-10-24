/**
 * The committed fixture corpora are what their tools write: each tool's
 * `--check` rebuilds its files in memory and compares them byte for byte. Run
 * here so a fixture edited by hand (or a tool left behind a contract change)
 * fails a test instead of drifting until someone happens to run the tool.
 * The media corpus is checked by its own integration test.
 */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..');

const TOOLS = ['fixtures/commands/tools/generate-fixtures.mjs', 'fixtures/m4/delivery/tools/generate-fixtures.mjs'];

describe('fixture corpora match their generators', () => {
  for (const tool of TOOLS) {
    it(`${tool} --check`, () => {
      const r = spawnSync(process.execPath, [join(REPO, tool), '--check'], { encoding: 'utf8', timeout: 60_000 });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    });
  }
});
