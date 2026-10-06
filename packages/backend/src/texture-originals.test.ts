/**
 * Which PNG counts as a KTX2 texture's lossless original, over HTTP against
 * the real backend and its game folder (KTX2 files made by the backend's
 * own encoder, imported from the folder):
 *
 * - A PNG of the same name and size beside the KTX2 counts only when the
 *   KTX2 records its digest (`KTX2_SOURCE_DIGEST_KEY`); a stale PNG left
 *   beside a KTX2 exported again is not read, and the layer is reported as
 *   re-encoded from the KTX2.
 * - The per-slot array's cache key names the original read: a PNG appearing
 *   beside the KTX2 later makes the array again (encoded from the PNG), and
 *   when it goes the first array is found in the cache again.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodeRgbaPng } from './image-thumbnail';
import { readKtx2, writeKtx2 } from './ktx2-container';
import { encodeKtx2 } from './texture-encode';
import { KTX2_SOURCE_DIGEST_KEY, ktx2RecordedSourceDigest } from './texture-originals';
import { slotArrayKey } from './texture-slots';
import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';
const S = 16;

/** A 16×16 RGBA PNG of `px`. */
const png = (px: (x: number, y: number) => [number, number, number, number]): Uint8Array => {
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) data.set(px(x, y), (y * S + x) * 4);
  return encodeRgbaPng(data, S, S);
};
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** `ktx2` with one more key/value entry (a NUL-terminated string). */
function withKeyValue(ktx2: Uint8Array, key: string, value: string): Uint8Array {
  const c = readKtx2(ktx2)!;
  const body = Buffer.from(`${key}\0${value}\0`, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  const kvd = new Uint8Array(Buffer.concat([c.kvd, len, body, Buffer.alloc((4 - (body.length % 4)) % 4)]));
  return writeKtx2({ ...c, kvd }, c.levels.map((l) => ({ data: l.stored, uncompressed: l.uncompressedByteLength })));
}

describe('lossless originals of KTX2 textures', () => {
  let tb: TestBackend;
  const ids: Record<string, string> = {};
  const IMAGE = png((x, y) => [x * 16, y * 16, (x * y) & 255, 255]);
  const OTHER = png((x, y) => [255 - x * 16, 40, y * 16, 255]);
  const game = (...rel: string[]): string => join(tb.root, 'data', 'projects', PID, ...rel);
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const post = (path: string, body: unknown) => api(`${tb.authUrl}/api/v1/projects/${PID}/${path}`, { body, token: tb.adminToken, origin: null });
  /** Pack one asset's whole RGBA as a colour texture; the route's answer. */
  const pack = async (assetId: string): Promise<{ packedFrom: { reencoded: boolean[] }; lossless?: Record<string, string> }> => {
    const r = await post('content/textures/pack', { layers: [(['r', 'g', 'b', 'a'] as const).map((channel) => ({ assetId, channel }))], encoding: 'color' });
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
    return r.json as { packedFrom: { reencoded: boolean[] }; lossless?: Record<string, string> };
  };
  /** The slot array of `assetId` alone, colour-encoded: its digest. */
  const slotArray = async (assetId: string): Promise<string> => {
    const res = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/textures/slots`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ layers: [assetId], mode: 'color' }),
    });
    expect(res.status).toBe(200);
    return res.headers.get('x-thirdlight-digest')!;
  };

  beforeAll(async () => {
    tb = await startBackend({ engineRoot: REPO });
    mkdirSync(game('assets', 'orig'), { recursive: true });
    // UASTC (linear) sources: a colour pack cannot join them, so their texels are read again.
    const made = await encodeKtx2(IMAGE, 'data');
    if (!made.ok) throw new Error(made.message);
    writeFileSync(game('assets', 'orig', 'stale.ktx2'), made.ktx2);
    writeFileSync(game('assets', 'orig', 'tied.ktx2'), withKeyValue(made.ktx2, KTX2_SOURCE_DIGEST_KEY, sha256(IMAGE)));
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'importAssets', projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'texture-originals-test' }, args: { folder: 'assets/orig' } }, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
    const assets = (tb.backend._test.service.query({ op: 'queryAssets', projectId: PID, args: { limit: 50, offset: 0 } }) as unknown as { assets: { assetId: string; displayName: string }[] }).assets;
    for (const name of ['stale', 'tied']) ids[name] = assets.find((a) => a.displayName === name)!.assetId;
  }, 120_000);
  afterAll(async () => {
    await tb?.teardown();
  });

  it('a slot array is made again when its KTX2\'s original appears, and found again when it goes', async () => {
    const stats = tb.backend._test.textureSlots.stats;
    const before = stats.assembled;
    const lossy = await slotArray(ids['tied']!);
    expect(await slotArray(ids['tied']!)).toBe(lossy);
    expect(stats.assembled - before).toBe(1);
    // The PNG the KTX2 records arrives: the array is encoded from it, under another key.
    writeFileSync(game('assets', 'orig', 'tied.png'), IMAGE);
    const t0 = performance.now();
    const lossless = await slotArray(ids['tied']!);
    expect(stats.assembled - before).toBe(2);
    expect(lossless).not.toBe(lossy);
    const hit = performance.now();
    expect(await slotArray(ids['tied']!)).toBe(lossless);
    console.info(`slot array from its PNG ${(hit - t0).toFixed(0)} ms; cache hit (route, PNG hashed) ${(performance.now() - hit).toFixed(1)} ms`);
    // Gone again: the first array, from the cache.
    rmSync(game('assets', 'orig', 'tied.png'));
    expect(await slotArray(ids['tied']!)).toBe(lossy);
    expect(stats.assembled - before).toBe(2);
    // The key is the same on any host with the same files and differs by the original read.
    const layer = { assetId: 'a', version: 1, sourceDigest: 'd'.repeat(64) };
    expect(slotArrayKey([layer], 'color', [null])).toEqual(slotArrayKey([layer], 'color', [null]));
    expect(slotArrayKey([layer], 'color', [null]).sourceDigest).not.toBe(slotArrayKey([layer], 'color', [sha256(IMAGE)]).sourceDigest);
  }, 120_000);

  it('a same-name same-size PNG counts only when the KTX2 records its digest', async () => {
    // A stale PNG beside a KTX2 that records nothing: the KTX2 is the source, flagged.
    writeFileSync(game('assets', 'orig', 'stale.png'), OTHER);
    expect(await pack(ids['stale']!)).toMatchObject({ packedFrom: { reencoded: [true] } });
    expect((await pack(ids['stale']!)).lossless).toBeUndefined();
    // Even its own image is not proven without a record.
    writeFileSync(game('assets', 'orig', 'stale.png'), IMAGE);
    expect(await pack(ids['stale']!)).toMatchObject({ packedFrom: { reencoded: [true] } });
    // A KTX2 recording its PNG's digest: another PNG there is not read; the recorded one is.
    writeFileSync(game('assets', 'orig', 'tied.png'), OTHER);
    const other = await pack(ids['tied']!);
    expect(other).toMatchObject({ packedFrom: { reencoded: [true] } });
    expect(other.lossless).toBeUndefined();
    writeFileSync(game('assets', 'orig', 'tied.png'), IMAGE);
    expect(await pack(ids['tied']!)).toMatchObject({ packedFrom: { reencoded: [false] }, lossless: { [ids['tied']!]: 'assets/orig/tied.png' } });
    expect(ktx2RecordedSourceDigest((await encodeKtx2(IMAGE, 'data') as { ktx2: Uint8Array }).ktx2)).toBeNull();
  }, 120_000);
});
