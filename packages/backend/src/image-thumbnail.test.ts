/**
 * A texture's tile thumbnail made on the server: a PNG or JPEG image scaled
 * down to fit the thumbnail edge, each pixel the mean of the pixels it
 * covers, written as a PNG the editor draws — and nothing for what is not
 * such an image.
 */
import { describe, expect, it } from 'vitest';
import { decodePngRgba } from '@thirdlight/project-model/png';
import { ASSET_THUMBNAIL_EDGE } from '@thirdlight/project-model/limits';
import { inflateSync } from 'node:zlib';

import { encodeRgbaPng, makeImageThumbnail } from './image-thumbnail';

const inflate = (data: Uint8Array, maxOut: number): Uint8Array => inflateSync(data, { maxOutputLength: maxOut });

function image(width: number, height: number, at: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(at(x, y), (y * width + x) * 4);
  return encodeRgbaPng(rgba, width, height);
}

describe('image thumbnails', () => {
  it('scales a large image down to the thumbnail edge, keeping its aspect and its colours', async () => {
    // Left half red, right half blue, 512 × 256.
    const src = image(512, 256, (x) => (x < 256 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const png = (await makeImageThumbnail(src))!;
    const out = decodePngRgba(png, { inflate });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect([out.png.width, out.png.height]).toEqual([ASSET_THUMBNAIL_EDGE, ASSET_THUMBNAIL_EDGE / 2]);
    const px = (x: number, y: number): number[] => [...out.png.rgba.subarray((y * out.png.width + x) * 4, (y * out.png.width + x) * 4 + 4)];
    expect(px(10, 10)).toEqual([255, 0, 0, 255]);
    expect(px(ASSET_THUMBNAIL_EDGE - 10, 10)).toEqual([0, 0, 255, 255]);
    expect(png.byteLength).toBeLessThan(src.byteLength);
  });

  it('averages the pixels a thumbnail pixel covers (a fine checker becomes grey)', async () => {
    const src = image(256, 256, (x, y) => ((x + y) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const out = decodePngRgba((await makeImageThumbnail(src))!, { inflate });
    expect(out.ok && [...out.png.rgba.subarray(0, 4)]).toEqual([128, 128, 128, 255]);
  });

  it('keeps a small image at its size and refuses what is not an image', async () => {
    const out = decodePngRgba((await makeImageThumbnail(image(16, 8, () => [1, 2, 3, 4])))!, { inflate });
    expect(out.ok && [out.png.width, out.png.height]).toEqual([16, 8]);
    expect(await makeImageThumbnail(new TextEncoder().encode('glTF not an image'))).toBeNull();
  });
});
