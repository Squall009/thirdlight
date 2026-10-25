/**
 * The timeline's character track — keys that place a player character,
 * have its own controller walk it to a mark, turn it and switch it off and
 * on, through the character director (the path `ctx.character` takes).
 *
 * While a character track plays, its character does not take the player's
 * input (unless the track says `playerInput`): from the play's start to its
 * end the cutscene owns it. At the end its walks still under way carry on to
 * their marks; a skip lands them there (each walk key still to come is a
 * placement, the way a transform track jumps to its end); a stop leaves the
 * character where it is, switched on or off as it was before the track
 * switched it (the director's `release` is the one rule).
 *
 * The editor's scrub preview shows the track as poses: a place key puts it
 * there, a walk slides it from where it was to the mark until the next key
 * (Play walks it at its controller's speed).
 */
import { TIMELINE_CHARACTER_MODES, type TimelineKey, type TimelineTrack } from '@thirdlight/project-model';

import type { CharacterReleaseKind, TimelineCharacterPort } from './character-director';

/** The owner name a play holds its characters under. */
export function timelineOwner(handle: number): string {
  return `timeline:${handle}`;
}

/** A play starts: each character track that holds input takes its character's. */
export function holdCharacters(port: TimelineCharacterPort | undefined, tracks: readonly TimelineTrack[], bound: (slot: string | undefined) => string | null, owner: string): void {
  if (port === undefined) return;
  for (const t of tracks) {
    if (t.type !== 'character' || t.muted === true || t.playerInput === true) continue;
    const id = bound(t.target);
    if (id !== null && port.has(id)) port.hold(id, owner);
  }
}

/** A play ends (finished, skipped, stopped): its holds end, its walks carry on, land or stop. */
export function releaseCharacters(port: TimelineCharacterPort | undefined, owner: string, how: CharacterReleaseKind): void {
  port?.release(owner, how);
}

/**
 * One character key (`skipping`: a walk lands on its mark at once, a turn
 * is immediate). Returns a problem to log once, or null.
 */
export function fireCharacterKey(port: TimelineCharacterPort | undefined, id: string, k: TimelineKey, skipping: boolean, owner: string): string | null {
  if (port === undefined || !port.has(id)) return `"${id}" is not a player character (an object with a Character controller)`;
  if (k.enabled !== undefined) port.setEnabled(id, k.enabled, owner);
  const mode = TIMELINE_CHARACTER_MODES.find((m) => m === k.mode);
  if (mode !== undefined && k.position !== undefined) {
    const ok = mode === 'place' || skipping ? port.place(id, k.position, k.facing) : port.walk(id, k.position, { ...(k.run === true ? { run: true } : {}), ...(k.facing !== undefined ? { facing: k.facing } : {}) }, owner);
    if (!ok) return `"${id}" cannot be placed there (a bad point, or no physics world to place it in)`;
  } else if (k.facing !== undefined) port.turn(id, k.facing, skipping);
  return null;
}

/** A character track's pose at `time` for the scrub preview (empty before its first key with a position or facing). */
export function characterTrackPose(track: TimelineTrack, time: number, end: number): { position?: [number, number, number]; rotation?: [number, number, number, number] } {
  let at: [number, number, number] | undefined;
  let facing: number | undefined;
  const keys = track.keys;
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i]!;
    if (k.time > time) break;
    if (k.facing !== undefined) facing = k.facing;
    if (k.position === undefined) continue;
    const to: [number, number, number] = [k.position[0], k.position[1], k.position[2]];
    if (k.mode !== 'walk' || at === undefined) {
      at = to;
      continue;
    }
    // A walk is shown sliding to its mark by the next key's time (or the end).
    const next = keys.slice(i + 1).find((x) => x.position !== undefined || x.facing !== undefined)?.time ?? end;
    const w = next > k.time ? Math.min(1, (time - k.time) / (next - k.time)) : 1;
    const from = at;
    at = [from[0] + (to[0] - from[0]) * w, from[1] + (to[1] - from[1]) * w, from[2] + (to[2] - from[2]) * w];
  }
  const out: { position?: [number, number, number]; rotation?: [number, number, number, number] } = {};
  if (at !== undefined) out.position = at;
  if (facing !== undefined) {
    const h = (facing * Math.PI) / 360;
    out.rotation = [0, Math.sin(h), 0, Math.cos(h)];
  }
  return out;
}
