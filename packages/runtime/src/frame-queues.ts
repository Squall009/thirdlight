/**
 * Entries the host queues between steps (storage answers, debug commands,
 * UI events, dialogue inputs, asset answers) ride on the next sampled step's
 * input frame, after what the frame already carries, up to a per-frame
 * number; the rest wait for the following frame. Riding on the frame is what
 * makes a recording replay them and the simulation worker apply them at the
 * same step as the page.
 */
import type { ActionFrame } from './actions';

type QueuedKey = 'saves' | 'commands' | 'ui' | 'dialogue' | 'assets';

/**
 * The frame with up to `max − (entries it has)` entries taken from `take`
 * under `key` (the frame as it is when there is no room, nothing waits, or
 * it is not an object: the frame check then says why).
 */
export function rideOnFrame(raw: unknown, key: QueuedKey, waiting: number, take: (room: number) => readonly unknown[], max: number): unknown {
  if (waiting === 0 || typeof raw !== 'object' || raw === null) return raw;
  const have = (raw as Record<string, unknown>)[key] ?? [];
  if (!Array.isArray(have)) return raw;
  const room = Math.max(0, max - have.length);
  if (room === 0) return raw;
  return { ...(raw as ActionFrame), [key]: [...(have as unknown[]), ...take(room)] };
}
