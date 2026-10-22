/**
 * GLB inspection step 13 (animations) and the animated-model profile (stages 3–6, checks
 * A1–A6) a caller may request.
 *
 * One step per function over the shared `GlbState`; `inspect.ts` runs them in the
 * profile order and stops at the first that reports.
 */

import type { AssetMetrics } from '@thirdlight/project-model';
import { ANIMATION_PATHS, ANIMATION_OUTPUT_TYPES, INTERPOLATIONS } from './gltf-rules';
import {
  ANIMATION_PROFILE_MAX_CLIPS,
  ANIMATION_PROFILE_MAX_CLIP_MS,
  ANIMATION_PROFILE_MAX_TRACKS,
  ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP,
  ANIMATION_PROFILE_MAX_TRACK_TIMES,
  ANIMATION_ROLE_KEYS,
} from './limits';
import type { ImportDiagnostic } from './types';
import { isPlainObject, asIndex, diag, ptr, type GlbState, type ResolvedAnimation } from './inspect-glb-state';
import { checkExtensionObject } from './inspect-glb-container';

export function checkAnimations(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const raw = glb.json['animations'];
  if (raw !== undefined && !Array.isArray(raw)) {
    return [
      diag('asset_animation_invalid', ptr('animations'), 'animations must be an array', {
        found: typeof raw,
        expected: 'an array',
      }),
    ];
  }
  const animations = Array.isArray(raw) ? raw : [];
  const nodeCount = glb.collection('nodes').length;
  let longestMs = 0;
  for (let i = 0; i < animations.length; i++) {
    const animation = animations[i];
    const path = ptr('animations', i);
    if (!isPlainObject(animation)) {
      out.push(
        diag('asset_animation_invalid', path, 'animation must be an object', { found: typeof animation, expected: 'an object' }),
      );
      continue;
    }
    checkExtensionObject(glb, animation, path, out, 'animation');
    const samplersRaw = animation['samplers'];
    const channelsRaw = animation['channels'];
    if (!Array.isArray(samplersRaw) || !Array.isArray(channelsRaw)) {
      out.push(
        diag('asset_animation_invalid', path, 'animation must carry samplers and channels arrays', {
          found: { samplers: typeof samplersRaw, channels: typeof channelsRaw },
          expected: 'samplers[] and channels[]',
        }),
      );
      continue;
    }
    // Samplers: resolve accessors, read the input times, check strict order.
    const samplerInputs: { min: number; max: number }[] = [];
    let samplerError = false;
    for (let s = 0; s < samplersRaw.length; s++) {
      const sampler = samplersRaw[s];
      const spath = `${path}/samplers/${s}`;
      if (!isPlainObject(sampler)) {
        out.push(
          diag('asset_animation_invalid', spath, 'animation sampler must be an object', { found: typeof sampler, expected: 'an object' }),
        );
        samplerError = true;
        continue;
      }
      const interpolation = sampler['interpolation'] ?? 'LINEAR';
      if (typeof interpolation !== 'string' || !INTERPOLATIONS.has(interpolation)) {
        out.push(
          diag('asset_animation_invalid', `${spath}/interpolation`, 'interpolation must be LINEAR, STEP or CUBICSPLINE', {
            found: interpolation,
            expected: 'LINEAR | STEP | CUBICSPLINE',
          }),
        );
        samplerError = true;
      }
      const inputIndex = asIndex(sampler['input']);
      const outputIndex = asIndex(sampler['output']);
      const input = inputIndex === null ? undefined : glb.accessors[inputIndex];
      const output = outputIndex === null ? undefined : glb.accessors[outputIndex];
      if (input === undefined || input.type !== 'SCALAR' || input.componentType !== 5126) {
        out.push(
          diag('asset_animation_invalid', `${spath}/input`, 'animation input must be a SCALAR FLOAT accessor', {
            found: input === undefined ? sampler['input'] : { type: input.type, componentType: input.componentType },
            expected: 'SCALAR FLOAT (5126)',
          }),
        );
        samplerError = true;
        continue;
      }
      if (output === undefined) {
        out.push(
          diag('asset_animation_invalid', `${spath}/output`, 'animation output must reference an existing accessor', {
            found: sampler['output'],
            expected: `0 .. ${glb.accessors.length - 1}`,
          }),
        );
        samplerError = true;
        continue;
      }
      const times = readFloats(glb, inputIndex as number);
      let previous = -Infinity;
      let min = Infinity;
      let max = -Infinity;
      let orderError = false;
      for (const t of times) {
        if (!Number.isFinite(t) || t <= previous) {
          orderError = true;
          break;
        }
        previous = t;
        if (t < min) min = t;
        if (t > max) max = t;
      }
      if (orderError || times.length === 0) {
        out.push(
          diag('asset_animation_invalid', `${spath}/input`, 'animation input times must be finite and strictly increasing', {
            found: times.length === 0 ? 'empty' : 'not strictly increasing',
            expected: 'strictly increasing finite floats',
          }),
        );
        samplerError = true;
        continue;
      }
      samplerInputs.push({ min, max });
    }
    if (samplerError) continue;

    let channelError = false;
    for (let c = 0; c < channelsRaw.length; c++) {
      const channel = channelsRaw[c];
      const cpath = `${path}/channels/${c}`;
      if (!isPlainObject(channel)) {
        out.push(
          diag('asset_animation_invalid', cpath, 'animation channel must be an object', { found: typeof channel, expected: 'an object' }),
        );
        channelError = true;
        continue;
      }
      const samplerIndex = asIndex(channel['sampler']);
      const target = channel['target'];
      if (samplerIndex === null || samplerIndex >= samplersRaw.length) {
        out.push(
          diag('asset_animation_invalid', `${cpath}/sampler`, 'channel sampler must resolve to an existing sampler', {
            found: channel['sampler'],
            expected: `0 .. ${samplersRaw.length - 1}`,
          }),
        );
        channelError = true;
        continue;
      }
      if (!isPlainObject(target)) {
        out.push(
          diag('asset_animation_invalid', `${cpath}/target`, 'channel target must be an object', { found: typeof target, expected: 'an object' }),
        );
        channelError = true;
        continue;
      }
      const targetExt = target['extensions'];
      if (targetExt !== undefined) {
        const names = isPlainObject(targetExt) ? Object.keys(targetExt) : [];
        out.push(
          diag(
            names.includes('KHR_animation_pointer') ? 'asset_animation_invalid' : 'asset_extension_unsupported',
            `${cpath}/target/extensions`,
            names.includes('KHR_animation_pointer')
              ? 'KHR_animation_pointer is not in the M2 profile'
              : 'channel target extensions are not in the M2 profile',
            { found: names, expected: 'no target extensions' },
          ),
        );
        channelError = true;
        continue;
      }
      const nodeIndex = asIndex(target['node']);
      if (nodeIndex === null || nodeIndex >= nodeCount) {
        out.push(
          diag('asset_animation_invalid', `${cpath}/target/node`, 'channel target node must exist', {
            found: target['node'],
            expected: `0 .. ${nodeCount - 1}`,
          }),
        );
        channelError = true;
        continue;
      }
      const targetPath = target['path'];
      if (typeof targetPath !== 'string' || !ANIMATION_PATHS.has(targetPath)) {
        out.push(
          diag('asset_animation_invalid', `${cpath}/target/path`, 'channel target path must be translation, rotation, scale or weights', {
            found: targetPath,
            expected: 'translation | rotation | scale | weights',
          }),
        );
        channelError = true;
        continue;
      }
      const sampler = samplersRaw[samplerIndex];
      if (!isPlainObject(sampler)) {
        channelError = true;
        continue;
      }
      const outputIndex = asIndex(sampler['output']);
      const output = outputIndex === null ? undefined : glb.accessors[outputIndex];
      const expectedType = ANIMATION_OUTPUT_TYPES[targetPath] as string;
      if (output === undefined || output.type !== expectedType) {
        out.push(
          diag('asset_animation_invalid', `${path}/samplers/${samplerIndex}/output`, 'animation output type must match the channel path', {
            found: output === undefined ? sampler['output'] : output.type,
            expected: expectedType,
          }),
        );
        channelError = true;
      }
    }
    if (channelError) continue;

    if (samplerInputs.length > 0) {
      let min = Infinity;
      let max = -Infinity;
      for (const s of samplerInputs) {
        if (s.min < min) min = s.min;
        if (s.max > max) max = s.max;
      }
      const ms = Math.round((max - min) * 1000);
      if (ms > longestMs) longestMs = ms;
    }
  }
  if (out.length > 0) return out;
  glb.clipDurationMs = longestMs;
  return null;
}

