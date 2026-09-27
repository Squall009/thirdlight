/**
 * Phase 23.11: sockets in the simulation — the rig poser (three.js's
 * sampling and mixing rules), the socket pose maths (target world · node ·
 * offset, written relative to the entity's parent), attach/detach rules, and
 * the animator's per-instance playback speed and morph weights.
 */
import { describe, expect, it } from 'vitest';

import type { ModelRig } from '@thirdlight/project-model';

import { AnimatorMachine, type AnimatorControllerLike, type AnimatorPose } from './animator';
import { RigPoser, decomposeMat4, mat4, sampleChannel } from './rig-pose';
import { SocketSystem, type SocketHost } from './sockets';
import type { TransformState } from './types';

const qy = (deg: number): [number, number, number, number] => {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
};

/** base → arm (+0.5 y) → hand (+0.5 z); `slide` moves the arm 0 → 4 m along x over 4 s; `spin` turns it 0 → 180° about y over 2 s. */
const RIG: ModelRig = {
  nodes: [
    { name: 'base', parent: -1, t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
    { name: 'arm', parent: 0, t: [0, 0.5, 0], r: [0, 0, 0, 1], s: [1, 1, 1] },
    { name: 'hand', parent: 1, t: [0, 0, 0.5], r: [0, 0, 0, 1], s: [1, 1, 1] },
  ],
  clips: [
    { assetId: 'model-a', name: 'slide', duration: 4, channels: [{ node: 'arm', path: 'translation', interpolation: 'LINEAR', times: [0, 4], values: [0, 0.5, 0, 4, 0.5, 0] }] },
    { assetId: 'model-a', name: 'spin', duration: 2, channels: [{ node: 'arm', path: 'rotation', interpolation: 'LINEAR', times: [0, 1, 2], values: [...qy(0), ...qy(90), ...qy(180)] }] },
  ],
};

const pose = (clips: { clip: string; time: number; weight: number }[], layers?: AnimatorPose['layers']): AnimatorPose => ({ state: 's', clips: clips.map((c) => ({ assetId: 'model-a', ...c })), ...(layers !== undefined ? { layers } : {}) });

function nodeAt(poser: RigPoser, name: string, p: AnimatorPose | null): { t: number[]; r: number[]; s: number[] } {
  const m = poser.nodeMatrix(poser.nodeIndex(name), p, mat4());
  const t = [0, 0, 0];
  const r = [0, 0, 0, 1];
  const s = [1, 1, 1];
  decomposeMat4(m, t, r, s);
  return { t, r, s };
}

describe('phase 23.11: the rig poser', () => {
  it('samples like three.js: linear, step, cubic spline, and holds the ends', () => {
    const out = [0, 0, 0, 0];
    const lin = { node: 'a', path: 'translation' as const, interpolation: 'LINEAR' as const, times: [1, 3], values: [0, 0, 0, 2, 4, 6] };
    sampleChannel(lin, 0, out);
    expect(out.slice(0, 3)).toEqual([0, 0, 0]);
    sampleChannel(lin, 2, out);
    expect(out.slice(0, 3)).toEqual([1, 2, 3]);
    sampleChannel(lin, 9, out);
    expect(out.slice(0, 3)).toEqual([2, 4, 6]);
    sampleChannel({ ...lin, interpolation: 'STEP' }, 2.9, out);
    expect(out.slice(0, 3)).toEqual([0, 0, 0]);
    // Hermite with zero tangents: smoothstep between the values.
    const cubic = { node: 'a', path: 'scale' as const, interpolation: 'CUBICSPLINE' as const, times: [0, 1], values: [0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 3, 3, 3, 0, 0, 0] };
    sampleChannel(cubic, 0.5, out);
    expect(out[0]).toBeCloseTo(2, 12);
    const rot = { node: 'a', path: 'rotation' as const, interpolation: 'LINEAR' as const, times: [0, 1], values: [...qy(0), ...qy(90)] };
    sampleChannel(rot, 0.5, out);
    expect(out[1]).toBeCloseTo(Math.sin(Math.PI / 8), 12);
  });

  it('poses a node from its clip, mixes weights and the rest pose, and follows layer masks', () => {
    const poser = new RigPoser(RIG, 'model-a');
    expect(poser.nodeIndex('hand')).toBe(2);
    expect(poser.nodeIndex('nope')).toBe(-1);
    expect(nodeAt(poser, 'hand', null).t).toEqual([0, 0.5, 0.5]);
    const slid = nodeAt(poser, 'hand', pose([{ clip: 'slide', time: 1.5, weight: 1 }]));
    expect(slid.t[0]).toBeCloseTo(1.5, 12);
    expect(slid.t[2]).toBeCloseTo(0.5, 12);
    // Weight 0.5: the other half is the rest pose (three.js PropertyMixer).
    expect(nodeAt(poser, 'hand', pose([{ clip: 'slide', time: 2, weight: 0.5 }])).t[0]).toBeCloseTo(1, 12);
    // A quarter turn about y carries the hand from +z to +x.
    const spun = nodeAt(poser, 'hand', pose([{ clip: 'spin', time: 1, weight: 1 }]));
    expect(spun.t[0]).toBeCloseTo(0.5, 12);
    expect(spun.t[2]).toBeCloseTo(0, 12);
    // A crossfade of the same clip into itself is one contribution timed by the heavier part.
    expect(nodeAt(poser, 'hand', pose([{ clip: 'slide', time: 1, weight: 0.3 }, { clip: 'slide', time: 3, weight: 0.7 }])).t[0]).toBeCloseTo(3, 12);
    // An override layer on `arm` at full weight replaces the base clip there; one masked elsewhere does not.
    const layer = (mask: string[]) => [{ name: 'L', mask, weight: 1, state: 'x', clips: [{ assetId: 'model-a', clip: 'slide', time: 4, weight: 1 }] }];
    expect(nodeAt(poser, 'hand', pose([{ clip: 'slide', time: 1, weight: 1 }], layer(['arm']))).t[0]).toBeCloseTo(4, 12);
    expect(nodeAt(poser, 'hand', pose([{ clip: 'slide', time: 1, weight: 1 }], layer(['base']))).t[0]).toBeCloseTo(1, 12);
  });
});

/** A small world of transforms for the socket system. */
function world(entities: { id: string; parentId?: string; t?: number[]; r?: number[]; s?: number[]; kinds?: string[] }[], poses: Map<string, AnimatorPose> = new Map()): { host: SocketHost; curr: Map<string, TransformState>; warnings: string[] } {
  const curr = new Map<string, TransformState>();
  const parent = new Map<string, string | null>();
  const kinds = new Map<string, string[]>();
  for (const e of entities) {
    curr.set(e.id, { position: [...(e.t ?? [0, 0, 0])] as [number, number, number], rotation: [...(e.r ?? [0, 0, 0, 1])] as [number, number, number, number], scale: [...(e.s ?? [1, 1, 1])] as [number, number, number] });
    parent.set(e.id, e.parentId ?? null);
    kinds.set(e.id, e.kinds ?? ['transform']);
  }
  const warnings: string[] = [];
  return {
    curr,
    warnings,
    host: { curr, parentOf: (id) => parent.get(id), componentsOf: (id) => kinds.get(id), poseOf: (id) => poses.get(id) ?? null, warn: (m) => warnings.push(m) },
  };
}
const entity = (id: string, components: Record<string, unknown>, parentId?: string) => ({ id, ...(parentId !== undefined ? { parentId } : {}), components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, ...components } }) as never;
const MODEL = { model: { asset: { assetId: 'model-a' } } };

