/**
 * Test-only: a disposable backend (temp data root + stub static dirs).
 * Imported by test files only (the `./testing` subpath); production code
 * never reaches it. `teardown` closes the backend and removes the root.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createBackend, type Backend } from './backend';

function hex(n: number): string {
  let out = '';
  const b = randomBytes(n);
  for (let i = 0; i < b.length; i += 1) out += (b[i] ?? 0).toString(16).padStart(2, '0');
  return out;
}

/**
 * Where tests make their scratch folders: TMPDIR when it is on disk, else ~/.cache/tmp. Never /tmp: on
 * this host it is RAM (tmpfs), and test projects and exports there have OOM-killed the machine. (No
 * `node:os`: it is not among the backend's allowed edges.)
 */
export function testTempBase(): string {
  const env = process.env.TMPDIR;
  if (env !== undefined && env !== '' && env !== '/tmp' && !env.startsWith('/tmp/')) return env;
  const home = process.env.HOME;
  if (home === undefined || home === '') throw new Error('testTempBase: TMPDIR is unset or /tmp and HOME is unset; set TMPDIR to a folder on disk');
  const base = join(home, '.cache', 'tmp');
  mkdirSync(base, { recursive: true });
  return base;
}

export async function createTestBackend(
  config: Record<string, unknown> & { timeouts?: Record<string, number> },
): Promise<{ backend: Backend; root: string; teardown: () => Promise<void> }> {
  const root = join(testTempBase(), `tl-backend-${process.pid}-${hex(6)}`);
  const editorDir = join(root, 'editor');
  const previewDir = join(root, 'preview');
  // A test may open an existing data root (a second backend over the first one's projects).
  const dataRoot = typeof config['dataRoot'] === 'string' ? config['dataRoot'] : join(root, 'data');
  mkdirSync(editorDir, { recursive: true });
  mkdirSync(previewDir, { recursive: true });
  writeFileSync(join(editorDir, 'index.html'), '<!doctype html><html><body>editor</body></html>\n');
  writeFileSync(join(previewDir, 'preview.js'), '// preview bundle stub (tests)\n');
  writeFileSync(join(previewDir, 'preview-m3.js'), '// M3 preview bundle stub (tests)\n');
  const merged: Record<string, unknown> = {
    ...config,
    dataRoot,
    editorStaticDir: editorDir,
    previewStaticDir: previewDir,
    authoringBind: config.authoringBind ?? '127.0.0.1:0',
    previewBind: config.previewBind ?? '127.0.0.1:0',
  };
  const created = createBackend(merged);
  if (!created.ok) throw new Error(`createBackend failed: ${created.error.message}`);
  const backend = created.backend;
  await backend.ready;
  return {
    backend,
    root,
    teardown: async () => {
      await backend.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}