/**
 * The animated-model profile's stages 3–6 and checks A1–A6, in the contract
 * order, against this proposal's real clip list. Only reached when the
 * caller requested the animated profile (`options.animation`).
 */
export function checkAnimationProfile(glb: GlbState, metrics: AssetMetrics): ImportDiagnostic[] | null {
  const request = glb.animation;
  if (request === null) return null;
  const roles = request.roles;
  const clips = metrics.animations;
  const names = clipNames(glb);

  // stage 3 — range (pure: decidable from the version's clip count).
  for (const role of ANIMATION_ROLE_KEYS) {
    const binding = roles[role];
    if (binding.clipIndex >= clips) {
      return [
        diag('animation_role_out_of_range', `/roles/${role}/clipIndex`, `role "${role}" clipIndex must be below the version's clip count`, {
          found: binding.clipIndex,
          expected: `0 .. ${clips - 1}`,
          role,
          clipIndex: binding.clipIndex,
          clips,
        }),
      ];
    }
  }

  // stage 4 — duplicates (pure).
  const seen = new Map<number, string>();
  for (const role of ANIMATION_ROLE_KEYS) {
    const index = roles[role].clipIndex;
    const previous = seen.get(index);
    if (previous !== undefined) {
      return [
        diag('animation_role_duplicate', '/roles', 'two roles must not share a clipIndex', {
          found: index,
          expected: 'three distinct clip indices',
          clipIndex: index,
          roles: [previous, role],
        }),
      ];
    }
    seen.set(index, role);
  }

  // stage 5 — name agreement against the real clip list.
  for (const role of ANIMATION_ROLE_KEYS) {
    const binding = roles[role];
    const real = names[binding.clipIndex] as string;
    if (real !== binding.clipName) {
      return [
        diag('animation_role_mismatch', `/roles/${role}/clipName`, `role "${role}" clipName must equal the clip's real name`, {
          found: binding.clipName,
          expected: real,
          role,
        }),
      ];
    }
  }

  // stage 6 — ambiguity.
  for (const role of ANIMATION_ROLE_KEYS) {
    const binding = roles[role];
    let matches = 0;
    for (const name of names) if (name === binding.clipName) matches += 1;
    if (matches > 1) {
      return [
        diag('animation_role_ambiguous', `/roles/${role}/clipName`, 'the clip list must contain exactly one clip with this name', {
          found: binding.clipName,
          expected: 'exactly one clip with this name',
          role,
          matches,
        }),
      ];
    }
  }

  return checkAnimatedGlbProfile(glb, roles);
}

