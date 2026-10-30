/**
 * A model node's pose in the simulation — the rig (project-model
 * `ModelRig`, read from the GLB by the play/export closure) posed by the
 * animator's pose, the way three.js's `AnimationMixer` poses the rendered
 * model (`three-adapter/src/animator-player.ts`), so a socket sits where the
 * node is drawn.
 *
 * - Sampling: three.js's interpolants — linear (quaternions slerped),
 *   step (the key at or before the time), glTF cubic spline (Hermite with the
 *   stored tangents, quaternions normalized); before the first key the first
 *   value, after the last key the last.
 * - Mixing (three.js `PropertyMixer`): per node property, every playing clip
 *   that animates it is accumulated in clip order as a weighted running mix
 *   (lerp, or slerp for rotations); a total weight under 1 is mixed with the
 *   rest value by the remainder.
 * - Override layers: a clip of layer i drives only the nodes
 *   the layer covers; a clip's weight is scaled by Π(1 − L_j) over the later
 *   layers j covering the node, L_j = layer weight × min(1, its clip
 *   weights) — the same factors the renderer's layered actions get.
 * - Node matrices compose parent-first (column-major 4×4, like three.js).
 * - A pose's look-at turn (`look`) rotates its bones about their pivots in
 *   the model's space after the clips, as the renderer does.
 *
 * Pure and deterministic (plain doubles, fixed order): page, worker and
 * export compute the same pose.
 *
 * Why its own poser rather than three's mixer: the simulation runs without
 * three.js (worker, Node) and must be deterministic;
 * tests/integration/m23-sockets/rig-parity.test.ts holds the two together.
 */
import { composeMat4, decomposeMat4, mat4, mulMat4, quatMultiply, type Mat4 } from '@thirdlight/shared';
import type { ModelRig, ModelRigChannel } from '@thirdlight/project-model';

import type { AnimatorPose } from './animator';
import { quatConj } from './look-at';

/** three.js `Quaternion.slerpFlat`: dst[d..d+3] := slerp(src0[a..], src1[b..], t). */
export function slerpFlat(dst: number[] | Float64Array, d: number, src0: ArrayLike<number>, a: number, src1: ArrayLike<number>, b: number, t: number): void {
  let x0 = src0[a]!, y0 = src0[a + 1]!, z0 = src0[a + 2]!, w0 = src0[a + 3]!;
  const x1 = src1[b]!, y1 = src1[b + 1]!, z1 = src1[b + 2]!, w1 = src1[b + 3]!;
  if (t === 0) {
    dst[d] = x0;
    dst[d + 1] = y0;
    dst[d + 2] = z0;
    dst[d + 3] = w0;
    return;
  }
  if (t === 1) {
    dst[d] = x1;
    dst[d + 1] = y1;
    dst[d + 2] = z1;
    dst[d + 3] = w1;
    return;
  }
  if (w0 !== w1 || x0 !== x1 || y0 !== y1 || z0 !== z1) {
    let s = 1 - t;
    const cos = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
    const dir = cos >= 0 ? 1 : -1;
    const sqrSin = 1 - cos * cos;
    if (sqrSin > Number.EPSILON) {
      const sin = Math.sqrt(sqrSin);
      const len = Math.atan2(sin, cos * dir);
      s = Math.sin(s * len) / sin;
      t = Math.sin(t * len) / sin;
    }
    const tDir = t * dir;
    x0 = x0 * s + x1 * tDir;
    y0 = y0 * s + y1 * tDir;
    z0 = z0 * s + z1 * tDir;
    w0 = w0 * s + w1 * tDir;
    if (s === 1 - t) {
      const f = 1 / Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);
      x0 *= f;
      y0 *= f;
      z0 *= f;
      w0 *= f;
    }
  }
  dst[d] = x0;
  dst[d + 1] = y0;
  dst[d + 2] = z0;
  dst[d + 3] = w0;
}

