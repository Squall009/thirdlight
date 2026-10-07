import { createResourceManager, type ProbeGridRecord } from '@thirdlight/runtime';
import { describe, expect, it } from 'vitest';

import { encodePng16, packProbeTexels } from './probe-artifact';
import { createProbeGridSet } from './probe-grids';

/** A tile file of `resolution` probes, every SH term `value`. */
async function tileFile(resolution: [number, number, number], value: number): Promise<Uint8Array> {
  const n = resolution[0] * resolution[1] * resolution[2];
  const packed = packProbeTexels(new Float32Array(n * 27).fill(value), new Float32Array(n));
  return encodePng16(packed.width, packed.height, packed.samples);
}

describe('probe grid set', () => {
  it('a bake again under the same asset id loads the new file (another resolution), not the decoded old one', async () => {
    const resources = createResourceManager();
    // The file the asset holds now: a re-bake replaces it in place.
    let file = await tileFile([2, 2, 2], 1);
    let reads = 0;
    const loadBytes = async (): Promise<Uint8Array> => (reads++, file);
    const grid = (resolution: [number, number, number]): ProbeGridRecord => ({ min: [0, 0, 0], max: [4, 4, 4], resolution, asset: 'probe-file' });
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    };

    const first = createProbeGridSet({ s: { grids: [grid([2, 2, 2])], createdAt: '2026-10-06T10:00:00.000Z' } }, loadBytes, resources);
    first.follow(['s']);
    await settle();
    expect(first.tiles()).toHaveLength(1);
    const oldBytes = first.tiles()[0]!.packed.data.byteLength;

    // The editor's setBakes: the old set lets go and the new one takes its tiles in the same tick.
    file = await tileFile([3, 2, 2], 2);
    first.dispose();
    const second = createProbeGridSet({ s: { grids: [grid([3, 2, 2])], createdAt: '2026-10-06T10:05:00.000Z' } }, loadBytes, resources);
    second.follow(['s']);
    await settle();
    expect(reads).toBe(2);
    expect(second.observe()).toMatchObject({ loaded: 1, failed: 0 });
    expect(second.tiles()[0]!.packed.data.byteLength).toBe((oldBytes * 3) / 2);

    // The same bake followed again shares the decoded tile (no read).
    const third = createProbeGridSet({ s: { grids: [grid([3, 2, 2])], createdAt: '2026-10-06T10:05:00.000Z' } }, loadBytes, resources);
    third.follow(['s']);
    await settle();
    expect(reads).toBe(2);
    expect(third.tiles()[0]!.packed).toBe(second.tiles()[0]!.packed);
  });
});