describe('phase 23.11: the socket system', () => {
  it('places an attached entity at targetWorld · node · offset, relative to its own parent, following the pose', () => {
    const poses = new Map<string, AnimatorPose>([['tt', pose([{ clip: 'slide', time: 2, weight: 1 }])]]);
    const w = world(
      [
        { id: 'tt', t: [10, 0, 0], r: qy(90), s: [2, 2, 2], kinds: ['transform', 'model'] },
        { id: 'holder', t: [0, 1, 0] },
        { id: 'gem', parentId: 'holder', t: [5, 5, 5] },
      ],
      poses,
    );
    const sys = new SocketSystem({ 'model-a': RIG }, w.host);
    sys.add([entity('tt', MODEL), entity('holder', {}), entity('gem', { socketAttach: { target: 'tt', node: 'hand', position: [0, 0.25, 0] } }, 'holder')]);
    expect(sys.list()).toEqual([{ entityId: 'gem', target: 'tt', node: 'hand' }]);
    sys.resolve();
    // node (model space) at clip time 2: [2, 0.5, 0.5]; offset +0.25 y → [2, 0.75, 0.5]; ×2, turned 90° about y
    // ([x, y, z] → [z, y, −x]), + [10, 0, 0] → [11, 1.5, −4]; relative to the holder (+1 y) → [11, 0.5, −4].
    const g = w.curr.get('gem')!;
    expect(g.position[0]).toBeCloseTo(11, 12);
    expect(g.position[1]).toBeCloseTo(0.5, 12);
    expect(g.position[2]).toBeCloseTo(-4, 12);
    expect(g.scale[0]).toBeCloseTo(2, 12);
    expect(g.rotation[1]).toBeCloseTo(Math.SQRT1_2, 12);
    // The pose moves on: so does the socket.
    poses.set('tt', pose([{ clip: 'slide', time: 3, weight: 1 }]));
    sys.resolve();
    expect(g.position[2]).toBeCloseTo(-6, 12);
    // The node's world pose for scripts.
    const p = [0, 0, 0];
    const r = [0, 0, 0, 1];
    expect(sys.nodeWorld('tt', 'hand', p, r)).toBe(true);
    expect(p[0]).toBeCloseTo(11, 12);
    expect(p[1]).toBeCloseTo(1, 12);
    expect(p[2]).toBeCloseTo(-6, 12);
  });

  it('detaches keeping the world pose or snapping back, and re-attaches authored sockets on reset', () => {
    const w = world([{ id: 'tt', kinds: ['transform', 'model'] }, { id: 'gem', t: [7, 8, 9] }]);
    const sys = new SocketSystem({ 'model-a': RIG }, w.host);
    sys.add([entity('tt', MODEL), entity('gem', { socketAttach: { target: 'tt', node: 'hand' } })]);
    sys.resolve();
    const g = w.curr.get('gem')!;
    expect(g.position).toEqual([0, 0.5, 0.5]);
    // Snap back: to the transform it had when it was attached.
    expect(sys.detach('gem', false)).toBe(true);
    expect(g.position).toEqual([7, 8, 9]);
    expect(sys.active).toBe(false);
    // Keep the world pose: it stays where the node left it.
    expect(sys.attach('gem')).toBe(true);
    sys.resolve();
    expect(sys.detach('gem')).toBe(true);
    expect(sys.detach('gem')).toBe(false);
    expect(g.position).toEqual([0, 0.5, 0.5]);
    sys.reset();
    expect(sys.attachedTo('gem')).toEqual({ entityId: 'gem', target: 'tt', node: 'hand' });
  });

  it('refuses unknown nodes, loops, physics bodies and a target without a rig, with a warning', () => {
    const w = world([
      { id: 'tt', kinds: ['transform', 'model'] },
      { id: 'uu', kinds: ['transform', 'model'] },
      { id: 'crate', kinds: ['transform', 'collider'] },
      { id: 'plain' },
    ]);
    const sys = new SocketSystem({ 'model-a': RIG }, w.host);
    sys.add([entity('tt', MODEL), entity('uu', MODEL), entity('crate', {}), entity('plain', {}), entity('other', { model: { asset: { assetId: 'model-b' } } })]);
    expect(sys.attach('plain', 'tt', 'finger')).toBe(false);
    expect(sys.attach('crate', 'tt', 'hand')).toBe(false);
    expect(sys.attach('plain', 'plain', 'hand')).toBe(false);
    expect(sys.attach('plain', 'nobody', 'hand')).toBe(false);
    expect(sys.attach('uu', 'tt', 'hand')).toBe(true);
    expect(sys.attach('tt', 'uu', 'hand')).toBe(false); // uu rides on tt
    expect(sys.attach('plain')).toBe(false); // no socket of its own
    expect(w.warnings.some((m) => /no node "finger"/.test(m))).toBe(true);
    expect(w.warnings.some((m) => /collider/.test(m))).toBe(true);
    expect(w.warnings.some((m) => /loop/.test(m))).toBe(true);
    // Chained sockets resolve in dependency order.
    expect(sys.attach('plain', 'uu', 'hand')).toBe(true);
    sys.resolve();
    expect(w.curr.get('plain')!.position[1]).toBeCloseTo(1, 12);
    expect(w.curr.get('plain')!.position[2]).toBeCloseTo(1, 12);
    // A removed target lets go of what rides on it.
    sys.remove(new Set(['uu']));
    expect(sys.list()).toEqual([]);
  });
});