/** Sample one channel at `time` into `out` (three.js's interpolants). */
export function sampleChannel(ch: ModelRigChannel, time: number, out: number[]): void {
  const size = ch.path === 'rotation' ? 4 : 3;
  const times = ch.times;
  const values = ch.values;
  const n = times.length;
  const cubic = ch.interpolation === 'CUBICSPLINE';
  const stride = cubic ? size * 3 : size;
  const valueAt = (i: number): number => i * stride + (cubic ? size : 0);
  // Before the first key / after the last: that key's value.
  if (!(time > times[0]!)) {
    const o = valueAt(0);
    for (let k = 0; k < size; k += 1) out[k] = values[o + k]!;
    return;
  }
  if (time >= times[n - 1]!) {
    const o = valueAt(n - 1);
    for (let k = 0; k < size; k += 1) out[k] = values[o + k]!;
    return;
  }
  // i1: the first key after `time` (binary search; keys are non-decreasing).
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= time) lo = mid + 1;
    else hi = mid;
  }
  const i1 = lo;
  const t0 = times[i1 - 1]!;
  const t1 = times[i1]!;
  if (ch.interpolation === 'STEP') {
    const o = valueAt(i1 - 1);
    for (let k = 0; k < size; k += 1) out[k] = values[o + k]!;
    return;
  }
  if (cubic) {
    const td = t1 - t0;
    const p = (time - t0) / td;
    const pp = p * p;
    const ppp = pp * p;
    const s2 = -2 * ppp + 3 * pp;
    const s3 = ppp - pp;
    const s0 = 1 - s2;
    const s1 = s3 - pp + p;
    const off1 = i1 * stride;
    const off0 = off1 - stride;
    for (let k = 0; k < size; k += 1) {
      const p0 = values[off0 + k + size]!;
      const m0 = values[off0 + k + size * 2]! * td;
      const p1 = values[off1 + k + size]!;
      const m1 = values[off1 + k]! * td;
      out[k] = s0 * p0 + s1 * m0 + s2 * p1 + s3 * m1;
    }
    if (size === 4) {
      const len = Math.hypot(out[0]!, out[1]!, out[2]!, out[3]!);
      if (len > 0) for (let k = 0; k < 4; k += 1) out[k] = out[k]! / len;
    }
    return;
  }
  const alpha = (time - t0) / (t1 - t0);
  const o0 = (i1 - 1) * size;
  const o1 = i1 * size;
  if (size === 4) {
    slerpFlat(out, 0, values, o0, values, o1, alpha);
    return;
  }
  for (let k = 0; k < size; k += 1) out[k] = values[o0 + k]! * (1 - alpha) + values[o1 + k]! * alpha;
}

interface BoundChannel {
  readonly node: number;
  readonly ch: ModelRigChannel;
}

/** The pose of one model's nodes (one per rig; reused for every entity showing that model). */
export class RigPoser {
  private readonly parent: Int32Array;
  private readonly byName = new Map<string, number>();
  /** `${assetId}\u0000${clip}` → its channels bound to this rig's nodes. */
  private readonly clips = new Map<string, readonly BoundChannel[]>();
  private readonly scratchLocal = mat4();
  private readonly scratchOut = mat4();
  private readonly tmp: number[] = [0, 0, 0, 0];
  /** `${assetId}\u0000${clip}` → its index in the rig (the renderer's action order). */
  private readonly clipOrder = new Map<string, number>();
  private readonly merged: { order: number; assetId: string; clip: string; time: number; weight: number }[] = [];
  private readonly acc: number[] = [0, 0, 0, 0];

  constructor(
    readonly rig: ModelRig,
    ownAssetId: string,
  ) {
    this.parent = Int32Array.from(rig.nodes.map((n) => n.parent));
    rig.nodes.forEach((n, i) => {
      if (n.name !== '' && !this.byName.has(n.name)) this.byName.set(n.name, i);
    });
    for (const clip of rig.clips) {
      const bound: BoundChannel[] = [];
      for (const ch of clip.channels) {
        let node: number | undefined;
        if (ch.node.startsWith('#')) {
          // An unnamed node of the same file (a clip of another file cannot name it).
          if (clip.assetId === ownAssetId) {
            const i = Number(ch.node.slice(1));
            if (Number.isInteger(i) && i >= 0 && i < rig.nodes.length) node = i;
          }
        } else node = this.byName.get(ch.node);
        if (node !== undefined) bound.push({ node, ch });
      }
      this.clips.set(`${clip.assetId}\u0000${clip.name}`, bound);
      if (!this.clipOrder.has(`${clip.assetId}\u0000${clip.name}`)) this.clipOrder.set(`${clip.assetId}\u0000${clip.name}`, this.clipOrder.size);
    }
  }

  /** A node's index by name (−1 when the model has no such node). */
  nodeIndex(name: string): number {
    return this.byName.get(name) ?? -1;
  }

  /**
   * The node's matrix in the model's space (its ancestors' and its own posed
   * local transforms, parents first) into `out`. `pose` null: the rest pose.
   */
  nodeMatrix(node: number, pose: AnimatorPose | null, out: Mat4): Mat4 {
    // The chain root → node.
    const chain: number[] = [];
    for (let i = node, guard = 0; i >= 0 && guard < 4096; i = this.parent[i]!, guard += 1) chain.push(i);
    out.fill(0);
    out[0] = 1;
    out[5] = 1;
    out[10] = 1;
    out[15] = 1;
    const t: number[] = [0, 0, 0];
    let r: number[] = [0, 0, 0, 1];
    const s: number[] = [1, 1, 1];
    const look = pose?.look;
    for (let k = chain.length - 1; k >= 0; k -= 1) {
      const i = chain[k]!;
      this.localTRS(i, pose, t, r, s);
      const turn = look === undefined ? undefined : look.bones.find((b) => b.node === this.rig.nodes[i]!.name);
      if (turn !== undefined) {
        // The look-at's model-space turn about the bone's pivot: local' = P⁻¹·D·P·local (P: the parent's model rotation).
        const pt: number[] = [0, 0, 0];
        const pr: number[] = [0, 0, 0, 1];
        const ps: number[] = [1, 1, 1];
        decomposeMat4(out, pt, pr, ps);
        r = quatMultiply(quatConj(pr), quatMultiply(turn.rotation, quatMultiply(pr, r)));
      }
      composeMat4(this.scratchLocal, t, r, s);
      mulMat4(this.scratchOut, out, this.scratchLocal);
      out.set(this.scratchOut);
    }
    return out;
  }

