/**
 * The descriptor of the `interactor` component (its own file, beside the
 * format in `interactor.ts`). The registry (`descriptors.ts`) lists it with
 * every other component.
 *
 * Pure data.
 */
import { num, obj } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import { INTERACTOR_DEFAULTS, INTERACTOR_LIMITS } from './interactor';

const L = INTERACTOR_LIMITS;

export const interactor: ComponentDescriptor = {
  name: 'interactor',
  label: 'Interactor',
  tooltip: 'Presses into what this object moves through: foliage bends away round it and stands up again behind it, for any number of objects. The camera\'s target (or objects a script names with ctx.camera.setSeeThrough({subjects})) presses with the defaults without it.',
  category: 'Rendering',
  value: obj('interactor', 'Interactor', 'Radius, strength and recovery of the press (empty: the defaults).', [
    num('radius', 'Radius', `Metres round the body it presses within (absent: the body's radius plus ${INTERACTOR_DEFAULTS.margin} m).`, { min: L.radius.min, max: L.radius.max, step: 0.05, unit: 'm' }),
    num('strength', 'Strength', 'How far foliage lies down at the body: 1 bends a plant\'s tip by its own height; 0 presses nothing.', { min: L.strength.min, max: L.strength.max, step: 0.05, default: INTERACTOR_DEFAULTS.strength }),
    num('recovery', 'Recovery', 'Seconds what it pressed takes to stand up again behind the object.', { min: L.recovery.min, max: L.recovery.max, step: 0.1, unit: 's', default: INTERACTOR_DEFAULTS.recovery }),
  ]),
  add: { kind: 'menu', value: { strength: INTERACTOR_DEFAULTS.strength } },
  handles: [],
  excludes: [],
  prefab: true,
  rules: ['Every object with it presses; the camera\'s target and scripted subjects press with the defaults.', 'Drawn in a 64 m square round the camera on WebGPU (none on WebGL 2).', 'A scatter or cover rule\'s bendAway scales how readily its plants give way.'],
};
