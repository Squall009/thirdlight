/**
 * Phase 22.1: PNG encoding on the page — the inline side of the `encodePng`
 * job (the same OffscreenCanvas encoder as the worker where the page has
 * one, else a DOM canvas).
 */
import { encodePngOffscreen, type EncodeInput } from './jobs';

export async function encodePngOnPage(input: EncodeInput): Promise<Uint8Array> {
  if (typeof OffscreenCanvas === 'function') return encodePngOffscreen(input);
  const width = 'bitmap' in input ? input.bitmap.width : input.width;
  const height = 'bitmap' in input ? input.bitmap.height : input.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2D canvas for the PNG');
  if ('bitmap' in input) {
    ctx.drawImage(input.bitmap, 0, 0);
    input.bitmap.close();
  } else {
    ctx.putImageData(new ImageData(input.pixels as unknown as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('the PNG could not be encoded'));
      else void blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
    }, 'image/png');
  });
}
