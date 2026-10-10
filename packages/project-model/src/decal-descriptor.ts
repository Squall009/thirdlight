/**
 * The descriptor of the `decal` component and of the `decalLayers` field
 * every drawn object carries (their own file, beside the format in
 * `decals.ts`). The registry (`descriptors.ts`) lists the component with
 * every other one.
 *
 * Pure data.
 */
import { decalLayerMask, enm, int, num, obj, ref, vec2, vec3 } from './descriptor-builders';
import type { ComponentDescriptor, IntFieldDescriptor } from './descriptor-types';
import { DECAL_CHANNELS, DECAL_DEFAULTS, DECAL_LIMITS, DECAL_MODES } from './decals';

const L = DECAL_LIMITS;
const D = DECAL_DEFAULTS;

/** What each channel's opacity changes (the Inspector's tooltips). */
const CHANNEL_TIPS: Readonly<Record<(typeof DECAL_CHANNELS)[number], string>> = {
  albedo: 'How much of its colour covers the surface\'s.',
  normal: 'How much of its normal map bends the surface\'s (cracks, seams).',
  roughness: 'How much of its roughness replaces the surface\'s (a wet patch: roughness only).',
  metalness: 'How much of its metalness replaces the surface\'s.',
  occlusion: 'How much of its occlusion darkens the surface\'s indirect light.',
  emission: 'How much of its glow is added to the surface.',
};

/**
 * A drawn object's `decalLayers`: absent, every layer, so a level takes decals without setting anything. A
 * skinned model's absent mask is none, so that field stores every layer when the Inspector sets it back.
 */
export function decalLayersField(skinnable: boolean): IntFieldDescriptor {
  const absent = skinnable ? 'every layer, none for a skinned model: a projector fixed in the world slides over a moving skin' : 'every layer';
  return decalLayerMask('decalLayers', 'Decal layers', `The decal layers projected decals mark it in: a decal marks it when their layers share one (none: no projected decal marks it). Absent: ${absent}.`, 0, skinnable ? {} : { omitDefault: true });
}

// A new decal: a metre-wide mark projected along the object's −Z (turn the object to face the surface).
const DECAL_NEW = { size: [...D.size] };

export const decal: ComponentDescriptor = {
  name: 'decal',
  label: 'Decal',
  tooltip: 'A box that marks the surfaces inside it with a decal material (dirt, cracks, stains, signs), projected along the object\'s −Z.',
  category: 'Rendering',
  value: obj('decal', 'Decal', 'A projector box centred on the object; its image lies in the object\'s XY plane, +Y up, and it projects along −Z.', [
    vec3('size', 'Size', 'Width and height of the mark, and depth of the box it reaches through (metres; the object\'s scale applies).', { required: true, min: 0, minExclusive: true, max: L.sizeMax, step: 0.05, unit: 'm', default: [...D.size], labels: ['w', 'h', 'd'], handle: 'box3' }),
    enm('mode', 'Mode', 'Projected: the surfaces under it blend it in channel by channel before they are lit. Clipped: a mesh cut from the surfaces under it at load, drawn as a mesh decal (its material\'s blend).', DECAL_MODES, { default: D.mode, omitDefault: true }),
    ref('material', 'Material', 'A decal material: its textures (or a trim sheet\'s decal cell) and its blend.', 'material', { required: true }),
    obj('opacity', 'Channel opacity', 'Projected decals: how much of each surface channel it changes (empty: all of it). Mesh and clipped decals blend their lit colour instead.', DECAL_CHANNELS.map((c) => num(c, c.charAt(0).toUpperCase() + c.slice(1), CHANNEL_TIPS[c], { min: 0, max: 1, step: 0.05, default: 1 }))),
    num('normalFade', 'Normal fade', 'Surfaces turned further than this from facing the projector take no mark; it fades out over the last fifth of the angle (180: back faces too).', { min: L.normalFadeMin, max: L.normalFadeMax, step: 1, unit: 'deg', default: D.normalFade }),
    vec2('edgeFade', 'Edge fade', 'The share of the box depth it fades over near its front and back ends, so a mark ends softly where a surface leaves the box.', { min: 0, max: 1, step: 0.05, default: [...D.edgeFade], labels: ['front', 'back'] }),
    num('fadeDistance', 'Fade distance', 'Metres from the camera where it has faded out, over the last fifth (empty: never).', { min: 0, minExclusive: true, max: L.fadeDistanceMax, step: 1, unit: 'm' }),
    int('sortOrder', 'Sort order', 'Where decals overlap, the higher order is drawn over the lower.', { min: L.sortOrderMin, max: L.sortOrderMax, default: D.sortOrder, omitDefault: true }),
    decalLayerMask('layers', 'Layers', 'The decal layers it marks: only objects whose decal layers share one take it.', 1, { omitDefault: true }),
  ]),
  add: { kind: 'pick', value: DECAL_NEW, pick: ['material'] },
  handles: [{ kind: 'box3', label: 'Size', bind: { size: 'size' }, space: 'local', follows: 'transform' }],
  excludes: [],
  prefab: false,
};
