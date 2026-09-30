/**
 * A model's rig as simulation data — its node hierarchy (rest
 * transforms) and the node animation channels of its clips, read from the
 * GLB bytes.
 *
 * Why: sockets (an entity attached to a named node of another entity's
 * model) are resolved in the simulation step, so the page, the simulation
 * worker and the static export place an attached entity identically and a
 * replay reproduces it. The runtime never loads models, so the play/export
 * closure reads the rig once from the asset's bytes (the digest-verified
 * blob) and ships it as data; the runtime evaluates the animator's pose on it
 * (`runtime/src/rig-pose.ts`) the way three.js's mixer poses the rendered
 * model.
 *
 * - Nodes: the default scene's nodes in depth-first order (parents first),
 *   each with its parent index (−1 at the root) and its rest translation,
 *   rotation and scale (a node `matrix` is decomposed like three.js does).
 * - Names follow three.js's GLTFLoader naming (so the node a designer picks
 *   is the node the renderer draws): whitespace → `_`, `[ ] . : /` removed,
 *   a repeated name gets `_1`, `_2`, … in the loader's order (scene names,
 *   then each scene's nodes depth-first; a node's camera and light names
 *   right after it). Unnamed nodes have the name `''` (not addressable).
 * - Clips: every animation (`name`, else `animation_<index>`), its
 *   translation/rotation/scale channels (morph `weights` are not node
 *   poses), key times and values as stored (normalized integers scaled like
 *   three.js), the interpolation, and the duration (the last key time).
 *   A channel names its node (`#<index>` for an unnamed node of the same
 *   file), so clips of an animation-only file bind by name to another rig.
 *
 * Pure: bytes in, data out; no I/O, no three.js.
 */

export type RigPath = 'translation' | 'rotation' | 'scale';
export type RigInterpolation = 'LINEAR' | 'STEP' | 'CUBICSPLINE';

export interface ModelRigNode {
  name: string;
  /** The parent's index in `nodes` (−1: a root of the scene). */
  parent: number;
  t: [number, number, number];
  r: [number, number, number, number];
  s: [number, number, number];
}

export interface ModelRigChannel {
  /** The node's name, or `#<index>` (an unnamed node of the clip's own file). */
  node: string;
  path: RigPath;
  interpolation: RigInterpolation;
  times: number[];
  /** 3 (translation, scale) or 4 (rotation) values per key; ×3 for CUBICSPLINE (in-tangent, value, out-tangent). */
  values: number[];
}

export interface ModelRigClip {
  /** The asset whose file holds the clip (a model's own, or an animation-only file for its rig). */
  assetId: string;
  name: string;
  /** Seconds (the last key time of any channel). */
  duration: number;
  channels: ModelRigChannel[];
}

export interface ModelRig {
  nodes: ModelRigNode[];
  clips: ModelRigClip[];
  /** Clips were left out: the rig's key data passed {@link MODEL_RIG_LIMITS}.keyNumbers. */
  truncated?: true;
}

/**
 * Engine limits of a rig as data. Nodes and clips match the importer's caps
 * (4,096 nodes, 64 clips). Key numbers (times + values of every channel)
 * bound what one model adds to a play/export manifest: 262,144 numbers is
 * about 3 MB of JSON — a character with 60 bones × 12 clips × 3 channels of
 * 30 keys fits with room; clips past the limit are left out and the rig is
 * marked `truncated` (a socket on it then warns once in the play log). The
 * budget is per model (its animation-only files included), never shared
 * across the project, so a game's hundredth character is read like its first.
 */
