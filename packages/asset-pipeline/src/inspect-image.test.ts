/**
 * Standalone texture inspection (phase 9.4): PNG/JPEG/WebP by magic bytes,
 * the declared size bounded, never decoded.
 */
import { describe, expect, it } from 'vitest';

import { IMAGE_TOOLCHAIN, inspectImage, TEXTURE_EDGE_MAX } from './index';

const OPTS = { profile: 'image' as const, recipeVersion: 1 as const, toolchain: IMAGE_TOOLCHAIN };

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  b[24] = 8;
  b[25] = 6;
  return b;
}

describe('inspectImage', () => {
  it('accepts a PNG and reports format, size and decoded bytes', () => {
    const p = inspectImage(png(256, 128), OPTS);
    expect(p.status).toBe('ok');
    expect(p.kind).toBe('texture');
    expect(p.metrics).toEqual({ format: 'png', width: 256, height: 128, decodedBytes: 256 * 128 * 4 });
    expect(p.importRecipe).toEqual({ profile: 'image', recipeVersion: 1, toolchain: IMAGE_TOOLCHAIN });
  });

  it('rejects oversized images, other formats and garbage, never throwing', () => {
    expect(inspectImage(png(TEXTURE_EDGE_MAX + 1, 4), OPTS).status).toBe('rejected');
    expect(inspectImage(new TextEncoder().encode('hello, not an image at all'), OPTS).status).toBe('rejected');
    const ktx2 = new Uint8Array(64);
    ktx2.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(inspectImage(ktx2, OPTS).diagnostics[0]?.message).toMatch(/KTX2/);
  });
});
