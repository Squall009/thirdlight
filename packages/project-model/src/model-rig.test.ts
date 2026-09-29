/**
 * Reading a model's rig from GLB bytes — the node hierarchy with
 * rest transforms and three.js's node names, and the node animation channels.
 */
import { describe, expect, it } from 'vitest';

import { MODEL_RIG_LIMITS, readModelRig, rigNodeNames, sanitizeRigNodeName, validateModelRig } from './model-rig';

/** A GLB from a JSON document and one binary buffer (accessor data). */
function glb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  let j = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...json, buffers: [{ byteLength: bin.length }] }));
  if (j.length % 4 !== 0) {
    const p = new Uint8Array(j.length + (4 - (j.length % 4))).fill(0x20);
    p.set(j);
    j = p;
  }
  const bpad = (4 - (bin.length % 4)) % 4;
  const out = new Uint8Array(20 + j.length + 8 + bin.length + bpad);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  dv.setUint32(20 + j.length, bin.length + bpad, true);
  dv.setUint32(24 + j.length, 0x004e4942, true);
  out.set(bin, 28 + j.length);
  return out;
}

/** Concatenate typed arrays into one buffer, returning each part's byte offset. */
function pack(parts: ArrayBufferView[]): { bin: Uint8Array; offsets: number[] } {
  const offsets: number[] = [];
  let n = 0;
  for (const p of parts) {
    offsets.push(n);
    n += p.byteLength + ((4 - (p.byteLength % 4)) % 4);
  }
  const bin = new Uint8Array(n);
  parts.forEach((p, i) => bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), offsets[i]!));
  return { bin, offsets };
}

