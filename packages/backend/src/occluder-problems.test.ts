/**
 * Ignored occluder stand-ins reach the project's problems: a model whose
 * `_OCC` node sticks out of its piece gets one line when the project loads
 * (and again only when the line changes), a model whose stand-in lies inside
 * and a model without one get none, and a file is read once per digest.
 */
import { describe, expect, it } from 'vitest';

import { createOccluderProblemChecker, occluderProblemLines, occluderProblems } from './occluder-problems';

/** A GLB of 1 m cubes (y 0..1), one per node: `[name, translation, scale]`. */
function cubes(nodes: readonly [string, [number, number, number], number][]): Uint8Array {
  const corners: number[] = [];
  for (const x of [-0.5, 0.5]) for (const y of [0, 1]) for (const z of [-0.5, 0.5]) corners.push(x, y, z);
  const pos = new Uint8Array(new Float32Array(corners).buffer);
  const idx = new Uint8Array(new Uint16Array([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]).buffer);
  const bin = new Uint8Array(pos.length + idx.length);
  bin.set(pos, 0);
  bin.set(idx, pos.length);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes: nodes.map(([name, t, s]) => ({ name, mesh: 0, translation: t, scale: [s, s, s] })),
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length }],
    buffers: [{ byteLength: bin.length }],
  };
  let text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(text.length + ((4 - (text.length % 4)) % 4)).fill(0x20);
  padded.set(text);
  text = padded;
  const out = new Uint8Array(28 + text.length + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, text.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  dv.setUint32(20 + text.length, bin.length, true);
  dv.setUint32(24 + text.length, 0x004e4942, true);
  out.set(bin, 28 + text.length);
  return out;
}

const INSIDE = cubes([['hedge_LOD0', [0, 0, 0], 1], ['hedge_OCC', [0, 0.25, 0], 0.5]]);
const OUTSIDE = cubes([['fence_LOD0', [0, 0, 0], 1], ['fence_OCC', [0, 0.5, 0], 1]]);
const NONE = cubes([['rock', [0, 0, 0], 1]]);

/** A project of three models, its files read through a counting `readBlob`. */
function service(files: Record<string, Uint8Array>) {
  const reads: string[] = [];
  return {
    reads,
    readCapturedV3: () => ({ ok: true as const, read: { content: { assets: Object.keys(files).map((assetId) => ({ assetId, kind: 'model', displayName: assetId.toUpperCase(), currentVersion: 1 })) } } }),
    readBlob: (_p: string, ref: { assetId: string }) => {
      reads.push(ref.assetId);
      return { ok: true as const, bytes: files[ref.assetId]!, digest: `d-${ref.assetId}` };
    },
  };
}

describe('ignored occluder stand-ins', () => {
  it('a stand-in sticking out of its piece is one problem line; one inside, and a model without, none', () => {
    expect(occluderProblemLines(INSIDE)).toEqual([]);
    expect(occluderProblemLines(NONE)).toEqual([]);
    const lines = occluderProblemLines(OUTSIDE);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('fence_OCC: 4 of 8 vertices outside the LOD0 bounds of "fence"');
    const svc = service({ hedge: INSIDE, fence: OUTSIDE, rock: NONE });
    const rows = occluderProblems(svc as never, 'p');
    expect(rows?.map((r) => r.assetId)).toEqual(['fence']);
    expect(rows![0]!.message.startsWith('"FENCE" (fence) v1: fence_OCC')).toBe(true);
    expect(rows![0]!.message.length).toBeLessThanOrEqual(256);
  });

  it('logs a model\'s line when it appears, not again while it stays, and reads each file once', () => {
    const svc = service({ hedge: INSIDE, fence: OUTSIDE });
    const logged: [string, string][] = [];
    const checker = createOccluderProblemChecker({ service: svc as never, recordProblem: (_p, code, message) => logged.push([code, message]), logStartup: () => undefined, closed: () => false });
    checker.loaded('p');
    checker.loaded('p');
    expect(logged.map(([code]) => code)).toEqual(['model_occluder_ignored']);
    expect(svc.reads).toEqual(['hedge', 'fence']);
    // A change that brings no model in runs no check.
    checker.changed('p', { type: 'setTransform' });
    expect(svc.reads).toHaveLength(2);
  });
});
