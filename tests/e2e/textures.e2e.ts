/**
 * Phase 9.4: standalone textures. A PNG imports as a `texture` asset whose tile
 * shows the image itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-tex-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A w×h RGBA PNG filled by `color(x, y)`. */
export function makePng(w: number, h: number, color: (x: number, y: number) => [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) raw.set(color(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('a PNG imports as a texture asset and its tile shows the image', async ({ page }) => {
  const file = join(dir, 'checker.png');
  writeFileSync(file, makePng(64, 64, (x, y) => ((x >> 3) + (y >> 3)) % 2 === 0 ? [240, 60, 60, 255] : [40, 40, 200, 255]));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const tile = page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'checker' });
  await expect(tile).toHaveCount(1, { timeout: 10_000 });
  await expect(tile).toContainText('texture');
  await expect(tile.locator('img.tl-tile__img--thumb')).toHaveAttribute('src', /^blob:/);
  const listed = await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } });
  expect((listed['assets'] as { kind: string }[])[0]!.kind).toBe('texture');
  // A texture is not draggable into the scene (it goes on a material).
  await expect(tile).toHaveAttribute('draggable', 'false');
});
