/**
 * PNG encoding on an `OffscreenCanvas` — what the editor worker's jobs (and
 * the same jobs run on the page) use; a worker has no DOM canvas.
 */

/** Pixels (RGBA8, row 0 on top) or a bitmap to encode as PNG. */
export type EncodeInput = { pixels: Uint8ClampedArray; width: number; height: number } | { bitmap: ImageBitmap };

/** PNG bytes of pixels or a bitmap, on an OffscreenCanvas (a worker has no DOM canvas). */
export async function encodePngOffscreen(input: EncodeInput): Promise<Uint8Array> {
  const width = 'bitmap' in input ? input.bitmap.width : input.width;
  const height = 'bitmap' in input ? input.bitmap.height : input.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('no 2D OffscreenCanvas for the PNG');
  if ('bitmap' in input) {
    ctx.drawImage(input.bitmap, 0, 0);
    input.bitmap.close();
  } else {
    ctx.putImageData(new ImageData(input.pixels as unknown as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}
