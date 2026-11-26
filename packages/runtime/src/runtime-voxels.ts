/** How the runtime's voxel worlds are wired to the runtime that owns them. */
import type { RuntimeArgs } from './runtime-args';
import { RuntimeVoxels } from './voxel-worlds';
import { propLightShape } from './prop-light-shape';
import { worldTransformOf } from './world-transform';
import type { RuntimeSim } from './runtime-sim';
import type { RuntimeFaults } from './runtime-faults';
import type { RuntimeCharacters } from './runtime-characters';
import type { RuntimeViews } from './views';
import type { EntityAccess } from './entity-access';
import type { PlayerControllers } from './player-controllers';

/** What the voxel worlds read of the runtime they run in. */
export interface RuntimeVoxelsOwner {
  readonly views: RuntimeViews;
  readonly sim: RuntimeSim;
  readonly controllers: PlayerControllers;
  readonly chars: RuntimeCharacters;
  readonly entityAccess: EntityAccess;
  readonly faults: RuntimeFaults;
}

/** The runtime's voxel worlds, reading the camera, the bodies, the props and the portals of the runtime that owns them. */
export function runtimeVoxels(args: RuntimeArgs, rt: RuntimeVoxelsOwner): RuntimeVoxels {
  return new RuntimeVoxels(args.voxels ?? null, args.physics3d, {
    // Worlds stream around where the camera looks (its target, else itself), else around their objects.
    camera: () => {
      const v = rt.views.main.hasView() ? rt.views.main.view() : null;
      if (v === null || v.live === null) return null;
      return (v.target !== undefined ? rt.sim.curr.get(v.target)?.position : undefined) ?? v.position;
    },
    positionOf: (id) => rt.sim.curr.get(id)?.position,
    characters: () => rt.controllers.ids,
    // The last step's displacement over its length (a placement reads as a jump, which the lead points ignore).
    velocityOf: (id) => {
      const a = rt.sim.prev.get(id)?.position;
      const b = rt.sim.curr.get(id)?.position;
      if (a === undefined || b === undefined) return undefined;
      const hz = rt.sim.hz;
      return [(b[0]! - a[0]!) * hz, (b[1]! - a[1]!) * hz, (b[2]! - a[2]!) * hz];
    },
    worldTransform: (id) => worldTransformOf(id, rt.sim.curr, (x) => rt.sim.parentOf(x)),
    propShape: (id, components, world) => propLightShape(id, components, world, rt.chars.colliders.ctx, args.modelBounds)?.shape ?? null,
    portalOpen: (id) => rt.entityAccess.portalOpen(id),
    warn: (message) => rt.faults.log('thirdlight.runtime:voxels', 'warn', message),
  });
}
