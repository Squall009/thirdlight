/**
 * Phase 23.9a: font import — the committed DejaVu Sans ASCII subset
 * (fixtures/fonts, TTF and WOFF2) gives its format and family name; an OTF
 * and a WOFF built from the same tables are accepted; truncated, garbage and
 * over-cap bytes are refused.
 */
import { describe, expect, it } from 'vitest';

import { FONT_SOURCE_BYTES_MAX, FONT_TOOLCHAIN, inspectFont } from './inspect-font';
import { base64ToBytes } from './test-fixtures';

const RAW = import.meta.glob('../../../fixtures/fonts/bytes.base64.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const files = JSON.parse(Object.values(RAW)[0]!) as Record<string, string>;
const ttf = base64ToBytes(files['neutral-sans.ttf']!);
const woff2 = base64ToBytes(files['neutral-sans.woff2']!);
const inspect = (bytes: Uint8Array) => inspectFont(bytes, { profile: 'font', recipeVersion: 1, toolchain: FONT_TOOLCHAIN, displayName: 'neutral sans' });

/** The TTF with its sfnt version replaced by 'OTTO' (the directory layout is the same). */
function asOtf(): Uint8Array {
  const b = ttf.slice();
  b.set([0x4f, 0x54, 0x54, 0x4f], 0);
  return b;
}

/** A WOFF 1.0 wrapping the TTF's tables uncompressed (compLength == origLength is allowed). */
function asWoff(): Uint8Array {
  const src = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const n = src.getUint16(4);
  const tables = Array.from({ length: n }, (_, i) => ({ tag: ttf.subarray(12 + i * 16, 16 + i * 16), sum: src.getUint32(12 + i * 16 + 4), off: src.getUint32(12 + i * 16 + 8), len: src.getUint32(12 + i * 16 + 12) }));
  let at = 44 + n * 20;
  const placed = tables.map((t) => {
    const off = at;
    at += (t.len + 3) & ~3;
    return { ...t, woffOff: off };
  });
  const b = new Uint8Array(at);
  const v = new DataView(b.buffer);
  b.set([0x77, 0x4f, 0x46, 0x46], 0);
  v.setUint32(4, 0x00010000);
  v.setUint32(8, at);
  v.setUint16(12, n);
  v.setUint32(16, ttf.length);
  placed.forEach((t, i) => {
    const r = 44 + i * 20;
    b.set(t.tag, r);
    v.setUint32(r + 4, t.woffOff);
    v.setUint32(r + 8, t.len);
    v.setUint32(r + 12, t.len);
    v.setUint32(r + 16, t.sum);
    b.set(ttf.subarray(t.off, t.off + t.len), t.woffOff);
  });
  return b;
}

describe('inspectFont', () => {
  it('accepts the TTF fixture and reads its family name', () => {
    const p = inspect(ttf);
    expect(p.status).toBe('ok');
    expect(p.kind).toBe('font');
    expect(p.metrics).toEqual({ format: 'ttf', familyName: 'DejaVu Sans' });
    expect(p.inspection).toEqual({ format: 'ttf', familyName: 'DejaVu Sans' });
    expect(p.importRecipe).toEqual({ profile: 'font', recipeVersion: 1, toolchain: { ...FONT_TOOLCHAIN } });
    expect(ttf.length).toBeLessThan(40 * 1024);
  });

  it('accepts the WOFF2 fixture, an OTF and a WOFF (no family name for the compressed ones)', () => {
    expect(inspect(woff2).metrics).toEqual({ format: 'woff2' });
    expect(inspect(asOtf()).metrics).toEqual({ format: 'otf', familyName: 'DejaVu Sans' });
    const woff = inspect(asWoff());
    expect(woff.status).toBe('ok');
    expect(woff.metrics).toEqual({ format: 'woff' });
  });

  it('refuses truncated, garbage and over-cap bytes', () => {
    for (const bad of [ttf.subarray(0, 8), ttf.subarray(0, 100), ttf.subarray(0, ttf.length - 200), woff2.subarray(0, 40), woff2.subarray(0, woff2.length - 1), asWoff().subarray(0, 60)]) {
      const p = inspect(bad);
      expect(p.status).toBe('rejected');
      expect(p.inspection.format).toBeNull();
      expect(p.diagnostics[0]!.code).toBe('asset_container_invalid');
    }
    const junk = inspect(new TextEncoder().encode('this is not a font file at all'));
    expect(junk.status).toBe('rejected');
    expect(junk.diagnostics[0]!.code).toBe('asset_container_invalid');
    const png = inspect(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0));
    expect(png.status).toBe('rejected');
    const huge = new Uint8Array(FONT_SOURCE_BYTES_MAX + 1);
    huge.set(ttf, 0);
    const over = inspect(huge);
    expect(over.status).toBe('rejected');
    expect(over.diagnostics[0]!.code).toBe('asset_size_exceeded');
  });
});
