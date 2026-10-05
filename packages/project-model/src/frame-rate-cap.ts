/**
 * The frame-rate cap a game sets: the most frames per second the page draws.
 * A fast engine on a phone's 120 Hz display would otherwise draw (and burn
 * battery) at the display's rate however little the game needs it. The cap
 * is presentation: game time keeps its fixed step whatever is drawn.
 *
 * Where a game sets it: the project setting `frame_rate_cap` (0 or absent:
 * none), a player's settings field bound to `frameRateCap`, the UI engine
 * action `setSetting` with `setting: 'frameRateCap'`, and scripts
 * (`ctx.display.setFrameRateCap`).
 *
 * Pure: no I/O.
 */

/**
 * The caps a game may set (frames per second). 30 and 60 divide the common
 * 60, 120 and 240 Hz displays evenly; 120 keeps a 240 Hz display at half its
 * rate. None (null) is the display's own rate.
 */
export const FRAME_RATE_CAPS = [30, 60, 120] as const;
export type FrameRateCap = (typeof FRAME_RATE_CAPS)[number];

/** What a settings field bound to the cap may choose: each cap as text, and 'none' (no cap). */
export const FRAME_RATE_CAP_CHOICES: readonly string[] = Object.freeze([...FRAME_RATE_CAPS.map(String), 'none']);

/**
 * A cap from a setting, a script, a settings field or a UI action: 30, 60 or
 * 120 (a number or its text), null for none (null, 0 or 'none'), undefined
 * when the value is not a cap.
 */
export function frameRateCapOf(v: unknown): FrameRateCap | null | undefined {
  if (v === null || v === 0 || v === 'none') return null;
  const n = typeof v === 'string' && /^\d{2,3}$/.test(v) ? Number(v) : v;
  return (FRAME_RATE_CAPS as readonly unknown[]).includes(n) ? (n as FrameRateCap) : undefined;
}

/** The project's cap (the `frame_rate_cap` setting; absent, 0 or unknown: none). */
export function projectFrameRateCap(settings: unknown): FrameRateCap | null {
  const v = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['frame_rate_cap'] : undefined;
  return frameRateCapOf(v) ?? null;
}