export const MODEL_RIG_LIMITS = Object.freeze({ nodes: 4096, clips: 64, keyNumbers: 262_144 });

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** three.js `PropertyBinding.sanitizeNodeName`. */
export function sanitizeRigNodeName(name: string): string {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

/** three.js `Matrix4.decompose` of a column-major 4×4 into [t, r, s]. */
function decompose(m: readonly number[]): { t: [number, number, number]; r: [number, number, number, number]; s: [number, number, number] } {
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const det =
    m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  if (det < 0) sx = -sx;
  const isx = sx === 0 ? 0 : 1 / sx;
  const isy = sy === 0 ? 0 : 1 / sy;
  const isz = sz === 0 ? 0 : 1 / sz;
  return {
    t: [m[12]!, m[13]!, m[14]!],
    r: quatFromRotation(m[0]! * isx, m[4]! * isy, m[8]! * isz, m[1]! * isx, m[5]! * isy, m[9]! * isz, m[2]! * isx, m[6]! * isy, m[10]! * isz),
    s: [sx, sy, sz],
  };
}

/** three.js `Quaternion.setFromRotationMatrix` (row-major arguments m11…m33). */
export function quatFromRotation(m11: number, m12: number, m13: number, m21: number, m22: number, m23: number, m31: number, m32: number, m33: number): [number, number, number, number] {
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
/** Bytes per component and the normalized scale three.js applies (`getNormalizedComponentScale`). */
const COMPONENT_TYPES: Record<number, { bytes: number; read: (v: DataView, o: number) => number; norm: number }> = {
  5120: { bytes: 1, read: (v, o) => v.getInt8(o), norm: 1 / 127 },
  5121: { bytes: 1, read: (v, o) => v.getUint8(o), norm: 1 / 255 },
  5122: { bytes: 2, read: (v, o) => v.getInt16(o, true), norm: 1 / 32767 },
  5123: { bytes: 2, read: (v, o) => v.getUint16(o, true), norm: 1 / 65535 },
  5125: { bytes: 4, read: (v, o) => v.getUint32(o, true), norm: 1 },
  5126: { bytes: 4, read: (v, o) => v.getFloat32(o, true), norm: 1 },
};

/** Split a GLB into its JSON and BIN chunks (null: not a GLB 2.0). */
function glbChunks(bytes: Uint8Array): { json: Json; bin: DataView | null } | string {
  if (bytes.byteLength < 20) return 'the file is too short to be a GLB';
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) return 'the file is not a GLB (magic)';
  if (dv.getUint32(4, true) !== 2) return 'only GLB version 2 is read';
  const total = Math.min(dv.getUint32(8, true), bytes.byteLength);
  let off = 12;
  let json: Json | null = null;
  let bin: DataView | null = null;
  while (off + 8 <= total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (start + len > total) return 'a GLB chunk runs past the file end';
    if (type === 0x4e4f534a && json === null) {
      try {
        const text = new TextDecoder('utf-8').decode(bytes.subarray(start, start + len));
        const parsed: unknown = JSON.parse(text);
        if (!isObj(parsed)) return 'the GLB JSON is not an object';
        json = parsed;
      } catch {
        return 'the GLB JSON does not parse';
      }
    } else if (type === 0x004e4942 && bin === null) {
      bin = new DataView(bytes.buffer, bytes.byteOffset + start, len);
    }
    off = start + len + ((4 - (len % 4)) % 4);
  }
  if (json === null) return 'the GLB has no JSON chunk';
  return { json, bin };
}

/** An accessor's numbers (normalized integers scaled; null when it cannot be read). */
function readAccessor(json: Json, bin: DataView | null, index: unknown): { data: number[]; size: number } | null {
  const accessors = Array.isArray(json['accessors']) ? (json['accessors'] as unknown[]) : [];
  const views = Array.isArray(json['bufferViews']) ? (json['bufferViews'] as unknown[]) : [];
  if (typeof index !== 'number' || !Number.isInteger(index)) return null;
  const a = accessors[index];
  if (!isObj(a) || a['sparse'] !== undefined || typeof a['bufferView'] !== 'number') return null;
  const size = COMPONENTS[String(a['type'])];
  const ct = COMPONENT_TYPES[Number(a['componentType'])];
  const count = a['count'];
  if (size === undefined || ct === undefined || typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
  const view = views[a['bufferView'] as number];
  if (!isObj(view) || bin === null || (view['buffer'] ?? 0) !== 0) return null;
  const base = (typeof view['byteOffset'] === 'number' ? view['byteOffset'] : 0) + (typeof a['byteOffset'] === 'number' ? a['byteOffset'] : 0);
  const elem = size * ct.bytes;
  const stride = typeof view['byteStride'] === 'number' && view['byteStride'] > 0 ? view['byteStride'] : elem;
  if (count > 0 && base + stride * (count - 1) + elem > bin.byteLength) return null;
  const scale = a['normalized'] === true ? ct.norm : 1;
  const data: number[] = new Array<number>(count * size);
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < size; k += 1) {
      const v = ct.read(bin, base + i * stride + k * ct.bytes);
      data[i * size + k] = scale === 1 ? v : Math.fround(v * scale);
    }
  }
  return { data, size };
}

