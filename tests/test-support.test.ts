/**
 * The shared test support (tests/support): the static file server over real
 * HTTP and files on disk, and the command envelope a spec sends.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { mustCommand, sendCommand, type CommandRoute } from './support/commands';
import { serveDir } from './support/serve-dir';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function folder(): string {
  const base = join(homedir(), '.cache', 'tmp');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'tl-test-support-'));
  roots.push(root);
  mkdirSync(join(root, 'sub'));
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
  writeFileSync(join(root, 'sub', 'a.png'), 'png');
  writeFileSync(join(root, 'sub', 'b.bin'), 'bin');
  return root;
}

describe('serveDir', () => {
  it('serves the folder only, index.html for /, typed by extension', async () => {
    const root = folder();
    const served: string[] = [];
    const site = await serveDir(root, { served });
    try {
      const index = await fetch(site.url);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type')).toBe('text/html');
      expect(await index.text()).toBe('<!doctype html>');
      const png = await fetch(`${site.url}sub/a.png?x=1`);
      expect(png.headers.get('content-type')).toBe('application/octet-stream');
      expect((await fetch(`${site.url}sub`)).status).toBe(404);
      expect((await fetch(`${site.url}..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
      expect(served).toEqual(['index.html', 'sub/a.png']);
      expect(index.headers.get('cross-origin-opener-policy')).toBeNull();
    } finally {
      await site.close();
    }
  });

  it('takes more types, isolation headers, and drops open connections on close when asked', async () => {
    const site = await serveDir(folder(), { types: { '.png': 'image/png' }, isolated: true, dropConnections: true });
    const png = await fetch(`${site.url}sub/a.png`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(png.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    await site.close();
    await expect(fetch(site.url)).rejects.toThrow();
  });
});

describe('the command envelope', () => {
  const route = (answers: Record<string, unknown>[]): CommandRoute & { sent: Record<string, unknown>[] } => {
    const sent: Record<string, unknown>[] = [];
    return {
      projectId: 'p-0001',
      sent,
      command: (body) => {
        sent.push(body);
        return Promise.resolve(body['op'] === 'queryProject' ? { ok: true, revision: 7 } : answers.shift()!);
      },
    };
  };

  it('sends at the current revision with a fresh request id and the MCP origin, or none', async () => {
    const r = route([{ ok: true }, { ok: true }, { ok: true }]);
    await sendCommand(r, 'setTransform', { a: 1 }, { clientId: 'e2e-x' });
    await sendCommand(r, 'setTransform', { a: 2 }, { clientId: null, projectId: 'p-0002' });
    const [q, first, q2, second] = r.sent;
    expect(q).toEqual({ op: 'queryProject', projectId: 'p-0001', args: {} });
    expect(first).toMatchObject({ op: 'setTransform', projectId: 'p-0001', expectedRevision: 7, origin: { kind: 'mcp', clientId: 'e2e-x' }, args: { a: 1 } });
    expect(String(first!['requestId'])).toMatch(/^req-[0-9a-f]{32}$/);
    expect(q2!['projectId']).toBe('p-0002');
    expect(second!['origin']).toBeUndefined();
    expect(second!['requestId']).not.toBe(first!['requestId']);
  });

  it('mustCommand throws a refusal with its answer, and lets no_change pass when asked', async () => {
    const refused = { ok: false, error: { code: 'no_change' } };
    await expect(mustCommand(route([refused]), 'setName', {})).rejects.toThrow(/setName refused: .*no_change/);
    await expect(mustCommand(route([refused]), 'setName', {}, { noChangeIsDone: true })).resolves.toEqual(refused);
  });
});
