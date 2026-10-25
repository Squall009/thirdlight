/**
 * The descriptor of the `foliageBend` component (its own file, beside the
 * format in `foliage-bend.ts`). The registry (`descriptors.ts`) lists it with
 * every other component.
 *
 * Pure data.
 */
import { num, obj } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import { FOLIAGE_BEND_DEFAULTS, FOLIAGE_BEND_LIMITS } from './foliage-bend';

const L = FOLIAGE_BEND_LIMITS;

export const foliageBend: ComponentDescriptor = {
  name: 'foliageBend',
  label: 'Foliage bend',
  tooltip: 'How this object parts grass and other foliage while it is a view subject (the camera\'s target, or one a script names with ctx.camera.setSeeThrough({subjects})). Without it a subject still parts foliage with the defaults.',
  category: 'Rendering',
  value: obj('foliageBend', 'Foliage bend', 'Radius, strength and recovery of the push (empty: the defaults).', [
    num('radius', 'Radius', `Metres round the body foliage gives way within (absent: the body's radius plus ${FOLIAGE_BEND_DEFAULTS.margin} m).`, { min: L.radius.min, max: L.radius.max, step: 0.05, unit: 'm' }),
    num('strength', 'Strength', 'How far foliage lies down at the body: 1 bends a plant\'s tip by its own height; 0 parts nothing.', { min: L.strength.min, max: L.strength.max, step: 0.05, default: FOLIAGE_BEND_DEFAULTS.strength }),
    num('recovery', 'Recovery', 'Seconds the pressed path takes to stand up again behind the object.', { min: L.recovery.min, max: L.recovery.max, step: 0.1, unit: 's', default: FOLIAGE_BEND_DEFAULTS.recovery }),
  ]),
  add: { kind: 'menu', value: { strength: FOLIAGE_BEND_DEFAULTS.strength } },
  handles: [],
  excludes: [],
  prefab: true,
  rules: ['Only subjects bend foliage: the camera\'s target, or the objects a script names (at most four per view, the nearest kept).', 'A scatter or cover rule\'s bendAway scales how readily its plants give way.'],
};
