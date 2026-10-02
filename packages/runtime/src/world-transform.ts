/**
 * An object's world transform: its own transform (local to its parent)
 * composed up its parents, as the renderer composes the scene graph. A
 * parent scaled unevenly and turned gives a child a sheared world matrix;
 * like Unity's `lossyScale` and Godot's `global_transform` basis, the scale
 * read back is the length of each world axis.
 */
import { composeMat4, decomposeMat4, mat4, mulMat4 } from './rig-pose';
import type { TransformState } from './types';

/** Parent chains deeper than this are cut (a cycle cannot hang a step). */
const MAX_DEPTH = 64;

export interface WorldTransform {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
}

const local = mat4();
const acc = mat4();
const tmp = mat4();

/**
 * `entityId`'s world transform from the step's transforms (`curr`) and its
 * parents, or undefined when it is not loaded. A parent that is not loaded
 * ends the chain (the object reads as if at the root).
 */
export function worldTransformOf(entityId: string, curr: ReadonlyMap<string, TransformState>, parentOf: (id: string) => string | null | undefined): WorldTransform | undefined {
  const own = curr.get(entityId);
  if (own === undefined) return undefined;
  composeMat4(acc, own.position, own.rotation, own.scale);
  let parent = parentOf(entityId);
  let rooted = true;
  for (let depth = 0; parent !== null && parent !== undefined && depth < MAX_DEPTH; depth += 1) {
    const t = curr.get(parent);
    if (t === undefined) break;
    rooted = false;
    composeMat4(local, t.position, t.rotation, t.scale);
    mulMat4(tmp, local, acc);
    acc.set(tmp);
    parent = parentOf(parent);
  }
  if (rooted) {
    // A root object's world transform is its own (no round trip through a matrix).
    return Object.freeze({
      position: Object.freeze([own.position[0], own.position[1], own.position[2]] as const),
      rotation: Object.freeze([own.rotation[0], own.rotation[1], own.rotation[2], own.rotation[3]] as const),
      scale: Object.freeze([own.scale[0], own.scale[1], own.scale[2]] as const),
    });
  }
  const p: number[] = [0, 0, 0];
  const r: number[] = [0, 0, 0, 1];
  const s: number[] = [1, 1, 1];
  decomposeMat4(acc, p, r, s);
  return Object.freeze({
    position: Object.freeze([p[0]!, p[1]!, p[2]!] as const),
    rotation: Object.freeze([r[0]!, r[1]!, r[2]!, r[3]!] as const),
    scale: Object.freeze([s[0]!, s[1]!, s[2]!] as const),
  });
}
