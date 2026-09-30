/**
 * The export writes its output as it is produced, over HTTP against the real
 * backend and the real disk:
 *
 * - every shipped asset is copied from its file in the game folder into the
 *   output (the bytes on disk, under their digest), with no temp or backup
 *   directory left in the export root;
 * - an export that fails midway (a shipped file changes while the files are
 *   being copied) answers with the structured error, removes its temp
 *   directory and leaves the previous output byte-untouched.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const WAV = readFileSync(join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-jump.wav'));
const PID = 'demo-0001';
const SOUNDS = 6;
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The same sound with its last sample byte changed: a different file (and digest) of the same size. */
function variant(i: number): Uint8Array {
  const b = new Uint8Array(WAV);
  b[b.length - 1] = (b[b.length - 1]! + 1 + i) & 0xff;
  return b;
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      const r = rel === '' ? e : `${rel}/${e}`;
      if (statSync(full).isDirectory()) walk(full, r);
      else out[r] = sha(readFileSync(full));
    }
  };
  walk(dir, '');
  return out;
}

describe('the export streams its files to disk', () => {
  let tb: TestBackend;
  let exportRoot: string;
  const game = (...rel: string[]): string => join(tb.root, 'data', 'projects', PID, ...rel);
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = (op: string, args: Record<string, unknown>) =>
    api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'export-streaming-test' }, args }, token: tb.adminToken, origin: null });
  const exportNow = () => api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null });
  const litter = (): string[] => readdirSync(exportRoot).filter((e) => e.startsWith('.export-tmp-') || e.includes('.replacing'));

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-export-streaming-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
    mkdirSync(game('assets', 'sfx'), { recursive: true });
    for (let i = 0; i < SOUNDS; i += 1) writeFileSync(game('assets', 'sfx', `s${i}.wav`), variant(i));
    expect((await command('importAssets', { folder: 'assets/sfx', labels: ['sfx'] })).status).toBe(200);
  });
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('copies every shipped asset from the game folder under its digest and leaves no temp directory', async () => {
    const r = await exportNow();
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const out = join(exportRoot, String((r.json as { outputDir: string }).outputDir));
    const files = tree(out);
    for (let i = 0; i < SOUNDS; i += 1) {
      const digest = sha(variant(i));
      expect(files[`content/sha256/${digest}`], `s${i}.wav`).toBe(digest);
    }
    expect(Object.keys(files).sort()).toEqual(Object.keys((r.json as { files: Record<string, number> }).files).sort());
    expect(litter()).toEqual([]);
  }, 240_000);

  it('an export that fails while it copies the files leaves no temp directory and the previous output untouched', async () => {
    const first = await exportNow();
    expect(first.status).toBe(200);
    const out = join(exportRoot, String((first.json as { outputDir: string }).outputDir));
    const before = tree(out);

    // The files are copied in digest order; the last one is changed on disk once the copying has begun.
    const last = Array.from({ length: SOUNDS }, (_, i) => ({ i, digest: sha(variant(i)) })).sort((a, b) => (a.digest < b.digest ? -1 : 1)).at(-1)!;
    const pending = exportNow();
    let changed = false;
    for (let spins = 0; spins < 2_000_000 && !changed; spins += 1) {
      await new Promise((r) => setImmediate(r));
      if (readdirSync(exportRoot).some((e) => e.startsWith('.export-tmp-'))) {
        writeFileSync(game('assets', 'sfx', `s${last.i}.wav`), variant(SOUNDS + 7));
        changed = true;
      }
    }
    expect(changed).toBe(true);
    const r = await pending;
    expect(r.status).not.toBe(200);
    const error = (r.json as { error: { code: string; reason?: string; message: string } }).error;
    expect(error.code).toBe('export_build_unavailable');
    expect(error.reason, error.message).toBe('asset_source_changed');
    expect(litter()).toEqual([]);
    expect(tree(out)).toEqual(before);
  }, 240_000);
});
