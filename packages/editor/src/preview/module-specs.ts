/**
 * Phase 24.3: the simulation module specs the Play preview provides beyond the
 * runtime's built-ins, keyed by manifest module id and in dependency order
 * (a module after those it needs). The game host imports no module package;
 * this composition entry registers them, and each game's manifest `modules`
 * pick the ones it references. (An export links only the specs its manifest
 * names — `thirdlight:export-modules`.)
 */
import type { SimulationModuleSpec } from '@thirdlight/runtime';
import { platformerSpec } from '@thirdlight/platformer';
import { platformerGameCameraSpec, platformerGameSessionSpec } from '@thirdlight/platformer-game';

export const PREVIEW_MODULE_SPECS: readonly SimulationModuleSpec[] = Object.freeze([platformerSpec, platformerGameSessionSpec, platformerGameCameraSpec]);