/** The animated GLB profile checks A1–A6, in the stated order (fail-fast per check). */
function checkAnimatedGlbProfile(
  glb: GlbState,
  roles: ResolvedAnimation['roles'],
): ImportDiagnostic[] | null {
  const animations = glb.collection('animations');

  // A1 — clip count.
  if (animations.length < 1 || animations.length > ANIMATION_PROFILE_MAX_CLIPS) {
    return [
      diag('asset_limits_exceeded', ptr('animations'), `the animated profile allows 1-${ANIMATION_PROFILE_MAX_CLIPS} clips`, {
        found: animations.length,
        expected: `1 .. ${ANIMATION_PROFILE_MAX_CLIPS}`,
        limit: 'animation_clips',
      }),
    ];
  }

  // A2 — no skeletal animation (no `skins`, no JOINTS_0/WEIGHTS_0).
  const skins = glb.collection('skins').length;
  if (skins > 0) {
    return [
      diag('animation_skin_unsupported', ptr('skins'), 'the animated profile has no skeletal animation', {
        found: skins,
        expected: 'no skins array',
      }),
    ];
  }
  const jointAttribute = findJointAttributePath(glb);
  if (jointAttribute !== null) {
    return [
      diag('animation_skin_unsupported', jointAttribute, 'the animated profile has no JOINTS_0/WEIGHTS_0 attributes', {
        found: jointAttribute.slice(jointAttribute.lastIndexOf('/') + 1),
        expected: 'no skinning attributes',
      }),
    ];
  }

  // A3 — channels total and per clip.
  let totalChannels = 0;
  let maxChannelsPerClip = 0;
  let totalKeyframes = 0;
  for (const animation of animations) {
    if (!isPlainObject(animation)) continue;
    const channels = Array.isArray(animation['channels']) ? animation['channels'] : [];
    totalChannels += channels.length;
    if (channels.length > maxChannelsPerClip) maxChannelsPerClip = channels.length;
    // A4 — summed sampler `input` keyframe count over all clips.
    const samplers = Array.isArray(animation['samplers']) ? animation['samplers'] : [];
    for (const sampler of samplers) {
      if (!isPlainObject(sampler)) continue;
      const inputIndex = asIndex(sampler['input']);
      const input = inputIndex === null ? undefined : glb.accessors[inputIndex];
      if (input !== undefined) totalKeyframes += input.count;
    }
  }
  if (
    totalChannels > ANIMATION_PROFILE_MAX_TRACKS ||
    maxChannelsPerClip > ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP
  ) {
    return [
      diag('asset_limits_exceeded', ptr('animations'), 'animation channels exceed the animated profile', {
        found: { channels: totalChannels, maxChannelsPerClip },
        expected: `<= ${ANIMATION_PROFILE_MAX_TRACKS} total, <= ${ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP} per clip`,
        limit: 'animation_tracks',
      }),
    ];
  }

  // A4 — keyframes.
  if (totalKeyframes > ANIMATION_PROFILE_MAX_TRACK_TIMES) {
    return [
      diag('asset_limits_exceeded', ptr('animations'), 'sampler input keyframes exceed the animated profile', {
        found: totalKeyframes,
        expected: `<= ${ANIMATION_PROFILE_MAX_TRACK_TIMES}`,
        limit: 'animation_track_times',
      }),
    ];
  }

  // A5 — longest clip duration (`metrics.clipDurationMs` covers it).
  if (glb.clipDurationMs > ANIMATION_PROFILE_MAX_CLIP_MS) {
    return [
      diag('asset_limits_exceeded', ptr('animations'), 'clip duration exceeds the animated profile', {
        found: glb.clipDurationMs,
        expected: `<= ${ANIMATION_PROFILE_MAX_CLIP_MS}`,
        limit: 'animation_clip_duration',
      }),
    ];
  }

  // A6 — no translation channel on a scene root node.
  return checkRootMotion(glb, roles);
}