const PATHS: Record<string, { path: RigPath; size: number }> = {
  translation: { path: 'translation', size: 3 },
  rotation: { path: 'rotation', size: 4 },
  scale: { path: 'scale', size: 3 },
};

/**
 * Read a model's rig from its GLB bytes. `assetId` stamps the clips (the
 * runtime looks a pose clip up by asset and name). Never throws.
 */
export function readModelRig(bytes: Uint8Array, assetId: string, keyBudget: number = MODEL_RIG_LIMITS.keyNumbers): { ok: true; rig: ModelRig; keyNumbers: number } | { ok: false; message: string } {
  const chunks = glbChunks(bytes);
  if (typeof chunks === 'string') return { ok: false, message: chunks };
  const { json, bin } = chunks;
  const nodesDef = Array.isArray(json['nodes']) ? (json['nodes'] as unknown[]) : [];
  const scenes = Array.isArray(json['scenes']) ? (json['scenes'] as unknown[]) : [];
  const cameras = Array.isArray(json['cameras']) ? (json['cameras'] as unknown[]) : [];
  const lightsExt = isObj(json['extensions']) ? (json['extensions'] as Json)['KHR_lights_punctual'] : undefined;
  const lights = isObj(lightsExt) && Array.isArray(lightsExt['lights']) ? (lightsExt['lights'] as unknown[]) : [];

  // Names as three.js's GLTFLoader gives them (its createUniqueName, in its order).
  const used = new Map<string, number>();
  const unique = (original: string): string => {
    const s = sanitizeRigNodeName(original);
    const n = used.get(s);
    if (n !== undefined) {
      used.set(s, n + 1);
      return `${s}_${n + 1}`;
    }
    used.set(s, 0);
    return s;
  };
  const nodeName = new Map<number, string>();
  const namedCameras = new Set<number>();
  const namedLights = new Set<number>();
  const reserve = (index: number, depth: number): void => {
    if (depth > 256 || nodeName.has(index)) return;
    const def = nodesDef[index];
    if (!isObj(def)) return;
    nodeName.set(index, typeof def['name'] === 'string' && def['name'] !== '' ? unique(def['name']) : '');
    const cam = def['camera'];
    if (typeof cam === 'number' && !namedCameras.has(cam)) {
      namedCameras.add(cam);
      const c = cameras[cam];
      if (isObj(c) && typeof c['name'] === 'string' && c['name'] !== '') unique(c['name']);
    }
    const lx = isObj(def['extensions']) ? (def['extensions'] as Json)['KHR_lights_punctual'] : undefined;
    if (isObj(lx) && typeof lx['light'] === 'number' && !namedLights.has(lx['light'])) {
      const li = lx['light'];
      namedLights.add(li);
      const l = lights[li];
      unique(isObj(l) && typeof l['name'] === 'string' && l['name'] !== '' ? l['name'] : `light_${li}`);
    }
    const kids = Array.isArray(def['children']) ? (def['children'] as unknown[]) : [];
    for (const k of kids) if (typeof k === 'number') reserve(k, depth + 1);
  };
  for (const sc of scenes) {
    if (!isObj(sc)) continue;
    if (typeof sc['name'] === 'string' && sc['name'] !== '') unique(sc['name']);
    for (const n of Array.isArray(sc['nodes']) ? (sc['nodes'] as unknown[]) : []) if (typeof n === 'number') reserve(n, 0);
  }

  // The default scene's hierarchy, depth-first.
  const sceneIndex = typeof json['scene'] === 'number' ? json['scene'] : 0;
  const scene = scenes[sceneIndex];
  const nodes: ModelRigNode[] = [];
  const rigIndex = new Map<number, number>();
  const visit = (index: number, parent: number, depth: number): void => {
    if (depth > 256 || rigIndex.has(index) || nodes.length >= MODEL_RIG_LIMITS.nodes) return;
    const def = nodesDef[index];
    if (!isObj(def)) return;
    let t: [number, number, number] = [0, 0, 0];
    let r: [number, number, number, number] = [0, 0, 0, 1];
    let s: [number, number, number] = [1, 1, 1];
    const nums = (v: unknown, n: number): number[] | null => (Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as number[]) : null);
    const m = nums(def['matrix'], 16);
    if (m !== null) {
      const d = decompose(m);
      t = d.t;
      r = d.r;
      s = d.s;
    } else {
      const tt = nums(def['translation'], 3);
      const rr = nums(def['rotation'], 4);
      const ss = nums(def['scale'], 3);
      if (tt !== null) t = [tt[0]!, tt[1]!, tt[2]!];
      if (rr !== null) r = [rr[0]!, rr[1]!, rr[2]!, rr[3]!];
      if (ss !== null) s = [ss[0]!, ss[1]!, ss[2]!];
    }
    const at = nodes.length;
    rigIndex.set(index, at);
    nodes.push({ name: nodeName.get(index) ?? '', parent, t, r, s });
    const kids = Array.isArray(def['children']) ? (def['children'] as unknown[]) : [];
    for (const k of kids) if (typeof k === 'number') visit(k, at, depth + 1);
  };
  if (isObj(scene)) for (const n of Array.isArray(scene['nodes']) ? (scene['nodes'] as unknown[]) : []) if (typeof n === 'number') visit(n, -1, 0);

  // Clips (node channels only), within the key budget.
  const animations = Array.isArray(json['animations']) ? (json['animations'] as unknown[]) : [];
  const clips: ModelRigClip[] = [];
  let keyNumbers = 0;
  let truncated = false;
  for (let ai = 0; ai < animations.length && clips.length < MODEL_RIG_LIMITS.clips; ai += 1) {
    const anim = animations[ai];
    if (!isObj(anim)) continue;
    const samplers = Array.isArray(anim['samplers']) ? (anim['samplers'] as unknown[]) : [];
    const channels: ModelRigChannel[] = [];
    let duration = 0;
    let clipNumbers = 0;
    for (const ch of Array.isArray(anim['channels']) ? (anim['channels'] as unknown[]) : []) {
      if (!isObj(ch) || !isObj(ch['target'])) continue;
      const target = ch['target'] as Json;
      const p = PATHS[String(target['path'])];
      const nodeIndex = target['node'];
      if (p === undefined || typeof nodeIndex !== 'number' || !rigIndex.has(nodeIndex)) continue;
      const sampler = samplers[ch['sampler'] as number];
      if (!isObj(sampler)) continue;
      const interp = sampler['interpolation'] === 'STEP' || sampler['interpolation'] === 'CUBICSPLINE' ? (sampler['interpolation'] as RigInterpolation) : 'LINEAR';
      const input = readAccessor(json, bin, sampler['input']);
      const output = readAccessor(json, bin, sampler['output']);
      if (input === null || output === null || input.size !== 1 || output.size !== p.size || input.data.length === 0) continue;
      const perKey = p.size * (interp === 'CUBICSPLINE' ? 3 : 1);
      if (output.data.length !== input.data.length * perKey) continue;
      const name = nodeName.get(nodeIndex) ?? '';
      channels.push({ node: name !== '' ? name : `#${rigIndex.get(nodeIndex)!}`, path: p.path, interpolation: interp, times: input.data, values: output.data });
      duration = Math.max(duration, input.data[input.data.length - 1]!);
      clipNumbers += input.data.length + output.data.length;
    }
    if (keyNumbers + clipNumbers > keyBudget) {
      truncated = true;
      continue;
    }
    keyNumbers += clipNumbers;
    clips.push({ assetId, name: typeof anim['name'] === 'string' && anim['name'] !== '' ? anim['name'] : `animation_${ai}`, duration, channels });
  }
  return { ok: true, rig: { nodes, clips, ...(truncated ? { truncated: true as const } : {}) }, keyNumbers };
}

