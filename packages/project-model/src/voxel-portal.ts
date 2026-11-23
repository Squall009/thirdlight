/**
 * The `voxelPortal` component: open or shut state on a prop that stands in
 * an opening of a voxel structure (a door leaf, a window pane, a shutter).
 *
 * Open or shut is state, never voxels: the opening's cells stay `opening`
 * voxels whatever the prop does. While the prop is shut, what it `stops`
 * is closed at its opening exactly and at once, whatever the leaf's
 * thickness: light (the opening's cells stop the light's rays whole),
 * sight (rooms and see-through read the opening as closed), walkers (paths
 * through the opening are marked as through a shut door). A pane of glass
 * is a prop that does not stop light.
 *
 * A game's script flips `open` through the generic component access
 * (`ctx.entity(id).set('voxelPortal', { open })`) and saves it as it saves
 * any written field. The engine has no door behaviour: how a door swings or
 * who may open it is the game's.
 *
 * Pure data.
 */
import { isPlainObject } from '@thirdlight/shared';
import type { ModelErrorV2 } from './errors';

/** What a shut portal stops. */
export interface VoxelPortalStops {
  readonly light: boolean;
  readonly sight: boolean;
  readonly walk: boolean;
}

export interface VoxelPortalComponent {
  /** Open: the opening passes everything; shut: it stops what `stops` names. */
  readonly open: boolean;
  readonly stops: VoxelPortalStops;
}

/** A door: shut, stopping light, sight and walkers (what a new portal starts as). */
export const VOXEL_PORTAL_DEFAULTS: VoxelPortalComponent = Object.freeze({ open: false, stops: Object.freeze({ light: true, sight: true, walk: true }) });

/** A pane of glass: shut, light and sight pass, walkers do not. */
export const VOXEL_PORTAL_GLASS: VoxelPortalComponent = Object.freeze({ open: false, stops: Object.freeze({ light: false, sight: false, walk: true }) });

/** The component's fields in canonical order. */
export const VOXEL_PORTAL_FIELDS: readonly string[] = Object.freeze(['open', 'stops']);
const FIELDS = VOXEL_PORTAL_FIELDS;
const STOPS = ['light', 'sight', 'walk'] as const;

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

export function validateVoxelPortalComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'voxelPortal is an object { open, stops: { light, sight, walk } }', value);
  for (const k of Object.keys(value)) if (!FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown voxelPortal field "${k}" (${FIELDS.join(', ')})`, k);
  if (typeof value['open'] !== 'boolean') err(errors, 'field_type', `${path}/open`, 'open is true or false', value['open']);
  const s = value['stops'];
  if (!isPlainObject(s)) return err(errors, 'field_type', `${path}/stops`, 'stops is an object { light, sight, walk } of true or false', s);
  for (const k of Object.keys(s)) if (!(STOPS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/stops/${k}`, `unknown stop "${k}" (${STOPS.join(', ')})`, k);
  for (const k of STOPS) if (typeof s[k] !== 'boolean') err(errors, 'field_type', `${path}/stops/${k}`, `stops.${k} is true or false`, s[k]);
}

/** Rebuilt field by field: every field kept, nothing else. */
export function canonicalVoxelPortal(c: VoxelPortalComponent): VoxelPortalComponent {
  return { open: c.open, stops: { light: c.stops.light, sight: c.stops.sight, walk: c.stops.walk } };
}

/** An object's portal as the runtime reads it (null: no portal, or not a valid one). */
export function voxelPortalOf(components: Readonly<Record<string, unknown>>): VoxelPortalComponent | null {
  const v = components['voxelPortal'];
  if (!isPlainObject(v) || typeof v['open'] !== 'boolean' || !isPlainObject(v['stops'])) return null;
  const s = v['stops'];
  if (typeof s['light'] !== 'boolean' || typeof s['sight'] !== 'boolean' || typeof s['walk'] !== 'boolean') return null;
  return { open: v['open'], stops: { light: s['light'], sight: s['sight'], walk: s['walk'] } };
}
