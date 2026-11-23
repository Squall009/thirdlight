/**
 * The descriptor of the `voxelPortal` component (beside its format in
 * `voxel-portal.ts`): Open, and what a shut portal stops.
 *
 * Pure data.
 */
import { bool, obj } from './descriptor-builders';
import type { ComponentDescriptor } from './descriptor-types';
import { VOXEL_PORTAL_DEFAULTS } from './voxel-portal';

const D = VOXEL_PORTAL_DEFAULTS;

export const voxelPortal: ComponentDescriptor = {
  name: 'voxelPortal',
  label: 'Portal',
  tooltip: "Open or shut state of a prop standing in an opening of a voxel structure (a door, a pane, a shutter). Shut, it closes its opening exactly for what it stops, whatever the prop's thickness; the opening's voxels never change. A script flips Open; how a door swings is the game's.",
  category: 'Rendering',
  value: obj('voxelPortal', 'Portal', 'Whether it is open, and what it stops while shut.', [
    bool('open', 'Open', 'Open: the opening passes light, sight and walkers. Shut: it stops what Stops names.', { required: true, default: D.open }),
    obj('stops', 'Stops while shut', 'What the shut prop closes its opening to. A pane of glass stops walkers only.', [
      bool('light', 'Light', "The opening's cells stop the light's rays whole while shut (off: light passes, as through glass).", { required: true, default: D.stops.light }),
      bool('sight', 'Sight', 'Rooms and their portals read the opening as closed while shut (off: it is seen through).', { required: true, default: D.stops.sight }),
      bool('walk', 'Walkers', 'Paths through the opening are marked as through a shut door, which a path query takes only when asked.', { required: true, default: D.stops.walk }),
    ], { required: true }),
  ]),
  add: { kind: 'menu', value: { open: D.open, stops: { ...D.stops } } },
  handles: [],
  excludes: [],
  prefab: true,
  rules: [
    "Joined to the opening it stands in by its place: a child of the structure object, inside the opening's cells.",
    "Open or shut is state, never voxels; a prop with a portal is not stamped into the light by its shape (its opening does the stopping).",
  ],
};
