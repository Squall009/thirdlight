/**
 * Phase 23.11: the simulation's rig poser agrees with what the renderer
 * draws. The same GLB is read by project-model's `readModelRig` (the data
 * the runtime resolves sockets on) and loaded by the real three.js
 * GLTFLoader; the renderer's own `createAnimatorPlayer` poses the loaded
 * model from animator poses (single clips, weights under 1, crossfades,
 * an override layer with a bone mask) and every named node's world matrix is
 * compared with `RigPoser.nodeMatrix` — node names (sanitized, repeated,
 * clashing with a scene name), rest transforms, linear/step/cubic-spline
 * sampling and three.js's mixing rules included.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';

import { readModelRig } from '@thirdlight/project-model';
import { RigPoser, mat4, type AnimatorPose } from '@thirdlight/runtime';
import { createAnimatorPlayer } from '@thirdlight/three-adapter';

import { socketGlb } from '../../e2e/socket-glb';

async function load(bytes: Uint8Array): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => new GLTFLoader().parse(buf, '', (g) => resolve({ scene: g.scene, animations: g.animations }), reject));
}

/** A GLB whose names test three.js's naming: repeated names, a clash with the scene name, characters it strips; a cubic-spline and a step channel. */
function namingGlb(): Uint8Array {
  const f = (a: number[]): Uint8Array => new Uint8Array(new Float32Array(a).buffer);
  const h = (deg: number): number[] => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];
  const parts = [
    f([0, 1, 2]), // 0 times
    f([...[0, 0, 0, 0], ...h(0), ...[0, 0, 0, 0], ...[0, 0, 0, 0], ...h(60), ...[0, 0, 0, 0], ...[0, 0, 0, 0], ...h(120), ...[0, 0, 0, 0]]), // 1 cubic rotation
    f([0, 0, 0, 1, 1, 1, 2, 0.5, 0]), // 2 step translation
    f([1, 1, 1, 2, 2, 2, 0.5, 0.5, 0.5]), // 3 linear scale
  ];
  const offsets: number[] = [];
  let n = 0;
  for (const p of parts) {
    offsets.push(n);
    n += p.byteLength;
  }
  const bin = new Uint8Array(n);
  parts.forEach((p, i) => bin.set(p, offsets[i]!));
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes: [
      { name: 'Scene', children: [1, 3], translation: [1, 0, 0] },
      { name: 'Bone', children: [2], translation: [0, 1, 0], rotation: h(30) },
      { name: 'Bone', translation: [0, 0.5, 0], scale: [1, 2, 1] },
      { name: 'tip.end R', matrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0.25, 0.5, 0.75, 1] },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: parts.map((p, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: p.byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [2] },
      { bufferView: 1, componentType: 5126, count: 9, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    animations: [
      {
        name: 'wave',
        samplers: [
          { input: 0, output: 1, interpolation: 'CUBICSPLINE' },
          { input: 0, output: 2, interpolation: 'STEP' },
          { input: 0, output: 3, interpolation: 'LINEAR' },
        ],
        channels: [
          { sampler: 0, target: { node: 1, path: 'rotation' } },
          { sampler: 1, target: { node: 2, path: 'translation' } },
          { sampler: 2, target: { node: 3, path: 'scale' } },
        ],
      },
    ],
  };
  let j = new TextEncoder().encode(JSON.stringify(json));
  if (j.length % 4 !== 0) {
    const p = new Uint8Array(j.length + (4 - (j.length % 4))).fill(0x20);
    p.set(j);
    j = p;
  }
  const out = new Uint8Array(20 + j.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  dv.setUint32(20 + j.length, bin.length, true);
  dv.setUint32(24 + j.length, 0x004e4942, true);
  out.set(bin, 28 + j.length);
  return out;
}

async function compare(bytes: Uint8Array, poses: readonly (AnimatorPose | null)[]): Promise<number> {
  const rigRes = readModelRig(bytes, 'model-a');
  if (!rigRes.ok) throw new Error(rigRes.message);
  const poser = new RigPoser(rigRes.rig, 'model-a');
  const { scene, animations } = await load(bytes);
  const player = createAnimatorPlayer(scene, animations, 'model-a');
  const m = mat4();
  let compared = 0;
  for (const pose of poses) {
    if (pose !== null) player.apply(pose);
    scene.updateMatrixWorld(true);
    for (const [i, node] of rigRes.rig.nodes.entries()) {
      if (node.name === '') continue;
      const obj = scene.getObjectByName(node.name);
      expect(obj, `three.js has a node named "${node.name}"`).toBeDefined();
      poser.nodeMatrix(i, pose, m);
      const want = obj!.matrixWorld.elements;
      for (let k = 0; k < 16; k += 1) expect(m[k]!, `${node.name}[${k}] at ${JSON.stringify(pose?.clips ?? null)}`).toBeCloseTo(want[k]!, 5);
      compared += 1;
    }
  }
  player.dispose();
  return compared;
}

const clip = (name: string, time: number, weight: number) => ({ assetId: 'model-a', clip: name, time, weight });

describe('phase 23.11: the rig poser matches the renderer', () => {
  it('the socket fixture: rest, single clips, weights, crossfades and a masked override layer', async () => {
    const poses: (AnimatorPose | null)[] = [
      null,
      { state: 'a', clips: [clip('slide', 0, 1)] },
      { state: 'a', clips: [clip('slide', 1.25, 1)] },
      { state: 'a', clips: [clip('slide', 4, 1)] },
      { state: 'a', clips: [clip('spin', 0.7, 1)] },
      { state: 'a', clips: [clip('slide', 2, 0.4)] },
      { state: 'a', clips: [clip('slide', 3, 0.6), clip('spin', 1.5, 0.4)] },
      { state: 'a', clips: [clip('spin', 0.2, 0.25), clip('spin', 1.8, 0.75)] },
      { state: 'a', clips: [clip('slide', 1, 1)], layers: [{ name: 'L', mask: ['arm'], weight: 0.5, state: 'b', clips: [clip('spin', 1, 1)] }] },
      { state: 'a', clips: [clip('slide', 2.5, 1)], layers: [{ name: 'L', mask: ['base'], weight: 1, state: 'b', clips: [clip('spin', 1, 1)] }] },
    ];
    expect(await compare(socketGlb(), poses)).toBe(poses.length * 3);
  });

  it('three.js naming, matrix nodes, cubic-spline and step channels', async () => {
    const bytes = namingGlb();
    const rig = readModelRig(bytes, 'model-a');
    expect(rig.ok && rig.rig.nodes.map((n) => n.name)).toEqual(['Scene_1', 'Bone', 'Bone_1', 'tipend_R']);
    const poses: (AnimatorPose | null)[] = [null, { state: 'a', clips: [clip('wave', 0.4, 1)] }, { state: 'a', clips: [clip('wave', 1.3, 1)] }, { state: 'a', clips: [clip('wave', 1.7, 0.5)] }, { state: 'a', clips: [clip('wave', 2, 1)] }];
    expect(await compare(bytes, poses)).toBe(poses.length * 4);
  });
});
