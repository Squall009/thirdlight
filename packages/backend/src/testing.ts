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

/** Temp base dir without `node:os` (not in backend's allowed edges): TMPDIR or /tmp. */
const tempBase = (): string => process.env.TMPDIR ?? '/tmp';

export async function createTestBackend(
  config: Record<string, unknown> & { timeouts?: Record<string, number> },
): Promise<{ backend: Backend; root: string; teardown: () => Promise<void> }> {
  const root = join(tempBase(), `tl-backend-${process.pid}-${hex(6)}`);
  const editorDir = join(root, 'editor');
  const previewDir = join(root, 'preview');
  const dataRoot = join(root, 'data');
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