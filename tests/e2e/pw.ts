/**
 * Playwright's test API for the e2e specs, with one change: `expect.poll` retries every
 * POLL_INTERVALS ms instead of Playwright's default back-off (100, 250, 500, then every
 * 1000 ms). Most polls here wait for a game or renderer state that arrives within a second
 * or two; the default back-off then waited up to a further second past it, poll after poll,
 * which added minutes to a full gate. A poll that passes its own `intervals` keeps them.
 */
import { expect as playwrightExpect } from '@playwright/test';

export * from '@playwright/test';

/** Retry delays of `expect.poll` (the last one repeats). */
export const POLL_INTERVALS: readonly number[] = [50, 100, 200];

type PollOptions = { message?: string; timeout?: number; intervals?: number[] };

const poll: typeof playwrightExpect.poll = (generator, messageOrOptions) => {
  const options: PollOptions = typeof messageOrOptions === 'string' ? { message: messageOrOptions } : { ...(messageOrOptions ?? {}) };
  return playwrightExpect.poll(generator, { ...options, intervals: options.intervals ?? [...POLL_INTERVALS] });
};

export const expect: typeof playwrightExpect = new Proxy(playwrightExpect, {
  get: (target, key, receiver) => (key === 'poll' ? poll : Reflect.get(target, key, receiver)),
});