describe('phase 23.11: readModelRig', () => {
  it('reads the default scene depth-first with parents, rest transforms (matrix decomposed) and three.js names', () => {
    const m = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1]; // uniform scale 2 at [1, 2, 3]
    const doc = {
      scene: 1,
      scenes: [
        { name: 'Other', nodes: [5] },
        { name: 'Main', nodes: [0, 4] },
      ],
      nodes: [
        { name: 'Root Bone', children: [1, 2] },
        { name: 'hand.L', translation: [0.5, 0, 0], rotation: [0, 0, 0.7071067811865476, 0.7071067811865476] },
        { name: 'hand.L', scale: [1, 2, 3], children: [3] },
        { matrix: m },
        { name: 'Main' },
        { name: 'elsewhere' },
      ],
    };
    const r = readModelRig(glb(doc, new Uint8Array(0)), 'model-a');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nodes = r.rig.nodes;
    // three.js: scene names first ("Other", "Main"), then nodes; "hand.L" → "handL", the second "handL_1";
    // the node "Main" collides with the scene name reserved before it.
    expect(nodes.map((n) => n.name)).toEqual(['Root_Bone', 'handL', 'handL_1', '', 'Main_1']);
    expect(nodes.map((n) => n.parent)).toEqual([-1, 0, 0, 2, -1]);
    expect(nodes[1]!.t).toEqual([0.5, 0, 0]);
    expect(nodes[1]!.r[2]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(nodes[2]!.s).toEqual([1, 2, 3]);
    expect(nodes[3]!.t).toEqual([1, 2, 3]);
    expect(nodes[3]!.s).toEqual([2, 2, 2]);
    expect(nodes[3]!.r).toEqual([0, 0, 0, 1]);
    expect(rigNodeNames(r.rig)).toEqual(['Root_Bone', 'handL', 'handL_1', 'Main_1']);
    expect(sanitizeRigNodeName('a b:c/d[e].f')).toBe('a_bcdef');
    expect(validateModelRig(r.rig)).toBeNull();
  });

  it('reads translation/rotation/scale channels (normalized integers scaled, cubic spline kept) and skips morph weights', () => {
    const times = new Float32Array([0, 0.5, 2]);
    const trans = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    // A normalized int16 rotation: 32767 ≙ 1.
    const rot = new Int16Array([0, 0, 0, 32767, 0, 23170, 0, 23170]);
    const rotT = new Float32Array([0, 1]);
    const cubic = new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 3, 3, 3, 0, 0, 0]); // in, value, out × 2 keys
    const { bin, offsets } = pack([times, trans, rot, rotT, cubic]);
    const doc = {
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'a', children: [1] }, {}],
      bufferViews: [times, trans, rot, rotT, cubic].map((p, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: p.byteLength })),
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'SCALAR' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5122, normalized: true, count: 2, type: 'VEC4' },
        { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR' },
        { bufferView: 4, componentType: 5126, count: 6, type: 'VEC3' },
      ],
      animations: [
        {
          name: 'move',
          samplers: [
            { input: 0, output: 1 },
            { input: 3, output: 2, interpolation: 'STEP' },
            { input: 3, output: 4, interpolation: 'CUBICSPLINE' },
            { input: 3, output: 3 },
          ],
          channels: [
            { sampler: 0, target: { node: 0, path: 'translation' } },
            { sampler: 1, target: { node: 1, path: 'rotation' } },
            { sampler: 2, target: { node: 0, path: 'scale' } },
            { sampler: 3, target: { node: 0, path: 'weights' } },
          ],
        },
        { samplers: [], channels: [] },
      ],
    };
    const r = readModelRig(glb(doc, bin), 'model-a');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [move, unnamed] = r.rig.clips;
    expect(move!.name).toBe('move');
    expect(move!.assetId).toBe('model-a');
    expect(move!.duration).toBe(2);
    expect(move!.channels.map((c) => [c.node, c.path, c.interpolation])).toEqual([
      ['a', 'translation', 'LINEAR'],
      ['#1', 'rotation', 'STEP'],
      ['a', 'scale', 'CUBICSPLINE'],
    ]);
    expect(move!.channels[1]!.values[3]).toBeCloseTo(1, 6);
    expect(move!.channels[1]!.values[5]).toBeCloseTo(Math.SQRT1_2, 4);
    expect(move!.channels[2]!.values).toHaveLength(18);
    expect(unnamed!.name).toBe('animation_1');
    expect(r.keyNumbers).toBe(3 + 9 + 2 + 8 + 2 + 18);
    expect(validateModelRig(r.rig)).toBeNull();
  });

  it('leaves clips out past the key budget and marks the rig truncated', () => {
    const times = new Float32Array([0, 1]);
    const vals = new Float32Array([0, 0, 0, 1, 1, 1]);
    const { bin, offsets } = pack([times, vals]);
    const doc = {
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'a' }],
      bufferViews: [{ buffer: 0, byteOffset: offsets[0], byteLength: 8 }, { buffer: 0, byteOffset: offsets[1], byteLength: 24 }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR' },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      animations: [0, 1, 2].map((i) => ({ name: `c${i}`, samplers: [{ input: 0, output: 1 }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] })),
    };
    const r = readModelRig(glb(doc, bin), 'm', 12); // 8 numbers per clip
    expect(r.ok && r.rig.clips.map((c) => c.name)).toEqual(['c0']);
    expect(r.ok && r.rig.truncated).toBe(true);
    expect(MODEL_RIG_LIMITS.keyNumbers).toBeGreaterThan(100_000);
  });

  it('refuses what is not a GLB and flags malformed rig data', () => {
    expect(readModelRig(new Uint8Array(8), 'm').ok).toBe(false);
    expect(readModelRig(new TextEncoder().encode('{"asset":{"version":"2.0"}}'), 'm').ok).toBe(false);
    expect(validateModelRig({ nodes: [{ name: 'a', parent: 0, t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }], clips: [] })).toMatch(/earlier index/);
    expect(validateModelRig({ nodes: [], clips: [{ assetId: 'm', name: 'c', duration: 1, channels: [{ node: 'a', path: 'rotation', interpolation: 'LINEAR', times: [0], values: [0, 0, 0] }] }] })).toMatch(/do not match/);
  });
});