/** The addressable node names of a rig, in order (unnamed nodes left out). */
export function rigNodeNames(rig: ModelRig): string[] {
  return rig.nodes.map((n) => n.name).filter((n) => n !== '');
}

/** A shape check of rig data (a manifest or snapshot carries it); null when it is well-formed. */
export function validateModelRig(v: unknown): string | null {
  if (!isObj(v)) return 'a rig is { nodes, clips }';
  const nodes = v['nodes'];
  const clips = v['clips'];
  if (!Array.isArray(nodes) || nodes.length > MODEL_RIG_LIMITS.nodes) return `rig nodes must be a list of at most ${MODEL_RIG_LIMITS.nodes}`;
  const fin = (x: unknown, n: number): boolean => Array.isArray(x) && x.length === n && x.every((y) => typeof y === 'number' && Number.isFinite(y));
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    if (!isObj(n) || typeof n['name'] !== 'string' || typeof n['parent'] !== 'number' || !Number.isInteger(n['parent']) || n['parent'] < -1 || n['parent'] >= i || !fin(n['t'], 3) || !fin(n['r'], 4) || !fin(n['s'], 3)) {
      return `rig node ${i} must be { name, parent (an earlier index or -1), t [3], r [4], s [3] }`;
    }
  }
  if (!Array.isArray(clips) || clips.length > MODEL_RIG_LIMITS.clips * 4) return 'rig clips must be a list';
  for (let i = 0; i < clips.length; i += 1) {
    const c = clips[i];
    if (!isObj(c) || typeof c['assetId'] !== 'string' || typeof c['name'] !== 'string' || typeof c['duration'] !== 'number' || !Number.isFinite(c['duration']) || !Array.isArray(c['channels'])) {
      return `rig clip ${i} must be { assetId, name, duration, channels }`;
    }
    for (const ch of c['channels'] as unknown[]) {
      if (!isObj(ch) || typeof ch['node'] !== 'string' || PATHS[String(ch['path'])] === undefined || !['LINEAR', 'STEP', 'CUBICSPLINE'].includes(String(ch['interpolation']))) {
        return `rig clip ${i} has a channel that is not { node, path, interpolation, times, values }`;
      }
      const times = ch['times'];
      const values = ch['values'];
      if (!Array.isArray(times) || !Array.isArray(values) || times.length === 0) return `rig clip ${i} has a channel without keys`;
      const per = PATHS[String(ch['path'])]!.size * (ch['interpolation'] === 'CUBICSPLINE' ? 3 : 1);
      if (values.length !== times.length * per) return `rig clip ${i} has a channel whose values do not match its keys`;
      if (!times.every((x) => typeof x === 'number' && Number.isFinite(x)) || !values.every((x) => typeof x === 'number' && Number.isFinite(x))) return `rig clip ${i} has a non-finite key`;
    }
  }
  if (v['truncated'] !== undefined && v['truncated'] !== true) return 'truncated is true or absent';
  return null;
}
