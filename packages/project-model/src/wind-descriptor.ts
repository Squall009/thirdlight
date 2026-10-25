/**
 * The descriptor of the `windZone` component (its own file, beside the
 * format in `wind.ts`). The registry (`descriptors.ts`) lists it with every
 * other component.
 *
 * Pure data.
 */
import { enm, int, num, obj, vec2, vec3, when } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import { WIND_DEFAULTS, WIND_LIMITS, WIND_ZONE_SHAPES } from './wind';

const L = WIND_LIMITS;

// A new zone: a 20 m box, as large as a clearing, blending in over its default edge and changing nothing yet.
const WIND_ZONE_NEW = { shape: 'box', size: [...WIND_DEFAULTS.zoneSize] };

export const windZone: ComponentDescriptor = {
  name: 'windZone',
  label: 'Wind zone',
  tooltip: 'A box or sphere where the wind differs from the scene\'s: any value it sets replaces the wind around it, fading in over its blend distance inside the edge. Read from above (its height is ignored).',
  category: 'Rendering',
  value: obj('windZone', 'Wind zone', 'The zone\'s shape and the wind values it sets (empty: the wind around it).', [
    enm('shape', 'Shape', 'A box (turns with the object about up) or a sphere (its footprint, a circle).', WIND_ZONE_SHAPES, { required: true, default: 'box' }),
    vec3('size', 'Size', 'Width, height and depth (the object\'s scale applies).', { min: 0, minExclusive: true, max: L.zoneSizeMax, step: 0.5, unit: 'm', default: [...WIND_DEFAULTS.zoneSize], labels: ['w', 'h', 'd'], handle: 'box3', when: when('shape', 'box') }),
    num('radius', 'Radius', 'The sphere\'s radius (the object\'s largest scale applies).', { min: 0, minExclusive: true, max: L.zoneSizeMax, step: 0.5, unit: 'm', default: WIND_DEFAULTS.zoneRadius, handle: 'radius', when: when('shape', 'sphere') }),
    num('blend', 'Blend', 'Metres inside the edge over which the zone fades in from the wind around it (0: a hard edge, as sharp as the wind map\'s texels).', { min: 0, max: L.blendMax, step: 0.5, unit: 'm', default: WIND_DEFAULTS.zoneBlend }),
    int('priority', 'Priority', 'Where zones overlap, the higher priority is laid over the lower.', { min: L.priorityMin, max: L.priorityMax, default: WIND_DEFAULTS.zonePriority, omitDefault: true }),
    vec2('direction', 'Direction', 'Horizontal direction [x, z] (not both 0).', { min: -1, max: 1, step: 0.05, nonZero: true, labels: ['x', 'z'] }),
    num('strength', 'Strength', 'Base strength (0: still air).', { min: 0, max: L.strengthMax, step: 0.05 }),
    num('gust', 'Gusts', 'Extra strength the gust pattern adds at its peaks.', { min: 0, max: L.gustMax, step: 0.05 }),
    num('turbulence', 'Turbulence', 'Small-scale variation over space.', { min: 0, max: 1, step: 0.05 }),
    num('speed', 'Gust speed', 'Metres per second the gust pattern travels.', { min: 0, max: L.speedMax, step: 0.5, unit: 'm/s' }),
    num('scale', 'Gust size', 'Metres the gust pattern spans before it repeats.', { min: L.scaleMin, max: L.scaleMax, step: 0.5, unit: 'm' }),
  ]),
  add: { kind: 'menu', value: WIND_ZONE_NEW },
  create: [{ label: 'Wind zone', menu: 'Light' }],
  handles: [
    { kind: 'box3', label: 'Size', bind: { size: 'size' }, space: 'local', when: when('shape', 'box') },
    { kind: 'radius', label: 'Radius', bind: { radius: 'radius' }, space: 'local', when: when('shape', 'sphere') },
  ],
  excludes: [],
  prefab: true,
  rules: ['Zones are read from above: a box turns with its object about up; a sphere is its circle on the ground.', 'Direction, gust speed and gust size are the pattern\'s; the noise texture and its second layer are the scene\'s only.'],
};
