/**
 * A relayed replay answers once its restart is applied, not when it is
 * queued. The restart waits for the simulation's next step boundary (a held
 * or paused game takes no step, a busy page reaches it late), so the answer
 * reads the simulation's run until a new one began, and says the restart is
 * still pending when the wait the backend allows runs out (inside the relay's
 * timeout): a tool tells a slow restart from a failed call either way.
 */
/** What the wait reads of the simulation (the game host's `SimAccess.runNow`). */
interface RunReader {
  runNow(): Promise<{ readonly run: number; readonly startStep: number } | null>;
}

export type RestartOutcome =
  | { readonly state: 'applied'; readonly run: number; readonly atStep: number }
  | { readonly state: 'pending'; readonly run: number };

/** How often the run is read while waiting (about a frame). */
const RESTART_POLL_MS = 16;

/**
 * Wait until the simulation is in a later run than `beforeRun` or `withinMs`
 * passed. `alive` false (the play stopped) ends the wait as pending.
 */
export async function awaitRestart(access: RunReader, beforeRun: number, withinMs: number, alive: () => boolean): Promise<RestartOutcome> {
  const end = performance.now() + withinMs;
  for (;;) {
    const now = alive() ? await access.runNow() : null;
    if (now !== null && now.run > beforeRun) return { state: 'applied', run: now.run, atStep: now.startStep };
    if (now === null || !alive() || performance.now() >= end) return { state: 'pending', run: beforeRun + 1 };
    await new Promise((r) => setTimeout(r, Math.min(RESTART_POLL_MS, Math.max(0, end - performance.now()))));
  }
}