describe('phase 23.11: animator speed and morph weights', () => {
  const controller: AnimatorControllerLike = {
    controllerId: 'c',
    parameters: [{ name: 'smile', type: 'float', default: 0.25 }],
    states: [{ id: 'a', name: 'A', motion: { kind: 'clip', clip: { assetId: 'model-a', clip: 'slide', duration: 4 } }, speed: 1, loop: true }],
    transitions: [],
    entry: 'a',
    events: [],
    morphs: [{ target: 'mouth', parameter: 'smile' }],
  };
  it('scales the clip time by the per-instance speed (0 holds, 0.5 halves) and refuses a speed outside 0–10', () => {
    const full = new AnimatorMachine(controller);
    const half = new AnimatorMachine(controller);
    expect(half.setSpeed(0.5)).toBe(true);
    for (let i = 0; i < 120; i += 1) {
      full.step(1 / 120);
      half.step(1 / 120);
    }
    expect(full.pose().clips[0]!.time).toBeCloseTo(1, 9);
    expect(half.pose().clips[0]!.time).toBeCloseTo(0.5, 9);
    expect(half.speed()).toBe(0.5);
    expect(half.setSpeed(0)).toBe(true);
    half.step(1);
    expect(half.pose().clips[0]!.time).toBeCloseTo(0.5, 9);
    expect(half.setSpeed(-1)).toBe(false);
    expect(half.setSpeed(11)).toBe(false);
    expect(half.setSpeed(Number.NaN)).toBe(false);
  });
  it('reports morph weights from parameter bindings and scripts (clamped), only when there are some', () => {
    const m = new AnimatorMachine(controller);
    expect(m.pose().morphs).toEqual({ mouth: 0.25 });
    m.set('smile', 3);
    expect(m.morph('mouth')).toBe(1);
    expect(m.setMorph('blink', 0.4)).toBe(true);
    expect(m.setMorph('mouth', -2)).toBe(true);
    expect(m.pose().morphs).toEqual({ mouth: 0, blink: 0.4 });
    expect(m.setMorph('', 1)).toBe(false);
    const plain = new AnimatorMachine({ ...controller, morphs: undefined });
    expect(plain.pose().morphs).toBeUndefined();
  });
});
