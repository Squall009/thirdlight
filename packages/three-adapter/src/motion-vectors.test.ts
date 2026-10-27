/**
 * Motion vectors under blended draws: what a blended material writes into
 * the motion target leaves the target as it was under the blend state three
 * makes for it (its WebGPU pipeline's own factors, applied as WebGPU blends),
 * for every blend the engine's effects and mesh decals use and three's own
 * modes; opaque draws write their motion.
 */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { applyBlend } from './effects-draw';
import { installDecalDraw } from './mesh-decals';
import { blendsOver, keepValueOf } from './motion-vectors';

type Factor = string;
type Blend = { color: { srcFactor: Factor; dstFactor: Factor; operation: string }; alpha: { srcFactor: Factor; dstFactor: Factor; operation: string } };

/** A WebGPU blend factor's value for one channel (`a`: the channel is alpha). */
function factor(f: Factor, src: number[], dst: number[], ch: number): number {
  const sa = src[3]!;
  const da = dst[3]!;
  switch (f) {
    case 'zero':
      return 0;
    case 'one':
      return 1;
    case 'src':
      return src[ch]!;
    case 'one-minus-src':
      return 1 - src[ch]!;
    case 'src-alpha':
      return sa;
    case 'one-minus-src-alpha':
      return 1 - sa;
    case 'dst':
      return dst[ch]!;
    case 'one-minus-dst':
      return 1 - dst[ch]!;
    case 'dst-alpha':
      return da;
    case 'one-minus-dst-alpha':
      return 1 - da;
    default:
      throw new Error(`factor ${f} not modelled`);
  }
}

/** WebGPU's blend of `src` over `dst` (operation add, as three's modes use). */
function blend(b: Blend, src: number[], dst: number[]): number[] {
  return [0, 1, 2, 3].map((ch) => {
    const s = ch === 3 ? b.alpha : b.color;
    expect(s.operation).toBe('add');
    return src[ch]! * factor(s.srcFactor, src, dst, ch) + dst[ch]! * factor(s.dstFactor, src, dst, ch);
  });
}

/** Three's WebGPU pipeline helper (made with its backend, no device needed for the blend state). */
const utils = (new THREE.WebGPUBackend() as unknown as { pipelineUtils: { _getBlending(m: THREE.Material): Blend } }).pipelineUtils;

/** A material with each of the engine's blends: three's modes, the effect outputs' and the mesh decals'. */
function blendedMaterials(): [string, THREE.Material][] {
  const out: [string, THREE.Material][] = [];
  for (const [name, mode, premultiplied] of [
    ['normal', THREE.NormalBlending, false],
    ['normal premultiplied', THREE.NormalBlending, true],
    ['additive', THREE.AdditiveBlending, false],
    ['additive premultiplied', THREE.AdditiveBlending, true],
    ['subtractive premultiplied', THREE.SubtractiveBlending, true],
    ['multiply premultiplied', THREE.MultiplyBlending, true],
  ] as const) {
    const m = new THREE.MeshBasicNodeMaterial();
    m.transparent = true;
    m.blending = mode;
    m.premultipliedAlpha = premultiplied;
    out.push([name, m]);
  }
  for (const b of ['alpha', 'additive', 'premultiplied', 'multiply']) {
    const m = new THREE.MeshBasicNodeMaterial();
    applyBlend(m, b);
    out.push([`effect ${b}`, m]);
  }
  for (const b of ['blend', 'multiply', 'add'] as const) {
    const m = new THREE.MeshStandardNodeMaterial();
    installDecalDraw(m, { blend: b, sortOrder: 0 });
    out.push([`decal ${b}`, m]);
  }
  return out;
}

describe('motion vectors under blended draws', () => {
  it('a blended draw leaves the motion behind it as it was', () => {
    const behind = [0.0123, -0.0456, 0, 1];
    for (const [name, m] of blendedMaterials()) {
      expect(blendsOver(m), name).toBe(true);
      const k = keepValueOf(m);
      const out = blend(utils._getBlending(m), [k, k, k, k], behind);
      out.forEach((v, i) => expect(v, `${name} channel ${i}`).toBeCloseTo(behind[i]!, 9));
    }
  });

  it('opaque draws (and an opaque effect output) write their own motion', () => {
    const plain = new THREE.MeshStandardNodeMaterial();
    expect(blendsOver(plain)).toBe(false);
    const opaque = new THREE.MeshBasicNodeMaterial();
    applyBlend(opaque, 'opaque');
    expect(blendsOver(opaque)).toBe(false);
  });
});