function clipNames(glb: GlbState): string[] {
  return glb.collection('animations').map((animation) =>
    isPlainObject(animation) && typeof animation['name'] === 'string' ? animation['name'] : '',
  );
}

/** The default scene's root node indices (the holder's own nodes, A6). */
function rootNodeIndices(glb: GlbState): Set<number> {
  const scenes = glb.collection('scenes');
  const index = asIndex(glb.json['scene']);
  const scene = index !== null && index < scenes.length ? scenes[index] : scenes[0];
  const out = new Set<number>();
  if (isPlainObject(scene) && Array.isArray(scene['nodes'])) {
    for (const value of scene['nodes']) {
      const node = asIndex(value);
      if (node !== null) out.add(node);
    }
  }
  return out;
}

/** The first `JOINTS_0`/`WEIGHTS_0` attribute path, or `null`. */
function findJointAttributePath(glb: GlbState): string | null {
  const meshes = glb.collection('meshes');
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    if (!isPlainObject(mesh) || !Array.isArray(mesh['primitives'])) continue;
    const primitives = mesh['primitives'];
    for (let j = 0; j < primitives.length; j++) {
      const primitive = primitives[j];
      if (!isPlainObject(primitive)) continue;
      const attributes = primitive['attributes'];
      if (!isPlainObject(attributes)) continue;
      for (const name of ['JOINTS_0', 'WEIGHTS_0']) {
        if (Object.prototype.hasOwnProperty.call(attributes, name)) {
          return `${ptr('meshes', i, 'primitives', j, 'attributes')}/${name}`;
        }
      }
    }
  }
  return null;
}

