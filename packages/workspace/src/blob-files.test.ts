/**
 * Files checked once per change and served from disk (the filesystem boundary):
 *
 * - a file's digest is kept under its stamp, in memory and in the stamps file,
 *   so a second pass, and a new process reading the stamps file, hashes only
 *   what changed;
 * - a file served under a digest it no longer has is refused before a byte is
 *   sent, and one that changes while it is sent never yields its last chunk.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlobChangedError, openBlobFile, SERVE_CHUNK_BYTES } from './blob-files';
import type { ContentContext } from './content-store';
import { FileStamps, STAMP_RACY_MS } from './file-stamps';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('file stamps and files served from disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tl-blob-files-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A file last modified well before now (a hash of it is trusted at once). */
  const writeOld = (name: string, bytes: Uint8Array): string => {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    const past = (Date.now() - 10 * STAMP_RACY_MS) / 1000;
    utimesSync(p, past, past);
    return p;
  };

  it('hashes a file once per change, and a new process reading the stamps file hashes only the changed one', () => {
    const a = writeOld('a.bin', new Uint8Array(3000).fill(1));
    const b = writeOld('b.bin', new Uint8Array(5000).fill(2));
    const file = join(dir, 'cache', 'file-stamps.json');
    const first = new FileStamps(file);
    expect(first.digestOf(a)!.digest).toBe(sha(new Uint8Array(3000).fill(1)));
    expect(first.digestOf(b)!.hashed).toBe(true);
    expect(first.digestOf(a)!.hashed).toBe(false);
    expect(first.hashes).toBe(2);
    first.save();
    // Another process: the stamps file answers for the unchanged file.
    writeOld('b.bin', new Uint8Array(5000).fill(3));
    const second = new FileStamps(file);
    expect(second.digestOf(a)!.hashed).toBe(false);
    const changed = second.digestOf(b)!;
    expect(changed.hashed).toBe(true);
    expect(changed.digest).toBe(sha(new Uint8Array(5000).fill(3)));
    expect(second.hashes).toBe(1);
  });

  it('does not trust a hash made in the same moment as the last write (it is made again next time)', () => {
    const p = join(dir, 'fresh.bin');
    writeFileSync(p, new Uint8Array(10).fill(4));
    const stamps = new FileStamps(null);
    expect(stamps.digestOf(p)!.hashed).toBe(true);
    expect(stamps.digestOf(p)!.hashed).toBe(true);
    // Once the hash is well after the write, the stamp is trusted.
    const later = new FileStamps(null, () => statSync(p).mtimeMs + STAMP_RACY_MS + 1);
    expect(later.digestOf(p)!.hashed).toBe(true);
    expect(later.digestOf(p)!.hashed).toBe(false);
  });

  it('refuses a file that no longer has its digest before sending, and cuts short one that changes while it is sent', async () => {
    const bytes = new Uint8Array(SERVE_CHUNK_BYTES * 3 + 17);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) & 0xff;
    const real = writeOld('asset.bin', bytes);
    const ctx: ContentContext = { projectId: 'p', dir, thirdlightDir: join(dir, '.thirdlight'), storageVersion: 4, revision: 1, scene: null, content: null, gameFolder: null, stamps: new FileStamps(null) };
    const file = { digest: sha(bytes), byteLength: bytes.length, real };

    // Whole and unchanged: every byte, in order.
    const whole = openBlobFile(ctx, file);
    expect(whole.ok).toBe(true);
    const got: Uint8Array[] = [];
    for await (const c of (whole as { ok: true; blob: { chunks(): AsyncGenerator<Uint8Array> } }).blob.chunks()) got.push(c);
    expect(sha(Buffer.concat(got))).toBe(file.digest);

    // Changed while it is sent: the last chunk never comes.
    const during = openBlobFile(ctx, file);
    expect(during.ok).toBe(true);
    const sent: Uint8Array[] = [];
    let error: unknown = null;
    try {
      for await (const c of (during as { ok: true; blob: { chunks(): AsyncGenerator<Uint8Array> } }).blob.chunks()) {
        if (sent.length === 0) {
          const other = new Uint8Array(bytes);
          other[other.length - 1] = (other[other.length - 1] ?? 0) ^ 0xff;
          writeFileSync(real, other);
        }
        sent.push(c);
      }
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BlobChangedError);
    expect(sent.reduce((n, c) => n + c.length, 0)).toBeLessThan(bytes.length);

    // Changed before it is opened: refused, and marked for a new check.
    const after = openBlobFile(ctx, file);
    expect(after.ok).toBe(false);
    expect(after.ok === false && after.changed).toBe(true);
    expect(after.ok === false && after.error.code).toBe('asset_source_changed');

    // A path outside the project is never opened.
    const outside = openBlobFile(ctx, { ...file, real: '/etc/hostname' });
    expect(outside.ok).toBe(false);
    expect(outside.ok === false && outside.changed).toBe(false);
  });
});
