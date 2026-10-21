/**
 * "Check padding" over HTTP against the real backend: a trim sheet's image
 * (imported from the game folder as a PNG, and as a KTX2 transcoded on the
 * encoder's worker path) checked against its row table. A detailed sheet
 * whose gutters repeat their rows exactly passes as a UASTC KTX2 from the
 * pinned encoder; as ETC1S its differing gutters are not judged (its blocks
 * move them as much as a fault would), never as faults.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodeRgbaPng } from './image-thumbnail';
import { encodeKtx2 } from './texture-encode';
import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';
/** Two 16 px rows on a 64 × 64 sheet, 8 px of padding: red [8, 24), blue [40, 56). */
const SHEET = { size: [64, 64], texelDensity: 64, padding: 8, rows: [{ slot: 'lower_wall', top: 8, bottom: 24 }, { slot: 'trim', top: 40, bottom: 56 }] };

/** Rows on a 256 × 256 sheet, 8 px gutters, starting off the 4 px block grid (the blocks hold a row's edge and its gutter). */
const DETAILED = { size: [256, 256], texelDensity: 64, padding: 8, rows: [{ slot: 'a', top: 13, bottom: 61 }, { slot: 'b', top: 77, bottom: 141 }, { slot: 'c', top: 157, bottom: 237, tileV: true }] };

/** Shaded rows (a wave plus fine grain) whose gutters repeat the edge rows exactly (a field's continue its wrap). */
function detailedPng(): Uint8Array {
  const W = 256;
  const d = new Uint8Array(W * W * 4).fill(128);
  const grain = (x: number, y: number): number => (((Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0) % 33) - 16;
  DETAILED.rows.forEach((r, i) => {
    for (let y = r.top; y < r.bottom; y++) {
      for (let x = 0; x < W; x++) {
        const v = 128 + 60 * Math.sin(x / 9 + i) * Math.cos(y / 7) + grain(x, y) / 2;
        d.set([v + i * 20, v * 0.8, v * 0.6 + 30, 255].map((c) => Math.max(0, Math.min(255, Math.round(c)))), (y * W + x) * 4);
      }
    }
    const tall = r.bottom - r.top;
    for (let k = 1; k <= DETAILED.padding; k++) {
      const above = r.tileV === true ? r.bottom - 1 - ((k - 1) % tall) : r.top;
      const below = r.tileV === true ? r.top + ((k - 1) % tall) : r.bottom - 1;
      d.copyWithin((r.top - k) * W * 4, above * W * 4, (above + 1) * W * 4);
      d.copyWithin((r.bottom - 1 + k) * W * 4, below * W * 4, (below + 1) * W * 4);
    }
  });
  return encodeRgbaPng(d, W, W);
}

/** The sheet: each row's colour over its row and padding; `leak` paints the blue row's colour into red's last padding row. */
function sheetPng(leak: boolean): Uint8Array {
  const data = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    const c = y < 32 ? [200, 30, 30, 255] : [30, 30, 200, 255];
    for (let x = 0; x < 64; x++) data.set(leak && y === 31 ? [30, 30, 200, 255] : c, (y * 64 + x) * 4);
  }
  return encodeRgbaPng(data, 64, 64);
}

describe('trim sheet padding check', () => {
  let tb: TestBackend;
  const ids: Record<string, string> = {};
  const game = (...rel: string[]): string => join(tb.root, 'data', 'projects', PID, ...rel);
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const check = (texture: string, trim: unknown) => api(`${tb.authUrl}/api/v1/projects/${PID}/content/textures/trim-check`, { body: { texture, trim }, token: tb.adminToken, origin: null });

  beforeAll(async () => {
    tb = await startBackend({ engineRoot: REPO });
    mkdirSync(game('assets', 'trim'), { recursive: true });
    writeFileSync(game('assets', 'trim', 'good.png'), sheetPng(false));
    writeFileSync(game('assets', 'trim', 'leaky.png'), sheetPng(true));
    const made = await encodeKtx2(sheetPng(false), 'data');
    if (!made.ok) throw new Error(made.message);
    writeFileSync(game('assets', 'trim', 'packed.ktx2'), made.ktx2);
    writeFileSync(game('assets', 'trim', 'detailed.png'), detailedPng());
    for (const [name, mode] of [['detailed-uastc', 'data'], ['detailed-etc1s', 'color']] as const) {
      const k = await encodeKtx2(detailedPng(), mode);
      if (!k.ok) throw new Error(k.message);
      writeFileSync(game('assets', 'trim', `${name}.ktx2`), k.ktx2);
    }
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'importAssets', projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'trim-check-test' }, args: { folder: 'assets/trim' } }, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
    const assets = (tb.backend._test.service.query({ op: 'queryAssets', projectId: PID, args: { limit: 50, offset: 0 } }) as unknown as { assets: { assetId: string; displayName: string }[] }).assets;
    for (const name of ['good', 'leaky', 'packed', 'detailed', 'detailed-uastc', 'detailed-etc1s']) ids[name] = assets.find((a) => a.displayName === name)!.assetId;
  }, 120_000);
  afterAll(async () => {
    await tb?.teardown();
  });

  it('passes a padded sheet, finds a row whose padding is the next row, reads a KTX2 transcoded, and refuses a bad table', async () => {
    const good = await check(ids['good']!, SHEET);
    expect(good.status, JSON.stringify(good.json)).toBe(200);
    expect(good.json).toMatchObject({ ok: true, width: 64, height: 64, sizeMatches: true, transcoded: false, problems: [] });
    const leaky = await check(ids['leaky']!, SHEET);
    expect(leaky.json).toMatchObject({ ok: true, problems: [{ slot: 'lower_wall', side: 'below', y: 31, difference: 170 }] });
    const ktx2 = await check(ids['packed']!, SHEET);
    expect(ktx2.json).toMatchObject({ ok: true, transcoded: true, problems: [] });
    // A table for another size: reported, no rows checked.
    expect((await check(ids['good']!, { ...SHEET, size: [128, 128] })).json).toMatchObject({ ok: true, sizeMatches: false, problems: [] });
    // A detailed sheet: exact as a PNG; within the transcoded tolerance as UASTC; as ETC1S its blocks move the gutters: not judged, no faults.
    expect((await check(ids['detailed']!, DETAILED)).json).toMatchObject({ ok: true, transcoded: false, paddingRead: true, problems: [] });
    expect((await check(ids['detailed-uastc']!, DETAILED)).json).toMatchObject({ ok: true, transcoded: true, paddingRead: true, problems: [] });
    expect((await check(ids["detailed-etc1s"]!, DETAILED)).json).toMatchObject({ ok: true, transcoded: true, paddingRead: false, problems: [] });
    const bad = await check(ids['good']!, { ...SHEET, rows: [] });
    expect(bad.status).toBe(400);
    expect((await check('no-such-texture', SHEET)).status).toBe(400);
  }, 120_000);
});