/** A6: every offending root-translation channel, in clip/channel order. */
function checkRootMotion(glb: GlbState, roles: ResolvedAnimation['roles']): ImportDiagnostic[] | null {
  const rootNodes = rootNodeIndices(glb);
  if (rootNodes.size === 0) return null;
  const animations = glb.collection('animations');
  const nodes = glb.collection('nodes');
  const out: ImportDiagnostic[] = [];
  for (let i = 0; i < animations.length; i++) {
    const animation = animations[i];
    if (!isPlainObject(animation) || !Array.isArray(animation['channels'])) continue;
    const channels = animation['channels'];
    for (let c = 0; c < channels.length; c++) {
      const channel = channels[c];
      if (!isPlainObject(channel)) continue;
      const target = channel['target'];
      if (!isPlainObject(target) || target['path'] !== 'translation') continue;
      const nodeIndex = asIndex(target['node']);
      if (nodeIndex === null || !rootNodes.has(nodeIndex)) continue;
      const node = nodes[nodeIndex];
      const nodeName = isPlainObject(node) && typeof node['name'] === 'string' ? node['name'] : '';
      const role = ANIMATION_ROLE_KEYS.find((key) => roles[key].clipIndex === i);
      out.push(
        diag(
          'animation_root_motion',
          `${ptr('animations', i, 'channels', c, 'target')}/path`,
          'a channel must not animate a scene root node translation (root motion)',
          {
            found: nodeIndex,
            expected: 'no translation channel on a scene root node',
            ...(role === undefined ? {} : { role }),
            nodeIndex,
            nodeName,
          },
        ),
      );
    }
  }
  return out.length > 0 ? out : null;
}

/** Read an accessor's little-endian float32 values from the embedded BIN chunk. */
function readFloats(glb: GlbState, index: number): number[] {
  const info = glb.accessors[index];
  const accessor = glb.collection('accessors')[index];
  if (info === undefined || !isPlainObject(accessor)) return [];
  const bufferViewIndex = asIndex(accessor['bufferView']);
  const bv = bufferViewIndex === null ? undefined : glb.bufferViews[bufferViewIndex];
  if (bv === undefined) return [];
  const byteOffset = typeof accessor['byteOffset'] === 'number' ? accessor['byteOffset'] : 0;
  const view = new DataView(bv.data.buffer, bv.data.byteOffset, bv.data.byteLength);
  const out: number[] = [];
  for (let i = 0; i < info.count; i++) out.push(view.getFloat32(byteOffset + i * 4, true));
  return out;
}