  /** One node's posed local translation, rotation and scale. */
  localTRS(node: number, pose: AnimatorPose | null, t: number[], r: number[], s: number[]): void {
    const n = this.rig.nodes[node]!;
    this.mixProperty(node, 'translation', pose, n.t, t);
    this.mixProperty(node, 'rotation', pose, n.r, r);
    this.mixProperty(node, 'scale', pose, n.s, s);
  }

  private mixProperty(node: number, path: 'translation' | 'rotation' | 'scale', pose: AnimatorPose | null, rest: readonly number[], out: number[]): void {
    const size = path === 'rotation' ? 4 : 3;
    let total = 0;
    const acc = this.acc;
    const tmp = this.tmp;
    const add = (value: readonly number[], w: number): void => {
      if (total === 0) {
        for (let k = 0; k < size; k += 1) acc[k] = value[k]!;
        total = w;
        return;
      }
      total += w;
      const mix = w / total;
      if (size === 4) slerpFlat(acc, 0, acc, 0, value, 0, mix);
      else for (let k = 0; k < size; k += 1) acc[k] = acc[k]! * (1 - mix) + value[k]! * mix;
    };
    if (pose !== null) {
      const layers = pose.layers ?? [];
      if (layers.length === 0) {
        // One action per clip, as the renderer has: the same clip twice (a crossfade into itself) is one
        // contribution with the summed weight, timed by the heavier part; clips in the rig's (file) order.
        const merged = this.merged;
        merged.length = 0;
        for (const c of pose.clips) {
          const order = this.clipOrder.get(`${c.assetId}\u0000${c.clip}`);
          if (order === undefined) continue;
          const have = merged.find((m) => m.order === order);
          if (have === undefined) merged.push({ order, assetId: c.assetId, clip: c.clip, time: c.time, weight: c.weight });
          else {
            if (c.weight > have.weight) have.time = c.time;
            have.weight += c.weight;
          }
        }
        merged.sort((a, b) => a.order - b.order);
        for (const c of merged) {
          if (!(c.weight > 0)) continue;
          const ch = this.channel(c.assetId, c.clip, node, path);
          if (ch === null) continue;
          sampleChannel(ch, c.time, tmp);
          add(tmp, c.weight);
        }
      } else {
        // L_j: how much layer j replaces what is under it (its clips must exist in this rig).
        const covers = layers.map((l) => l.mask.length === 0 || l.mask.includes(this.rig.nodes[node]!.name));
        const influence = layers.map((l) => {
          let sum = 0;
          for (const c of l.clips) if (this.clips.has(`${c.assetId}\u0000${c.clip}`)) sum += Math.max(0, c.weight);
          return Math.min(1, Math.max(0, l.weight)) * Math.min(1, sum);
        });
        const keep = (from: number): number => {
          let f = 1;
          for (let j = from + 1; j < layers.length; j += 1) if (covers[j]) f *= 1 - influence[j]!;
          return f;
        };
        const addList = (layer: number, clips: AnimatorPose['clips'], scale: number): void => {
          if (layer >= 0 && !covers[layer]) return;
          for (const c of clips) {
            if (!(c.weight > 0)) continue;
            const w = c.weight * scale * keep(layer);
            if (!(w > 0)) continue;
            const ch = this.channel(c.assetId, c.clip, node, path);
            if (ch === null) continue;
            sampleChannel(ch, c.time, tmp);
            add(tmp, w);
          }
        };
        addList(-1, pose.clips, 1);
        layers.forEach((l, i) => addList(i, l.clips, Math.min(1, Math.max(0, l.weight))));
      }
    }
    if (total === 0) {
      for (let k = 0; k < size; k += 1) out[k] = rest[k]!;
      return;
    }
    if (total < 1) {
      // The rest value makes up the missing weight.
      if (size === 4) slerpFlat(acc, 0, acc, 0, rest, 0, 1 - total);
      else for (let k = 0; k < size; k += 1) acc[k] = acc[k]! * total + rest[k]! * (1 - total);
    }
    for (let k = 0; k < size; k += 1) out[k] = acc[k]!;
  }

  private channel(assetId: string, clip: string, node: number, path: string): ModelRigChannel | null {
    const list = this.clips.get(`${assetId}\u0000${clip}`);
    if (list === undefined) return null;
    for (const b of list) if (b.node === node && b.ch.path === path) return b.ch;
    return null;
  }
}
