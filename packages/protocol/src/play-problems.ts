/**
 * A running game's problems for its author: the game page reports a problem
 * once per kind (a sound dropped because every voice was busy, a deprecated
 * call), the editor relays it, and the backend writes one Problems line per
 * kind and Play. An exported game has no editor to tell; it only counts them
 * in its own diagnostics.
 */

/** A problem's kind: a short code (`voice_cap`). */
export const PLAY_PROBLEM_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** The longest problem line (characters). */
export const PLAY_PROBLEM_MESSAGE_MAX = 512;
/**
 * The distinct kinds one Play writes at most: each kind is one line, so
 * this bounds a page that reports a new code over and over, not a game.
 */
export const PLAY_PROBLEM_KINDS_MAX = 32;

/** Why a reported problem is refused (null: well formed). */
export function playProblemProblem(code: unknown, message: unknown): string | null {
  if (typeof code !== 'string' || !PLAY_PROBLEM_CODE_RE.test(code)) return 'code must be a lowercase code (a letter, then letters, digits or _; ≤ 64)';
  if (typeof message !== 'string' || message.length < 1 || message.length > PLAY_PROBLEM_MESSAGE_MAX) return `message must be a string of 1–${PLAY_PROBLEM_MESSAGE_MAX} characters`;
  return null;
}
