/**
 * A relayed replay answers once its restart is applied, not when it is
 * queued. The restart waits for the simulation's next step boundary (a held
 * or paused game takes no step, a busy page reaches it late), so the answer
 * reads the simulation's run until a new one began, and says the restart is
 * still pending when the wait the backend allows runs out (inside the relay's
 * timeout): a tool tells a slow restart from a failed call either way.
 */
/**
 * What the wait reads: the simulation's run (the game host's `SimAccess.runNow`, asked of the worker in
 * worker mode) and the last step the page has applied (the host's observation). In worker mode the page
 * applies the worker's frames on its next animation frame, while the run is answered at once: an answer
 * given before the page shows the new run would be followed by an observation of the old run's state
 * (its loaded scenes, its objects) under the new run's id.
 */
export interface RunReader {
  runNow(): Promise<{ readonly run: number; readonly startStep: number } | null>;
  shownStep(): number;
}

export type RestartOutcome =
  | { readonly state: 'applied'; readonly run: number; readonly atStep: number }
  | { readonly state: 'pending'; readonly run: number };

/** How often the run is read while waiting (about a frame). */
const RESTART_POLL_MS = 16;

/**
 * Wait until the simulation is in a later run than `beforeRun` and the page
 * shows it, or `withinMs` passed. `alive` false (the play stopped) ends the wait as pending.
 */
export async function awaitRestart(access: RunReader, beforeRun: number, withinMs: number, alive: () => boolean): Promise<RestartOutcome> {
  const end = performance.now() + withinMs;
  for (;;) {
    const now = alive() ? await access.runNow() : null;
    // Applied once the page shows a step of the new run (its first step is after `startStep`).
    if (now !== null && now.run > beforeRun && access.shownStep() > now.startStep) return { state: 'applied', run: now.run, atStep: now.startStep };
    if (now === null || !alive() || performance.now() >= end) return { state: 'pending', run: beforeRun + 1 };
    await new Promise((r) => setTimeout(r, Math.min(RESTART_POLL_MS, Math.max(0, end - performance.now()))));
  }
}
