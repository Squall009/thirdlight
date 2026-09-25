/**
 * Phase 22.0: where the game's simulation runs.
 *
 * - `worker` (the default): runtime, physics, gameplay blocks and scripts run
 *   in a dedicated worker; the page keeps input, audio, the DOM and
 *   rendering, so a long simulation step never delays a frame or an input
 *   event. Every game gains from it and none depends on running in the page.
 * - `single`: everything in the page (as before phase 22). The fallback when
 *   the browser cannot start the worker, and a choice for debugging.
 *
 * The page URL flag `?threads=off` (or `single`/`main`) forces single-thread
 * mode, `?threads=on`/`worker` asks for the worker; otherwise the project
 * setting `sim_thread` (1 worker, 2 main thread) decides; absent: worker.
 *
 * The transform stream uses a SharedArrayBuffer only where the page is
 * cross-origin isolated (COOP + COEP headers); everywhere else it is
 * messages (transferred typed arrays) — an export on any static host works.
 */

export type ThreadingMode = 'worker' | 'single';
export type SimTransport = 'shared' | 'message';

/** The page URL flag. */
export const THREADS_URL_PARAM = 'threads';

/** The `sim_thread` setting's values: its index here (1 worker, 2 main thread). */
export const SIM_THREAD_SETTING_VALUES: readonly (ThreadingMode | null)[] = [null, 'worker', 'single'];

/** The URL flag's mode (null: absent or not understood). */
export function threadingFromUrl(search: string): ThreadingMode | null {
  const m = /[?&]threads=([^&#]*)/.exec(search);
  if (m === null) return null;
  const v = decodeURIComponent(m[1]!).toLowerCase();
  if (v === 'off' || v === 'single' || v === 'main' || v === '0' || v === 'false') return 'single';
  if (v === 'on' || v === 'worker' || v === '1' || v === 'true') return 'worker';
  return null;
}

/** Decide the mode (and say why — the page logs it). */
export function resolveThreadingMode(input: { url: string; setting?: number | undefined; workerAvailable: boolean }): { mode: ThreadingMode; reason: string } {
  const fromUrl = threadingFromUrl(input.url);
  const fromSetting = typeof input.setting === 'number' ? (SIM_THREAD_SETTING_VALUES[input.setting] ?? null) : null;
  const wanted: ThreadingMode = fromUrl ?? fromSetting ?? 'worker';
  const source = fromUrl !== null ? `the page URL (?${THREADS_URL_PARAM}=)` : fromSetting !== null ? 'the project setting sim_thread' : 'the default';
  if (wanted === 'worker' && !input.workerAvailable) return { mode: 'single', reason: `${source} asks for the worker, but this browser cannot start one: single thread` };
  return { mode: wanted, reason: source };
}

/** Shared memory for the transforms only where the page is cross-origin isolated. */
export function resolveTransport(env: { crossOriginIsolated?: unknown; SharedArrayBuffer?: unknown }): SimTransport {
  return env.crossOriginIsolated === true && typeof env.SharedArrayBuffer === 'function' ? 'shared' : 'message';
}

/** The one line a page logs about its threading. */
export function threadingLogLine(mode: ThreadingMode, reason: string, transport: SimTransport | null, isolated: boolean): string {
  if (mode === 'single') return `[thirdlight] simulation: single thread (${reason}; cross-origin isolated: ${isolated ? 'yes' : 'no'})`;
  return `[thirdlight] simulation: worker (${reason}); transforms by ${transport === 'shared' ? 'shared memory' : 'messages'} (cross-origin isolated: ${isolated ? 'yes' : 'no'})`;
}
