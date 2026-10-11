/**
 * A paint stream is as tall as the page's GPU takes textures: a set or batch
 * whose painted copies pass that is drawn unpainted and said once to the
 * host's Problems, on a WebGL 2 device smaller than WebGPU's default side too.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { PAINT_STREAM_OVERFLOW, PAINT_STREAM_ROWS_MAX, PAINT_STREAM_WIDTH, paintStream, paintStreamRowsMax, reportPaintStreamOverflow, setPaintStreamDevice } from './vertex-paint-draw';

const webgl = (side: number) => ({ isWebGLBackend: true, gl: { MAX_TEXTURE_SIZE: 0x0d33, getParameter: (p: number) => (p === 0x0d33 ? side : 0) } });
const webgpu = (side: number) => ({ device: { limits: { maxTextureDimension2D: side } } });

afterEach(() => setPaintStreamDevice(webgpu(PAINT_STREAM_ROWS_MAX)));

describe('paint stream size', () => {
  it('takes the device largest side: WebGPU limits, WebGL 2 MAX_TEXTURE_SIZE, none below one row', () => {
    setPaintStreamDevice(webgpu(8192));
    expect(paintStreamRowsMax()).toBe(8192);
    setPaintStreamDevice(webgl(16384));
    expect(paintStreamRowsMax()).toBe(16384);
    setPaintStreamDevice(webgl(4096));
    expect(paintStreamRowsMax()).toBe(4096);
    setPaintStreamDevice(webgl(2048));
    expect(paintStreamRowsMax()).toBe(0);
    // A backend that names no size leaves what was read.
    setPaintStreamDevice({ isWebGLBackend: true });
    expect(paintStreamRowsMax()).toBe(0);
  });

  it('reports a stream past the device once and draws it unpainted; one that fits is made', () => {
    setPaintStreamDevice(webgl(4096));
    const heard: [string, string][] = [];
    const stop = reportPaintStreamOverflow((code, message) => heard.push([code, message]));
    // 4097 rows of 4096 texels: past this GPU, under WebGPU's default side.
    expect(paintStream(new Uint8Array(4), PAINT_STREAM_WIDTH, 4097)).toBeNull();
    expect(paintStream(new Uint8Array(4), PAINT_STREAM_WIDTH, 4097)).toBeNull();
    expect(heard).toHaveLength(1);
    expect(heard[0]![0]).toBe(PAINT_STREAM_OVERFLOW);
    expect(heard[0]![1]).toMatch(/4097 painted copies of a 4096-vertex mesh needs 4097 rows of 4096 texels, past the 4096 this GPU takes/);
    const fits = paintStream(new Uint8Array(8 * 4), 8, 1);
    expect(fits).not.toBeNull();
    fits?.dispose();
    stop();
    expect(paintStream(new Uint8Array(4), PAINT_STREAM_WIDTH, 5000)).toBeNull();
    expect(heard).toHaveLength(1);
  });
});
