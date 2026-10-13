/**
 * The instance brush on the shared brush kit: the settings it uses (size
 * across and paint/erase; its copies' density, spacing, scale, turn,
 * alignment and seed are its own, `InstanceBrush`), their bounds from the
 * command's, and the store they are remembered in.
 *
 * Pure but for the store's storage.
 */
import { INSTANCE_BRUSH_DEFAULTS, INSTANCE_BRUSH_LIMITS } from '@thirdlight/runtime';

import { DEFAULT_BRUSH, brushStore, type BrushBounds, type BrushSettings, type BrushStore, type BrushUse } from './brush';

/** The shared settings the instance brush uses: its footprint and whether it erases. */
export const INSTANCE_BRUSH_USES: readonly BrushUse[] = ['size', 'invert'];

/** Sizes a stroke may carry (across: twice the command's radius bounds); a copy brush has no height step (kept at the default). */
export const INSTANCE_BRUSH_BOUNDS: BrushBounds = Object.freeze({ size: [2 * INSTANCE_BRUSH_LIMITS.radius.min, 2 * INSTANCE_BRUSH_LIMITS.radius.max] as const, heightStep: [DEFAULT_BRUSH.heightStep, DEFAULT_BRUSH.heightStep] as const });

const DEFAULTS: BrushSettings = Object.freeze({ ...DEFAULT_BRUSH, size: 2 * INSTANCE_BRUSH_DEFAULTS.radius }) as BrushSettings;

/** The instance brush's shared settings (one store for the page, remembered in this browser). */
export const instanceBrushStore = (): BrushStore => brushStore('instances', 'paint', DEFAULTS, INSTANCE_BRUSH_BOUNDS);
