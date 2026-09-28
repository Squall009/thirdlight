/**
 * The gameplay panel's wire views and the zone gesture's placement planning
 * (packet 56; phase 24.5: generic).
 *
 * Phase 24.5 removed the platformer authoring layer from here: the fixed
 * tuning-settings list (the settings are built from their descriptor), the
 * game-config form and its goal/checkpoint validation, the cue slots
 * (superseded by `content.eventCues`), the zone roles offered for creation
 * and the camera-follow form (an Inspector section). What stays is what the
 * editor still reads until phase 24.7 deletes the game block and the zone
 * component: the game block's wire shape, and the planning of the Scene
 * view's zone gesture, which moves and resizes zone objects a project
 * already has.
 *
 * Pure: no DOM, no I/O, no Node builtins. The backend remains the authority.
 */

import type { GameZoneComponent, CameraFollowComponent } from '@thirdlight/project-model';

/**
 * The editor's structural view of the `GameConfig` block (the `queryGameConfig`
 * result). Structurally compatible with project-model's `GameConfig`; declared
 * locally because the block arrives over the wire (the client never trusts
 * its own types).
 */
export interface GameConfigLike {
  /** 1: v3 (level + killY); 2: v4 (neither). */
  configVersion: 1 | 2;
  title: string;
  objective: string;
  instructions: string;
  playerId: string;
  cameraId: string;
  spawnId: string;
  level?: { minX: number; maxX: number; minY: number; maxY: number };
  killY?: number;
  cues: { start: string | null; jump: string | null; checkpoint: string | null; death: string | null; goal: string | null };
}

// ---------------------------------------------------------------------------
// The zone gesture's planning (until phase 24.7 removes the zone component)
// ---------------------------------------------------------------------------

export type ZoneRole = GameZoneComponent['role'];

/** The size a zone gesture's plain click commits (a 1.5 × 1.5 m square: an area the default 1.8 m character fits into). */
export const DEFAULT_ZONE_SIZE: Readonly<Record<ZoneRole, [number, number]>> = {
  hazard: [1.5, 1.5],
  checkpoint: [1.5, 1.5],
  goal: [1.5, 1.5],
  exit: [1.5, 1.5],
};
/** The §23.3.1 span bound (0 < v <= 1e6); the UI keeps a 0.1 m drag floor. */
export const MAX_ZONE_SPAN = 1e6;
export const MIN_ZONE_SPAN_UI = 0.1;

export interface ZonePlanError {
  code: string;
  message: string;
}

/** The `createEntity` args that create a zone. */
export interface ZoneCreateArgs {
  kind: 'group';
  name: string;
  transform: { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] };
  components: { gameZone: Record<string, unknown> };
}

/**
 * Plan a zone creation (the zone gesture's `create`). A checkpoint requires
 * `safeSpawnId` in the same value and its activation look. The entity is a
 * root `group` (no parent, unit scale, no rotation).
 */
export function planCreateZone(
  opts: { role: ZoneRole; size: [number, number]; position: [number, number, number]; safeSpawnId?: string; name?: string },
): { ok: true; args: ZoneCreateArgs } | { ok: false; error: ZonePlanError } {
  if (DEFAULT_ZONE_SIZE[opts.role] === undefined) return { ok: false, error: { code: 'field_value', message: 'unknown zone role' } };
  const [w, h] = opts.size;
  for (const v of [w, h]) {
    if (!Number.isFinite(v) || v <= 0 || v > MAX_ZONE_SPAN) {
      return { ok: false, error: { code: 'field_value', message: `zone size must satisfy 0 < v <= ${MAX_ZONE_SPAN} meters` } };
    }
  }
  for (const v of opts.position) {
    if (!Number.isFinite(v)) return { ok: false, error: { code: 'field_value', message: 'zone position must hold finite numbers' } };
  }
  const gameZone: Record<string, unknown> = { role: opts.role, size: [w, h] };
  if (opts.role === 'checkpoint') {
    if (typeof opts.safeSpawnId !== 'string' || opts.safeSpawnId.length === 0) {
      return { ok: false, error: { code: 'field_missing', message: 'a checkpoint zone requires a safeSpawnId reference in the same edit' } };
    }
    gameZone['safeSpawnId'] = opts.safeSpawnId;
    gameZone['activation'] = { emissive: '#ffffff', emissiveIntensity: 1, cueAssetId: null };
  }
  return {
    ok: true,
    args: {
      kind: 'group',
      name: opts.name ?? `zone-${opts.role}`,
      transform: { position: [opts.position[0], opts.position[1], opts.position[2] ?? 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: { gameZone },
    },
  };
}

export type { GameZoneComponent, CameraFollowComponent };
