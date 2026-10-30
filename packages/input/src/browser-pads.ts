/**
 * The browser binding's gamepads: which pad is active (the lowest-index standard pad showing
 * activity; the browser reuses indexes, so a pad is known by index and id), the hot-plug
 * listeners and the pads' fresh presses for `anyPressed`. What a lost or unsupported pad means
 * for the rest of the binding (menus, held state, diagnostics) is the host's.
 */
import { GAMEPAD_DEAD_ZONE } from './types';

const DEVICE_ID_MAX = 64;

interface GamepadEventLike {
  gamepad?: Gamepad | null;
}

export function clipDeviceId(id: unknown): string {
  const s = typeof id === 'string' ? id : '';
  return s.length > DEVICE_ID_MAX ? s.slice(0, DEVICE_ID_MAX) : s;
}

export const padButtons = (gp: Gamepad): boolean[] => Array.from(gp.buttons, (b) => b?.pressed === true);
export const padAxes = (gp: Gamepad): number[] => Array.from(gp.axes, (a) => (typeof a === 'number' && Number.isFinite(a) ? a : 0));

/** What the pad tracker tells and asks the rest of the binding. */
export interface PadHost {
  detached(): boolean;
  /** The active pad changed to another one: held state needs a fresh activation. */
  freshActivation(): void;
  /** The active pad is gone (its id, as it was). */
  lost(id: string | null, reason: string): void;
  /** A non-standard pad was seen (once per id). */
  mappingUnsupported(id: string): void;
}

export function createPadTracker(host: PadHost) {
  let activeIndex: number | null = null;
  let activeId: string | null = null;
  const tracked = new Map<number, string>();
  const reportedMappingIds = new Set<string>();
  /** Each standard pad's buttons at the last sample (by index), for the frame's press. */
  let padsSeen = new Map<number, boolean[]>();

  // Any button or a stick past the dead zone wakes a pad, whatever the actions bind.
  const deviceHasActivity = (gp: Gamepad): boolean => padButtons(gp).includes(true) || padAxes(gp).some((v) => Math.abs(v) > GAMEPAD_DEAD_ZONE);

  const reportMappingUnsupported = (gp: Gamepad): void => {
    const id = clipDeviceId(gp.id);
    if (reportedMappingIds.has(id)) return;
    reportedMappingIds.add(id);
    host.mappingUnsupported(id);
  };

  /** The active pad is gone (disconnect event, index reuse, or a missing poll entry). */
  const deviceLost = (index: number, reason: string): void => {
    tracked.delete(index);
    if (activeIndex !== index) return;
    const lostId = activeId;
    activeIndex = null;
    activeId = null;
    host.lost(lostId, reason);
  };

  /**
   * Pick the active pad: the lowest-index connected
   * standard-mapped pad showing activity; the current pad stays active until
   * it is lost or a lower-index active pad appears. Reconciles index reuse.
   */
  const pickActive = (list: ArrayLike<Gamepad | null>): Gamepad | null => {
    const standard: Gamepad[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const gp = list[i];
      if (!gp || gp.connected === false) continue;
      if (gp.mapping !== 'standard') {
        reportMappingUnsupported(gp);
        continue;
      }
      const knownId = tracked.get(gp.index);
      if (knownId !== undefined && knownId !== gp.id) {
        // The browser reuses indexes (MDN): a different id at a known index
        // is a new device, so the old one is treated as lost.
        deviceLost(gp.index, 'index_reuse');
      }
      tracked.set(gp.index, gp.id);
      standard.push(gp);
    }

    if (activeIndex !== null) {
      const current = standard.find((gp) => gp.index === activeIndex) ?? null;
      if (!current) {
        deviceLost(activeIndex, 'disconnected');
      } else {
        const lower = standard.find((gp) => gp.index < (activeIndex ?? 0) && deviceHasActivity(gp));
        if (lower) {
          // A lower-index pad takes over. This is an active-pad change, so it
          // goes through the same fresh-activation transition as a disconnect:
          // a button already held on the new pad yields `held`, never
          // `pressed`.
          host.freshActivation();
          activeIndex = lower.index;
          activeId = lower.id;
          return lower;
        }
        return current;
      }
    }

    const candidate = standard
      .filter((gp) => deviceHasActivity(gp))
      .sort((a, b) => a.index - b.index)[0];
    if (!candidate) return null;
    activeIndex = candidate.index;
    activeId = candidate.id;
    return candidate;
  };

  /**
   * A button of any standard pad that went down since the last sample (any
   * pad, active or not: "press any button" wakes one). A pad first seen with
   * a button held does not count; `skip`: a press is already known, or a rebind takes it.
   */
  const notePresses = (list: ArrayLike<Gamepad | null>, skip: boolean): { device: 'gamepad'; code: string } | null => {
    const seen = new Map<number, boolean[]>();
    let press: { device: 'gamepad'; code: string } | null = null;
    for (let i = 0; i < list.length; i += 1) {
      const gp = list[i];
      if (!gp || gp.connected === false || gp.mapping !== 'standard') continue;
      const now = padButtons(gp);
      seen.set(gp.index, now);
      const before = padsSeen.get(gp.index);
      if (before === undefined || skip || press !== null) continue;
      const hit = now.findIndex((d, k) => d && before[k] !== true);
      if (hit >= 0 && hit <= 31) press = { device: 'gamepad', code: `button${hit}` };
    }
    padsSeen = seen;
    return press;
  };

  return {
    /** A pad connected (its index is known by its id from now on). */
    onConnected(event: Event): void {
      if (host.detached()) return;
      const e = event as unknown as GamepadEventLike;
      if (!e.gamepad) return;
      tracked.set(e.gamepad.index, e.gamepad.id);
    },
    onDisconnected(event: Event): void {
      if (host.detached()) return;
      const e = event as unknown as GamepadEventLike;
      if (!e.gamepad) return;
      deviceLost(e.gamepad.index, 'disconnected');
    },
    pickActive,
    notePresses,
    /** Detach: no active pad, nothing tracked or reported. */
    clear(): void {
      activeIndex = null;
      activeId = null;
      tracked.clear();
      reportedMappingIds.clear();
    },
  };
}
